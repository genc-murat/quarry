/**
 * Check a published release the way this app would use it: download the
 * `latest.json` the updater endpoint resolves, then every artifact it points at,
 * and verify each with the public key in `src-tauri/tauri.conf.json`.
 *
 * The end-to-end script (`e2e-update.mjs`) proves the instalment path works by
 * installing a build it made itself, with a key it generated itself. This script
 * asks the other half of the question, about a release nobody has run yet:
 *
 *   - does the endpoint resolve, and does the manifest carry a version, a date
 *     and a `platforms` entry for every platform the workflow built?
 *   - is every key in it a key some app actually looks up, and does each entry
 *     point at that platform's artifact rather than at another platform's?
 *   - does the artifact download, and does the signature *in the manifest*
 *     verify against the configured public key — with the key id, so a release
 *     signed by the wrong key says so instead of "verification failed"?
 *   - does the trusted comment, which the second signature vouches for, name
 *     this artifact and this version?
 *   - does the `.sig` asset published next to it say the same thing as the
 *     manifest?
 *
 * Two halves, because they fail differently: the manifest rules are
 * `releaseManifest.mjs` and the signature format is `minisign.mjs`, both checked
 * without a network by their own tests. This file is the one that downloads.
 *
 *   node scripts/check-release.mjs                    # the published latest release
 *   node scripts/check-release.mjs --expect v0.2.0    # ... and the version it must be
 *   node scripts/check-release.mjs --manifest <url|path>
 *   node scripts/check-release.mjs --only darwin-aarch64
 *   node scripts/check-release.mjs --no-artifacts     # the manifest only
 *
 * Exits 0 when everything verified, 1 when something is wrong with the release,
 * and 2 when the check itself could not be run (no release published yet, no
 * pubkey configured, no network) — because those are different problems, and
 * only one of them is about the release.
 *
 * It never writes the repository except through `--save`, and it never installs
 * anything: an artifact that verifies has been read, not run.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  artifactDigest,
  decodePublicKey,
  decodeSignature,
  formatKeyId,
  parseTrustedComment,
  sameSignature,
  verifyArtifact,
} from "./minisign.mjs";
import {
  basename,
  compareVersions,
  expectedTargets,
  isVersion,
  validateManifest,
  versionsMatch,
} from "./releaseManifest.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONF = path.join(ROOT, "src-tauri/tauri.conf.json");
const WORKFLOW = path.join(ROOT, ".github/workflows/release.yml");

/** How long to wait for a manifest, and for a bundle. */
const MANIFEST_TIMEOUT = 30_000;
const ARTIFACT_TIMEOUT = 300_000;
/** A bundle bigger than this is a mistake, not a slow download. */
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
/** A `.sig` asset is a few hundred bytes; anything larger is not one. */
const MAX_SIG_BYTES = 64 * 1024;

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const value = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};

try {
  if (has("--help") || has("-h")) usage();
  else await main();
} catch (error) {
  console.error(`\n✗ ${error.message}`);
  process.exitCode = error.setup ? 2 : 1;
}

