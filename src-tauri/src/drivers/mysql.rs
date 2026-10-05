//! MySQL / MariaDB driver.
//!
//! Targets MySQL 5.6 as the baseline:
//! * TLS is optional and can be disabled for builds older than 5.6.46 which
//!   predate TLS 1.2 support.
//! * Introspection only uses structures available in 5.6
//!   (`information_schema` tables that existed before 5.7/8.0).
//! * `utf8mb4`, `BIT`, `DECIMAL`, `BLOB` and temporal types are mapped
//!   explicitly so precision and nullability survive the trip to JSON.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use futures_util::TryStreamExt;
use serde_json::{json, Value};
use sqlx::mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlRow, MySqlSslMode};
use sqlx::types::chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use sqlx::types::BigDecimal;
use sqlx::{Column, Executor, Row, TypeInfo, ValueRef};
use tokio_util::sync::CancellationToken;

use super::{build_object_schema, object_kind_from_marker, relational_actions, Connection, DatabaseDriver};
use crate::ddl::Dialect;
use crate::error::{DriverError, Result};
use crate::models::{
    ColumnMeta, ColumnSchema, ConfigField, ConnectionConfig, DatabaseInfo, DatabaseObject,
    DriverCapabilities, FieldType, ForeignKeySchema, IndexSchema, NamespaceInfo, ObjectKind,
    ObjectSchema, QueryLanguage, QueryRequest, QueryResponse, ResultShape, SelectOption, ServerInfo,
    SslMode, StatementResult, TableColumns,
};
use crate::sql_split::split_statements;

const ACCENT: &str = "#0EA5B7";

pub struct MySqlDriver;

impl MySqlDriver {
    pub fn new() -> Self {
        MySqlDriver
    }
}

impl Default for MySqlDriver {
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
        supports_transactions: true,
        supports_ddl: true,
        supports_explain: true,
        supports_cancel: true,
        object_kinds: vec![ObjectKind::Table, ObjectKind::View],
        supported_actions: relational_actions(),
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
            default_value: Some(json!("127.0.0.1")),
            options: vec![],
            help: None,
        },
        ConfigField {
            key: "port".into(),
            label: "Port".into(),
            field_type: FieldType::Number,
            placeholder: Some("3306".into()),
            required: true,
            default_value: Some(json!(3306)),
            options: vec![],
            help: None,
        },
        ConfigField {
            key: "username".into(),
            label: "Username".into(),
            field_type: FieldType::Text,
            placeholder: Some("root".into()),
            required: true,
            default_value: Some(json!("root")),
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
            key: "database".into(),
            label: "Database".into(),
            field_type: FieldType::Text,
            placeholder: Some("optional".into()),
            required: false,
            default_value: None,
            options: vec![],
            help: Some("Leave empty to browse every schema.".into()),
        },
        ConfigField {
            key: "sslMode".into(),
            label: "TLS".into(),
            field_type: FieldType::Select,
            placeholder: None,
            required: false,
            default_value: Some(json!("preferred")),
            options: vec![
                SelectOption {
                    value: "preferred".into(),
                    label: "Preferred".into(),
                },
                SelectOption {
                    value: "required".into(),
                    label: "Required".into(),
                },
                SelectOption {
                    value: "disabled".into(),
                    label: "Disabled (MySQL < 5.6.46)".into(),
                },
            ],
            help: Some("Disable TLS for servers older than MySQL 5.6.46.".into()),
        },
    ]
}

fn map_ssl_mode(mode: SslMode) -> MySqlSslMode {
    match mode {
        SslMode::Disabled => MySqlSslMode::Disabled,
        SslMode::Preferred => MySqlSslMode::Preferred,
        SslMode::Required => MySqlSslMode::Required,
    }
}

