//! The driver abstraction.
//!
//! Everything the application knows about a database engine flows through two
//! traits. Adding support for a new engine is a matter of implementing them and
//! registering the driver in [`DriverRegistry::with_builtins`] — no changes to
//! the IPC layer or the frontend are required.

pub mod mysql;
pub mod postgres;

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use tokio_util::sync::CancellationToken;

use crate::ddl::{self, Dialect};
use crate::error::{DriverError, Result};
use crate::models::{
    ColumnMeta, ColumnSchema, ConfigField, ConnectionConfig, DatabaseInfo, DatabaseObject,
    DriverCapabilities, DriverDescriptor, ForeignKeySchema, IndexSchema, NamespaceInfo,
    CreateTableRequest, ObjectAction, ObjectActionRequest, ObjectKind, ObjectSchema,
    QueryRequest, QueryResponse, RowChangeKind, RowChangeRequest, ServerInfo, TableColumns,
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

    /// Open a short lived connection and return server metadata without keeping
    /// a session around. Used by the "Test connection" button.
    async fn test(&self, config: &ConnectionConfig) -> Result<ServerInfo>;

    /// Establish a pooled, long lived connection.
    async fn connect(&self, config: &ConnectionConfig) -> Result<Arc<dyn Connection>>;
}

/// An open connection to one database server.
#[async_trait]
pub trait Connection: Send + Sync {
    fn driver_id(&self) -> &'static str;
    fn server_info(&self) -> &ServerInfo;
    fn capabilities(&self) -> DriverCapabilities;

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
            let Ok(schema) = self.describe_object(database, namespace, &object.name).await else {
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
    /// when the adapter has no EXPLAIN. The default uses the SQL keyword form,
    /// which is valid for every relational engine compiled in today.
    fn explain_statement(&self, statement: &str) -> Option<String> {
        Some(explain_sql(statement))
    }

    /// SQL dialect used for identifier quoting and generated DDL.
    fn dialect(&self) -> Dialect {
        Dialect::Ansi
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

    /// Generated `CREATE` DDL for an object. The default reconstructs it from
    /// introspection, which works for every SQL adapter.
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
            Some(serde_json::Value::Number(number)) => number.as_u64().ok_or_else(|| {
                DriverError::Query("row count was not an integer".into())
            }),
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
        registry.register(Arc::new(mysql::MySqlDriver::new()));
        registry.register(Arc::new(postgres::PostgresDriver::new()));
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
    use super::{explain_sql, object_kind_from_marker};
    use crate::models::ObjectKind;

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
