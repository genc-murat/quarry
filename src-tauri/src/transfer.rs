//! Export and import of saved connections.
//!
//! A transfer file is plain JSON: a format marker, a version, and the settings
//! of every saved connection. Passwords are not in it and cannot be — they live
//! in this machine's encrypted vault ([`crate::secrets`]), which this module
//! never reads — so moving a connection to another machine means typing its
//! password once there.
//!
//! Import keeps each connection's id, so a profile that arrives from elsewhere
//! *is* that profile rather than a look-alike. An id that is already stored is
//! left exactly as it is, which makes importing the same file twice a no-op
//! instead of a duplicate — or a silent overwrite of what was changed here
//! since. Nothing is connected and no password is asked for: an imported
//! connection is a profile, and connecting is the ordinary connect path.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::models::{ConnectionProfile, SslMode};
use crate::AppState;

/// Matches the IPC error shape `commands.rs` uses: a readable message string.
type CmdResult<T> = std::result::Result<T, String>;

/// Marker so a JSON file that is not a transfer file is refused with a readable
/// message instead of being read as an empty connection list.
const FORMAT: &str = "quarry.connections";
/// Bumped when the shape changes in a way an older build cannot read.
const VERSION: u32 = 1;

/// One connection as it travels: a profile without the password flag, which says
/// nothing useful on the receiving machine because nothing is transferred.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedConnection {
    pub id: String,
    pub name: String,
    pub driver: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub ssl_mode: SslMode,
    #[serde(default)]
    pub options: serde_json::Map<String, Value>,
}

impl ExportedConnection {
    /// Copy the settings of a stored profile. `has_password` is deliberately
    /// dropped: the flag is a fact about *this* machine's vault.
    fn from_profile(profile: &ConnectionProfile) -> Self {
        Self {
            id: profile.id.clone(),
            name: profile.name.clone(),
            driver: profile.driver.clone(),
            host: profile.host.clone(),
            port: profile.port,
            username: profile.username.clone(),
            database: profile.database.clone(),
            ssl_mode: profile.ssl_mode,
            options: profile.options.clone(),
        }
    }

    /// The profile an imported connection becomes. It has no password here —
    /// nothing about the vault travels — so `has_password` is false and the
    /// connect that follows asks for the password once.
    fn into_profile(self) -> ConnectionProfile {
        ConnectionProfile {
            id: self.id,
            name: self.name,
            driver: self.driver,
            host: self.host,
            port: self.port,
            username: self.username,
            database: self.database,
            ssl_mode: self.ssl_mode,
            options: self.options,
            has_password: false,
        }
    }
}

/// The document an export writes.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferFile {
    format: String,
    version: u32,
    connections: Vec<ExportedConnection>,
}

/// What an import did, so the UI can report it in one line.
#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    /// Connections added to the store.
    pub imported: usize,
    /// Connections whose id is already stored; they were left as they were.
    pub skipped: usize,
    /// `name (driver)` of the entries this build has no driver for.
    pub unsupported: Vec<String>,
}

/// The document an export contains. Pretty printed so the file is readable and
/// diffable by hand.
fn to_json(profiles: &[ConnectionProfile]) -> CmdResult<String> {
    let file = TransferFile {
        format: FORMAT.to_string(),
        version: VERSION,
        connections: profiles
            .iter()
            .map(ExportedConnection::from_profile)
            .collect(),
    };
    serde_json::to_string_pretty(&file)
        .map_err(|error| format!("could not serialize connections: {error}"))
}

/// Read a transfer document, refusing anything that is not one rather than
/// treating an unrelated JSON file as "no connections to import".
fn from_json(raw: &str) -> CmdResult<Vec<ExportedConnection>> {
    let file: TransferFile = serde_json::from_str(raw)
        .map_err(|error| format!("could not read the connection file: {error}"))?;

    if file.format != FORMAT {
        return Err(format!(
            "not a Quarry connections file: it declares format {:?}, expected {FORMAT:?}",
            file.format
        ));
    }
    if file.version > VERSION {
        return Err(format!(
            "the file was written by a newer version of Quarry: it declares format version {}, \
             this build reads {VERSION}",
            file.version
        ));
    }
    Ok(file.connections)
}