fn build_options(config: &ConnectionConfig) -> MySqlConnectOptions {
    let mut options = MySqlConnectOptions::new()
        .host(config.host.as_str())
        .port(config.port)
        .username(config.username.as_str())
        .ssl_mode(map_ssl_mode(config.ssl_mode))
        // sqlx normally runs a `SET sql_mode=..., time_zone=..., NAMES ...`
        // statement right after the handshake. It goes through the
        // prepared-statement protocol, which MySQL 5.6 (our baseline) rejects
        // with error 1295 - the same failure mode that made `USE` unusable.
        // Skipping it also means we never mutate the session's SQL mode or
        // timezone behind the user's back; the server defaults apply, exactly
        // as they would in the `mysql` CLI. Charset/collation are already
        // negotiated in the handshake (utf8mb4 / utf8mb4_unicode_ci).
        .pipes_as_concat(false)
        .no_engine_substitution(false)
        .timezone(None)
        .set_names(false);
    if let Some(database) = config.database.as_deref() {
        if !database.is_empty() {
            options = options.database(database);
        }
    }
    if let Some(password) = config.password.as_deref() {
        options = options.password(password);
    }
    options
}

async fn pool_for(config: &ConnectionConfig, max_connections: u32) -> Result<MySqlPool> {
    MySqlPoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(Duration::from_secs(20))
        .connect_with(build_options(config))
        .await
        .map_err(|e| DriverError::Connect(e.to_string()))
}

#[async_trait]
impl DatabaseDriver for MySqlDriver {
    fn id(&self) -> &'static str {
        "mysql"
    }

    fn display_name(&self) -> &'static str {
        "MySQL"
    }

    fn default_port(&self) -> u16 {
        3306
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

    async fn test(&self, config: &ConnectionConfig) -> Result<ServerInfo> {
        let pool = pool_for(config, 1).await?;
        let info = fetch_server_info(&pool).await;
        pool.close().await;
        info
    }

    async fn connect(&self, config: &ConnectionConfig) -> Result<Arc<dyn Connection>> {
        let pool = pool_for(config, 5).await?;
        let info = fetch_server_info(&pool).await?;
        Ok(Arc::new(MySqlConnection {
            pool,
            other_pools: Mutex::new(HashMap::new()),
            config: config.clone(),
            info,
        }))
    }
}

/// Parse a semantic version string into a packed number (5.6.27 -> 50627).
fn parse_version(version: &str) -> Option<u64> {
    let cleaned: String = version
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let mut parts = cleaned.split('.').filter_map(|p| p.parse::<u64>().ok());
    let major = parts.next()?;
    let minor = parts.next().unwrap_or(0);
    let patch = parts.next().unwrap_or(0);
    Some(major * 10_000 + minor * 100 + patch)
}

async fn fetch_server_info(pool: &MySqlPool) -> Result<ServerInfo> {
    // NOTE: aliases are back-quoted because names such as `current_user` are
    // reserved words on MySQL 5.6 and would be a syntax error unquoted.
    let row = sqlx::query(
        "SELECT VERSION() AS `version`, \
         @@version_comment AS `version_comment`, \
         DATABASE() AS `current_db`, \
         CURRENT_USER() AS `current_usr`",
    )
    .fetch_one(pool)
    .await
    .map_err(|e| DriverError::Connect(e.to_string()))?;

    let version: Option<String> = row.try_get("version").ok();
    let supports_tls = sqlx::query("SHOW VARIABLES LIKE 'have_ssl'")
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .and_then(|row| row.try_get::<String, _>("Value").ok())
        .map(|value| !value.eq_ignore_ascii_case("NO") && !value.is_empty())
        .unwrap_or(false);

    Ok(ServerInfo {
        version_number: version.as_deref().and_then(parse_version),
        version,
        server_comment: row.try_get("version_comment").ok(),
        current_database: row.try_get("current_db").ok(),
        current_user: row.try_get("current_usr").ok(),
        supports_tls,
    })
}

pub struct MySqlConnection {
    /// Pool bound to the database named in the connection config.
    pool: MySqlPool,
    /// Pools created on demand when the user targets a different database.
    ///
    /// MySQL cannot change database on an open connection: `USE` is rejected by
    /// the prepared-statement protocol (error 1295). Giving every database its
    /// own pool is both the simplest fix and more correct — it stops one
    /// request's database choice from leaking into another via a shared
    /// pooled connection.
    other_pools: Mutex<HashMap<String, MySqlPool>>,
    config: ConnectionConfig,
    info: ServerInfo,
}

