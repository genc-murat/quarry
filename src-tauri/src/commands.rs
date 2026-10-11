//! The IPC surface consumed by the frontend.
//!
//! Every command here is driver-agnostic: it resolves a driver from the
//! registry and speaks through the shared trait, so adding a new engine needs
//! no changes in this file.

use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use tauri::State;
use tokio_util::sync::CancellationToken;

use crate::drivers::Connection;
use crate::error::DriverError;
use crate::models::{
    ConnectResult, ConnectionConfig, ConnectionProfile, CreateTableRequest, DatabaseInfo,
    DatabaseObject, DriverDescriptor, InspectorSection, NamespaceInfo, ObjectAction,
    ObjectActionRequest, ObjectDetail, ObjectKind, ObjectSchema, OpenSessionRequest, QueryRequest,
    QueryResponse, RowChangeKind, RowChangeRequest, SectionActionRequest, SectionRequest,
    ServerInfo, SessionInfo, Snippet, SslMode, TableColumns,
};
use crate::session::SessionEntry;
use crate::sql_split::split_statements;
use crate::AppState;

type CmdResult<T> = std::result::Result<T, String>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveConnectionInput {
    #[serde(default)]
    pub id: Option<String>,
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
    /// New password. `Some("")` clears the stored password.
    #[serde(default)]
    pub password: Option<String>,
}

#[tauri::command]
pub fn list_drivers(state: State<'_, AppState>) -> Vec<DriverDescriptor> {
    state.registry.descriptors()
}

#[tauri::command]
pub fn list_connections(state: State<'_, AppState>) -> Vec<ConnectionProfile> {
    // `has_password` is persisted with the profile and kept in sync on
    // save/delete, so the stored flag is enough. Decrypting the whole vault here
    // would be wasted work on every refresh.
    state.store.list()
}

#[tauri::command]
pub fn save_connection(
    state: State<'_, AppState>,
    input: SaveConnectionInput,
) -> CmdResult<ConnectionProfile> {
    if !state.registry.contains(&input.driver) {
        return Err(DriverError::Config(format!("unknown driver: {}", input.driver)).to_string());
    }

    let id = input
        .id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // Only write the vault when the caller actually supplied a password. `None`
    // means "edit the rest of the profile, leave the stored secret as it is",
    // and `Some("")` clears it.
    let has_password = match input.password.as_deref() {
        Some("") => {
            state.secrets.set_password(&id, None)?;
            false
        }
        Some(password) => {
            state.secrets.set_password(&id, Some(password))?;
            true
        }
        None => state.secrets.has_password(&id),
    };

    let profile = ConnectionProfile {
        id: id.clone(),
        name: input.name,
        driver: input.driver,
        host: input.host,
        port: input.port,
        username: input.username,
        database: input.database.filter(|d| !d.is_empty()),
        ssl_mode: input.ssl_mode,
        options: input.options,
        has_password,
    };
    state.store.upsert(profile.clone())?;
    Ok(profile)
}

#[tauri::command]
pub fn delete_connection(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.store.delete(&id)?;
    state.secrets.delete_password(&id);
    Ok(())
}

