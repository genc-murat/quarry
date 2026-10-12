//! The driver abstraction.
//!
//! Everything the application knows about a database engine flows through two
//! traits. Adding support for a new engine is a matter of implementing them and
//! registering the driver in [`DriverRegistry::with_builtins`] — no changes to
//! the IPC layer or the frontend are required.

pub mod clickhouse;
pub mod mongo;
pub mod mysql;
pub mod postgres;
pub mod redis;
pub mod sqlite;

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use tokio_util::sync::CancellationToken;

use crate::ddl::{self, Dialect};
use crate::error::{DriverError, Result};
use crate::models::{
    ColumnMeta, ColumnSchema, ConfigField, ConnectionConfig, CreateTableRequest, DatabaseInfo,
    DatabaseObject, DriverCapabilities, DriverDescriptor, ForeignKeySchema, IndexSchema,
    InspectorSection, NamespaceInfo, ObjectAction, ObjectActionRequest, ObjectKind, ObjectSchema,
    QueryRequest, QueryResponse, RowChangeKind, RowChangeRequest, SectionActionRequest,
    SectionRequest, ServerInfo, TableColumns,
};

/// A database engine (MySQL, PostgreSQL, ...).
#[async_trait]
pub trait DatabaseDriver: Send + Sync {
    /// Stable machine identifier, e.g. `"mysql"`.
    fn id(&self) -> &'static str;
    fn display_name(&self) -> &'static str;
    fn default_port(&self) -> u16;
    /// Hex/CSS color used to accent the driver across the UI.
    fn accent_color(&self) -> &'static str;
    fn capabilities(&self) -> DriverCapabilities;
    /// Schema for the dynamic connection form.
    fn config_fields(&self) -> Vec<ConfigField>;

    /// SQL dialect the engine quotes identifiers with and generates DDL in.
    ///
    /// The only copy of the fact: a connection carries the driver it was opened
    /// by and answers [`Connection::dialect`] from here, so quoting in a session
    /// can never disagree with what the engine declares. The frontend's mocked
    /// drivers are checked against it without a live server.
    fn dialect(&self) -> Dialect {
        Dialect::Ansi
    }

    /// The statement that returns `statement`'s execution plan, or `None` when
    /// the engine cannot explain it.
    ///
    /// The default is the SQL keyword form, gated on the capability the driver
    /// advertises, so an engine without EXPLAIN declares `None` and every one of
    /// its connections inherits that answer. An engine with its own plan
    /// statement (SQLite's `EXPLAIN QUERY PLAN`, ClickHouse's
    /// `EXPLAIN indexes = 1`) overrides it, and its connections answer from the
    /// override.
    fn explain_statement(&self, statement: &str) -> Option<String> {
        self.capabilities()
            .supports_explain
            .then(|| explain_sql(statement))
    }

    /// Open a short lived connection and return server metadata without keeping
    /// a session around. Used by the "Test connection" button.
    async fn test(&self, config: &ConnectionConfig) -> Result<ServerInfo>;

    /// Establish a pooled, long lived connection.
    async fn connect(&self, config: &ConnectionConfig) -> Result<Arc<dyn Connection>>;
}

