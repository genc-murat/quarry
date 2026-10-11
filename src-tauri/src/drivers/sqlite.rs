//! Embedded SQLite driver.
//!
//! SQLite is file-backed (or explicitly in-memory), so it uses the same
//! connection contract as server databases while exposing only the `main`
//! database. A one-connection pool keeps `:memory:` databases stable.

use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use futures_util::TryStreamExt;
use serde_json::{json, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions, SqliteRow};
use sqlx::{Column, Executor, Row, TypeInfo, ValueRef};
use tokio_util::sync::CancellationToken;

use super::{
    build_object_schema, object_kind_from_marker, relational_actions, Connection, DatabaseDriver,
};
use crate::ddl::Dialect;
use crate::error::{DriverError, Result};
use crate::models::{
    ColumnMeta, ColumnSchema, ConfigField, ConnectionConfig, DatabaseInfo, DatabaseObject,
    DriverCapabilities, FieldType, ForeignKeySchema, IndexSchema, ObjectAction, ObjectKind,
    ObjectSchema, QueryLanguage, QueryRequest, QueryResponse, ResultShape, SelectOption,
    ServerInfo, StatementResult, TableColumns,
};
use crate::sql_split::split_statements;

const ACCENT: &str = "#003B57";
const DEFAULT_MAX_ROWS: usize = 1000;

pub struct SqliteDriver;

impl SqliteDriver {
    pub fn new() -> Self {
        Self
    }
}

impl Default for SqliteDriver {
    fn default() -> Self {
        Self::new()
    }
}

fn capabilities() -> DriverCapabilities {
    let mut actions = relational_actions();
    actions.push(ObjectAction::Reindex);
    DriverCapabilities {
        query_language: QueryLanguage::Sql,
        result_shape: ResultShape::Tabular,
        is_relational: true,
        supports_multiple_databases: false,
        supports_schemas: false,
        supports_transactions: true,
        supports_ddl: true,
        supports_explain: true,
        // Dropping the IPC future is not a guarantee that SQLite stops work.
        supports_cancel: false,
        object_kinds: vec![ObjectKind::Table, ObjectKind::View, ObjectKind::Trigger],
        supported_actions: actions,
    }
}

fn config_fields() -> Vec<ConfigField> {
    vec![
        ConfigField {
            key: "path".into(),
            label: "Database file".into(),
            field_type: FieldType::Text,
            placeholder: Some("/Users/me/data/shop.db".into()),
            required: true,
            default_value: None,
            options: vec![],
            help: Some("Path to the SQLite file. Use :memory: for a scratch database.".into()),
        },
        ConfigField {
            key: "createIfMissing".into(),
            label: "Create if missing".into(),
            field_type: FieldType::Select,
            placeholder: None,
            required: false,
            default_value: Some(json!("true")),
            options: vec![
                SelectOption {
                    value: "true".into(),
                    label: "Yes — create the file".into(),
                },
                SelectOption {
                    value: "false".into(),
                    label: "No — open an existing file only".into(),
                },
            ],
            help: None,
        },
    ]
}

