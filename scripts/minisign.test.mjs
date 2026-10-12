import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  artifactDigest,
  decodePublicKey,
  decodeSignature,
  digestOf,
  parseTrustedComment,
  sameSignature,
  verifyArtifact,
} from "./minisign.mjs";

/**
 * These tests are pinned to output produced by the real tools, because the
 * format is the part that cannot be reasoned about from the documentation:
 * whether `tauri signer` signs the artifact or its digest, and what the second
 * signature covers.
 *
 * The fixture — a real `tauri signer` key pair and signature over a 26-byte
 * payload, from two throwaway keys, so the project's own signing key is not
 * involved — lives in `src/lib/fixtures/update-signature.json`, which
 * `src-tauri/src/update_signature.rs` reads too. There it is verified by the
 * verifier the app itself calls (`minisign-verify` through
 * `tauri-plugin-updater`), and both halves assert the same outcome on the same
 * bytes: this file's verdict and the app's have to agree, or one of them is
 * wrong about what an update is allowed to install.
 *
 * What they lock down is the thing that would otherwise be found by shipping a
 * release nobody can install: a signature verified over the wrong message.
 */

const FIXTURE = JSON.parse(
  readFileSync(new URL("../src/lib/fixtures/update-signature.json", import.meta.url), "utf8"),
);

const PAYLOAD = Buffer.from(FIXTURE.payload, "utf8");
/** The key the fixture was signed with, and a second one over the same payload. */
const [SIGNED, FOREIGN] = FIXTURE.keys;

test("a signature from `tauri signer` verifies over the artifact's digest", () => {
  const key = decodePublicKey(SIGNED.publicKey);
  const signature = decodeSignature(SIGNED.signature);

  assert.equal(signature.algorithm, "ED");
  assert.equal(signature.prehashed, true, "tauri's signer prehashes; this is what the digest check depends on");
  assert.ok(signature.keyId.equals(key.keyId), "the signature's key id is the configured key's");
  assert.equal(key.keyIdText, SIGNED.keyId, "and it is the id the fixture pins");

  const verified = verifyArtifact({ publicKey: key, signature, digest: digestOf(PAYLOAD), bytes: PAYLOAD });
  assert.equal(verified.ok, true);
  assert.equal(verified.keyIdMatches, true);
  assert.equal(verified.globalOk, true, "the trusted comment is covered by the second signature");
  assert.equal(verified.trustedComment, SIGNED.trustedComment);
  assert.equal(verified.comment, "signature from tauri secret key");
});

test("the same signature does not verify over the artifact itself", () => {
  const key = decodePublicKey(SIGNED.publicKey);
  const signature = decodeSignature(SIGNED.signature);

  // What a legacy ("Ed") signature would have to be checked against. Reading a
  // prehashed signature this way is exactly the mistake the algorithm field
  // prevents, so it has to fail.
  const asLegacy = { ...signature, prehashed: false, algorithm: "Ed" };
  assert.equal(verifyArtifact({ publicKey: key, signature: asLegacy, bytes: PAYLOAD }).ok, false);
  assert.equal(verifyArtifact({ publicKey: key, signature, digest: digestOf(Buffer.from("something else")) }).ok, false);
});

test("one changed byte anywhere in the artifact is caught", () => {
  const key = decodePublicKey(SIGNED.publicKey);
  const signature = decodeSignature(SIGNED.signature);
  const tampered = Buffer.from(PAYLOAD);
  // The same byte the Rust half flips, so both are asked about the same payload.
  tampered[tampered.length - 2] = 0x21; // "v1\n" → "v!\n"

  assert.equal(verifyArtifact({ publicKey: key, signature, digest: digestOf(tampered) }).ok, false);
});

test("a signature from another key is refused, and names the key it is from", () => {
  const key = decodePublicKey(SIGNED.publicKey);
  const foreign = decodeSignature(FOREIGN.signature);
  const foreignKey = decodePublicKey(FOREIGN.publicKey);

  assert.equal(foreignKey.keyIdText, FOREIGN.keyId);
  assert.notEqual(foreignKey.keyIdText, key.keyIdText, "the two throwaway keys are not the same key");
  assert.equal(foreignKey.keyId.equals(key.keyId), false);

  const verified = verifyArtifact({ publicKey: key, signature: foreign, digest: digestOf(PAYLOAD) });
  assert.equal(verified.keyIdMatches, false);
  assert.equal(verified.ok, false);

  // ... and it does verify against its own key, so the fixture is a real signature.
  assert.equal(verifyArtifact({ publicKey: foreignKey, signature: foreign, digest: digestOf(PAYLOAD) }).ok, true);
});