#[async_trait]
impl Connection for MySqlConnection {
    fn driver_id(&self) -> &'static str {
        "mysql"
    }

    fn server_info(&self) -> &ServerInfo {
        &self.info
    }

    fn capabilities(&self) -> DriverCapabilities {
        capabilities()
    }

    fn dialect(&self) -> Dialect {
        Dialect::MySql
    }

    async fn ping(&self) -> Result<()> {
        sqlx::query("SELECT 1")
            .execute(&self.pool)
            .await
            .map(|_| ())
            .map_err(|e| DriverError::Connect(e.to_string()))
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        let rows = sqlx::query("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME")
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DriverError::Introspect(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|row| {
                let name: String = row.try_get("SCHEMA_NAME").unwrap_or_default();
                let is_system = matches!(
                    name.as_str(),
                    "information_schema" | "mysql" | "performance_schema" | "sys"
                );
                DatabaseInfo { name, is_system }
            })
            .collect())
    }

    async fn list_namespaces(&self, _database: &str) -> Result<Vec<NamespaceInfo>> {
        // MySQL has no separate schema layer; database == schema.
        Ok(vec![])
    }

    async fn list_objects(
        &self,
        database: &str,
        _namespace: Option<&str>,
    ) -> Result<Vec<DatabaseObject>> {
        let rows = sqlx::query(
            "SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT, TABLE_ROWS \
             FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
        )
        .bind(database)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DriverError::Introspect(e.to_string()))?;

        let mut objects: Vec<DatabaseObject> = rows
            .into_iter()
            .map(|row| {
                let name: String = row.try_get("TABLE_NAME").unwrap_or_default();
                let table_type: String = row.try_get("TABLE_TYPE").unwrap_or_default();
                let comment: Option<String> = row.try_get("TABLE_COMMENT").ok();
                let row_estimate: Option<u64> = row.try_get("TABLE_ROWS").ok();
                DatabaseObject {
                    name,
                    kind: object_kind_from_marker(&table_type),
                    schema: Some(database.to_string()),
                    comment: comment.filter(|c| !c.is_empty()),
                    row_estimate,
                }
            })
            .collect();

        // Triggers, stored routines and scheduled events do not appear in
        // `information_schema.TABLES`, so they are collected in one extra pass.
        let extra = sqlx::query(
            "SELECT TRIGGER_NAME AS object_name, 'TRIGGER' AS object_type \
             FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? \
             UNION ALL SELECT ROUTINE_NAME, ROUTINE_TYPE \
             FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? \
             UNION ALL SELECT EVENT_NAME, 'EVENT' \
             FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? \
             ORDER BY object_name",
        )
        .bind(database)
        .bind(database)
        .bind(database)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DriverError::Introspect(e.to_string()))?;

        objects.extend(extra.into_iter().map(|row| {
            let name: String = row.try_get("object_name").unwrap_or_default();
            let object_type: String = row.try_get("object_type").unwrap_or_default();
            DatabaseObject {
                name,
                kind: object_kind_from_marker(&object_type),
                schema: Some(database.to_string()),
                comment: None,
                row_estimate: None,
            }
        }));

        Ok(objects)
    }

    async fn describe_object(
        &self,
        database: &str,
        _namespace: Option<&str>,
        object: &str,
    ) -> Result<ObjectSchema> {
        let kind = self.object_kind(database, object).await?;

        let column_rows = sqlx::query(
            "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, \
             COLUMN_COMMENT, ORDINAL_POSITION FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
        )
        .bind(database)
        .bind(object)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DriverError::Introspect(e.to_string()))?;

        let columns: Vec<ColumnSchema> = column_rows
            .into_iter()
            .map(|row| {
                let is_nullable: String = row.try_get("IS_NULLABLE").unwrap_or_else(|_| "YES".into());
                let extra: String = row.try_get("EXTRA").unwrap_or_default();
                let key: String = row.try_get("COLUMN_KEY").unwrap_or_default();
                let comment: Option<String> = row.try_get("COLUMN_COMMENT").ok();
                ColumnSchema {
                    name: row.try_get("COLUMN_NAME").unwrap_or_default(),
                    data_type: row.try_get("COLUMN_TYPE").unwrap_or_default(),
                    nullable: is_nullable.eq_ignore_ascii_case("YES"),
                    default_value: row.try_get("COLUMN_DEFAULT").ok(),
                    is_primary_key: key == "PRI",
                    is_auto_increment: extra.to_ascii_lowercase().contains("auto_increment"),
                    comment: comment.filter(|c| !c.is_empty()),
                    ordinal: row.try_get::<i64, _>("ORDINAL_POSITION").unwrap_or(0) as u32,
                }
            })
            .collect();

        let index_rows = sqlx::query(
            "SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX",
        )
        .bind(database)
        .bind(object)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DriverError::Introspect(e.to_string()))?;

        let mut indexes: Vec<IndexSchema> = Vec::new();
        for row in index_rows {
            let name: String = row.try_get("INDEX_NAME").unwrap_or_default();
            let column: String = row.try_get("COLUMN_NAME").unwrap_or_default();
            let non_unique: i64 = row.try_get("NON_UNIQUE").unwrap_or(0);
            match indexes.iter_mut().find(|i| i.name == name) {
                Some(existing) => existing.columns.push(column),
                None => indexes.push(IndexSchema {
                    primary: name == "PRIMARY",
                    name,
                    columns: vec![column],
                    unique: non_unique == 0,
                }),
            }
        }

        let fk_rows = sqlx::query(
            "SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME \
             FROM information_schema.KEY_COLUMN_USAGE \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL \
             ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION",
        )
        .bind(database)
        .bind(object)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DriverError::Introspect(e.to_string()))?;

        let mut foreign_keys: Vec<ForeignKeySchema> = Vec::new();
        for row in fk_rows {
            let name: String = row.try_get("CONSTRAINT_NAME").unwrap_or_default();
            let column: String = row.try_get("COLUMN_NAME").unwrap_or_default();
            let ref_table: String = row.try_get("REFERENCED_TABLE_NAME").unwrap_or_default();
            let ref_column: String = row.try_get("REFERENCED_COLUMN_NAME").unwrap_or_default();
            match foreign_keys.iter_mut().find(|f| f.name == name) {
                Some(existing) => {
                    existing.columns.push(column);
                    existing.referenced_columns.push(ref_column);
                }
                None => foreign_keys.push(ForeignKeySchema {
                    name,
                    columns: vec![column],
                    referenced_table: ref_table,
                    referenced_columns: vec![ref_column],
                }),
            }
        }

        Ok(build_object_schema(object, kind, columns, indexes, foreign_keys))
    }

    /// One query instead of N: the whole schema's columns at once.
    async fn list_table_columns(
        &self,
        database: &str,
        _namespace: Option<&str>,
    ) -> Result<Vec<TableColumns>> {
        let rows = sqlx::query(
            "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION",
        )
        .bind(database)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DriverError::Introspect(e.to_string()))?;

        let mut out: Vec<TableColumns> = Vec::new();
        for row in rows {
            let table: String = row.try_get("TABLE_NAME").unwrap_or_default();
            let column = ColumnMeta {
                name: row.try_get("COLUMN_NAME").unwrap_or_default(),
                data_type: row.try_get("DATA_TYPE").ok(),
            };
            match out.last_mut() {
                Some(entry) if entry.table == table => entry.columns.push(column),
                _ => out.push(TableColumns {
                    table,
                    schema: Some(database.to_string()),
                    columns: vec![column],
                }),
            }
        }
        Ok(out)
    }

    async fn execute(&self, request: QueryRequest) -> Result<QueryResponse> {
        self.execute_cancellable(request, CancellationToken::new()).await
    }

    async fn execute_cancellable(
        &self,
        request: QueryRequest,
        cancel: CancellationToken,
    ) -> Result<QueryResponse> {
        let max_rows = request.max_rows.unwrap_or(1000).max(1) as usize;
        let statements = split_statements(&request.sql);
        if statements.is_empty() {
            return Err(DriverError::Query("no statement to execute".into()));
        }

        let started = Instant::now();
        // Pick the pool bound to the requested database; no `USE` needed.
        let pool = self.pool_for(request.database.as_deref()).await?;
        let mut conn = pool
            .acquire()
            .await
            .map_err(|e| DriverError::Connect(e.to_string()))?;

        // Capture this connection's server-side id so another connection in the
        // same pool can `KILL QUERY` it. sqlx 0.8 exposes no public cancel API,
        // and the kill must come from a *different* connection because this one
        // is busy for the duration of the statement.
        let pid: Option<u64> = sqlx::query("SELECT CONNECTION_ID() AS `id`")
            .fetch_one(&mut *conn)
            .await
            .ok()
            .and_then(|row| row.try_get::<u64, _>("id").ok());

        let watcher = pid.map(|pid| {
            let pool = pool.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move {
                cancel.cancelled().await;
                if let Ok(mut killer) = pool.acquire().await {
                    // Best effort: without the PROCESS privilege this errors and
                    // the connection is simply not interrupted.
                    let _ = sqlx::query(&format!("KILL QUERY {pid}"))
                        .execute(&mut *killer)
                        .await;
                }
            })
        });

        let mut results = Vec::with_capacity(statements.len());
        for statement in &statements {
            if cancel.is_cancelled() {
                break;
            }
            results.push(run_statement(&mut *conn, statement, max_rows).await);
        }
        drop(conn);
        if let Some(watcher) = watcher {
            watcher.abort();
        }

        if cancel.is_cancelled() {
            return Err(DriverError::Cancelled("query interrupted".into()));
        }

        Ok(QueryResponse {
            results,
            total_ms: started.elapsed().as_millis() as u64,
        })
    }
}

