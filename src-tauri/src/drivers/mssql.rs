//! Microsoft SQL Server driver (TDS, over `tiberius`).
//!
//! Speaks the same [`DatabaseDriver`] / [`Connection`] contract as the other
//! SQL adapters. The engine's own words: identifiers are bracket-quoted
//! ([`Dialect::SqlServer`]), there is no `EXPLAIN`, a statement is cancelled
//! with `KILL` from a second connection, and a session can move between
//! databases — which the adapter follows with one client pool per database,
//! the way the MySQL adapter does with its pools.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use futures_util::TryStreamExt;
use serde_json::{json, Value};
use tiberius::{AuthMethod, Client, Config, EncryptionLevel, Row};
use tokio::net::TcpStream;
use tokio_util::compat::TokioAsyncWriteCompatExt;
use tokio_util::sync::CancellationToken;

use super::{
    build_object_schema, object_kind_from_marker, relational_actions, Connection, DatabaseDriver,
};
use crate::ddl::Dialect;
use crate::error::{DriverError, Result};
use crate::models::{
    ColumnMeta, ColumnSchema, ConfigField, ConnectionConfig, DatabaseInfo, DatabaseObject,
    DriverCapabilities, FieldType, ForeignKeySchema, IndexSchema, NamespaceInfo, ObjectKind,
    ObjectSchema, QueryLanguage, QueryRequest, QueryResponse, ResultShape, SelectOption,
    ServerInfo, SslMode, StatementResult, TableColumns,
};
use crate::sql_split::split_statements;

const ACCENT: &str = "#9A4B99";

/// A client connected through the write-compat wrapper `tiberius` asks for.
type RawClient = Client<tokio_util::compat::Compat<TcpStream>>;

pub struct MssqlDriver;

impl MssqlDriver {
    pub fn new() -> Self {
        MssqlDriver
    }
}

impl Default for MssqlDriver {
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
        // T-SQL has no EXPLAIN statement; `supports_explain: false` is what
        // makes every connection of this driver answer `explain_statement`
        // with `None`.
        supports_explain: false,
        supports_cancel: true,
        object_kinds: vec![
            ObjectKind::Table,
            ObjectKind::View,
            ObjectKind::Sequence,
            ObjectKind::Procedure,
            ObjectKind::Trigger,
        ],
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
            placeholder: Some("1433".into()),
            required: true,
            default_value: Some(json!(1433)),
            options: vec![],
            help: None,
        },
        ConfigField {
            key: "username".into(),
            label: "Username".into(),
            field_type: FieldType::Text,
            placeholder: Some("sa".into()),
            required: true,
            default_value: Some(json!("sa")),
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
            placeholder: Some("master".into()),
            required: false,
            default_value: Some(json!("master")),
            options: vec![],
            help: Some(
                "The database the session opens on; leave empty for the login default.".into(),
            ),
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
            help: Some(
                "Encryption uses the server certificate without validating it, like the SQL Server tooling defaults."
                    .into(),
            ),
        },
    ]
}

fn map_ssl_mode(mode: SslMode) -> EncryptionLevel {
    match mode {
        SslMode::Disabled => EncryptionLevel::NotSupported,
        SslMode::Preferred => EncryptionLevel::On,
        SslMode::Required => EncryptionLevel::Required,
    }
}

/// The connection facts every pool in one session shares. A pool is opened per
/// database (that is the login's database), so only the database differs.
#[derive(Clone)]
struct ConnectionSettings {
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    ssl_mode: SslMode,
}

impl ConnectionSettings {
    fn build_config(&self, database: Option<&str>) -> Config {
        let mut config = Config::new();
        config.host(&self.host);
        config.port(self.port);
        config.authentication(AuthMethod::sql_server(&self.username, self.password.as_deref().unwrap_or_default()));
        if let Some(database) = database.filter(|name| !name.is_empty()) {
            config.database(database);
        }
        config.encryption(map_ssl_mode(self.ssl_mode));
        // SQL Server's own installers ship a self-signed certificate, and the
        // clients that ship with it (SSMS, sqlcmd, Azure Data Studio) encrypt
        // against it without validating — the studio follows that default.
        config.trust_cert();
        config
    }
}

/// Open one client, database included in the login. The 20-second bounds are
/// the same the other adapters give their pools.
async fn open_client(settings: &ConnectionSettings, database: Option<&str>) -> Result<RawClient> {
    let config = settings.build_config(database);
    let addr = config.get_addr();
    let tcp = tokio::time::timeout(Duration::from_secs(20), TcpStream::connect(&addr))
        .await
        .map_err(|_| DriverError::Connect(format!("timed out connecting to {addr}")))?
        .map_err(|e| DriverError::Connect(e.to_string()))?;
    tcp.set_nodelay(true)
        .map_err(|e| DriverError::Connect(e.to_string()))?;
    let connect = Client::connect(config, tcp.compat_write());
    tokio::time::timeout(Duration::from_secs(20), connect)
        .await
        .map_err(|_| DriverError::Connect("timed out during the TDS login".into()))?
        .map_err(|e| DriverError::Connect(e.to_string()))
}

/// How many idle clients one database keeps. A session runs one statement at a
/// time; the second connection a cancel opens is closed again right after.
const MAX_IDLE_CLIENTS: usize = 4;

/// A pool of clients for one database. `tiberius` has no pool of its own, and
/// the borrow a result stream holds rules out wrapping one client in a mutex —
/// so idle clients are parked here and handed out by value.
struct ClientPool {
    settings: Arc<ConnectionSettings>,
    database: Option<String>,
    idle: tokio::sync::Mutex<Vec<RawClient>>,
}

