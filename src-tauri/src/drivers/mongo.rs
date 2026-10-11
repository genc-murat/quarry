//! MongoDB driver.
//!
//! MongoDB is document oriented: there are no tables, columns are not fixed and
//! there is no SQL. Like the Redis adapter it is expressed through
//! [`DriverCapabilities`] (`ResultShape::Document`, `isRelational: false`,
//! `supportsDdl: false`, ...) so the rest of the app stays driver-agnostic.
//!
//! * The editor text is a sequence of JSON command documents, for example
//!   `{"find": "users", "filter": {"age": {"$gt": 21}}}`. Documents may be laid
//!   out over several lines; `//` and `#` comment lines are ignored.
//! * `find` and `aggregate` cursors are drained with `getMore` up to the row
//!   limit; any other command replies with a single document.
//! * Reply documents are flattened into the shared columns/rows shape. Nested
//!   values stay as JSON, and BSON types use relaxed extended JSON (`$oid`,
//!   `$date`, ...).
//! * The explorer lists collections and views. Collection columns are inferred
//!   from a bounded sample of documents, and indexes come from `listIndexes`.

use std::collections::{HashMap, HashSet};
use std::future::IntoFuture;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures_util::TryStreamExt;
use mongodb::bson::{doc, Bson, Document};
use mongodb::options::ClientOptions;
use mongodb::results::{CollectionSpecification, CollectionType};
use mongodb::{Client, Database, IndexModel};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde_json::{json, Value};

use super::{build_object_schema, Connection, DatabaseDriver};
use crate::error::{DriverError, Result};
use crate::models::{
    ColumnMeta, ColumnSchema, ConfigField, ConnectionConfig, DatabaseInfo, DatabaseObject,
    DriverCapabilities, FieldType, IndexSchema, NamespaceInfo, ObjectAction, ObjectKind,
    ObjectSchema, QueryLanguage, QueryRequest, QueryResponse, ResultShape, SelectOption,
    ServerInfo, SslMode, StatementResult, TableColumns,
};

const ACCENT: &str = "#47A248";
const DEFAULT_PORT: u16 = 27017;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Documents read from a collection to infer its columns.
const SAMPLE_DOCS: i64 = 200;
/// Largest `batchSize` requested from a `getMore`.
const MAX_BATCH: usize = 1000;
/// Rows returned when the request does not set `maxRows`.
const DEFAULT_MAX_ROWS: usize = 1000;
/// System databases that the explorer marks as such.
const SYSTEM_DATABASES: [&str; 3] = ["admin", "config", "local"];

pub struct MongoDriver;

impl MongoDriver {
    pub fn new() -> Self {
        MongoDriver
    }
}

impl Default for MongoDriver {
    fn default() -> Self {
        Self::new()
    }
}

fn capabilities() -> DriverCapabilities {
    DriverCapabilities {
        query_language: QueryLanguage::Mongo,
        result_shape: ResultShape::Document,
        is_relational: false,
        supports_multiple_databases: true,
        supports_schemas: false,
        supports_transactions: false,
        supports_ddl: false,
        // MongoDB has no `EXPLAIN` prefix, so `explain_statement` (which gates
        // on this flag) answers `None` rather than an invalid statement.
        supports_explain: false,
        // Commands run on the server's own cursor handling; there is no
        // server-side cancel wired up for them.
        supports_cancel: false,
        object_kinds: vec![ObjectKind::Collection, ObjectKind::View],
        // Read-only surface for now: schema inspection, data preview, counting
        // and copying the name. Writes go through commands in the editor.
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
            default_value: Some(json!("127.0.0.1")),
            options: vec![],
            help: None,
        },
        ConfigField {
            key: "port".into(),
            label: "Port".into(),
            field_type: FieldType::Number,
            placeholder: Some("27017".into()),
            required: true,
            default_value: Some(json!(DEFAULT_PORT)),
            options: vec![],
            help: None,
        },
        ConfigField {
            key: "username".into(),
            label: "Username".into(),
            field_type: FieldType::Text,
            placeholder: Some("app".into()),
            required: false,
            default_value: None,
            options: vec![],
            help: Some(
                "Optional. Authenticates against the database below, or admin when it is empty."
                    .into(),
            ),
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
            placeholder: Some("app".into()),
            required: false,
            default_value: None,
            options: vec![],
            help: Some("Optional default database for commands that do not name one.".into()),
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
                    label: "Required".into(),
                },
            ],
            help: Some("Required connects with TLS using the system certificate store.".into()),
        },
    ]
}