impl MySqlConnection {
    /// Resolve the pool for a target database, creating and caching one on
    /// first use. `None`/empty falls back to the configured database.
    async fn pool_for(&self, database: Option<&str>) -> Result<MySqlPool> {
        let Some(database) = database.filter(|name| !name.is_empty()) else {
            return Ok(self.pool.clone());
        };
        if self.config.database.as_deref() == Some(database) {
            return Ok(self.pool.clone());
        }

        if let Some(existing) = self.other_pools.lock().unwrap().get(database).cloned() {
            return Ok(existing);
        }

        // Build the pool without holding the lock across the await.
        let mut config = self.config.clone();
        config.database = Some(database.to_string());
        let pool = pool_for(&config, 5).await?;

        let mut pools = self.other_pools.lock().unwrap();
        Ok(pools
            .entry(database.to_string())
            .or_insert(pool)
            .clone())
    }

    async fn object_kind(&self, database: &str, object: &str) -> Result<ObjectKind> {
        let table_type: Option<String> = sqlx::query(
            "SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
        )
        .bind(database)
        .bind(object)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| DriverError::Introspect(e.to_string()))?
        .and_then(|row| row.try_get("TABLE_TYPE").ok());
        Ok(match table_type {
            Some(t) if t.eq_ignore_ascii_case("VIEW") => ObjectKind::View,
            Some(_) => ObjectKind::Table,
            None => ObjectKind::Other,
        })
    }
}

