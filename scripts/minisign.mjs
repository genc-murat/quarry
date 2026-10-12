/**
 * Just enough of minisign's file format to answer the question a release check
 * asks — is this the artifact that key signed — plus the one field in it that a
 * signature alone does not give you.
 *
 * The format, as `tauri signer` writes it: a public key is the text
 *
 *     untrusted comment: minisign public key: <key id, hex>
 *     <base64 of: 2-byte algorithm | 8-byte key id | 32-byte Ed25519 key>
 *
 * and a signature is the text
 *
 *     untrusted comment: signature from tauri secret key
 *     <base64 of: 2-byte algorithm | 8-byte key id | 64-byte Ed25519 signature>
 *     trusted comment: timestamp:…	file:…	version:…?
 *     <base64 of the same structure, holding the signature over both lines above>
 *
 * and both are stored base64-encoded again as one look — which is what
 * `tauri.conf.json` holds for the key and what the `.sig` files hold for a
 * signature. So decoding one of these is base64, then lines, then base64.
 *
 * Two details are not guessable from the text and were read off real output:
 *
 * - The signature's algorithm field decides what the Ed25519 signature covers.
 *   `tauri signer sign` and the bundler both write `ED`, and that signature
 *   covers the **BLAKE2b-512 digest** of the artifact, not the artifact.
 *   minisign's older spelling `Ed` covers the file itself; that mode is accepted
 *   here too, because a signature made by hand with minisign's CLI would use it.
 *   (Checked against a real 25 MiB bundle: with `ED`, the digest verifies and
 *   the payload does not.) The public key's own algorithm field is `Ed` in both
 *   cases — it names the scheme, not the mode — so the two are never compared.
 * - The trusted comment is covered by the second Ed25519 signature, whose
 *   message is the 64-byte signature above **followed by** that comment — read
 *   off real output the same way, since the trailing line is the bare signature
 *   and nothing in the text says what it was made over. That is what makes
 *   `file:` and `version:` in the comment *worth comparing* to what the manifest
 *   says: the same key vouched for them. The bundler writes the version it
 *   built; a bare `tauri signer sign` writes only the name.
 *
 * The key id is checked before the signature, because a signature from another
 * key is the mistake this whole check exists to catch, and reporting "signed by
 * a different key" is more useful than reporting "the signature is wrong".
 *
 * Nothing here knows about HTTP, manifests or this app; see
 * `releaseManifest.mjs` for the manifest rules and `check-release.mjs` for the
 * script that downloads the two and puts them together.
 * See `minisign.test.mjs` for these being checked against real signatures.
 */
import { createHash, createPublicKey, verify as verifyEd25519 } from "node:crypto";

/** What `tauri signer` writes: the signature covers the payload's BLAKE2b-512 digest. */
const PREHASHED = "ED";
/** minisign's older mode, still accepted: the signature covers the payload itself. */
const LEGACY = "Ed";

const KEY_ID_BYTES = 8;
const KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const KEY_BLOB_BYTES = 2 + KEY_ID_BYTES + KEY_BYTES;
const SIGNATURE_BLOB_BYTES = 2 + KEY_ID_BYTES + SIGNATURE_BYTES;
/** The trailing line is the bare signature, with no algorithm or key id in front. */
const COMMENT_SIGNATURE_BYTES = SIGNATURE_BYTES;
const UNTRUSTED = "untrusted comment:";
const TRUSTED = "trusted comment:";

/**
 * A minisign file is the text above, base64-encoded as a whole. `what` only
 * names the thing in the error, so a bad key and a bad signature read
 * differently.
 */
function minisignLines(value, what) {
  let text;
  try {
    text = Buffer.from(String(value).trim(), "base64").toString("utf8");
  } catch {
    throw new Error(`${what} is not readable as base64`);
  }
  const lines = text.split("\n").map((line) => line.trim());
  while (lines.length && !lines.at(-1)) lines.pop();
  if (lines.length < 2 || !lines[0].startsWith(UNTRUSTED)) {
    throw new Error(`${what} is not in minisign's format`);
  }
  if (lines.length !== 2 && !lines[2].startsWith(TRUSTED)) {
    throw new Error(`${what} has a third line that is not a trusted comment`);
  }
  return lines;
}

/** The blob each of the two line kinds carries, refusing anything the wrong size. */
function blob(line, bytes, what) {
  const raw = Buffer.from(line, "base64");
  if (raw.length !== bytes) {
    throw new Error(`${what} is ${raw.length} bytes, expected ${bytes}`);
  }
  return raw;
}

/**
 * The configured public key, as `plugins.updater.pubkey` holds it. Any key that
 * is not an Ed25519 minisign key is refused rather than half-understood.
 */
export function decodePublicKey(value) {
  const lines = minisignLines(value, "the updater public key");
  const raw = blob(lines[1], KEY_BLOB_BYTES, "the updater public key");
  const algorithm = raw.toString("latin1", 0, 2);
  if (algorithm !== LEGACY) {
    throw new Error(`the updater public key uses ${JSON.stringify(algorithm)}, not Ed25519`);
  }

  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.subarray(10).toString("base64url") },
    format: "jwk",
  });
  const keyId = Buffer.from(raw.subarray(2, 10));
  return {
    algorithm,
    keyId,
    keyIdText: formatKeyId(keyId),
    key,
    /** The literal the config file carries, so a report can point at it. */
    text: String(value).trim(),
  };
}

