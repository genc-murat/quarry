import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  compareVersions,
  expectedTargets,
  isVersion,
  validateManifest,
  versionsMatch,
} from "./releaseManifest.mjs";

/**
 * The manifest rules are checked here rather than against a live release,
 * because the interesting cases are the ones a real release does not have: a key
 * nobody reads, a platform left out, a Linux tarball offered to Windows.
 *
 * The first test reads the project's own release workflow, so the targets a
 * manifest is judged against are the ones the workflow actually builds. If the
 * matrix gains a platform and this check does not know it, that test is where it
 * shows up.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const WORKFLOW = `      matrix:
        include:
          - platform: macos-latest
            args: --target aarch64-apple-darwin
          - platform: macos-latest
            args: --target x86_64-apple-darwin
          - platform: ubuntu-22.04
            args: ""
          - platform: windows-latest
            args: ""
`;

const targets = expectedTargets(WORKFLOW);

/** A manifest that would install everywhere, so each test can break one thing. */
function release(version = "0.1.0") {
  return {
    version,
    notes: "Desktop builds",
    pub_date: "2026-10-12T03:00:00Z",
    platforms: {
      "darwin-aarch64-app": entry("Quarry.app.tar.gz"),
      "darwin-aarch64": entry("Quarry.app.tar.gz"),
      "darwin-x86_64-app": entry("Quarry.app.tar.gz"),
      "darwin-x86_64": entry("Quarry.app.tar.gz"),
      "linux-x86_64-appimage": entry(`Quarry_${version}_amd64.AppImage.tar.gz`),
      "linux-x86_64": entry(`Quarry_${version}_amd64.AppImage.tar.gz`),
      "windows-x86_64-nsis": entry(`Quarry_${version}_x64-setup.nsis.zip`),
      "windows-x86_64": entry(`Quarry_${version}_x64-setup.nsis.zip`),
    },
  };
}

function entry(name, signature = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo=") {
  return { signature, url: `https://github.com/example/quarry/releases/download/v0.1.0/${name}` };
}

/** The problems one manifest produces, for a test to match against. */
function problemsOf(manifest, options) {
  return validateManifest(manifest, { targets, ...options }).problems;
}

test("the platforms a release must carry come from the release workflow", async () => {
  const mine = expectedTargets(await readFile(path.join(ROOT, ".github/workflows/release.yml"), "utf8"));

  assert.deepEqual(
    mine.map((target) => `${target.platform}-${target.arch}`),
    ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"],
    "the two macOS architectures and the one each of Linux and Windows",
  );
  assert.deepEqual(mine[0].keys, ["darwin-aarch64-app", "darwin-aarch64"]);
  assert.deepEqual(mine[3].keys, ["windows-x86_64-nsis", "windows-x86_64"]);
});

test("a runner with no --target builds for its own architecture", () => {
  assert.deepEqual(
    targets.map((target) => target.triple),
    ["aarch64-apple-darwin", "x86_64-apple-darwin", "ubuntu-22.04 (its own architecture)", "windows-latest (its own architecture)"],
  );
});

test("several targets in one matrix entry are all read", () => {
  const both = expectedTargets(`        include:
          - platform: macos-latest
            args: --target aarch64-apple-darwin --target x86_64-apple-darwin
`);
  assert.deepEqual(both.map((target) => target.arch), ["arm64", "x64"]);
});

test("a target this check cannot place is refused, not passed over", () => {
  assert.throws(
    () => expectedTargets("        include:\n          - platform: macos-latest\n            args: --target riscv64gc-unknown-linux-gnu\n"),
    /not a target this check knows/,
  );
  assert.throws(() => expectedTargets("        include:\n          - platform: freebsd-13\n            args: \"\"\n"), /not a target this check knows/);
  assert.throws(() => expectedTargets("jobs:\n  publish:\n    steps: []\n"), /no build matrix/);
});

test("a manifest that would install everywhere has nothing wrong with it", () => {
  const { problems, notes, resolved } = validateManifest(release(), { targets });

  assert.deepEqual(problems, []);
  assert.deepEqual(
    resolved.map((target) => target.key),
    ["darwin-aarch64-app", "darwin-x86_64-app", "linux-x86_64-appimage", "windows-x86_64-nsis"],
    "each target is named by the key the app looks up first",
  );
  assert.ok(notes.some((note) => /macOS \(arm64\) resolves through darwin-aarch64-app/.test(note)));
});