async function main() {
  const conf = JSON.parse(await readFile(CONF, "utf8"));
  const endpoint = conf.plugins?.updater?.endpoints?.[0];
  const pubkey = conf.plugins?.updater?.pubkey;
  if (!endpoint) throw setup("tauri.conf.json configures no updater endpoint, so there is nothing to check");
  if (!pubkey) {
    throw setup("tauri.conf.json configures no updater pubkey, so a release could not be verified");
  }

  const override = conf.plugins?.updater?.target;
  const key = decodePublicKey(pubkey);
  const targets = expectedTargets(await readFile(WORKFLOW, "utf8"), { override });
  const source = value("--manifest") ?? endpoint;
  const local = isLocal(source);

  console.log(`checking ${source === endpoint ? "the published release" : "a manifest given on the command line"}`);
  console.log(`  manifest:   ${source}`);
  console.log(`  key:        ${key.keyIdText} (plugins.updater.pubkey, ${key.algorithm})`);
  console.log(`  version:    ${conf.version} in this checkout`);
  if (override) {
    // Not a detail: with this set, the app looks up that key and nothing else,
    // so every other key in the manifest is dead weight.
    console.log(`  target:     plugins.updater.target makes every platform look up only ${override}`);
  }
  console.log(
    `  expecting:  ${targets.map((target) => `${target.name} ${target.arch}`).join(", ")} (.github/workflows/release.yml)`,
  );

  const manifest = await readManifest(source);
  const { problems, notes, entries, resolved } = validateManifest(manifest, {
    targets,
    // A manifest served from this machine cannot be https, and the point of
    // pointing at one is usually that it is not published yet.
    allowHttp: local,
    override,
  });

  const expected = value("--expect");
  if (expected) {
    const wanted = expected.replace(/^v/, "");
    if (manifest.version !== wanted) {
      problems.push(`the manifest carries ${manifest.version}, and --expect asked for ${wanted}`);
    }
  }

  if (isVersion(manifest.version)) {
    const direction = compareVersions(manifest.version, conf.version);
    console.log(
      `  manifest:   version ${manifest.version}${
        direction === null ? "" : direction > 0 ? `, newer than ${conf.version} — the app would take it` : `, not newer than ${conf.version} — no installed app would take it`
      }`,
    );
    if (direction !== null && direction <= 0 && manifest.version !== conf.version) {
      notes.push(`${manifest.version} is not newer than this checkout's ${conf.version}, so an app running ${conf.version} would ignore it`);
    }
  }
  if (manifest.pub_date) console.log(`              published ${manifest.pub_date}`);

  for (const note of notes) console.log(`  · ${note}`);

  if (has("--no-artifacts")) {
    report(problems, manifest, { artifacts: false });
    return;
  }

  const wanted = value("--only");
  if (wanted && !entries.some((entry) => entry.key === wanted)) {
    throw setup(`--only ${wanted} is not in the manifest; it has ${entries.map((entry) => entry.key).join(", ")}`);
  }

  // An entry with no URL or signature has already been reported as a problem;
  // there is nothing to download for it.
  const verifiable = entries.filter((entry) => entry.url && entry.signature);
  const chosen = verifiable.filter((entry) => !wanted || entry.key === wanted);
  if (chosen.length !== verifiable.length) {
    console.log(`\nskipping ${verifiable.length - chosen.length} other entr${verifiable.length - chosen.length === 1 ? "y" : "ies"} (--only)`);
  }

  const save = value("--save");
  if (save) await mkdir(save, { recursive: true });

  // The typed key and the plain one name the same artifact, so an artifact is
  // downloaded and verified once per URL and the rest of the keys ride along —
  // otherwise a real release downloads each 25 MiB bundle twice.
  const groups = new Map();
  for (const entry of chosen) {
    if (!groups.has(entry.url)) groups.set(entry.url, []);
    groups.get(entry.url).push(entry);
  }

  console.log(
    `\nverifying ${groups.size} artifact${groups.size === 1 ? "" : "s"} for ${chosen.length} of ${entries.length} entries${save ? ` (keeping them in ${save})` : ""}`,
  );
  for (const group of groups.values()) {
    try {
      problems.push(...(await verifyEntry(group, { key, version: manifest.version, save })));
    } catch (error) {
      // A download that failed is a problem with this release, not a reason to
      // stop reading the rest of it.
      console.log(`  download:   failed: ${error.message}`);
      problems.push(`${group[0].key}: ${error.message}`);
    }
  }

  // A release that covers more than the matrix asked for is fine, and worth
  // saying out loud — but the plain key of a platform that already resolved is
  // not an extra platform, it is the same one twice.
  const extra = entries.filter(
    (entry) => entry.lookup && !resolved.some((target) => target.keys.includes(entry.key)),
  );
  if (extra.length) {
    console.log(`  · also published: ${extra.map((entry) => entry.key).join(", ")}`);
  }

  report(problems, manifest, { artifacts: true });
}

/** Fetch the manifest, or read it from disk, into one shape. */
async function readManifest(source) {
  if (isLocalPath(source)) {
    const text = await readFile(source.startsWith("file:") ? fileURLToPath(source) : source, "utf8");
    return parseJson(text, source);
  }
  const response = await fetchOrExplain(source, { signal: AbortSignal.timeout(MANIFEST_TIMEOUT) });
  if (response.status === 404) {
    throw setup(
      `${source} is not there (404): nothing has been published at that endpoint yet, so there is no release to check`,
    );
  }
  if (!response.ok) throw setup(`${source} answered ${response.status} ${response.statusText}`);
  return parseJson(await response.text(), source);
}

function parseJson(text, source) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw setup(`${source} is not JSON: ${error.message}`);
  }
}

/**
 * Download one artifact, verify it, and say what was found. `group` is every
 * entry in the manifest pointing at the same URL — one artifact, usually named
 * twice, once by the installer-typed key and once by the plain fallback.
 * Returns the problems rather than throwing, so one bad entry does not hide the
 * rest.
 */
