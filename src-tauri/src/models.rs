//! Serializable data transfer objects.
//!
//! These types are intentionally driver-agnostic: every adapter (MySQL,
//! PostgreSQL, and future Redis/Mongo/ClickHouse ones) speaks in terms of these
//! structures so the frontend never needs driver specific code.

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// Connection configuration
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SslMode {
    /// Never use TLS (required by very old servers, e.g. MySQL < 5.6.46).
    Disabled,
    /// Use TLS when the server offers it, otherwise fall back to plaintext.
    #[default]
    Preferred,
    /// Require a TLS connection.
    Required,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub driver: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub ssl_mode: SslMode,
    /// Driver specific extras so new drivers never require core changes.
    #[serde(default)]
    pub options: serde_json::Map<String, Value>,
}

/// A stored connection profile. Never carries the password inline; that lives
/// in the encrypted secret vault (see [`crate::secrets`]).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
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
    /// Whether a password is currently stored in the secret vault.
    #[serde(default)]
    pub has_password: bool,
}

// ---------------------------------------------------------------------------
// Driver descriptors (drive the dynamic connection form + capability aware UI)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QueryLanguage {
    Sql,
    Redis,
    Mongo,
    Http,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResultShape {
    /// Rows and columns (relational).
    Tabular,
    /// Documents (Mongo style).
    Document,
    /// Key/value pairs (Redis style).
    KeyValue,
}