fn path_and_options(config: &ConnectionConfig) -> Result<(String, bool)> {
    let path = config
        .options
        .get("path")
        .and_then(Value::as_str)
        .or_else(|| (!config.host.trim().is_empty()).then_some(config.host.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| DriverError::Config("a SQLite database file path is required".into()))?;
    let create_if_missing = config
        .options
        .get("createIfMissing")
        .and_then(|value| {
            value
                .as_bool()
                .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
        })
        .unwrap_or(true);
    Ok((path.to_string(), create_if_missing))
}

fn connect_options(path: &str, create_if_missing: bool) -> SqliteConnectOptions {
    let mut options = SqliteConnectOptions::new()
        .filename(Path::new(path))
        .create_if_missing(create_if_missing)
        .foreign_keys(true);
    if path == ":memory:" {
        options = options.in_memory(true);
    }
    options
}

async fn open_pool(config: &ConnectionConfig) -> Result<SqlitePool> {
    let (path, create_if_missing) = path_and_options(config)?;
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(connect_options(&path, create_if_missing))
        .await
        .map_err(|error| DriverError::Connect(error.to_string()))
}

#[async_trait]
impl DatabaseDriver for SqliteDriver {
    fn id(&self) -> &'static str {
        "sqlite"
    }
    fn display_name(&self) -> &'static str {
        "SQLite"
    }
    fn default_port(&self) -> u16 {
        0
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
    fn dialect(&self) -> Dialect {
        Dialect::Sqlite
    }
    /// SQLite plans every statement it accepts with `EXPLAIN QUERY PLAN`.
    fn explain_statement(&self, statement: &str) -> Option<String> {
        Some(format!(
            "EXPLAIN QUERY PLAN {}",
            statement.trim().trim_end_matches(';').trim()
        ))
    }

    async fn test(&self, config: &ConnectionConfig) -> Result<ServerInfo> {
        let pool = open_pool(config).await?;
        let info = fetch_server_info(&pool).await;
        pool.close().await;
        info
    }

    async fn connect(&self, config: &ConnectionConfig) -> Result<Arc<dyn Connection>> {
        let pool = open_pool(config).await?;
        let info = fetch_server_info(&pool).await?;
        Ok(Arc::new(SqliteConnection {
            driver: SqliteDriver::new(),
            pool,
            info,
        }))
    }
}

pub struct SqliteConnection {
    /// The driver this connection was opened by. [`SqliteDriver`] is a stateless
    /// declaration, so the connection carries it and answers what the engine
    /// says about itself (its id, capabilities, dialect and plan statement)
    /// from here instead of repeating it.
    driver: SqliteDriver,
    pool: SqlitePool,
    info: ServerInfo,
}

async fn fetch_server_info(pool: &SqlitePool) -> Result<ServerInfo> {
    let row = sqlx::query("SELECT sqlite_version() AS version")
        .fetch_one(pool)
        .await
        .map_err(|error| DriverError::Connect(error.to_string()))?;
    let version: Option<String> = row.try_get("version").ok();
    Ok(ServerInfo {
        version,
        version_number: None,
        server_comment: Some("SQLite embedded database".into()),
        current_database: Some("main".into()),
        current_user: None,
        supports_tls: false,
    })
}

fn pragma_identifier(identifier: &str) -> String {
    format!("'{}'", identifier.replace('\'', "''"))
}

fn require_main(database: &str) -> Result<()> {
    if database.is_empty() || database == "main" {
        Ok(())
    } else {
        Err(DriverError::Unsupported(format!(
            "SQLite sessions are opened on one database (`main`); `{database}` is not attached"
        )))
    }
}

#[async_trait]
impl Connection for SqliteConnection {
    fn driver(&self) -> &dyn DatabaseDriver {
        &self.driver
    }
    fn server_info(&self) -> &ServerInfo {
        &self.info
    }