impl ClientPool {
    async fn acquire(self: &Arc<Self>) -> Result<ClientGuard> {
        let parked = self.idle.lock().await.pop();
        let client = match parked {
            Some(client) => client,
            None => open_client(&self.settings, self.database.as_deref()).await?,
        };
        Ok(ClientGuard {
            pool: self.clone(),
            client: Some(client),
            broken: false,
        })
    }
}

/// A client borrowed from a [`ClientPool`]. On drop it returns to the pool —
/// unless it is marked broken, because a stream dropped mid-response or a
/// cancelled request leaves the TDS session mid-message and the only safe
/// course is to close it (the words of `tiberius`' own cancellation notes).
struct ClientGuard {
    pool: Arc<ClientPool>,
    client: Option<RawClient>,
    broken: bool,
}

impl ClientGuard {
    fn client(&mut self) -> &mut RawClient {
        self.client.as_mut().expect("a guard holds its client")
    }
}

impl Drop for ClientGuard {
    fn drop(&mut self) {
        if let (false, Some(client)) = (self.broken, self.client.take()) {
            if let Ok(mut idle) = self.pool.idle.try_lock() {
                if idle.len() < MAX_IDLE_CLIENTS {
                    idle.push(client);
                }
            }
        }
    }
}

/// Parse `@@VERSION` into the dotted build number, e.g. the `15.0.4298.1` of
/// `Microsoft SQL Server 2019 (RTM-CU23 GDR) ... 15.0.4298.1`. The year comes
/// first and carries no dot, so the first dotted token is the build.
fn parse_mssql_version(version: &str) -> Option<String> {
    version
        .split_whitespace()
        .find_map(|token| {
            let parts: Vec<&str> = token.split('.').collect();
            (parts.len() >= 2
                && parts
                    .iter()
                    .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())))
            .then(|| token.to_string())
        })
}

/// Whether a statement's first word names one of the statements whose server
/// reply is a row count rather than rows. tiberius has no describe, so the
/// split decides the call: `execute` for these, `simple_query` for everything
/// else — a wrong guess for `WITH ... DELETE` costs the affected count, not a
/// broken reply.
fn is_dml_statement(sql: &str) -> bool {
    let head = sql
        .trim_start()
        .split(|c: char| !c.is_ascii_alphabetic())
        .find(|word| !word.is_empty())
        .map(|word| word.to_ascii_uppercase())
        .unwrap_or_default();
    matches!(
        head.as_str(),
        "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "CREATE" | "ALTER" | "DROP" | "TRUNCATE"
            | "GRANT" | "REVOKE" | "DENY" | "USE" | "SET"
    )
}

#[async_trait]
impl DatabaseDriver for MssqlDriver {
    fn id(&self) -> &'static str {
        "mssql"
    }

    fn display_name(&self) -> &'static str {
        "SQL Server"
    }

    fn default_port(&self) -> u16 {
        1433
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
        Dialect::SqlServer
    }

    async fn test(&self, config: &ConnectionConfig) -> Result<ServerInfo> {
        let settings = settings_for(config);
        let mut client = open_client(&settings, config.database.as_deref()).await?;
        fetch_server_info(&mut client).await
    }

    async fn connect(&self, config: &ConnectionConfig) -> Result<Arc<dyn Connection>> {
        let settings = settings_for(config);
        let mut client = open_client(&settings, config.database.as_deref()).await?;
        let info = fetch_server_info(&mut client).await?;
        // The pool is keyed by the database the login actually landed on, so
        // `pool_for(None)` finds it even when the profile left the field empty
        // and the server picked its own default.
        let key = info.current_database.clone().unwrap_or_default();
        let pool = Arc::new(ClientPool {
            settings: settings.clone(),
            database: Some(key.clone()).filter(|name| !name.is_empty()),
            idle: tokio::sync::Mutex::new(vec![client]),
        });
        let mut pools = HashMap::new();
        pools.insert(key, pool);
        Ok(Arc::new(MssqlConnection {
            driver: MssqlDriver::new(),
            settings,
            info,
            pools: tokio::sync::Mutex::new(pools),
        }))
    }
}

fn settings_for(config: &ConnectionConfig) -> Arc<ConnectionSettings> {
    Arc::new(ConnectionSettings {
        host: config.host.clone(),
        port: config.port,
        username: config.username.clone(),
        password: config.password.clone(),
        ssl_mode: config.ssl_mode,
    })
}

/// `@@VERSION` is one long banner line; `DB_NAME()` is the login's database.
async fn fetch_server_info(client: &mut RawClient) -> Result<ServerInfo> {
    let row = first_row(
        client,
        "SELECT @@VERSION AS version, DB_NAME() AS current_db, \
         SUSER_SNAME() AS current_login",
    )
    .await?
    .ok_or_else(|| DriverError::Connect("the server answered no server info".into()))?;

    let version: Option<String> = row.try_get::<&str, _>(0).ok().flatten().map(str::to_string);
    let version_number = version
        .as_deref()
        .and_then(parse_mssql_version)
        .and_then(|v| v.split('.').next()?.parse::<u64>().ok());

    let supports_tls = first_row(
        client,
        "SELECT encrypt_option FROM sys.dm_exec_connections WHERE session_id = @@SPID",
    )
    .await
    .ok()
    .flatten()
    .and_then(|row| row.try_get::<&str, _>(0).ok().flatten().map(str::to_string))
    .map(|value| value.eq_ignore_ascii_case("TRUE"))
    .unwrap_or(false);

    Ok(ServerInfo {
        version,
        version_number,
        server_comment: None,
        current_database: row
            .try_get::<&str, _>(1)
            .ok()
            .flatten()
            .map(str::to_string),
        current_user: row
            .try_get::<&str, _>(2)
            .ok()
            .flatten()
            .map(str::to_string),
        supports_tls,
    })
}

