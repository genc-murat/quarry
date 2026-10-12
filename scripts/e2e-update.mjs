/**
 * End-to-end check of the self-update path: two real bundles, a real manifest,
 * and an app that updates itself while nobody is looking.
 *
 * Reading the code cannot tell you whether an update works, because most of the
 * path lives outside it: the bundler's signature, the endpoint's manifest, the
 * installed copy the shell replaces. So this builds the version in
 * `tauri.conf.json` and the next one after it, serves the newer one's signed
 * artifact from a local HTTP server, prepares a copy of the older bundle the way
 * that platform installs it, and launches it. The build carries a probe
 * (src/lib/updateProbe.ts) that drives the same check → download → install →
 * restart the settings panel drives, and reports every step back to that server.
 *
 * Three phases run, each against a fresh copy of the old build:
 *
 *   1. an honest artifact and signature   → the app installs it, restarts, and
 *                                           comes back reporting the new version
 *   2. a tampered artifact, good signature → the install is refused, and what is
 *                                           on disk is untouched
 *   3. an honest artifact, foreign key     → the same refusal
 *
 * Phases 2 and 3 are why this is worth the minutes it takes: the endpoint is
 * public and its manifest is anyone's to rewrite, so a payload that does not
 * verify must never reach the disk. A run that only checked phase 1 would pass
 * just as happily with signature verification disabled.
 *
 *   node scripts/e2e-update.mjs               # the version in tauri.conf.json → +1 patch
 *   node scripts/e2e-update.mjs --next 0.2.0  # a specific update to offer
 *   node scripts/e2e-update.mjs --keep        # keep the bundles and logs of a run
 *   node scripts/e2e-update.mjs --report      # each platform's contract, and build nothing
 *
 * Each platform's update path is a different shape, and `scripts/updatePlatforms.mjs`
 * holds those shapes as data: the bundle to build, the artifact to serve, the
 * manifest keys the app looks up, and how an installed copy is prepared. The
 * constraints that come with them — macOS refusing a symlinked path, Linux
 * needing a real AppImage, Windows needing an installed copy and restarting the
 * app from the installer rather than from our code — are printed by `--report`
 * and listed in the README.
 *
 * The macOS half has been run; the Linux and Windows halves are written from the
 * contracts above and have not been run here, so treat a green run on those two
 * as unconfirmed until it happens on that OS.
 *
 * Needs a GUI session (the app opens a window) and the updater signing key —
 * `TAURI_SIGNING_PRIVATE_KEY` or `TAURI_SIGNING_PRIVATE_KEY_PATH`, else
 * `~/.tauri/quarry.key`. It is not a CI check: it builds two debug bundles, so a
 * cold Rust target directory makes it a coffee break, and it wants a window
 * server a runner does not have.
 *
 * Exit codes: 0 every phase behaved, 1 a phase did something else, 2 the run
 * could not be set up (missing key, wrong platform, no window to open in).
 */
import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, lstatSync, openSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { allPlatforms, INSTALLED, updatePlatform } from "./updatePlatforms.mjs";

const run = promisify(execFile);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONF = path.join(ROOT, "src-tauri/tauri.conf.json");
/** Debug bundles: the same bundling and the same updater, minutes not hours. */
const BUNDLES = path.join(ROOT, "src-tauri/target/debug/bundle");

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const value = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};

const conf = JSON.parse(await readFile(CONF, "utf8"));
const product = conf.productName;
const currentVersion = conf.version;
const nextVersion = value("--next") ?? bumpPatch(currentVersion);
const keep = has("--keep");
/** The crate's name, which is what the binary is called on disk. */
const binary = (await readFile(path.join(ROOT, "src-tauri/Cargo.toml"), "utf8")).match(
  /^\s*name\s*=\s*"([^"]+)"/m,
)?.[1];

let contract = null;

