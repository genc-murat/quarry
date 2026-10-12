/**
 * The app version is written down in three places, and a release only works when
 * they agree: `tauri.conf.json` names the bundles and is what the updater
 * compares against, `package.json` is the npm version, and `Cargo.toml` is the
 * crate's. The release workflow additionally requires the tag to be the same
 * version, because the tag names the assets the updater fetches.
 *
 *   node scripts/check-version.mjs            # the three sources agree
 *   node scripts/check-version.mjs v0.2.0     # ... and match the release tag
 *
 * Exits non-zero with a list of the versions found, so a mismatch says which
 * file to fix rather than just failing.
 */
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url);

const SOURCES = {
  "package.json": (text) => JSON.parse(text).version,
  "src-tauri/Cargo.toml": (text) => text.match(/^version\s*=\s*"([^"]+)"/m)?.[1],
  "src-tauri/tauri.conf.json": (text) => JSON.parse(text).version,
};

const found = [];
for (const [path, read] of Object.entries(SOURCES)) {
  const value = read(readFileSync(new URL(path, ROOT), "utf8"));
  if (!value) {
    console.error(`${path} does not declare a version`);
    process.exit(1);
  }
  found.push([path, value]);
}

const tag = (process.argv[2] ?? "").replace(/^v/, "");
const versions = new Set(found.map(([, value]) => value));

if (versions.size > 1 || (tag && !versions.has(tag))) {
  console.error("the app version is not consistent:");
  for (const [path, value] of found) console.error(`  ${path}: ${value}`);
  if (tag) console.error(`  tag: ${tag}`);
  process.exit(1);
}

console.log(`app version ${[...versions][0]} is consistent${tag ? ` with tag v${tag}` : ""}`);