/// The first row of a one-row query, drained cleanly. None when the query
/// answered no rows at all.
async fn first_row(client: &mut RawClient, sql: &str) -> Result<Option<Row>> {
    let mut stream = client
        .simple_query(sql)
        .await
        .map_err(|e| DriverError::Introspect(e.to_string()))?;
    while let Some(item) = stream
        .try_next()
        .await
        .map_err(|e| DriverError::Introspect(e.to_string()))?
    {
        if let tiberius::QueryItem::Row(row) = item {
            return Ok(Some(row));
        }
    }
    Ok(None)
}

pub struct MssqlConnection {
    /// The driver this connection was opened by, the single declaration of the
    /// engine's id, capabilities, dialect and (absent) plan statement.
    driver: MssqlDriver,
    settings: Arc<ConnectionSettings>,
    info: ServerInfo,
    /// One client pool per database the session has run against. A TDS login
    /// opens on its database, so switching is a new pool rather than a `USE`.
    pools: tokio::sync::Mutex<HashMap<String, Arc<ClientPool>>>,
}

impl MssqlConnection {
    /// The pool for a target database, created on first use. `None`/empty falls
    /// back to the database the connection was opened with.
    async fn pool_for(&self, database: Option<&str>) -> Result<Arc<ClientPool>> {
        let key = database
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| self.info.current_database.as_deref().unwrap_or_default())
            .to_string();
        if let Some(pool) = self.pools.lock().await.get(&key) {
            return Ok(pool.clone());
        }
        let mut pools = self.pools.lock().await;
        if let Some(pool) = pools.get(&key) {
            return Ok(pool.clone());
        }
        let pool = Arc::new(ClientPool {
            settings: self.settings.clone(),
            database: Some(key.clone()).filter(|name| !name.is_empty()),
            idle: tokio::sync::Mutex::new(vec![]),
        });
        pools.insert(key, pool.clone());
        Ok(pool)
    }
}

#[async_trait]
impl Connection for MssqlConnection {
    fn driver(&self) -> &dyn DatabaseDriver {
        &self.driver
    }

    fn server_info(&self) -> &ServerInfo {
        &self.info
    }

    async fn ping(&self) -> Result<()> {
        let mut guard = self.pool_for(None).await?.acquire().await?;
        let client = guard.client();
        client
            .simple_query("SELECT 1")
            .await
            .map(|_| ())
            .map_err(|e| DriverError::Connect(e.to_string()))
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        let mut guard = self.pool_for(None).await?.acquire().await?;
        let rows = query_all(guard.client(), "SELECT name FROM sys.databases ORDER BY name", &[])
            .await?;
        Ok(rows
            .into_iter()
            .map(|row| {
                let name = row_string(&row, 0);
                DatabaseInfo {
                    is_system: matches!(name.as_str(), "master" | "tempdb" | "model" | "msdb"),
                    name,
                }
            })
            .collect())
    }