#[tauri::command]
pub async fn test_connection(
    state: State<'_, AppState>,
    config: ConnectionConfig,
) -> CmdResult<ServerInfo> {
    let driver = state.registry.get(&config.driver).ok_or_else(|| {
        DriverError::Config(format!("unknown driver: {}", config.driver)).to_string()
    })?;
    driver.test(&config).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn connect(
    state: State<'_, AppState>,
    input: OpenSessionRequest,
) -> CmdResult<ConnectResult> {
    let (profile_id, name, config) = resolve_open_request(&state, input)?;

    let driver = state.registry.get(&config.driver).ok_or_else(|| {
        DriverError::Config(format!("unknown driver: {}", config.driver)).to_string()
    })?;

    let connection = driver.connect(&config).await.map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let server = connection.server_info().clone();

    state
        .sessions
        .insert(SessionEntry {
            id: id.clone(),
            profile_id: profile_id.clone(),
            name: name.clone(),
            connection,
        })
        .await;

    Ok(ConnectResult {
        session: SessionInfo {
            id,
            profile_id,
            driver: config.driver,
            name,
            server,
        },
    })
}

fn resolve_open_request(
    state: &State<'_, AppState>,
    input: OpenSessionRequest,
) -> CmdResult<(String, String, ConnectionConfig)> {
    if let Some(profile_id) = input.profile_id {
        let profile = state
            .store
            .get(&profile_id)
            .ok_or_else(|| DriverError::NotFound(format!("connection {profile_id}")).to_string())?;
        let config = ConnectionConfig {
            driver: profile.driver.clone(),
            host: profile.host.clone(),
            port: profile.port,
            username: profile.username.clone(),
            password: state.secrets.get_password(&profile.id),
            database: profile.database.clone(),
            ssl_mode: profile.ssl_mode,
            options: profile.options.clone(),
        };
        return Ok((profile.id.clone(), profile.name.clone(), config));
    }

    if let Some(config) = input.config {
        let name = format!("{}@{}", config.username, config.host);
        return Ok((String::new(), name, config));
    }

    Err(DriverError::Config("no connection information provided".into()).to_string())
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, connection_id: String) -> CmdResult<()> {
    state.sessions.remove(&connection_id).await;
    Ok(())
}

#[tauri::command]
pub async fn list_sessions(state: State<'_, AppState>) -> CmdResult<Vec<SessionInfo>> {
    Ok(state.sessions.list().await)
}

async fn connection(state: &State<'_, AppState>, id: &str) -> CmdResult<Arc<dyn Connection>> {
    state
        .sessions
        .get(id)
        .await
        .ok_or_else(|| DriverError::NotFound(format!("session {id}")).to_string())
}

#[tauri::command]
pub async fn list_databases(
    state: State<'_, AppState>,
    connection_id: String,
) -> CmdResult<Vec<DatabaseInfo>> {
    connection(&state, &connection_id)
        .await?
        .list_databases()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_namespaces(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
) -> CmdResult<Vec<NamespaceInfo>> {
    connection(&state, &connection_id)
        .await?
        .list_namespaces(&database)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_objects(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    namespace: Option<String>,
) -> CmdResult<Vec<DatabaseObject>> {
    connection(&state, &connection_id)
        .await?
        .list_objects(&database, namespace.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn describe_object(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    namespace: Option<String>,
    object: String,
) -> CmdResult<ObjectSchema> {
    connection(&state, &connection_id)
        .await?
        .describe_object(&database, namespace.as_deref(), &object)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_table_columns(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    namespace: Option<String>,
) -> CmdResult<Vec<TableColumns>> {
    connection(&state, &connection_id)
        .await?
        .list_table_columns(&database, namespace.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn execute_query(
    state: State<'_, AppState>,
    connection_id: String,
    request: QueryRequest,
) -> CmdResult<QueryResponse> {
    let conn = connection(&state, &connection_id).await?;

    // Register a cancellation token under the caller's run id (when supplied)
    // so a `cancel_query` call can interrupt this run while it is in flight.
    let run_id = request.run_id.clone();
    let cancel = match run_id.as_deref() {
        Some(id) => state.running.register(id),
        None => CancellationToken::new(),
    };

    let timeout = request.timeout_ms;
    let future = conn.execute_cancellable(request, cancel.clone());
    let result = match timeout {
        Some(ms) => match tokio::time::timeout(Duration::from_millis(ms), future).await {
            Ok(result) => result,
            Err(_) => {
                // Trip the token before dropping the future so the driver's
                // watcher still issues the server-side cancel.
                cancel.cancel();
                Err(DriverError::Cancelled(format!("query exceeded {ms} ms")))
            }
        },
        None => future.await,
    };

    if let Some(id) = run_id.as_deref() {
        state.running.finish(id);
    }

    result.map_err(|e| e.to_string())
}

/// Ask a running query to stop. Returns whether a matching run was found.
#[tauri::command]
pub fn cancel_query(state: State<'_, AppState>, run_id: String) -> bool {
    state.running.cancel(&run_id)
}

/// Run each statement wrapped in its driver's `EXPLAIN`, returning the plan as
/// an ordinary result set so the UI can render it without special cases.
#[tauri::command]
pub async fn explain_query(
    state: State<'_, AppState>,
    connection_id: String,
    request: QueryRequest,
) -> CmdResult<QueryResponse> {
    let conn = connection(&state, &connection_id).await?;

    if !conn.capabilities().supports_explain {
        return Err(
            DriverError::Unsupported("this driver cannot explain queries".into()).to_string(),
        );
    }

    let statements = split_statements(&request.sql);
    if statements.is_empty() {
        return Err(DriverError::Query("no statement to explain".into()).to_string());
    }

    let mut explained = Vec::with_capacity(statements.len());
    for statement in &statements {
        match conn.explain_statement(statement) {
            Some(sql) => explained.push(sql),
            None => {
                return Err(
                    DriverError::Unsupported("this driver cannot explain queries".into())
                        .to_string(),
                )
            }
        }
    }

    let explained_request = QueryRequest {
        database: request.database,
        sql: explained.join(";\n"),
        max_rows: request.max_rows,
        timeout_ms: request.timeout_ms,
        run_id: None,
    };
    conn.execute(explained_request)
        .await
        .map_err(|e| e.to_string())
}

/// Body of a driver-declared `Live` inspector section. The driver answers for
/// the ids it advertised and refuses anything else, so this stays a router.
#[tauri::command]
pub async fn object_section(
    state: State<'_, AppState>,
    request: SectionRequest,
) -> CmdResult<InspectorSection> {
    let conn = connection(&state, &request.connection_id).await?;
    conn.section_body(&request)
        .await
        .map_err(|error| error.to_string())
}

/// Run an operation a section advertised. What an action means (and whether the
/// caller may run it against this object) is the driver's business: it owns
/// both the descriptor and the re-validation, so nothing engine-specific leaks
/// into the IPC layer.
#[tauri::command]
pub async fn object_section_action(
    state: State<'_, AppState>,
    request: SectionActionRequest,
) -> CmdResult<QueryResponse> {
    let conn = connection(&state, &request.connection_id).await?;
    conn.run_section_action(request)
        .await
        .map_err(|error| error.to_string())
}

/// Everything the object inspector shows: schema, generated DDL, row count, the
/// actions this driver supports and the inspector sections it declares.
#[tauri::command]
pub async fn object_detail(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    namespace: Option<String>,
    object: String,
) -> CmdResult<ObjectDetail> {
    let conn = connection(&state, &connection_id).await?;
    let schema = conn
        .describe_object(&database, namespace.as_deref(), &object)
        .await
        .map_err(|e| e.to_string())?;
    let ddl = conn
        .object_ddl(&database, namespace.as_deref(), &object)
        .await
        .map_err(|e| e.to_string())?;
    // Counting a view can be expensive or unsupported; never fail the whole
    // inspector because of it.
    let row_count = if matches!(
        schema.kind,
        ObjectKind::Table | ObjectKind::MaterializedView
    ) {
        conn.count_rows(&database, namespace.as_deref(), &object)
            .await
            .ok()
    } else {
        None
    };

    // Extra panels are the driver's own; a driver that cannot describe them
    // must not take the whole inspector down with it.
    let sections = conn
        .inspect_sections(&database, namespace.as_deref(), &object, &schema)
        .await
        .unwrap_or_default();
    Ok(ObjectDetail {
        schema,
        ddl,
        row_count,
        size_bytes: None,
        actions: conn.capabilities().supported_actions,
        identifier_quote: conn.dialect().quote_char().to_string(),
        sections,
    })
}

/// Run one context-menu write action, translated to dialect SQL by the driver.
#[tauri::command]
pub async fn object_action(
    state: State<'_, AppState>,
    request: ObjectActionRequest,
) -> CmdResult<QueryResponse> {
    let conn = connection(&state, &request.connection_id).await?;
    let supported = conn.capabilities().supported_actions;
    // Always resolve the real object kind from the connection: `object_kind`
    // is caller-controlled IPC data and must not let a trigger masquerade as a table.
    let object_kind = conn
        .describe_object(
            &request.database,
            request.namespace.as_deref(),
            &request.object,
        )
        .await
        .map_err(|error| error.to_string())?
        .kind;
    if conn.driver_id() == "sqlite"
        && object_kind == ObjectKind::Trigger
        && request.action != ObjectAction::DropObject
    {
        return Err(DriverError::Unsupported(
            "SQLite triggers only support drop; table actions do not apply".into(),
        )
        .to_string());
    }
    if !supported.iter().any(|action| *action == request.action) {
        return Err(DriverError::Unsupported(format!(
            "{} does not support {:?}",
            conn.driver_id(),
            request.action
        ))
        .to_string());
    }
    // Truncate/maintenance/reindex only make sense for a base table; refuse a
    // stray IPC call for anything else rather than emitting invalid DDL.
    if matches!(
        request.action,
        ObjectAction::Truncate | ObjectAction::Maintenance | ObjectAction::Reindex
    ) {
        if object_kind != ObjectKind::Table {
            return Err(DriverError::Unsupported(
                "this action is only available for tables".into(),
            )
            .to_string());
        }
    }

    conn.apply_object_action(request)
        .await
        .map_err(|e| e.to_string())
}

/// Exact row count for an object (used by the context menu).
#[tauri::command]
pub async fn count_rows(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    namespace: Option<String>,
    object: String,
) -> CmdResult<u64> {
    let conn = connection(&state, &connection_id).await?;
    conn.count_rows(&database, namespace.as_deref(), &object)
        .await
        .map_err(|e| e.to_string())
}

/// Validate a grid row change against the table schema. Shared by the single
/// and batch commands so both refuse the same unsafe requests.
fn prepare_row_change(
    schema: &ObjectSchema,
    request: &mut RowChangeRequest,
) -> crate::error::Result<()> {
    if schema.kind != ObjectKind::Table {
        return Err(DriverError::Unsupported(
            "only tables can be edited row by row".into(),
        ));
    }
    let valid_columns: std::collections::HashSet<&str> = schema
        .columns
        .iter()
        .map(|column| column.name.as_str())
        .collect();
    let mut seen_values = std::collections::HashSet::new();
    for value in &request.values {
        if !valid_columns.contains(value.column.as_str()) {
            return Err(DriverError::Config(format!(
                "unknown column: {}",
                value.column
            )));
        }
        if !seen_values.insert(value.column.as_str()) {
            return Err(DriverError::Config(format!(
                "duplicate column: {}",
                value.column
            )));
        }
    }
    match request.kind {
        RowChangeKind::Insert => {
            // Let the server assign auto-increment keys the grid left blank.
            let auto: std::collections::HashSet<String> = schema
                .columns
                .iter()
                .filter(|c| c.is_auto_increment)
                .map(|c| c.name.clone())
                .collect();
            request
                .values
                .retain(|value| !(auto.contains(&value.column) && value.value.is_null()));
            if request.values.is_empty() {
                return Err(DriverError::Config(
                    "an insert needs at least one column".into(),
                ));
            }
        }
        RowChangeKind::Update | RowChangeKind::Delete => {
            let primary: Vec<&str> = schema
                .columns
                .iter()
                .filter(|c| c.is_primary_key)
                .map(|c| c.name.as_str())
                .collect();
            if primary.is_empty() {
                return Err(DriverError::Unsupported(
                    "this table has no primary key, so rows cannot be edited safely".into(),
                ));
            }
            let provided: std::collections::HashSet<&str> =
                request.key.iter().map(|key| key.column.as_str()).collect();
            if !primary.iter().all(|pk| provided.contains(pk)) {
                return Err(DriverError::Config(
                    "the row key must include every primary key column".into(),
                ));
            }
        }
    }
    Ok(())
}

/// Apply a single-row insert/update/delete from the results grid. Building the
/// SQL here (not in the frontend) keeps identifier quoting and value escaping in
/// one tested place.
#[tauri::command]
pub async fn apply_row_change(
    state: State<'_, AppState>,
    request: RowChangeRequest,
) -> CmdResult<QueryResponse> {
    let conn = connection(&state, &request.connection_id).await?;
    let schema = conn
        .describe_object(
            &request.database,
            request.namespace.as_deref(),
            &request.object,
        )
        .await
        .map_err(|e| e.to_string())?;
    let mut request = request;
    prepare_row_change(&schema, &mut request).map_err(|e| e.to_string())?;
    conn.apply_row_change(request)
        .await
        .map_err(|e| e.to_string())
}

/// Apply a whole grid save in one call, describing each table once instead of
/// once per row so a large batch costs a single introspection round trip.
#[tauri::command]
pub async fn apply_row_changes(
    state: State<'_, AppState>,
    requests: Vec<RowChangeRequest>,
) -> CmdResult<QueryResponse> {
    if requests.len() > 100 {
        return Err(
            DriverError::Config("row-change batches are limited to 100 rows".into()).to_string(),
        );
    }
    if let Some(first) = requests.first() {
        let conn = connection(&state, &first.connection_id).await?;
        if conn.driver_id() == "clickhouse"
            && requests.iter().all(|request| {
                request.connection_id == first.connection_id
                    && request.database == first.database
                    && request.namespace == first.namespace
                    && request.object == first.object
                    && request.kind == RowChangeKind::Insert
            })
        {
            let schema = conn
                .describe_object(&first.database, first.namespace.as_deref(), &first.object)
                .await
                .map_err(|error| error.to_string())?;
            let mut validated = requests;
            for request in &mut validated {
                prepare_row_change(&schema, request).map_err(|error| error.to_string())?;
            }
            let count = validated.len();
            let response = conn
                .apply_row_changes(validated)
                .await
                .map_err(|error| error.to_string())?;
            if response.results.len() != count {
                return Err(format!(
                    "ClickHouse batch returned {} results; expected {count}",
                    response.results.len()
                ));
            }
            return Ok(response);
        }
    }

    let started = std::time::Instant::now();
    let mut results = Vec::new();
    let mut schemas: std::collections::HashMap<String, ObjectSchema> =
        std::collections::HashMap::new();

    for mut request in requests {
        let conn = connection(&state, &request.connection_id).await?;
        let key = format!(
            "{}|{}|{}|{}",
            request.connection_id,
            request.database,
            request.namespace.clone().unwrap_or_default(),
            request.object
        );
        if !schemas.contains_key(&key) {
            let schema = conn
                .describe_object(
                    &request.database,
                    request.namespace.as_deref(),
                    &request.object,
                )
                .await
                .map_err(|e| e.to_string())?;
            schemas.insert(key.clone(), schema);
        }
        prepare_row_change(&schemas[&key], &mut request).map_err(|e| {
            format!(
                "row {} failed after {} successful rows: {e}",
                results.len() + 1,
                results.len()
            )
        })?;
        let response = if conn.driver_id() == "clickhouse" && request.kind == RowChangeKind::Insert
        {
            // Validation has already resolved the table schema and checked every identifier.
            // Defer ClickHouse inserts until the full vector can use its streaming format API.
            let response = conn.apply_row_change(request).await.map_err(|e| {
                format!(
                    "row {} failed after {} successful rows: {e}",
                    results.len() + 1,
                    results.len()
                )
            })?;
            response
        } else {
            conn.apply_row_change(request).await.map_err(|e| {
                format!(
                    "row {} failed after {} successful rows: {e}",
                    results.len() + 1,
                    results.len()
                )
            })?
        };
        if let Some(error) = response
            .results
            .iter()
            .find_map(|result| result.error.as_deref())
        {
            return Err(format!(
                "row {} failed after {} successful rows: {error}",
                results.len() + 1,
                results.len()
            ));
        }
        if response.results.len() != 1 {
            return Err(format!(
                "row {} returned {} results; expected one after {} successful rows",
                results.len() + 1,
                response.results.len(),
                results.len()
            ));
        }
        results.extend(response.results);
    }

    Ok(QueryResponse {
        results,
        total_ms: started.elapsed().as_millis() as u64,
    })
}

/// Create a table from the wizard's definition.
#[tauri::command]
pub async fn create_table(
    state: State<'_, AppState>,
    request: CreateTableRequest,
) -> CmdResult<QueryResponse> {
    let conn = connection(&state, &request.connection_id).await?;
    if !conn.capabilities().supports_ddl {
        return Err(
            DriverError::Unsupported("this driver cannot create tables".into()).to_string(),
        );
    }
    conn.create_table(request).await.map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSnippetInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub sql: String,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub driver: Option<String>,
}

#[tauri::command]
pub fn list_snippets(state: State<'_, AppState>) -> Vec<Snippet> {
    state.snippets.list()
}

#[tauri::command]
pub fn save_snippet(state: State<'_, AppState>, input: SaveSnippetInput) -> CmdResult<Snippet> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err(DriverError::Config("snippet name is required".into()).to_string());
    }

    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let snippet = Snippet {
        id: input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        name: name.to_string(),
        sql: input.sql,
        database: input.database.filter(|d| !d.is_empty()),
        driver: input.driver.filter(|d| !d.is_empty()),
        created_at,
    };
    state.snippets.upsert(snippet.clone())?;
    Ok(snippet)
}

#[tauri::command]
pub fn delete_snippet(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.snippets.delete(&id)?;
    Ok(())
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Value {
    state.settings.get()
}

#[tauri::command]
pub fn set_settings(state: State<'_, AppState>, value: Value) -> CmdResult<()> {
    state.settings.set(value).map_err(|e| e.to_string())
}
