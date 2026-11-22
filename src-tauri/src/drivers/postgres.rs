//! PostgreSQL driver.
//!
//! Proves the abstraction: it speaks the exact same [`DatabaseDriver`] /
//! [`Connection`] contract as MySQL, so the frontend renders it with zero
//! driver-specific code. Differences are expressed purely through
//! capabilities (schemas, multiple databases) and the config schema.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
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

use super::{
    build_object_schema, object_kind_from_marker, relational_actions, Connection, DatabaseDriver,
};
use crate::ddl::Dialect;
use crate::error::{DriverError, Result};
use crate::models::{
    ColumnMeta, ColumnSchema, ConfigField, ConnectionConfig, DatabaseInfo, DatabaseObject,
    DriverCapabilities, FieldType, ForeignKeySchema, IndexSchema, NamespaceInfo, ObjectAction,
    ObjectKind, ObjectSchema, QueryLanguage, QueryRequest, QueryResponse, ResultShape,
    SelectOption, ServerInfo, SslMode, StatementResult, TableColumns,
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

    fn dialect(&self) -> Dialect {
        Dialect::Postgres
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
        Ok(Arc::new(PostgresConnection {
            driver: PostgresDriver::new(),
            pool,
            other_pools: Mutex::new(HashMap::new()),
            config: config.clone(),
            info,
        }))
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
    let version_number = version.as_deref().and_then(parse_pg_version).and_then(|v| {
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
    /// The driver this connection was opened by. [`PostgresDriver`] is a
    /// stateless declaration, so the connection carries it and answers what the
    /// engine says about itself (its id, capabilities, dialect and plan
    /// statement) from here instead of repeating it.
    driver: PostgresDriver,
    /// Pool bound to the database named in the connection config.
    pool: PgPool,
    /// Pools created on demand when the user targets a different database.
    ///
    /// A PostgreSQL session cannot switch databases, and the explorer lists
    /// every database on the server. Each requested database therefore gets its
    /// own pool so its introspection and queries read that database instead of
    /// silently reusing the connection's database.
    other_pools: Mutex<HashMap<String, PgPool>>,
    config: ConnectionConfig,
    info: ServerInfo,
}

#[async_trait]
impl Connection for PostgresConnection {
    fn driver(&self) -> &dyn DatabaseDriver {
        &self.driver
    }

    fn server_info(&self) -> &ServerInfo {
        &self.info
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

    async fn list_namespaces(&self, database: &str) -> Result<Vec<NamespaceInfo>> {
        let pool = self.pool_for(Some(database)).await?;
        let rows = sqlx::query(
            "SELECT nspname FROM pg_namespace \
             WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' \
             ORDER BY nspname",
        )
        .fetch_all(&pool)
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
        database: &str,
        namespace: Option<&str>,
    ) -> Result<Vec<DatabaseObject>> {
        let pool = self.pool_for(Some(database)).await?;
        let schema = namespace.unwrap_or("public");
        let rows = sqlx::query(
            "SELECT table_name, table_type FROM information_schema.tables \
             WHERE table_schema = $1 ORDER BY table_name",
        )
        .bind(schema)
        .fetch_all(&pool)
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
        // All four branches reuse `$1`, so this statement has exactly one
        // parameter. Binding the schema once per textual occurrence supplied
        // four values for a one-parameter statement, which the server rejects.
        .bind(schema)
        .fetch_all(&pool)
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
        database: &str,
        namespace: Option<&str>,
        object: &str,
    ) -> Result<ObjectSchema> {
        let pool = self.pool_for(Some(database)).await?;
        let schema = namespace.unwrap_or("public");
        let kind = self.object_kind(&pool, schema, object).await?;

        // pg_catalog is used instead of information_schema because materialized
        // views are deliberately absent from information_schema while they are
        // first-class objects in the explorer. `format_type` also keeps length
        // and precision modifiers that information_schema splits into columns.
        let column_rows = sqlx::query(
            "SELECT a.attname AS column_name, \
                    pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type, \
                    NOT a.attnotnull AS is_nullable, \
                    CASE WHEN a.attgenerated = '' \
                         THEN pg_catalog.pg_get_expr(d.adbin, d.adrelid) \
                    END AS column_default, \
                    a.attidentity <> '' AS is_identity, \
                    pg_catalog.col_description(a.attrelid, a.attnum) AS column_comment, \
                    a.attnum AS ordinal_position \
             FROM pg_catalog.pg_attribute a \
             JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             LEFT JOIN pg_catalog.pg_attrdef d \
               ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
             WHERE n.nspname = $1 AND c.relname = $2 \
               AND a.attnum > 0 AND NOT a.attisdropped \
               AND c.relkind IN ('r', 'p', 'v', 'm', 'f') \
             ORDER BY a.attnum",
        )
        .bind(schema)
        .bind(object)
        .fetch_all(&pool)
        .await
        .map_err(|e| DriverError::Introspect(e.to_string()))?;

        let mut columns: Vec<ColumnSchema> = column_rows
            .into_iter()
            .map(|row| {
                let is_nullable: bool = row.try_get("is_nullable").unwrap_or(true);
                let is_identity: bool = row.try_get("is_identity").unwrap_or(false);
                let default_value: Option<String> = row.try_get("column_default").ok();
                let comment: Option<String> = row.try_get("column_comment").ok().flatten();
                ColumnSchema {
                    name: row.try_get("column_name").unwrap_or_default(),
                    data_type: row.try_get("data_type").unwrap_or_default(),
                    nullable: is_nullable,
                    is_primary_key: false,
                    // Identity columns (GENERATED ... AS IDENTITY) have no
                    // `nextval(...)` default, so they must be detected through
                    // `attidentity` or a blank key in the grid is inserted as
                    // an explicit NULL instead of letting the server assign it.
                    is_auto_increment: is_identity
                        || default_value
                            .as_deref()
                            .map(|d| d.contains("nextval("))
                            .unwrap_or(false),
                    default_value,
                    comment,
                    ordinal: row.try_get::<i16, _>("ordinal_position").unwrap_or(0) as u32,
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
        .fetch_all(&pool)
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
            "SELECT con.conname AS constraint_name, source_att.attname AS column_name, \
                    referenced.relname AS referenced_table, referenced_att.attname AS referenced_column, \
                    key_position.position AS ordinal_position \
             FROM pg_catalog.pg_constraint con \
             JOIN pg_catalog.pg_class source_table ON source_table.oid = con.conrelid \
             JOIN pg_catalog.pg_namespace source_schema ON source_schema.oid = source_table.relnamespace \
             JOIN pg_catalog.pg_class referenced ON referenced.oid = con.confrelid \
             JOIN LATERAL generate_subscripts(con.conkey, 1) AS key_position(position) ON true \
             JOIN pg_catalog.pg_attribute source_att \
               ON source_att.attrelid = source_table.oid AND source_att.attnum = con.conkey[key_position.position] \
             JOIN pg_catalog.pg_attribute referenced_att \
               ON referenced_att.attrelid = referenced.oid AND referenced_att.attnum = con.confkey[key_position.position] \
             WHERE con.contype = 'f' AND source_schema.nspname = $1 AND source_table.relname = $2 \
             ORDER BY con.conname, key_position.position",
        )
        .bind(schema)
        .bind(object)
        .fetch_all(&pool)
        .await
        .map_err(|e| DriverError::Introspect(e.to_string()))?;

        let mut foreign_key_columns = Vec::with_capacity(fk_rows.len());
        for row in fk_rows {
            let name: String = row.try_get("constraint_name").unwrap_or_default();
            let position: i32 = row.try_get("ordinal_position").unwrap_or(0);
            let column: String = row.try_get("column_name").unwrap_or_default();
            let ref_table: String = row.try_get("referenced_table").unwrap_or_default();
            let ref_column: String = row.try_get("referenced_column").unwrap_or_default();
            foreign_key_columns.push((name, position, column, ref_table, ref_column));
        }
        let foreign_keys = assemble_foreign_key_columns(foreign_key_columns);

        Ok(build_object_schema(
            object,
            kind,
            columns,
            indexes,
            foreign_keys,
        ))
    }

    /// One query instead of N: the whole schema's columns at once.
    async fn list_table_columns(
        &self,
        database: &str,
        namespace: Option<&str>,
    ) -> Result<Vec<TableColumns>> {
        let pool = self.pool_for(Some(database)).await?;
        let schema = namespace.unwrap_or("public");
        // The catalog query includes materialized views, which
        // information_schema.columns omits.
        let rows = sqlx::query(
            "SELECT c.relname AS table_name, a.attname AS column_name, \
                    pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type \
             FROM pg_catalog.pg_attribute a \
             JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND a.attnum > 0 AND NOT a.attisdropped \
               AND c.relkind IN ('r', 'p', 'v', 'm', 'f') \
             ORDER BY c.relname, a.attnum",
        )
        .bind(schema)
        .fetch_all(&pool)
        .await
        .map_err(|e| DriverError::Introspect(e.to_string()))?;

        let mut out: Vec<TableColumns> = Vec::new();
        for row in rows {
            let table: String = row.try_get("table_name").unwrap_or_default();
            let column = ColumnMeta {
                name: row.try_get("column_name").unwrap_or_default(),
                data_type: row.try_get("data_type").ok(),
                compare_as_decimal: false,
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
        self.execute_cancellable(request, CancellationToken::new())
            .await
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
        // A PostgreSQL session cannot switch databases, so a query for another
        // database runs on that database's own pool instead of silently using
        // the connection's database.
        let pool = self.pool_for(request.database.as_deref()).await?;
        let mut conn = pool
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
            let pool = pool.clone();
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
            failed_row: None,
        })
    }

    async fn execute_parameterized(
        &self,
        database: &str,
        sql: &str,
        params: &[Value],
    ) -> Result<QueryResponse> {
        // Values travel as text parameters; the SQL casts each placeholder to
        // the introspected column type, so uuid/jsonb/numeric/arrays parse
        // exactly as a typed bind would.
        let pool = self.pool_for(Some(database)).await?;
        let started = Instant::now();
        let mut query = sqlx::query(sql);
        for value in params {
            query = query.bind(pg_text_parameter(value));
        }
        let done = query
            .execute(&pool)
            .await
            .map_err(|error| DriverError::Query(error.to_string()))?;
        let elapsed = started.elapsed().as_millis() as u64;
        Ok(QueryResponse {
            results: vec![StatementResult {
                statement: sql.to_string(),
                is_query: false,
                columns: vec![],
                rows: vec![],
                row_count: 0,
                affected_rows: Some(done.rows_affected()),
                last_insert_id: None,
                execution_ms: elapsed,
                truncated: false,
                error: None,
            }],
            total_ms: elapsed,
            failed_row: None,
        })
    }
}

impl PostgresConnection {
    /// Resolve the pool for a target database, creating and caching one on
    /// first use. `None`/empty falls back to the configured database.
    async fn pool_for(&self, database: Option<&str>) -> Result<PgPool> {
        let Some(database) = database.filter(|name| !name.is_empty()) else {
            return Ok(self.pool.clone());
        };
        if self.config.database.as_deref() == Some(database)
            || self.info.current_database.as_deref() == Some(database)
        {
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
        Ok(pools.entry(database.to_string()).or_insert(pool).clone())
    }

    /// Resolve the real object kind from the catalog. `information_schema`
    /// omits materialized views and sequences, so `pg_class.relkind` is the
    /// reliable source for every object the explorer lists.
    async fn object_kind(&self, pool: &PgPool, schema: &str, object: &str) -> Result<ObjectKind> {
        let relkind: Option<String> = sqlx::query(
            "SELECT c.relkind::text AS relkind FROM pg_catalog.pg_class c \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relname = $2",
        )
        .bind(schema)
        .bind(object)
        .fetch_optional(pool)
        .await
        .map_err(|e| DriverError::Introspect(e.to_string()))?
        .and_then(|row| row.try_get("relkind").ok());

        Ok(relkind
            .as_deref()
            .map(object_kind_from_relkind)
            .unwrap_or(ObjectKind::Other))
    }
}

/// Map `pg_class.relkind` to the explorer's object kinds. Partitioned and
/// foreign tables keep behaving like tables; sequences stay distinct because
/// they cannot be edited or previewed as rows.
fn object_kind_from_relkind(relkind: &str) -> ObjectKind {
    match relkind {
        "r" | "p" | "f" => ObjectKind::Table,
        "v" => ObjectKind::View,
        "m" => ObjectKind::MaterializedView,
        "S" => ObjectKind::Sequence,
        _ => ObjectKind::Other,
    }
}

fn assemble_foreign_key_columns(
    mut columns: Vec<(String, i32, String, String, String)>,
) -> Vec<ForeignKeySchema> {
    columns.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)));
    let mut foreign_keys: Vec<ForeignKeySchema> = Vec::new();
    for (name, _, column, referenced_table, referenced_column) in columns {
        match foreign_keys.iter_mut().find(|fk| fk.name == name) {
            Some(foreign_key) => {
                foreign_key.columns.push(column);
                foreign_key.referenced_columns.push(referenced_column);
            }
            None => foreign_keys.push(ForeignKeySchema {
                name,
                columns: vec![column],
                referenced_table,
                referenced_columns: vec![referenced_column],
            }),
        }
    }
    foreign_keys
}

#[cfg(test)]
mod foreign_key_tests {
    use super::assemble_foreign_key_columns;

    #[test]
    fn catalog_relkinds_map_to_explorer_kinds() {
        use super::object_kind_from_relkind;
        use crate::models::ObjectKind;

        assert_eq!(object_kind_from_relkind("r"), ObjectKind::Table);
        assert_eq!(object_kind_from_relkind("p"), ObjectKind::Table);
        assert_eq!(object_kind_from_relkind("f"), ObjectKind::Table);
        assert_eq!(object_kind_from_relkind("v"), ObjectKind::View);
        assert_eq!(object_kind_from_relkind("m"), ObjectKind::MaterializedView);
        assert_eq!(object_kind_from_relkind("S"), ObjectKind::Sequence);
        assert_eq!(object_kind_from_relkind("c"), ObjectKind::Other);
    }

    #[test]
    fn composite_foreign_key_columns_keep_catalog_key_order() {
        let foreign_keys = assemble_foreign_key_columns(vec![
            (
                "fk_pair".into(),
                2,
                "source_b".into(),
                "target".into(),
                "target_b".into(),
            ),
            (
                "fk_pair".into(),
                1,
                "source_a".into(),
                "target".into(),
                "target_a".into(),
            ),
            (
                "fk_other".into(),
                1,
                "other_id".into(),
                "other".into(),
                "id".into(),
            ),
        ]);

        assert_eq!(foreign_keys.len(), 2);
        assert_eq!(foreign_keys[0].columns, vec!["other_id"]);
        assert_eq!(foreign_keys[1].columns, vec!["source_a", "source_b"]);
        assert_eq!(
            foreign_keys[1].referenced_columns,
            vec!["target_a", "target_b"]
        );
    }
}

async fn run_statement(
    conn: &mut sqlx::postgres::PgConnection,
    sql: &str,
    max_rows: usize,
) -> StatementResult {
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
                    compare_as_decimal: false,
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

/// PostgreSQL receives every bound value as text; the statement casts it to
/// the column type. `None` binds SQL NULL.
fn pg_text_parameter(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        Value::Bool(value) => Some(value.to_string()),
        Value::Number(number) => Some(number.to_string()),
        Value::Array(_) | Value::Object(_) => Some(value.to_string()),
    }
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
                return super::json_i64(v);
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

/// Decode the common PostgreSQL array types into JSON arrays. Elements are
/// decoded as nullable: `Vec<T>` fails on an array containing NULL, which used
/// to turn the whole column into NULL.
fn decode_array(row: &PgRow, idx: usize, name: &str) -> Value {
    fn nullable<T>(values: Vec<Option<T>>, convert: impl Fn(T) -> Value) -> Value {
        Value::Array(
            values
                .into_iter()
                .map(|value| value.map_or(Value::Null, &convert))
                .collect(),
        )
    }

    let element = name.trim_end_matches("[]");
    match element {
        "INT2" => row
            .try_get::<Vec<Option<i16>>, _>(idx)
            .map(|values| nullable(values, |value| json!(value)))
            .unwrap_or(Value::Null),
        "INT4" => row
            .try_get::<Vec<Option<i32>>, _>(idx)
            .map(|values| nullable(values, |value| json!(value)))
            .unwrap_or(Value::Null),
        "INT8" => row
            .try_get::<Vec<Option<i64>>, _>(idx)
            .map(|values| nullable(values, super::json_i64))
            .unwrap_or(Value::Null),
        "BOOL" => row
            .try_get::<Vec<Option<bool>>, _>(idx)
            .map(|values| nullable(values, |value| json!(value)))
            .unwrap_or(Value::Null),
        "FLOAT8" => row
            .try_get::<Vec<Option<f64>>, _>(idx)
            .map(|values| nullable(values, |value| json!(value)))
            .unwrap_or(Value::Null),
        "TEXT" | "VARCHAR" | "BPCHAR" | "NAME" => row
            .try_get::<Vec<Option<String>>, _>(idx)
            .map(|values| nullable(values, Value::String))
            .unwrap_or(Value::Null),
        _ => row
            .try_get::<Vec<Option<String>>, _>(idx)
            .map(|values| nullable(values, Value::String))
            .unwrap_or_else(|_| Value::String(format!("<unsupported array: {name}>"))),
    }
}

#[cfg(test)]
mod integration {
    use super::*;
    use crate::models::{RowChangeKind, RowChangeRequest, RowValue};

    /// Builds a connection config from the environment so a real server can be
    /// exercised without committing credentials. Run with:
    ///
    /// ```text
    /// QUARRY_TEST_POSTGRES_HOST=127.0.0.1 QUARRY_TEST_POSTGRES_USER=postgres \
    /// QUARRY_TEST_POSTGRES_PASSWORD=secret cargo test -- --ignored
    /// ```
    ///
    /// The second test creates and drops a database, so the role needs
    /// `CREATEDB` and the server must be PostgreSQL 13 or newer.
    fn env(name: &str) -> Option<String> {
        std::env::var(name).ok().filter(|value| !value.is_empty())
    }

    fn config() -> Option<ConnectionConfig> {
        Some(ConnectionConfig {
            driver: "postgres".into(),
            host: env("QUARRY_TEST_POSTGRES_HOST")?,
            port: env("QUARRY_TEST_POSTGRES_PORT")
                .and_then(|value| value.parse().ok())
                .unwrap_or(5432),
            username: env("QUARRY_TEST_POSTGRES_USER").unwrap_or_else(|| "postgres".into()),
            password: env("QUARRY_TEST_POSTGRES_PASSWORD"),
            database: env("QUARRY_TEST_POSTGRES_DATABASE"),
            ssl_mode: SslMode::Preferred,
            options: Default::default(),
        })
    }

    fn unique(prefix: &str) -> String {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after the epoch")
            .as_nanos();
        format!("{prefix}_{}_{nanos}", std::process::id())
    }

    async fn run(connection: &std::sync::Arc<dyn Connection>, database: &str, sql: &str) {
        let response = connection
            .execute(QueryRequest {
                database: Some(database.to_string()),
                sql: sql.to_string(),
                max_rows: Some(100),
                timeout_ms: None,
                run_id: None,
            })
            .await
            .expect("statement should execute");
        for result in &response.results {
            assert!(
                result.error.is_none(),
                "`{}` failed: {:?}",
                result.statement,
                result.error
            );
        }
    }

    #[tokio::test]
    #[ignore = "needs a reachable PostgreSQL server (see module docs)"]
    async fn introspects_identity_materialized_views_and_sequences() {
        let Some(config) = config() else {
            eprintln!("skipping: QUARRY_TEST_POSTGRES_HOST is not set");
            return;
        };

        let driver = PostgresDriver::new();
        let info = driver.test(&config).await.expect("server info");
        let connection = driver.connect(&config).await.expect("connect");
        let database = config
            .database
            .clone()
            .or_else(|| info.current_database.clone())
            .expect("a database to test against");
        let suffix = unique("quarry_it");
        let table = format!("{suffix}_items");
        let sequence = format!("{suffix}_seq");
        let view = format!("{suffix}_view");

        run(
            &connection,
            &database,
            &format!(
                "CREATE TABLE \"{table}\" (\
                   id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, \
                   name text NOT NULL, qty integer, \
                   doubled integer GENERATED ALWAYS AS (qty * 2) STORED); \
                 CREATE SEQUENCE \"{sequence}\"; \
                 INSERT INTO \"{table}\" (name, qty) VALUES ('first', 1); \
                 CREATE MATERIALIZED VIEW \"{view}\" AS \
                   SELECT id, name FROM \"{table}\""
            ),
        )
        .await;

        // This call used to bind four values for a statement with one `$1`,
        // which PostgreSQL rejects before returning any object.
        let objects = connection
            .list_objects(&database, Some("public"))
            .await
            .expect("list objects");
        assert!(objects
            .iter()
            .any(|object| object.name == table && object.kind == ObjectKind::Table));
        assert!(objects
            .iter()
            .any(|object| object.name == sequence && object.kind == ObjectKind::Sequence));
        assert!(objects
            .iter()
            .any(|object| { object.name == view && object.kind == ObjectKind::MaterializedView }));
        assert_eq!(
            objects.iter().filter(|object| object.name == view).count(),
            1,
            "a materialized view must appear once, not in both tables and views"
        );

        let schema = connection
            .describe_object(&database, Some("public"), &table)
            .await
            .expect("describe table");
        let id = schema
            .columns
            .iter()
            .find(|column| column.name == "id")
            .expect("id column");
        assert!(
            id.is_auto_increment,
            "an identity column must be recognised so a blank key is left to the server"
        );
        assert!(id.is_primary_key, "the identity column is the primary key");
        assert_eq!(id.data_type, "bigint");
        let generated = schema
            .columns
            .iter()
            .find(|column| column.name == "doubled")
            .expect("generated column");
        assert!(
            generated.default_value.is_none(),
            "a generation expression must not be reported as a DEFAULT"
        );
        assert!(!generated.is_auto_increment);

        // Materialized views are absent from information_schema, so their kind
        // and columns come from pg_catalog.
        let view_schema = connection
            .describe_object(&database, Some("public"), &view)
            .await
            .expect("describe materialized view");
        assert_eq!(view_schema.kind, ObjectKind::MaterializedView);
        assert_eq!(view_schema.columns.len(), 2);

        let schema_columns = connection
            .list_table_columns(&database, Some("public"))
            .await
            .expect("list table columns");
        let view_columns = schema_columns
            .iter()
            .find(|entry| entry.table == view)
            .expect("materialized view columns in the schema listing");
        assert_eq!(view_columns.columns.len(), 2);

        let inserted = connection
            .apply_row_change(RowChangeRequest {
                connection_id: "integration".into(),
                database: database.clone(),
                namespace: Some("public".into()),
                object: table.clone(),
                kind: RowChangeKind::Insert,
                key: vec![],
                values: vec![RowValue {
                    column: "name".into(),
                    value: serde_json::json!("second"),
                    data_type: Some("text".into()),
                }],
            })
            .await
            .expect("insert row");
        assert!(inserted.results[0].error.is_none());

        let counted = connection
            .execute(QueryRequest {
                database: Some(database.clone()),
                sql: format!("SELECT count(*) AS total FROM \"{table}\""),
                max_rows: Some(1),
                timeout_ms: None,
                run_id: None,
            })
            .await
            .expect("count rows");
        assert_eq!(counted.results[0].rows[0][0], serde_json::json!(2));

        run(
            &connection,
            &database,
            &format!(
                "DROP MATERIALIZED VIEW \"{view}\"; \
                 DROP TABLE \"{table}\"; \
                 DROP SEQUENCE \"{sequence}\""
            ),
        )
        .await;
    }

    #[tokio::test]
    #[ignore = "needs a reachable PostgreSQL server (see module docs)"]
    async fn decodes_common_types_without_losing_values() {
        let Some(config) = config() else {
            eprintln!("skipping: QUARRY_TEST_POSTGRES_HOST is not set");
            return;
        };

        let connection = PostgresDriver::new()
            .connect(&config)
            .await
            .expect("connect");
        let database = connection
            .server_info()
            .current_database
            .clone()
            .expect("current database");
        let response = connection
            .execute(QueryRequest {
                database: Some(database),
                sql: "SELECT \
                        9007199254740993::bigint AS big_int, \
                        ARRAY[9007199254740992::bigint, 1] AS big_array, \
                        12.34::numeric AS amount, \
                        '00000000-0000-0000-0000-000000000001'::uuid AS uuid_value, \
                        TIMESTAMPTZ '2024-01-02 03:04:05+00' AS stamp, \
                        DATE '2024-01-02' AS day, \
                        '{\"a\":1}'::jsonb AS doc, \
                        decode('deadbeef','hex') AS bytes, \
                        true AS flag, \
                        ARRAY[1,2]::integer[] AS ints"
                    .into(),
                max_rows: Some(1),
                timeout_ms: None,
                run_id: None,
            })
            .await
            .expect("select common types");
        let result = &response.results[0];
        assert!(result.error.is_none(), "query failed: {:?}", result.error);
        let row = &result.rows[0];
        assert_eq!(row[0], serde_json::json!("9007199254740993"));
        assert_eq!(row[1], serde_json::json!(["9007199254740992", 1]));
        // NUMERIC keeps its stored scale, so trailing zeros are significant.
        assert!(row[2]
            .as_str()
            .is_some_and(|value| value.starts_with("12.34")));
        assert_eq!(
            row[3],
            serde_json::json!("00000000-0000-0000-0000-000000000001")
        );
        assert!(row[4]
            .as_str()
            .is_some_and(|value| value.starts_with("2024-01-02T03:04:05")));
        assert_eq!(row[5], serde_json::json!("2024-01-02"));
        assert_eq!(row[6], serde_json::json!({ "a": 1 }));
        assert_eq!(row[7], serde_json::json!("base64:3q2+7w=="));
        assert_eq!(row[8], serde_json::json!(true));
        assert_eq!(row[9], serde_json::json!([1, 2]));
    }

    #[tokio::test]
    #[ignore = "needs a reachable PostgreSQL server (see module docs)"]
    async fn row_changes_bind_typed_values_instead_of_interpolating_sql() {
        let Some(config) = config() else {
            eprintln!("skipping: QUARRY_TEST_POSTGRES_HOST is not set");
            return;
        };

        let connection = PostgresDriver::new()
            .connect(&config)
            .await
            .expect("connect");
        let database = connection
            .server_info()
            .current_database
            .clone()
            .expect("current database");
        let table = format!("{}_typed", unique("quarry_it"));
        run(
            &connection,
            &database,
            &format!(
                "CREATE TABLE \"{table}\" (\
                   id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, \
                   name text NOT NULL, qty integer, amount numeric(10,2), \
                   tags text[], doc jsonb, token uuid, payload bytea)"
            ),
        )
        .await;

        // A value that would terminate a plain string literal in a careless
        // builder; it must round-trip as data through the bind.
        let name = "O'Brien \\ \"; DROP TABLE ignored; --";
        let inserted = connection
            .apply_row_change(RowChangeRequest {
                connection_id: "integration".into(),
                database: database.clone(),
                namespace: Some("public".into()),
                object: table.clone(),
                kind: RowChangeKind::Insert,
                key: vec![],
                values: vec![
                    RowValue {
                        column: "name".into(),
                        value: serde_json::json!(name),
                        data_type: Some("text".into()),
                    },
                    RowValue {
                        column: "qty".into(),
                        value: serde_json::json!(7),
                        data_type: Some("integer".into()),
                    },
                    RowValue {
                        column: "amount".into(),
                        value: serde_json::json!(12.34),
                        data_type: Some("numeric(10,2)".into()),
                    },
                    RowValue {
                        column: "tags".into(),
                        value: serde_json::json!(["a,b", "c\"d", "e\\f", null]),
                        data_type: Some("text[]".into()),
                    },
                    RowValue {
                        column: "doc".into(),
                        value: serde_json::json!({ "a": 1, "s": "x" }),
                        data_type: Some("jsonb".into()),
                    },
                    RowValue {
                        column: "token".into(),
                        value: serde_json::json!("00000000-0000-0000-0000-000000000001"),
                        data_type: Some("uuid".into()),
                    },
                    RowValue {
                        column: "payload".into(),
                        value: serde_json::json!("base64:3q2+7w=="),
                        data_type: Some("bytea".into()),
                    },
                ],
            })
            .await
            .expect("insert typed row");
        assert_eq!(inserted.results[0].affected_rows, Some(1));

        let selected = connection
            .execute(QueryRequest {
                database: Some(database.clone()),
                sql: format!(
                    "SELECT id, name, qty, amount, tags, doc, token, \
                            encode(payload, 'base64') AS payload64 \
                     FROM \"{table}\""
                ),
                max_rows: Some(1),
                timeout_ms: None,
                run_id: None,
            })
            .await
            .expect("select typed row");
        let row = &selected.results[0].rows[0];
        assert_eq!(row[1], serde_json::json!(name));
        assert_eq!(row[2], serde_json::json!(7));
        assert!(row[3]
            .as_str()
            .is_some_and(|value| value.starts_with("12.34")));
        assert_eq!(row[4], serde_json::json!(["a,b", "c\"d", "e\\f", null]));
        assert_eq!(row[5], serde_json::json!({ "a": 1, "s": "x" }));
        assert_eq!(
            row[6],
            serde_json::json!("00000000-0000-0000-0000-000000000001")
        );
        assert_eq!(row[7], serde_json::json!("3q2+7w=="));
        let id = row[0].as_i64().expect("a small identity value");

        let updated = connection
            .apply_row_change(RowChangeRequest {
                connection_id: "integration".into(),
                database: database.clone(),
                namespace: Some("public".into()),
                object: table.clone(),
                kind: RowChangeKind::Update,
                key: vec![RowValue {
                    column: "id".into(),
                    value: serde_json::json!(id),
                    data_type: Some("bigint".into()),
                }],
                values: vec![RowValue {
                    column: "name".into(),
                    value: serde_json::json!("renamed"),
                    data_type: Some("text".into()),
                }],
            })
            .await
            .expect("update typed row");
        assert_eq!(updated.results[0].affected_rows, Some(1));

        let deleted = connection
            .apply_row_change(RowChangeRequest {
                connection_id: "integration".into(),
                database: database.clone(),
                namespace: Some("public".into()),
                object: table.clone(),
                kind: RowChangeKind::Delete,
                key: vec![RowValue {
                    column: "id".into(),
                    value: serde_json::json!(id),
                    data_type: Some("bigint".into()),
                }],
                values: vec![],
            })
            .await
            .expect("delete typed row");
        assert_eq!(deleted.results[0].affected_rows, Some(1));

        run(&connection, &database, &format!("DROP TABLE \"{table}\"")).await;
    }

    #[tokio::test]
    #[ignore = "needs a reachable PostgreSQL server (see module docs)"]
    async fn introspection_and_queries_read_the_requested_database() {
        let Some(config) = config() else {
            eprintln!("skipping: QUARRY_TEST_POSTGRES_HOST is not set");
            return;
        };

        let driver = PostgresDriver::new();
        let connection = driver.connect(&config).await.expect("connect");
        let info = connection.server_info().clone();
        let database = config
            .database
            .clone()
            .or_else(|| info.current_database.clone())
            .expect("a database to test against");
        let suffix = unique("quarry_it_db");
        let other = suffix.clone();
        let other_table = format!("{suffix}_only_here");
        let main_table = format!("{suffix}_only_main");

        run(
            &connection,
            &database,
            &format!("CREATE DATABASE \"{other}\""),
        )
        .await;
        run(
            &connection,
            &other,
            &format!("CREATE TABLE \"{other_table}\" (id integer)"),
        )
        .await;
        run(
            &connection,
            &database,
            &format!("CREATE TABLE \"{main_table}\" (id integer)"),
        )
        .await;

        // A PostgreSQL session cannot switch databases, so introspection for
        // another database must use that database's own pool instead of quietly
        // reading the connection's database.
        let other_objects = connection
            .list_objects(&other, Some("public"))
            .await
            .expect("list objects in the other database");
        assert!(other_objects
            .iter()
            .any(|object| object.name == other_table));
        assert!(
            !other_objects.iter().any(|object| object.name == main_table),
            "listing `{other}` must not return objects from `{database}`"
        );

        let described = connection
            .describe_object(&other, Some("public"), &other_table)
            .await
            .expect("describe the other database's table");
        assert_eq!(described.columns.len(), 1);

        let response = connection
            .execute(QueryRequest {
                database: Some(other.clone()),
                sql: "SELECT current_database() AS name".into(),
                max_rows: Some(1),
                timeout_ms: None,
                run_id: None,
            })
            .await
            .expect("query the other database");
        assert_eq!(response.results[0].rows[0][0], serde_json::json!(other));

        run(
            &connection,
            &database,
            &format!("DROP TABLE \"{main_table}\""),
        )
        .await;
        run(
            &connection,
            &database,
            &format!("DROP DATABASE IF EXISTS \"{other}\" WITH (FORCE)"),
        )
        .await;
    }
}