async fn run_statement(conn: &mut sqlx::mysql::MySqlConnection, sql: &str, max_rows: usize) -> StatementResult {
    let started = Instant::now();
    let mut result = StatementResult {
        statement: sql.to_string(),
        is_query: false,
        columns: vec![],
        rows: vec![],
        row_count: 0,
        affected_rows: None,
        last_insert_id: None,
        execution_ms: 0,
        truncated: false,
        error: None,
    };

    match conn.describe(sql).await {
        Ok(described) => {
            let columns: Vec<ColumnMeta> = described
                .columns()
                .iter()
                .map(|c| ColumnMeta {
                    name: c.name().to_string(),
                    data_type: Some(c.type_info().name().to_string()),
                })
                .collect();

            if columns.is_empty() {
                // Statement with no result set (INSERT/UPDATE/DDL/...).
                match sqlx::query(sql).execute(&mut *conn).await {
                    Ok(res) => {
                        result.affected_rows = Some(res.rows_affected());
                        result.last_insert_id = Some(res.last_insert_id());
                    }
                    Err(e) => result.error = Some(e.to_string()),
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
                    Err(e) => result.error = Some(e.to_string()),
                }
            }
        }
        Err(error) => {
            // MySQL cannot prepare everything — `SET`, `LOCK TABLES` and some
            // DDL answer error 1295, and sqlx only speaks the prepared
            // protocol. Say what is actually going on instead of leaking a bare
            // server error.
            let message = error.to_string();
            result.error = Some(if message.contains("1295") {
                format!(
                    "MySQL cannot run this statement through the prepared-statement \
                     protocol (error 1295). Commands such as SET, LOCK TABLES and \
                     USE are not supported yet.\n\n{message}"
                )
            } else {
                message
            });
        }
    }

    result.execution_ms = started.elapsed().as_millis() as u64;
    result
}