async function verifyEntry(group, { key, version, save }) {
  const [entry] = group;
  const problems = [];
  console.log(
    `\n${entry.key}${group.length > 1 ? ` (+${group.length - 1} more ${group.length === 2 ? "key" : "keys"} for the same artifact)` : ""}${entry.lookup ? "" : " (a key no app looks up)"}`,
  );

  console.log(`  url:        ${entry.url}`);
  if (entry.lookup && !entry.lookup.artifact.test(entry.name)) {
    console.log(`  artifact:   ${entry.name} is not a ${entry.lookup.name} artifact`);
  }

  let signature;
  try {
    signature = decodeSignature(entry.signature);
  } catch (error) {
    console.log(`  signature:  cannot be read at all: ${error.message}`);
    return [`${entry.key}: the signature in the manifest is not readable: ${error.message}`];
  }

  console.log(
    `  signature:  ${signature.algorithm} (${signature.prehashed ? "over the BLAKE2b-512 digest" : "over the artifact"}), key id ${formatKeyId(signature.keyId)}${signature.keyId.equals(key.keyId) ? " — the configured key" : ` — but the configured key is ${key.keyIdText}`}`,
  );

  // Two entries for one artifact have to carry the same signature, because there
  // is only one artifact to sign: a difference means one of the two is stale.
  for (const other of group.slice(1)) {
    let same = other.signature === entry.signature;
    if (!same) {
      try {
        same = sameSignature(decodeSignature(other.signature), signature);
      } catch {
        same = false;
      }
    }
    if (!same) {
      problems.push(
        `${other.key} and ${entry.key} point at the same artifact but carry different signatures, so one of them is stale`,
      );
    }
  }

  const downloaded = await download(entry.url, {
    limit: MAX_ARTIFACT_BYTES,
    timeout: ARTIFACT_TIMEOUT,
    // A prehashed signature is checked against the digest, which is all a
    // download has to produce; a legacy signature and `--save` need the bytes.
    keep: !signature.prehashed || Boolean(save),
  });

  console.log(
    `  downloaded: ${formatBytes(downloaded.size)}${downloaded.contentLength !== null && downloaded.contentLength !== downloaded.size ? ` of a claimed ${formatBytes(downloaded.contentLength)}` : ""} in ${(downloaded.ms / 1000).toFixed(1)}s`,
  );
  if (downloaded.contentLength !== null && downloaded.contentLength !== downloaded.size) {
    problems.push(`the download of ${entry.name} was cut short: ${downloaded.size} of ${downloaded.contentLength} bytes`);
  }

  const verified = verifyArtifact({
    publicKey: key,
    signature,
    digest: downloaded.digest,
    bytes: downloaded.bytes,
  });

  if (!verified.keyIdMatches) {
    problems.push(
      `${entry.key}: ${entry.name} is signed by key ${formatKeyId(signature.keyId)}, and the configured key is ${key.keyIdText}, so no installed app could accept it`,
    );
  }
  if (!verified.ok) {
    problems.push(`${entry.key}: the signature over ${entry.name} does not verify with the configured key`);
  }
  console.log(`  artifact:   ${verified.ok ? "verified ✓" : "does NOT verify ✗"}`);

  const comment = parseTrustedComment(verified.trustedComment);
  if (verified.globalOk === null) {
    problems.push(
      `${entry.key}: the signature carries no trusted comment, so nothing independently says which file and version it is for`,
    );
    console.log("  comment:    none ✗");
  } else {
    console.log(`  comment:    ${verified.globalOk ? "verified ✓" : "does NOT verify ✗"}`);
    if (!verified.globalOk) {
      problems.push(`${entry.key}: the trusted comment of ${entry.name} does not verify, so it was changed after signing`);
    } else {
      const named = comment.file ? basename(comment.file) : null;
      if (named && named !== entry.name) {
        problems.push(
          `${entry.key}: the signature names ${comment.file} and the manifest points at ${entry.name}`,
        );
      } else if (named) {
        console.log(`              for ${named}${comment.timestamp ? `, signed ${new Date(comment.timestamp * 1000).toISOString()}` : ""}`);
      }
      // Only the bundler writes the version into the comment; `tauri signer
      // sign` writes the name alone. When it is there it has to be this one, and
      // it is compared the way the plugin compares it with what the endpoint
      // announced — as semver, so a `v` prefix is not a difference.
      if (comment.version && version && !versionsMatch(comment.version, version)) {
        problems.push(
          `${entry.key}: the signature was made for version ${comment.version}, and the manifest says ${version}`,
        );
      } else if (comment.version) {
        console.log(`              version ${comment.version} agrees`);
      }
    }
  }

  problems.push(...(await compareSignatureAsset(entry, signature)));

  if (save && downloaded.bytes) {
    const kept = path.join(save, entry.name);
    await writeFile(kept, downloaded.bytes);
    // Keeping a bad artifact is deliberate: it is what a failed run is then
    // read from. Saying which it is is what makes that safe.
    console.log(`  kept:       ${kept}${verified.ok ? " (verified)" : " (does NOT verify)"}`);
  }

  return problems;
}