/// An open connection to one database server.
#[async_trait]
pub trait Connection: Send + Sync {
    /// Identifier of the driver this connection belongs to (`"mysql"`, ...),
    /// read from the held driver so a session can never report an id the
    /// registry does not know.
    fn driver_id(&self) -> &'static str {
        self.driver().id()
    }

    /// The driver this connection was opened by.
    ///
    /// A driver is a stateless declaration, so the connection embeds the one it
    /// belongs to and reads what the engine says about itself from it: its
    /// identifier ([`Connection::driver_id`]), what it can do
    /// ([`Connection::capabilities`]), the SQL dialect it quotes and generates
    /// DDL with ([`Connection::dialect`]) and how it explains a statement
    /// ([`Connection::explain_statement`]). Those facts therefore have exactly
    /// one implementation, on the driver — the same one the frontend's fixtures
    /// are checked against.
    fn driver(&self) -> &dyn DatabaseDriver;

    fn server_info(&self) -> &ServerInfo;

    /// What the engine can do, read from the held driver. The UI gates features
    /// on these flags, so a session cannot offer something the driver does not
    /// declare.
    fn capabilities(&self) -> DriverCapabilities {
        self.driver().capabilities()
    }

    async fn ping(&self) -> Result<()>;

    /// Databases on the server (MySQL: schemas; PostgreSQL: databases).
    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>>;

    /// Schemas/namespaces inside a database. Drivers without schemas return a
    /// single synthetic entry so the UI can stay uniform.
    async fn list_namespaces(&self, database: &str) -> Result<Vec<NamespaceInfo>>;

    /// Tables, views, collections, ... inside a database/namespace.
    async fn list_objects(
        &self,
        database: &str,
        namespace: Option<&str>,
    ) -> Result<Vec<DatabaseObject>>;

    async fn describe_object(
        &self,
        database: &str,
        namespace: Option<&str>,
        object: &str,
    ) -> Result<ObjectSchema>;

    /// All columns of every object in a schema, for editor autocompletion.
    ///
    /// The default implementation walks `describe_object`, which is correct for
    /// every driver; SQL adapters override it with a single `information_schema`
    /// query so a large schema costs one round trip instead of hundreds.
    async fn list_table_columns(
        &self,
        database: &str,
        namespace: Option<&str>,
    ) -> Result<Vec<TableColumns>> {
        let objects = self.list_objects(database, namespace).await?;
        let mut out = Vec::with_capacity(objects.len());
        for object in objects {
            let Ok(schema) = self
                .describe_object(database, namespace, &object.name)
                .await
            else {
                continue;
            };
            out.push(TableColumns {
                table: object.name,
                schema: namespace.map(str::to_string),
                columns: schema
                    .columns
                    .into_iter()
                    .map(|c| ColumnMeta {
                        name: c.name,
                        data_type: Some(c.data_type),
                    })
                    .collect(),
            });
        }
        Ok(out)
    }

    async fn execute(&self, request: QueryRequest) -> Result<QueryResponse>;

    /// Execute with the option to be interrupted. The default implementation
    /// ignores `cancel` and delegates to [`Connection::execute`]; SQL adapters
    /// override it to issue a server-side cancel (`KILL QUERY` /
    /// `pg_cancel_backend`) so a long statement actually stops on the server.
    async fn execute_cancellable(
        &self,
        request: QueryRequest,
        cancel: CancellationToken,
    ) -> Result<QueryResponse> {
        let _ = cancel;
        self.execute(request).await
    }

    /// Rewrite a statement into one that returns its execution plan, or `None`
    /// when the engine has no EXPLAIN. Read from the driver, which is where the
    /// declaration lives.
    fn explain_statement(&self, statement: &str) -> Option<String> {
        self.driver().explain_statement(statement)
    }

    /// SQL dialect used for identifier quoting and generated DDL. Read from the
    /// driver, so a connection cannot quote differently than it declares.
    fn dialect(&self) -> Dialect {
        self.driver().dialect()
    }

    /// Quote a single identifier using the connection's dialect.
    fn quote_identifier(&self, name: &str) -> String {
        self.dialect().quote(name)
    }

    /// Fully qualified, quoted name for an object. Prefers the namespace
    /// (PostgreSQL schema) and falls back to the database (MySQL).
    fn qualified_name(&self, database: &str, namespace: Option<&str>, object: &str) -> String {
        let qualifier = namespace
            .filter(|value| !value.is_empty())
            .or_else(|| Some(database).filter(|value| !value.is_empty()));
        self.dialect().quote_qualified(qualifier, object)
    }

    /// Panels this driver contributes to the object inspector. The default
    /// advertises none, so an engine with extra detail adds a section here
    /// instead of a field on [`crate::models::ObjectDetail`].
    async fn inspect_sections(
        &self,
        _database: &str,
        _namespace: Option<&str>,
        _object: &str,
        _schema: &ObjectSchema,
    ) -> Result<Vec<InspectorSection>> {
        Ok(vec![])
    }

    /// Body of a `Live` section, fetched when the user opens it. The driver must
    /// answer for every id it advertised in [`Connection::inspect_sections`].
    async fn section_body(&self, _request: &SectionRequest) -> Result<InspectorSection> {
        Err(DriverError::Unsupported(
            "this driver has no on-demand inspector sections".into(),
        ))
    }

    /// Run an operation a section advertised. Drivers re-validate the request
    /// (target object, engine, row parameter) because the UI only forwards ids
    /// and parameters it was given.
    async fn run_section_action(&self, _request: SectionActionRequest) -> Result<QueryResponse> {
        Err(DriverError::Unsupported(
            "this driver has no inspector section actions".into(),
        ))
    }

    async fn object_ddl(
        &self,
        database: &str,
        namespace: Option<&str>,
        object: &str,
    ) -> Result<String> {
        let schema = self.describe_object(database, namespace, object).await?;
        Ok(ddl::create_table(&schema, self.dialect()))
    }

    /// Exact row count for a table. Tables that cannot be counted (views) fail.
    async fn count_rows(
        &self,
        database: &str,
        namespace: Option<&str>,
        object: &str,
    ) -> Result<u64> {
        let sql = format!(
            "SELECT COUNT(*) AS count FROM {}",
            self.qualified_name(database, namespace, object)
        );
        let response = self
            .execute(QueryRequest {
                database: Some(database.to_string()),
                sql,
                max_rows: Some(1),
                timeout_ms: None,
                run_id: None,
            })
            .await?;
        let statement = response
            .results
            .into_iter()
            .next()
            .ok_or_else(|| DriverError::Query("no result for row count".into()))?;
        if let Some(error) = statement.error {
            return Err(DriverError::Query(error));
        }
        match statement.rows.first().and_then(|row| row.first()) {
            Some(serde_json::Value::Number(number)) => number
                .as_u64()
                .ok_or_else(|| DriverError::Query("row count was not an integer".into())),
            Some(serde_json::Value::String(text)) => text
                .parse::<u64>()
                .map_err(|_| DriverError::Query("row count was not an integer".into())),
            _ => Err(DriverError::Query("row count was missing".into())),
        }
    }

    /// Apply a context-menu write action. The default builds dialect SQL with
    /// [`ddl::action_sql`] and runs it, so SQL adapters need no extra code.
    async fn apply_object_action(&self, request: ObjectActionRequest) -> Result<QueryResponse> {
        let sql = ddl::action_sql(&request, self.dialect())?;
        self.execute(QueryRequest {
            database: Some(request.database.clone()),
            sql,
            max_rows: Some(1),
            timeout_ms: None,
            run_id: None,
        })
        .await
    }

    /// Apply a single-row insert/update/delete from the results grid. The
    /// default builds dialect SQL with the [`ddl`] row helpers and runs it, so
    /// SQL adapters need no extra code.
    async fn apply_row_change(&self, request: RowChangeRequest) -> Result<QueryResponse> {
        let sql = match request.kind {
            RowChangeKind::Insert => ddl::insert_row_sql(&request, self.dialect())?,
            RowChangeKind::Update => ddl::update_row_sql(&request, self.dialect())?,
            RowChangeKind::Delete => ddl::delete_row_sql(&request, self.dialect())?,
        };
        self.execute(QueryRequest {
            database: Some(request.database.clone()),
            sql,
            max_rows: Some(1),
            timeout_ms: None,
            run_id: None,
        })
        .await
    }

    /// Apply a bounded batch of row changes. Engines with a bulk protocol may
    /// override this; the default preserves the existing per-row semantics.
    async fn apply_row_changes(&self, requests: Vec<RowChangeRequest>) -> Result<QueryResponse> {
        let started = std::time::Instant::now();
        let mut results = Vec::with_capacity(requests.len());
        for request in requests {
            let response = self.apply_row_change(request).await?;
            if let Some(error) = response
                .results
                .iter()
                .find_map(|item| item.error.as_deref())
            {
                return Err(DriverError::Query(error.to_string()));
            }
            results.extend(response.results);
        }
        Ok(QueryResponse {
            results,
            total_ms: started.elapsed().as_millis() as u64,
        })
    }

    /// Create a table from the wizard definition. The default renders dialect
    /// SQL with [`ddl::create_table_from_columns`] and runs it.
    async fn create_table(&self, request: CreateTableRequest) -> Result<QueryResponse> {
        let sql = ddl::create_table_from_columns(&request, self.dialect())?;
        self.execute(QueryRequest {
            database: Some(request.database.clone()),
            sql,
            max_rows: Some(1),
            timeout_ms: None,
            run_id: None,
        })
        .await
    }
}