test("editing the trusted comment is caught, even though the artifact still verifies", () => {
  const key = decodePublicKey(SIGNED.publicKey);
  const signature = decodeSignature(SIGNED.signature);
  const edited = { ...signature, trustedComment: "timestamp:1791764629\tfile:something-else.app.tar.gz" };

  const verified = verifyArtifact({ publicKey: key, signature: edited, digest: digestOf(PAYLOAD) });
  assert.equal(verified.ok, true, "the artifact's own signature is untouched");
  assert.equal(verified.globalOk, false, "the comment is what the second signature protects");
});

test("the trusted comment's fields are read as the tools write them", () => {
  // `tauri signer sign` writes the timestamp and the file name, and no version.
  assert.deepEqual(parseTrustedComment(SIGNED.trustedComment), {
    timestamp: 1791764629,
    file: "with-fixture-key.bin",
    version: null,
  });

  // The bundler adds the version it built, read off a bundle it signed. This is
  // the field a release check compares against the manifest, and the field
  // `tauri-plugin-updater` compares against the version the endpoint announced.
  assert.deepEqual(parseTrustedComment(FIXTURE.bundlerComment), {
    timestamp: 1791764122,
    file: "Quarry.app.tar.gz",
    version: "0.1.0",
  });

  // Anything else in there is ignored rather than refused.
  assert.equal(parseTrustedComment("something:else").timestamp, null);
  assert.equal(parseTrustedComment("").file, null);
});

test("a hash of a stream is the hash of its bytes", () => {
  const whole = digestOf(PAYLOAD);
  const streamed = artifactDigest();
  for (const chunk of [PAYLOAD.subarray(0, 7), PAYLOAD.subarray(7, 20), PAYLOAD.subarray(20)]) streamed.update(chunk);

  assert.equal(streamed.size, PAYLOAD.length);
  assert.ok(streamed.digest().equals(whole), "the digest a download produces is the digest a signature was made over");
});

test("anything that is not a minisign file is refused with a reason", () => {
  assert.throws(() => decodePublicKey("bm90IGEga2V5"), /not in minisign's format/);
  assert.throws(() => decodeSignature("bm90IGEgc2lnbmF0dXJlCg=="), /not in minisign's format/);
  assert.throws(() => decodePublicKey(""), /not in minisign's format/);

  // A blob of the right shape but the wrong length would otherwise be read as
  // uninitialised bytes and "verified" against nothing.
  const short = Buffer.concat([Buffer.from("Ed"), Buffer.alloc(8), Buffer.alloc(31)]).toString("base64");
  const text = `untrusted comment: minisign public key: 00\n${short}\n`;
  assert.throws(() => decodePublicKey(Buffer.from(text).toString("base64")), /expected 42/);
});

test("two copies of one signature compare equal however they are wrapped", () => {
  const signature = decodeSignature(SIGNED.signature);
  // The same text, re-encoded with the lines joined instead of kept — which is
  // what a manifest and the `.sig` asset next to it may look like.
  const rewrapped = Buffer.from(
    Buffer.from(SIGNED.signature, "base64").toString("utf8").replace(/\n/g, "\r\n"),
    "utf8",
  ).toString("base64");

  assert.equal(rewrapped === SIGNED.signature, false, "the two are different strings");
  assert.equal(sameSignature(decodeSignature(rewrapped), signature), true);
  assert.equal(
    sameSignature(decodeSignature(FOREIGN.signature), signature),
    false,
    "a different signature does not compare equal",
  );
});

test("a signature that needs an artifact it was not given says so", () => {
  const key = decodePublicKey(SIGNED.publicKey);
  const signature = decodeSignature(SIGNED.signature);

  assert.throws(
    () => verifyArtifact({ publicKey: key, signature, bytes: PAYLOAD }),
    /needs the artifact's BLAKE2b-512 digest/,
  );
  assert.throws(
    () => verifyArtifact({ publicKey: key, signature: { ...signature, prehashed: false }, digest: digestOf(PAYLOAD) }),
    /needs the artifact's bytes/,
  );
});

test("the fixture keeps both keys and both signatures", () => {
  // The Rust half reads the same fields; a fixture that loses one of them should
  // fail here rather than half-run there.
  assert.equal(FIXTURE.keys.length, 2);
  for (const entry of FIXTURE.keys) {
    assert.ok(entry.publicKey && entry.signature && entry.trustedComment && entry.keyId, JSON.stringify(entry));
  }
  assert.match(FIXTURE.payload, /\n$/, "the payload the digests are made over ends in a newline");
});