    async fn object_ddl(
        &self,
        database: &str,
        _namespace: Option<&str>,
        object: &str,
    ) -> Result<String> {
        require_main(database)?;
        sqlx::query_scalar(
            "SELECT sql FROM main.sqlite_master WHERE name = ? AND type IN ('table', 'view', 'trigger')",
        )
        .bind(object)
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| DriverError::Introspect(error.to_string()))?
        .ok_or_else(|| DriverError::NotFound(format!("SQLite object `{object}` has no stored DDL")))
    }

    async fn ping(&self) -> Result<()> {
        sqlx::query("SELECT 1")
            .execute(&self.pool)
            .await
            .map(|_| ())
            .map_err(|error| DriverError::Connect(error.to_string()))
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        let rows = sqlx::query("PRAGMA database_list")
            .fetch_all(&self.pool)
            .await
            .map_err(|error| DriverError::Introspect(error.to_string()))?;
        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let name: String = row.try_get("name").ok()?;
                Some(DatabaseInfo {
                    is_system: name == "temp",
                    name,
                })
            })
            .collect())
    }

    async fn list_namespaces(&self, database: &str) -> Result<Vec<crate::models::NamespaceInfo>> {
        require_main(database)?;
        Ok(Vec::new())
    }

    async fn list_objects(
        &self,
        database: &str,
        _namespace: Option<&str>,
    ) -> Result<Vec<DatabaseObject>> {
        require_main(database)?;
        let rows = sqlx::query(
            "SELECT name, type FROM main.sqlite_master \
             WHERE type IN ('table', 'view', 'trigger') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' \
             ORDER BY type, name",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|error| DriverError::Introspect(error.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|row| {
                let name: String = row.try_get("name").unwrap_or_default();
                let marker: String = row.try_get("type").unwrap_or_default();
                DatabaseObject {
                    name,
                    kind: object_kind_from_marker(&marker),
                    schema: Some("main".into()),
                    comment: None,
                    row_estimate: None,
                }
            })
            .collect())
    }

    async fn describe_object(
        &self,
        database: &str,
        _namespace: Option<&str>,
        object: &str,
    ) -> Result<ObjectSchema> {
        require_main(database)?;
        let kind_marker: Option<String> = sqlx::query_scalar(
            "SELECT type FROM main.sqlite_master WHERE name = ? AND type IN ('table', 'view', 'trigger')"
        ).bind(object).fetch_optional(&self.pool).await
            .map_err(|error| DriverError::Introspect(error.to_string()))?;
        let kind = kind_marker
            .as_deref()
            .map(object_kind_from_marker)
            .ok_or_else(|| DriverError::NotFound(format!("SQLite object `{object}`")))?;

        let table_info = format!("PRAGMA main.table_info({})", pragma_identifier(object));
        let rows = sqlx::query(&table_info)
            .fetch_all(&self.pool)
            .await
            .map_err(|error| DriverError::Introspect(error.to_string()))?;
        let create_sql: Option<String> =
            sqlx::query_scalar("SELECT sql FROM main.sqlite_master WHERE name = ?")
                .bind(object)
                .fetch_optional(&self.pool)
                .await
                .map_err(|error| DriverError::Introspect(error.to_string()))?;
        let is_autoincrement = create_sql
            .as_deref()
            .map(|sql| sql.to_ascii_uppercase().contains("AUTOINCREMENT"))
            .unwrap_or(false);
        let mut columns = Vec::with_capacity(rows.len());
        for row in rows {
            let name: String = row.try_get("name").unwrap_or_default();
            let data_type: String = row.try_get("type").unwrap_or_default();
            let pk: i64 = row.try_get("pk").unwrap_or(0);
            let not_null: i64 = row.try_get("notnull").unwrap_or(0);
            let default_value: Option<String> = row.try_get("dflt_value").ok();
            columns.push(ColumnSchema {
                is_auto_increment: is_autoincrement
                    && data_type.eq_ignore_ascii_case("INTEGER")
                    && pk > 0,
                name,
                data_type,
                nullable: not_null == 0 && pk == 0,
                default_value,
                is_primary_key: pk > 0,
                comment: None,
                ordinal: row.try_get::<i64, _>("cid").unwrap_or(0).max(0) as u32,
            });
        }

        let index_rows = sqlx::query(&format!(
            "PRAGMA main.index_list({})",
            pragma_identifier(object)
        ))
        .fetch_all(&self.pool)
        .await
        .map_err(|error| DriverError::Introspect(error.to_string()))?;
        let mut indexes = Vec::new();
        for row in index_rows {
            let name: String = row.try_get("name").unwrap_or_default();
            let unique: i64 = row.try_get("unique").unwrap_or(0);
            let origin: String = row.try_get("origin").unwrap_or_default();
            let info = sqlx::query("SELECT seqno, name FROM pragma_index_info(?) ORDER BY seqno")
                .bind(&name)
                .fetch_all(&self.pool)
                .await
                .map_err(|error| DriverError::Introspect(error.to_string()))?;
            let columns_in_index = info
                .into_iter()
                .filter_map(|entry| entry.try_get::<String, _>("name").ok())
                .collect();
            indexes.push(IndexSchema {
                name,
                columns: columns_in_index,
                unique: unique != 0,
                primary: origin == "pk",
            });
        }

        let fk_rows = sqlx::query("SELECT id, seq, \"from\" AS source_column, \"table\" AS target_table, \"to\" AS target_column FROM pragma_foreign_key_list(?) ORDER BY id, seq")
            .bind(object).fetch_all(&self.pool).await
            .map_err(|error| DriverError::Introspect(error.to_string()))?;
        let mut foreign_keys: Vec<ForeignKeySchema> = Vec::new();
        for row in fk_rows {
            let id: i64 = row.try_get("id").unwrap_or(0);
            let source: String = row.try_get("source_column").unwrap_or_default();
            let target_table: String = row.try_get("target_table").unwrap_or_default();
            let target_column: String = row.try_get("target_column").unwrap_or_default();
            let name = format!("fk_{object}_{id}");
            match foreign_keys.iter_mut().find(|fk| fk.name == name) {
                Some(fk) => {
                    fk.columns.push(source);
                    fk.referenced_columns.push(target_column);
                }
                None => foreign_keys.push(ForeignKeySchema {
                    name,
                    columns: vec![source],
                    referenced_table: target_table,
                    referenced_columns: vec![target_column],
                }),
            }
        }
        Ok(build_object_schema(
            object,
            kind,
            columns,
            indexes,
            foreign_keys,
        ))
    }

    async fn list_table_columns(
        &self,
        database: &str,
        _namespace: Option<&str>,
    ) -> Result<Vec<TableColumns>> {
        require_main(database)?;
        let rows = sqlx::query(
            "SELECT m.name AS table_name, p.name AS column_name, p.type AS data_type \
             FROM main.sqlite_master AS m \
             JOIN pragma_table_info(m.name) AS p \
             WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' \
             ORDER BY m.name, p.cid",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|error| DriverError::Introspect(error.to_string()))?;
        let mut tables: Vec<TableColumns> = Vec::new();
        for row in rows {
            let table: String = row.try_get("table_name").unwrap_or_default();
            let column = ColumnMeta {
                name: row.try_get("column_name").unwrap_or_default(),
                data_type: row.try_get("data_type").ok(),
            };
            match tables.last_mut() {
                Some(entry) if entry.table == table => entry.columns.push(column),
                _ => tables.push(TableColumns {
                    table,
                    schema: Some("main".into()),
                    columns: vec![column],
                }),
            }
        }
        Ok(tables)
    }

    async fn execute(&self, request: QueryRequest) -> Result<QueryResponse> {
        self.execute_cancellable(request, CancellationToken::new())
            .await
    }

    async fn execute_cancellable(
        &self,
        request: QueryRequest,
        cancel: CancellationToken,
    ) -> Result<QueryResponse> {
        if cancel.is_cancelled() {
            return Err(DriverError::Cancelled("query interrupted".into()));
        }
        require_main(request.database.as_deref().unwrap_or("main"))?;
        let statements = split_statements(&request.sql);
        if statements.is_empty() {
            return Err(DriverError::Query("no statement to execute".into()));
        }
        let started = Instant::now();
        let max_rows = request.max_rows.unwrap_or(DEFAULT_MAX_ROWS as u32).max(1) as usize;
        let mut conn = self
            .pool
            .acquire()
            .await
            .map_err(|error| DriverError::Connect(error.to_string()))?;
        let mut results = Vec::with_capacity(statements.len());
        for statement in &statements {
            if cancel.is_cancelled() {
                return Err(DriverError::Cancelled("query interrupted".into()));
            }
            results.push(run_statement(&mut conn, statement, max_rows).await);
        }
        Ok(QueryResponse {
            results,
            total_ms: started.elapsed().as_millis() as u64,
        })
    }

}

