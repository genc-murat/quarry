/**
 * What the update path consists of on each platform, as data — because the
 * parts that differ are all names and orderings, and a name is exactly what
 * breaks silently: an artifact the bundler does not produce, a manifest key the
 * app never asks for, a bundle flag the CLI rejects.
 *
 * Every value here comes from the piece that decides it:
 *
 * - `bundle` is what `tauri build --bundles` accepts on that OS, and `bundle` is
 *   what the CLI prints as its own possible values there.
 * - `installer` is the updater's spelling of the bundle type — `BundleType` in
 *   tauri-utils (`platform.rs`), the same strings `@tauri-apps/api`'s
 *   `getBundleType()` returns and the ones appended to the manifest target.
 * - `keys` is the lookup the updater performs, in order:
 *   `{os}-{arch}-{installer}` first, then `{os}-{arch}`
 *   (tauri-plugin-updater, `Updater::get_urls`). Setting `plugins.updater.target`
 *   in the config replaces that list with the single target it names — which is
 *   what `updatePlatform`'s third argument asks for, so a check can ask what the
 *   app would look up rather than what it would look up by default.
 * - the architecture spellings are `updater_arch()`'s own (`x86_64`, `aarch64`,
 *   `i686`, `armv7`, `riscv64`), not Node's.
 * - the artifact patterns are the structure the plugin documents for each
 *   platform in its own docs comments.
 *
 * This file is data and rules only, so it can be checked without building
 * anything: see `updatePlatforms.test.mjs`.
 */

/** The updater's spelling of each architecture (`updater_arch`). */
const ARCHITECTURES = {
  x64: "x86_64",
  arm64: "aarch64",
  ia32: "i686",
  arm: "armv7",
  riscv64: "riscv64",
};

/**
 * The installed copy is replaced differently on each platform: a bundle to swap,
 * a single executable to overwrite, or an installer to run.
 */
export const INSTALLED = {
  appBundle: "appBundle",
  appImage: "appImage",
  installer: "installer",
};

const PLATFORMS = {
  darwin: {
    name: "macOS",
    os: "darwin",
    bundle: "app",
    installer: "app",
    directory: "macos",
    /** The updater artifact: `[AppName].app.tar.gz`, next to `[AppName].app`. */
    artifact: /\.app\.tar\.gz$/,
    installed: INSTALLED.appBundle,
    notes: [
      "the app is replaced as a bundle, so the update is only possible from a real .app",
      "macOS is also the one platform where the updater refuses to start if the path to the executable contains a symlink (tauri-utils' StartingBinary), which rules out /tmp and /var installs",
      "our frontend restarts the app itself after downloadAndInstall returns; nothing installer-side does it",
    ],
  },
  linux: {
    name: "Linux",
    os: "linux",
    bundle: "appimage",
    installer: "appimage",
    directory: "appimage",
    /** `[AppName]_[version]_amd64.AppImage.tar.gz`, next to the AppImage itself. */
    artifact: /\.AppImage\.tar\.gz$/,
    /** The file the tarball wraps, which is what an installed copy actually is. */
    payload: /\.AppImage$/,
    installed: INSTALLED.appImage,
    notes: [
      "the app must be running as an AppImage: the updater writes the new image over the file the APPIMAGE variable points at, so a build run from target/debug, an extracted AppImage directory, or a .deb/.rpm install follow other paths",
      "the tarball's AppImage replaces the file in place and keeps its permissions; the restart is ours, right after",
      "opening a window needs WebKitGTK and a display, so this cannot be checked on a headless runner",
    ],
  },
  win32: {
    name: "Windows",
    os: "windows",
    bundle: "nsis",
    installer: "nsis",
    directory: "nsis",
    /** `[AppName]_[version]_x64-setup.exe` and its `.nsis.zip`, both accepted. */
    artifact: /-setup(\.nsis)?\.(exe|zip)$/,
    prefer: /\.zip$/,
    installed: INSTALLED.installer,
    notes: [
      "the update runs the NSIS installer and then the app exits from inside downloadAndInstall, so our process.relaunch never runs here: the installer itself restarts the app (restart_after_install defaults to true, which passes /R)",
      "the installer's mode comes from plugins.updater.windows.installMode — this project sets passive (/P); basicUi leaves the restart out entirely",
      "only an installed copy can be updated, so the old version has to be installed with its own installer first; a build run from target/debug has nothing to replace",
      "NSIS installs per user by default (currentUser, HKCU), so no elevation is needed — a per-machine install would need it",
      "the artifact is the NSIS zip or the -setup.exe itself; the updater accepts either",
      "an unsigned installer is what SmartScreen warns about; signing is outside this check",
    ],
  },
};

/** The platforms this check knows how to prepare an installed copy for. */
export const PLATFORMS_SUPPORTED = Object.keys(PLATFORMS);

/**
 * The contract for one platform and architecture, with the manifest keys in the
 * order the updater looks them up. `override` is `plugins.updater.target`, if
 * the config sets one: the updater then looks up that single key and nothing
 * else, on every platform.
 */
export function updatePlatform(platform = process.platform, arch = process.arch, override) {
  const base = PLATFORMS[platform];
  if (!base) {
    throw new Error(
      `${platform} is not a platform the updater supports (${PLATFORMS_SUPPORTED.join(", ")})`,
    );
  }
  const target = ARCHITECTURES[arch];
  if (!target) {
    throw new Error(`${arch} is not an architecture the updater supports`);
  }

  return {
    ...base,
    arch: target,
    keys: override ? [override] : [`${base.os}-${target}-${base.installer}`, `${base.os}-${target}`],
  };
}

/** Every platform's contract, for `--report`. */
export function allPlatforms() {
  return PLATFORMS_SUPPORTED.map((platform) => updatePlatform(platform, process.arch));
}

/**
 * The updater's spelling of an architecture, or null for one it does not name.
 * For suggesting what a mistyped manifest key probably meant: a manifest written
 * with Node's `arm64` is the mistake this catches.
 */
export function updaterArchitecture(architecture) {
  return ARCHITECTURES[architecture] ?? null;
}

/**
 * Every key the updater would look up anywhere, mapped back to the contract that
 * looks it up — with `typed` saying whether it is the installer-typed key or the
 * plain fallback. A manifest is checked against this: a key that is not in here
 * is a key no app ever reads, and an app whose target has no key here cannot be
 * updated by that release. See `releaseManifest.mjs`.
 */
export function manifestLookups() {
  const index = new Map();
  for (const platform of PLATFORMS_SUPPORTED) {
    for (const arch of Object.keys(ARCHITECTURES)) {
      const contract = updatePlatform(platform, arch);
      contract.keys.forEach((key, position) => {
        index.set(key, { ...contract, key, typed: position === 0 });
      });
    }
  }
  return index;
}
