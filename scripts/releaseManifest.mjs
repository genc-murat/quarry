/**
 * What a `latest.json` has to say for an installed app to be able to update from
 * it — as rules, so the release check can be wrong about it out loud instead of
 * only in a browser.
 *
 * Two directions, and the check needs both:
 *
 * - `expectedTargets(workflow)` reads the build matrix out of the release
 *   workflow. Which platforms a release must carry is not a fact about the
 *   manifest; it is a fact about what the workflow built, and reading it is the
 *   difference between "the manifest is well formed" and "the manifest can update
 *   the three platforms this project ships". A target names the updater's own
 *   keys, via `updatePlatforms.mjs`, so the names here cannot drift from the ones
 *   the app looks up.
 * - `validateManifest(manifest, { targets })` reads a real manifest and reports
 *   every way it fails to be installable: a version that is not one, a key no
 *   app ever asks for, a target with no key at all, a URL pointing at another
 *   platform's artifact, a template that was never substituted, an artifact
 *   whose name carries a version other than the manifest's.
 *
 * What it deliberately does not do is check a signature: that is
 * `minisign.mjs` and it needs the artifact. This file only needs the JSON, so
 * the rules can be tested without a network or a release.
 */
import { manifestLookups, updaterArchitecture, updatePlatform } from "./updatePlatforms.mjs";

/**
 * Rust target triple → what Node calls that platform and architecture, so a
 * triple can be turned into the manifest keys the updater on it would look up.
 * The triples are the ones the workflow names; a triple the check cannot place
 * is refused rather than guessed, because guessing here means a release that
 * silently omits a platform.
 */
const TRIPLES = {
  "aarch64-apple-darwin": ["darwin", "arm64"],
  "x86_64-apple-darwin": ["darwin", "x64"],
  "aarch64-unknown-linux-gnu": ["linux", "arm64"],
  "x86_64-unknown-linux-gnu": ["linux", "x64"],
  "x86_64-unknown-linux-musl": ["linux", "x64"],
  "armv7-unknown-linux-gnueabihf": ["linux", "arm"],
  "i686-unknown-linux-gnu": ["linux", "ia32"],
  "x86_64-pc-windows-msvc": ["win32", "x64"],
  "aarch64-pc-windows-msvc": ["win32", "arm64"],
  "i686-pc-windows-msvc": ["win32", "ia32"],
};

/** A runner without `--target` builds for its own architecture, which is this. */
const RUNNERS = [
  [/^macos/, ["darwin", "arm64"]],
  [/^ubuntu|^linux/, ["linux", "x64"]],
  [/^windows/, ["win32", "x64"]],
];

/**
 * The platforms a release built, taken from the workflow's matrix: each entry's
 * `--target` if it has one, and the runner's own architecture if it does not
 * (which is how the Linux and Windows entries are written). `override` is
 * `plugins.updater.target` when the config sets one, because then every platform
 * looks up that one key instead of its own.
 */
export function expectedTargets(workflow, { override } = {}) {
  const items = matrixItems(workflow);
  if (!items.length) {
    throw new Error(
      "no build matrix was found in the release workflow, so there is no way to know which platforms a release must carry",
    );
  }

  const targets = [];
  for (const item of items) {
    const named = [...item.args.matchAll(/--target[=\s]+(\S+)/g)].map((match) => match[1]);
    const intended = named.length
      ? named.map((triple) => ({ triple, found: TRIPLES[triple] }))
      : [{ triple: null, found: runnerTarget(item.runner) }];

    for (const { triple, found } of intended) {
      if (!found) {
        throw new Error(
          `the release workflow builds for ${triple ?? item.runner}, which is not a target this check knows; add it to TRIPLES in releaseManifest.mjs`,
        );
      }
      const [platform, arch] = found;
      const contract = updatePlatform(platform, arch, override);
      targets.push({
        triple: triple ?? `${item.runner} (its own architecture)`,
        runner: item.runner,
        platform,
        arch,
        name: contract.name,
        keys: contract.keys,
      });
    }
  }
  return targets;
}