/// Build a `mongodb://` URI. Credentials are percent-encoded so characters such
/// as `@`, `:` or `/` in a password cannot change the URI structure.
fn connection_url(config: &ConnectionConfig) -> Result<String> {
    let host = config.host.trim();
    if host.is_empty() {
        return Err(DriverError::Config("a host is required".into()));
    }
    let user = config.username.trim();
    let credentials = match (user.is_empty(), config.password.as_deref()) {
        (true, _) => String::new(),
        (false, None | Some("")) => format!("{}@", encode(user)),
        (false, Some(password)) => format!("{}:{}@", encode(user), encode(password)),
    };
    let path = match non_empty(config.database.as_deref()) {
        Some(database) => format!("/{}", encode(&database)),
        None => "/".to_string(),
    };
    let query = if config.ssl_mode == SslMode::Required {
        "?tls=true"
    } else {
        ""
    };
    Ok(format!(
        "mongodb://{credentials}{host}:{}{path}{query}",
        config.port
    ))
}

fn encode(value: &str) -> String {
    utf8_percent_encode(value, NON_ALPHANUMERIC).to_string()
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

async fn connect_client(config: &ConnectionConfig) -> Result<Client> {
    let url = connection_url(config)?;
    let mut options = ClientOptions::parse(url)
        .await
        .map_err(|e| DriverError::Config(e.to_string()))?;
    options.app_name = Some("Quarry".into());
    options.connect_timeout = Some(CONNECT_TIMEOUT);
    options.server_selection_timeout = Some(CONNECT_TIMEOUT);
    Client::with_options(options).map_err(|e| DriverError::Config(e.to_string()))
}

/// Bound a server call so an unreachable host cannot stall the UI.
async fn with_timeout<T>(future: impl IntoFuture<Output = mongodb::error::Result<T>>) -> Result<T> {
    tokio::time::timeout(CONNECT_TIMEOUT, future.into_future())
        .await
        .map_err(|_| {
            DriverError::Connect(format!(
                "connection timed out after {}s",
                CONNECT_TIMEOUT.as_secs()
            ))
        })?
        .map_err(|e| DriverError::Connect(e.to_string()))
}

/// `ping` plus `buildInfo`. Both must succeed, so bad credentials or a wrong
/// host fail here rather than on the first query.
async fn fetch_server_info(client: &Client, config: &ConnectionConfig) -> Result<ServerInfo> {
    let admin = client.database("admin");
    with_timeout(admin.run_command(doc! { "ping": 1 })).await?;
    let build = with_timeout(admin.run_command(doc! { "buildInfo": 1 })).await?;
    let version = build.get_str("version").ok().map(str::to_string);

    Ok(ServerInfo {
        version_number: version.as_deref().and_then(parse_version),
        version,
        server_comment: Some("MongoDB".into()),
        current_database: non_empty(config.database.as_deref()),
        current_user: non_empty(Some(&config.username)),
        supports_tls: config.ssl_mode == SslMode::Required,
    })
}

#[async_trait]
impl DatabaseDriver for MongoDriver {
    fn id(&self) -> &'static str {
        "mongodb"
    }

    fn display_name(&self) -> &'static str {
        "MongoDB"
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

    async fn test(&self, config: &ConnectionConfig) -> Result<ServerInfo> {
        let client = connect_client(config).await?;
        fetch_server_info(&client, config).await
    }

    async fn connect(&self, config: &ConnectionConfig) -> Result<Arc<dyn Connection>> {
        let client = connect_client(config).await?;
        let info = fetch_server_info(&client, config).await?;
        Ok(Arc::new(MongoConnection {
            driver: MongoDriver::new(),
            client,
            info,
            default_database: non_empty(config.database.as_deref()),
        }))
    }
}

pub struct MongoConnection {
    /// The driver this connection was opened by. [`MongoDriver`] is a stateless
    /// declaration, so the connection carries it and answers what the engine
    /// says about itself (its id, capabilities, dialect and lack of EXPLAIN)
    /// from here instead of repeating it.
    driver: MongoDriver,
    client: Client,
    info: ServerInfo,
    default_database: Option<String>,
}

impl MongoConnection {
    /// The database a request runs against: the explicit one, else the profile's
    /// default. MongoDB has no implicit "current" database, so one must exist.
    fn target_database(&self, requested: Option<&str>) -> Result<String> {
        non_empty(requested)
            .or_else(|| self.default_database.clone())
            .ok_or_else(|| DriverError::Query("no database selected".into()))
    }
}

#[async_trait]
impl Connection for MongoConnection {
    fn driver(&self) -> &dyn DatabaseDriver {
        &self.driver
    }

    fn server_info(&self) -> &ServerInfo {
        &self.info
    }