/** The state a phase builds up: what the app reports, and what it fetched. */
const seen = { steps: [], requests: [] };
/** What the server offers right now; each phase swaps it. */
const served = { manifest: null, artifact: null };

let work = null;
let server = null;
let child = null;
let key = null;
let failed = false;

try {
  contract = updatePlatform();
  if (has("--report")) reportContracts();
  else await main();
} catch (error) {
  if (/not a platform|not an architecture/.test(error.message)) error = setup(error.message);
  failed = true;
  console.error(`\n✗ ${error.message}`);
  process.exitCode = error.setup ? 2 : 1;
} finally {
  await stopRun();
  if (server) await new Promise((done) => server.close(done));
  // A failed run is read from its logs, so its work is kept either way, and the
  // target directory is put back before anyone launches what this run left.
  if (failed && work && key) await restoreBuild(key);
  if (work && (keep || failed)) console.log(`\nkept for inspection: ${work}`);
  else if (work) await rm(work, { recursive: true, force: true });
}

async function main() {
  await preflight();
  console.log(`checking ${currentVersion} → ${nextVersion} on ${contract.name} (${contract.arch})`);

  // Not os.tmpdir(): on macOS /tmp and /var are symlinks, and the updater
  // refuses to install from a path that contains one.
  work = await mkdtemp(path.join(homedir(), ".quarry-update-e2e-"));
  await mkdir(path.join(work, "logs"), { recursive: true });
  console.log(`work: ${work}`);

  key = await signingKey();
  await startServer();
  const origin = `http://127.0.0.1:${server.address().port}`;

  const old = await buildBundle({
    label: "current",
    config: overrideConfig(origin, null),
    key,
    origin,
  });
  // The newer build overwrites the same target directory, so the older one is
  // copied out before it starts — artifact and all, since what an installed
  // copy is made of is not the artifact on macOS (the .app) nor on Linux (the
  // AppImage inside the tarball).
  const oldBuild = await keepOldBuild(old);

  const next = await buildBundle({
    label: nextVersion,
    config: overrideConfig(origin, nextVersion),
    key,
    origin,
  });
  served.name = path.basename(next);
  const artifacts = {
    honest: await readFile(next),
    tampered: null,
    signature: (await readFile(`${next}.sig`, "utf8")).trim(),
    foreign: await foreignSignature(next, work),
  };
  artifacts.tampered = Buffer.from(artifacts.honest);
  artifacts.tampered[Math.floor(artifacts.tampered.length / 2)] ^= 0xff;

  const phases = [
    {
      name: "an honest artifact installs, restarts, and reports the new version",
      artifact: artifacts.honest,
      signature: artifacts.signature,
      updates: true,
    },
    {
      name: "a tampered artifact is refused",
      artifact: artifacts.tampered,
      signature: artifacts.signature,
      updates: false,
    },
    {
      name: "a signature from a foreign key is refused",
      artifact: artifacts.honest,
      signature: artifacts.foreign,
      updates: false,
    },
  ];

  for (const phase of phases) await runPhase(phase, oldBuild);

  await restoreBuild(key);
  console.log(`\n✓ all ${phases.length} phases behaved`);
}

// --- the check itself -------------------------------------------------------