test("the plain key is a fallback, not a mistake", () => {
  const manifest = release();
  delete manifest.platforms["windows-x86_64-nsis"];

  const { problems, notes } = validateManifest(manifest, { targets });
  assert.deepEqual(problems, []);
  assert.ok(notes.some((note) => /Windows \(x64\) resolves through windows-x86_64 — windows-x86_64-nsis is missing/.test(note)));
});

test("a platform the workflow built with no entry at all is a problem", () => {
  const manifest = release();
  delete manifest.platforms["windows-x86_64-nsis"];
  delete manifest.platforms["windows-x86_64"];

  assert.match(
    problemsOf(manifest).join("\n"),
    /Windows \(x64\) has no entry at all: this release cannot update it \(needs windows-x86_64-nsis or windows-x86_64\)/,
  );
});

test("a key no app looks up is a problem, and says what was probably meant", () => {
  const manifest = release();
  // Node's spelling of the architecture is exactly the mistake this catches.
  manifest.platforms["darwin-arm64"] = entry("Quarry.app.tar.gz");
  manifest.platforms["darwin-arm64-app"] = entry("Quarry.app.tar.gz");

  const problems = problemsOf(manifest).join("\n");
  assert.match(problems, /darwin-arm64 is not a key any app looks up, so this entry would never be read; the updater spells it darwin-aarch64/);
  assert.match(problems, /darwin-arm64-app .*; the updater spells it darwin-aarch64-app/);
});