/** The matrix's `platform:`/`args:` pairs, in the order the workflow lists them. */
function matrixItems(workflow) {
  const items = [];
  for (const line of String(workflow).split("\n")) {
    const runner = line.match(/^\s*-\s*platform:\s*(\S+)\s*$/);
    if (runner) {
      items.push({ runner: unquote(runner[1]), args: "" });
      continue;
    }
    const args = line.match(/^\s*args:\s*(.*)$/);
    if (args && items.length) items.at(-1).args = unquote(args[1]);
  }
  return items;
}

function unquote(value) {
  return value.trim().replace(/^["']|["']$/g, "").trim();
}

function runnerTarget(runner) {
  for (const [pattern, found] of RUNNERS) if (pattern.test(runner)) return found;
  return null;
}

/**
 * Every way a manifest cannot be installed from, grouped by the entry that
 * caused it. `notes` are the observations that are not faults — which key a
 * target will resolve through, a version the artifact name agrees with — because
 * a release check that only speaks on failure is one nobody reads.
 */
export function validateManifest(manifest, { targets, allowHttp = false, override } = {}) {
  const problems = [];
  const notes = [];
  const lookups = manifestLookups();
  const entries = [];

  // With `plugins.updater.target` set, one key is looked up by every platform and
  // every other key in the manifest is never read — including the ones this
  // check would otherwise consider correct.
  const keyOf = (name) => {
    if (override) return name === override ? known(name) : null;
    return lookups.has(name) ? known(name) : null;
  };
  const known = (name) =>
    lookups.get(name) ?? { key: name, name: null, os: null, arch: null, typed: true, artifact: null };

  if (!manifest || typeof manifest !== "object") {
    return { problems: ["the manifest is not a JSON object"], notes, entries, resolved: [] };
  }

  const version = manifest.version;
  if (typeof version !== "string" || !isVersion(version)) {
    problems.push(`the manifest's version ${JSON.stringify(version ?? null)} is not a version`);
  }

  if (manifest.pub_date !== undefined && Number.isNaN(Date.parse(manifest.pub_date))) {
    problems.push(`the manifest's pub_date ${JSON.stringify(manifest.pub_date)} is not a date`);
  }

  const platforms = manifest.platforms;
  if (!platforms || typeof platforms !== "object" || Array.isArray(platforms)) {
    problems.push("the manifest has no platforms object");
    return { problems, notes, entries, resolved: [] };
  }
  if (!Object.keys(platforms).length) problems.push("the manifest's platforms object is empty");

  for (const [key, entry] of Object.entries(platforms)) {
    const lookup = keyOf(key);
    const found = { key, lookup, platform: lookup?.os ?? null, arch: lookup?.arch ?? null, typed: lookup?.typed ?? null };

    if (!lookup) {
      problems.push(
        override
          ? `${key} is not the key this app looks up: plugins.updater.target makes it read only ${override}, so this entry would never be read`
          : `${key} is not a key any app looks up, so this entry would never be read${unknownKeyHint(key, lookups)}`,
      );
    } else if (!lookup.artifact) {
      notes.push(
        `${override} is not a target this check knows a platform for, so only its name and signature can be checked, not the artifact's form`,
      );
    }
    if (!entry || typeof entry !== "object") {
      problems.push(`${key} has no url and signature`);
      entries.push(found);
      continue;
    }

    const url = typeof entry.url === "string" ? entry.url : "";
    const signature = typeof entry.signature === "string" ? entry.signature.trim() : "";

    if (!signature) problems.push(`${key} has no signature, so nothing about it could be verified`);
    if (!url) {
      problems.push(`${key} has no url`);
      entries.push(found);
      continue;
    }
    if (/\{\{|\$\{/.test(url)) {
      problems.push(`${key} points at ${url}, which still contains a template variable`);
    } else {
      // The updater hands the URL to its HTTP client as it finds it, so a
      // relative one fails there; failing it here says why.
      let parsed = null;
      try {
        parsed = new URL(url);
      } catch {
        problems.push(`${key} points at ${url}, which is not an absolute URL`);
      }
      if (parsed && parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
        problems.push(`${key} points at ${url}, which is not https`);
      }
    }

    const name = basename(url);
    found.url = url;
    found.signature = signature;
    found.name = name;

    if (lookup?.artifact && !lookup.artifact.test(name)) {
      problems.push(
        `${key} points at ${name}, which is not a ${lookup.name} updater artifact (expected ${lookup.artifact})`,
      );
    }

    // The bundler puts the version in the Linux and Windows artifact names. When
    // it is there it has to be this release's, or the entry is offering another
    // version's file under this version's number.
    const named = versionInName(name);
    if (named) {
      if (version && named !== version) {
        problems.push(`${key} points at ${name}, which is named for version ${named}, not ${version}`);
      } else if (named === version && !notes.includes(`the artifacts are named for version ${named}, which agrees`)) {
        // The typed key and the plain one name one artifact; saying this twice
        // is noise, not emphasis.
        notes.push(`the artifacts are named for version ${named}, which agrees`);
      }
    }

    entries.push(found);
  }

  const resolved = [];
  for (const target of targets ?? []) {
    const key = target.keys.find((candidate) => candidate in platforms);
    if (!key) {
      problems.push(
        `${target.name} (${target.arch}) has no entry at all: this release cannot update it (needs ${target.keys.join(" or ")})`,
      );
      continue;
    }
    resolved.push({ ...target, key, typed: key === target.keys[0] });
    notes.push(
      `${target.name} (${target.arch}) resolves through ${key}${key === target.keys[0] ? "" : ` — ${target.keys[0]} is missing, so the app falls back to the plain key`}`,
    );
  }

  return { problems, notes, entries, resolved };
}

/**
 * Why a key might not be read, said in the terms of the mistake: the updater's
 * architecture spelling is not Node's, and `darwin-arm64` is what that looks
 * like in a manifest. Otherwise the keys on the same platform are the useful
 * thing to print — all of them, across three platforms and five architectures,
 * is a wall nobody reads.
 */
function unknownKeyHint(key, lookups) {
  const [os, architecture, ...rest] = key.split("-");
  const respelled = updaterArchitecture(architecture);
  if (respelled) {
    const suggestion = [os, respelled, ...rest].join("-");
    if (lookups.has(suggestion)) return `; the updater spells it ${suggestion}`;
  }
  const sameOs = [...lookups.keys()].filter((known) => known.startsWith(`${os}-`));
  return sameOs.length ? ` (keys on ${os}: ${sameOs.join(", ")})` : ` (known keys: ${[...lookups.keys()].join(", ")})`;
}

/** The file name in a URL, without its query or fragment. */
export function basename(url) {
  const path = String(url).replace(/[?#].*$/, "");
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The version a bundler bakes into an artifact name, when it bakes one in. */
function versionInName(name) {
  return name.match(/_(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)_/)?.[1] ?? null;
}

/**
 * Whether a string is a version the updater would accept. It compares versions
 * with the `semver` crate, which refuses anything looser than this, and an
 * unparseable version in a manifest is a release nobody can install rather than
 * a formatting nit.
 */
export function isVersion(value) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(String(value));
}

/**
 * Whether two versions are the same version, the way the updater decides it when
 * it checks what a signature was made for against what the endpoint announced:
 * as semver when both parse, and literally when they do not. So `v1.2.3` and
 * `1.2.3` are the same version there, and comparing them any more strictly here
 * would report a problem the app does not have.
 */
export function versionsMatch(one, other) {
  const ordered = compareVersions(String(one).replace(/^v/, ""), String(other).replace(/^v/, ""));
  return ordered === null ? one === other : ordered === 0;
}

/**
 * Compare two versions the way semver does, or `null` when either is not one —
 * because "this release is newer than the app" is the whole question, and
 * guessing at an unparseable version would answer it wrongly.
 */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;

  for (const field of ["major", "minor", "patch"]) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }
  // A prerelease is older than the release it leads to.
  if (a.prerelease.length && !b.prerelease.length) return -1;
  if (!a.prerelease.length && b.prerelease.length) return 1;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i += 1) {
    const one = a.prerelease[i];
    const other = b.prerelease[i];
    if (one === undefined) return -1;
    if (other === undefined) return 1;
    if (one === other) continue;
    const numeric = /^\d+$/.test(one) && /^\d+$/.test(other);
    if (numeric) return Number(one) < Number(other) ? -1 : 1;
    return one < other ? -1 : 1;
  }
  return 0;
}

function parseVersion(value) {
  const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}