async function runPhase(phase, oldBuild) {
  console.log(`\n→ ${phase.name}`);

  seen.steps.length = 0;
  seen.requests.length = 0;
  served.artifact = phase.artifact;
  served.manifest = manifest(phase.signature);

  const installed = await prepareInstall(oldBuild);
  assertNoSymlinks(installed.exe);
  const before = await fingerprint(installed.exe);
  console.log(`  installed: ${installed.description}`);

  const log = path.join(work, "logs", `${slug(phase.name)}.log`);
  child = launch(installed.exe, log);

  try {
    const introduced = await waitForStep(
      "the app to report it started",
      (step) => step.startsWith("start:"),
    );
    assert(
      introduced === `start:${currentVersion}:${contract.installer}`,
      `the app introduced itself as "${introduced}", not ${currentVersion} as ${contract.installer}`,
    );
    const checked = await waitForStep("the app to finish checking", (step) =>
      step.startsWith("after-check:"),
    );
    assert(
      checked === `after-check:available:${nextVersion}:${currentVersion}`,
      `the check saw "${checked}"`,
    );
    await waitForStep("the app to start installing", (step) => step.startsWith("installing:"));
    await waitFor("the app to fetch the artifact", () =>
      seen.requests.includes(`GET /${served.name}`),
    );

    if (phase.updates) {
      await waitFor(
        "the restarted app to report in",
        () => starts().length === 2,
        150_000,
      );
      assert(
        starts()[1] === `start:${nextVersion}:${contract.installer}`,
        `the app came back as "${starts()[1]}"`,
      );
      await waitForStep("the restarted app to find itself current", (step) =>
        step === "after-check:current",
      );
      assert(
        !seen.steps.some((step) => step.startsWith("install-error")),
        "the install reported a failure",
      );
      assert(
        (await fingerprint(installed.exe)) !== before,
        "the installed copy is byte for byte what it was before the update",
      );
      if (contract.installed === INSTALLED.appBundle) {
        assert(
          (await bundleVersion(installed.exe)) === nextVersion,
          `the installed bundle still says ${currentVersion}`,
        );
      }
    } else {
      await waitForStep("the install to be refused", (step) => step.startsWith("install-error:"));
      const refused = seen.steps.find((step) => step.startsWith("install-error:"));
      assert(/signature/i.test(refused), `the refusal did not mention the signature: ${refused}`);
      assert(starts().length === 1, "the app restarted after a refused install");
      assert(
        seen.steps.at(-1) === refused,
        `the app kept going after the refusal: ${seen.steps.join(", ")}`,
      );
      assert(
        (await fingerprint(installed.exe)) === before,
        "the installed copy changed after a refused install",
      );
      if (contract.installed === INSTALLED.appBundle) {
        assert(
          (await bundleVersion(installed.exe)) === currentVersion,
          "the installed bundle changed after a refused install",
        );
      }
    }

    console.log(
      phase.updates
        ? `  ✓ installed and restarted into ${nextVersion}`
        : `  ✓ refused ${nextVersion}`,
    );
    // The evidence, so a passing run reads as a sequence rather than a verdict.
    console.log(`    ${seen.steps.join(" | ")}`);
  } catch (error) {
    await dump(phase, log);
    throw error;
  } finally {
    await stopRun();
  }
}

function starts() {
  return seen.steps.filter((step) => step.startsWith("start:"));
}

/**
 * What the endpoint offers: the artifact, its signature, and the version. The
 * keys are the ones the updater looks up, typed one first — serving both is what
 * keeps the check about the app rather than about which shape of manifest a
 * release happened to publish (the plain key is the fallback, see
 * `Updater::get_urls`).
 */
function manifest(signature) {
  const url = `http://127.0.0.1:${server.address().port}/${served.name}`;
  return {
    version: nextVersion,
    notes: "Built by scripts/e2e-update.mjs.",
    pub_date: new Date().toISOString(),
    platforms: Object.fromEntries(contract.keys.map((key) => [key, { signature, url }])),
  };
}

// --- installing the older version, per platform -----------------------------