/// The set of drivers the application knows about.
pub struct DriverRegistry {
    drivers: BTreeMap<&'static str, Arc<dyn DatabaseDriver>>,
}

impl DriverRegistry {
    /// Registry pre-populated with every driver compiled into the binary.
    pub fn with_builtins() -> Self {
        let mut registry = DriverRegistry {
            drivers: BTreeMap::new(),
        };
        registry.register(Arc::new(clickhouse::ClickHouseDriver::new()));
        registry.register(Arc::new(mongo::MongoDriver::new()));
        registry.register(Arc::new(mysql::MySqlDriver::new()));
        registry.register(Arc::new(postgres::PostgresDriver::new()));
        registry.register(Arc::new(sqlite::SqliteDriver::new()));
        registry.register(Arc::new(redis::RedisDriver::new()));
        registry
    }

    /// Add a driver. Later registrations of the same id replace earlier ones.
    pub fn register(&mut self, driver: Arc<dyn DatabaseDriver>) {
        self.drivers.insert(driver.id(), driver);
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn DatabaseDriver>> {
        self.drivers.get(id).cloned()
    }

    pub fn contains(&self, id: &str) -> bool {
        self.drivers.contains_key(id)
    }

    pub fn ids(&self) -> Vec<&'static str> {
        self.drivers.keys().copied().collect()
    }