    async fn ping(&self) -> Result<()> {
        with_timeout(
            self.client
                .database("admin")
                .run_command(doc! { "ping": 1 }),
        )
        .await
        .map(|_| ())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        let names = self
            .client
            .list_database_names()
            .await
            .map_err(introspect_error)?;
        Ok(names
            .into_iter()
            .map(|name| DatabaseInfo {
                is_system: SYSTEM_DATABASES.contains(&name.as_str()),
                name,
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
        let specs = list_collection_specs(&self.client.database(database)).await?;
        Ok(specs
            .into_iter()
            .map(|spec| DatabaseObject {
                kind: kind_of(&spec.collection_type),
                name: spec.name,
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
        let db = self.client.database(database);
        let kind = collection_kind(&db, object).await?;
        let collection = db.collection::<Document>(object);

        let sample: Vec<Document> = collection
            .find(doc! {})
            .limit(SAMPLE_DOCS)
            .await
            .map_err(introspect_error)?
            .try_collect()
            .await
            .map_err(introspect_error)?;
        let columns = infer_columns(&sample);

        let indexes = collection
            .list_indexes()
            .await
            .map_err(introspect_error)?
            .try_collect::<Vec<IndexModel>>()
            .await
            .map_err(introspect_error)?
            .into_iter()
            .map(index_schema)
            .collect();

        Ok(build_object_schema(object, kind, columns, indexes, vec![]))
    }

    /// Columns come from sampled documents, so autocompletion for MongoDB is
    /// left to the query language itself. Walking every collection here would
    /// cost one sampling round trip per collection.
    async fn list_table_columns(
        &self,
        _database: &str,
        _namespace: Option<&str>,
    ) -> Result<Vec<TableColumns>> {
        Ok(vec![])
    }

    /// There is no DDL. A collection is described by a runnable `create`
    /// command; views are described by their pipeline, which is not stored
    /// as a command here.
    async fn object_ddl(
        &self,
        database: &str,
        _namespace: Option<&str>,
        object: &str,
    ) -> Result<String> {
        let kind = collection_kind(&self.client.database(database), object).await?;
        Ok(match kind {
            ObjectKind::View => format!(
                "// view {object} is defined by its pipeline; see the listCollections output"
            ),
            _ => format!("// collection {object}\n{}", json!({ "create": object })),
        })
    }

    async fn count_rows(
        &self,
        database: &str,
        _namespace: Option<&str>,
        object: &str,
    ) -> Result<u64> {
        self.client
            .database(database)
            .collection::<Document>(object)
            .count_documents(doc! {})
            .await
            .map_err(|e| DriverError::Query(e.to_string()))
    }

    async fn execute(&self, request: QueryRequest) -> Result<QueryResponse> {
        let max_rows = request
            .max_rows
            .map(|rows| rows.max(1) as usize)
            .unwrap_or(DEFAULT_MAX_ROWS);
        let commands = parse_commands(&request.sql)?;
        if commands.is_empty() {
            return Err(DriverError::Query("no command to execute".into()));
        }

        let database = self.target_database(request.database.as_deref())?;
        let db = self.client.database(&database);
        let started = Instant::now();
        let mut results = Vec::with_capacity(commands.len());
        for (statement, command) in commands {
            results.push(run_command(&db, statement, command, max_rows).await);
        }

        Ok(QueryResponse {
            results,
            total_ms: started.elapsed().as_millis() as u64,
        })
    }
}

fn introspect_error(error: mongodb::error::Error) -> DriverError {
    DriverError::Introspect(error.to_string())
}

fn kind_of(collection_type: &CollectionType) -> ObjectKind {
    match collection_type {
        CollectionType::View => ObjectKind::View,
        _ => ObjectKind::Collection,
    }
}

async fn list_collection_specs(db: &Database) -> Result<Vec<CollectionSpecification>> {
    db.list_collections()
        .await
        .map_err(introspect_error)?
        .try_collect()
        .await
        .map_err(introspect_error)
}

/// Kind of a named collection or view. Missing names are `NotFound` so the
/// inspector reports them instead of showing an empty collection.
async fn collection_kind(db: &Database, name: &str) -> Result<ObjectKind> {
    list_collection_specs(db)
        .await?
        .into_iter()
        .find(|spec| spec.name == name)
        .map(|spec| kind_of(&spec.collection_type))
        .ok_or_else(|| DriverError::NotFound(format!("collection {name} does not exist")))
}

fn index_schema(model: IndexModel) -> IndexSchema {
    let columns: Vec<String> = model.keys.keys().cloned().collect();
    let options = model.options.unwrap_or_default();
    let name = options.name.clone().unwrap_or_else(|| columns.join("_"));
    IndexSchema {
        primary: name == "_id_",
        unique: options.unique.unwrap_or(false),
        name,
        columns,
    }
}

/// Infer the top-level fields of a collection from sampled documents. A field
/// missing from some sampled documents, or null in one, is nullable. `_id`
/// always comes first, and the rest keep first-seen order.
fn infer_columns(sample: &[Document]) -> Vec<ColumnSchema> {
    struct Field {
        name: String,
        types: Vec<&'static str>,
        present: usize,
        has_null: bool,
    }

    let mut fields: Vec<Field> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for document in sample {
        for (key, value) in document.iter() {
            let position = *index.entry(key.clone()).or_insert_with(|| {
                fields.push(Field {
                    name: key.clone(),
                    types: Vec::new(),
                    present: 0,
                    has_null: false,
                });
                fields.len() - 1
            });
            let field = &mut fields[position];
            field.present += 1;
            if matches!(value, Bson::Null) {
                field.has_null = true;
            }
            let type_name = bson_type_name(value);
            if !field.types.contains(&type_name) {
                field.types.push(type_name);
            }
        }
    }

    fields.sort_by_key(|field| field.name != "_id");
    let total = sample.len();
    fields
        .into_iter()
        .enumerate()
        .map(|(position, field)| ColumnSchema {
            is_primary_key: field.name == "_id",
            nullable: field.present < total || field.has_null,
            name: field.name,
            data_type: field.types.join(" | "),
            default_value: None,
            is_auto_increment: false,
            comment: None,
            ordinal: position as u32 + 1,
        })
        .collect()
}

/// The BSON type name shown in the inspector, following the `$type` aliases.
fn bson_type_name(value: &Bson) -> &'static str {
    match value {
        Bson::Double(_) => "double",
        Bson::String(_) => "string",
        Bson::Array(_) => "array",
        Bson::Document(_) => "object",
        Bson::Boolean(_) => "bool",
        Bson::Null => "null",
        Bson::RegularExpression(_) => "regex",
        Bson::JavaScriptCode(_) | Bson::JavaScriptCodeWithScope(_) => "javascript",
        Bson::Int32(_) => "int",
        Bson::Int64(_) => "long",
        Bson::Timestamp(_) => "timestamp",
        Bson::Binary(_) => "binData",
        Bson::ObjectId(_) => "objectId",
        Bson::DateTime(_) => "date",
        Bson::Symbol(_) => "symbol",
        Bson::Decimal128(_) => "decimal",
        Bson::Undefined => "undefined",
        Bson::MaxKey => "maxKey",
        Bson::MinKey => "minKey",
        Bson::DbPointer(_) => "dbPointer",
    }
}

fn parse_version(version: &str) -> Option<u64> {
    let mut parts = version
        .split('.')
        .map(|part| {
            part.chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
        })
        .filter_map(|part| part.parse::<u64>().ok());
    let major = parts.next()?;
    let minor = parts.next().unwrap_or(0);
    let patch = parts.next().unwrap_or(0);
    Some(major * 10_000 + minor * 100 + patch)
}

// ---------------------------------------------------------------------------
// Command parsing (pure, unit tested)
// ---------------------------------------------------------------------------

/// Split the editor text into JSON command documents. Each top-level `{...}`
/// is one command, so a command may span several lines and commas or
/// semicolons between commands are optional. `//` and `#` lines are comments.
pub fn split_documents(script: &str) -> std::result::Result<Vec<String>, String> {
    let stripped: String = script
        .lines()
        .filter(|line| {
            let trimmed = line.trim_start();
            !(trimmed.starts_with("//") || trimmed.starts_with('#'))
        })
        .collect::<Vec<_>>()
        .join("\n");

    let mut documents = Vec::new();
    let mut depth = 0usize;
    let mut start = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    for (index, c) in stripped.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' if depth > 0 => in_string = true,
            '{' => {
                if depth == 0 {
                    start = index;
                }
                depth += 1;
            }
            '}' => {
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| "unexpected `}` outside a command".to_string())?;
                if depth == 0 {
                    documents.push(stripped[start..=index].to_string());
                }
            }
            c if depth == 0 && !c.is_whitespace() && c != ',' && c != ';' => {
                return Err(format!(
                    "expected a JSON command such as {{\"find\": \"users\"}}, found `{c}`"
                ));
            }
            '[' => depth += 1,
            ']' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }

    if depth != 0 || in_string {
        return Err("unterminated command document".into());
    }
    Ok(documents)
}

/// Parse every command in the script into a BSON document.
fn parse_commands(script: &str) -> Result<Vec<(String, Document)>> {
    split_documents(script)
        .map_err(DriverError::Query)?
        .into_iter()
        .map(|text| {
            let value: Value = serde_json::from_str(&text)
                .map_err(|e| DriverError::Query(format!("invalid JSON command: {e}")))?;
            let document = match Bson::try_from(value) {
                Ok(Bson::Document(document)) => document,
                _ => {
                    return Err(DriverError::Query(
                        "each command must be a JSON object".into(),
                    ))
                }
            };
            if document.is_empty() {
                return Err(DriverError::Query("empty command document".into()));
            }
            Ok((text, document))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Running commands and building result tables
// ---------------------------------------------------------------------------

/// The shared table shape, built from one command's reply.
struct Table {
    columns: Vec<ColumnMeta>,
    rows: Vec<Vec<Value>>,
    truncated: bool,
}

async fn run_command(
    db: &Database,
    statement: String,
    command: Document,
    max_rows: usize,
) -> StatementResult {
    let started = Instant::now();
    let outcome = run(db, command, max_rows).await;

    let mut result = StatementResult {
        statement,
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

async fn run(
    db: &Database,
    mut command: Document,
    max_rows: usize,
) -> std::result::Result<Table, String> {
    let name = command.keys().next().cloned().unwrap_or_default();
    match name.as_str() {
        "find" => drain_cursor(db, command, max_rows).await,
        "aggregate" => {
            // An aggregate must carry a cursor option to return a cursor.
            if !command.contains_key("cursor") {
                command.insert("cursor", doc! {});
            }
            drain_cursor(db, command, max_rows).await
        }
        _ => {
            let reply = db.run_command(command).await.map_err(|e| e.to_string())?;
            Ok(documents_table(&[reply], max_rows))
        }
    }
}

/// Read a `find`/`aggregate` cursor, continuing with `getMore` until the row
/// limit is passed. One extra row is fetched to tell whether the result was
/// truncated. A cursor left open is closed with `killCursors`.
async fn drain_cursor(
    db: &Database,
    command: Document,
    max_rows: usize,
) -> std::result::Result<Table, String> {
    let reply = db.run_command(command).await.map_err(|e| e.to_string())?;
    let cursor = reply
        .get_document("cursor")
        .map_err(|_| "reply did not include a cursor".to_string())?;
    let mut cursor_id = cursor.get_i64("id").unwrap_or(0);
    let collection = cursor
        .get_str("ns")
        .ok()
        .and_then(|ns| ns.split_once('.').map(|(_, name)| name.to_string()))
        .unwrap_or_default();
    let mut documents = batch(cursor, "firstBatch");

    while cursor_id != 0 && documents.len() <= max_rows {
        let wanted = (max_rows + 1 - documents.len()).min(MAX_BATCH) as i64;
        let more = db
            .run_command(doc! {
                "getMore": cursor_id,
                "collection": &collection,
                "batchSize": wanted,
            })
            .await
            .map_err(|e| e.to_string())?;
        let next = more
            .get_document("cursor")
            .map_err(|_| "getMore reply did not include a cursor".to_string())?;
        cursor_id = next.get_i64("id").unwrap_or(0);
        let next_batch = batch(next, "nextBatch");
        let empty = next_batch.is_empty();
        documents.extend(next_batch);
        if empty {
            break;
        }
    }

    if cursor_id != 0 {
        // Best effort: the server reclaims idle cursors on its own anyway.
        let _ = db
            .run_command(doc! { "killCursors": &collection, "cursors": [cursor_id] })
            .await;
    }

    Ok(documents_table(&documents, max_rows))
}

fn batch(cursor: &Document, field: &str) -> Vec<Document> {
    cursor
        .get_array(field)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| match item {
                    Bson::Document(document) => Some(document.clone()),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Flatten documents into columns and rows. Columns are the union of top-level
/// keys in first-seen order; a missing key becomes null in that row.
fn documents_table(documents: &[Document], max_rows: usize) -> Table {
    let mut names: Vec<String> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for document in documents {
        for key in document.keys() {
            if seen.insert(key.as_str()) {
                names.push(key.clone());
            }
        }
    }

    let columns = names
        .iter()
        .map(|name| ColumnMeta {
            name: name.clone(),
            data_type: None,
        })
        .collect();
    let rows = documents
        .iter()
        .take(max_rows)
        .map(|document| {
            names
                .iter()
                .map(|name| {
                    document
                        .get(name)
                        .cloned()
                        .map(Bson::into_relaxed_extjson)
                        .unwrap_or(Value::Null)
                })
                .collect()
        })
        .collect();

    Table {
        columns,
        rows,
        truncated: documents.len() > max_rows,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ObjectAction, ObjectKind};

    fn config(host: &str, port: u16, db: Option<&str>, ssl: SslMode) -> ConnectionConfig {
        ConnectionConfig {
            driver: "mongodb".into(),
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
    fn builds_a_uri_and_escapes_credentials() {
        let mut base = config("127.0.0.1", 27017, None, SslMode::Disabled);
        assert_eq!(connection_url(&base).unwrap(), "mongodb://127.0.0.1:27017/");

        base.database = Some("shop".into());
        assert_eq!(
            connection_url(&base).unwrap(),
            "mongodb://127.0.0.1:27017/shop"
        );

        base.username = "app user".into();
        base.password = Some("p@ss/word".into());
        assert_eq!(
            connection_url(&base).unwrap(),
            "mongodb://app%20user:p%40ss%2Fword@127.0.0.1:27017/shop"
        );

        base.password = None;
        assert_eq!(
            connection_url(&base).unwrap(),
            "mongodb://app%20user@127.0.0.1:27017/shop"
        );

        base.ssl_mode = SslMode::Required;
        assert!(connection_url(&base).unwrap().ends_with("?tls=true"));

        assert!(connection_url(&config("  ", 27017, None, SslMode::Disabled)).is_err());
    }

    #[test]
    fn splits_multi_line_documents_and_skips_comments() {
        let script = "// first\n{\"find\": \"users\",\n  \"filter\": {\"a\": {\"$gt\": 1}}}\n# note\n{\"ping\": 1};\n{\"find\": \"s\", \"filter\": {\"text\": \"}{ \\\"quoted\\\" \"}}";
        let documents = split_documents(script).unwrap();
        assert_eq!(documents.len(), 3);
        assert!(documents[0].starts_with("{\"find\": \"users\""));
        assert_eq!(documents[1], "{\"ping\": 1}");
        assert!(documents[2].ends_with("\"}}"));
    }

    #[test]
    fn rejects_text_outside_documents_and_unterminated_input() {
        assert!(split_documents("SELECT * FROM users").is_err());
        assert!(split_documents("{\"find\": \"users\"").is_err());
        assert!(split_documents("{\"find\": \"unclosed").is_err());
        assert!(split_documents("}").is_err());
        assert_eq!(split_documents("  \n  ").unwrap(), Vec::<String>::new());
    }

    #[test]
    fn parses_commands_into_documents() {
        let commands = parse_commands("{\"find\": \"users\", \"limit\": 5}").unwrap();
        assert_eq!(commands.len(), 1);
        assert_eq!(
            commands[0].1.keys().next().map(String::as_str),
            Some("find")
        );

        assert!(parse_commands("{\"find\": ").is_err());
        assert!(parse_commands("{}").is_err());
    }

    #[test]
    fn documents_flatten_into_union_columns() {
        let first = doc! { "_id": 1, "name": "Ada" };
        let second = doc! { "_id": 2, "age": 36 };
        let table = documents_table(&[first, second], 10);
        let names: Vec<&str> = table.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["_id", "name", "age"]);
        assert_eq!(table.rows[0], vec![json!(1), json!("Ada"), Value::Null]);
        assert_eq!(table.rows[1], vec![json!(2), Value::Null, json!(36)]);
        assert!(!table.truncated);
    }

    #[test]
    fn documents_truncate_at_the_row_limit() {
        let docs = vec![doc! { "n": 1 }, doc! { "n": 2 }, doc! { "n": 3 }];
        let table = documents_table(&docs, 2);
        assert_eq!(table.rows.len(), 2);
        assert!(table.truncated);
    }

    #[test]
    fn bson_values_use_relaxed_extended_json() {
        let table = documents_table(&[doc! { "count": 7_i64, "tags": ["a", "b"] }], 10);
        assert_eq!(table.rows[0][0], json!(7));
        assert_eq!(table.rows[0][1], json!(["a", "b"]));
    }

    #[test]
    fn infers_columns_with_nullability_and_id_first() {
        let sample = vec![
            doc! { "name": "Ada", "_id": 1 },
            doc! { "_id": 2, "name": Bson::Null, "age": 36 },
        ];
        let columns = infer_columns(&sample);
        assert_eq!(columns[0].name, "_id");
        assert!(columns[0].is_primary_key);
        assert!(!columns[0].nullable);
        assert_eq!(columns[1].name, "name");
        assert!(columns[1].nullable);
        let age = columns.iter().find(|c| c.name == "age").unwrap();
        assert!(age.nullable);
        assert_eq!(age.data_type, "int");
    }

    #[test]
    fn capabilities_hide_every_sql_surface() {
        let caps = capabilities();
        assert_eq!(caps.query_language, QueryLanguage::Mongo);
        assert_eq!(caps.result_shape, ResultShape::Document);
        assert!(!caps.is_relational);
        assert!(!caps.supports_ddl);
        assert!(!caps.supports_explain);
        assert!(!caps.supports_schemas);
        assert!(caps.supports_multiple_databases);
        assert!(caps.object_kinds.contains(&ObjectKind::Collection));
        assert!(caps.supported_actions.contains(&ObjectAction::ViewData));
        assert!(!caps.supported_actions.contains(&ObjectAction::DropObject));
    }

    #[test]
    fn config_fields_match_the_connection_form_contract() {
        let fields = config_fields();
        let keys: Vec<&str> = fields.iter().map(|f| f.key.as_str()).collect();
        assert_eq!(
            keys,
            vec!["host", "port", "username", "password", "database", "sslMode"]
        );
        assert!(fields.iter().any(|f| f.field_type == FieldType::Password));
    }

    #[test]
    fn parses_versions() {
        assert_eq!(parse_version("7.0.5"), Some(70005));
        assert_eq!(parse_version("6.0"), Some(60000));
        assert_eq!(parse_version("8.0.0-rc1"), Some(80000));
    }

    #[test]
    fn keeps_strings_with_braces_and_escaped_quotes_inside_one_command() {
        let script = r#"{"find": "logs", "filter": {"msg": "a } \"quoted\" { b"}}"#;
        let documents = split_documents(script).unwrap();
        assert_eq!(documents, vec![script.to_string()]);
    }

    #[test]
    fn commands_may_be_separated_by_commas_or_semicolons() {
        let documents = split_documents("{\"ping\": 1},{\"ping\": 1};{\"ping\": 1}").unwrap();
        assert_eq!(documents.len(), 3);
    }

    #[test]
    fn nested_arrays_stay_inside_their_command() {
        let script = "{\"insert\": \"c\", \"documents\": [{\"a\": 1}, {\"b\": [2, 3]}]}";
        assert_eq!(split_documents(script).unwrap().len(), 1);
    }

    #[test]
    fn rejects_top_level_arrays_and_unbalanced_brackets() {
        assert!(split_documents("[{\"ping\": 1}]").is_err());
        assert!(split_documents("{\"find\": [1, 2}").is_err());
    }

    #[test]
    fn rejects_bare_strings_between_commands() {
        assert!(parse_commands("{\"find\": \"c\"}\n\"just a string\"").is_err());
    }

    #[test]
    fn converts_extended_json_values_to_bson_types() {
        let commands = parse_commands(
            "{\"find\": \"c\", \"filter\": {\"_id\": {\"$oid\": \"64b64c6f8f1b2c3d4e5f6a7b\"}}}",
        )
        .unwrap();
        let filter = commands[0].1.get_document("filter").unwrap();
        assert!(matches!(filter.get("_id"), Some(Bson::ObjectId(_))));
    }

    /// Cursor draining (`getMore`), row truncation and per-statement errors
    /// against a real server. Uses the same environment variables as the
    /// test below.
    #[tokio::test]
    #[ignore = "needs a reachable MongoDB server (see module docs)"]
    async fn drains_cursors_and_reports_statement_errors() {
        let Ok(host) = std::env::var("QUARRY_TEST_MONGO_HOST") else {
            eprintln!("skipping: QUARRY_TEST_MONGO_HOST is not set");
            return;
        };
        let config = ConnectionConfig {
            driver: "mongodb".into(),
            host,
            port: std::env::var("QUARRY_TEST_MONGO_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(DEFAULT_PORT),
            username: std::env::var("QUARRY_TEST_MONGO_USER").unwrap_or_default(),
            password: std::env::var("QUARRY_TEST_MONGO_PASSWORD").ok(),
            database: Some("quarry_test".into()),
            ssl_mode: SslMode::Disabled,
            options: Default::default(),
        };
        let connection = MongoDriver::new().connect(&config).await.expect("connect");
        let run = |sql: &str, max_rows: u32| QueryRequest {
            database: Some("quarry_test".into()),
            sql: sql.into(),
            max_rows: Some(max_rows),
            timeout_ms: None,
            run_id: None,
        };

        // Missing collection on drop is fine; the insert is what matters.
        let _ = connection
            .execute(run("{\"drop\": \"quarry_many\"}", 1))
            .await;
        let inserted = connection
            .execute(run(
                "{\"insert\": \"quarry_many\", \"documents\": [{\"n\": 1}, {\"n\": 2}, {\"n\": 3}, {\"n\": 4}, {\"n\": 5}]}",
                1,
            ))
            .await
            .expect("insert");
        assert!(inserted.results[0].error.is_none());

        // The limit is passed: two rows come back and the result is truncated.
        let limited = connection
            .execute(run("{\"find\": \"quarry_many\", \"sort\": {\"n\": 1}}", 2))
            .await
            .expect("find limited");
        assert_eq!(limited.results[0].row_count, 2);
        assert!(limited.results[0].truncated);

        // A batch size of 2 forces `getMore` to drain the rest of the cursor.
        let drained = connection
            .execute(run(
                "{\"aggregate\": \"quarry_many\", \"pipeline\": [{\"$sort\": {\"n\": 1}}], \"cursor\": {\"batchSize\": 2}}",
                10,
            ))
            .await
            .expect("aggregate");
        assert!(
            drained.results[0].error.is_none(),
            "{:?}",
            drained.results[0].error
        );
        assert_eq!(drained.results[0].row_count, 5);
        assert!(!drained.results[0].truncated);

        // An unknown command fails only its own statement; the next one still runs.
        let mixed = connection
            .execute(run("{\"notACommand\": 1}\n{\"ping\": 1}", 10))
            .await
            .expect("execute mixed");
        assert!(mixed.results[0].error.is_some());
        assert!(!mixed.results[0].is_query);
        assert!(mixed.results[1].error.is_none());

        let _ = connection
            .execute(run("{\"drop\": \"quarry_many\"}", 1))
            .await;
    }

    /// End-to-end against a real server, skipped unless one is provided:
    ///
    /// ```text
    /// QUARRY_TEST_MONGO_HOST=127.0.0.1 cargo test -- --ignored
    /// ```
    #[tokio::test]
    #[ignore = "needs a reachable MongoDB server (see module docs)"]
    async fn connects_lists_and_runs_commands() {
        let Ok(host) = std::env::var("QUARRY_TEST_MONGO_HOST") else {
            eprintln!("skipping: QUARRY_TEST_MONGO_HOST is not set");
            return;
        };
        let config = ConnectionConfig {
            driver: "mongodb".into(),
            host,
            port: std::env::var("QUARRY_TEST_MONGO_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(DEFAULT_PORT),
            username: std::env::var("QUARRY_TEST_MONGO_USER").unwrap_or_default(),
            password: std::env::var("QUARRY_TEST_MONGO_PASSWORD").ok(),
            database: Some("quarry_test".into()),
            ssl_mode: SslMode::Disabled,
            options: Default::default(),
        };

        let driver = MongoDriver::new();
        let info = driver.test(&config).await.expect("server info");
        assert!(info.version.is_some());

        let connection = driver.connect(&config).await.expect("connect");
        connection.ping().await.expect("ping");

        let response = connection
            .execute(QueryRequest {
                database: None,
                sql: "{\"drop\": \"quarry_items\"}\n{\"insert\": \"quarry_items\", \"documents\": [{\"sku\": \"a\"}, {\"sku\": \"b\"}]}\n{\"find\": \"quarry_items\", \"sort\": {\"sku\": 1}}"
                    .into(),
                max_rows: Some(10),
                timeout_ms: None,
                run_id: None,
            })
            .await
            .expect("execute");
        let found = &response.results[2];
        assert!(found.error.is_none(), "find failed: {:?}", found.error);
        assert_eq!(found.row_count, 2);

        // The preview the explorer builds for a collection: a sorted find with
        // skip/limit paging.
        let page = connection
            .execute(QueryRequest {
                database: Some("quarry_test".into()),
                sql: "{\"find\": \"quarry_items\", \"filter\": {}, \"sort\": {\"_id\": 1}, \"skip\": 1, \"limit\": 1}".into(),
                max_rows: Some(1),
                timeout_ms: None,
                run_id: None,
            })
            .await
            .expect("page");
        let page = &page.results[0];
        assert!(page.error.is_none(), "page failed: {:?}", page.error);
        assert_eq!(page.row_count, 1);

        let objects = connection
            .list_objects("quarry_test", None)
            .await
            .expect("list objects");
        assert!(objects.iter().any(|o| o.name == "quarry_items"));

        let schema = connection
            .describe_object("quarry_test", None, "quarry_items")
            .await
            .expect("describe");
        assert!(schema.columns.iter().any(|c| c.name == "sku"));

        let _ = connection
            .execute(QueryRequest {
                database: None,
                sql: "{\"drop\": \"quarry_items\"}".into(),
                max_rows: Some(1),
                timeout_ms: None,
                run_id: None,
            })
            .await;
    }
}