async fn stream_rows(
    conn: &mut sqlx::mysql::MySqlConnection,
    sql: &str,
    max_rows: usize,
) -> Result<(Vec<Vec<Value>>, bool)> {
    let mut rows: Vec<Vec<Value>> = Vec::new();
    let mut truncated = false;
    let mut stream = sqlx::query(sql).fetch(&mut *conn);
    while let Some(row) = stream
        .try_next()
        .await
        .map_err(|e| DriverError::Query(e.to_string()))?
    {
        if rows.len() >= max_rows {
            truncated = true;
            break;
        }
        rows.push(decode_row(&row));
    }
    Ok((rows, truncated))
}

fn decode_row(row: &MySqlRow) -> Vec<Value> {
    (0..row.len()).map(|idx| decode_cell(row, idx)).collect()
}

/// Decode a single MySQL cell into JSON, preserving precision and nullability.
fn decode_cell(row: &MySqlRow, idx: usize) -> Value {
    let raw = match row.try_get_raw(idx) {
        Ok(raw) => raw,
        Err(_) => return Value::Null,
    };
    if raw.is_null() {
        return Value::Null;
    }

    let name = row.column(idx).type_info().name().to_ascii_uppercase();
    let unsigned = name.contains("UNSIGNED");

    if name.contains("BIGINT") {
        if unsigned {
            if let Ok(v) = row.try_get::<u64, _>(idx) {
                return json!(v);
            }
        }
        if let Ok(v) = row.try_get::<i64, _>(idx) {
            return json!(v);
        }
    } else if name.contains("INT") || name.contains("YEAR") {
        if unsigned {
            if let Ok(v) = row.try_get::<u64, _>(idx) {
                return json!(v);
            }
        }
        if let Ok(v) = row.try_get::<i64, _>(idx) {
            return json!(v);
        }
    } else if name.contains("FLOAT") || name.contains("DOUBLE") || name.contains("REAL") {
        if let Ok(v) = row.try_get::<f64, _>(idx) {
            return json!(v);
        }
    } else if name.contains("DECIMAL") || name.contains("NUMERIC") {
        if let Ok(v) = row.try_get::<BigDecimal, _>(idx) {
            return Value::String(v.to_string());
        }
    } else if name.contains("DATETIME") || name.contains("TIMESTAMP") {
        if let Ok(v) = row.try_get::<NaiveDateTime, _>(idx) {
            return Value::String(v.to_string());
        }
        if let Ok(v) = row.try_get::<String, _>(idx) {
            return Value::String(v);
        }
    } else if name.contains("DATE") {
        if let Ok(v) = row.try_get::<NaiveDate, _>(idx) {
            return Value::String(v.to_string());
        }
    } else if name.contains("TIME") {
        if let Ok(v) = row.try_get::<NaiveTime, _>(idx) {
            return Value::String(v.to_string());
        }
    } else if name.contains("BIT") {
        if let Ok(v) = row.try_get::<u64, _>(idx) {
            return json!(v);
        }
        if let Ok(v) = row.try_get::<Vec<u8>, _>(idx) {
            return Value::String(format!("0x{}", hex(&v)));
        }
    } else if name.contains("BLOB") || name.contains("BINARY") || name.contains("GEOMETRY") {
        if let Ok(v) = row.try_get::<Vec<u8>, _>(idx) {
            return Value::String(format!("base64:{}", BASE64.encode(&v)));
        }
    }

    // Textual fallback for VARCHAR/TEXT/ENUM/SET/JSON and anything unmapped.
    if let Ok(v) = row.try_get::<String, _>(idx) {
        return Value::String(v);
    }
    if let Ok(v) = row.try_get::<Vec<u8>, _>(idx) {
        return match String::from_utf8(v.clone()) {
            Ok(s) => Value::String(s),
            Err(_) => Value::String(format!("base64:{}", BASE64.encode(&v))),
        };
    }
    Value::Null
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}