/**
 * The 8-byte key id as minisign prints it — in the public key's own comment, in
 * `minisign.pub`, and in its console output — so that a report can be held
 * against the configured key by eye.
 *
 * The number is stored little-endian and printed as a number, which is why this
 * is the bytes reversed. What the app compares is the bytes, and so does
 * `verifyArtifact`; this is only how they are shown, and getting it wrong once
 * meant printing `1965786EF996D35A` for the key whose own comment says
 * `5AD396F96E786519`.
 */
export function formatKeyId(keyId) {
  return Buffer.from(keyId).reverse().toString("hex").toUpperCase();
}

/**
 * A `.sig` file's contents. `prehashed` is the one thing a caller has to know
 * before downloading: a prehashed signature is checked against the digest, which
 * streams, and a legacy one against the whole artifact, which has to be held.
 */
export function decodeSignature(value) {
  const lines = minisignLines(value, "the artifact signature");
  const raw = blob(lines[1], SIGNATURE_BLOB_BYTES, "the artifact signature");
  const algorithm = raw.toString("latin1", 0, 2);
  if (algorithm !== PREHASHED && algorithm !== LEGACY) {
    throw new Error(`the artifact signature uses ${JSON.stringify(algorithm)}, not Ed25519`);
  }

  return {
    algorithm,
    prehashed: algorithm === PREHASHED,
    keyId: raw.subarray(2, 10),
    signature: raw.subarray(10),
    comment: lines[0].slice(UNTRUSTED.length).trim(),
    /**
     * The comment whose fields the second signature vouches for. minisign can
     * represent a signature without one; the bundler never writes one like that,
     * and the release check treats a missing comment as a problem rather than
     * skipping the comparison — here it only reads as empty.
     */
    trustedComment: lines.length === 2 ? "" : lines[2].slice(TRUSTED.length).trim(),
    globalSignature:
      lines.length < 4 ? null : blob(lines[3], COMMENT_SIGNATURE_BYTES, "the comment signature"),
    text: String(value).trim(),
  };
}

/** The digest a prehashed signature is made over: BLAKE2b-512, as minisign's own. */
export function digestOf(bytes) {
  return createHash("blake2b512").update(bytes).digest();
}

/**
 * A running BLAKE2b-512 over something too big to hold: the check feeds this the
 * chunks it downloads and asks for the digest at the end, so a 25 MiB bundle
 * costs nothing to verify. `size` comes along because it is the other number a
 * report wants.
 */
export function artifactDigest() {
  const hash = createHash("blake2b512");
  let size = 0;
  return {
    update(chunk) {
      hash.update(chunk);
      size += chunk.length;
      return this;
    },
    get size() {
      return size;
    },
    digest() {
      return hash.digest();
    },
  };
}

/**
 * Verify a signature over an artifact. A prehashed signature (`tauri signer`)
 * takes `digest`; a legacy one takes `bytes`, because that is what it covers.
 *
 * Returns what a caller needs to report rather than throwing, since "the
 * signature is wrong" is the expected outcome of a tampered release: which key
 * signed it, whether the artifact verified, and whether the trusted comment did.
 */
export function verifyArtifact({ publicKey, signature, digest, bytes }) {
  const message = signature.prehashed ? digest : bytes;
  if (!message) {
    throw new Error(
      signature.prehashed
        ? "a prehashed signature needs the artifact's BLAKE2b-512 digest"
        : "a legacy signature needs the artifact's bytes",
    );
  }

  const keyIdMatches = signature.keyId.equals(publicKey.keyId);
  return {
    algorithm: signature.algorithm,
    keyIdMatches,
    /** The artifact itself. */
    ok: keyIdMatches && verifyOrFalse(message, publicKey.key, signature.signature),
    /**
     * The trusted comment. `null` when the signature carries none. A false here
     * means the comment was changed after signing, so `file:` and `version:`
     * from that comment must not be believed.
     */
    globalOk: signature.globalSignature
      ? keyIdMatches &&
        verifyOrFalse(
          Buffer.concat([signature.signature, Buffer.from(signature.trustedComment, "utf8")]),
          publicKey.key,
          signature.globalSignature,
        )
      : null,
    trustedComment: signature.trustedComment,
    comment: signature.comment,
  };
}

/**
 * Whether two decoded signatures are the same signature, so a difference in
 * base64 wrapping is not read as a difference in what was signed. A manifest
 * and the `.sig` asset next to an artifact are two copies of one signature, and
 * a release check compares them.
 */
export function sameSignature(one, other) {
  return (
    one.algorithm === other.algorithm &&
    one.signature.equals(other.signature) &&
    one.trustedComment === other.trustedComment
  );
}

/**
 * What the trusted comment says, when it says it: the bundler writes
 * `timestamp:…\tfile:…\tversion:…`, `tauri signer sign` writes the first two.
 * Unknown fields are ignored rather than refused, since this is metadata on its
 * way to being compared, not a schema.
 */
export function parseTrustedComment(text) {
  const fields = {};
  for (const part of String(text).split("\t")) {
    const at = part.indexOf(":");
    if (at > 0) fields[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return {
    timestamp: /^\d+$/.test(fields.timestamp ?? "") ? Number(fields.timestamp) : null,
    file: fields.file || null,
    version: fields.version || null,
  };
}

function verifyOrFalse(message, key, signature) {
  try {
    return verifyEd25519(null, message, key, signature);
  } catch {
    // A signature of the wrong size or shape is a failed verification, not a
    // crash: the caller is about to print why.
    return false;
  }
}
