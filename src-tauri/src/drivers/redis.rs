//! Redis driver.
//!
//! Redis is not relational: there are no tables, schemas or DDL, and the
//! "query language" is a command per line rather than a SQL script. All of that
//! is expressed through [`DriverCapabilities`] (`ResultShape::KeyValue`,
//! `isRelational: false`, `supportsDdl: false`, ...) so the rest of the app
//! stays driver-agnostic.
//!
//! * The editor sends its whole text to [`Connection::execute`], which treats
//!   every non-empty, non-`#` line as one command (arguments may be quoted).
//! * Replies are flattened into the shared rows/columns result shape so the
//!   existing grid renders them: a scalar becomes one cell, an array one row
//!   per element, a RESP3 map a `field`/`value` table.
//! * The explorer lists keys with `SCAN` (capped) and maps each key to a
//!   compact structure summary via `TYPE`/`TTL`/`<type>LEN`/`STRLEN`.

use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use redis::aio::ConnectionManager;
use redis::Value as RedisValue;
use serde_json::{json, Map as JsonMap, Value};
use tokio_util::sync::CancellationToken;

use super::{Connection, DatabaseDriver};
use crate::error::{DriverError, Result};
use crate::models::{
    ColumnMeta, ColumnSchema, ConfigField, ConnectionConfig, DatabaseInfo, DatabaseObject,
    DriverCapabilities, FieldType, NamespaceInfo, ObjectAction, ObjectKind, ObjectSchema,
    QueryLanguage, QueryRequest, QueryResponse, ResultShape, SelectOption, ServerInfo, SslMode,
    StatementResult,
};

const ACCENT: &str = "#DC382D";
/// How many keys `list_objects` is willing to collect before stopping. A Redis
/// keyspace can hold millions of keys; the tree lists a bounded sample instead.
const MAX_KEYS: usize = 2000;
/// Upper bound on `SCAN` round trips so a huge keyspace cannot stall the tree.
const MAX_SCAN_ROUNDS: usize = 40;

pub struct RedisDriver;

impl RedisDriver {
    pub fn new() -> Self {
        RedisDriver
    }
}

impl Default for RedisDriver {
    fn default() -> Self {
        Self::new()
    }
}

fn capabilities() -> DriverCapabilities {
    DriverCapabilities {
        query_language: QueryLanguage::Redis,
        result_shape: ResultShape::KeyValue,
        is_relational: false,
        // Keys live in numbered databases; the session stays on the configured
        // one, so the UI is not offered a database switcher.
        supports_multiple_databases: false,
        supports_schemas: false,
        supports_transactions: false,
        supports_ddl: false,
        // Redis has no query planner, so `explain_statement` (which gates on
        // this flag) answers `None` instead of a bogus `EXPLAIN <command>`.
        supports_explain: false,
        // Commands are answered by a single multiplexed connection; there is
        // nothing to cancel server-side.
        supports_cancel: false,
        object_kinds: vec![ObjectKind::Key],
        // Only "Inspect structure" applies to a key; the SQL-shaped write
        // actions are hidden because none of them is advertised here.
        supported_actions: vec![ObjectAction::Inspect],
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
            placeholder: Some("6379".into()),
            required: true,
            default_value: Some(json!(6379)),
            options: vec![],
            help: None,
        },
        ConfigField {
            key: "username".into(),
            label: "Username".into(),
            field_type: FieldType::Text,
            placeholder: Some("default".into()),
            required: false,
            default_value: None,
            options: vec![],
            help: Some("Optional. Only ACL users (Redis 6+) need a username.".into()),
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
            field_type: FieldType::Number,
            placeholder: Some("0".into()),
            required: false,
            default_value: Some(json!(0)),
            options: vec![],
            help: Some("Redis database index (0–15 by default).".into()),
        },
        ConfigField {
            key: "sslMode".into(),
            label: "TLS".into(),
            field_type: FieldType::Select,
            placeholder: None,
            required: false,
            default_value: Some(json!("disabled")),
            options: vec![
                SelectOption {
                    value: "disabled".into(),
                    label: "Disabled".into(),
                },
                SelectOption {
                    value: "required".into(),
                    label: "Required (rediss)".into(),
                },
            ],
            help: Some("Required connects over TLS using the system certificate store.".into()),
        },
    ]
}