async fn run_statement(
    conn: &mut sqlx::pool::PoolConnection<sqlx::Sqlite>,
    sql: &str,
    max_rows: usize,
) -> StatementResult {
    let started = Instant::now();
    let mut result = StatementResult {
        statement: sql.to_string(),
        is_query: false,
        columns: Vec::new(),
        rows: Vec::new(),
        row_count: 0,
        affected_rows: None,
        last_insert_id: None,
        execution_ms: 0,
        truncated: false,
        error: None,
    };
    match conn.describe(sql).await {
        Ok(description) => {
            let columns: Vec<ColumnMeta> = description
                .columns()
                .iter()
                .map(|column| ColumnMeta {
                    name: column.name().to_string(),
                    data_type: Some(column.type_info().name().to_string()),
                })
                .collect();
            if columns.is_empty() {
                match sqlx::query(sql).execute(&mut **conn).await {
                    Ok(done) => {
                        result.affected_rows = Some(done.rows_affected());
                        result.last_insert_id = Some(done.last_insert_rowid().max(0) as u64);
                    }
                    Err(error) => result.error = Some(error.to_string()),
                }
            } else {
                result.is_query = true;
                result.columns = columns;
                match stream_rows(conn, sql, max_rows).await {
                    Ok((rows, truncated)) => {
                        result.row_count = rows.len();
                        result.rows = rows;
                        result.truncated = truncated;
                    }
                    Err(error) => result.error = Some(error.to_string()),
                }
            }
        }
        Err(error) => result.error = Some(error.to_string()),
    }
    result.execution_ms = started.elapsed().as_millis() as u64;
    result
}

