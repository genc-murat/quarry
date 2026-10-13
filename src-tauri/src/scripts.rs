//! Writing SQL script files.
//!
//! The native file picker is the `tauri-plugin-dialog` half; this command is the
//! half that touches the disk. It is a deliberately plain `std::fs` write so a
//! script saved by the editor is an ordinary `.sql` file any other tool can open
//! — no vault, no store, no driver involvement.

use std::path::Path;

/// Matches the IPC error shape `commands.rs` uses: a readable message string.
type CmdResult<T> = std::result::Result<T, String>;

/// Write a UTF-8 script file, creating the parent directory if the picker
/// returned a path inside one that does not exist yet.
#[tauri::command]
pub fn write_script_file(path: String, contents: String) -> CmdResult<()> {
    if let Some(parent) = Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
        }
    }
    std::fs::write(&path, contents).map_err(|error| format!("could not write {path}: {error}"))
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
        write_script_file(path.to_string_lossy().into_owned(), sql.to_string()).unwrap();
        // Read straight from the filesystem: the point is the on-disk file, not
        // a round trip through another command.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), sql);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn writing_creates_missing_parent_directories() {
        // The file path lives under a directory that does not exist yet.
        let path = temp_path("nested").join("scripts").join("query.sql");
        write_script_file(path.to_string_lossy().into_owned(), "SELECT 2".to_string()).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "SELECT 2");
        let _ = std::fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn writing_to_a_directory_reports_an_error() {
        // The temp directory exists, so writing to it as a *file* must fail.
        let dir = std::env::temp_dir();
        let error = write_script_file(dir.to_string_lossy().into_owned(), "SELECT 1".to_string())
            .unwrap_err();
        assert!(error.starts_with("could not write"), "{error}");
    }
}
