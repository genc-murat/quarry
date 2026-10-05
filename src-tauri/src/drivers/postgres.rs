//! PostgreSQL driver.
//!
//! Proves the abstraction: it speaks the exact same [`DatabaseDriver`] /
//! [`Connection`] contract as MySQL, so the frontend renders it with zero
//! driver-specific code. Differences are expressed purely through
//! capabilities (schemas, multiple databases) and the config schema.

use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use futures_util::TryStreamExt;
use serde_json::{json, Value};
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgRow, PgSslMode};
use sqlx::types::chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use sqlx::types::{BigDecimal, Uuid};
use sqlx::{Column, Executor, Row, TypeInfo, ValueRef};
use tokio_util::sync::CancellationToken;

use super::{build_object_schema, object_kind_from_marker, relational_actions, Connection, DatabaseDriver};
use crate::ddl::Dialect;
use crate::error::{DriverError, Result};
use crate::models::{
    ColumnMeta, ColumnSchema, ConfigField, ConnectionConfig, DatabaseInfo, DatabaseObject,
    DriverCapabilities, FieldType, ForeignKeySchema, IndexSchema, NamespaceInfo, ObjectAction,
    ObjectKind, ObjectSchema, QueryLanguage, QueryRequest, QueryResponse, ResultShape, SelectOption,
    ServerInfo, SslMode, StatementResult, TableColumns,
};
use crate::sql_split::split_statements;

const ACCENT: &str = "#3B82F6";

pub struct PostgresDriver;

impl PostgresDriver {
    pub fn new() -> Self {
        PostgresDriver
    }
}

impl Default for PostgresDriver {
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
        supports_schemas: true,
        supports_transactions: true,
        supports_ddl: true,
        supports_explain: true,
        supports_cancel: true,
        object_kinds: vec![
            ObjectKind::Table,
            ObjectKind::View,
            ObjectKind::MaterializedView,
            ObjectKind::Sequence,
        ],
        supported_actions: {
            let mut actions = relational_actions();
            actions.push(ObjectAction::Reindex);
            actions
        },
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
            placeholder: Some("5432".into()),
            required: true,
            default_value: Some(json!(5432)),
            options: vec![],
            help: None,
        },
        ConfigField {
            key: "username".into(),
            label: "Username".into(),
            field_type: FieldType::Text,
            placeholder: Some("postgres".into()),
            required: true,
            default_value: Some(json!("postgres")),
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
            placeholder: Some("postgres".into()),
            required: true,
            default_value: Some(json!("postgres")),
            options: vec![],
            help: None,
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
                    label: "Disabled".into(),
                },
            ],
            help: None,
        },
    ]
}

fn map_ssl_mode(mode: SslMode) -> PgSslMode {
    match mode {
        SslMode::Disabled => PgSslMode::Disable,
        SslMode::Preferred => PgSslMode::Prefer,
        SslMode::Required => PgSslMode::Require,
    }
}

fn build_options(config: &ConnectionConfig) -> PgConnectOptions {
    let mut options = PgConnectOptions::new()
        .host(config.host.as_str())
        .port(config.port)
        .username(config.username.as_str())
        .ssl_mode(map_ssl_mode(config.ssl_mode));
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

async fn pool_for(config: &ConnectionConfig, max_connections: u32) -> Result<PgPool> {
    PgPoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(Duration::from_secs(20))
        .connect_with(build_options(config))
        .await
        .map_err(|e| DriverError::Connect(e.to_string()))
}

#[async_trait]
impl DatabaseDriver for PostgresDriver {
    fn id(&self) -> &'static str {
        "postgres"
    }

    fn display_name(&self) -> &'static str {
        "PostgreSQL"
    }

    fn default_port(&self) -> u16 {
        5432
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
        Ok(Arc::new(PostgresConnection { pool, info }))
    }
}

fn parse_pg_version(version: &str) -> Option<String> {
    // "PostgreSQL 15.3 on x86_64-pc-linux-gnu, ..." -> "15.3"
    let rest = version.strip_prefix("PostgreSQL ")?;
    let number: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    if number.is_empty() {
        None
    } else {
        Some(number)
    }
}