/**
 * Prepares the copy the app under test will run and update. What that means
 * differs per platform: a bundle to swap (macOS), a single executable that is
 * the app (Linux's AppImage), or an installer to run (Windows' NSIS) — and only
 * the last one leaves the app somewhere else entirely.
 */async function prepareInstall(oldBuild) {
  const install = path.join(work, "install");
  await rm(install, { recursive: true, force: true });
  await mkdir(install, { recursive: true });

  if (contract.installed === INSTALLED.appBundle) {
    const app = path.join(install, `${product}.app`);
    await cp(oldBuild.bundle, app, { recursive: true });
    // The executable inside a bundle is named after the binary, not the product.
    const inside = await readdir(path.join(app, "Contents", "MacOS"));
    return { exe: path.join(app, "Contents", "MacOS", inside[0]), description: `${product}.app` };
  }

  if (contract.installed === INSTALLED.appImage) {
    const exe = path.join(install, path.basename(oldBuild.image));
    await cp(oldBuild.image, exe);
    // The updater replaces this file in place, and it has to be runnable.
    await chmod(exe, 0o755);
    return { exe, description: path.basename(exe) };
  }

  // Windows: the installer puts the old version where the update expects to
  // find it, and a build run from the target directory has nothing to replace.
  await stopRun();
  await logged(oldBuild.artifact, ["/S"], { log: path.join(work, "logs", "install-old.log") });
  const exe = await waitFor("the silent install to put a copy down", installedExe, 60_000);
  return { exe, description: exe };
}

/**
 * The executable an NSIS install leaves behind, per user: `%LOCALAPPDATA%` plus
 * the product name. Which of the two names the binary has depends on how the
 * bundler named it, so both are tried before giving up and saying so.
 */