    /// Descriptors describing every registered driver, for the frontend.
    pub fn descriptors(&self) -> Vec<DriverDescriptor> {
        self.drivers
            .values()
            .map(|driver| DriverDescriptor {
                id: driver.id().to_string(),
                display_name: driver.display_name().to_string(),
                default_port: driver.default_port(),
                accent_color: driver.accent_color().to_string(),
                capabilities: driver.capabilities(),
                config_fields: driver.config_fields(),
            })
            .collect()
    }
}

impl Default for DriverRegistry {
    fn default() -> Self {
        Self::with_builtins()
    }
}

// ---------------------------------------------------------------------------
// Shared helpers for adapters
// ---------------------------------------------------------------------------

/// The context-menu actions every relational adapter supports. `Reindex` is
/// added separately by engines that have it.
pub fn relational_actions() -> Vec<ObjectAction> {
    use ObjectAction::*;
    vec![
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
        CreateIndex,
        DropIndex,
        AddColumn,
        AlterColumn,
        DropColumn,
    ]
}

/// Build an `EXPLAIN` form of a statement, trimming any trailing semicolon so
/// the prefix is not read as part of the statement text.
pub fn explain_sql(statement: &str) -> String {
    let trimmed = statement.trim().trim_end_matches(';').trim_end();
    format!("EXPLAIN {trimmed}")
}

/// Build the standard column list shared by SQL adapters. Adapters that read
/// from `information_schema` can reuse this to keep ordering consistent.
/// Classify one normalized object-type marker, as returned by each engine's
/// introspection queries, into an [`ObjectKind`]. Every driver routes through
/// this so the explorer groups objects identically regardless of the server;
/// anything unrecognised is `Other`.
pub fn object_kind_from_marker(marker: &str) -> ObjectKind {
    match marker.trim().to_ascii_uppercase().as_str() {
        "TABLE" | "BASE TABLE" | "FOREIGN TABLE" => ObjectKind::Table,
        "VIEW" | "SYSTEM VIEW" => ObjectKind::View,
        "MATERIALIZED VIEW" => ObjectKind::MaterializedView,
        "COLLECTION" => ObjectKind::Collection,
        "KEYSPACE" => ObjectKind::KeySpace,
        "KEY" => ObjectKind::Key,
        "FUNCTION" => ObjectKind::Function,
        "PROCEDURE" => ObjectKind::Procedure,
        "TRIGGER" => ObjectKind::Trigger,
        "EVENT" => ObjectKind::Event,
        "SEQUENCE" => ObjectKind::Sequence,
        _ => ObjectKind::Other,
    }
}

pub fn sort_columns(columns: &mut [ColumnSchema]) {
    columns.sort_by_key(|c| c.ordinal);
}

