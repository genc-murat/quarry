//! ClickHouse driver.
//!
//! ClickHouse speaks SQL over HTTP, so this adapter is relational: databases
//! come from `system.databases`, tables and views from `system.tables`, and
//! columns from `system.columns`. Statements are split with the shared SQL
//! splitter.
//!
//! * Statements that return rows are read as `JSONCompactEachRowWithNames` and
//!   streamed, so the row limit stops the transfer early. Everything else runs
//!   with `execute`.
//! * Writes are not row-oriented (`INSERT`, `ALTER TABLE ... UPDATE`), so the
//!   grid row editor is refused by [`Connection::apply_row_change`].
//! * Only the plain HTTP interface is used, so the connection form has no TLS
//!   option.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use clickhouse::query::Query;
use clickhouse::Client;
use serde_json::Value;

use super::{build_object_schema, Connection, DatabaseDriver};
use crate::ddl;
use crate::error::{DriverError, Result};
use crate::models::{
    ColumnMeta, ColumnSchema, ConfigField, ConnectionConfig, CreateTableRequest, DatabaseInfo,
    DatabaseObject, DriverCapabilities, FieldType, IndexSchema, InspectorSection, NamespaceInfo,
    ObjectAction, ObjectKind, ObjectSchema, QueryLanguage, QueryRequest, QueryResponse,
    ResultShape, RowChangeRequest, SectionAction, SectionActionRequest, SectionBlock,
    SectionColumn, SectionColumnRole, SectionField, SectionFormat, SectionRequest, SectionSource,
    SectionTone, ServerInfo, SslMode, StatementResult, TableColumns,
};
use crate::sql_split::split_statements;

const ACCENT: &str = "#FFCC01";
const DEFAULT_PORT: u16 = 8123;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Rows returned when the request does not set `maxRows`.
const DEFAULT_MAX_ROWS: usize = 1000;
/// Databases that the explorer marks as system databases.
const SYSTEM_DATABASES: [&str; 3] = ["system", "information_schema", "INFORMATION_SCHEMA"];
/// Keywords of statements that return a result set.
const ROW_KEYWORDS: [&str; 7] = [
    "SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXISTS", "EXPLAIN",
];

const TABLES_SQL: &str = "SELECT name, engine FROM system.tables WHERE database = ? ORDER BY name";
const OBJECT_SQL: &str =
    "SELECT engine, primary_key FROM system.tables WHERE database = ? AND name = ?";
const COLUMNS_SQL: &str =
    "SELECT name, type, default_kind, default_expression, is_in_primary_key, comment \
     FROM system.columns WHERE database = ? AND table = ? ORDER BY position";
const ALL_COLUMNS_SQL: &str = "SELECT table, name, type FROM system.columns \
     WHERE database = ? ORDER BY table, position";
const TABLE_SETTINGS_SQL: &str = "SELECT engine, partition_key, sorting_key, primary_key, metadata_modification_time, engine_full FROM system.tables WHERE database = ? AND name = ?";
const PARTS_SQL: &str = "SELECT partition, partition_id, sum(rows), sum(bytes_on_disk), count() FROM system.parts WHERE database = ? AND table = ? AND active GROUP BY partition, partition_id ORDER BY partition";
const MUTATIONS_SQL: &str = "SELECT mutation_id, command, create_time, is_done, parts_to_do, latest_fail_reason FROM system.mutations WHERE database = ? AND table = ? ORDER BY create_time DESC LIMIT 100";
const QUERY_LOG_SQL: &str = "SELECT event_time, query_duration_ms, read_rows, read_bytes, written_rows, written_bytes, memory_usage, query, exception FROM system.query_log WHERE type = 'QueryFinish' AND is_initial_query = 1 AND query != ''";

/// Inspector section ids this driver advertises. The UI treats them as opaque.
const STORAGE_SECTION: &str = "storage";
const QUERY_HISTORY_SECTION: &str = "query_history";
/// Action ids offered by the storage section.
const OPTIMIZE_PARTITION: &str = "optimize_partition";
const DROP_PARTITION: &str = "drop_partition";
/// Rows a query-history request returns when it does not ask for a specific count.
const DEFAULT_HISTORY_LIMIT: u32 = 50;
/// Hard cap on query-history rows, whatever the caller asks for.
const MAX_HISTORY_LIMIT: u32 = 100;

fn query_history_sql(scoped_to_database: bool, limit: u32) -> String {
    let database_filter = if scoped_to_database {
        " AND current_database = ?"
    } else {
        ""
    };
    format!(
        "{QUERY_LOG_SQL}{database_filter} ORDER BY event_time DESC LIMIT {}",
        limit.clamp(1, 100)
    )
}