/// Redis database index from the core `database` field (defaults to 0).
fn database_index(config: &ConnectionConfig) -> Result<i64> {
    match config
        .database
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        None => Ok(0),
        Some(text) => text.parse::<i64>().map_err(|_| {
            DriverError::Config(format!("`{text}` is not a valid Redis database index"))
        }),
    }
}

/// Build a connection URL. Redis rejects credentials that are not
/// percent-encoded, so the userinfo parts go through a strict encoder.
fn connection_url(config: &ConnectionConfig) -> Result<String> {
    let host = config.host.trim();
    if host.is_empty() {
        return Err(DriverError::Config("a host is required".into()));
    }
    let scheme = if config.ssl_mode == SslMode::Required {
        "rediss"
    } else {
        "redis"
    };
    let user = config.username.trim();
    let credentials = match (user.is_empty(), config.password.as_deref()) {
        (true, None) => String::new(),
        (true, Some(password)) => format!(":{}@", encode(password)),
        (false, password) => format!("{}:{}@", encode(user), encode(password.unwrap_or_default())),
    };
    let db = database_index(config)?;
    Ok(format!(
        "{scheme}://{credentials}{host}:{}/{}",
        config.port, db
    ))
}

fn encode(value: &str) -> String {
    utf8_percent_encode(value, NON_ALPHANUMERIC).to_string()
}

async fn connect_manager(config: &ConnectionConfig) -> Result<ConnectionManager> {
    let client = redis::Client::open(connection_url(config)?)
        .map_err(|e| DriverError::Config(e.to_string()))?;
    tokio::time::timeout(Duration::from_secs(20), ConnectionManager::new(client))
        .await
        .map_err(|_| DriverError::Connect("connection timed out after 20s".into()))?
        .map_err(|e| DriverError::Connect(e.to_string()))
}

#[async_trait]
impl DatabaseDriver for RedisDriver {
    fn id(&self) -> &'static str {
        "redis"
    }

    fn display_name(&self) -> &'static str {
        "Redis"
    }

    fn default_port(&self) -> u16 {
        6379
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
        let mut manager = connect_manager(config).await?;
        let info = fetch_server_info(&mut manager, config).await;
        info
    }

    async fn connect(&self, config: &ConnectionConfig) -> Result<Arc<dyn Connection>> {
        let manager = connect_manager(config).await?;
        let mut probe = manager.clone();
        let info = fetch_server_info(&mut probe, config).await?;
        Ok(Arc::new(RedisConnection {
            driver: RedisDriver::new(),
            manager,
            info,
            db: database_index(config)?,
        }))
    }
}