/// Fold the connections in a transfer file into the stored ones.
///
/// Returns only the profiles that have to be added, plus what happened to the
/// rest. A connection whose id is already stored is left exactly as it is —
/// with the password vault untouched, re-importing a file is a no-op rather
/// than a second copy of every connection — and an entry whose driver this
/// build does not have is reported by name instead of being stored half-usable.
pub fn merge(
    existing: &[ConnectionProfile],
    incoming: Vec<ExportedConnection>,
    is_known_driver: impl Fn(&str) -> bool,
) -> (Vec<ConnectionProfile>, ImportSummary) {
    let mut added = Vec::new();
    let mut summary = ImportSummary::default();

    for connection in incoming {
        if !is_known_driver(&connection.driver) {
            summary
                .unsupported
                .push(format!("{} ({})", connection.name, connection.driver));
        } else if existing.iter().any(|profile| profile.id == connection.id) {
            summary.skipped += 1;
        } else {
            added.push(connection.into_profile());
            summary.imported += 1;
        }
    }

    (added, summary)
}

/// Write the transfer file, creating the parent directory if the picker
/// returned a path inside one that does not exist yet. Returns how many
/// connections were written.
fn write_transfer(path: &Path, profiles: &[ConnectionProfile]) -> CmdResult<usize> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
        }
    }
    let json = to_json(profiles)?;
    fs::write(path, json)
        .map_err(|error| format!("could not write {}: {error}", path.display()))?;
    Ok(profiles.len())
}

/// Read a transfer file from disk.
fn read_transfer(path: &Path) -> CmdResult<Vec<ExportedConnection>> {
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;
    from_json(&raw)
}

/// Write every saved connection to `path`, for moving them to another machine.
#[tauri::command]
pub fn export_connections(state: State<'_, AppState>, path: String) -> CmdResult<usize> {
    write_transfer(Path::new(&path), &state.store.list())
}

