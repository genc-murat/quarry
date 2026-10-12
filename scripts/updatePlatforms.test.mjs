import assert from "node:assert/strict";
import test from "node:test";

import {
  allPlatforms,
  manifestLookups,
  PLATFORMS_SUPPORTED,
  updaterArchitecture,
  updatePlatform,
} from "./updatePlatforms.mjs";

/**
 * The contract is data, so it can be checked without building a bundle on the
 * platform in question — which is the point: the Linux and Windows halves of the
 * update check cannot be run here, and these tests are what keeps their names
 * honest against the pieces that produce them.
 *
 * The expected values are copied from those pieces, not from symmetry:
 * `BundleType` in tauri-utils' platform.rs for the installer names, and
 * `Updater::get_urls` in tauri-plugin-updater for the key order.
 */

test("every platform names its bundle the way the updater does", () => {
  // tauri-utils BundleType: Nsis = "nsis", AppImage = "appimage", App = "app".
  assert.equal(updatePlatform("darwin").installer, "app");
  assert.equal(updatePlatform("linux").installer, "appimage");
  assert.equal(updatePlatform("win32").installer, "nsis");

  // Linux and Windows build the bundle the installer is named after; macOS's
  // bundler calls the same thing `app`.
  assert.equal(updatePlatform("darwin").bundle, "app");
  assert.equal(updatePlatform("linux").bundle, "appimage");
  assert.equal(updatePlatform("win32").bundle, "nsis");
});

test("the manifest keys are the typed one first, then the plain one", () => {
  assert.deepEqual(updatePlatform("darwin", "arm64").keys, [
    "darwin-aarch64-app",
    "darwin-aarch64",
  ]);
  assert.deepEqual(updatePlatform("linux", "x64").keys, [
    "linux-x86_64-appimage",
    "linux-x86_64",
  ]);
  assert.deepEqual(updatePlatform("win32", "x64").keys, ["windows-x86_64-nsis", "windows-x86_64"]);
});

test("architectures are spelled the updater's way, not Node's", () => {
  const expected = {
    x64: "x86_64",
    arm64: "aarch64",
    ia32: "i686",
    arm: "armv7",
    riscv64: "riscv64",
  };
  for (const [node, updater] of Object.entries(expected)) {
    assert.equal(updatePlatform("linux", node).arch, updater);
    assert.ok(updatePlatform("linux", node).keys[1].endsWith(`-${updater}`));
  }
  // The name Node uses would be wrong in a manifest.
  assert.ok(!updatePlatform("darwin", "arm64").keys.some((key) => key.includes("arm64")));
});

test("an unsupported platform or architecture is refused, not guessed", () => {
  assert.throws(() => updatePlatform("freebsd"), /not a platform the updater supports/);
  assert.throws(() => updatePlatform("linux", "mips"), /not an architecture the updater supports/);
});

test("each platform's artifact pattern matches that platform's artifact alone", () => {
  const darwin = updatePlatform("darwin").artifact;
  assert.ok(darwin.test("Quarry.app.tar.gz"));
  assert.ok(!darwin.test("Quarry_0.1.0_amd64.AppImage.tar.gz"));
  assert.ok(!darwin.test("Quarry_0.1.0_x64-setup.exe"));

  const linux = updatePlatform("linux").artifact;
  assert.ok(linux.test("Quarry_0.1.0_amd64.AppImage.tar.gz"));
  assert.ok(!linux.test("Quarry_0.1.0_x64-setup.nsis.zip"));

  const windows = updatePlatform("win32").artifact;
  assert.ok(windows.test("Quarry_0.1.0_x64-setup.exe"));
  assert.ok(windows.test("Quarry_0.1.0_x64-setup.nsis.zip"));
  assert.ok(!windows.test("Quarry_0.1.0_x64.msi.zip"));
});

test("the Linux payload is the AppImage the tarball wraps", () => {
  const linux = updatePlatform("linux");
  assert.equal(linux.installed, "appImage");
  assert.ok(linux.payload.test("Quarry_0.1.0_amd64.AppImage"));
  assert.ok(!linux.payload.test("Quarry_0.1.0_amd64.AppImage.tar.gz"));
});

test("Windows prefers the zip when both artifacts carry a signature", () => {
  const windows = updatePlatform("win32");
  assert.equal(windows.installed, "installer");
  assert.ok(windows.prefer.test("Quarry_0.1.0_x64-setup.nsis.zip"));
  assert.ok(!windows.prefer.test("Quarry_0.1.0_x64-setup.exe"));
});

test("every platform documents its own constraints", () => {
  for (const platform of allPlatforms()) {
    assert.ok(platform.notes.length >= 3, `${platform.name} has too few notes`);
    assert.ok(
      platform.notes.every((note) => typeof note === "string" && note.length > 20),
      `${platform.name} has a note that says nothing`,
    );
  }
  assert.deepEqual(PLATFORMS_SUPPORTED.sort(), ["darwin", "linux", "win32"]);
});

test("the lookup index maps every key back to the contract that looks it up", () => {
  const lookups = manifestLookups();

  for (const [key, found] of lookups) {
    // The index is what a manifest is judged against, so a key in it that its
    // own contract does not list would judge a manifest against a name no app
    // ever asks for.
    assert.ok(found.keys.includes(key), `${key} is not in its own contract's key list`);
    assert.equal(found.typed, found.keys[0] === key, `${key} is typed the wrong way`);
    assert.equal(found.os, found.keys[0].split("-")[0]);
    assert.ok(found.artifact instanceof RegExp);
  }

  assert.equal(lookups.size, PLATFORMS_SUPPORTED.length * 5 * 2, "three platforms, five architectures, two keys each");
  assert.equal(lookups.get("windows-x86_64-nsis").name, "Windows");
  assert.equal(lookups.get("windows-x86_64-nsis").typed, true);
  assert.equal(lookups.get("windows-x86_64").typed, false);
  assert.equal(lookups.get("linux-aarch64").arch, "aarch64");
  assert.equal(lookups.get("darwin-arm64"), undefined, "Node's spelling is not a key");
});

test("plugins.updater.target replaces both keys with the one it names", () => {
  assert.deepEqual(updatePlatform("darwin", "arm64", "darwin-aarch64-app").keys, ["darwin-aarch64-app"]);
  assert.deepEqual(updatePlatform("linux", "x64", "custom").keys, ["custom"], "every platform looks up the same one");
  assert.deepEqual(updatePlatform("linux", "x64", undefined).keys, ["linux-x86_64-appimage", "linux-x86_64"]);
  assert.deepEqual(updatePlatform("linux", "x64", "").keys, ["linux-x86_64-appimage", "linux-x86_64"], "an empty target is not a target");
});

test("an architecture can be respelled the updater's way", () => {
  assert.equal(updaterArchitecture("arm64"), "aarch64");
  assert.equal(updaterArchitecture("x64"), "x86_64");
  assert.equal(updaterArchitecture("aarch64"), null, "already the updater's spelling");
  assert.equal(updaterArchitecture("mips"), null);
});

test("the macOS contract carries the constraints that were observed by running it", () => {
  const notes = updatePlatform("darwin").notes.join(" ");
  assert.match(notes, /symlink/);
  assert.match(notes, /\.app/);
});