function installedExe() {
  const root = path.join(
    process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"),
    product,
  );
  for (const name of [`${product}.exe`, `${binary}.exe`]) {
    const candidate = path.join(root, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

// --- building ---------------------------------------------------------------

/**
 * Builds one bundle with the update check pointed at this run's server, and
 * returns the artifact it produced. The overrides go to the bundler as a file
 * rather than into `tauri.conf.json`, so a run leaves the repository alone.
 */
async function buildBundle({ label, config, key, origin }) {
  console.log(`\nbuilding ${label} (debug, ${contract.bundle})…`);
  const configPath = path.join(work, `${slug(label)}.conf.json`);
  await writeFile(configPath, JSON.stringify(config, null, 2));
  await logged(
    "npx",
    ["tauri", "build", "--debug", "--bundles", contract.bundle, "--config", configPath],
    {
      log: path.join(work, "logs", `${slug(label)}-build.log`),
      env: {
        TAURI_SIGNING_PRIVATE_KEY: key,
        VITE_UPDATE_PROBE: "1",
        VITE_UPDATE_PROBE_URL: origin,
      },
    },
  );

  const directory = path.join(BUNDLES, contract.directory);
  const entries = await readdir(directory);
  // The updater artifact is the one tauri signed; when a platform produces more
  // than one (Windows ships the installer and its zip), take the preferred one.
  const candidates = entries.filter(
    (entry) => contract.artifact.test(entry) && entries.includes(`${entry}.sig`),
  );
  if (candidates.length === 0) {
    throw setup(`the build produced no signed updater artifact in ${directory}: ${entries.join(", ")}`);
  }
  const chosen = contract.prefer
    ? (candidates.find((entry) => contract.prefer.test(entry)) ?? candidates[0])
    : candidates[0];
  console.log(`  artifact: ${chosen}`);
  return path.join(directory, chosen);
}

/**
 * Holds on to everything an installed copy can be made of: the signed artifact,
 * plus the bundle or the AppImage that the artifact only wraps. The next build
 * overwrites the target directory, so all of it has to be taken now.
 */
async function keepOldBuild(artifact) {
  const held = path.join(work, "old");
  await mkdir(held, { recursive: true });
  const kept = { artifact: path.join(held, path.basename(artifact)) };
  await cp(artifact, kept.artifact);
  await cp(`${artifact}.sig`, `${kept.artifact}.sig`);

  const built = path.join(BUNDLES, contract.directory);
  if (contract.installed === INSTALLED.appBundle) {
    kept.bundle = path.join(held, `${product}.app`);
    await cp(path.join(built, `${product}.app`), kept.bundle, { recursive: true });
  } else if (contract.installed === INSTALLED.appImage) {
    const entries = await readdir(built);
    const image = entries.find((entry) => contract.payload.test(entry));
    if (!image) throw setup(`the build produced no AppImage in ${built} to hold on to`);
    kept.image = path.join(held, image);
    await cp(path.join(built, image), kept.image);
  }
  return kept;
}

/** The bundler's config for this run: local endpoint, local CSP, next version. */
function overrideConfig(origin, version) {
  const csp = conf.app?.security?.csp;
  if (!csp) throw setup("tauri.conf.json has no CSP to extend for the probe's reports");

  return {
    ...(version ? { version } : {}),
    plugins: {
      updater: {
        ...conf.plugins.updater,
        endpoints: [`${origin}/latest.json`],
        // The endpoint is http, which the updater only accepts when the build
        // that talks to it says so.
        dangerousInsecureTransportProtocol: true,
      },
    },
    app: { security: { csp: allowOrigin(csp, origin) } },
  };
}

/** Adds the run's origin to the CSP's `connect-src`, which the probe needs. */
function allowOrigin(csp, origin) {
  const directives = csp.split(";").map((part) => part.trim()).filter(Boolean);
  const connect = directives.find((part) => part.startsWith("connect-src "));
  if (!connect) throw setup("the app CSP has no connect-src directive to extend");

  const sources = connect.slice("connect-src ".length).split(/\s+/);
  if (!sources.includes(origin)) sources.push(origin);
  return `${directives.map((part) => (part === connect ? `connect-src ${sources.join(" ")}` : part)).join("; ")};`;
}

/**
 * Puts an ordinary build of the repository's version back in the target
 * directory. The run's own bundles point at a local endpoint and carry the
 * probe, so leaving them there would be leaving a bundle nobody should launch.
 * A failure here says nothing about the update path, so it only warns.
 */
async function restoreBuild(key) {
  console.log("\nrebuilding the repository's version without the overrides…");
  try {
    await logged("npx", ["tauri", "build", "--debug", "--bundles", contract.bundle], {
      log: path.join(work, "logs", "restore-build.log"),
      env: { TAURI_SIGNING_PRIVATE_KEY: key },
    });
  } catch (error) {
    console.warn(`  ! ${error.message}`);
    console.warn("    the bundle in src-tauri/target is still this run's, not a plain build");
  }
}

/** Signs an honest artifact with a key this app does not trust. */
async function foreignSignature(artifact, dir) {
  const home = path.join(dir, "foreign");
  await mkdir(home, { recursive: true });
  const key = path.join(home, "foreign.key");
  const copy = path.join(home, path.basename(artifact));
  await cp(artifact, copy);

  await logged("npx", ["tauri", "signer", "generate", "-w", key, "-p", "", "--ci", "-f"], {
    log: path.join(dir, "logs", "foreign-key.log"),
  });
  await logged("npx", ["tauri", "signer", "sign", "-f", key, copy], {
    log: path.join(dir, "logs", "foreign-sign.log"),
  });
  return (await readFile(`${copy}.sig`, "utf8")).trim();
}

// --- the app under test -----------------------------------------------------

function launch(exe, log) {
  const out = openSync(log, "w");
  // Detached so the app gets a process group of its own: the restarted process
  // inherits it, and one kill takes the whole run down.
  const started = spawn(exe, [], { detached: true, stdio: ["ignore", out, out] });
  started.on("error", (error) => console.error(`  the app did not start: ${error.message}`));
  started.unref();
  return started;
}

async function stopRun() {
  if (child?.pid) {
    try {
      if (process.platform === "win32") {
        await run("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
      } else {
        process.kill(-child.pid, "SIGKILL");
      }
    } catch {
      // Already gone, or the group went with it.
    }
    child = null;
  }
  if (!work) return;

  // The restarted process is nobody's child by then, so sweep for whatever is
  // running out of this run's own paths.
  const install = path.join(work, "install");
  try {
    if (process.platform === "win32") {
      await run("powershell", [
        "-NoProfile",
        "-Command",
        `Get-Process | Where-Object { $_.Path -like '${install}*' } | Stop-Process -Force`,
      ]);
      return;
    }
    const { stdout } = await run("ps", ["-axo", "pid=,command="]);
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.includes(install) || trimmed.startsWith("ps ")) continue;
      const pid = Number(trimmed.split(/\s+/, 1)[0]);
      if (pid > 0) process.kill(pid, "SIGKILL");
    }
  } catch {
    // No process list to sweep, or nothing matched.
  }
}

/** The SHA-256 of a file, which is how "the copy on disk changed" is meant. */
async function fingerprint(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

/** macOS: the version inside the installed bundle, read from its Info.plist. */
async function bundleVersion(exe) {
  const plist = path.join(path.dirname(path.dirname(exe)), "Info.plist");
  const { stdout } = await run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleShortVersionString",
    plist,
  ]);
  return stdout.trim();
}

// --- the server the app talks to --------------------------------------------

function startServer() {
  server = createServer((request, response) => {
    const { pathname } = new URL(request.url, "http://127.0.0.1");
    seen.requests.push(`${request.method} ${pathname}`);

    if (pathname.startsWith("/probe/")) {
      seen.steps.push(decodeURIComponent(pathname.slice("/probe/".length)));
      response.writeHead(204, { "access-control-allow-origin": "*" });
      response.end();
      return;
    }
    if (pathname === "/latest.json") {
      return send(response, "application/json", Buffer.from(JSON.stringify(served.manifest)));
    }
    if (pathname === `/${served.name}`) {
      // Whatever the platform's updater artifact is: a tarball, an installer.
      return send(response, "application/octet-stream", served.artifact);
    }
    response.writeHead(404).end();
  });

  return new Promise((done) => server.listen(0, "127.0.0.1", done));
}

function send(response, type, body) {
  response.writeHead(200, { "content-type": type, "content-length": body.length });
  response.end(body);
}

// --- plumbing ---------------------------------------------------------------

/** Resolves the updater signing key, without ever naming it in output. */
async function signingKey() {
  const inline = process.env.TAURI_SIGNING_PRIVATE_KEY;
  const fromPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH;
  if (inline && inline.includes("untrusted comment")) return inline;
  const file = fromPath ?? inline ?? path.join(homedir(), ".tauri", "quarry.key");
  try {
    return await readFile(file, "utf8");
  } catch {
    throw setup(`no updater signing key: set TAURI_SIGNING_PRIVATE_KEY or put one at ${file}`);
  }
}

async function preflight() {
  if (!conf.plugins?.updater?.pubkey) {
    throw setup("tauri.conf.json has no updater pubkey, so nothing could be verified");
  }
  // Caught here rather than by a phase: an update that is not newer is not an
  // update, and finding out by timing out on a phase says less.
  if (compare(nextVersion, currentVersion) <= 0) {
    throw setup(`--next must be newer than ${currentVersion}, not ${nextVersion}`);
  }

  // The app opens a window, so a session without one would spend two builds
  // before timing out on a phase.
  if (process.platform === "darwin") {
    const session = await run("launchctl", ["managername"])
      .then(({ stdout }) => stdout.trim())
      .catch(() => "");
    if (session !== "Aqua") {
      throw setup(`the app needs a GUI session to open its window, not "${session || "unknown"}"`);
    }
  } else if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw setup("the app needs a display to open its window: set DISPLAY or WAYLAND_DISPLAY");
  }
}