fn clickhouse_insert_sql(
    table: &str,
    columns: &[String],
    requests: &[RowChangeRequest],
) -> Result<String> {
    if columns.is_empty() || requests.is_empty() {
        return Err(DriverError::Config(
            "ClickHouse bulk insert needs columns and rows".into(),
        ));
    }
    if requests.iter().any(|request| {
        request.values.len() != columns.len()
            || request
                .values
                .iter()
                .map(|value| value.column.as_str())
                .ne(columns.iter().map(String::as_str))
    }) {
        return Err(DriverError::Config(
            "ClickHouse bulk insert rows must use the same columns".into(),
        ));
    }
    let values = requests
        .iter()
        .map(|request| {
            let row = request
                .values
                .iter()
                .map(|value| clickhouse_value(&value.value))
                .collect::<Vec<_>>()
                .join(", ");
            format!("({row})")
        })
        .collect::<Vec<_>>()
        .join(", ");
    Ok(format!(
        "INSERT INTO {table} ({}) VALUES {values}",
        columns
            .iter()
            .map(|column| ddl::Dialect::Ansi.quote(column))
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

fn partition_action_sql(qualified_table: &str, partition_id: &str, action: &str) -> Result<String> {
    if partition_id.is_empty()
        || partition_id.len() > 128
        || partition_id.chars().any(char::is_control)
    {
        return Err(DriverError::Config(
            "invalid ClickHouse partition id".into(),
        ));
    }
    let partition = ddl::Dialect::Ansi.string_literal(partition_id);
    Ok(match action {
        DROP_PARTITION => format!("ALTER TABLE {qualified_table} DROP PARTITION ID {partition}"),
        OPTIMIZE_PARTITION => {
            format!("OPTIMIZE TABLE {qualified_table} PARTITION ID {partition}")
        }
        other => {
            return Err(DriverError::Unsupported(format!(
                "unknown ClickHouse partition action {other}"
            )))
        }
    })
}

/// A cell that carries its own accent, e.g. a mutation that is still running.
fn toned(text: impl Into<String>, tone: SectionTone) -> Value {
    serde_json::json!({ "text": text.into(), "tone": tone })
}

/// `true` for MergeTree and its variants (`ReplacingMergeTree`, `SummingMergeTree`,
/// `ReplicatedMergeTree`, ...) — the engines that have parts and mutations.
fn is_merge_tree(engine: &str) -> bool {
    engine.ends_with("MergeTree")
}

fn partition_columns() -> Vec<SectionColumn> {
    let column = |key: &str, label: &str, format: SectionFormat| SectionColumn {
        key: key.into(),
        label: label.into(),
        role: SectionColumnRole::Meta,
        format,
        tone: SectionTone::Neutral,
        unit: None,
    };
    vec![
        column("partition", "Partition", SectionFormat::Text),
        column("rows", "Rows", SectionFormat::Number),
        column("bytes", "Bytes", SectionFormat::Bytes),
        column("parts", "Parts", SectionFormat::Number),
    ]
}

/// Partition maintenance, offered per row of the partitions table. `param`
/// names the column whose value the row button forwards as the partition id.
fn partition_actions() -> Vec<SectionAction> {
    vec![
        SectionAction {
            id: OPTIMIZE_PARTITION.into(),
            label: "Optimize".into(),
            confirm_label: Some("Optimize partition".into()),
            description: Some(
                "This forces a merge for the selected partition and may consume substantial I/O."
                    .into(),
            ),
            danger: false,
            param: Some("partitionId".into()),
            require_param: false,
        },
        SectionAction {
            id: DROP_PARTITION.into(),
            label: "Drop".into(),
            confirm_label: Some("Drop partition".into()),
            description: Some(
                "This deletes all data in the selected partition. This operation is replicated and cannot be undone."
                    .into(),
            ),
            danger: true,
            param: Some("partitionId".into()),
            require_param: true,
        },
    ]
}

fn mutation_columns() -> Vec<SectionColumn> {
    vec![
        SectionColumn {
            key: "id".into(),
            label: "Mutation".into(),
            role: SectionColumnRole::Meta,
            format: SectionFormat::Text,
            tone: SectionTone::Neutral,
            unit: None,
        },
        SectionColumn {
            key: "status".into(),
            label: "Status".into(),
            role: SectionColumnRole::Meta,
            format: SectionFormat::Text,
            tone: SectionTone::Neutral,
            unit: None,
        },
        SectionColumn {
            key: "command".into(),
            label: "Command".into(),
            role: SectionColumnRole::Body,
            format: SectionFormat::Text,
            tone: SectionTone::Neutral,
            unit: None,
        },
        SectionColumn {
            key: "failure".into(),
            label: "Error".into(),
            role: SectionColumnRole::Body,
            format: SectionFormat::Text,
            tone: SectionTone::Danger,
            unit: None,
        },
    ]
}

fn query_history_columns() -> Vec<SectionColumn> {
    let meta = |key: &str, label: &str, format: SectionFormat, unit: Option<&str>| SectionColumn {
        key: key.into(),
        label: label.into(),
        role: SectionColumnRole::Meta,
        format,
        tone: SectionTone::Neutral,
        unit: unit.map(str::to_string),
    };
    vec![
        meta("eventTime", "Time", SectionFormat::Text, None),
        meta("durationMs", "Duration", SectionFormat::Number, Some("ms")),
        meta("readRows", "Rows read", SectionFormat::Number, None),
        meta("readBytes", "Read", SectionFormat::Bytes, None),
        meta("writtenRows", "Rows written", SectionFormat::Number, None),
        meta("writtenBytes", "Written", SectionFormat::Bytes, None),
        meta("memoryBytes", "Peak", SectionFormat::Bytes, None),
        SectionColumn {
            key: "query".into(),
            label: "Query".into(),
            role: SectionColumnRole::Body,
            format: SectionFormat::Text,
            tone: SectionTone::Neutral,
            unit: None,
        },
        SectionColumn {
            key: "exception".into(),
            label: "Error".into(),
            role: SectionColumnRole::Body,
            format: SectionFormat::Text,
            tone: SectionTone::Danger,
            unit: None,
        },
    ]
}

/// The query log is server-wide, so every object offers it.
fn query_history_section() -> InspectorSection {
    InspectorSection {
        id: QUERY_HISTORY_SECTION.into(),
        label: "Query history".into(),
        source: SectionSource::Live,
        hint: Some(format!("system.query_log · latest {DEFAULT_HISTORY_LIMIT}")),
        error_hint: Some(
            "Check system.query_log permissions and whether query logging is enabled.".into(),
        ),
        blocks: vec![],
        actions: vec![],
    }
}

pub struct ClickHouseDriver;

impl ClickHouseDriver {
    pub fn new() -> Self {
        ClickHouseDriver
    }
}

impl Default for ClickHouseDriver {
    fn default() -> Self {
        Self::new()
    }
}

fn capabilities() -> DriverCapabilities {
    DriverCapabilities {
        query_language: QueryLanguage::Sql,
        result_shape: ResultShape::Tabular,
        is_relational: true,
        supports_multiple_databases: true,
        supports_schemas: false,
        supports_transactions: false,
        // Tables are created by the ClickHouse-specific renderer (ENGINE and
        // ORDER BY); the generic ALTER/UPDATE/DELETE builders are not used.
        supports_ddl: true,
        supports_explain: true,
        supports_cancel: false,
        object_kinds: vec![
            ObjectKind::Table,
            ObjectKind::View,
            ObjectKind::MaterializedView,
        ],
        supported_actions: vec![
            ObjectAction::Inspect,
            ObjectAction::ViewData,
            ObjectAction::CountRows,
            ObjectAction::CopyName,
        ],
    }
}

fn config_fields() -> Vec<ConfigField> {
    vec![
        ConfigField {
            key: "host".into(),
            label: "Host".into(),
            field_type: FieldType::Text,
            placeholder: Some("127.0.0.1".into()),
            required: true,
            default_value: Some(serde_json::json!("127.0.0.1")),
            options: vec![],
            help: None,
        },
        ConfigField {
            key: "port".into(),
            label: "HTTP port".into(),
            field_type: FieldType::Number,
            placeholder: Some("8123".into()),
            required: true,
            default_value: Some(serde_json::json!(DEFAULT_PORT)),
            options: vec![],
            help: Some("The HTTP interface port (8123 by default).".into()),
        },
        ConfigField {
            key: "username".into(),
            label: "Username".into(),
            field_type: FieldType::Text,
            placeholder: Some("default".into()),
            required: false,
            default_value: None,
            options: vec![],
            help: None,
        },
        ConfigField {
            key: "password".into(),
            label: "Password".into(),
            field_type: FieldType::Password,
            placeholder: Some("••••••••".into()),
            required: false,
            default_value: None,
            options: vec![],
            help: None,
        },
        ConfigField {
            key: "sslMode".into(),
            label: "Transport security".into(),
            field_type: FieldType::Select,
            placeholder: None,
            required: true,
            default_value: Some(serde_json::json!("disabled")),
            options: vec![
                crate::models::SelectOption { value: "disabled".into(), label: "HTTP (no TLS)".into() },
                crate::models::SelectOption { value: "required".into(), label: "HTTPS (TLS required)".into() },
            ],
            help: Some("TLS requires a ClickHouse HTTPS endpoint (commonly port 8443). Certificate validation is enabled.".into()),
        },
        ConfigField {
            key: "database".into(),
            label: "Database".into(),
            field_type: FieldType::Text,
            placeholder: Some("default".into()),
            required: false,
            default_value: None,
            options: vec![],
            help: Some("Optional default database for statements that do not name one.".into()),
        },
    ]
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// Build an HTTP(S) URL. `Preferred` retains the historical plaintext default;
/// callers opt into HTTPS with `Required` so no silent downgrade can occur.
fn base_url(config: &ConnectionConfig) -> Result<String> {
    let host = config.host.trim();
    if host.is_empty() || host.contains('/') || host.contains('@') {
        return Err(DriverError::Config(
            "a valid host is required (without a scheme or path)".into(),
        ));
    }
    let scheme = if config.ssl_mode == SslMode::Required {
        "https"
    } else {
        "http"
    };
    Ok(format!("{scheme}://{host}:{}", config.port))
}

/// Build an HTTP client for the configured server. Nothing is contacted yet.
fn build_client(config: &ConnectionConfig) -> Result<Client> {
    let mut client = Client::default().with_url(base_url(config)?);
    let user = config.username.trim();
    if !user.is_empty() {
        client = client.with_user(user);
    }
    if let Some(password) = config.password.as_deref().filter(|value| !value.is_empty()) {
        client = client.with_password(password);
    }
    if let Some(database) = non_empty(config.database.as_deref()) {
        client = client.with_database(database);
    }
    Ok(client)
}

#[async_trait]
impl DatabaseDriver for ClickHouseDriver {
    fn id(&self) -> &'static str {
        "clickhouse"
    }

    fn display_name(&self) -> &'static str {
        "ClickHouse"
    }

    fn default_port(&self) -> u16 {
        DEFAULT_PORT
    }

    fn accent_color(&self) -> &'static str {
        ACCENT
    }

    fn capabilities(&self) -> DriverCapabilities {
        capabilities()
    }

    fn config_fields(&self) -> Vec<ConfigField> {
        config_fields()
    }

    /// ClickHouse only explains a read; anything else is refused before it
    /// reaches the server. Its connections inherit this answer.
    fn explain_statement(&self, statement: &str) -> Option<String> {
        explain_clickhouse(statement)
    }

    async fn test(&self, config: &ConnectionConfig) -> Result<ServerInfo> {
        let client = build_client(config)?;
        fetch_server_info(&client, config).await
    }

    async fn connect(&self, config: &ConnectionConfig) -> Result<Arc<dyn Connection>> {
        let client = build_client(config)?;
        let info = fetch_server_info(&client, config).await?;
        Ok(Arc::new(ClickHouseConnection {
            driver: ClickHouseDriver::new(),
            client,
            info,
            default_database: non_empty(config.database.as_deref()),
        }))
    }
}

/// Rows of a result set, as shared by the statement and table readers.
#[derive(Default)]
struct Table {
    columns: Vec<ColumnMeta>,
    rows: Vec<Vec<Value>>,
    truncated: bool,
}

/// Incrementally decodes `JSONCompactEachRowWithNames` lines: the first line
/// names the columns, every other line is one row. Once the row limit is
/// exceeded the decoder reports that no more input is needed.
struct Decoder {
    names: Option<Vec<String>>,
    rows: Vec<Vec<Value>>,
    max_rows: usize,
    truncated: bool,
}

impl Decoder {
    fn new(max_rows: usize) -> Self {
        Decoder {
            names: None,
            rows: Vec::new(),
            max_rows,
            truncated: false,
        }
    }

    /// Returns `Ok(false)` when the row limit is passed and reading can stop.
    fn push_line(&mut self, line: &[u8]) -> std::result::Result<bool, String> {
        if line.is_empty() {
            return Ok(true);
        }
        if self.names.is_none() {
            self.names = Some(serde_json::from_slice(line).map_err(|e| e.to_string())?);
            return Ok(true);
        }
        if self.rows.len() == self.max_rows {
            self.truncated = true;
            return Ok(false);
        }
        self.rows
            .push(serde_json::from_slice(line).map_err(|e| e.to_string())?);
        Ok(true)
    }

    fn finish(self) -> Table {
        Table {
            columns: self
                .names
                .unwrap_or_default()
                .into_iter()
                .map(|name| ColumnMeta {
                    name,
                    data_type: None,
                })
                .collect(),
            rows: self.rows,
            truncated: self.truncated,
        }
    }
}

/// Run a row-returning query and stream its result through [`Decoder`]. One
/// row past the limit is read to detect truncation; then the transfer stops
/// and the connection is released.
async fn read_table(query: Query, max_rows: usize) -> std::result::Result<Table, String> {
    let mut cursor = query
        .fetch_bytes("JSONCompactEachRowWithNames")
        .map_err(|e| e.to_string())?;
    let mut decoder = Decoder::new(max_rows);
    let mut pending: Vec<u8> = Vec::new();
    'read: while let Some(chunk) = cursor.next().await.map_err(|e| e.to_string())? {
        pending.extend_from_slice(&chunk);
        while let Some(end) = pending.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = pending.drain(..=end).collect();
            if !decoder.push_line(&line[..line.len() - 1])? {
                break 'read;
            }
        }
    }
    Ok(decoder.finish())
}