/// Read a transfer file back: the connections it holds that this machine does
/// not have yet are added to the store, the rest are reported and left alone.
#[tauri::command]
pub fn import_connections(state: State<'_, AppState>, path: String) -> CmdResult<ImportSummary> {
    let incoming = read_transfer(Path::new(&path))?;
    let (added, summary) = merge(&state.store.list(), incoming, |driver| {
        state.registry.contains(driver)
    });

    if !added.is_empty() {
        state
            .store
            .upsert_many(added)
            .map_err(|error| error.to_string())?;
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    use crate::secrets::SecretStore;
    use crate::store::ProfileStore;

    fn profile(id: &str, name: &str, driver: &str) -> ConnectionProfile {
        ConnectionProfile {
            id: id.to_string(),
            name: name.to_string(),
            driver: driver.to_string(),
            host: "10.0.0.5".to_string(),
            port: 3306,
            username: "reader".to_string(),
            database: Some("shop".to_string()),
            ssl_mode: SslMode::Required,
            options: serde_json::Map::from_iter([("path".to_string(), json!("/data/shop.db"))]),
            // Set on the source machine, and exactly what must not travel.
            has_password: true,
        }
    }

    /// A unique directory per test so parallel runs cannot collide.
    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("quarry-transfer-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn the_file_holds_every_setting_and_no_trace_of_a_password() {
        let json = to_json(&[profile("p1", "Local MySQL", "mysql")]).unwrap();
        let parsed: Value = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed["format"], json!("quarry.connections"));
        assert_eq!(parsed["version"], json!(1));

        // Pinned key by key: a password or a `hasPassword` flag added to the
        // transfer later fails here instead of shipping quietly.
        let entry = parsed["connections"][0].as_object().unwrap();
        assert_eq!(
            entry.keys().collect::<Vec<_>>(),
            [
                "id", "name", "driver", "host", "port", "username", "database", "sslMode",
                "options"
            ],
        );
        assert_eq!(entry["options"], json!({ "path": "/data/shop.db" }));
        assert_eq!(entry["sslMode"], json!("required"));
    }

    #[test]
    fn an_imported_connection_keeps_its_id_and_arrives_without_a_password() {
        let json = to_json(&[profile("p1", "Local MySQL", "mysql")]).unwrap();
        let (added, summary) = merge(&[], from_json(&json).unwrap(), |driver| driver == "mysql");

        assert_eq!(summary.imported, 1);
        assert_eq!(summary.skipped, 0);
        assert!(summary.unsupported.is_empty());
        assert_eq!(added.len(), 1);
        assert_eq!(added[0].id, "p1");
        assert_eq!(added[0].name, "Local MySQL");
        assert_eq!(added[0].database.as_deref(), Some("shop"));
        // The source had one stored; nothing about the vault travelled, so the
        // next connect asks rather than failing against a password that is not
        // here.
        assert!(!added[0].has_password);
    }

    #[test]
    fn a_connection_that_is_already_here_is_left_exactly_as_it_was() {
        // Same id, different name and a password stored here: importing must not
        // touch it, so re-importing a file cannot undo local edits.
        let mut existing = profile("p1", "Edited here", "mysql");
        existing.has_password = true;

        let json = to_json(&[profile("p1", "Local MySQL", "mysql")]).unwrap();
        let (added, summary) = merge(&[existing.clone()], from_json(&json).unwrap(), |_| true);

        assert_eq!(summary.imported, 0);
        assert_eq!(summary.skipped, 1);
        assert!(added.is_empty());
        assert_eq!(existing.name, "Edited here");
        assert!(existing.has_password);
    }

    #[test]
    fn an_unknown_driver_is_reported_by_name_instead_of_stored() {
        let json = to_json(&[
            profile("p1", "Warehouse", "oracle"),
            profile("p2", "Local", "mysql"),
        ])
        .unwrap();
        let (added, summary) = merge(&[], from_json(&json).unwrap(), |driver| driver == "mysql");

        assert_eq!(summary.imported, 1);
        assert_eq!(summary.unsupported, ["Warehouse (oracle)"]);
        assert_eq!(added.len(), 1);
        assert_eq!(added[0].id, "p2");
    }

    #[test]
    fn a_password_stored_in_the_vault_never_reaches_the_file() {
        // The whole point of leaving passwords behind, checked against the real
        // vault and the real profile store rather than the exported fields:
        // the source machine does have a password for this connection, and the
        // export is written with the vault sitting in the very same directory.
        let dir = temp_dir("vault");
        let store = ProfileStore::load(&dir);
        let secrets = SecretStore::load(&dir);
        secrets.set_password("p1", Some("hunter2")).unwrap();

        let mut source = profile("p1", "Local MySQL", "mysql");
        source.has_password = secrets.has_password("p1");
        store.upsert(source).unwrap();

        let path = dir.join("quarry-connections.json");
        assert_eq!(write_transfer(&path, &store.list()).unwrap(), 1);
        let exported = fs::read_to_string(&path).unwrap();

        // Neither the password nor the encrypted blob it is stored as.
        assert!(
            !exported.contains("hunter2"),
            "the password travelled:
{exported}"
        );
        let vault = fs::read_to_string(dir.join("secrets.json")).unwrap();
        let blob = serde_json::from_str::<serde_json::Map<String, Value>>(&vault)
            .unwrap()
            .remove("p1")
            .and_then(|value| value.as_str().map(str::to_string))
            .expect("the vault must hold an encrypted password for p1");
        assert!(
            !exported.contains(&blob),
            "the encrypted password travelled:
{exported}"
        );

        // And what arrives has no password here either.
        let destination = temp_dir("vault-destination");
        let (added, summary) = merge(&[], read_transfer(&path).unwrap(), |_| true);
        assert_eq!(summary.imported, 1);
        assert!(!added[0].has_password);
        assert!(!SecretStore::load(&destination).has_password("p1"));

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&destination);
    }

    #[test]
    fn a_file_that_is_not_a_transfer_file_is_refused() {
        // Another tool's export that happens to carry a `format` field is called
        // out as the wrong file, so the user knows which one to pick instead.
        let other_tool = r#"{"format":"dbeaver.connections","version":1,"connections":[]}"#;
        let error = from_json(other_tool).unwrap_err();
        assert!(error.contains("not a Quarry connections file"), "{error}");
        assert!(error.contains("dbeaver.connections"), "{error}");

        // JSON with no marker at all — or no JSON — is refused as unreadable
        // rather than read as "no connections to import".
        let error = from_json(r#"{"host":"10.0.0.5","port":3306}"#).unwrap_err();
        assert!(
            error.starts_with("could not read the connection file"),
            "{error}"
        );

        let error = from_json("not json at all").unwrap_err();
        assert!(
            error.starts_with("could not read the connection file"),
            "{error}"
        );
    }

    #[test]
    fn a_newer_format_version_is_refused_rather_than_half_read() {
        let raw = json!({
            "format": "quarry.connections",
            "version": VERSION + 1,
            "connections": [],
        })
        .to_string();

        let error = from_json(&raw).unwrap_err();
        assert!(error.contains("newer version of Quarry"), "{error}");
    }

    #[test]
    fn an_exported_file_reads_back_from_disk() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("nested").join("quarry-connections.json");
        let source = vec![profile("p1", "Local MySQL", "mysql")];

        // The write creates the directory the picker pointed into.
        assert_eq!(write_transfer(&path, &source).unwrap(), 1);

        let back = read_transfer(&path).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].id, "p1");
        assert_eq!(back[0].host, "10.0.0.5");
        assert_eq!(back[0].port, 3306);
        assert_eq!(back[0].ssl_mode, SslMode::Required);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reading_a_file_that_is_not_there_says_which_path_failed() {
        let path = temp_dir("missing").join("nope.json");
        let error = read_transfer(&path).unwrap_err();
        assert!(error.starts_with("could not read "), "{error}");
        assert!(error.contains("nope.json"), "{error}");
    }
}