/**
 * macOS is the one platform where the updater refuses to start if the path to
 * the executable contains a symlink (tauri-utils' StartingBinary checks it
 * there and nowhere else), which makes the install location a real constraint
 * rather than a stylistic one — better to say so here than to fail later with
 * the plugin's own wording.
 */
function assertNoSymlinks(target) {
  if (process.platform !== "darwin") return;

  const parts = [];
  let at = path.resolve(target);
  while (true) {
    parts.push(at);
    const up = path.dirname(at);
    if (up === at) break;
    at = up;
  }
  const links = parts.filter((part) => {
    try {
      return lstatSync(part).isSymbolicLink();
    } catch {
      return false;
    }
  });
  if (links.length > 0) throw setup(`the install path has a symlink in it: ${links.join(", ")}`);
}

async function waitFor(what, met, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const found = await met();
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

/** Waits for the app to report a step, and returns that step. */
async function waitForStep(what, matches) {
  return waitFor(what, () => seen.steps.find((step) => matches(step)));
}

function assert(held, detail) {
  if (!held) throw new Error(detail);
}

/** A failed phase is read from its log, which is the only thing it left. */
async function dump(phase, log) {
  console.error(`  reported: ${seen.steps.join(" | ") || "(nothing)"}`);
  console.error(`  fetched:  ${seen.requests.join(" | ") || "(nothing)"}`);
  try {
    const text = await readFile(log, "utf8");
    const tail = text.split("\n").slice(-20).join("\n").trim();
    if (tail) console.error(`  app said:\n${tail.replace(/^/gm, "    ")}`);
  } catch {
    // No log: the app never wrote one.
  }
  console.error(`  phase: ${phase.name}`);
}

function bumpPatch(version) {
  return version.replace(/(\d+)$/, (part) => String(Number(part) + 1));
}

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function setup(message) {
  const error = new Error(message);
  error.setup = true;
  return error;
}

/** Runs a command with its output in a file, and its environment extended. */
function logged(command, args, { log, env }) {
  return new Promise((done, fail) => {
    const out = openSync(log, "w");
    const running = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", out, out],
    });
    running.on("error", fail);
    running.on("exit", (code) => {
      closeSync(out);
      if (code === 0) done();
      else fail(new Error(`${command} ${args.join(" ")} exited ${code}: see ${log}`));
    });
  });
}