#[cfg(test)]
mod integration {
    use super::*;

    /// Builds a connection config from the environment so a real server can be
    /// exercised without committing credentials. Run with:
    ///
    /// ```text
    /// QUARRY_TEST_MYSQL_HOST=127.0.0.1 QUARRY_TEST_MYSQL_USER=root \
    /// QUARRY_TEST_MYSQL_PASSWORD=secret cargo test -- --ignored
    /// ```
    fn env(name: &str) -> Option<String> {
        std::env::var(name).ok().filter(|value| !value.is_empty())
    }

    fn config() -> Option<ConnectionConfig> {
        Some(ConnectionConfig {
            driver: "mysql".into(),
            host: env("QUARRY_TEST_MYSQL_HOST")?,
            port: env("QUARRY_TEST_MYSQL_PORT")
                .and_then(|value| value.parse().ok())
                .unwrap_or(3306),
            username: env("QUARRY_TEST_MYSQL_USER").unwrap_or_else(|| "root".into()),
            password: env("QUARRY_TEST_MYSQL_PASSWORD"),
            database: env("QUARRY_TEST_MYSQL_DATABASE"),
            ssl_mode: SslMode::Preferred,
            options: Default::default(),
        })
    }

    #[tokio::test]
    #[ignore = "needs a reachable MySQL server (see module docs)"]
    async fn connects_introspects_and_queries() {
        let Some(config) = config() else {
            eprintln!("skipping: QUARRY_TEST_MYSQL_HOST is not set");
            return;
        };

        let driver = MySqlDriver::new();
        let info = driver.test(&config).await.expect("server info");
        assert!(info.version.is_some(), "version should be reported");

        let connection = driver.connect(&config).await.expect("connect");
        let databases = connection.list_databases().await.expect("list databases");
        assert!(!databases.is_empty());

        let database = config
            .database
            .clone()
            .or_else(|| info.current_database.clone())
            .unwrap_or_else(|| databases[0].name.clone());

        let objects = connection.list_objects(&database, None).await.expect("list objects");
        if let Some(table) = objects.iter().find(|o| o.kind == ObjectKind::Table) {
            let schema = connection
                .describe_object(&database, None, &table.name)
                .await
                .expect("describe object");
            assert!(!schema.columns.is_empty(), "table should expose columns");
        }

        let response = connection
            .execute(QueryRequest {
                database: Some(database),
                sql: "SELECT 1 AS `one`, NULL AS `nothing`, NOW() AS `now`".into(),
                max_rows: Some(10),
                timeout_ms: None,
                run_id: None,
            })
            .await
            .expect("execute");
        let first = &response.results[0];
        assert!(first.error.is_none(), "unexpected error: {:?}", first.error);
        assert_eq!(first.row_count, 1);
    }

    /// Regression: targeting another database used to emit `USE`, which MySQL
    /// rejects with error 1295 under the prepared-statement protocol. Databases
    /// are now handled by giving each one its own pool.
    #[tokio::test]
    #[ignore = "needs a reachable MySQL server (see module docs)"]
    async fn queries_another_database() {
        let Some(config) = config() else {
            eprintln!("skipping: QUARRY_TEST_MYSQL_HOST is not set");
            return;
        };

        let driver = MySqlDriver::new();
        let connection = driver.connect(&config).await.expect("connect");
        let databases = connection.list_databases().await.expect("list databases");
        let current = connection.server_info().current_database.clone();

        let Some(other) = databases
            .iter()
            .find(|entry| Some(entry.name.as_str()) != current.as_deref())
        else {
            eprintln!("skipping: the server exposes a single database");
            return;
        };

        let response = connection
            .execute(QueryRequest {
                database: Some(other.name.clone()),
                sql: "SELECT 1 AS `one`".into(),
                max_rows: Some(10),
                timeout_ms: None,
                run_id: None,
            })
            .await
            .expect("execute against another database");
        let first = &response.results[0];
        assert!(
            first.error.is_none(),
            "querying `{}` failed: {:?}",
            other.name,
            first.error
        );
        assert_eq!(first.row_count, 1);
    }
}