/**
 * The `.sig` asset next to the artifact, if the release has one. The updater
 * reads the signature out of the manifest and never fetches this file, so its
 * absence is not an update problem — but a release whose two copies of the same
 * signature disagree has one copy that is wrong, and that is.
 */
async function compareSignatureAsset(entry, signature) {
  const url = `${entry.url}.sig`;
  let response;
  try {
    response = await fetchOrExplain(url, { signal: AbortSignal.timeout(MANIFEST_TIMEOUT) });
  } catch (error) {
    return [`${entry.key}: ${url} could not be fetched to compare: ${error.message}`];
  }
  if (response.status === 404) {
    console.log(`  .sig asset: none published (the updater does not need it)`);
    return [];
  }
  if (!response.ok) return [`${entry.key}: ${url} answered ${response.status} ${response.statusText}`];

  const text = (await response.text()).slice(0, MAX_SIG_BYTES);
  if (text.trim() === signature.text) {
    console.log("  .sig asset: matches the manifest ✓");
    return [];
  }
  // Different base64 wrapping is not a different signature; compare the parts.
  try {
    if (sameSignature(decodeSignature(text), signature)) {
      console.log("  .sig asset: matches the manifest ✓ (wrapped differently)");
      return [];
    }
  } catch (error) {
    return [`${entry.key}: ${url} is not a readable signature: ${error.message}`];
  }
  return [
    `${entry.key}: ${url} and the signature in the manifest are different signatures for ${entry.name}`,
  ];
}

/**
 * Stream a URL, hashing as it goes, so a 25 MiB bundle is never held twice and a
 * 5 GiB one is refused instead of downloaded. `keep` is what a legacy signature
 * needs: the bytes, not just the digest.
 */
async function download(url, { limit, timeout, keep }) {
  if (!/^https?:\/\//.test(url)) {
    // The updater parses the URL it is given; a relative one would be resolved
    // against nothing and fail there, so it fails here first.
    throw new Error(`${url} is not an absolute http(s) URL, so the updater could not fetch it`);
  }

  const started = Date.now();
  const response = await fetchOrExplain(url, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`${url} answered ${response.status} ${response.statusText}`);

  const claimed = Number(response.headers.get("content-length"));
  const contentLength = Number.isFinite(claimed) && claimed > 0 ? claimed : null;
  if (contentLength !== null && contentLength > limit) {
    throw new Error(`${url} claims ${formatBytes(contentLength)}, over the ${formatBytes(limit)} limit`);
  }

  const hash = artifactDigest();
  const chunks = keep ? [] : null;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    hash.update(bytes);
    if (chunks) chunks.push(bytes);
    if (hash.size > limit) throw new Error(`${url} is over the ${formatBytes(limit)} limit`);
  }

  return {
    size: hash.size,
    contentLength,
    digest: hash.digest(),
    bytes: chunks ? Buffer.concat(chunks) : null,
    ms: Date.now() - started,
  };
}

/**
 * `fetch`'s own failures say "fetch failed" and leave the reason in `cause`,
 * which is the difference between a DNS name that does not resolve and a
 * connection that timed out — the two things a release check is read to tell
 * apart.
 */
async function fetchOrExplain(url, options) {
  try {
    return await fetch(url, { redirect: "follow", ...options });
  } catch (error) {
    const why = error.cause?.code ?? error.cause?.message ?? error.name;
    throw new Error(`${url} could not be fetched (${why ?? error.message})`);
  }
}

function report(problems, manifest, { artifacts }) {
  if (!problems.length) {
    console.log(
      `\n✓ the release would update every platform it was built for (${manifest.version})${artifacts ? ", and every artifact verified" : " — the artifacts were not checked (--no-artifacts)"}`,
    );
    return;
  }
  console.error(`\n✗ ${problems.length} problem${problems.length === 1 ? "" : "s"} in the release:`);
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exitCode = 1;
}

function usage() {
  console.log(`Check a published release against this app's updater configuration.

  node scripts/check-release.mjs [options]

  --manifest <url|path>  check this manifest instead of the configured endpoint
  --expect <version>     require the manifest to carry this version (v0.2.0)
  --only <key>           verify one platform entry, e.g. darwin-aarch64
  --no-artifacts         check the manifest without downloading anything
  --save <dir>           keep each downloaded artifact in this directory
  --help                 this text

Exits 0 when the release verified, 1 when the release is wrong, 2 when the check
could not be run at all.`);
}

/** A source on this machine: a path, a file:// URL, or a loopback address. */
function isLocal(source) {
  return isLocalPath(source) || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//.test(source);
}

function isLocalPath(source) {
  return source.startsWith("file:") || (!/^[a-z][a-z0-9+.-]*:\/\//i.test(source) && !source.startsWith("//"));
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function setup(message) {
  const error = new Error(message);
  error.setup = true;
  return error;
}