/// Convenience for assembling an [`ObjectSchema`] from its parts.
pub fn build_object_schema(
    name: &str,
    kind: crate::models::ObjectKind,
    mut columns: Vec<ColumnSchema>,
    mut indexes: Vec<IndexSchema>,
    foreign_keys: Vec<ForeignKeySchema>,
) -> ObjectSchema {
    sort_columns(&mut columns);
    indexes.sort_by(|a, b| a.name.cmp(&b.name));
    ObjectSchema {
        name: name.to_string(),
        kind,
        columns,
        indexes,
        foreign_keys,
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::{json, Value};

    use super::{explain_sql, object_kind_from_marker, DriverRegistry};
    use crate::ddl::Dialect;
    use crate::models::ObjectKind;

    /// Path of the snapshot the frontend's fixtures are checked against.
    fn snapshot_path() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/fixtures/driver-descriptors.json")
    }

    /// The character a dialect wraps identifiers in.
    fn quote_char(dialect: Dialect) -> String {
        dialect
            .quote("x")
            .chars()
            .next()
            .map(String::from)
            .unwrap_or_default()
    }

    /// Every registered driver's declaration, as the frontend sees it: the
    /// `list_drivers` descriptor, plus the two facts the driver declares that
    /// the dev mock also mirrors — the identifier quote its templates are built
    /// with, and the statement a read is explained with (`null` when the engine
    /// cannot explain).
    fn descriptor_snapshot() -> String {
        let registry = DriverRegistry::with_builtins();
        let entries: Vec<Value> = registry
            .descriptors()
            .into_iter()
            .map(|descriptor| {
                let driver = registry
                    .get(&descriptor.id)
                    .unwrap_or_else(|| panic!("{} is registered", descriptor.id));
                let mut value = serde_json::to_value(&descriptor).expect("a descriptor serializes");
                let map = value.as_object_mut().expect("a descriptor is an object");
                map.insert(
                    "identifierQuote".into(),
                    json!(quote_char(driver.dialect())),
                );
                map.insert(
                    "explainSelect".into(),
                    json!(driver.explain_statement("SELECT 1")),
                );
                value
            })
            .collect();

        let mut snapshot = serde_json::to_string_pretty(&entries).expect("the snapshot serializes");
        snapshot.push('\n');
        snapshot
    }

    /// The frontend cannot import Rust, so `src/lib/fixtures/driver-descriptors.json`
    /// is the contract between the two languages: this test keeps the snapshot
    /// honest against the registry, and `src/lib/fixtureDrift.test.ts` keeps
    /// `src/lib/mockFixtures.ts` honest against the snapshot. A capability, field,
    /// action, identifier quote or explain statement that only one side knows
    /// about then fails a test instead of silently showing the browser a surface
    /// the engine does not have.
    ///
    /// After an intentional change to a driver, regenerate the snapshot with
    ///
    /// ```sh
    /// QUARRY_UPDATE_SNAPSHOT=1 cargo test --manifest-path src-tauri/Cargo.toml descriptor_snapshot
    /// ```
    ///
    /// and bring the fixture in line (`npm run check:drift` runs both halves).
    #[test]
    fn descriptor_snapshot_matches_the_registry() {
        let expected = descriptor_snapshot();
        let path = snapshot_path();

        if std::env::var_os("QUARRY_UPDATE_SNAPSHOT").is_some() {
            std::fs::create_dir_all(path.parent().expect("snapshot directory"))
                .expect("the fixture directory is writable");
            std::fs::write(&path, &expected).expect("the snapshot is written");
            return;
        }

        let stored = std::fs::read_to_string(&path).unwrap_or_else(|error| {
            panic!(
                "cannot read {}: {error}\nregenerate it with QUARRY_UPDATE_SNAPSHOT=1",
                path.display()
            )
        });
        assert_eq!(
            serde_json::from_str::<Value>(&stored).expect("the snapshot is valid JSON"),
            serde_json::from_str::<Value>(&expected).expect("the snapshot is valid JSON"),
            "the driver descriptor snapshot is stale: regenerate it with \
             QUARRY_UPDATE_SNAPSHOT=1 and bring src/lib/mockFixtures.ts in line"
        );
    }

    #[test]
    fn explain_prefixes_and_trims_semicolons() {
        assert_eq!(explain_sql("SELECT 1"), "EXPLAIN SELECT 1");
        assert_eq!(explain_sql("  SELECT 1;  "), "EXPLAIN SELECT 1");
        assert_eq!(explain_sql("SELECT 1;;"), "EXPLAIN SELECT 1");
    }

    #[test]
    fn object_kind_markers_are_classified() {
        assert_eq!(object_kind_from_marker("BASE TABLE"), ObjectKind::Table);
        assert_eq!(object_kind_from_marker("TABLE"), ObjectKind::Table);
        assert_eq!(object_kind_from_marker("FOREIGN TABLE"), ObjectKind::Table);
        assert_eq!(object_kind_from_marker("VIEW"), ObjectKind::View);
        assert_eq!(object_kind_from_marker("SYSTEM VIEW"), ObjectKind::View);
        assert_eq!(
            object_kind_from_marker("materialized view"),
            ObjectKind::MaterializedView
        );
        assert_eq!(object_kind_from_marker("FUNCTION"), ObjectKind::Function);
        assert_eq!(object_kind_from_marker("PROCEDURE"), ObjectKind::Procedure);
        assert_eq!(object_kind_from_marker("TRIGGER"), ObjectKind::Trigger);
        assert_eq!(object_kind_from_marker("EVENT"), ObjectKind::Event);
        assert_eq!(object_kind_from_marker("SEQUENCE"), ObjectKind::Sequence);
        assert_eq!(object_kind_from_marker("  trigger "), ObjectKind::Trigger);
        assert_eq!(object_kind_from_marker("nonsense"), ObjectKind::Other);
    }
}
