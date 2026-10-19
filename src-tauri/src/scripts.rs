//! Saving SQL script files.
//!
//! The native save dialog is opened from Rust, and what it hands the webview
//! is a *capability*, never a path: an unguessable token that this module can
//! trade for the write. A save goes straight to the file a token names, and a
//! missing or stale token puts the dialog up first — so the webview cannot
//! name a filesystem location at all, and a compromised one can at worst
//! re-write a file the human picked in this very run. Tokens die with the
//! process on purpose: a tab restored from a previous run re-asks.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, FilePath};

/// Matches the IPC error shape `commands.rs` uses: a readable message string.
type CmdResult<T> = std::result::Result<T, String>;

/// What one grant looks like over the IPC: where the file lives (for the tab
/// title and the tooltip) and the key that may save there again.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantedScript {
    pub path: String,
    pub token: String,
}

/// The live grants: token → path. Tokens are random 128-bit values, so the
/// only way to hold one is to have been handed it by this module.
#[derive(Default)]
pub struct ScriptGrants(Mutex<HashMap<String, PathBuf>>);

impl ScriptGrants {
    fn grant(&self, path: PathBuf) -> GrantedScript {
        let token = uuid::Uuid::new_v4().to_string();
        self.0
            .lock()
            .expect("the grant table locks")
            .insert(token.clone(), path.clone());
        GrantedScript {
            path: path.to_string_lossy().into_owned(),
            token,
        }
    }

    fn path_of(&self, token: &str) -> Option<PathBuf> {
        self.0
            .lock()
            .expect("the grant table locks")
            .get(token)
            .cloned()
    }
}

/// The final path segment of a suggested name — the webview may send
/// separators, and a dialog default is a name, never a path.
fn suggested_name(file_name: &str) -> String {
    let name = Path::new(file_name)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("query.sql");
    if name.trim().is_empty() {
        "query.sql".to_string()
    } else {
        name.to_string()
    }
}

/// Open the native save dialog and hand back the grant for where it landed.
/// Nothing is written yet — the grant only names the file a later save may
/// create.
#[tauri::command]
pub async fn pick_script_path(
    app: AppHandle,
    grants: State<'_, ScriptGrants>,
    file_name: String,
) -> CmdResult<Option<GrantedScript>> {
    let picked = save_dialog(&app, suggested_name(&file_name)).await?;
    Ok(picked.map(|path| grants.grant(path)))
}

/// Write `contents` to the file a grant names, or — with no live token — put
/// the save dialog up first and write where it lands. Returns the grant for
/// where the file now lives, or null on a cancelled dialog.
#[tauri::command]
pub async fn save_script_file(
    app: AppHandle,
    grants: State<'_, ScriptGrants>,
    token: Option<String>,
    file_name: String,
    contents: String,
) -> CmdResult<Option<GrantedScript>> {
    if let Some(token) = token {
        if let Some(path) = grants.path_of(&token) {
            write_script(&path, &contents)?;
            return Ok(Some(GrantedScript {
                path: path.to_string_lossy().into_owned(),
                token,
            }));
        }
    }
    let Some(picked) = save_dialog(&app, suggested_name(&file_name)).await? else {
        return Ok(None);
    };
    write_script(&picked, &contents)?;
    Ok(Some(grants.grant(picked)))
}

/// The save dialog, bridged to async through a one-shot: the plugin calls back
/// on its own thread, and the command waits for the human.
async fn save_dialog(app: &AppHandle, file_name: String) -> CmdResult<Option<PathBuf>> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("SQL script", &["sql"])
        .set_file_name(&file_name)
        .save_file(move |file: Option<FilePath>| {
            let _ = sender.send(file);
        });
    let picked = receiver
        .await
        .map_err(|_| "the dialog was closed".to_string())?;
    Ok(picked.and_then(|file: FilePath| file.into_path().ok()))
}

/// Write the text, creating the parent directory if the picked path lives in
/// one that does not exist yet. The checks are the shape of a grant, not
/// ceremony: the dialog only ever issues absolute `.sql` paths.
fn write_script(path: &Path, contents: &str) -> CmdResult<()> {
    if !path.is_absolute() {
        return Err(format!("{} is not an absolute path", path.display()));
    }
    let is_sql = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("sql"))
        .unwrap_or(false);
    if !is_sql {
        return Err(format!("{} is not a .sql file", path.display()));
    }
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
        }
    }
    std::fs::write(path, contents)
        .map_err(|error| format!("could not write {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> std::path::PathBuf {
        // A unique directory per test so parallel runs cannot collide.
        let dir =
            std::env::temp_dir().join(format!("quarry-scripts-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("script.sql")
    }

    #[test]
    fn writes_the_exact_text_to_disk() {
        let path = temp_path("roundtrip");
        let sql = "SELECT 1;\nSELECT 'a;b';\n";
        write_script(&path, sql).unwrap();
        // Read straight from the filesystem: the point is the on-disk file, not
        // a round trip through another command.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), sql);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn writing_creates_missing_parent_directories() {
        // The file path lives under a directory that does not exist yet.
        let path = temp_path("nested").join("scripts").join("query.sql");
        write_script(&path, "SELECT 2").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "SELECT 2");
        let _ = std::fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn writing_to_a_directory_reports_an_error() {
        // A directory shaped exactly like a grant — absolute, named `.sql` —
        // still cannot take a write, and the failure is reported as one.
        let dir =
            std::env::temp_dir().join(format!("quarry-scripts-dir-{}.sql", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let error = write_script(&dir, "SELECT 1").unwrap_err();
        assert!(error.starts_with("could not write"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_grant_is_exactly_an_absolute_sql_path() {
        // The dialog only issues absolute `.sql` paths; `write_script` refuses
        // anything else.
        let relative = Path::new("scripts/query.sql");
        assert!(write_script(relative, "SELECT 1").is_err());
        let not_sql = temp_path("extension").with_extension("txt");
        assert!(write_script(&not_sql, "SELECT 1").is_err());
        assert!(write_script(&temp_path("fine"), "SELECT 1").is_ok());
    }

    #[test]
    fn a_suggestion_is_taken_as_a_name_not_a_path() {
        assert_eq!(suggested_name("orders.sql"), "orders.sql");
        assert_eq!(suggested_name("/etc/passwd"), "passwd");
        assert_eq!(suggested_name("../../secrets.sql"), "secrets.sql");
        assert_eq!(suggested_name(""), "query.sql");
        assert_eq!(suggested_name("   "), "query.sql");
    }

    #[test]
    fn tokens_name_exactly_their_own_grant() {
        let grants = ScriptGrants::default();
        let granted = grants.grant(temp_path("tokened"));
        // The token resolves to its own path, and nothing else — a forged or
        // stale token finds no file to write to at all.
        assert_eq!(grants.path_of(&granted.token), Some(temp_path("tokened")));
        assert_eq!(grants.path_of("not-a-token"), None);
        let other = grants.grant(temp_path("other"));
        assert_ne!(granted.token, other.token);
    }
}
