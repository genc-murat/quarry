//! Password storage backed by an encrypted, app-local vault.
//!
//! Quarry deliberately does **not** use the OS keyring (macOS Keychain, Windows
//! Credential Manager, Secret Service). Reading a keychain item raises an
//! authorization prompt on macOS, and because ad-hoc signed development builds
//! get a fresh signature on every rebuild the prompt comes back each time. For
//! a local database tool that is a lot of friction, so passwords live in a
//! small AES-256-GCM encrypted vault inside the app config directory instead:
//!
//! * `secrets.key`  — 32 random bytes generated on first run (`0600` on Unix).
//! * `secrets.json` — map of `profile id -> base64(nonce || ciphertext)`.
//!
//! Threat model, stated plainly: this protects against *casual* disclosure — a
//! config directory that gets backed up, synced or shared, a stray `grep`, or
//! another app reading the file. It does **not** protect against an attacker who
//! can already read files as this user, because the key sits next to the vault.
//! That is the accepted trade-off for a prompt-free experience; a master
//! password would be the way to raise the bar.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;

use crate::error::{DriverError, Result};

const KEY_FILE: &str = "secrets.key";
const VAULT_FILE: &str = "secrets.json";
const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;

pub struct SecretStore {
    vault_path: PathBuf,
    key: [u8; KEY_LEN],
    entries: RwLock<HashMap<String, String>>,
}

impl SecretStore {
    /// Load (and decrypt) the vault, generating a key on first run. A missing or
    /// corrupted vault simply yields an empty store.
    pub fn load(dir: &Path) -> Self {
        let key = load_or_create_key(&dir.join(KEY_FILE));
        let vault_path = dir.join(VAULT_FILE);

        let stored: HashMap<String, String> = match fs::read_to_string(&vault_path) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
            Err(_) => HashMap::new(),
        };

        let entries = stored
            .into_iter()
            .filter_map(|(id, blob)| decrypt(&key, &blob).map(|password| (id, password)))
            .collect();

        Self {
            vault_path,
            key,
            entries: RwLock::new(entries),
        }
    }

    /// Fetch the stored password, if any.
    pub fn get_password(&self, profile_id: &str) -> Option<String> {
        self.entries.read().unwrap().get(profile_id).cloned()
    }

    /// Whether a password is stored for the profile.
    pub fn has_password(&self, profile_id: &str) -> bool {
        self.entries.read().unwrap().contains_key(profile_id)
    }

    /// Store (or, with `None`/an empty string, clear) the password.
    pub fn set_password(&self, profile_id: &str, password: Option<&str>) -> Result<()> {
        {
            let mut entries = self.entries.write().unwrap();
            match password {
                Some(pw) if !pw.is_empty() => {
                    entries.insert(profile_id.to_string(), pw.to_string());
                }
                _ => {
                    entries.remove(profile_id);
                }
            }
        }
        self.persist()
    }

    /// Delete the stored password for a profile.
    pub fn delete_password(&self, profile_id: &str) {
        let removed = self.entries.write().unwrap().remove(profile_id).is_some();
        if removed {
            let _ = self.persist();
        }
    }

    fn persist(&self) -> Result<()> {
        let encrypted: HashMap<String, String> = {
            let entries = self.entries.read().unwrap();
            let mut out = HashMap::with_capacity(entries.len());
            for (id, password) in entries.iter() {
                out.insert(id.clone(), encrypt(&self.key, password)?);
            }
            out
        };

        if let Some(parent) = self.vault_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| DriverError::Config(format!("could not create config dir: {e}")))?;
        }

        let serialized = serde_json::to_string_pretty(&encrypted)
            .map_err(|e| DriverError::Config(format!("could not serialize vault: {e}")))?;
        // Same crash-safe write as the profile store: temp file then rename.
        let tmp = self.vault_path.with_extension("tmp");
        fs::write(&tmp, serialized)
            .map_err(|e| DriverError::Config(format!("could not write vault: {e}")))?;
        fs::rename(&tmp, &self.vault_path)
            .map_err(|e| DriverError::Config(format!("could not persist vault: {e}")))?;
        restrict_permissions(&self.vault_path);
        Ok(())
    }
}

fn encrypt(key: &[u8; KEY_LEN], plaintext: &str) -> Result<String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext.as_bytes())
        .map_err(|_| DriverError::Config("could not encrypt password".into()))?;

    let mut blob = nonce.to_vec();
    blob.extend_from_slice(&ciphertext);
    Ok(BASE64.encode(blob))
}

fn decrypt(key: &[u8; KEY_LEN], blob: &str) -> Option<String> {
    let raw = BASE64.decode(blob).ok()?;
    if raw.len() <= NONCE_LEN {
        return None;
    }
    let (nonce, ciphertext) = raw.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let plaintext = cipher.decrypt(Nonce::from_slice(nonce), ciphertext).ok()?;
    String::from_utf8(plaintext).ok()
}

/// Read the vault key, generating and persisting a fresh one when it is absent
/// or unreadable.
fn load_or_create_key(path: &Path) -> [u8; KEY_LEN] {
    if let Ok(raw) = fs::read_to_string(path) {
        if let Ok(bytes) = BASE64.decode(raw.trim()) {
            if bytes.len() == KEY_LEN {
                let mut key = [0u8; KEY_LEN];
                key.copy_from_slice(&bytes);
                return key;
            }
        }
        tracing::warn!("secret key at {path:?} is invalid; generating a new one");
    }

    let key = Aes256Gcm::generate_key(OsRng);
    let mut bytes = [0u8; KEY_LEN];
    bytes.copy_from_slice(&key);

    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Err(error) = fs::write(path, BASE64.encode(bytes)) {
        tracing::warn!(
            "could not persist secret key: {error}; passwords will not survive a restart"
        );
    } else {
        restrict_permissions(path);
    }
    bytes
}

/// Best effort `0600` so the key is not world readable on Unix.
#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_password() {
        let key = [7u8; KEY_LEN];
        let blob = encrypt(&key, "p@ssw0rd ünïcode").expect("encrypt");
        assert_eq!(decrypt(&key, &blob).as_deref(), Some("p@ssw0rd ünïcode"));
    }

    #[test]
    fn does_not_decrypt_with_the_wrong_key() {
        let blob = encrypt(&[1u8; KEY_LEN], "secret").expect("encrypt");
        assert_eq!(decrypt(&[2u8; KEY_LEN], &blob), None);
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(decrypt(&[0u8; KEY_LEN], "not-base64!!"), None);
        assert_eq!(decrypt(&[0u8; KEY_LEN], ""), None);
    }
}
