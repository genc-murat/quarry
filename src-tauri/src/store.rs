//! Persistence for connection profiles and application settings.
//!
//! Passwords are deliberately *not* stored here — they live in the encrypted
//! secret vault (see [`crate::secrets`]). This file only ever holds
//! non-sensitive metadata.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde_json::Value;

use crate::error::{DriverError, Result};
use crate::models::{ConnectionProfile, Snippet};

fn read_json<T: serde::de::DeserializeOwned + Default>(path: &Path) -> T {
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => T::default(),
    }
}

fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| DriverError::Config(format!("could not create config dir: {e}")))?;
    }
    let serialized = serde_json::to_string_pretty(value)
        .map_err(|e| DriverError::Config(format!("could not serialize config: {e}")))?;
    // Write to a sibling temp file first so a crash never truncates the store.
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, serialized)
        .map_err(|e| DriverError::Config(format!("could not write config: {e}")))?;
    fs::rename(&tmp, path)
        .map_err(|e| DriverError::Config(format!("could not persist config: {e}")))?;
    Ok(())
}

#[derive(Default)]
pub struct ProfileStore {
    path: PathBuf,
    profiles: RwLock<Vec<ConnectionProfile>>,
}

impl ProfileStore {
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("connections.json");
        let profiles: Vec<ConnectionProfile> = read_json(&path);
        Self {
            path,
            profiles: RwLock::new(profiles),
        }
    }

    pub fn list(&self) -> Vec<ConnectionProfile> {
        self.profiles.read().unwrap().clone()
    }

    pub fn get(&self, id: &str) -> Option<ConnectionProfile> {
        self.profiles
            .read()
            .unwrap()
            .iter()
            .find(|p| p.id == id)
            .cloned()
    }

    /// Insert or update a profile and persist the store.
    pub fn upsert(&self, profile: ConnectionProfile) -> Result<()> {
        {
            let mut profiles = self.profiles.write().unwrap();
            match profiles.iter_mut().find(|p| p.id == profile.id) {
                Some(existing) => *existing = profile,
                None => profiles.push(profile),
            }
        }
        self.persist()
    }

    /// Insert or update several profiles in a single write, so an import
    /// touches the file once instead of once per connection.
    pub fn upsert_many(&self, incoming: Vec<ConnectionProfile>) -> Result<()> {
        if incoming.is_empty() {
            return Ok(());
        }
        {
            let mut profiles = self.profiles.write().unwrap();
            for profile in incoming {
                match profiles.iter_mut().find(|p| p.id == profile.id) {
                    Some(existing) => *existing = profile,
                    None => profiles.push(profile),
                }
            }
        }
        self.persist()
    }

    pub fn delete(&self, id: &str) -> Result<bool> {
        let removed = {
            let mut profiles = self.profiles.write().unwrap();
            let before = profiles.len();
            profiles.retain(|p| p.id != id);
            profiles.len() != before
        };
        if removed {
            self.persist()?;
        }
        Ok(removed)
    }

    fn persist(&self) -> Result<()> {
        let profiles = self.profiles.read().unwrap().clone();
        write_json(&self.path, &profiles)
    }
}

#[derive(Default)]
pub struct SnippetStore {
    path: PathBuf,
    snippets: RwLock<Vec<Snippet>>,
}

impl SnippetStore {
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("snippets.json");
        let snippets: Vec<Snippet> = read_json(&path);
        Self {
            path,
            snippets: RwLock::new(snippets),
        }
    }

    pub fn list(&self) -> Vec<Snippet> {
        self.snippets.read().unwrap().clone()
    }

    /// Insert or update a snippet and persist the store.
    pub fn upsert(&self, snippet: Snippet) -> Result<()> {
        {
            let mut snippets = self.snippets.write().unwrap();
            match snippets.iter_mut().find(|s| s.id == snippet.id) {
                Some(existing) => *existing = snippet,
                None => snippets.push(snippet),
            }
        }
        self.persist()
    }

    pub fn delete(&self, id: &str) -> Result<bool> {
        let removed = {
            let mut snippets = self.snippets.write().unwrap();
            let before = snippets.len();
            snippets.retain(|s| s.id != id);
            snippets.len() != before
        };
        if removed {
            self.persist()?;
        }
        Ok(removed)
    }

    fn persist(&self) -> Result<()> {
        let snippets = self.snippets.read().unwrap().clone();
        write_json(&self.path, &snippets)
    }
}

#[derive(Default)]
pub struct SettingsStore {
    path: PathBuf,
    value: RwLock<Value>,
}

impl SettingsStore {
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("settings.json");
        let value: Value = read_json(&path);
        Self {
            path,
            value: RwLock::new(value),
        }
    }

    /// Current settings. A missing or corrupt `settings.json` deserializes to
    /// `Value::Null`, which the frontend cannot index into, so an empty object is
    /// returned instead — callers always get a JSON object.
    pub fn get(&self) -> Value {
        let value = self.value.read().unwrap().clone();
        if value.is_object() {
            value
        } else {
            Value::Object(serde_json::Map::new())
        }
    }

    pub fn set(&self, value: Value) -> Result<()> {
        *self.value.write().unwrap() = value.clone();
        write_json(&self.path, &value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_default_to_an_object() {
        // A fresh config directory has no settings.json; `get` must still return
        // an object so `settings.theme` on the frontend never dereferences null.
        let dir = std::env::temp_dir().join(format!("quarry-settings-{}", uuid::Uuid::new_v4()));
        let store = SettingsStore::load(&dir);
        assert!(store.get().is_object());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