test("a key that is wrong in another way lists that platform's keys", () => {
  const manifest = release();
  manifest.platforms["darwin-i686-msi"] = entry("Quarry.app.tar.gz");

  const problems = problemsOf(manifest).join("\n");
  assert.match(problems, /darwin-i686-msi is not a key any app looks up/);
  assert.match(problems, /\(keys on darwin: darwin-x86_64-app, darwin-x86_64, /);
  assert.match(problems, /darwin-aarch64-app, darwin-aarch64, /);
  assert.ok(!problems.includes("windows-"), "only that platform's keys, not all thirty");
});

test("an artifact from another platform is a problem", () => {
  const manifest = release();
  manifest.platforms["darwin-aarch64-app"] = entry("Quarry_0.1.0_amd64.AppImage.tar.gz");

  assert.match(problemsOf(manifest).join("\n"), /not a macOS updater artifact \(expected \/\\\.app\\\.tar\\\.gz\$\/\)/);
});

test("an artifact named for another version is a problem", () => {
  const manifest = release();
  manifest.platforms["linux-x86_64-appimage"] = entry("Quarry_9.9.9_amd64.AppImage.tar.gz");

  assert.match(problemsOf(manifest).join("\n"), /named for version 9\.9\.9, not 0\.1\.0/);
});

test("a URL that is a template, relative, or plain http is a problem", () => {
  const templated = release();
  templated.platforms["darwin-aarch64"] = { signature: "sig", url: "https://example.invalid/{{artifact}}" };
  assert.match(problemsOf(templated).join("\n"), /still contains a template variable/);

  const relative = release();
  relative.platforms["darwin-aarch64"] = { signature: "sig", url: "Quarry.app.tar.gz" };
  assert.match(problemsOf(relative).join("\n"), /not an absolute URL/);

  const insecure = release();
  insecure.platforms["darwin-aarch64"] = entry("Quarry.app.tar.gz");
  insecure.platforms["darwin-aarch64"].url = "http://example.invalid/Quarry.app.tar.gz";
  assert.match(problemsOf(insecure).join("\n"), /which is not https/);
  // ... which is only tolerated for a manifest served from this machine.
  assert.deepEqual(problemsOf(insecure, { allowHttp: true }), []);
});

test("an entry with no signature or no url says which it is missing", () => {
  const manifest = release();
  delete manifest.platforms["darwin-aarch64"].signature;
  manifest.platforms["linux-x86_64"] = { signature: "sig" };

  const problems = problemsOf(manifest).join("\n");
  assert.match(problems, /darwin-aarch64 has no signature/);
  assert.match(problems, /linux-x86_64 has no url/);
});

test("a manifest that is not a manifest is refused rather than read", () => {
  assert.match(problemsOf({ version: "one", platforms: {} }).join("\n"), /version "one" is not a version/);
  assert.match(problemsOf({ version: "0.1.0", platforms: {} }).join("\n"), /platforms object is empty/);
  assert.match(problemsOf({ version: "0.1.0" }).join("\n"), /no platforms object/);
  assert.match(
    problemsOf({ version: "0.1.0", pub_date: "yesterday", platforms: { "darwin-aarch64": entry("Quarry.app.tar.gz") } }).join("\n"),
    /pub_date "yesterday" is not a date/,
  );
  assert.match(problemsOf(null).join("\n"), /not a JSON object/);
});

test("plugins.updater.target replaces the whole lookup list with one key", () => {
  const override = "darwin-aarch64-app";
  const overridden = expectedTargets(WORKFLOW, { override });
  assert.deepEqual(
    overridden.map((target) => target.keys),
    [[override], [override], [override], [override]],
    "every platform looks up that one key when the config names it",
  );

  // A manifest with the full default list: the one override key is read, and
  // every other key — including the ones that are correct by default — is not.
  const { problems, resolved } = validateManifest(release(), { targets: overridden, override });
  assert.equal(resolved.length, 4, "all four targets resolve through the override key");
  assert.match(problems.join("\n"), /darwin-x86_64 is not the key this app looks up: plugins\.updater\.target makes it read only darwin-aarch64-app/);
  assert.equal(problems.length, 7, "the other seven keys are all dead weight");
  assert.ok(!problems.some((problem) => /never be read \(keys on/.test(problem)), "not the spelling advice, which is about the default list");
});

test("a target this check does not know is checked as far as it can be", () => {
  const override = "quarry-desktop";
  const only = { version: "0.1.0", platforms: { [override]: entry("Quarry.app.tar.gz") } };
  const onlyTargets = expectedTargets(WORKFLOW, { override });

  const { problems, notes } = validateManifest(only, { targets: onlyTargets, override });
  assert.deepEqual(problems, []);
  assert.ok(notes.some((note) => /not a target this check knows a platform for/.test(note)));

  // ... but its signature and URL are still checked, which is the part that
  // does not depend on knowing what the name means.
  const broken = { version: "0.1.0", platforms: { [override]: { signature: "", url: "Quarry.app.tar.gz" } } };
  const brokenProblems = validateManifest(broken, { targets: onlyTargets, override }).problems.join("\n");
  assert.match(brokenProblems, /has no signature/);
  assert.match(brokenProblems, /not an absolute URL/);
});

test("a platform this build did not make is fine to publish", () => {
  const manifest = release();
  manifest.platforms["linux-aarch64"] = entry("Quarry_0.1.0_aarch64.AppImage.tar.gz");

  assert.deepEqual(problemsOf(manifest), [], "an extra platform is not a fault");
});

test("versions are compared the way the updater compares them", () => {
  assert.equal(isVersion("0.1.0"), true);
  assert.equal(isVersion("0.1.0-rc.1"), true);
  assert.equal(isVersion("v0.1.0"), false, "the tag has a v; the version does not");
  assert.equal(isVersion("0.1"), false);

  assert.equal(compareVersions("0.1.0", "0.2.0"), -1);
  assert.equal(compareVersions("0.2.0", "0.2.0"), 0);
  assert.equal(compareVersions("1.0.0", "0.9.9"), 1);
  assert.equal(compareVersions("0.2.0-rc.1", "0.2.0"), -1, "a prerelease is older than the release");
  assert.equal(compareVersions("0.2.0-rc.2", "0.2.0-rc.10"), -1, "numeric prerelease fields compare as numbers");
  assert.equal(compareVersions("0.1.0", "one"), null, "an unparseable version has no order");
});

test("what a signature was made for matches what the endpoint announced", () => {
  // The plugin compares these as semver, so a `v` prefix is not a difference;
  // reporting one as a problem would be reporting a fault the app does not have.
  assert.equal(versionsMatch("v0.1.0", "0.1.0"), true);
  assert.equal(versionsMatch("0.1.0", "0.1.0"), true);
  assert.equal(versionsMatch("0.1.0", "0.2.0"), false);
  assert.equal(versionsMatch("0.2.0-rc.1", "0.2.0"), false);

  // ... and literally when either is not a version at all.
  assert.equal(versionsMatch("nightly", "nightly"), true);
  assert.equal(versionsMatch("nightly", "vnightly"), false, "not a version, so not trimmed either");
});