/** Orders the numeric halves of two versions; `--next` is a test input, so
 *  pre-release ordering is not modelled. */
function compare(left, right) {
  const parts = (version) => version.split(".").map((part) => Number(part) || 0);
  const one = parts(left);
  const two = parts(right);
  for (let at = 0; at < Math.max(one.length, two.length); at += 1) {
    const difference = (one[at] ?? 0) - (two[at] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/** Every platform's contract, which is also what the tests pin. */
function reportContracts() {
  console.log("platform contracts — the shapes an update takes, per platform\n");
  for (const platform of allPlatforms()) {
    const here = platform.os === contract.os ? "  ← this machine" : "";
    console.log(`${platform.name}${here}`);
    console.log(`  build:      tauri build --bundles ${platform.bundle} → bundle/${platform.directory}`);
    console.log(
      `  artifact:   ${platform.artifact.source}${platform.prefer ? `, preferring ${platform.prefer.source}` : ""}`,
    );
    console.log(`  manifest:   {os}-{arch}-{installer}, then {os}-{arch}`);
    console.log(`              e.g. ${platform.keys.join(", then ")}`);
    console.log(`  installed:  ${platform.installed}`);
    for (const note of platform.notes) console.log(`  · ${note}`);
    console.log("");
  }

  console.log("everywhere");
  console.log(
    "  · the keys are tried in that order, and {arch} is the updater's spelling; setting plugins.updater.target replaces the whole list with the one target it names",
  );
  console.log(
    "  · the check serves http on loopback, which a release build refuses without dangerousInsecureTransportProtocol — a debug build only warns",
  );
  console.log(
    "  · the probe reports over the app's own CSP, so a run widens connect-src with its origin",
  );
  console.log(
    `  · this machine would check ${contract.name} (${contract.arch}), where the update path ${
      process.platform === "darwin" ? "has been run" : "has not been run"
    }`,
  );
}