fn cell(row: &[Value], index: usize) -> Value {
    row.get(index).cloned().unwrap_or(Value::Null)
}

/// Text of a cell. ClickHouse quotes 64-bit integers, so numbers are rendered too.
fn text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Flags come back as `1`/`0` numbers or strings, depending on the column type.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_u64() == Some(1),
        Value::String(text) => text == "1",
        _ => false,
    }
}

/// Encode a value literal for ClickHouse VALUES inserts. ClickHouse uses
/// backslash escapes in quoted strings, so escape the slash before control and quote chars.
fn clickhouse_value(value: &Value) -> String {
    match value {
        Value::Null => "NULL".into(),
        Value::Bool(flag) => (if *flag { "true" } else { "false" }).into(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => {
            let escaped = text
                .replace('\\', "\\\\")
                .replace('\'', "\\'")
                .replace('\0', "\\0")
                .replace('\n', "\\n")
                .replace('\r', "\\r")
                .replace('\t', "\\t");
            format!("'{escaped}'")
        }
        other => {
            let encoded = other.to_string().replace('\\', "\\\\").replace('\'', "\\'");
            format!("'{encoded}'")
        }
    }
}

fn introspect_error(error: String) -> DriverError {
    DriverError::Introspect(error)
}

fn kind_from_engine(engine: &str) -> ObjectKind {
    match engine {
        "View" | "LiveView" | "WindowView" => ObjectKind::View,
        "MaterializedView" => ObjectKind::MaterializedView,
        _ => ObjectKind::Table,
    }
}

/// Whether a statement returns a result set. Leading `--` comments are skipped.
fn returns_rows(statement: &str) -> bool {
    let code: String = statement
        .lines()
        .map(str::trim_start)
        .filter(|line| !line.starts_with("--"))
        .collect::<Vec<_>>()
        .join("\n");
    let keyword = code
        .trim_start()
        .split(|c: char| !c.is_ascii_alphabetic())
        .find(|word| !word.is_empty())
        .unwrap_or("")
        .to_ascii_uppercase();
    ROW_KEYWORDS.contains(&keyword.as_str())
}

fn parse_version(version: &str) -> Option<u64> {
    let mut parts = version
        .split('.')
        .filter_map(|part| part.parse::<u64>().ok());
    let major = parts.next()?;
    let minor = parts.next().unwrap_or(0);
    let patch = parts.next().unwrap_or(0);
    Some(major * 10_000 + minor * 100 + patch)
}

async fn fetch_server_info(client: &Client, config: &ConnectionConfig) -> Result<ServerInfo> {
    let table = tokio::time::timeout(
        CONNECT_TIMEOUT,
        read_table(client.query("SELECT version()"), 1),
    )
    .await
    .map_err(|_| {
        DriverError::Connect(format!(
            "connection timed out after {}s",
            CONNECT_TIMEOUT.as_secs()
        ))
    })?
    .map_err(DriverError::Connect)?;
    let version = table.rows.first().map(|row| text(&cell(row, 0)));

    Ok(ServerInfo {
        version_number: version.as_deref().and_then(parse_version),
        version,
        server_comment: Some("ClickHouse".into()),
        current_database: non_empty(config.database.as_deref()),
        current_user: non_empty(Some(config.username.as_str())),
        supports_tls: config.ssl_mode == SslMode::Required,
    })
}

pub struct ClickHouseConnection {
    /// The driver this connection was opened by. [`ClickHouseDriver`] is a
    /// stateless declaration, so the connection carries it and answers what the
    /// engine says about itself (its id, capabilities, dialect and plan
    /// statement) from here instead of repeating it.
    driver: ClickHouseDriver,
    client: Client,
    info: ServerInfo,
    default_database: Option<String>,
}

impl ClickHouseConnection {
    /// A client whose default database is the requested one, else the profile's.
    fn client_for(&self, requested: Option<&str>) -> Client {
        match non_empty(requested).or_else(|| self.default_database.clone()) {
            Some(database) => self.client.clone().with_database(database),
            None => self.client.clone(),
        }
    }

    /// One row per active partition of a MergeTree table.
    async fn partition_rows(&self, database: &str, table: &str) -> Result<Vec<Value>> {
        let result = read_table(
            self.client_for(Some(database))
                .query(PARTS_SQL)
                .bind(database)
                .bind(table),
            usize::MAX,
        )
        .await
        .map_err(introspect_error)?;
        Ok(result
            .rows
            .iter()
            .map(|row| {
                serde_json::json!({
                    "partition": text(&cell(row, 0)),
                    "partitionId": text(&cell(row, 1)),
                    "rows": text(&cell(row, 2)).parse::<u64>().ok(),
                    "bytes": text(&cell(row, 3)).parse::<u64>().ok(),
                    "parts": text(&cell(row, 4)).parse::<u64>().ok(),
                })
            })
            .collect())
    }

    /// The partitions table. Reading `system.parts` needs its own grants, so a
    /// failed read shows the empty text instead of failing the inspector.
    async fn partitions_block(&self, database: &str, table: &str) -> SectionBlock {
        let rows = self
            .partition_rows(database, table)
            .await
            .unwrap_or_default();
        SectionBlock::Table {
            title: Some("Active partitions".into()),
            columns: partition_columns(),
            rows,
            empty_text: Some(
                "No active partitions or insufficient system.parts permissions.".into(),
            ),
            actions: partition_actions(),
        }
    }

    /// Recent mutations, for the same reason read leniently as the partitions.
    async fn mutations_block(&self, database: &str, table: &str) -> SectionBlock {
        let rows = read_table(
            self.client_for(Some(database))
                .query(MUTATIONS_SQL)
                .bind(database)
                .bind(table),
            100,
        )
        .await
        .map(|result| {
            result
                .rows
                .iter()
                .map(|row| {
                    let parts_to_do = text(&cell(row, 4)).parse::<u64>().ok();
                    let status = if truthy(&cell(row, 3)) {
                        toned("Complete", SectionTone::Success)
                    } else {
                        toned(
                            format!(
                                "{} parts remaining",
                                parts_to_do
                                    .map_or_else(|| "?".to_string(), |parts| parts.to_string())
                            ),
                            SectionTone::Warning,
                        )
                    };
                    serde_json::json!({
                        "id": text(&cell(row, 0)),
                        "status": status,
                        "command": text(&cell(row, 1)),
                        "failure": text(&cell(row, 5)),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
        SectionBlock::Log {
            title: Some("Recent mutations".into()),
            columns: mutation_columns(),
            rows,
            empty_text: Some(
                "No recent mutations or insufficient system.mutations permissions.".into(),
            ),
        }
    }

    /// The storage panel: engine layout, plus partitions and mutations for the
    /// MergeTree family. `None` when `system.tables` has no row for the object.
    async fn storage_section(
        &self,
        database: &str,
        object: &str,
    ) -> Result<Option<InspectorSection>> {
        let settings = read_table(
            self.client_for(Some(database))
                .query(TABLE_SETTINGS_SQL)
                .bind(database)
                .bind(object),
            1,
        )
        .await
        .map_err(introspect_error)?;
        let Some(row) = settings.rows.first() else {
            return Ok(None);
        };
        let engine = text(&cell(row, 0));
        let merge_tree = is_merge_tree(&engine);
        let field = |label: &str, value: String| SectionField {
            label: label.into(),
            value: non_empty(Some(value.as_str())),
        };
        let mut blocks = vec![SectionBlock::Fields {
            title: Some(if merge_tree {
                "MergeTree layout".into()
            } else {
                "Engine layout".into()
            }),
            fields: vec![
                field("Engine", engine),
                field("Partition by", text(&cell(row, 1))),
                field("Order by", text(&cell(row, 2))),
                field("Primary key", text(&cell(row, 3))),
            ],
        }];
        // Only the MergeTree family has parts and mutations; a plain `View`
        // would report two permanently empty lists.
        if merge_tree {
            blocks.push(self.partitions_block(database, object).await);
            blocks.push(self.mutations_block(database, object).await);
        }
        Ok(Some(InspectorSection {
            id: STORAGE_SECTION.into(),
            label: "Storage".into(),
            source: SectionSource::Inline,
            hint: None,
            error_hint: None,
            blocks,
            actions: vec![],
        }))
    }

    /// Body of the query-history section, scoped to the object's database.
    async fn history_section_body(&self, database: &str, limit: u32) -> Result<InspectorSection> {
        let limit = limit.clamp(1, MAX_HISTORY_LIMIT);
        let database = non_empty(Some(database)).or_else(|| self.default_database.clone());
        let sql = query_history_sql(database.is_some(), limit);
        let mut query = self.client_for(database.as_deref()).query(&sql);
        if let Some(database) = database {
            query = query.bind(database);
        }
        let result = read_table(query, limit as usize)
            .await
            .map_err(introspect_error)?;
        let rows = result
            .rows
            .iter()
            .map(|row| {
                serde_json::json!({
                    "eventTime": text(&cell(row, 0)),
                    "durationMs": text(&cell(row, 1)).parse::<u64>().ok(),
                    "readRows": text(&cell(row, 2)).parse::<u64>().ok(),
                    "readBytes": text(&cell(row, 3)).parse::<u64>().ok(),
                    "writtenRows": text(&cell(row, 4)).parse::<u64>().ok(),
                    "writtenBytes": text(&cell(row, 5)).parse::<u64>().ok(),
                    "memoryBytes": text(&cell(row, 6)).parse::<u64>().ok(),
                    "query": text(&cell(row, 7)),
                    "exception": text(&cell(row, 8)),
                })
            })
            .collect();
        let mut section = query_history_section();
        section.blocks = vec![SectionBlock::Log {
            title: Some("Recent successful queries".into()),
            columns: query_history_columns(),
            rows,
            empty_text: Some(
                "No query history is available, or the server has not flushed its logs yet.".into(),
            ),
        }];
        Ok(section)
    }
}

#[async_trait]
impl Connection for ClickHouseConnection {
    fn driver(&self) -> &dyn DatabaseDriver {
        &self.driver
    }

    fn server_info(&self) -> &ServerInfo {
        &self.info
    }

    async fn ping(&self) -> Result<()> {
        tokio::time::timeout(
            CONNECT_TIMEOUT,
            read_table(self.client.query("SELECT 1"), 1),
        )
        .await
        .map_err(|_| DriverError::Connect("ping timed out".into()))?
        .map(|_| ())
        .map_err(DriverError::Connect)
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        let table = read_table(
            self.client
                .query("SELECT name FROM system.databases ORDER BY name"),
            usize::MAX,
        )
        .await
        .map_err(introspect_error)?;
        Ok(table
            .rows
            .iter()
            .map(|row| {
                let name = text(&cell(row, 0));
                DatabaseInfo {
                    is_system: SYSTEM_DATABASES.contains(&name.as_str()),
                    name,
                }
            })
            .collect())
    }

    async fn list_namespaces(&self, _database: &str) -> Result<Vec<NamespaceInfo>> {
        Ok(vec![])
    }

    async fn list_objects(
        &self,
        database: &str,
        _namespace: Option<&str>,
    ) -> Result<Vec<DatabaseObject>> {
        let table = read_table(
            self.client_for(Some(database))
                .query(TABLES_SQL)
                .bind(database),
            usize::MAX,
        )
        .await
        .map_err(introspect_error)?;
        Ok(table
            .rows
            .iter()
            .map(|row| DatabaseObject {
                name: text(&cell(row, 0)),
                kind: kind_from_engine(&text(&cell(row, 1))),
                schema: Some(database.to_string()),
                comment: None,
                row_estimate: None,
            })
            .collect())
    }

    async fn describe_object(
        &self,
        database: &str,
        _namespace: Option<&str>,
        object: &str,
    ) -> Result<ObjectSchema> {
        let client = self.client_for(Some(database));
        let header = read_table(client.query(OBJECT_SQL).bind(database).bind(object), 1)
            .await
            .map_err(introspect_error)?;
        let row = header
            .rows
            .first()
            .ok_or_else(|| DriverError::NotFound(format!("object {object} does not exist")))?;
        let kind = kind_from_engine(&text(&cell(row, 0)));
        // ClickHouse reports the key as a tuple, `(sku)` or `(a, b)`.
        let primary_key = text(&cell(row, 1));
        let primary_key = primary_key
            .trim()
            .strip_prefix('(')
            .and_then(|inner| inner.strip_suffix(')'))
            .unwrap_or(primary_key.trim())
            .to_string();

        let table = read_table(
            client.query(COLUMNS_SQL).bind(database).bind(object),
            usize::MAX,
        )
        .await
        .map_err(introspect_error)?;
        let columns = table
            .rows
            .iter()
            .enumerate()
            .map(|(index, row)| {
                let data_type = text(&cell(row, 1));
                let default_kind = text(&cell(row, 2));
                let comment = text(&cell(row, 5));
                ColumnSchema {
                    name: text(&cell(row, 0)),
                    nullable: data_type.starts_with("Nullable("),
                    default_value: (!default_kind.is_empty()).then(|| text(&cell(row, 3))),
                    is_primary_key: truthy(&cell(row, 4)),
                    is_auto_increment: false,
                    comment: (!comment.is_empty()).then_some(comment),
                    data_type,
                    ordinal: index as u32 + 1,
                }
            })
            .collect();

        // The sorting key stands in for an index; it is not unique.
        let indexes = if primary_key.trim().is_empty() {
            vec![]
        } else {
            vec![IndexSchema {
                name: "primary_key".into(),
                columns: primary_key
                    .split(',')
                    .map(|part| part.trim().to_string())
                    .collect(),
                unique: false,
                primary: true,
            }]
        };

        Ok(build_object_schema(object, kind, columns, indexes, vec![]))
    }

    /// One `system.columns` query for the whole database, instead of describing
    /// each table in turn.
    async fn list_table_columns(
        &self,
        database: &str,
        _namespace: Option<&str>,
    ) -> Result<Vec<TableColumns>> {
        let table = read_table(
            self.client_for(Some(database))
                .query(ALL_COLUMNS_SQL)
                .bind(database),
            usize::MAX,
        )
        .await
        .map_err(introspect_error)?;

        let mut out: Vec<TableColumns> = Vec::new();
        let mut positions: HashMap<String, usize> = HashMap::new();
        for row in &table.rows {
            let name = text(&cell(row, 0));
            let position = *positions.entry(name.clone()).or_insert_with(|| {
                out.push(TableColumns {
                    table: name,
                    schema: None,
                    columns: Vec::new(),
                });
                out.len() - 1
            });
            out[position].columns.push(ColumnMeta {
                name: text(&cell(row, 1)),
                data_type: Some(text(&cell(row, 2))),
            });
        }
        Ok(out)
    }

    /// ClickHouse contributes its own inspector panels: the storage layout (with
    /// partition maintenance) and the server-wide query history.
    async fn inspect_sections(
        &self,
        database: &str,
        _namespace: Option<&str>,
        object: &str,
        _schema: &ObjectSchema,
    ) -> Result<Vec<InspectorSection>> {
        let mut sections = Vec::new();
        if let Some(storage) = self.storage_section(database, object).await? {
            sections.push(storage);
        }
        sections.push(query_history_section());
        Ok(sections)
    }

    async fn section_body(&self, request: &SectionRequest) -> Result<InspectorSection> {
        match request.section.as_str() {
            QUERY_HISTORY_SECTION => {
                self.history_section_body(
                    &request.database,
                    request.limit.unwrap_or(DEFAULT_HISTORY_LIMIT),
                )
                .await
            }
            other => Err(DriverError::NotFound(format!(
                "{other} is not a refreshable section of this object"
            ))),
        }
    }

    /// Partition maintenance. The storage section is only advertised for
    /// MergeTree tables, but this arrives as IPC input, so the object, engine
    /// and partition id are checked again here.
    async fn run_section_action(&self, request: SectionActionRequest) -> Result<QueryResponse> {
        if request.section != STORAGE_SECTION {
            return Err(DriverError::Unsupported(format!(
                "{} offers no actions",
                request.section
            )));
        }
        let partition_id = non_empty(request.param.as_deref()).ok_or_else(|| {
            DriverError::Config("partition maintenance needs a partition id".into())
        })?;
        let schema = self
            .describe_object(&request.database, None, &request.object)
            .await?;
        if schema.kind != ObjectKind::Table {
            return Err(DriverError::Unsupported(
                "partition maintenance is limited to MergeTree tables".into(),
            ));
        }
        let settings = read_table(
            self.client_for(Some(&request.database))
                .query(TABLE_SETTINGS_SQL)
                .bind(&request.database)
                .bind(&request.object),
            1,
        )
        .await
        .map_err(introspect_error)?;
        let engine = settings
            .rows
            .first()
            .map(|row| text(&cell(row, 0)))
            .unwrap_or_default();
        if !is_merge_tree(&engine) {
            return Err(DriverError::Unsupported(
                "partition maintenance requires a MergeTree-family engine".into(),
            ));
        }
        let partitions = self
            .partition_rows(&request.database, &request.object)
            .await?;
        if !partitions.iter().any(|partition| {
            partition.get("partitionId").and_then(Value::as_str) == Some(partition_id.as_str())
        }) {
            return Err(DriverError::NotFound(
                "partition id is not present in this table".into(),
            ));
        }
        let table = self.qualified_name(&request.database, None, &request.object);
        let sql = partition_action_sql(&table, &partition_id, &request.action)?;
        self.execute(QueryRequest {
            database: Some(request.database.clone()),
            sql,
            max_rows: Some(1),
            timeout_ms: None,
            run_id: None,
        })
        .await
    }

    async fn object_ddl(
        &self,
        database: &str,
        namespace: Option<&str>,
        object: &str,
    ) -> Result<String> {
        let sql = format!(
            "SHOW CREATE TABLE {}",
            self.qualified_name(database, namespace, object)
        );
        let table = read_table(self.client_for(Some(database)).query(&sql), 1)
            .await
            .map_err(introspect_error)?;
        table
            .rows
            .first()
            .map(|row| text(&cell(row, 0)))
            .ok_or_else(|| DriverError::NotFound(format!("no DDL returned for {object}")))
    }

    /// Create a table with the ClickHouse renderer: ENGINE, ORDER BY and
    /// `Nullable(T)` columns, which the generic MySQL-style builder cannot produce.
    async fn create_table(&self, request: CreateTableRequest) -> Result<QueryResponse> {
        let sql = ddl::create_clickhouse_table(&request)?;
        self.execute(QueryRequest {
            database: Some(request.database.clone()),
            sql,
            max_rows: Some(1),
            timeout_ms: None,
            run_id: None,
        })
        .await
    }

    /// Grid edits are refused: ClickHouse rows are changed with
    /// `ALTER TABLE ... UPDATE` and lightweight deletes, which the generic
    /// row helpers do not produce.
    async fn apply_row_change(&self, _request: RowChangeRequest) -> Result<QueryResponse> {
        Err(DriverError::Unsupported(
            "ClickHouse rows cannot be edited in the grid; use the validated bulk insert workflow or run mutations in SQL"
                .into(),
        ))
    }




    async fn apply_row_changes(&self, requests: Vec<RowChangeRequest>) -> Result<QueryResponse> {
        if requests.is_empty() {
            return Ok(QueryResponse {
                results: vec![],
                total_ms: 0,
            });
        }
        if requests.len() > 100 {
            return Err(DriverError::Config(
                "ClickHouse insert batches are limited to 100 rows".into(),
            ));
        }
        let first = &requests[0];
        if requests.iter().any(|request| {
            request.kind != crate::models::RowChangeKind::Insert
                || request.database != first.database
                || request.namespace != first.namespace
                || request.object != first.object
                || request
                    .values
                    .iter()
                    .map(|value| value.column.as_str())
                    .collect::<Vec<_>>()
                    != first
                        .values
                        .iter()
                        .map(|value| value.column.as_str())
                        .collect::<Vec<_>>()
        }) {
            return Err(DriverError::Config(
                "ClickHouse bulk insert requires rows for one table with identical ordered columns"
                    .into(),
            ));
        }
        let started = Instant::now();
        let table = self.qualified_name(&first.database, first.namespace.as_deref(), &first.object);
        let columns = first
            .values
            .iter()
            .map(|value| value.column.clone())
            .collect::<Vec<_>>();
        let statement = clickhouse_insert_sql(&table, &columns, &requests)?;
        let response = self
            .execute(QueryRequest {
                database: Some(first.database.clone()),
                sql: statement,
                max_rows: Some(1),
                timeout_ms: None,
                run_id: None,
            })
            .await?;
        if let Some(error) = response
            .results
            .iter()
            .find_map(|result| result.error.as_deref())
        {
            return Err(DriverError::Query(error.to_string()));
        }
        let Some(mut result) = response.results.into_iter().next() else {
            return Err(DriverError::Query(
                "ClickHouse insert returned no result".into(),
            ));
        };
        result.row_count = 0;
        // Each response entry represents one source row; keeping the per-row
        // count at one lets the import UI sum the batch accurately.
        result.affected_rows = Some(1);
        let results = (0..requests.len()).map(|_| result.clone()).collect();
        Ok(QueryResponse {
            results,
            total_ms: started.elapsed().as_millis() as u64,
        })
    }

    async fn execute(&self, request: QueryRequest) -> Result<QueryResponse> {
        let max_rows = request
            .max_rows
            .map(|rows| rows.max(1) as usize)
            .unwrap_or(DEFAULT_MAX_ROWS);
        let statements = split_statements(&request.sql);
        if statements.is_empty() {
            return Err(DriverError::Query("no statement to execute".into()));
        }

        let client = self.client_for(request.database.as_deref());
        let started = Instant::now();
        let mut results = Vec::with_capacity(statements.len());
        for statement in statements {
            results.push(run_statement(&client, statement, max_rows).await);
        }

        Ok(QueryResponse {
            results,
            total_ms: started.elapsed().as_millis() as u64,
        })
    }
}

fn explain_clickhouse(statement: &str) -> Option<String> {
    let normalized = statement.trim_start().to_ascii_uppercase();
    if normalized.starts_with("SELECT ") || normalized.starts_with("WITH ") {
        Some(format!(
            "EXPLAIN indexes = 1 {}",
            statement.trim().trim_end_matches(';')
        ))
    } else {
        None
    }
}

async fn run_statement(client: &Client, statement: String, max_rows: usize) -> StatementResult {
    let started = Instant::now();
    let rows_expected = returns_rows(&statement);
    let outcome = if rows_expected {
        read_table(client.query(&statement), max_rows).await
    } else {
        client
            .query(&statement)
            .execute()
            .await
            .map(|_| Table::default())
            .map_err(|e| e.to_string())
    };

    let mut result = StatementResult {
        statement,
        is_query: rows_expected,
        columns: vec![],
        rows: vec![],
        row_count: 0,
        affected_rows: None,
        last_insert_id: None,
        execution_ms: 0,
        truncated: false,
        error: None,
    };
    match outcome {
        Ok(table) => {
            result.row_count = table.rows.len();
            result.columns = table.columns;
            result.rows = table.rows;
            result.truncated = table.truncated;
        }
        Err(message) => {
            result.is_query = false;
            result.error = Some(message);
        }
    }
    result.execution_ms = started.elapsed().as_millis() as u64;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ColumnDefinition, SslMode};

    fn config(host: &str, port: u16, database: Option<&str>) -> ConnectionConfig {
        ConnectionConfig {
            driver: "clickhouse".into(),
            host: host.into(),
            port,
            username: String::new(),
            password: None,
            database: database.map(str::to_string),
            ssl_mode: SslMode::Disabled,
            options: Default::default(),
        }
    }

    #[test]
    fn builds_http_or_https_urls_and_rejects_invalid_hosts() {
        let mut settings = config("localhost", 8123, None);
        assert_eq!(base_url(&settings).unwrap(), "http://localhost:8123");
        settings.ssl_mode = SslMode::Required;
        assert_eq!(base_url(&settings).unwrap(), "https://localhost:8123");
        assert!(base_url(&config("  ", 8123, None)).is_err());
        assert!(base_url(&config("https://localhost", 8123, None)).is_err());
    }

    #[test]
    fn decodes_names_then_rows_and_stops_past_the_limit() {
        let mut decoder = Decoder::new(2);
        assert!(decoder.push_line(b"[\"id\",\"name\"]").unwrap());
        assert!(decoder.push_line(b"[1,\"Ada\"]").unwrap());
        assert!(decoder.push_line(b"[2,\"Lin\"]").unwrap());
        assert!(!decoder.push_line(b"[3,\"Max\"]").unwrap());
        let table = decoder.finish();
        assert_eq!(table.columns.len(), 2);
        assert_eq!(table.columns[1].name, "name");
        assert_eq!(table.rows.len(), 2);
        assert_eq!(table.rows[1][0], serde_json::json!(2));
        assert!(table.truncated);
    }

    #[test]
    fn a_result_within_the_limit_is_not_truncated() {
        let mut decoder = Decoder::new(5);
        decoder.push_line(b"[\"n\"]").unwrap();
        decoder.push_line(b"[1]").unwrap();
        let table = decoder.finish();
        assert_eq!(table.rows.len(), 1);
        assert!(!table.truncated);
    }

    #[test]
    fn clickhouse_insert_literals_escape_quotes_backslashes_and_controls() {
        assert_eq!(
            clickhouse_value(&serde_json::json!("it's \\ fine\nnext")),
            "'it\\'s \\\\ fine\\nnext'"
        );
        assert_eq!(clickhouse_value(&serde_json::json!(true)), "true");
        assert_eq!(clickhouse_value(&serde_json::Value::Null), "NULL");
    }

    #[test]
    fn malformed_lines_are_reported() {
        let mut decoder = Decoder::new(5);
        assert!(decoder.push_line(b"not json").is_err());
    }

    #[test]
    fn classifies_statements_that_return_rows() {
        assert!(returns_rows("SELECT 1"));
        assert!(returns_rows("  select * from t"));
        assert!(returns_rows("WITH x AS (SELECT 1) SELECT * FROM x"));
        assert!(returns_rows("(SELECT 1)"));
        assert!(returns_rows("-- note\nSHOW TABLES"));
        assert!(!returns_rows("INSERT INTO t VALUES (1)"));
        assert!(!returns_rows("CREATE TABLE t (x UInt8) ENGINE = Memory"));
        assert!(!returns_rows("-- only a comment"));
        assert_eq!(
            explain_clickhouse("SELECT 1;"),
            Some("EXPLAIN indexes = 1 SELECT 1".into())
        );
        assert_eq!(explain_clickhouse("INSERT INTO x VALUES (1)"), None);
    }

    #[test]
    fn query_history_is_scoped_to_the_requested_database_and_caps_limit() {
        let scoped = query_history_sql(true, 500);
        assert!(scoped.contains("current_database = ?"));
        assert!(scoped.ends_with("ORDER BY event_time DESC LIMIT 100"));

        let unscoped = query_history_sql(false, 0);
        assert!(!unscoped.contains("current_database = ?"));
        assert!(unscoped.ends_with("ORDER BY event_time DESC LIMIT 1"));
    }

    #[test]
    fn bulk_insert_sql_quotes_identifiers_and_values_for_all_rows() {
        let request = |id: u64, value: &str| RowChangeRequest {
            connection_id: "c".into(),
            database: "shop".into(),
            namespace: None,
            object: "orders".into(),
            kind: crate::models::RowChangeKind::Insert,
            key: vec![],
            values: vec![
                crate::models::RowValue {
                    column: "id".into(),
                    value: serde_json::json!(id),
                },
                crate::models::RowValue {
                    column: "display name".into(),
                    value: serde_json::json!(value),
                },
            ],
        };
        let sql = clickhouse_insert_sql(
            "orders",
            &["id".into(), "display name".into()],
            &[request(1, "O'Reilly"), request(2, "Ada")],
        )
        .unwrap();
        assert_eq!(
            sql,
            r#"INSERT INTO orders ("id", "display name") VALUES (1, 'O\'Reilly'), (2, 'Ada')"#
        );
        assert!(clickhouse_insert_sql("t", &[], &[request(1, "x")]).is_err());
        assert!(clickhouse_insert_sql("t", &["id".into()], &[request(1, "x")]).is_err());
    }

    #[test]
    fn partition_actions_quote_partition_ids_and_reject_controls() {
        let drop_sql = partition_action_sql("t", "202601", DROP_PARTITION).unwrap();
        assert!(drop_sql.contains("DROP PARTITION ID '202601'"));
        let optimize_sql = partition_action_sql("t", "it's", OPTIMIZE_PARTITION).unwrap();
        assert!(optimize_sql.contains("PARTITION ID 'it''s'"));
        let control_id = ["bad", "id"].join(&char::from(10).to_string());
        assert!(partition_action_sql("t", &control_id, DROP_PARTITION).is_err());
        assert!(partition_action_sql("t", "", OPTIMIZE_PARTITION).is_err());
        // An action id the driver never advertised is refused, not guessed at.
        assert!(partition_action_sql("t", "202601", "truncate").is_err());
    }

    #[test]
    fn sections_serialize_with_a_discriminating_block_type() {
        let section = InspectorSection {
            id: STORAGE_SECTION.into(),
            label: "Storage".into(),
            source: SectionSource::Inline,
            hint: None,
            error_hint: None,
            blocks: vec![SectionBlock::Fields {
                title: Some("MergeTree layout".into()),
                fields: vec![SectionField {
                    label: "Engine".into(),
                    value: Some("MergeTree".into()),
                }],
            }],
            actions: vec![],
        };
        let value = serde_json::to_value(&section).unwrap();
        assert_eq!(value["source"], "inline");
        assert_eq!(value["blocks"][0]["type"], "fields");
        assert_eq!(value["blocks"][0]["title"], "MergeTree layout");
        assert_eq!(value["blocks"][0]["fields"][0]["label"], "Engine");
    }

    #[test]
    fn partition_maintenance_is_row_scoped_and_guarded() {
        let actions = partition_actions();
        let drop = actions
            .iter()
            .find(|action| action.id == DROP_PARTITION)
            .unwrap();
        assert!(drop.danger);
        assert!(drop.require_param);
        assert_eq!(drop.param.as_deref(), Some("partitionId"));
        assert_eq!(drop.confirm_label.as_deref(), Some("Drop partition"));
        let optimize = actions
            .iter()
            .find(|action| action.id == OPTIMIZE_PARTITION)
            .unwrap();
        assert!(!optimize.danger);
        assert!(optimize.description.is_some());
        assert!(partition_columns()
            .iter()
            .any(|column| column.key == "bytes" && column.format == SectionFormat::Bytes));
    }

    #[test]
    fn merge_tree_detection_covers_the_engine_family() {
        assert!(is_merge_tree("MergeTree"));
        assert!(is_merge_tree("ReplicatedReplacingMergeTree"));
        assert!(!is_merge_tree("View"));
        assert!(!is_merge_tree("Memory"));
    }

    #[test]
    fn query_history_is_an_on_demand_section_with_formatted_columns() {
        let section = query_history_section();
        assert_eq!(section.id, QUERY_HISTORY_SECTION);
        assert_eq!(section.source, SectionSource::Live);
        assert!(section.error_hint.is_some());
        assert!(
            section.blocks.is_empty(),
            "a live section ships its rows on request only"
        );
        let columns = query_history_columns();
        let column = |key: &str| columns.iter().find(|column| column.key == key).unwrap();
        assert_eq!(column("readBytes").format, SectionFormat::Bytes);
        assert_eq!(column("durationMs").unit.as_deref(), Some("ms"));
        assert_eq!(column("exception").tone, SectionTone::Danger);
        assert_eq!(column("exception").role, SectionColumnRole::Body);
    }

    #[test]
    fn mutation_status_carries_its_own_tone() {
        let done = toned("Complete", SectionTone::Success);
        assert_eq!(done["text"], "Complete");
        assert_eq!(done["tone"], "success");
        assert_eq!(mutation_columns().last().unwrap().key, "failure");
    }

    #[test]
    fn engines_map_to_object_kinds() {
        assert_eq!(kind_from_engine("MergeTree"), ObjectKind::Table);
        assert_eq!(kind_from_engine("View"), ObjectKind::View);
        assert_eq!(
            kind_from_engine("MaterializedView"),
            ObjectKind::MaterializedView
        );
    }

    #[test]
    fn flags_and_cells_are_read_leniently() {
        assert!(truthy(&serde_json::json!(1)));
        assert!(truthy(&serde_json::json!("1")));
        assert!(!truthy(&serde_json::json!(0)));
        assert_eq!(text(&serde_json::json!("42")), "42");
        assert_eq!(text(&serde_json::json!(42)), "42");
        assert_eq!(cell(&[], 3), Value::Null);
    }

    #[test]
    fn versions_are_packed() {
        assert_eq!(parse_version("24.3.1.2672"), Some(240301));
        assert_eq!(parse_version("23.8"), Some(230800));
        assert_eq!(parse_version("nonsense"), None);
    }

    #[test]
    fn capabilities_offer_table_creation_but_no_destructive_actions() {
        let caps = capabilities();
        assert_eq!(caps.query_language, QueryLanguage::Sql);
        assert!(caps.is_relational);
        assert!(caps.supports_ddl);
        assert!(caps.supports_explain);
        assert!(!caps.supports_cancel);
        assert!(caps.supported_actions.contains(&ObjectAction::ViewData));
        assert!(!caps.supported_actions.contains(&ObjectAction::DropObject));
        assert!(!caps.supported_actions.contains(&ObjectAction::CreateIndex));
    }

    #[test]
    fn config_fields_offer_explicit_transport_security() {
        let fields = config_fields();
        let ssl = fields.iter().find(|field| field.key == "sslMode").unwrap();
        assert_eq!(ssl.field_type, FieldType::Select);
        assert_eq!(ssl.options.len(), 2);
        assert!(ssl.options.iter().any(|option| option.value == "required"));
    }

    /// End-to-end against a real server, skipped unless one is provided:
    ///
    /// ```text
    /// QUARRY_TEST_CLICKHOUSE_HOST=127.0.0.1 QUARRY_TEST_CLICKHOUSE_PORT=8123 cargo test -- --ignored
    /// ```
    #[tokio::test]
    #[ignore = "needs a reachable ClickHouse server (see module docs)"]
    async fn connects_introspects_and_runs_statements() {
        let Ok(host) = std::env::var("QUARRY_TEST_CLICKHOUSE_HOST") else {
            eprintln!("skipping: QUARRY_TEST_CLICKHOUSE_HOST is not set");
            return;
        };
        let config = ConnectionConfig {
            driver: "clickhouse".into(),
            host,
            port: std::env::var("QUARRY_TEST_CLICKHOUSE_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(DEFAULT_PORT),
            username: std::env::var("QUARRY_TEST_CLICKHOUSE_USER").unwrap_or_default(),
            password: std::env::var("QUARRY_TEST_CLICKHOUSE_PASSWORD").ok(),
            database: None,
            ssl_mode: SslMode::Disabled,
            options: Default::default(),
        };

        let driver = ClickHouseDriver::new();
        let info = driver.test(&config).await.expect("server info");
        assert!(info.version_number.is_some());

        let connection = driver.connect(&config).await.expect("connect");
        connection.ping().await.expect("ping");

        let run = |sql: &str, max_rows: u32| QueryRequest {
            database: Some("quarry_test".into()),
            sql: sql.into(),
            max_rows: Some(max_rows),
            timeout_ms: None,
            run_id: None,
        };
        let setup = connection
            .execute(QueryRequest {
                database: None,
                sql: "DROP DATABASE IF EXISTS quarry_test; \
                      CREATE DATABASE quarry_test; \
                      CREATE TABLE quarry_test.items (sku String, qty UInt32) ENGINE = MergeTree PARTITION BY qty % 2 ORDER BY sku; \
                      INSERT INTO quarry_test.items VALUES ('a', 1), ('b', 2), ('c', 3)"
                    .into(),
                max_rows: Some(10),
                timeout_ms: None,
                run_id: None,
            })
            .await
            .expect("setup");
        for statement in &setup.results {
            assert!(statement.error.is_none(), "{:?}", statement.error);
        }

        // The row limit is passed: two rows come back and the result is truncated.
        let limited = connection
            .execute(run(
                "SELECT sku, qty FROM quarry_test.items ORDER BY sku",
                2,
            ))
            .await
            .expect("limited select");
        assert_eq!(limited.results[0].row_count, 2);
        assert!(limited.results[0].truncated);
        assert_eq!(limited.results[0].columns[0].name, "sku");

        // The preview paging the explorer builds for a table: LIMIT and OFFSET.
        let page = connection
            .execute(run(
                "SELECT * FROM \"quarry_test\".\"items\" ORDER BY sku LIMIT 1 OFFSET 1",
                1,
            ))
            .await
            .expect("page");
        assert!(
            page.results[0].error.is_none(),
            "{:?}",
            page.results[0].error
        );
        assert_eq!(page.results[0].rows[0][0], serde_json::json!("b"));

        // One failing statement does not stop the next one.
        let mixed = connection
            .execute(run(
                "SELECT * FROM quarry_test.missing_table;\nSELECT 1 AS one",
                10,
            ))
            .await
            .expect("mixed");
        assert!(mixed.results[0].error.is_some());
        assert!(mixed.results[1].error.is_none());
        assert_eq!(mixed.results[1].rows[0][0], serde_json::json!(1));

        let databases = connection.list_databases().await.expect("databases");
        assert!(databases.iter().any(|d| d.name == "quarry_test"));
        assert!(databases.iter().any(|d| d.name == "system" && d.is_system));

        let objects = connection
            .list_objects("quarry_test", None)
            .await
            .expect("objects");
        assert!(objects
            .iter()
            .any(|o| o.name == "items" && o.kind == ObjectKind::Table));

        let schema = connection
            .describe_object("quarry_test", None, "items")
            .await
            .expect("describe");
        let names: Vec<&str> = schema.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["sku", "qty"]);
        assert!(schema.columns[0].is_primary_key);
        assert_eq!(schema.indexes[0].columns, vec!["sku".to_string()]);

        let ddl = connection
            .object_ddl("quarry_test", None, "items")
            .await
            .expect("ddl");
        assert!(ddl.contains("CREATE TABLE"), "{ddl}");

        let count = connection
            .count_rows("quarry_test", None, "items")
            .await
            .expect("count");
        assert_eq!(count, 3);

        let columns = connection
            .list_table_columns("quarry_test", None)
            .await
            .expect("columns");
        assert!(columns
            .iter()
            .any(|t| t.table == "items" && t.columns.len() == 2));

        // Inspector panels: the adapter declares the MergeTree layout, the
        // partition table and the server-wide query history for a table.
        let sections = connection
            .inspect_sections("quarry_test", None, "items", &schema)
            .await
            .expect("sections");
        let section = |id: &str| {
            sections
                .iter()
                .find(|section| section.id == id)
                .unwrap_or_else(|| panic!("{id} section is missing"))
        };
        let storage = section(STORAGE_SECTION);
        assert_eq!(storage.source, SectionSource::Inline);
        assert!(storage
            .blocks
            .iter()
            .any(|block| matches!(block, SectionBlock::Fields { .. })));
        let (partitions, partition_actions) = storage
            .blocks
            .iter()
            .find_map(|block| match block {
                SectionBlock::Table { rows, actions, .. } => Some((rows, actions)),
                _ => None,
            })
            .expect("partition table");
        assert_eq!(
            partition_actions.len(),
            2usize,
            "optimize and drop are offered"
        );
        // The table is partitioned by `qty % 2`, so both partitions are active.
        let ids: Vec<&str> = partitions
            .iter()
            .filter_map(|row| row.get("partitionId").and_then(Value::as_str))
            .collect();
        assert_eq!(ids, vec!["0", "1"]);

        let history = section(QUERY_HISTORY_SECTION);
        assert_eq!(history.source, SectionSource::Live);
        assert!(history.blocks.is_empty(), "a live section ships no rows");
        let body = connection
            .section_body(&SectionRequest {
                connection_id: String::new(),
                database: "quarry_test".into(),
                namespace: None,
                object: "items".into(),
                section: QUERY_HISTORY_SECTION.into(),
                limit: Some(5),
            })
            .await
            .expect("query history body");
        assert!(matches!(body.blocks.as_slice(), [SectionBlock::Log { .. }]));
        assert!(
            connection
                .section_body(&SectionRequest {
                    connection_id: String::new(),
                    database: "quarry_test".into(),
                    namespace: None,
                    object: "items".into(),
                    section: "nope".into(),
                    limit: None,
                })
                .await
                .is_err(),
            "an unknown section is refused"
        );

        // Partition maintenance runs through a section action, and a partition id
        // the table does not have is refused before any SQL is built.
        let action = |param: &str| SectionActionRequest {
            connection_id: String::new(),
            database: "quarry_test".into(),
            namespace: None,
            object: "items".into(),
            section: STORAGE_SECTION.into(),
            action: OPTIMIZE_PARTITION.into(),
            param: Some(param.to_string()),
        };
        let optimized = connection
            .run_section_action(action("0"))
            .await
            .expect("optimize partition");
        assert!(
            optimized
                .results
                .iter()
                .all(|result| result.error.is_none()),
            "{:?}",
            optimized.results
        );
        assert!(connection
            .run_section_action(action("no-such-partition"))
            .await
            .is_err());

        // The wizard path: ENGINE, an inferred ORDER BY from the primary key, and
        // a nullable column stored as Nullable(String).
        let created = connection
            .create_table(CreateTableRequest {
                connection_id: String::new(),
                database: "quarry_test".into(),
                namespace: None,
                table: "wizard".into(),
                columns: vec![
                    ColumnDefinition {
                        name: "sku".into(),
                        data_type: "String".into(),
                        nullable: false,
                        default_value: None,
                        is_primary_key: true,
                        is_auto_increment: false,
                        comment: None,
                        after: None,
                    },
                    ColumnDefinition {
                        name: "note".into(),
                        data_type: "String".into(),
                        nullable: true,
                        default_value: None,
                        is_primary_key: false,
                        is_auto_increment: false,
                        comment: Some("free text".into()),
                        after: None,
                    },
                ],
                if_not_exists: Some(false),
                comment: Some("wizard table".into()),
                engine: Some("MergeTree".into()),
                order_by: vec![],
                partition_by: None,
                primary_key: None,
                ttl: None,
                settings: vec![],
            })
            .await
            .expect("create table");
        assert!(
            created.results[0].error.is_none(),
            "{:?}",
            created.results[0].error
        );
        let wizard = connection
            .describe_object("quarry_test", None, "wizard")
            .await
            .expect("describe wizard");
        let note = wizard.columns.iter().find(|c| c.name == "note").unwrap();
        assert!(note.nullable);
        assert_eq!(note.data_type, "Nullable(String)");
        assert!(wizard.columns[0].is_primary_key);
        assert_eq!(wizard.indexes[0].columns, vec!["sku".to_string()]);

        let _ = connection
            .execute(QueryRequest {
                database: None,
                sql: "DROP DATABASE IF EXISTS quarry_test".into(),
                max_rows: Some(1),
                timeout_ms: None,
                run_id: None,
            })
            .await;
    }
}