/// An operation the UI can offer in a table/object context menu. Drivers
/// advertise which ones they implement via [`DriverCapabilities`]; the menu is
/// generated from that list so the frontend never hardcodes a driver.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "camelCase")]
pub enum ObjectAction {
    Inspect,
    ViewData,
    CountRows,
    CopyName,
    CopyQualifiedName,
    CopyDdl,
    GenerateDdl,
    TemplateSelect,
    TemplateInsert,
    TemplateUpdate,
    TemplateDelete,
    ExportData,
    RenameObject,
    DuplicateObject,
    DropObject,
    Truncate,
    Maintenance,
    Reindex,
    CreateIndex,
    DropIndex,
    AddColumn,
    AlterColumn,
    DropColumn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ObjectKind {
    Table,
    View,
    MaterializedView,
    Collection,
    KeySpace,
    Function,
    Procedure,
    Trigger,
    Event,
    Sequence,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FieldType {
    Text,
    Number,
    Password,
    Select,
    Boolean,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectOption {
    pub value: String,
    pub label: String,
}

/// A single field in the dynamic connection form.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigField {
    pub key: String,
    pub label: String,
    pub field_type: FieldType,
    #[serde(default)]
    pub placeholder: Option<String>,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub default_value: Option<Value>,
    #[serde(default)]
    pub options: Vec<SelectOption>,
    #[serde(default)]
    pub help: Option<String>,
}

/// What a driver can do. The UI adapts to these flags instead of hardcoding
/// driver specific behaviour.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverCapabilities {
    pub query_language: QueryLanguage,
    pub result_shape: ResultShape,
    pub is_relational: bool,
    pub supports_multiple_databases: bool,
    pub supports_schemas: bool,
    pub supports_transactions: bool,
    pub supports_ddl: bool,
    pub supports_explain: bool,
    pub supports_cancel: bool,
    pub object_kinds: Vec<ObjectKind>,
    /// Which context-menu operations the driver implements.
    #[serde(default)]
    pub supported_actions: Vec<ObjectAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverDescriptor {
    pub id: String,
    pub display_name: String,
    pub default_port: u16,
    pub accent_color: String,
    pub capabilities: DriverCapabilities,
    pub config_fields: Vec<ConfigField>,
}

// ---------------------------------------------------------------------------
// Server + schema metadata
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub version: Option<String>,
    /// Packed numeric version, e.g. 50627 for MySQL 5.6.27.
    pub version_number: Option<u64>,
    pub server_comment: Option<String>,
    pub current_database: Option<String>,
    pub current_user: Option<String>,
    pub supports_tls: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseInfo {
    pub name: String,
    #[serde(default)]
    pub is_system: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceInfo {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseObject {
    pub name: String,
    pub kind: ObjectKind,
    #[serde(default)]
    pub schema: Option<String>,
    #[serde(default)]
    pub comment: Option<String>,
    #[serde(default)]
    pub row_estimate: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnSchema {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    #[serde(default)]
    pub default_value: Option<String>,
    #[serde(default)]
    pub is_primary_key: bool,
    #[serde(default)]
    pub is_auto_increment: bool,
    #[serde(default)]
    pub comment: Option<String>,
    pub ordinal: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSchema {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeySchema {
    pub name: String,
    pub columns: Vec<String>,
    pub referenced_table: String,
    pub referenced_columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectSchema {
    pub name: String,
    pub kind: ObjectKind,
    pub columns: Vec<ColumnSchema>,
    pub indexes: Vec<IndexSchema>,
    pub foreign_keys: Vec<ForeignKeySchema>,
}

// ---------------------------------------------------------------------------
// Query execution
// ---------------------------------------------------------------------------

/// Every column of every table in a schema, fetched in one round trip. Used to
/// power editor autocompletion without describing tables one by one.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableColumns {
    pub table: String,
    #[serde(default)]
    pub schema: Option<String>,
    pub columns: Vec<ColumnMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryRequest {
    #[serde(default)]
    pub database: Option<String>,
    pub sql: String,
    #[serde(default)]
    pub max_rows: Option<u32>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// Caller-generated id used to cancel an in-flight run (see `cancel_query`).
    #[serde(default)]
    pub run_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    #[serde(default)]
    pub data_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementResult {
    pub statement: String,
    pub is_query: bool,
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<Value>>,
    pub row_count: usize,
    #[serde(default)]
    pub affected_rows: Option<u64>,
    #[serde(default)]
    pub last_insert_id: Option<u64>,
    pub execution_ms: u64,
    pub truncated: bool,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResponse {
    pub results: Vec<StatementResult>,
    pub total_ms: u64,
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub profile_id: String,
    pub driver: String,
    pub name: String,
    pub server: ServerInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    pub session: SessionInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSessionRequest {
    /// Connect an already saved profile...
    #[serde(default)]
    pub profile_id: Option<String>,
    /// ...or a fully specified, ad-hoc connection.
    #[serde(default)]
    pub config: Option<ConnectionConfig>,
}

// ---------------------------------------------------------------------------
// Saved queries (snippets)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Object actions (table context menu)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum IndexKind {
    #[default]
    BTree,
    Hash,
    FullText,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MaintenanceKind {
    Optimize,
    Analyze,
    Vacuum,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDefinition {
    pub name: String,
    pub data_type: String,
    #[serde(default)]
    pub nullable: bool,
    /// Raw SQL default expression (e.g. `0`, `CURRENT_TIMESTAMP`, `'x'`).
    #[serde(default)]
    pub default_value: Option<String>,
    #[serde(default)]
    pub is_primary_key: bool,
    #[serde(default)]
    pub is_auto_increment: bool,
    #[serde(default)]
    pub comment: Option<String>,
    /// MySQL only: where to place the column (`AFTER <col>`).
    #[serde(default)]
    pub after: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDefinition {
    #[serde(default)]
    pub name: Option<String>,
    pub columns: Vec<String>,
    #[serde(default)]
    pub unique: bool,
    #[serde(default)]
    pub kind: IndexKind,
    /// MySQL only: per-column prefix lengths.
    #[serde(default)]
    pub prefix_lengths: Vec<u32>,
}

/// A typed request for one context-menu write operation. The backend turns it
/// into dialect SQL (never string-interpolating user identifiers).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectActionRequest {
    pub connection_id: String,
    pub database: String,
    #[serde(default)]
    pub namespace: Option<String>,
    pub object: String,
    #[serde(default)]
    pub object_kind: Option<ObjectKind>,
    pub action: ObjectAction,
    #[serde(default)]
    pub new_name: Option<String>,
    #[serde(default)]
    pub with_data: Option<bool>,
    #[serde(default)]
    pub if_exists: Option<bool>,
    #[serde(default)]
    pub cascade: Option<bool>,
    #[serde(default)]
    pub maintenance: Option<MaintenanceKind>,
    #[serde(default)]
    pub index: Option<IndexDefinition>,
    #[serde(default)]
    pub index_name: Option<String>,
    #[serde(default)]
    pub column: Option<ColumnDefinition>,
    #[serde(default)]
    pub rename_to: Option<String>,
}

/// Everything the object inspector needs in one round trip.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectDetail {
    pub schema: ObjectSchema,
    pub ddl: String,
    #[serde(default)]
    pub row_count: Option<u64>,
    #[serde(default)]
    pub size_bytes: Option<u64>,
    pub actions: Vec<ObjectAction>,
    /// Identifier quote character for the driver ("`" or `"`), used by the UI
    /// when it builds quick templates.
    pub identifier_quote: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RowChangeKind {
    Insert,
    Update,
    Delete,
}

/// One column/value pair in a row mutation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowValue {
    pub column: String,
    pub value: Value,
}

/// A single-row edit coming from the results grid. The backend renders it as
/// dialect SQL (never string-interpolating identifiers) and runs it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowChangeRequest {
    pub connection_id: String,
    pub database: String,
    #[serde(default)]
    pub namespace: Option<String>,
    pub object: String,
    pub kind: RowChangeKind,
    /// Primary-key columns identifying the row (update/delete).
    #[serde(default)]
    pub key: Vec<RowValue>,
    /// New column values (insert/update).
    #[serde(default)]
    pub values: Vec<RowValue>,
}

/// Wizard definition for a brand new table. Shares [`ColumnDefinition`] with the
/// add/alter column dialogs so the DDL renderer stays in one place.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTableRequest {
    pub connection_id: String,
    pub database: String,
    #[serde(default)]
    pub namespace: Option<String>,
    pub table: String,
    pub columns: Vec<ColumnDefinition>,
    #[serde(default)]
    pub if_not_exists: Option<bool>,
    #[serde(default)]
    pub comment: Option<String>,
}

/// A named query the user saved for reuse. Driver/database are optional hints
/// so a snippet can be recalled against a matching session when one is open.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub sql: String,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub driver: Option<String>,
    /// Unix epoch milliseconds, for stable ordering.
    pub created_at: u64,
}