async fn fetch_server_info(pool: &PgPool) -> Result<ServerInfo> {
    // `current_usr` avoids depending on how each server treats reserved words
    // such as `current_user` when used as a column alias.
    let row = sqlx::query(
        "SELECT version() AS version, current_database() AS current_db, current_user AS current_usr",
    )
        .fetch_one(pool)
        .await
        .map_err(|e| DriverError::Connect(e.to_string()))?;

    let version: Option<String> = row.try_get("version").ok();
    let version_number = version
        .as_deref()
        .and_then(parse_pg_version)
        .and_then(|v| {
            let major: u64 = v.split('.').next()?.parse().ok()?;
            Some(major)
        });
    let supports_tls = sqlx::query("SHOW ssl")
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .and_then(|row| row.try_get::<String, _>("ssl").ok())
        .map(|value| value.eq_ignore_ascii_case("on"))
        .unwrap_or(false);

    Ok(ServerInfo {
        version,
        version_number,
        server_comment: None,
        current_database: row.try_get("current_db").ok(),
        current_user: row.try_get("current_usr").ok(),
        supports_tls,
    })
}

pub struct PostgresConnection {
    pool: PgPool,
    info: ServerInfo,
}

#[async_trait]
impl Connection for PostgresConnection {
    fn driver_id(&self) -> &'static str {
        "postgres"
    }

    fn server_info(&self) -> &ServerInfo {
        &self.info
    }

    fn capabilities(&self) -> DriverCapabilities {
        capabilities()
    }

    fn dialect(&self) -> Dialect {
        Dialect::Postgres
    }

    async fn ping(&self) -> Result<()> {
        sqlx::query("SELECT 1")
            .execute(&self.pool)
            .await
            .map(|_| ())
            .map_err(|e| DriverError::Connect(e.to_string()))
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        let rows = sqlx::query(
            "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DriverError::Introspect(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|row| {
                let name: String = row.try_get("datname").unwrap_or_default();
                DatabaseInfo {
                    is_system: name == "postgres",
                    name,
                }
            })
            .collect())
    }

    async fn list_namespaces(&self, _database: &str) -> Result<Vec<NamespaceInfo>> {
        let rows = sqlx::query(
            "SELECT nspname FROM pg_namespace \
             WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' \
             ORDER BY nspname",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DriverError::Introspect(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|row| NamespaceInfo {
                name: row.try_get("nspname").unwrap_or_default(),
            })
            .collect())
    }

    async fn list_objects(
        &self,
        _database: &str,
        namespace: Option<&str>,
    ) -> Result<Vec<DatabaseObject>> {
        let schema = namespace.unwrap_or("public");
        let rows = sqlx::query(
            "SELECT table_name, table_type FROM information_schema.tables \
             WHERE table_schema = $1 ORDER BY table_name",
        )
        .bind(schema)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DriverError::Introspect(e.to_string()))?;

        let mut objects: Vec<DatabaseObject> = rows
            .into_iter()
            .map(|row| {
                let name: String = row.try_get("table_name").unwrap_or_default();
                let table_type: String = row.try_get("table_type").unwrap_or_default();
                DatabaseObject {
                    name,
                    kind: object_kind_from_marker(&table_type),
                    schema: Some(schema.to_string()),
                    comment: None,
                    row_estimate: None,
                }
            })
            .collect();

        // Sequences, functions/procedures and user triggers are not part of
        // `information_schema.tables`, so they are collected in one extra pass.
        let extra = sqlx::query(
            "SELECT sequence_name AS object_name, 'SEQUENCE' AS object_type \
             FROM information_schema.sequences WHERE sequence_schema = $1 \
             UNION ALL SELECT routine_name, routine_type \
             FROM information_schema.routines WHERE routine_schema = $1 \
             UNION ALL SELECT t.tgname, 'TRIGGER' \
             FROM pg_catalog.pg_trigger t \
             JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE NOT t.tgisinternal AND n.nspname = $1 \
             UNION ALL SELECT matviewname, 'MATERIALIZED VIEW' \
             FROM pg_catalog.pg_matviews WHERE schemaname = $1 \
             ORDER BY object_name",
        )
        .bind(schema)
        .bind(schema)
        .bind(schema)
        .bind(schema)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DriverError::Introspect(e.to_string()))?;

        objects.extend(extra.into_iter().map(|row| {
            let name: String = row.try_get("object_name").unwrap_or_default();
            let object_type: String = row.try_get("object_type").unwrap_or_default();
            DatabaseObject {
                name,
                kind: object_kind_from_marker(&object_type),
                schema: Some(schema.to_string()),
                comment: None,
                row_estimate: None,
            }
        }));

        Ok(objects)
    }

    async fn describe_object(
        &self,
        _database: &str,
        namespace: Option<&str>,
        object: &str,
    ) -> Result<ObjectSchema> {
        let schema = namespace.unwrap_or("public");
        let kind = self.object_kind(schema, object).await?;

        let column_rows = sqlx::query(
            "SELECT column_name, data_type, is_nullable, column_default, ordinal_position \
             FROM information_schema.columns \
             WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
        )
        .bind(schema)
        .bind(object)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DriverError::Introspect(e.to_string()))?;

        let mut columns: Vec<ColumnSchema> = column_rows
            .into_iter()
            .map(|row| {
                let is_nullable: String = row.try_get("is_nullable").unwrap_or_else(|_| "YES".into());
                let default_value: Option<String> = row.try_get("column_default").ok();
                ColumnSchema {
                    name: row.try_get("column_name").unwrap_or_default(),
                    data_type: row.try_get("data_type").unwrap_or_default(),
                    nullable: is_nullable.eq_ignore_ascii_case("YES"),
                    is_primary_key: false,
                    is_auto_increment: default_value
                        .as_deref()
                        .map(|d| d.contains("nextval("))
                        .unwrap_or(false),
                    default_value,
                    comment: None,
                    ordinal: row.try_get::<i32, _>("ordinal_position").unwrap_or(0) as u32,
                }
            })
            .collect();

        let index_rows = sqlx::query(
            "SELECT i.relname AS index_name, a.attname AS column_name, \
                    ix.indisunique AS is_unique, ix.indisprimary AS is_primary \
             FROM pg_index ix \
             JOIN pg_class i ON i.oid = ix.indexrelid \
             JOIN pg_class t ON t.oid = ix.indrelid \
             JOIN pg_namespace n ON n.oid = t.relnamespace \
             JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true \
             JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum \
             WHERE n.nspname = $1 AND t.relname = $2 \
             ORDER BY i.relname, k.ord",
        )
        .bind(schema)
        .bind(object)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DriverError::Introspect(e.to_string()))?;

        let mut indexes: Vec<IndexSchema> = Vec::new();
        let mut primary_columns: Vec<String> = Vec::new();
        for row in index_rows {
            let name: String = row.try_get("index_name").unwrap_or_default();
            let column: String = row.try_get("column_name").unwrap_or_default();
            let unique: bool = row.try_get("is_unique").unwrap_or(false);
            let primary: bool = row.try_get("is_primary").unwrap_or(false);
            if primary && !primary_columns.contains(&column) {
                primary_columns.push(column.clone());
            }
            match indexes.iter_mut().find(|i| i.name == name) {
                Some(existing) => existing.columns.push(column),
                None => indexes.push(IndexSchema {
                    name,
                    columns: vec![column],
                    unique,
                    primary,
                }),
            }
        }
        for column in columns.iter_mut() {
            if primary_columns.contains(&column.name) {
                column.is_primary_key = true;
            }
        }

        let fk_rows = sqlx::query(
            "SELECT tc.constraint_name, kcu.column_name, \
                    ccu.table_name AS referenced_table, ccu.column_name AS referenced_column \
             FROM information_schema.table_constraints tc \
             JOIN information_schema.key_column_usage kcu \
               ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema \
             JOIN information_schema.constraint_column_usage ccu \
               ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema \
             WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2 \
             ORDER BY tc.constraint_name",
        )
        .bind(schema)
        .bind(object)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DriverError::Introspect(e.to_string()))?;

        let mut foreign_keys: Vec<ForeignKeySchema> = Vec::new();
        for row in fk_rows {
            let name: String = row.try_get("constraint_name").unwrap_or_default();
            let column: String = row.try_get("column_name").unwrap_or_default();
            let ref_table: String = row.try_get("referenced_table").unwrap_or_default();
            let ref_column: String = row.try_get("referenced_column").unwrap_or_default();
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
        _database: &str,
        namespace: Option<&str>,
    ) -> Result<Vec<TableColumns>> {
        let schema = namespace.unwrap_or("public");
        let rows = sqlx::query(
            "SELECT table_name, column_name, data_type FROM information_schema.columns \
             WHERE table_schema = $1 ORDER BY table_name, ordinal_position",
        )
        .bind(schema)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DriverError::Introspect(e.to_string()))?;

        let mut out: Vec<TableColumns> = Vec::new();
        for row in rows {
            let table: String = row.try_get("table_name").unwrap_or_default();
            let column = ColumnMeta {
                name: row.try_get("column_name").unwrap_or_default(),
                data_type: row.try_get("data_type").ok(),
            };
            match out.last_mut() {
                Some(entry) if entry.table == table => entry.columns.push(column),
                _ => out.push(TableColumns {
                    table,
                    schema: Some(schema.to_string()),
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

        // A PostgreSQL connection is bound to one database for its lifetime;
        // silently running the query against the *other* database would return
        // plausible but wrong results, so refuse instead.
        if let Some(target) = request.database.as_deref().filter(|name| !name.is_empty()) {
            if let Some(current) = self.info.current_database.as_deref() {
                if current != target {
                    return Err(DriverError::Unsupported(format!(
                        "PostgreSQL cannot switch databases on an open connection. \
                         This session is connected to `{current}`; create a connection \
                         for `{target}` instead."
                    )));
                }
            }
        }

        let started = Instant::now();
        let mut conn = self
            .pool
            .acquire()
            .await
            .map_err(|e| DriverError::Connect(e.to_string()))?;

        // sqlx exposes no public cancel API, so capture this backend's pid and
        // have a separate connection call `pg_cancel_backend` when asked.
        let pid: Option<i32> = sqlx::query("SELECT pg_backend_pid() AS pid")
            .fetch_one(&mut *conn)
            .await
            .ok()
            .and_then(|row| row.try_get::<i32, _>("pid").ok());

        let watcher = pid.map(|pid| {
            let pool = self.pool.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move {
                cancel.cancelled().await;
                if let Ok(mut canceller) = pool.acquire().await {
                    // Best effort: may fail without the right privileges.
                    let _ = sqlx::query("SELECT pg_cancel_backend($1)")
                        .bind(pid)
                        .execute(&mut *canceller)
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

impl PostgresConnection {
    /// Resolve the real object kind so views and materialized views are not
    /// reported as plain tables.
    async fn object_kind(&self, schema: &str, object: &str) -> Result<ObjectKind> {
        let table_type: Option<String> = sqlx::query(
            "SELECT table_type FROM information_schema.tables \
             WHERE table_schema = $1 AND table_name = $2",
        )
        .bind(schema)
        .bind(object)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| DriverError::Introspect(e.to_string()))?
        .and_then(|row| row.try_get("table_type").ok());

        Ok(match table_type.as_deref() {
            Some(t) if t == "VIEW" => ObjectKind::View,
            Some(t) if t == "MATERIALIZED VIEW" => ObjectKind::MaterializedView,
            Some(_) => ObjectKind::Table,
            None => ObjectKind::Other,
        })
    }
}

async fn run_statement(conn: &mut sqlx::postgres::PgConnection, sql: &str, max_rows: usize) -> StatementResult {
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
                match sqlx::query(sql).execute(&mut *conn).await {
                    Ok(res) => result.affected_rows = Some(res.rows_affected()),
                    Err(e) => result.error = Some(e.to_string()),
                }
            } else {
                result.is_query = true;
                result.columns = columns;
                match stream_rows(&mut *conn, sql, max_rows).await {
                    Ok((rows, truncated)) => {
                        result.row_count = rows.len();
                        result.rows = rows;
                        result.truncated = truncated;
                    }
                    Err(e) => result.error = Some(e.to_string()),
                }
            }
        }
        Err(_) => match stream_rows(&mut *conn, sql, max_rows).await {
            Ok((rows, truncated)) => {
                result.row_count = rows.len();
                result.rows = rows;
                result.truncated = truncated;
                result.is_query = !result.rows.is_empty();
            }
            Err(e) => result.error = Some(e.to_string()),
        },
    }

    result.execution_ms = started.elapsed().as_millis() as u64;
    result
}

async fn stream_rows(
    conn: &mut sqlx::postgres::PgConnection,
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

fn decode_row(row: &PgRow) -> Vec<Value> {
    (0..row.len()).map(|idx| decode_cell(row, idx)).collect()
}

fn decode_cell(row: &PgRow, idx: usize) -> Value {
    let raw = match row.try_get_raw(idx) {
        Ok(raw) => raw,
        Err(_) => return Value::Null,
    };
    if raw.is_null() {
        return Value::Null;
    }

    let name = row.column(idx).type_info().name().to_ascii_uppercase();

    if name.ends_with("[]") {
        return decode_array(row, idx, &name);
    }

    match name.as_str() {
        "BOOL" => {
            if let Ok(v) = row.try_get::<bool, _>(idx) {
                return json!(v);
            }
        }
        "INT2" => {
            if let Ok(v) = row.try_get::<i16, _>(idx) {
                return json!(v);
            }
        }
        "INT4" => {
            if let Ok(v) = row.try_get::<i32, _>(idx) {
                return json!(v);
            }
        }
        "INT8" => {
            if let Ok(v) = row.try_get::<i64, _>(idx) {
                return json!(v);
            }
        }
        "FLOAT4" => {
            if let Ok(v) = row.try_get::<f32, _>(idx) {
                return json!(v);
            }
        }
        "FLOAT8" => {
            if let Ok(v) = row.try_get::<f64, _>(idx) {
                return json!(v);
            }
        }
        "NUMERIC" => {
            if let Ok(v) = row.try_get::<BigDecimal, _>(idx) {
                return Value::String(v.to_string());
            }
        }
        "JSON" | "JSONB" => {
            if let Ok(v) = row.try_get::<Value, _>(idx) {
                return v;
            }
        }
        "UUID" => {
            if let Ok(v) = row.try_get::<Uuid, _>(idx) {
                return Value::String(v.to_string());
            }
        }
        "TIMESTAMP" => {
            if let Ok(v) = row.try_get::<NaiveDateTime, _>(idx) {
                return Value::String(v.to_string());
            }
        }
        "TIMESTAMPTZ" => {
            if let Ok(v) = row.try_get::<DateTime<Utc>, _>(idx) {
                return Value::String(v.to_rfc3339());
            }
        }
        "DATE" => {
            if let Ok(v) = row.try_get::<NaiveDate, _>(idx) {
                return Value::String(v.to_string());
            }
        }
        "TIME" => {
            if let Ok(v) = row.try_get::<NaiveTime, _>(idx) {
                return Value::String(v.to_string());
            }
        }
        "BYTEA" => {
            if let Ok(v) = row.try_get::<Vec<u8>, _>(idx) {
                return Value::String(format!("base64:{}", BASE64.encode(&v)));
            }
        }
        _ => {}
    }

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

/// Decode the common PostgreSQL array types into JSON arrays.
fn decode_array(row: &PgRow, idx: usize, name: &str) -> Value {
    let element = name.trim_end_matches("[]");
    match element {
        "INT2" => row
            .try_get::<Vec<i16>, _>(idx)
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        "INT4" => row
            .try_get::<Vec<i32>, _>(idx)
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        "INT8" => row
            .try_get::<Vec<i64>, _>(idx)
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        "BOOL" => row
            .try_get::<Vec<bool>, _>(idx)
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        "FLOAT8" => row
            .try_get::<Vec<f64>, _>(idx)
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        "TEXT" | "VARCHAR" | "BPCHAR" | "NAME" => row
            .try_get::<Vec<String>, _>(idx)
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        _ => row
            .try_get::<Vec<String>, _>(idx)
            .map(|v| json!(v))
            .unwrap_or_else(|_| Value::String(format!("<unsupported array: {name}>"))),
    }
}