    async fn list_namespaces(&self, database: &str) -> Result<Vec<NamespaceInfo>> {
        // Unlike MySQL's server-wide `information_schema`, the sys catalogs
        // are per-database: the introspection must run where the objects are.
        let mut guard = self.pool_for(Some(database)).await?.acquire().await?;
        // The system schemas (`sys`, `INFORMATION_SCHEMA`, `guest` and the
        // `db_*` fixed roles) are not user namespaces, the way `pg_*` is not.
        let rows = query_all(
            guard.client(),
            "SELECT name FROM sys.schemas \
             WHERE name NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest') AND name NOT LIKE 'db[_]%' \
             ORDER BY name",
            &[],
        )
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| NamespaceInfo {
                name: row_string(&row, 0),
            })
            .collect())
    }

    async fn list_objects(
        &self,
        database: &str,
        namespace: Option<&str>,
    ) -> Result<Vec<DatabaseObject>> {
        let schema = namespace.unwrap_or("dbo");
        let mut guard = self.pool_for(Some(database)).await?.acquire().await?;
        // One union for everything the explorer groups: tables, views,
        // sequences, procedures and the schema's triggers. `type_desc` would
        // answer `USER_TABLE` and `SQL_STORED_PROCEDURE`, which the shared
        // classifier does not know, so the two-letter `type` is mapped to the
        // markers it does — pinned by `list_object_markers_are_classified`.
        let rows = query_all(
            guard.client(),
            "SELECT o.name, CASE o.type \
                 WHEN 'U' THEN 'TABLE' WHEN 'V' THEN 'VIEW' WHEN 'SO' THEN 'SEQUENCE' \
                 WHEN 'P' THEN 'PROCEDURE' WHEN 'TR' THEN 'TRIGGER' END, s.name \
             FROM sys.objects o \
             JOIN sys.schemas s ON s.schema_id = o.schema_id \
             WHERE s.name = @P1 AND o.type IN ('U', 'V', 'SO', 'P', 'TR') \
             ORDER BY o.name",
            &[&schema],
        )
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| {
                let name = row_string(&row, 0);
                let marker = row_string(&row, 1);
                let schema_name = row_string(&row, 2);
                DatabaseObject {
                    name,
                    kind: object_kind_from_marker(&marker),
                    schema: Some(schema_name),
                    comment: None,
                    row_estimate: None,
                }
            })
            .collect())
    }

    async fn describe_object(
        &self,
        database: &str,
        namespace: Option<&str>,
        object: &str,
    ) -> Result<ObjectSchema> {
        let schema = namespace.unwrap_or("dbo");
        let mut guard = self.pool_for(Some(database)).await?.acquire().await?;
        let client = guard.client();

        let kind = object_kind(client, schema, object).await?;

        let column_rows = query_all(
            client,
            // `INFORMATION_SCHEMA.COLUMNS` on SQL Server has no `IS_IDENTITY`
            // (that column is MySQL's); identity comes from COLUMNPROPERTY.
            "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, ORDINAL_POSITION, \
                    CAST(COLUMNPROPERTY(OBJECT_ID(QUOTENAME(TABLE_SCHEMA) + '.' + QUOTENAME(TABLE_NAME)), \
                                        COLUMN_NAME, 'IsIdentity') AS INT) AS is_identity \
             FROM INFORMATION_SCHEMA.COLUMNS \
             WHERE TABLE_SCHEMA = @P1 AND TABLE_NAME = @P2 \
             ORDER BY ORDINAL_POSITION",
            &[&schema, &object],
        )
        .await?;
        let mut columns: Vec<ColumnSchema> = column_rows
            .into_iter()
            .map(|row| {
                let nullable = row_string(&row, 2).eq_ignore_ascii_case("YES");
                let default_value = row_try_string(&row, 3);
                let is_auto_increment = row_try_i32(&row, 5).unwrap_or(0) == 1;
                ColumnSchema {
                    name: row_string(&row, 0),
                    data_type: row_string(&row, 1),
                    nullable,
                    is_primary_key: false,
                    is_auto_increment,
                    default_value,
                    comment: None,
                    ordinal: row_try_i32(&row, 4).unwrap_or(0) as u32,
                }
            })
            .collect();

        let index_rows = query_all(
            client,
            "SELECT i.name, i.is_unique, i.is_primary_key, ic.key_ordinal, c.name \
             FROM sys.indexes i \
             JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
             JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
             JOIN sys.tables t ON t.object_id = i.object_id \
             JOIN sys.schemas s ON s.schema_id = t.schema_id \
             WHERE s.name = @P1 AND t.name = @P2 AND i.name IS NOT NULL \
             ORDER BY i.name, ic.key_ordinal",
            &[&schema, &object],
        )
        .await?;
        let mut indexes: Vec<IndexSchema> = Vec::new();
        let mut primary_columns: Vec<String> = Vec::new();
        for row in index_rows {
            let name = row_string(&row, 0);
            let unique = row_try_bool(&row, 1).unwrap_or(false);
            let primary = row_try_bool(&row, 2).unwrap_or(false);
            let column = row_string(&row, 4);
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

        let fk_rows = query_all(
            client,
            "SELECT fk.name, fkc.constraint_column_id, pc.name, rt.name, rc.name \
             FROM sys.foreign_keys fk \
             JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
             JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id \
               AND pc.column_id = fkc.parent_column_id \
             JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id \
             JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id \
               AND rc.column_id = fkc.referenced_column_id \
             JOIN sys.schemas s ON s.schema_id = fk.schema_id \
             WHERE s.name = @P1 AND OBJECT_NAME(fk.parent_object_id) = @P2 \
             ORDER BY fk.name, fkc.constraint_column_id",
            &[&schema, &object],
        )
        .await?;
        let foreign_key_columns: Vec<(String, i32, String, String, String)> = fk_rows
            .into_iter()
            .map(|row| {
                (
                    row_string(&row, 0),
                    row_try_i32(&row, 1).unwrap_or(0),
                    row_string(&row, 2),
                    row_string(&row, 3),
                    row_string(&row, 4),
                )
            })
            .collect();
        let foreign_keys = assemble_foreign_key_columns(foreign_key_columns);

        Ok(build_object_schema(object, kind, columns, indexes, foreign_keys))
    }

    /// One query instead of N: the whole schema's columns at once.
    async fn list_table_columns(
        &self,
        database: &str,
        namespace: Option<&str>,
    ) -> Result<Vec<TableColumns>> {
        let schema = namespace.unwrap_or("dbo");
        let mut guard = self.pool_for(Some(database)).await?.acquire().await?;
        let rows = query_all(
            guard.client(),
            "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS \
             WHERE TABLE_SCHEMA = @P1 ORDER BY TABLE_NAME, ORDINAL_POSITION",
            &[&schema],
        )
        .await?;
        let mut out: Vec<TableColumns> = Vec::new();
        for row in rows {
            let table = row_string(&row, 0);
            let column = ColumnMeta {
                name: row_string(&row, 1),
                data_type: Some(row_string(&row, 2)),
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
        // The pool bound to the requested database; the login carried the
        // connection's own, so no `USE` is ever sent.
        let pool = self.pool_for(request.database.as_deref()).await?;
        let mut guard = pool.acquire().await?;

        // The session id another connection must name to `KILL` this one; the
        // kill cannot come from the session that is busy running the query.
        let spid: Option<i32> = {
            let client = guard.client();
            match first_row(client, "SELECT @@SPID AS spid").await {
                Ok(Some(row)) => row.try_get::<i32, _>(0).ok().flatten(),
                // A session that cannot report its id cannot be killed either;
                // run the statements without a cancel watcher instead of failing.
                _ => None,
            }
        };

        let watcher = spid.map(|spid| {
            let pool = pool.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move {
                cancel.cancelled().await;
                if let Ok(mut killer) = pool.acquire().await {
                    // Best effort: without ALTER ANY CONNECTION (or being the
                    // session's owner) the kill errors and the statement runs on.
                    let _ = killer.client().execute(&format!("KILL {spid}"), &[]).await;
                    killer.broken = true;
                }
            })
        });

        let mut results = Vec::with_capacity(statements.len());
        for statement in &statements {
            if cancel.is_cancelled() {
                break;
            }
            let client = guard.client();
            let (result, broken) = run_statement(client, statement, max_rows).await;
            guard.broken |= broken;
            results.push(result);
        }
        // A cancelled request leaves this client mid-reply even when the loop
        // ended cleanly, so the guard must not park it.
        if cancel.is_cancelled() {
            guard.broken = true;
        }
        drop(guard);
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

/// Resolve the real object kind so a view is not reported as a plain table.
async fn object_kind(client: &mut RawClient, schema: &str, object: &str) -> Result<ObjectKind> {
    let rows = query_all(
        client,
        "SELECT o.type FROM sys.objects o \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         WHERE s.name = @P1 AND o.name = @P2",
        &[&schema, &object],
    )
    .await?;
    Ok(match rows.first().map(|row| row_string(row, 0)) {
        Some(marker) if marker == "V" => ObjectKind::View,
        Some(marker) if marker == "SO" => ObjectKind::Sequence,
        Some(marker) if marker == "P" => ObjectKind::Procedure,
        Some(marker) if marker == "TR" => ObjectKind::Trigger,
        Some(_) => ObjectKind::Table,
        None => ObjectKind::Other,
    })
}

/// Run one statement with no parameters, collecting the rows of the first
/// result set or the affected count of a row-count reply. Returns whether the
/// client came out of the reply mid-message — the mark that says the guard
/// must close it rather than park it.
async fn run_statement(client: &mut RawClient, sql: &str, max_rows: usize) -> (StatementResult, bool) {
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

    if is_dml_statement(sql) {
        match client.execute(sql, &[]).await {
            Ok(done) => result.affected_rows = Some(done.total()),
            Err(error) => {
                result.error = Some(error.to_string());
                // A statement error may have stopped the reply mid-message —
                // tiberius' own advice is that a pool discards a connection
                // after one, so this client is not parked.
                return (result, true);
            }
        }
        result.execution_ms = started.elapsed().as_millis() as u64;
        return (result, false);
    }

    let outcome = run_query_stream(client, sql, max_rows).await;

    // Breaking out of a stream mid-reply is what leaves the TDS session
    // unsynced, and so is a reply an error cut off; either way the client
    // must be closed rather than parked.
    let broken = match outcome {
        Ok((columns, rows, truncated)) => {
            result.is_query = columns.as_ref().map(|c| !c.is_empty()).unwrap_or(false);
            result.columns = columns.unwrap_or_default();
            result.row_count = rows.len();
            result.rows = rows;
            result.truncated = truncated;
            truncated
        }
        Err(error) => {
            result.error = Some(error.to_string());
            true
        }
    };

    result.execution_ms = started.elapsed().as_millis() as u64;
    (result, broken)
}

type QueryOutcome = (
    Option<Vec<ColumnMeta>>,
    Vec<Vec<Value>>,
    bool,
);

async fn run_query_stream(
    client: &mut RawClient,
    sql: &str,
    max_rows: usize,
) -> std::result::Result<QueryOutcome, tiberius::error::Error> {
    let mut stream = client.simple_query(sql).await?;
    let mut columns: Option<Vec<ColumnMeta>> = None;
    let mut rows: Vec<Vec<Value>> = Vec::new();
    let mut truncated = false;
    while let Some(item) = stream.try_next().await? {
        match item {
            tiberius::QueryItem::Metadata(metadata) => {
                if columns.is_none() {
                    columns = Some(columns_of(metadata.columns()));
                }
            }
            tiberius::QueryItem::Row(row) => {
                if columns.is_none() {
                    columns = Some(columns_of(row.columns()));
                }
                if rows.len() >= max_rows {
                    truncated = true;
                    break;
                }
                rows.push(decode_row(&row));
            }
        }
    }
    Ok((columns, rows, truncated))
}

fn columns_of(columns: &[tiberius::Column]) -> Vec<ColumnMeta> {
    columns
        .iter()
        .map(|column| ColumnMeta {
            name: column.name().to_string(),
            data_type: Some(column_type_name(column.column_type())),
        })
        .collect()
}

/// Drain every row of every result set of an introspection query. The
/// descriptors' own bounds keep these small.
async fn query_all(client: &mut RawClient, sql: &str, params: &[&dyn tiberius::ToSql]) -> Result<Vec<Row>> {
    let mut stream = client
        .query(sql, params)
        .await
        .map_err(|e| DriverError::Introspect(e.to_string()))?;
    let mut rows = Vec::new();
    while let Some(item) = stream
        .try_next()
        .await
        .map_err(|e| DriverError::Introspect(e.to_string()))?
    {
        if let tiberius::QueryItem::Row(row) = item {
            rows.push(row);
        }
    }
    Ok(rows)
}

fn row_string(row: &Row, index: usize) -> String {
    row_try_string(row, index).unwrap_or_default()
}

fn row_try_string(row: &Row, index: usize) -> Option<String> {
    row.try_get::<&str, _>(index)
        .ok()
        .flatten()
        .map(str::to_string)
}

fn row_try_i32(row: &Row, index: usize) -> Option<i32> {
    row.try_get::<i32, _>(index).ok().flatten()
}

fn row_try_bool(row: &Row, index: usize) -> Option<bool> {
    row.try_get::<bool, _>(index).ok().flatten()
}

/// Column names for the metadata, in the words a DBA would use: the TDS wire
/// type turned back into the T-SQL type it came from.
fn column_type_name(column_type: tiberius::ColumnType) -> String {
    use tiberius::ColumnType::*;
    match column_type {
        Null => "sql_variant".into(),
        Bit | Bitn => "bit".into(),
        Int1 => "tinyint".into(),
        Int2 => "smallint".into(),
        Int4 => "int".into(),
        Int8 => "bigint".into(),
        Intn => "int".into(),
        Float4 => "real".into(),
        Float8 | Floatn => "float".into(),
        Money | Money4 => "money".into(),
        Guid => "uniqueidentifier".into(),
        Decimaln | Numericn => "decimal".into(),
        Datetime4 => "smalldatetime".into(),
        Datetime | Datetimen => "datetime".into(),
        Daten => "date".into(),
        Timen => "time".into(),
        Datetime2 => "datetime2".into(),
        DatetimeOffsetn => "datetimeoffset".into(),
        BigVarBin | BigBinary | Image => "varbinary".into(),
        BigVarChar | BigChar => "varchar".into(),
        NVarchar | NChar | NText => "nvarchar".into(),
        Text => "text".into(),
        Xml => "xml".into(),
        Udt => "udt".into(),
        SSVariant => "sql_variant".into(),
    }
}

fn decode_row(row: &Row) -> Vec<Value> {
    (0..row.columns().len())
        .map(|index| decode_cell(row, index))
        .collect()
}

/// One cell as JSON. The TDS wire type names the first candidate; a type that
/// answers no candidate falls through to the same string-then-bytes chain the
/// PostgreSQL decoder uses, and only then to null.
fn decode_cell(row: &Row, index: usize) -> Value {
    use tiberius::ColumnType::*;

    match row.columns()[index].column_type() {
        Bit | Bitn => {
            if let Ok(Some(v)) = row.try_get::<bool, _>(index) {
                return json!(v);
            }
        }
        Int1 => {
            if let Ok(Some(v)) = row.try_get::<u8, _>(index) {
                return json!(v);
            }
        }
        Int2 => {
            if let Ok(Some(v)) = row.try_get::<i16, _>(index) {
                return json!(v);
            }
        }
        Int4 => {
            if let Ok(Some(v)) = row.try_get::<i32, _>(index) {
                return json!(v);
            }
        }
        Int8 => {
            if let Ok(Some(v)) = row.try_get::<i64, _>(index) {
                return json!(v);
            }
        }
        // `Intn` is what an INT column arrives as over the wire; its width
        // decides the Rust type, widest first.
        Intn => {
            if let Ok(Some(v)) = row.try_get::<i64, _>(index) {
                return json!(v);
            }
            if let Ok(Some(v)) = row.try_get::<i32, _>(index) {
                return json!(v);
            }
        }
        Float4 => {
            if let Ok(Some(v)) = row.try_get::<f32, _>(index) {
                return json!(v);
            }
        }
        Float8 | Floatn => {
            if let Ok(Some(v)) = row.try_get::<f64, _>(index) {
                return json!(v);
            }
        }
        Decimaln | Numericn => {
            if let Ok(Some(v)) = row.try_get::<tiberius::numeric::Numeric, _>(index) {
                return Value::String(v.to_string());
            }
        }
        Guid => {
            if let Ok(Some(v)) = row.try_get::<uuid::Uuid, _>(index) {
                return Value::String(v.to_string());
            }
        }
        // The crate's `chrono` feature is compiled against chrono 0.4, the
        // same version `sqlx` pins, so the impls apply to its re-export.
        Datetime | Datetime2 | Datetimen | Datetime4 => {
            if let Ok(Some(v)) = row.try_get::<sqlx::types::chrono::NaiveDateTime, _>(index) {
                return Value::String(v.to_string());
            }
        }
        Daten => {
            if let Ok(Some(v)) = row.try_get::<sqlx::types::chrono::NaiveDate, _>(index) {
                return Value::String(v.to_string());
            }
        }
        Timen => {
            if let Ok(Some(v)) = row.try_get::<sqlx::types::chrono::NaiveTime, _>(index) {
                return Value::String(v.to_string());
            }
        }
        DatetimeOffsetn => {
            if let Ok(Some(v)) =
                row.try_get::<sqlx::types::chrono::DateTime<sqlx::types::chrono::FixedOffset>, _>(
                    index,
                )
            {
                return Value::String(v.to_rfc3339());
            }
        }
        BigVarChar | BigChar | NVarchar | NChar | Text | NText | Xml => {
            if let Ok(Some(v)) = row.try_get::<&str, _>(index) {
                return Value::String(v.to_string());
            }
        }
        BigVarBin | BigBinary | Image => {
            if let Ok(Some(v)) = row.try_get::<&[u8], _>(index) {
                return match String::from_utf8(v.to_vec()) {
                    Ok(s) => Value::String(s),
                    Err(_) => Value::String(format!("base64:{}", BASE64.encode(v))),
                };
            }
        }
        _ => {}
    }

    // Money and the odd cases (`sql_variant`, an `Intn` of another width) fall
    // through to the same chain as every other adapter.
    if let Ok(Some(v)) = row.try_get::<&str, _>(index) {
        return Value::String(v.to_string());
    }
    if let Ok(Some(v)) = row.try_get::<&[u8], _>(index) {
        return match String::from_utf8(v.to_vec()) {
            Ok(s) => Value::String(s),
            Err(_) => Value::String(format!("base64:{}", BASE64.encode(v))),
        };
    }
    Value::Null
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
mod tests {
    use super::*;
    use crate::drivers::object_kind_from_marker;
    use crate::models::ObjectKind;

    #[test]
    fn list_object_markers_are_classified() {
        // The exact words `list_objects`' CASE puts in the marker column; a
        // drift here would file every table under "other" in the explorer.
        assert_eq!(object_kind_from_marker("TABLE"), ObjectKind::Table);
        assert_eq!(object_kind_from_marker("VIEW"), ObjectKind::View);
        assert_eq!(object_kind_from_marker("SEQUENCE"), ObjectKind::Sequence);
        assert_eq!(object_kind_from_marker("PROCEDURE"), ObjectKind::Procedure);
        assert_eq!(object_kind_from_marker("TRIGGER"), ObjectKind::Trigger);
    }

    #[test]
    fn version_banner_parses_to_the_build_number() {
        assert_eq!(
            parse_mssql_version(
                "Microsoft SQL Server 2019 (RTM-CU23 GDR) (KB5035129) - 15.0.4298.1 (X64) \
                 Jan 20 2024 03:54:07 Copyright (C) 2019 Microsoft Corporation"
            ),
            Some("15.0.4298.1".into())
        );
        assert_eq!(
            parse_mssql_version("Microsoft SQL Azure (RTM) - 12.0.2000.8"),
            Some("12.0.2000.8".into())
        );
        // The year comes first and has no dot, so it is never mistaken.
        assert_eq!(
            parse_mssql_version("Microsoft SQL Server 2019 - something"),
            None
        );
    }

    #[test]
    fn row_count_statements_take_the_execute_path() {
        for sql in [
            "INSERT INTO orders (id) VALUES (1)",
            "update [orders] set [status] = 'paid'",
            "  DELETE FROM orders",
            "TRUNCATE TABLE orders",
            "CREATE TABLE t (id INT)",
        ] {
            assert!(is_dml_statement(sql), "{sql} should take the execute path");
        }
        for sql in [
            "SELECT * FROM orders",
            "with recent as (SELECT id FROM orders) SELECT * FROM recent",
            "EXEC sp_helpdb",
        ] {
            assert!(!is_dml_statement(sql), "{sql} should take the query path");
        }
    }

    /// End-to-end against a real server, skipped unless one is provided. The
    /// server's password arrives only through the environment, and the example
    /// below hands that same variable to the container, so no credential is
    /// ever written down here:
    ///
    /// ```text
    /// export QUARRY_TEST_MSSQL_PASSWORD='<pick a compliant sa password>'
    /// docker run -d --name quarry-mssql -e ACCEPT_EULA=Y \
    ///   -e "MSSQL_SA_PASSWORD=$QUARRY_TEST_MSSQL_PASSWORD" -p 14330:1433 \
    ///   mcr.microsoft.com/mssql/server:2022-latest
    /// QUARRY_TEST_MSSQL_HOST=127.0.0.1 QUARRY_TEST_MSSQL_PORT=14330 \
    ///   cargo test -- --ignored
    /// ```
    #[tokio::test]
    #[ignore = "needs a reachable SQL Server (see module docs)"]
    async fn connects_introspects_and_runs_statements() {
        use std::time::Duration;

        let Ok(password) = std::env::var("QUARRY_TEST_MSSQL_PASSWORD") else {
            eprintln!("skipping: QUARRY_TEST_MSSQL_PASSWORD is not set");
            return;
        };
        let config = ConnectionConfig {
            driver: "mssql".into(),
            host: std::env::var("QUARRY_TEST_MSSQL_HOST").unwrap_or_else(|_| "127.0.0.1".into()),
            port: std::env::var("QUARRY_TEST_MSSQL_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(1433),
            username: "sa".into(),
            password: Some(password),
            database: None,
            // `Preferred` is the form's default and exercises the TLS handshake
            // against the container's self-signed certificate.
            ssl_mode: SslMode::Preferred,
            options: Default::default(),
        };

        let driver = MssqlDriver::new();
        let info = driver.test(&config).await.expect("server info");
        assert!(info.version.is_some(), "{:?}", info.version);
        assert!(info.version_number.is_some(), "{:?}", info.version_number);
        assert!(info.supports_tls, "preferred must have encrypted the session");

        let connection = driver.connect(&config).await.expect("connect");
        connection.ping().await.expect("ping");

        let run = |sql: &str| QueryRequest {
            database: Some("quarry_test".into()),
            sql: sql.into(),
            max_rows: Some(100),
            timeout_ms: None,
            run_id: None,
        };

        // Setup runs on the login database with fully qualified names, the way
        // a script pasted into a fresh session would.
        let setup = connection
            .execute(QueryRequest {
                database: None,
                sql: "IF DB_ID('quarry_test') IS NOT NULL DROP DATABASE quarry_test; \
                      CREATE DATABASE quarry_test; \
                      CREATE TABLE quarry_test.dbo.items (\
                        id INT IDENTITY(1,1) PRIMARY KEY, \
                        name NVARCHAR(80) NOT NULL, \
                        price DECIMAL(12,2) NULL, \
                        active BIT NOT NULL, \
                        taken_at DATETIME2 NULL, \
                        amount MONEY NULL, \
                        ref UNIQUEIDENTIFIER NULL); \
                      INSERT INTO quarry_test.dbo.items (name, price, active, taken_at, amount, ref) \
                      VALUES ('first', 12.34, 1, '2026-10-19T12:00:00', 4.5, \
                              '11111111-2222-3333-4444-555555555555'); \
                      INSERT INTO quarry_test.dbo.items (name, active) VALUES ('second', 0)"
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
        // The two inserts went through the execute path and reported counts:
        // [0] the IF/DROP, [1] CREATE DATABASE, [2] CREATE TABLE, [3..] the
        // inserts, whose DONE row counts are what `execute` surfaces.
        let inserts = &setup.results[3..];
        assert_eq!(inserts.len(), 2, "{:?}", setup.results);
        assert_eq!(inserts[0].affected_rows, Some(1));
        assert_eq!(inserts[1].affected_rows, Some(1));

        // The typed row round-trips: numbers, bit, decimal, guid, datetime2 —
        // and money, which tiberius cannot decode yet, arrives as null.
        let select = connection
            .execute(run("SELECT name, price, active, ref, taken_at, amount, id FROM dbo.items WHERE name = 'first'"))
            .await
            .expect("typed select");
        let statement = &select.results[0];
        assert!(statement.error.is_none(), "{:?}", statement.error);
        assert_eq!(statement.row_count, 1);
        assert_eq!(statement.columns[0].name, "name");
        let row = &statement.rows[0];
        assert_eq!(row[0], json!("first"));
        assert_eq!(row[1], json!("12.34"), "decimal renders as its text");
        assert_eq!(row[2], json!(true), "bit renders as a boolean");
        assert_eq!(row[3], json!("11111111-2222-3333-4444-555555555555"));
        assert!(
            row[4]
                .as_str()
                .map(|value| value.starts_with("2026-10-19"))
                .unwrap_or(false),
            "datetime2 renders as text: {row:?}"
        );
        assert_eq!(row[5], json!(null), "money has no FromSql in tiberius yet");
        assert_eq!(row[6], json!(1), "identity arrived as a number");

        // The row limit is passed: one row back, flagged truncated — and the
        // truncated client is not parked but closed, so this query and the
        // next both answer on fresh sessions.
        let limited = connection
            .execute(QueryRequest {
                max_rows: Some(1),
                ..run("SELECT id FROM dbo.items ORDER BY id")
            })
            .await
            .expect("limited select");
        assert_eq!(limited.results[0].row_count, 1);
        assert!(limited.results[0].truncated);

        // A failing statement reports the server's error and the next
        // statement still answers: the pool did not reuse a broken session.
        let failed = connection.execute(run("SELECT 1/0")).await.expect("run");
        assert!(failed.results[0].error.is_some(), "division by zero errors");
        let after_failure = connection
            .execute(run("SELECT COUNT(*) FROM dbo.items"))
            .await
            .expect("query after failure");
        assert!(
            after_failure.results[0].error.is_none(),
            "{:?}",
            after_failure.results[0].error
        );

        // Introspection: databases, the schema list, the objects of `dbo`
        // classified as tables (the CASE mapping, not `type_desc`'s words),
        // the table's columns, identity flag and primary key.
        let databases = connection.list_databases().await.expect("databases");
        let quarry = databases
            .iter()
            .find(|db| db.name == "quarry_test")
            .expect("quarry_test");
        assert!(!quarry.is_system);
        assert!(databases.iter().any(|db| db.name == "tempdb" && db.is_system));

        let namespaces = connection
            .list_namespaces("quarry_test")
            .await
            .expect("schemas");
        assert!(namespaces.iter().any(|ns| ns.name == "dbo"), "{namespaces:?}");
        assert!(!namespaces.iter().any(|ns| ns.name == "INFORMATION_SCHEMA"));

        let objects = connection
            .list_objects("quarry_test", Some("dbo"))
            .await
            .expect("objects");
        let items = objects.iter().find(|object| object.name == "items").expect("items");
        assert_eq!(items.kind, ObjectKind::Table, "the CASE marker classifies as a table");

        let schema = connection
            .describe_object("quarry_test", Some("dbo"), "items")
            .await
            .expect("describe");
        assert_eq!(schema.kind, ObjectKind::Table);
        let id = schema.columns.iter().find(|c| c.name == "id").expect("id column");
        assert!(id.is_primary_key, "the primary key comes from sys.indexes");
        assert!(id.is_auto_increment, "IS_IDENTITY marks the identity column");
        assert_eq!(id.data_type, "int");
        let price = schema.columns.iter().find(|c| c.name == "price").expect("price");
        assert!(price.nullable);
        assert!(!price.is_auto_increment);

        let columns = connection
            .list_table_columns("quarry_test", Some("dbo"))
            .await
            .expect("columns");
        let items_columns = columns.iter().find(|entry| entry.table == "items").expect("items");
        assert_eq!(items_columns.columns.len(), schema.columns.len());

        // A query against another database lands on its own pool and really
        // runs there: `USE` is never sent, the login just opens separately.
        let on_master = connection
            .execute(QueryRequest {
                database: Some("master".into()),
                sql: "SELECT DB_NAME() AS current_db".into(),
                max_rows: Some(1),
                timeout_ms: None,
                run_id: None,
            })
            .await
            .expect("master query");
        assert_eq!(on_master.results[0].rows[0][0], json!("master"));
        // And the quarry_test pool still answers afterwards.
        let back = connection
            .execute(run("SELECT DB_NAME() AS current_db"))
            .await
            .expect("back");
        assert_eq!(back.results[0].rows[0][0], json!("quarry_test"));

        // A cancelled statement is killed on the server and reported as
        // cancelled; the killed session is discarded, not reused.
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let task_connection = connection.clone();
        let task = tokio::spawn(async move {
            task_connection
                .execute_cancellable(
                    QueryRequest {
                        database: Some("quarry_test".into()),
                        sql: "WAITFOR DELAY '0:00:30';".into(),
                        max_rows: Some(1),
                        timeout_ms: None,
                        run_id: None,
                    },
                    task_cancel,
                )
                .await
        });
        tokio::time::sleep(Duration::from_secs(2)).await;
        cancel.cancel();
        let outcome = tokio::time::timeout(Duration::from_secs(20), task)
            .await
            .expect("the cancel path finishes promptly once killed")
            .expect("the task joins");
        assert!(
            matches!(outcome, Err(DriverError::Cancelled(_))),
            "{outcome:?}"
        );
        let recovered = connection
            .execute(run("SELECT COUNT(*) FROM dbo.items"))
            .await
            .expect("query after cancel");
        assert_eq!(recovered.results[0].rows[0][0], json!(2));

        // The engine declares no EXPLAIN, so the plan rewrite is None.
        assert!(connection.explain_statement("SELECT 1").is_none());

        // Cleanup on the login database.
        connection
            .execute(QueryRequest {
                database: None,
                sql: "DROP DATABASE quarry_test;".into(),
                max_rows: Some(1),
                timeout_ms: None,
                run_id: None,
            })
            .await
            .expect("cleanup");
    }
}