fn parse_redis_version(version: &str) -> Option<u64> {
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

/// `INFO server` plus a best-effort `ACL WHOAMI`. An old server (or a
/// restricted user) without ACL still connects; the username is simply absent.
async fn fetch_server_info(
    manager: &mut ConnectionManager,
    config: &ConnectionConfig,
) -> Result<ServerInfo> {
    // A `PING` gives a clear connection error before anything else.
    let pong: redis::RedisResult<String> = redis::cmd("PING").query_async(manager).await;
    pong.map_err(|e| DriverError::Connect(e.to_string()))?;

    let info: String = redis::cmd("INFO")
        .arg("server")
        .query_async(manager)
        .await
        .map_err(|e| DriverError::Connect(e.to_string()))?;

    let version = info.lines().find_map(|line| {
        line.trim()
            .strip_prefix("redis_version:")
            .map(|value| value.trim().to_string())
    });

    let current_user: Option<String> = redis::cmd("ACL")
        .arg("WHOAMI")
        .query_async(manager)
        .await
        .ok();

    Ok(ServerInfo {
        version_number: version.as_deref().and_then(parse_redis_version),
        version,
        server_comment: Some("Redis".into()),
        current_database: Some(database_index(config)?.to_string()),
        current_user,
        supports_tls: config.ssl_mode == SslMode::Required,
    })
}

pub struct RedisConnection {
    /// The driver this connection was opened by. [`RedisDriver`] is a stateless
    /// declaration, so the connection carries it and answers what the engine
    /// says about itself (its id, capabilities, dialect and lack of EXPLAIN)
    /// from here instead of repeating it.
    driver: RedisDriver,
    manager: ConnectionManager,
    info: ServerInfo,
    db: i64,
}

impl RedisConnection {
    /// The multiplexed connection manager is cheap to clone (an `Arc` inside),
    /// which is how a `&self` method gets the `&mut` a command needs.
    fn handle(&self) -> ConnectionManager {
        self.manager.clone()
    }
}

#[async_trait]
impl Connection for RedisConnection {
    fn driver(&self) -> &dyn DatabaseDriver {
        &self.driver
    }

    fn server_info(&self) -> &ServerInfo {
        &self.info
    }

    async fn ping(&self) -> Result<()> {
        let mut conn = self.handle();
        redis::cmd("PING")
            .query_async::<String>(&mut conn)
            .await
            .map(|_| ())
            .map_err(|e| DriverError::Connect(e.to_string()))
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        // Keys live in numbered databases, but the session is pinned to the one
        // in the connection config, so that is the only one offered.
        Ok(vec![DatabaseInfo {
            name: self.db.to_string(),
            is_system: false,
        }])
    }

    async fn list_namespaces(&self, _database: &str) -> Result<Vec<NamespaceInfo>> {
        Ok(vec![])
    }

    async fn list_objects(
        &self,
        database: &str,
        _namespace: Option<&str>,
    ) -> Result<Vec<DatabaseObject>> {
        let mut conn = self.handle();
        let mut cursor: u64 = 0;
        let mut keys: Vec<String> = Vec::new();
        let mut rounds = 0usize;

        loop {
            let (next, batch): (u64, Vec<String>) = redis::cmd("SCAN")
                .arg(cursor)
                .arg("COUNT")
                .arg(500)
                .query_async(&mut conn)
                .await
                .map_err(|e| DriverError::Introspect(e.to_string()))?;
            keys.extend(batch);
            rounds += 1;
            cursor = next;
            if cursor == 0 || keys.len() >= MAX_KEYS || rounds >= MAX_SCAN_ROUNDS {
                break;
            }
        }

        keys.sort();
        keys.truncate(MAX_KEYS);
        Ok(keys
            .into_iter()
            .map(|name| DatabaseObject {
                name,
                kind: ObjectKind::Key,
                schema: Some(database.to_string()),
                comment: None,
                row_estimate: None,
            })
            .collect())
    }

    /// Describe a key as a small structure summary (type, TTL, length) so the
    /// inspector has something to show where a table would list columns.
    async fn describe_object(
        &self,
        _database: &str,
        _namespace: Option<&str>,
        object: &str,
    ) -> Result<ObjectSchema> {
        let mut conn = self.handle();
        let key_type = key_type(&mut conn, object).await?;
        let ttl: i64 = redis::cmd("TTL")
            .arg(object)
            .query_async(&mut conn)
            .await
            .unwrap_or(-2);
        let length = key_length(&mut conn, object, &key_type).await;

        let columns = vec![
            ColumnSchema {
                name: "type".into(),
                data_type: key_type.clone(),
                nullable: false,
                default_value: None,
                is_primary_key: false,
                is_auto_increment: false,
                comment: None,
                ordinal: 1,
            },
            ColumnSchema {
                name: "ttl".into(),
                data_type: "seconds".into(),
                nullable: true,
                default_value: Some(format_ttl(ttl)),
                is_primary_key: false,
                is_auto_increment: false,
                comment: Some("Seconds until expiry; -1 means none.".into()),
                ordinal: 2,
            },
            ColumnSchema {
                name: "length".into(),
                data_type: "items".into(),
                nullable: true,
                default_value: length.map(|value| value.to_string()),
                is_primary_key: false,
                is_auto_increment: false,
                comment: None,
                ordinal: 3,
            },
        ];

        Ok(ObjectSchema {
            name: object.to_string(),
            kind: ObjectKind::Key,
            columns,
            indexes: vec![],
            foreign_keys: vec![],
        })
    }

    /// There is no DDL in Redis; show the key's type and a ready-to-run command
    /// rather than a fabricated `CREATE TABLE`.
    async fn object_ddl(
        &self,
        _database: &str,
        _namespace: Option<&str>,
        object: &str,
    ) -> Result<String> {
        let mut conn = self.handle();
        let key_type = key_type(&mut conn, object).await?;
        let command = match key_type.as_str() {
            "string" => "GET",
            "list" => "LRANGE",
            "set" => "SMEMBERS",
            "zset" => "ZRANGE",
            "hash" => "HGETALL",
            "stream" => "XRANGE",
            _ => "TYPE",
        };
        let invocation = match key_type.as_str() {
            "list" | "stream" => format!("{command} {object} - +"),
            _ => format!("{command} {object}"),
        };
        Ok(format!(
            "# Redis key: {object}\n# Type: {key_type}\n{invocation}"
        ))
    }

    /// Redis has no column metadata; nothing to feed the SQL completion.
    async fn list_table_columns(
        &self,
        _database: &str,
        _namespace: Option<&str>,
    ) -> Result<Vec<crate::models::TableColumns>> {
        Ok(vec![])
    }

    /// Exact "row" count for a key: the collection length, or 1 for a scalar.
    async fn count_rows(
        &self,
        _database: &str,
        _namespace: Option<&str>,
        object: &str,
    ) -> Result<u64> {
        let mut conn = self.handle();
        let key_type = key_type(&mut conn, object).await?;
        match key_length(&mut conn, object, &key_type).await {
            Some(length) => Ok(length.max(0) as u64),
            None if key_type == "none" => Err(DriverError::NotFound(format!(
                "key {object} does not exist"
            ))),
            None => Ok(1),
        }
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
        let commands = split_commands(&request.sql);
        if commands.is_empty() {
            return Err(DriverError::Query("no command to execute".into()));
        }

        let started = Instant::now();
        let mut conn = self.handle();
        let mut results = Vec::with_capacity(commands.len());
        for args in &commands {
            if cancel.is_cancelled() {
                break;
            }
            results.push(run_command(&mut conn, args, max_rows).await);
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

async fn key_type(conn: &mut ConnectionManager, key: &str) -> Result<String> {
    let value: String = redis::cmd("TYPE")
        .arg(key)
        .query_async(conn)
        .await
        .map_err(|e| DriverError::Introspect(e.to_string()))?;
    Ok(value.to_ascii_lowercase())
}

/// Length of a collection key, or string length for a string. `None` for a
/// missing key or a type without a length.
async fn key_length(conn: &mut ConnectionManager, key: &str, key_type: &str) -> Option<i64> {
    let command = match key_type {
        "string" => "STRLEN",
        "list" => "LLEN",
        "set" => "SCARD",
        "zset" => "ZCARD",
        "hash" => "HLEN",
        "stream" => "XLEN",
        _ => return None,
    };
    redis::cmd(command).arg(key).query_async(conn).await.ok()
}

fn format_ttl(ttl: i64) -> String {
    match ttl {
        -1 => "no expiry".to_string(),
        -2 => "missing".to_string(),
        seconds => format!("{seconds}s"),
    }
}

async fn run_command(
    conn: &mut ConnectionManager,
    args: &[String],
    max_rows: usize,
) -> StatementResult {
    let started = Instant::now();
    let mut result = StatementResult {
        statement: args.join(" "),
        is_query: true,
        columns: vec![],
        rows: vec![],
        row_count: 0,
        affected_rows: None,
        last_insert_id: None,
        execution_ms: 0,
        truncated: false,
        error: None,
    };

    let Some((name, rest)) = args.split_first() else {
        result.is_query = false;
        result.error = Some("empty command".into());
        return result;
    };

    let mut command = redis::cmd(name);
    for arg in rest {
        command.arg(arg);
    }

    match command.query_async::<RedisValue>(conn).await {
        Ok(value) => {
            let (columns, rows, truncated) = reply_to_table(&value, max_rows);
            result.columns = columns;
            result.row_count = rows.len();
            result.rows = rows;
            result.truncated = truncated;
        }
        Err(error) => {
            result.is_query = false;
            result.error = Some(error.to_string());
        }
    }

    result.execution_ms = started.elapsed().as_millis() as u64;
    result
}

// ---------------------------------------------------------------------------
// Command parsing (pure, unit tested)
// ---------------------------------------------------------------------------

/// Split the editor text into commands. One command per line; blank lines and
/// `#` comments are ignored. Redis commands have no terminator, so lines are
/// the natural separator (matching `redis-cli` pasted scripts and Lua-style
/// readability).
pub fn split_commands(script: &str) -> Vec<Vec<String>> {
    script
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                return None;
            }
            let tokens = tokenize(trimmed);
            (!tokens.is_empty()).then_some(tokens)
        })
        .collect()
}

/// Split one command line into arguments, honouring single/double quotes and
/// backslash escapes so `SET key "hello world"` stays two arguments.
fn tokenize(line: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut has_token = false;
    let mut chars = line.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            '"' | '\'' => {
                has_token = true;
                while let Some(d) = chars.next() {
                    if d == c {
                        break;
                    }
                    if d == '\\' {
                        if let Some(escaped) = chars.next() {
                            current.push(escaped);
                        }
                    } else {
                        current.push(d);
                    }
                }
            }
            c if c.is_whitespace() => {
                if has_token {
                    tokens.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            _ => {
                current.push(c);
                has_token = true;
            }
        }
    }

    if has_token {
        tokens.push(current);
    }
    tokens
}

// ---------------------------------------------------------------------------
// Reply -> rows (pure, unit tested)
// ---------------------------------------------------------------------------

/// Flatten a reply into the shared tabular shape.
///
/// * a scalar becomes a single `value` cell,
/// * an array/set of scalars becomes one row per element,
/// * an array of arrays becomes a matrix (`col_1`, `col_2`, ...),
/// * a RESP3 map becomes a `field`/`value` table.
fn reply_to_table(value: &RedisValue, max_rows: usize) -> (Vec<ColumnMeta>, Vec<Vec<Value>>, bool) {
    let (columns, rows) = match value {
        RedisValue::Array(items) | RedisValue::Set(items) => array_table(items),
        RedisValue::Map(pairs) => {
            let columns = vec![
                ColumnMeta {
                    name: "field".into(),
                    data_type: Some("string".into()),
                },
                ColumnMeta {
                    name: "value".into(),
                    data_type: Some("string".into()),
                },
            ];
            let rows = pairs
                .iter()
                .map(|(key, val)| vec![scalar_value(key), scalar_value(val)])
                .collect();
            (columns, rows)
        }
        scalar => (
            vec![ColumnMeta {
                name: "value".into(),
                data_type: Some(scalar_type(scalar).into()),
            }],
            vec![vec![scalar_value(scalar)]],
        ),
    };

    if rows.len() > max_rows {
        let mut rows = rows;
        rows.truncate(max_rows);
        (columns, rows, true)
    } else {
        (columns, rows, false)
    }
}

fn array_table(items: &[RedisValue]) -> (Vec<ColumnMeta>, Vec<Vec<Value>>) {
    let nested = !items.is_empty()
        && items
            .iter()
            .all(|item| matches!(item, RedisValue::Array(_) | RedisValue::Set(_)));

    if nested {
        let width = items
            .iter()
            .map(|item| match item {
                RedisValue::Array(inner) | RedisValue::Set(inner) => inner.len(),
                _ => 0,
            })
            .max()
            .unwrap_or(0);
        let columns = (1..=width)
            .map(|index| ColumnMeta {
                name: format!("col_{index}"),
                data_type: Some("string".into()),
            })
            .collect();
        let rows = items
            .iter()
            .map(|item| match item {
                RedisValue::Array(inner) | RedisValue::Set(inner) => {
                    let mut row: Vec<Value> = inner.iter().map(scalar_value).collect();
                    row.resize(width, Value::Null);
                    row
                }
                other => vec![scalar_value(other)],
            })
            .collect();
        (columns, rows)
    } else {
        let columns = vec![ColumnMeta {
            name: "value".into(),
            data_type: Some("string".into()),
        }];
        let rows = items.iter().map(|item| vec![scalar_value(item)]).collect();
        (columns, rows)
    }
}

fn scalar_value(value: &RedisValue) -> Value {
    match value {
        RedisValue::Nil => Value::Null,
        RedisValue::Int(number) => json!(number),
        RedisValue::Double(number) => json!(number),
        RedisValue::Boolean(flag) => json!(flag),
        RedisValue::Okay => Value::String("OK".into()),
        RedisValue::SimpleString(text) => Value::String(text.clone()),
        RedisValue::BulkString(bytes) => bytes_to_value(bytes),
        RedisValue::VerbatimString { text, .. } => Value::String(text.clone()),
        RedisValue::BigNumber(bytes) => Value::String(String::from_utf8_lossy(bytes).into()),
        RedisValue::ServerError(error) => Value::String(error.to_string()),
        RedisValue::Attribute { data, .. } => scalar_value(data),
        RedisValue::Array(items) | RedisValue::Set(items) => {
            Value::Array(items.iter().map(scalar_value).collect())
        }
        RedisValue::Map(pairs) => {
            let mut object = JsonMap::new();
            for (key, val) in pairs {
                object.insert(scalar_value(key).to_string(), scalar_value(val));
            }
            Value::Object(object)
        }
        RedisValue::Push { data, .. } => {
            if data.len() == 1 {
                scalar_value(&data[0])
            } else {
                Value::Array(data.iter().map(scalar_value).collect())
            }
        }
        // `Value` is `#[non_exhaustive]`; a future protocol reply renders as null
        // rather than failing the whole result.
        _ => Value::Null,
    }
}

fn bytes_to_value(bytes: &[u8]) -> Value {
    match std::str::from_utf8(bytes) {
        Ok(text) => Value::String(text.to_string()),
        Err(_) => {
            use base64::engine::general_purpose::STANDARD as BASE64;
            use base64::Engine;
            Value::String(format!("base64:{}", BASE64.encode(bytes)))
        }
    }
}

fn scalar_type(value: &RedisValue) -> &'static str {
    match value {
        RedisValue::Nil => "nil",
        RedisValue::Int(_) | RedisValue::BigNumber(_) => "integer",
        RedisValue::Double(_) => "double",
        RedisValue::Boolean(_) => "boolean",
        RedisValue::Okay | RedisValue::SimpleString(_) => "status",
        RedisValue::BulkString(_) | RedisValue::VerbatimString { .. } => "string",
        RedisValue::Array(_) | RedisValue::Set(_) | RedisValue::Push { .. } => "array",
        RedisValue::Map(_) => "map",
        RedisValue::ServerError(_) => "error",
        RedisValue::Attribute { data, .. } => scalar_type(data),
        _ => "value",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(host: &str, port: u16, db: Option<&str>, ssl: SslMode) -> ConnectionConfig {
        ConnectionConfig {
            driver: "redis".into(),
            host: host.into(),
            port,
            username: String::new(),
            password: None,
            database: db.map(str::to_string),
            ssl_mode: ssl,
            options: Default::default(),
        }
    }

    #[test]
    fn builds_a_url_and_escapes_credentials() {
        let mut base = config("127.0.0.1", 6379, Some("3"), SslMode::Disabled);
        assert_eq!(connection_url(&base).unwrap(), "redis://127.0.0.1:6379/3");

        base.username = "app user".into();
        base.password = Some("p@ss/word".into());
        assert_eq!(
            connection_url(&base).unwrap(),
            "redis://app%20user:p%40ss%2Fword@127.0.0.1:6379/3"
        );

        base.ssl_mode = SslMode::Required;
        assert!(connection_url(&base).unwrap().starts_with("rediss://"));

        // A blank database means index 0.
        let default_db = config("localhost", 6379, None, SslMode::Disabled);
        assert_eq!(
            connection_url(&default_db).unwrap(),
            "redis://localhost:6379/0"
        );

        assert!(connection_url(&config("", 6379, None, SslMode::Disabled)).is_err());
        assert!(connection_url(&config("h", 6379, Some("db1"), SslMode::Disabled)).is_err());
    }

    #[test]
    fn splits_commands_one_per_line_and_skips_noise() {
        let script = "# a comment\n\n  SET key \"hello world\"  \nLPUSH list a b c\n   \n";
        let commands = split_commands(script);
        assert_eq!(commands.len(), 2);
        assert_eq!(commands[0], vec!["SET", "key", "hello world"]);
        assert_eq!(commands[1], vec!["LPUSH", "list", "a", "b", "c"]);
    }

    #[test]
    fn tokenizes_quotes_and_escapes() {
        assert_eq!(tokenize("GET key"), vec!["GET", "key"]);
        assert_eq!(tokenize("SET k 'a b'"), vec!["SET", "k", "a b"]);
        assert_eq!(tokenize("SET k \"a\\\"b\""), vec!["SET", "k", "a\"b"]);
        // An empty quoted argument is still an argument.
        assert_eq!(tokenize("GET \"\""), vec!["GET", ""]);
        assert_eq!(tokenize("   "), Vec::<String>::new());
    }

    #[test]
    fn maps_scalar_replies_to_a_single_cell() {
        let (columns, rows, truncated) = reply_to_table(&RedisValue::Int(42), 10);
        assert_eq!(columns.len(), 1);
        assert_eq!(columns[0].name, "value");
        assert_eq!(columns[0].data_type.as_deref(), Some("integer"));
        assert_eq!(rows, vec![vec![json!(42)]]);
        assert!(!truncated);

        let (_, rows, _) = reply_to_table(&RedisValue::Nil, 10);
        assert_eq!(rows, vec![vec![Value::Null]]);

        let (_, rows, _) = reply_to_table(&RedisValue::BulkString(b"hello".to_vec()), 10);
        assert_eq!(rows, vec![vec![Value::String("hello".into())]]);
    }

    #[test]
    fn maps_array_replies_one_row_per_element() {
        let value = RedisValue::Array(vec![
            RedisValue::BulkString(b"a".to_vec()),
            RedisValue::BulkString(b"b".to_vec()),
        ]);
        let (columns, rows, truncated) = reply_to_table(&value, 10);
        assert_eq!(columns.len(), 1);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1][0], Value::String("b".into()));
        assert!(!truncated);
    }

    #[test]
    fn maps_nested_arrays_and_maps() {
        let matrix = RedisValue::Array(vec![
            RedisValue::Array(vec![RedisValue::Int(1), RedisValue::Int(2)]),
            RedisValue::Array(vec![RedisValue::Int(3)]),
        ]);
        let (columns, rows, _) = reply_to_table(&matrix, 10);
        assert_eq!(columns.len(), 2);
        assert_eq!(columns[1].name, "col_2");
        assert_eq!(rows[1], vec![json!(3), Value::Null]);

        let map = RedisValue::Map(vec![(
            RedisValue::BulkString(b"field".to_vec()),
            RedisValue::BulkString(b"value".to_vec()),
        )]);
        let (columns, rows, _) = reply_to_table(&map, 10);
        assert_eq!(columns.len(), 2);
        assert_eq!(columns[0].name, "field");
        assert_eq!(rows[0][1], Value::String("value".into()));
    }

    #[test]
    fn truncates_long_replies() {
        let value = RedisValue::Array(vec![
            RedisValue::Int(1),
            RedisValue::Int(2),
            RedisValue::Int(3),
        ]);
        let (_, rows, truncated) = reply_to_table(&value, 2);
        assert_eq!(rows.len(), 2);
        assert!(truncated);
    }

    /// The Redis surface is advertised, not implied: these flags are what the
    /// UI and the IPC guards read, so lock them down.
    #[test]
    fn capabilities_hide_every_sql_shaped_surface() {
        let caps = capabilities();
        assert!(!caps.is_relational);
        assert!(!caps.supports_ddl);
        assert!(!caps.supports_explain);
        assert!(!caps.supports_schemas);
        assert!(!caps.supports_multiple_databases);
        assert!(!caps.supports_transactions);
        assert_eq!(caps.object_kinds, vec![ObjectKind::Key]);
        assert_eq!(caps.supported_actions, vec![ObjectAction::Inspect]);
    }

    #[test]
    fn parses_versions_and_ttl_labels() {
        assert_eq!(parse_redis_version("7.2.4"), Some(70204));
        assert_eq!(parse_redis_version("6.0"), Some(60000));
        assert_eq!(format_ttl(-1), "no expiry");
        assert_eq!(format_ttl(-2), "missing");
        assert_eq!(format_ttl(30), "30s");
    }

    /// End-to-end against a real server, skipped unless one is provided:
    ///
    /// ```text
    /// QUARRY_TEST_REDIS_HOST=127.0.0.1 cargo test -- --ignored
    /// ```
    #[tokio::test]
    #[ignore = "needs a reachable Redis server (see module docs)"]
    async fn connects_lists_keys_and_runs_commands() {
        let Ok(host) = std::env::var("QUARRY_TEST_REDIS_HOST") else {
            eprintln!("skipping: QUARRY_TEST_REDIS_HOST is not set");
            return;
        };
        let config = ConnectionConfig {
            driver: "redis".into(),
            host,
            port: std::env::var("QUARRY_TEST_REDIS_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(6379),
            username: std::env::var("QUARRY_TEST_REDIS_USER").unwrap_or_default(),
            password: std::env::var("QUARRY_TEST_REDIS_PASSWORD").ok(),
            database: None,
            ssl_mode: SslMode::Disabled,
            options: Default::default(),
        };

        let driver = RedisDriver::new();
        let info = driver.test(&config).await.expect("server info");
        assert!(info.version.is_some());

        let connection = driver.connect(&config).await.expect("connect");
        let response = connection
            .execute(QueryRequest {
                database: None,
                sql: "SET quarry:test 1\nGET quarry:test".into(),
                max_rows: Some(10),
                timeout_ms: None,
                run_id: None,
            })
            .await
            .expect("execute");
        assert_eq!(response.results.len(), 2);
        assert_eq!(response.results[1].rows[0][0], Value::String("1".into()));

        let _ = connection
            .execute(QueryRequest {
                database: None,
                sql: "DEL quarry:test".into(),
                max_rows: Some(10),
                timeout_ms: None,
                run_id: None,
            })
            .await;
    }
}