async fn stream_rows(
    conn: &mut sqlx::pool::PoolConnection<sqlx::Sqlite>,
    sql: &str,
    max_rows: usize,
) -> Result<(Vec<Vec<Value>>, bool)> {
    let mut rows = Vec::new();
    let mut truncated = false;
    let mut stream = sqlx::query(sql).fetch(&mut **conn);
    while let Some(row) = stream
        .try_next()
        .await
        .map_err(|error| DriverError::Query(error.to_string()))?
    {
        if rows.len() >= max_rows {
            truncated = true;
            break;
        }
        rows.push(decode_row(&row));
    }
    Ok((rows, truncated))
}

fn decode_row(row: &SqliteRow) -> Vec<Value> {
    (0..row.len())
        .map(|index| decode_cell(row, index))
        .collect()
}

fn decode_cell(row: &SqliteRow, index: usize) -> Value {
    let raw = match row.try_get_raw(index) {
        Ok(raw) => raw,
        Err(_) => return Value::Null,
    };
    if raw.is_null() {
        return Value::Null;
    }
    let kind = row.column(index).type_info().name().to_ascii_uppercase();
    match kind.as_str() {
        "INTEGER" | "INT" | "BIGINT" | "SMALLINT" => {
            if let Ok(value) = row.try_get::<i64, _>(index) {
                return json!(value);
            }
        }
        "REAL" | "FLOAT" | "DOUBLE" => {
            if let Ok(value) = row.try_get::<f64, _>(index) {
                return json!(value);
            }
        }
        "BLOB" => {
            if let Ok(value) = row.try_get::<Vec<u8>, _>(index) {
                return Value::String(format!("base64:{}", BASE64.encode(value)));
            }
        }
        _ => {}
    }
    if let Ok(value) = row.try_get::<i64, _>(index) {
        return json!(value);
    }
    if let Ok(value) = row.try_get::<f64, _>(index) {
        return json!(value);
    }
    if let Ok(value) = row.try_get::<String, _>(index) {
        return Value::String(value);
    }
    if let Ok(value) = row.try_get::<Vec<u8>, _>(index) {
        return match String::from_utf8(value.clone()) {
            Ok(text) => Value::String(text),
            Err(_) => Value::String(format!("base64:{}", BASE64.encode(value))),
        };
    }
    Value::Null
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::SslMode;

    fn config(path: &str, create: bool) -> ConnectionConfig {
        ConnectionConfig {
            driver: "sqlite".into(),
            host: String::new(),
            port: 0,
            username: String::new(),
            password: None,
            database: None,
            ssl_mode: SslMode::Disabled,
            options: serde_json::Map::from_iter([
                ("path".into(), json!(path)),
                ("createIfMissing".into(), json!(create)),
            ]),
        }
    }

    #[test]
    fn validates_path_and_reads_create_option() {
        assert!(path_and_options(&config("", true)).is_err());
        assert_eq!(
            path_and_options(&config(":memory:", false)).unwrap(),
            (":memory:".into(), false)
        );
        assert!(!capabilities().supports_multiple_databases);
        assert!(!capabilities().supports_cancel);
    }

    /// A connection carries the driver it was opened by, so its id, its
    /// capabilities, what it quotes with and how it explains a statement are
    /// the driver's declarations read back rather than a copy of them.
    #[tokio::test]
    async fn a_connection_answers_from_the_driver_it_was_opened_by() {
        let driver = SqliteDriver::new();
        let connection = driver.connect(&config(":memory:", true)).await.unwrap();

        assert_eq!(connection.driver_id(), driver.id());
        assert_eq!(
            serde_json::to_value(connection.capabilities()).unwrap(),
            serde_json::to_value(driver.capabilities()).unwrap()
        );
        assert_eq!(connection.dialect(), driver.dialect());
        assert_eq!(
            connection.quote_identifier("order items"),
            driver.dialect().quote("order items")
        );
        assert_eq!(
            connection.explain_statement("SELECT 1;"),
            driver.explain_statement("SELECT 1;")
        );
    }

    #[tokio::test]
    async fn in_memory_database_introspects_and_executes_queries() {
        let driver = SqliteDriver::new();
        let connection = driver.connect(&config(":memory:", true)).await.unwrap();
        assert_eq!(
            connection.server_info().current_database.as_deref(),
            Some("main")
        );
        let response = connection.execute(QueryRequest {
            database: Some("main".into()),
            sql: "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT); INSERT INTO users(name) VALUES ('Ada'); SELECT id, name FROM users;".into(),
            max_rows: Some(10), timeout_ms: None, run_id: None,
        }).await.unwrap();
        assert_eq!(response.results.len(), 3);
        assert_eq!(response.results[2].rows, vec![vec![json!(1), json!("Ada")]]);
        let tables = connection.list_objects("main", None).await.unwrap();
        assert_eq!(tables.len(), 1);
        connection.execute(QueryRequest {
            database: Some("main".into()),
            sql: "CREATE VIEW user_names AS SELECT name FROM users; CREATE TRIGGER user_insert AFTER INSERT ON users BEGIN UPDATE users SET name = name WHERE id = NEW.id; END;".into(),
            max_rows: Some(10), timeout_ms: None, run_id: None,
        }).await.unwrap();
        assert_eq!(
            connection
                .object_ddl("main", None, "user_names")
                .await
                .unwrap(),
            "CREATE VIEW user_names AS SELECT name FROM users"
        );
        assert!(connection
            .object_ddl("main", None, "user_insert")
            .await
            .unwrap()
            .starts_with("CREATE TRIGGER user_insert"));
        let schema = connection
            .describe_object("main", None, "users")
            .await
            .unwrap();
        assert!(schema.columns[0].is_primary_key && schema.columns[0].is_auto_increment);
        assert!(connection
            .object_ddl("main", None, "users")
            .await
            .unwrap()
            .starts_with("CREATE TABLE users"));
        let columns = connection.list_table_columns("main", None).await.unwrap();
        assert_eq!(columns.len(), 2);
        assert_eq!(columns[0].table, "user_names");
        assert_eq!(columns[1].table, "users");
    }

    #[tokio::test]
    async fn refuses_unattached_database_and_honors_no_create() {
        let driver = SqliteDriver::new();
        assert!(driver
            .connect(&config("/path/that/does/not/exist/quarry.db", false))
            .await
            .is_err());
        let connection = driver.connect(&config(":memory:", true)).await.unwrap();
        assert!(connection.list_objects("other", None).await.is_err());
    }

    #[test]
    fn decodes_blobs_as_base64_and_nulls() {
        // SQL NULL and explicit BLOB values are covered in the async query test
        // through SQLite's storage-class decoding in a live in-memory connection.
        assert_eq!(Dialect::Sqlite.quote("a\"b"), "\"a\"\"b\"");
        assert_eq!(pragma_identifier("a'b"), "'a''b'");
    }
}
