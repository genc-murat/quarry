//! The app's own verdict on the fixture the release check verifies.
//!
//! `scripts/minisign.mjs` is a second implementation of something this binary
//! already contains: `tauri-plugin-updater` base64-decodes the configured public
//! key and a manifest's signature, hands both to `minisign-verify`, and only
//! then reads the trusted comment. A second implementation is worth having only
//! if it agrees with the first, and the parts of it that could silently disagree
//! are exactly the parts that were read off real output over there: that a
//! signature's `ED` algorithm means the Ed25519 signature covers the artifact's
//! BLAKE2b-512 digest rather than the artifact, and that the trailing signature
//! covers the trusted comment.
//!
//! So the fixture the check is pinned to — a real `tauri signer` key pair and
//! signature over a 26-byte payload, in
//! `src/lib/fixtures/update-signature.json`, which `scripts/minisign.test.mjs`
//! reads as well — is verified *here* by the verifier the app itself calls, and
//! both halves assert the same outcome on the same bytes. That is what makes the
//! check's verdict worth trusting: it accepts what the app accepts, and refuses
//! what the app refuses.
//!
//! This module is compiled for tests only; the app never verifies a signature
//! itself, it asks the plugin to.

use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{Error, PublicKey, Signature};
use serde_json::Value;

/// One entry of the fixture: the key as `tauri.conf.json` stores it, the
/// signature as a `.sig` file holds it, and the two facts about them both halves
/// assert on.
struct FixtureKey {
    public_key: String,
    key_id: String,
    signature: String,
    trusted_comment: String,
}

/// The fixture both ends read, in the same directory as the driver descriptor
/// snapshot — the place this project keeps what the two languages agree on.
fn fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/fixtures/update-signature.json")
}

fn fixture() -> Value {
    let path = fixture_path();
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
    serde_json::from_str(&text).expect("the update signature fixture is valid JSON")
}

fn payload(fixture: &Value) -> Vec<u8> {
    fixture["payload"]
        .as_str()
        .expect("the fixture has a payload")
        .as_bytes()
        .to_vec()
}

fn key(fixture: &Value, index: usize) -> FixtureKey {
    let entry = &fixture["keys"][index];
    FixtureKey {
        public_key: entry["publicKey"]
            .as_str()
            .expect("the fixture key is base64")
            .to_string(),
        key_id: entry["keyId"]
            .as_str()
            .expect("the key id is pinned")
            .to_string(),
        signature: entry["signature"]
            .as_str()
            .expect("the fixture signature is base64")
            .to_string(),
        trusted_comment: entry["trustedComment"]
            .as_str()
            .expect("the fixture trusted comment is pinned")
            .to_string(),
    }
}

/// The plugin's own steps in its own order: decode the key, decode the
/// signature, verify the artifact's bytes, and only then read the trusted
/// comment — which is only worth reading once the signature that covers it has
/// been checked.
///
/// `minisign-verify` is a dependency of `tauri-plugin-updater`, so the lock file
/// resolves one version of it for both — what runs here is the code that runs in
/// the app.
fn app_verify(key: &str, signature: &str, data: &[u8]) -> Result<String, Error> {
    let public_key = PublicKey::decode(&decoded(key))?;
    let signature = Signature::decode(&decoded(signature))?;
    // Exactly the plugin's call, `allow_legacy` included.
    public_key.verify(data, &signature, true)?;
    Ok(signature.trusted_comment().to_string())
}

/// What `tauri-plugin-updater` does to the two base64 values before the verifier
/// sees them: decode to text.
fn decoded(value: &str) -> String {
    let bytes = STANDARD
        .decode(value.trim())
        .expect("the fixture holds base64");
    String::from_utf8(bytes).expect("...and it decodes to the minisign text")
}

/// The plugin's own `signed_version`, which is three lines of field splitting in
/// the middle of a large function: the `version:` field of a tab separated
/// trusted comment, if the signature was made by a tool that wrote one.
fn signed_version(trusted_comment: &str) -> Option<&str> {
    trusted_comment
        .split('\t')
        .find_map(|field| field.strip_prefix("version:"))
}

#[test]
fn the_release_check_fixture_verifies_with_the_apps_verifier() {
    let fixture = fixture();
    let signed = key(&fixture, 0);

    let comment = app_verify(&signed.public_key, &signed.signature, &payload(&fixture))
        .expect("the app accepts the release check's fixture");
    assert_eq!(comment, signed.trusted_comment);

    // And the signature is prehashed: refusing legacy mode changes nothing,
    // which is the claim `scripts/minisign.mjs` is built on — that the Ed25519
    // signature covers the payload's BLAKE2b-512 digest and not the payload.
    // Reading it the other way round fails, so this is not a coincidence of the
    // fixture being small.
    let public_key = PublicKey::decode(&decoded(&signed.public_key)).expect("the key decodes");
    let signature = Signature::decode(&decoded(&signed.signature)).expect("the signature decodes");
    let data = payload(&fixture);
    assert!(public_key.verify(&data, &signature, false).is_ok());
}

#[test]
fn a_signature_from_another_key_is_refused_because_the_key_id_differs() {
    let fixture = fixture();
    let signed = key(&fixture, 0);
    let foreign = key(&fixture, 1);

    assert!(matches!(
        app_verify(&signed.public_key, &foreign.signature, &payload(&fixture)),
        Err(Error::UnexpectedKeyId)
    ));

    // ... while it does verify against the key that made it, so the second entry
    // is a real signature and not a broken fixture.
    assert_eq!(
        app_verify(&foreign.public_key, &foreign.signature, &payload(&fixture))
            .expect("the second key accepts its own signature"),
        foreign.trusted_comment
    );
}

#[test]
fn one_changed_byte_in_the_payload_is_refused() {
    let fixture = fixture();
    let signed = key(&fixture, 0);

    let mut tampered = payload(&fixture);
    let last = tampered.len() - 2; // "v1\n" becomes "v!\n"
    tampered[last] = b'!';
    assert!(matches!(
        app_verify(&signed.public_key, &signed.signature, &tampered),
        Err(Error::InvalidSignature)
    ));
}

#[test]
fn the_key_the_fixture_was_signed_with_is_the_one_it_pins() {
    let fixture = fixture();
    let signed = key(&fixture, 0);

    // The key id is what the JS half compares before anything else, and the
    // verifier refuses a mismatch on. minisign prints it in the key's own
    // comment, so this checks the pinned value against the key itself rather
    // than against another copy of the same string.
    let public_key = PublicKey::decode(&decoded(&signed.public_key)).expect("the key decodes");
    let comment = public_key
        .untrusted_comment()
        .expect("a minisign public key carries a comment");
    assert!(comment.contains(&signed.key_id), "{comment}");
}

#[test]
fn the_version_a_signature_was_made_for_is_read_the_way_the_plugin_reads_it() {
    let fixture = fixture();

    assert_eq!(
        signed_version(&key(&fixture, 0).trusted_comment),
        None,
        "a bare `tauri signer sign` writes the name and no version"
    );
    assert_eq!(
        signed_version(
            fixture["bundlerComment"]
                .as_str()
                .expect("the fixture pins a bundler comment")
        ),
        Some("0.1.0"),
        "the bundler writes the version it built"
    );
}
