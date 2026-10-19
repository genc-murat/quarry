//! Quarry — a modular, themeable database studio.
//!
//! The architecture is deliberately driver-agnostic: a [`DriverRegistry`] holds
//! every compiled-in engine and the frontend talks to all of them through the
//! same set of IPC commands.

mod commands;
mod ddl;
mod decision;
mod drivers;
mod error;
mod models;
mod scripts;
mod secrets;
mod session;
mod sql_split;
mod store;
mod transfer;
// Test-only: it pins the release check's signature fixture against the verifier
// the updater plugin calls, so the check and the app cannot drift apart.
#[cfg(test)]
mod update_signature;

use std::sync::Arc;

use tauri::Manager;
use tracing_subscriber::EnvFilter;

use decision::DecisionClient;
use drivers::DriverRegistry;
use secrets::SecretStore;
use session::{QueryRegistry, SessionManager};
use store::{ProfileStore, SettingsStore, SnippetStore};

/// Application-wide state shared by every command.
pub struct AppState {
    pub registry: Arc<DriverRegistry>,
    pub sessions: Arc<SessionManager>,
    pub store: Arc<ProfileStore>,
    pub settings: Arc<SettingsStore>,
    pub secrets: Arc<SecretStore>,
    pub snippets: Arc<SnippetStore>,
    /// In-flight query runs, cancellable by id.
    pub running: Arc<QueryRegistry>,
    /// Local decision model used to rank editor completion candidates.
    pub decision: Arc<DecisionClient>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .try_init();

    tauri::Builder::default()
        .setup(|app| {
            // Self-updates are desktop-only: the mobile stores own delivery, so
            // the plugins are neither compiled nor registered there.
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
                // Native file picker for opening/saving SQL scripts. The disk
                // half is `scripts.rs`; this only supplies the dialog.
                app.handle().plugin(tauri_plugin_dialog::init())?;
            }

            let config_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));

            app.manage(AppState {
                registry: Arc::new(DriverRegistry::with_builtins()),
                sessions: Arc::new(SessionManager::new()),
                store: Arc::new(ProfileStore::load(&config_dir)),
                settings: Arc::new(SettingsStore::load(&config_dir)),
                secrets: Arc::new(SecretStore::load(&config_dir)),
                snippets: Arc::new(SnippetStore::load(&config_dir)),
                running: Arc::new(QueryRegistry::new()),
                decision: Arc::new(DecisionClient::new()),
            });
            // Paths the script-save dialog grants, which the write half accepts.
            app.manage(scripts::ScriptGrants::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_drivers,
            commands::list_connections,
            commands::save_connection,
            commands::delete_connection,
            transfer::export_connections,
            transfer::import_connections,
            commands::test_connection,
            commands::connect,
            commands::disconnect,
            commands::set_session_profile,
            commands::list_sessions,
            commands::list_databases,
            commands::list_namespaces,
            commands::list_objects,
            commands::describe_object,
            commands::list_table_columns,
            commands::execute_query,
            commands::cancel_query,
            commands::explain_query,
            commands::object_detail,
            commands::object_section,
            commands::object_section_action,
            commands::object_action,
            commands::count_rows,
            commands::apply_row_change,
            commands::apply_row_changes,
            commands::create_table,
            commands::list_snippets,
            commands::save_snippet,
            commands::delete_snippet,
            commands::get_settings,
            commands::set_settings,
            commands::rank_candidates,
            scripts::pick_script_path,
            scripts::save_script_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
