//! Shared read-only CQL adapter for Apache Cassandra and ScyllaDB.
use std::collections::VecDeque;
use std::num::NonZeroU32;
use std::ops::ControlFlow;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use futures_util::TryStreamExt;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::CertificateDer;
use scylla::client::{session::Session, session_builder::SessionBuilder};
use scylla::cluster::metadata::{CollectionType, ColumnType, NativeType, Strategy, Table};
use scylla::cluster::{ClusterState, Node};
use scylla::response::{Coordinator, PagingState};
use scylla::routing::Token;
use scylla::statement::prepared::PreparedStatement;
use scylla::statement::unprepared::Statement;
use scylla::value::{
    CqlDate, CqlDecimal, CqlTime, CqlTimestamp, CqlTimeuuid, CqlValue, CqlVarint, Row,
};
use serde_json::{json, Value};
use tokio::sync::{Mutex, OnceCell};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{json_i64, Connection, DatabaseDriver};
use crate::error::{DriverError, Result};
use crate::models::{
    ColumnMeta, ColumnSchema, ConfigField, ConnectionConfig, DatabaseInfo, DatabaseObject,
    DriverCapabilities, FieldType, InspectorSection, NamespaceInfo, ObjectAction, ObjectKind,
    ObjectSchema, PartitionDiagnostics, PartitionKeyValue, PartitionNode, PartitionPage,
    PartitionPlacement, PartitionRequest, PartitionTrace, PartitionTraceEvent, QueryLanguage,
    QueryRequest, QueryResponse, ResultShape, SectionBlock, SectionField, SectionSource,
    SelectOption, ServerInfo, SslMode, StatementResult, TableColumns,
};

const PORT: u16 = 9042;
const MAX_SESSIONS: usize = 4;
const MAX_CURSORS: usize = 128;
const MAX_PAGE_SIZE: u32 = 1000;
const TRACE_LOOKUP_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_TRACE_EVENTS: usize = 200;

type KeyspaceSession = Arc<OnceCell<Arc<Session>>>;

pub struct CqlDriver;

fn field(key: &str, label: &str, field_type: FieldType) -> ConfigField {
    ConfigField {
        key: key.into(),
        label: label.into(),
        field_type,
        placeholder: None,
        required: false,
        default_value: None,
        options: vec![],
        help: None,
    }
}

#[async_trait]
impl DatabaseDriver for CqlDriver {
    fn id(&self) -> &'static str {
        "cql"
    }
    fn display_name(&self) -> &'static str {
        "Cassandra / ScyllaDB"
    }
    fn default_port(&self) -> u16 {
        PORT
    }
    fn accent_color(&self) -> &'static str {
        "#4f9fcf"
    }

    fn capabilities(&self) -> DriverCapabilities {
        DriverCapabilities {
            query_language: QueryLanguage::Cql,
            result_shape: ResultShape::Tabular,
            is_relational: false,
            supports_multiple_databases: true,
            supports_schemas: false,
            supports_transactions: false,
            supports_ddl: false,
            supports_explain: false,
            supports_cancel: false,
            object_kinds: vec![ObjectKind::Table, ObjectKind::MaterializedView],
            supported_actions: vec![
                ObjectAction::Inspect,
                ObjectAction::ViewData,
                ObjectAction::CopyName,
            ],
        }
    }

    fn config_fields(&self) -> Vec<ConfigField> {
        vec![
            ConfigField {
                placeholder: Some("127.0.0.1".into()),
                required: true,
                help: Some(
                    "Comma-separated hosts. Use the same port for all contact points.".into(),
                ),
                ..field("host", "Contact points", FieldType::Text)
            },
            ConfigField {
                default_value: Some(json!(PORT)),
                required: true,
                ..field("port", "Port", FieldType::Number)
            },
            field("username", "Username", FieldType::Text),
            field("password", "Password", FieldType::Password),
            field("database", "Default keyspace", FieldType::Text),
            field("localDatacenter", "Local datacenter", FieldType::Text),
            ConfigField {
                default_value: Some(json!("disabled")),
                options: vec![
                    SelectOption {
                        value: "disabled".into(),
                        label: "Disabled".into(),
                    },
                    SelectOption {
                        value: "required".into(),
                        label: "Required · verify certificate".into(),
                    },
                ],
                ..field("sslMode", "TLS", FieldType::Select)
            },
            ConfigField {
                help: Some(
                    "Optional PEM file path. With TLS enabled, an empty path uses system roots."
                        .into(),
                ),
                ..field("caFile", "TLS CA certificate", FieldType::Text)
            },
        ]
    }

    async fn test(&self, config: &ConnectionConfig) -> Result<ServerInfo> {
        let (settings, keyspace) = Settings::new(config).await?;
        let session = settings.open(keyspace.as_deref()).await?;
        server_info(&session, &settings, keyspace).await
    }

    async fn connect(&self, config: &ConnectionConfig) -> Result<Arc<dyn Connection>> {
        let (settings, keyspace) = Settings::new(config).await?;
        let session = Arc::new(settings.open(keyspace.as_deref()).await?);
        let info = server_info(&session, &settings, keyspace).await?;
        Ok(Arc::new(CqlConnection {
            driver: CqlDriver,
            settings,
            session,
            info,
            keyspaces: Mutex::new(VecDeque::new()),
            cursors: Mutex::new(VecDeque::new()),
        }))
    }
}

struct Settings {
    addresses: Vec<String>,
    credentials: Option<(String, String)>,
    datacenter: Option<String>,
    tls: Option<Arc<rustls::ClientConfig>>,
}

impl Settings {
    async fn new(config: &ConnectionConfig) -> Result<(Self, Option<String>)> {
        let addresses = config
            .host
            .split(',')
            .map(str::trim)
            .filter(|host| !host.is_empty())
            .map(|host| {
                let host = host.trim_start_matches('[').trim_end_matches(']');
                if host.contains(':') {
                    if host.parse::<std::net::Ipv6Addr>().is_err() {
                        return Err(DriverError::Config(
                            "enter contact point hosts without ports".into(),
                        ));
                    }
                    Ok(format!("[{host}]:{}", config.port))
                } else {
                    Ok(format!("{host}:{}", config.port))
                }
            })
            .collect::<Result<Vec<_>>>()?;
        if addresses.is_empty() || config.port == 0 {
            return Err(DriverError::Config(
                "contact points and a valid port are required".into(),
            ));
        }
        let credentials = match (&config.username[..], config.password.as_ref()) {
            ("", None) => None,
            (user, Some(password)) if !user.is_empty() => Some((user.into(), password.clone())),
            _ => {
                return Err(DriverError::Config(
                    "provide both CQL username and password".into(),
                ))
            }
        };
        let option = |key: &str| {
            config
                .options
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        };
        let tls = if config.ssl_mode == SslMode::Disabled {
            None
        } else {
            let ca_file = option("caFile");
            Some(
                tokio::task::spawn_blocking(move || tls_config(ca_file.as_deref()))
                    .await
                    .map_err(connection_error)??,
            )
        };
        let keyspace = config
            .database
            .clone()
            .filter(|name| !name.trim().is_empty());
        Ok((
            Self {
                addresses,
                credentials,
                datacenter: option("localDatacenter"),
                tls,
            },
            keyspace,
        ))
    }

    async fn open(&self, keyspace: Option<&str>) -> Result<Session> {
        let mut builder = SessionBuilder::new()
            .known_nodes(&self.addresses)
            .tracing_info_fetch_attempts(NonZeroU32::new(12).unwrap())
            .tracing_info_fetch_interval(Duration::from_millis(40))
            .tls_context(self.tls.clone());
        if let Some((user, password)) = &self.credentials {
            builder = builder.user(user, password);
        }
        if let Some(datacenter) = &self.datacenter {
            builder = builder.prefer_datacenter(datacenter.clone());
        }
        if let Some(keyspace) = keyspace {
            builder = builder.use_keyspace(keyspace, true);
        }
        builder.build().await.map_err(connection_error)
    }
}

fn tls_config(ca_file: Option<&str>) -> Result<Arc<rustls::ClientConfig>> {
    let mut roots = rustls::RootCertStore::empty();
    if let Some(path) = ca_file {
        for certificate in CertificateDer::pem_file_iter(path).map_err(connection_error)? {
            roots
                .add(certificate.map_err(connection_error)?)
                .map_err(connection_error)?;
        }
    } else {
        roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
    }
    if roots.is_empty() {
        return Err(DriverError::Config(
            "no trusted TLS CA certificates were loaded".into(),
        ));
    }
    let client = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(connection_error)?
    .with_root_certificates(roots)
    .with_no_client_auth();
    Ok(Arc::new(client))
}

fn connection_error(error: impl std::fmt::Display) -> DriverError {
    DriverError::Connect(error.to_string())
}
fn query_error(error: impl std::fmt::Display) -> DriverError {
    DriverError::Query(error.to_string())
}

async fn release_version(session: &Session) -> Result<String> {
    let result = session
        .query_unpaged("SELECT release_version FROM system.local", &[])
        .await
        .map_err(connection_error)?
        .into_rows_result()
        .map_err(connection_error)?;
    let (version,) = result.single_row::<(String,)>().map_err(connection_error)?;
    Ok(version)
}

async fn server_info(
    session: &Session,
    settings: &Settings,
    keyspace: Option<String>,
) -> Result<ServerInfo> {
    Ok(ServerInfo {
        version: Some(release_version(session).await?),
        server_comment: Some(session.get_cluster_state().cluster_name().into()),
        current_database: keyspace,
        current_user: settings.credentials.as_ref().map(|(user, _)| user.clone()),
        supports_tls: settings.tls.is_some(),
        ..Default::default()
    })
}

struct CqlConnection {
    driver: CqlDriver,
    session: Arc<Session>,
    settings: Settings,
    info: ServerInfo,
    keyspaces: Mutex<VecDeque<(String, KeyspaceSession)>>,
    cursors: Mutex<VecDeque<(String, PartitionCursor)>>,
}

#[derive(PartialEq, Eq)]
struct PartitionSelection {
    database: String,
    table: String,
    keys: Vec<PartitionKeyValue>,
    page_size: u32,
}

struct PartitionCursor {
    selection: PartitionSelection,
    state: PagingState,
    prepared: PreparedStatement,
}

fn partition_node(node: &Node, address: String, shard: Option<u32>) -> PartitionNode {
    PartitionNode {
        host_id: node.host_id,
        address,
        datacenter: node.datacenter.clone(),
        rack: node.rack.clone(),
        shard,
    }
}

fn partition_diagnostics(
    state: &ClusterState,
    selection: &PartitionSelection,
    token: Option<Token>,
    coordinator: &Coordinator,
) -> PartitionDiagnostics {
    let placement = state
        .get_keyspace(&selection.database)
        .and_then(|keyspace| {
            if keyspace.tablet_based {
                Some(PartitionPlacement::Tablets)
            } else if matches!(
                keyspace.strategy,
                Strategy::SimpleStrategy { .. } | Strategy::NetworkTopologyStrategy { .. }
            ) {
                Some(PartitionPlacement::TokenRing)
            } else {
                // The driver falls back to RF=1 for unsupported strategies.
                None
            }
        });
    let replicas = match (token, &placement) {
        (Some(token), Some(placement)) => state
            .get_token_endpoints(&selection.database, &selection.table, token)
            .into_iter()
            .map(|(node, shard)| {
                let shard = (placement == &PartitionPlacement::Tablets || node.sharder().is_some())
                    .then_some(shard);
                partition_node(&node, node.address.to_string(), shard)
            })
            .collect(),
        _ => Vec::new(),
    };
    PartitionDiagnostics {
        token: token.map(|token| token.value().to_string()),
        placement,
        coordinator: partition_node(
            coordinator.node(),
            coordinator.connection_address().to_string(),
            coordinator.shard(),
        ),
        replicas,
    }
}

impl CqlConnection {
    async fn partition_trace(&self, id: Option<Uuid>, budget: Duration) -> PartitionTrace {
        let Some(id) = id else {
            return PartitionTrace::Unavailable { id: None };
        };
        if budget.is_zero() {
            return PartitionTrace::Unavailable { id: Some(id) };
        }
        let Ok(Ok(mut trace)) =
            tokio::time::timeout(budget, self.session.get_tracing_info(&id)).await
        else {
            return PartitionTrace::Unavailable { id: Some(id) };
        };
        trace.events.sort_by_key(|event| event.event_id);
        PartitionTrace::Available {
            id,
            duration_micros: trace.duration,
            truncated: trace.events.len() > MAX_TRACE_EVENTS,
            events: trace
                .events
                .into_iter()
                .take(MAX_TRACE_EVENTS)
                .map(|event| PartitionTraceEvent {
                    id: event.event_id.to_string(),
                    activity: event.activity,
                    source: event.source.map(|source| source.to_string()),
                    source_elapsed_micros: event.source_elapsed,
                    thread: event.thread,
                })
                .collect(),
        }
    }

    async fn session_for(&self, keyspace: Option<&str>) -> Result<Arc<Session>> {
        let Some(keyspace) = keyspace.filter(|name| !name.is_empty()) else {
            return Ok(self.session.clone());
        };
        if self.info.current_database.as_deref() == Some(keyspace) {
            return Ok(self.session.clone());
        }
        let cell = {
            let mut sessions = self.keyspaces.lock().await;
            if let Some(index) = sessions.iter().position(|(name, _)| name == keyspace) {
                let entry = sessions
                    .remove(index)
                    .expect("index matched in the same lock");
                let cell = entry.1.clone();
                sessions.push_back(entry);
                cell
            } else {
                let cell = Arc::new(OnceCell::new());
                sessions.push_back((keyspace.into(), cell.clone()));
                if sessions.len() > MAX_SESSIONS {
                    sessions.pop_front();
                }
                cell
            }
        };
        // A selected keyspace belongs to its own driver session. A shared USE
        // would silently redirect unqualified queries in other editor tabs.
        Ok(cell
            .get_or_try_init(|| async { self.settings.open(Some(keyspace)).await.map(Arc::new) })
            .await?
            .clone())
    }

    async fn table_state(&self, database: &str, table: &str) -> Result<Arc<ClusterState>> {
        let state = self.session.get_cluster_state();
        if lookup_table(&state, database, table).is_ok() {
            return Ok(state);
        }
        self.session.refresh_metadata().await.map_err(query_error)?;
        Ok(self.session.get_cluster_state())
    }
}

fn lookup_table<'a>(
    state: &'a ClusterState,
    database: &str,
    table: &str,
) -> Result<(&'a Table, ObjectKind)> {
    let keyspace = state
        .get_keyspace(database)
        .ok_or_else(|| DriverError::NotFound(database.into()))?;
    if let Some(view) = keyspace.views.get(table) {
        return Ok((&view.view_metadata, ObjectKind::MaterializedView));
    }
    keyspace
        .tables
        .get(table)
        .map(|table| (table, ObjectKind::Table))
        .ok_or_else(|| DriverError::NotFound(format!("{database}.{table}")))
}

fn type_name(typ: &ColumnType<'_>) -> String {
    let freeze = |name: String, frozen| {
        if frozen {
            format!("frozen<{name}>")
        } else {
            name
        }
    };
    match typ {
        ColumnType::Native(typ) => format!("{typ:?}").to_ascii_lowercase(),
        ColumnType::Collection { typ, frozen } => freeze(
            match typ {
                CollectionType::List(inner) => format!("list<{}>", type_name(inner)),
                CollectionType::Set(inner) => format!("set<{}>", type_name(inner)),
                CollectionType::Map(key, val) => {
                    format!("map<{}, {}>", type_name(key), type_name(val))
                }
                _ => "collection".into(),
            },
            *frozen,
        ),
        ColumnType::UserDefinedType { definition, frozen } => {
            freeze(definition.name.to_string(), *frozen)
        }
        ColumnType::Tuple(types) => format!(
            "tuple<{}>",
            types.iter().map(type_name).collect::<Vec<_>>().join(", ")
        ),
        ColumnType::Vector { typ, dimensions } => {
            format!("vector<{}, {dimensions}>", type_name(typ))
        }
        _ => "unknown".into(),
    }
}

fn table_schema(name: &str, table: &Table, kind: ObjectKind) -> ObjectSchema {
    let primary = table
        .partition_key
        .iter()
        .chain(&table.clustering_key)
        .collect::<Vec<_>>();
    let mut rest = table
        .columns
        .keys()
        .filter(|name| !primary.contains(name))
        .collect::<Vec<_>>();
    rest.sort();
    let columns = primary
        .iter()
        .copied()
        .chain(rest)
        .enumerate()
        .map(|(index, name)| ColumnSchema {
            name: name.clone(),
            data_type: type_name(&table.columns[name].typ),
            nullable: !primary.contains(&name),
            default_value: None,
            is_primary_key: primary.contains(&name),
            is_auto_increment: false,
            comment: None,
            ordinal: index as u32 + 1,
        })
        .collect();
    ObjectSchema {
        name: name.into(),
        kind,
        columns,
        indexes: vec![],
        foreign_keys: vec![],
    }
}

#[async_trait]
impl Connection for CqlConnection {
    fn driver(&self) -> &dyn DatabaseDriver {
        &self.driver
    }
    fn server_info(&self) -> &ServerInfo {
        &self.info
    }

    async fn ping(&self) -> Result<()> {
        release_version(&self.session).await.map(|_| ())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        self.session.refresh_metadata().await.map_err(query_error)?;
        let mut names: Vec<_> = self
            .session
            .get_cluster_state()
            .keyspaces_iter()
            .map(|(name, _)| DatabaseInfo {
                name: name.into(),
                is_system: name == "system" || name.starts_with("system_"),
            })
            .collect();
        names.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(names)
    }

    async fn list_namespaces(&self, _database: &str) -> Result<Vec<NamespaceInfo>> {
        Ok(vec![])
    }

    async fn list_objects(
        &self,
        database: &str,
        _namespace: Option<&str>,
    ) -> Result<Vec<DatabaseObject>> {
        let state = self.session.get_cluster_state();
        let keyspace = state
            .get_keyspace(database)
            .ok_or_else(|| DriverError::NotFound(database.into()))?;
        let mut objects: Vec<_> = keyspace
            .tables
            .keys()
            .filter(|name| !keyspace.views.contains_key(*name))
            .map(|name| (name, ObjectKind::Table))
            .chain(
                keyspace
                    .views
                    .keys()
                    .map(|name| (name, ObjectKind::MaterializedView)),
            )
            .map(|(name, kind)| DatabaseObject {
                name: name.clone(),
                kind,
                schema: None,
                comment: None,
                row_estimate: None,
            })
            .collect();
        objects.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(objects)
    }

    async fn describe_object(
        &self,
        database: &str,
        _namespace: Option<&str>,
        object: &str,
    ) -> Result<ObjectSchema> {
        let state = self.table_state(database, object).await?;
        let (table, kind) = lookup_table(&state, database, object)?;
        Ok(table_schema(object, table, kind))
    }

    async fn object_ddl(
        &self,
        _database: &str,
        _namespace: Option<&str>,
        _object: &str,
    ) -> Result<String> {
        Ok(String::new())
    }

    async fn count_rows(
        &self,
        _database: &str,
        _namespace: Option<&str>,
        _object: &str,
    ) -> Result<u64> {
        Err(DriverError::Unsupported(
            "CQL has no automatic table count".into(),
        ))
    }

    async fn list_table_columns(
        &self,
        database: &str,
        _namespace: Option<&str>,
    ) -> Result<Vec<TableColumns>> {
        let state = self.session.get_cluster_state();
        let keyspace = state
            .get_keyspace(database)
            .ok_or_else(|| DriverError::NotFound(database.into()))?;
        let mut tables: Vec<_> = keyspace
            .tables
            .iter()
            .filter(|(name, _)| !keyspace.views.contains_key(*name))
            .chain(
                keyspace
                    .views
                    .iter()
                    .map(|(name, view)| (name, &view.view_metadata)),
            )
            .map(|(name, table)| {
                let mut columns: Vec<_> = table
                    .columns
                    .iter()
                    .map(|(name, column)| ColumnMeta {
                        name: name.clone(),
                        data_type: Some(type_name(&column.typ)),
                        compare_as_decimal: false,
                    })
                    .collect();
                columns.sort_by(|a, b| a.name.cmp(&b.name));
                TableColumns {
                    table: name.clone(),
                    schema: Some(database.into()),
                    columns,
                }
            })
            .collect();
        tables.sort_by(|a, b| a.table.cmp(&b.table));
        Ok(tables)
    }

    async fn inspect_sections(
        &self,
        database: &str,
        _namespace: Option<&str>,
        object: &str,
        _schema: &ObjectSchema,
    ) -> Result<Vec<InspectorSection>> {
        let state = self.table_state(database, object).await?;
        let (table, _) = lookup_table(&state, database, object)?;
        Ok(vec![InspectorSection {
            id: "cql-keys".into(),
            label: "CQL keys".into(),
            source: SectionSource::Inline,
            hint: None,
            error_hint: None,
            actions: vec![],
            blocks: vec![SectionBlock::Fields {
                title: None,
                fields: vec![
                    SectionField {
                        label: "Partition key".into(),
                        value: Some(table.partition_key.join(", ")),
                    },
                    SectionField {
                        label: "Clustering key".into(),
                        value: (!table.clustering_key.is_empty())
                            .then(|| table.clustering_key.join(", ")),
                    },
                ],
            }],
        }])
    }

    async fn partition_keys(&self, database: &str, object: &str) -> Result<Vec<ColumnMeta>> {
        let state = self.table_state(database, object).await?;
        let (table, _) = lookup_table(&state, database, object)?;
        Ok(table
            .partition_key
            .iter()
            .map(|name| ColumnMeta {
                name: name.clone(),
                data_type: Some(type_name(&table.columns[name].typ)),
                compare_as_decimal: false,
            })
            .collect())
    }

    async fn read_partition(&self, request: PartitionRequest) -> Result<PartitionPage> {
        let started = Instant::now();
        let page_size = request.page_size.clamp(1, MAX_PAGE_SIZE);
        let selection = PartitionSelection {
            database: request.database,
            table: request.table,
            keys: request.keys,
            page_size,
        };
        let state = self
            .table_state(&selection.database, &selection.table)
            .await?;
        let (table, _) = lookup_table(&state, &selection.database, &selection.table)?;
        if table.partition_key.is_empty()
            || !table
                .partition_key
                .iter()
                .map(String::as_str)
                .eq(selection.keys.iter().map(|key| key.column.as_str()))
        {
            return Err(DriverError::Config(
                "provide every partition key component in schema order".into(),
            ));
        }
        let values = selection
            .keys
            .iter()
            .map(|key| {
                parse_key(&table.columns[&key.column].typ, &key.value)
                    .map_err(|error| DriverError::Config(format!("{}: {error}", key.column)))
            })
            .collect::<Result<Vec<_>>>()?;
        let (prepared, paging_state) = if let Some(token) = request.continuation {
            self.cursors.lock().await.iter()
                .find(|(id, cursor)| id == &token && cursor.selection == selection)
                .map(|(_, cursor)| (cursor.prepared.clone(), cursor.state.clone()))
                .ok_or_else(|| DriverError::Config("partition cursor expired or belongs to another query. Open the partition again.".into()))?
        } else {
            let predicate = table
                .partition_key
                .iter()
                .map(|name| format!("{} = ?", self.quote_identifier(name)))
                .collect::<Vec<_>>()
                .join(" AND ");
            let statement = format!(
                "SELECT * FROM {} WHERE {predicate}",
                self.qualified_name(&selection.database, None, &selection.table)
            );
            let mut prepared = self.session.prepare(statement).await.map_err(query_error)?;
            prepared.set_page_size(page_size as i32);
            (prepared, PagingState::start())
        };
        let mut bound = prepared.clone().bind(&values).map_err(query_error)?;
        bound.set_tracing(request.trace);
        let token = bound.calculate_token().ok().flatten();
        let (page, next) = self
            .session
            .execute_bound_single_page(&bound, paging_state)
            .await
            .map_err(query_error)?;
        let diagnostics = partition_diagnostics(
            &self.session.get_cluster_state(),
            &selection,
            token,
            page.request_coordinator(),
        );
        let page = page.into_rows_result().map_err(query_error)?;
        let trace_id = page.tracing_id();
        let columns = page
            .column_specs()
            .iter()
            .map(|spec| ColumnMeta {
                name: spec.name().into(),
                data_type: Some(type_name(spec.typ())),
                compare_as_decimal: matches!(spec.typ(), ColumnType::Native(NativeType::Decimal))
                    && !table.partition_key.iter().any(|name| name == spec.name()),
            })
            .collect();
        let rows = page
            .rows::<Row>()
            .map_err(query_error)?
            .map(|row| row.map(row_values).map_err(query_error))
            .collect::<Result<Vec<_>>>()?;
        let result = result_table(
            bound.prepared().get_statement().into(),
            columns,
            rows,
            started,
            false,
        );
        let continuation = match next.into_paging_control_flow() {
            ControlFlow::Break(()) => None,
            ControlFlow::Continue(state) => {
                let id = Uuid::new_v4().to_string();
                let mut cursors = self.cursors.lock().await;
                cursors.push_back((
                    id.clone(),
                    PartitionCursor {
                        selection,
                        state,
                        prepared,
                    },
                ));
                if cursors.len() > MAX_CURSORS {
                    cursors.pop_front();
                }
                Some(id)
            }
        };
        let trace = if request.trace {
            let budget = request.timeout_ms.map_or(TRACE_LOOKUP_TIMEOUT, |ms| {
                Duration::from_millis(ms)
                    .saturating_sub(started.elapsed())
                    .saturating_sub(Duration::from_millis(10))
                    .min(TRACE_LOOKUP_TIMEOUT)
            });
            Some(self.partition_trace(trace_id, budget).await)
        } else {
            None
        };
        Ok(PartitionPage {
            result,
            continuation,
            diagnostics,
            trace,
        })
    }

    async fn fetch_partition_trace(&self, trace_id: Uuid) -> Result<PartitionTrace> {
        Ok(self
            .partition_trace(Some(trace_id), TRACE_LOOKUP_TIMEOUT)
            .await)
    }

    async fn execute(&self, request: QueryRequest) -> Result<QueryResponse> {
        let sql = request.sql.trim();
        if !is_select(sql) {
            return Err(DriverError::Unsupported(
                "CQL supports one SELECT per run".into(),
            ));
        }
        let started = Instant::now();
        let session = self.session_for(request.database.as_deref()).await?;
        let max_rows = request.max_rows.unwrap_or(1000).max(1) as usize;
        let mut statement = Statement::new(sql);
        statement.set_page_size((max_rows.saturating_add(1).min(MAX_PAGE_SIZE as usize)) as i32);
        let pager = session
            .query_iter(statement, &[])
            .await
            .map_err(query_error)?;
        let state = session.get_cluster_state();
        let may_alias = sql
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .any(|word| word.eq_ignore_ascii_case("as"));
        let columns = pager
            .column_specs()
            .iter()
            .map(|spec| ColumnMeta {
                name: spec.name().into(),
                data_type: Some(type_name(spec.typ())),
                // DECIMAL partition keys are routed by their encoded bytes.
                // When aliases may hide the name, preserve scale if any such key exists.
                compare_as_decimal: matches!(spec.typ(), ColumnType::Native(NativeType::Decimal))
                    && lookup_table(
                        &state,
                        spec.table_spec().ks_name(),
                        spec.table_spec().table_name(),
                    )
                    .is_ok_and(|(table, _)| {
                        !table.partition_key.iter().any(|name| {
                            name == spec.name()
                                || (may_alias
                                    && matches!(
                                        table.columns[name].typ,
                                        ColumnType::Native(NativeType::Decimal)
                                    ))
                        })
                    }),
            })
            .collect();
        let mut stream = pager.rows_stream::<Row>().map_err(query_error)?;
        let mut rows = Vec::new();
        let mut truncated = false;
        while let Some(row) = stream.try_next().await.map_err(query_error)? {
            if rows.len() == max_rows {
                truncated = true;
                break;
            }
            rows.push(row_values(row));
        }
        Ok(result_table(sql.into(), columns, rows, started, truncated))
    }

    async fn execute_cancellable(
        &self,
        request: QueryRequest,
        cancel: CancellationToken,
    ) -> Result<QueryResponse> {
        tokio::select! {
            _ = cancel.cancelled() => Err(DriverError::Cancelled("stopped waiting for the CQL query".into())),
            result = self.execute(request) => result,
        }
    }
}

fn is_select(mut text: &str) -> bool {
    loop {
        text = text.trim_start();
        if text.starts_with("--") || text.starts_with("//") {
            text = text.split_once(['\r', '\n']).map_or("", |(_, after)| after);
        } else if let Some(comment) = text.strip_prefix("/*") {
            text = comment.split_once("*/").map_or("", |(_, after)| after);
        } else {
            return text
                .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                .next()
                .is_some_and(|word| word.eq_ignore_ascii_case("select"));
        }
    }
}

fn result_table(
    statement: String,
    columns: Vec<ColumnMeta>,
    rows: Vec<Vec<Value>>,
    started: Instant,
    truncated: bool,
) -> QueryResponse {
    let total_ms = started.elapsed().as_millis() as u64;
    QueryResponse {
        results: vec![StatementResult {
            statement,
            is_query: true,
            columns,
            row_count: rows.len(),
            rows,
            affected_rows: None,
            last_insert_id: None,
            execution_ms: total_ms,
            truncated,
            error: None,
        }],
        total_ms,
        failed_row: None,
    }
}

fn row_values(row: Row) -> Vec<Value> {
    row.columns
        .into_iter()
        .map(|value| value.map_or(Value::Null, cql_json))
        .collect()
}

fn decimal_text(value: CqlDecimal) -> String {
    use bigdecimal::num_bigint::Sign;

    let decimal = bigdecimal::BigDecimal::from(value);
    let scale = decimal.fractional_digit_count();
    // Keep the text round-trippable as a partition key. Display can pad
    // negative scales to integers and omits the scale of zero.
    if scale < 0 {
        let (coefficient, _) = decimal.into_bigint_and_scale();
        return format!("{coefficient}E{:+}", -scale);
    }
    if decimal.sign() == Sign::NoSign {
        return match scale {
            0 => "0".into(),
            1..=6 => format!("0.{}", "0".repeat(scale as usize)),
            _ => format!("0E-{scale}"),
        };
    }
    decimal.to_string()
}

fn cql_json(value: CqlValue) -> Value {
    use CqlValue::*;
    match value {
        Ascii(v) | Text(v) => json!(v),
        Boolean(v) => json!(v),
        Blob(v) => json!(format!("base64:{}", BASE64.encode(v))),
        BigInt(v) => json_i64(v),
        Counter(v) => json_i64(v.0),
        Int(v) => json!(v),
        SmallInt(v) => json!(v),
        TinyInt(v) => json!(v),
        Float(v) => {
            if v.is_finite() {
                json!(v)
            } else {
                json!(v.to_string())
            }
        }
        Double(v) => {
            if v.is_finite() {
                json!(v)
            } else {
                json!(v.to_string())
            }
        }
        Varint(v) => json!(bigdecimal::num_bigint::BigInt::from(v).to_string()),
        Decimal(v) => json!(decimal_text(v)),
        Date(v) => json!(i64::from(v.0) - (1_i64 << 31)),
        Timestamp(v) => json_i64(v.0),
        Time(v) => json_i64(v.0),
        Duration(v) => {
            json!({ "months": v.months, "days": v.days, "nanoseconds": json_i64(v.nanoseconds) })
        }
        Inet(v) => json!(v.to_string()),
        Uuid(v) => json!(v.to_string()),
        Timeuuid(v) => json!(v.to_string()),
        List(v) | Set(v) | Vector(v) => Value::Array(v.into_iter().map(cql_json).collect()),
        Map(v) => Value::Array(
            v.into_iter()
                .map(|(key, value)| json!([cql_json(key), cql_json(value)]))
                .collect(),
        ),
        Tuple(v) => Value::Array(
            v.into_iter()
                .map(|v| v.map_or(Value::Null, cql_json))
                .collect(),
        ),
        UserDefinedType { fields, .. } => Value::Object(
            fields
                .into_iter()
                .map(|(name, value)| (name, value.map_or(Value::Null, cql_json)))
                .collect(),
        ),
        Empty => json!({ "cqlEmpty": true }),
        other => json!(format!("{other:?}")),
    }
}

fn parse_key(typ: &ColumnType<'_>, text: &str) -> std::result::Result<CqlValue, String> {
    let invalid = || format!("expected {}", type_name(typ));
    let trimmed = text.trim();
    macro_rules! parse {
        ($variant:ident) => {
            trimmed
                .parse()
                .map(CqlValue::$variant)
                .map_err(|_| invalid())
        };
    }
    match typ {
        ColumnType::Native(typ) => match typ {
            NativeType::Text => Ok(CqlValue::Text(text.into())),
            NativeType::Ascii if text.is_ascii() => Ok(CqlValue::Ascii(text.into())),
            NativeType::Boolean => parse!(Boolean),
            NativeType::TinyInt => parse!(TinyInt),
            NativeType::SmallInt => parse!(SmallInt),
            NativeType::Int => parse!(Int),
            NativeType::BigInt => parse!(BigInt),
            NativeType::Float => parse!(Float),
            NativeType::Double => parse!(Double),
            NativeType::Inet => parse!(Inet),
            NativeType::Uuid => parse!(Uuid),
            NativeType::Timeuuid => trimmed
                .parse::<CqlTimeuuid>()
                .map(CqlValue::Timeuuid)
                .map_err(|_| invalid()),
            NativeType::Varint => trimmed
                .parse::<bigdecimal::num_bigint::BigInt>()
                .map(|value| CqlValue::Varint(CqlVarint::from(value)))
                .map_err(|_| invalid()),
            NativeType::Decimal => trimmed
                .parse::<bigdecimal::BigDecimal>()
                .ok()
                .and_then(|value| CqlDecimal::try_from(value).ok())
                .map(CqlValue::Decimal)
                .ok_or_else(invalid),
            NativeType::Date => trimmed
                .parse::<i64>()
                .ok()
                .and_then(|days| days.checked_add(1_i64 << 31))
                .and_then(|days| u32::try_from(days).ok())
                .map(|days| CqlValue::Date(CqlDate(days)))
                .ok_or_else(|| "enter days since the Unix epoch".into()),
            NativeType::Timestamp => trimmed
                .parse::<i64>()
                .map(|ms| CqlValue::Timestamp(CqlTimestamp(ms)))
                .map_err(|_| "enter milliseconds since the Unix epoch".into()),
            NativeType::Time => trimmed
                .parse::<i64>()
                .ok()
                .filter(|nanos| (0..86_400_000_000_000).contains(nanos))
                .map(|nanos| CqlValue::Time(CqlTime(nanos)))
                .ok_or_else(|| "enter nanoseconds since midnight".into()),
            NativeType::Blob => BASE64
                .decode(trimmed.strip_prefix("base64:").unwrap_or(trimmed))
                .map(CqlValue::Blob)
                .map_err(|_| "enter base64-encoded bytes".into()),
            NativeType::Ascii => Err(invalid()),
            _ => Err(format!(
                "{} keys can be queried in the CQL editor",
                type_name(&ColumnType::Native(typ.clone()))
            )),
        },
        _ => Err(format!(
            "{} keys can be queried in the CQL editor",
            type_name(typ)
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_console_accepts_comments_and_rejects_writes() {
        assert!(is_select(
            "// comment\n/* another */ -- last\nSELECT ';' FROM test"
        ));
        assert!(!is_select("/* SELECT */ DELETE FROM test"));
        assert!(!is_select("SELECTED"));
    }

    #[test]
    fn partition_values_and_result_cells_keep_exact_types() {
        let bigint = ColumnType::Native(NativeType::BigInt);
        let parsed = parse_key(&bigint, "9007199254740993").unwrap();
        assert_eq!(cql_json(parsed), json!("9007199254740993"));
        let decimal = ColumnType::Native(NativeType::Decimal);
        assert_eq!(
            cql_json(parse_key(&decimal, "98765432109876543210.01").unwrap()),
            json!("98765432109876543210.01")
        );
        for value in ["0.00", "0E-2147483647", "0E+2147483648", "12E+1", "120"] {
            assert_eq!(cql_json(parse_key(&decimal, value).unwrap()), json!(value));
        }
        let text = ColumnType::Native(NativeType::Text);
        assert_eq!(
            parse_key(&text, " x'; DELETE ").unwrap(),
            CqlValue::Text(" x'; DELETE ".into())
        );
    }

    #[tokio::test]
    #[ignore = "requires a disposable local CQL server at QUARRY_CQL_TEST_PORT"]
    async fn live_keyspaces_and_partition_paging() {
        let port = std::env::var("QUARRY_CQL_TEST_PORT")
            .expect("set QUARRY_CQL_TEST_PORT to a disposable localhost database")
            .parse()
            .unwrap();
        let test_tablets = std::env::var_os("QUARRY_CQL_TEST_TABLETS").is_some();
        let config = ConnectionConfig {
            driver: "cql".into(),
            host: "127.0.0.1".into(),
            port,
            username: std::env::var("QUARRY_CQL_TEST_USER").unwrap_or_default(),
            password: std::env::var("QUARRY_CQL_TEST_PASSWORD").ok(),
            database: None,
            ssl_mode: if std::env::var_os("QUARRY_CQL_TEST_CA").is_some() {
                SslMode::Required
            } else {
                SslMode::Disabled
            },
            options: std::env::var("QUARRY_CQL_TEST_CA")
                .ok()
                .map(|path| serde_json::Map::from_iter([("caFile".into(), json!(path))]))
                .unwrap_or_default(),
        };
        let (settings, _) = Settings::new(&config).await.unwrap();
        let seed = settings.open(None).await.unwrap();
        let local = seed
            .query_unpaged("SELECT host_id, data_center, rack FROM system.local", &[])
            .await
            .unwrap()
            .into_rows_result()
            .unwrap();
        let (host_id, datacenter, rack) = local.single_row::<(Uuid, String, String)>().unwrap();
        let replication_dc = datacenter.replace('\'', "''");
        let first = format!("quarry_cql_{}", Uuid::new_v4().simple());
        let second = format!("quarry_cql_{}", Uuid::new_v4().simple());
        for database in [&first, &second] {
            let tablets = if test_tablets {
                format!(" AND tablets = {{'enabled':{}}}", database == &second)
            } else {
                String::new()
            };
            seed.query_unpaged(
                format!("CREATE KEYSPACE {database} WITH replication = {{'class':'NetworkTopologyStrategy','{replication_dc}':1}}{tablets}"),
                &[],
            ).await.unwrap();
            seed.query_unpaged(
                format!("CREATE TABLE {database}.events (tenant text, bucket int, seq bigint, amount decimal, PRIMARY KEY ((tenant, bucket), seq))"),
                &[],
            ).await.unwrap();
            seed.query_unpaged(format!("INSERT INTO {database}.events (tenant, bucket, seq, amount) VALUES ('north', 1, 9007199254740993, 12.34)"), &[]).await.unwrap();
        }
        seed.query_unpaged(format!("INSERT INTO {first}.events (tenant, bucket, seq) VALUES ('north', 1, 9007199254740994)"), &[]).await.unwrap();
        seed.query_unpaged(format!("INSERT INTO {first}.events (tenant, bucket, seq) VALUES ('south', 1, 9007199254740995)"), &[]).await.unwrap();
        for sql in [
            format!("CREATE TABLE {first}.decimal_cluster (tenant text, amount decimal, PRIMARY KEY (tenant, amount))"),
            format!("INSERT INTO {first}.decimal_cluster (tenant, amount) VALUES ('before', 12.0)"),
            format!("INSERT INTO {first}.decimal_cluster (tenant, amount) VALUES ('after', 12.00)"),
            format!("CREATE TABLE {first}.decimal_partition (amount decimal, cluster decimal, label text, PRIMARY KEY (amount, cluster))"),
        ] {
            seed.query_unpaged(sql, &[]).await.unwrap();
        }
        let driver = CqlDriver;
        let conn = driver.connect(&config).await.unwrap();
        assert!(conn
            .list_databases()
            .await
            .unwrap()
            .iter()
            .any(|db| db.name == first));
        assert!(conn
            .list_objects(&first, None)
            .await
            .unwrap()
            .iter()
            .any(|object| object.name == "events"));
        let keys = conn.partition_keys(&first, "events").await.unwrap();
        assert_eq!(
            keys.iter().map(|key| key.name.as_str()).collect::<Vec<_>>(),
            ["tenant", "bucket"]
        );
        let query = |database: &str, sql: &str| QueryRequest {
            sql: sql.into(),
            database: Some(database.into()),
            max_rows: Some(1),
            timeout_ms: None,
            run_id: None,
        };
        let events = "SELECT seq, amount FROM events WHERE tenant = 'north' AND bucket = 1";
        let (before, after) = tokio::join!(
            conn.execute(query(&first, events)),
            conn.execute(query(&second, events))
        );
        let before = before.unwrap();
        let after = after.unwrap();
        assert!(before.results[0].truncated);
        assert!(!after.results[0].truncated);
        assert_eq!(
            after.results[0].rows[0],
            [json!("9007199254740993"), json!("12.34")]
        );
        assert!(after.results[0].columns[1].compare_as_decimal);
        for (tenant, filter, expected) in [("before", "12.00", "12.0"), ("after", "12.0", "12.00")]
        {
            let sql = format!("SELECT amount AS price FROM decimal_cluster WHERE tenant = '{tenant}' AND amount = {filter}");
            let result = conn.execute(query(&first, &sql)).await.unwrap();
            assert_eq!(result.results[0].rows, [vec![json!(expected)]]);
            let column = &result.results[0].columns[0];
            assert_eq!(column.name, "price");
            assert!(column.compare_as_decimal);
        }
        for (value, label) in [
            ("12.0", "one"),
            ("12.00", "two"),
            ("0.0", "zero"),
            ("0.00", "scaled zero"),
            ("12E+1", "exponent"),
            ("120.0", "fixed"),
        ] {
            seed.query_unpaged(
                format!("INSERT INTO {first}.decimal_partition (amount, cluster, label) VALUES ({value}, 3.00, '{label}')"),
                &[],
            ).await.unwrap();
            let sql = format!(
                "SELECT amount AS cluster, label FROM decimal_partition WHERE amount = {value}"
            );
            let result = conn.execute(query(&first, &sql)).await.unwrap();
            assert_eq!(result.results[0].rows, [vec![json!(value), json!(label)]]);
            assert!(!result.results[0].columns[0].compare_as_decimal);

            let sql =
                format!("SELECT amount, cluster FROM decimal_partition WHERE amount = {value}");
            let result = conn.execute(query(&first, &sql)).await.unwrap();
            assert_eq!(result.results[0].rows, [vec![json!(value), json!("3.00")]]);
            assert!(!result.results[0].columns[0].compare_as_decimal);
            assert!(result.results[0].columns[1].compare_as_decimal);

            let page = conn
                .read_partition(PartitionRequest {
                    database: first.clone(),
                    table: "decimal_partition".into(),
                    keys: vec![PartitionKeyValue {
                        column: "amount".into(),
                        value: value.into(),
                    }],
                    page_size: 2,
                    continuation: None,
                    timeout_ms: None,
                    run_id: None,
                    trace: false,
                })
                .await
                .unwrap();
            let result = &page.result.results[0];
            assert_eq!(result.rows.len(), 1);
            for (name, expected, comparable) in [
                ("amount", value, false),
                ("cluster", "3.00", true),
                ("label", label, false),
            ] {
                let index = result
                    .columns
                    .iter()
                    .position(|column| column.name == name)
                    .unwrap();
                assert_eq!(result.rows[0][index], json!(expected));
                assert_eq!(result.columns[index].compare_as_decimal, comparable);
            }
        }
        let mut request = PartitionRequest {
            database: first.clone(),
            table: "events".into(),
            keys: vec![
                PartitionKeyValue {
                    column: "tenant".into(),
                    value: "north".into(),
                },
                PartitionKeyValue {
                    column: "bucket".into(),
                    value: "1".into(),
                },
            ],
            page_size: 1,
            continuation: None,
            timeout_ms: None,
            run_id: None,
            trace: false,
        };
        let (server_token,) = seed
            .query_unpaged(
                format!("SELECT token(tenant, bucket) FROM {first}.events WHERE tenant = 'north' AND bucket = 1 LIMIT 1"),
                &[],
            )
            .await
            .unwrap()
            .into_rows_result()
            .unwrap()
            .single_row::<(i64,)>()
            .unwrap();
        let initial = conn.read_partition(request.clone()).await.unwrap();
        assert!(initial.trace.is_none());
        let token = Some(server_token.to_string());
        assert_eq!(initial.diagnostics.token, token);
        let coordinator = &initial.diagnostics.coordinator;
        assert_eq!(coordinator.host_id, host_id);
        assert_eq!(coordinator.datacenter.as_deref(), Some(datacenter.as_str()));
        assert_eq!(coordinator.rack.as_deref(), Some(rack.as_str()));
        if test_tablets || coordinator.shard.is_none() {
            assert_eq!(
                initial.diagnostics.placement,
                Some(PartitionPlacement::TokenRing)
            );
            assert_eq!(initial.diagnostics.replicas.len(), 1);
            let replica = &initial.diagnostics.replicas[0];
            assert_eq!(replica.host_id, host_id);
            assert_eq!(replica.datacenter, coordinator.datacenter);
            assert_eq!(replica.rack, coordinator.rack);
            assert_eq!(replica.shard.is_some(), test_tablets);
        }
        if test_tablets {
            let (table_id,) = seed
                .query_unpaged(
                    "SELECT id FROM system_schema.tables WHERE keyspace_name = ? AND table_name = ?",
                    (&second, "events"),
                )
                .await
                .unwrap()
                .into_rows_result()
                .unwrap()
                .single_row::<(Uuid,)>()
                .unwrap();
            let (server_replicas,) = seed
                .query_unpaged(
                    "SELECT replicas FROM system.tablets WHERE table_id = ? AND last_token >= ? LIMIT 1",
                    (table_id, server_token),
                )
                .await
                .unwrap()
                .into_rows_result()
                .unwrap()
                .single_row::<(Vec<(Uuid, i32)>,)>()
                .unwrap();
            let mut tablet_request = request.clone();
            tablet_request.database = second.clone();
            let mut tablet_page = conn.read_partition(tablet_request.clone()).await.unwrap();
            // The driver applies tablet updates in its background cluster worker.
            // With the V1 protocol, it only learns a tablet after a misrouted read.
            for _ in 0..16 {
                if !tablet_page.diagnostics.replicas.is_empty() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                tablet_page = conn.read_partition(tablet_request.clone()).await.unwrap();
            }
            assert_eq!(tablet_page.diagnostics.token, token);
            assert_eq!(
                tablet_page.diagnostics.placement,
                Some(PartitionPlacement::Tablets)
            );
            assert_eq!(tablet_page.diagnostics.coordinator.host_id, host_id);
            assert!(tablet_page.diagnostics.coordinator.shard.is_some());
            let known_replicas = tablet_page
                .diagnostics
                .replicas
                .iter()
                .map(|replica| (replica.host_id, replica.shard.unwrap() as i32))
                .collect::<Vec<_>>();
            assert!(!server_replicas.is_empty());
            assert_eq!(known_replicas, server_replicas);
        }
        assert!(initial.result.results[0]
            .columns
            .iter()
            .any(|column| column.name == "amount" && column.compare_as_decimal));
        request.continuation = Some(initial.continuation.unwrap());
        let mut different = request.clone();
        different.keys[0].value = "south".into();
        assert!(conn.read_partition(different).await.is_err());
        let next = conn.read_partition(request.clone()).await.unwrap();
        assert_eq!(next.diagnostics.token, token);
        assert_eq!(next.diagnostics.coordinator.host_id, host_id);
        assert_eq!(next.result.results[0].rows.len(), 1);
        let sequence = next.result.results[0]
            .columns
            .iter()
            .position(|column| column.name == "seq")
            .unwrap();
        assert_eq!(
            next.result.results[0].rows[0][sequence],
            json!("9007199254740994")
        );
        let mut trace_request = request.clone();
        trace_request.trace = true;
        // Expire only the event lookup budget after obtaining the page and trace ID.
        trace_request.timeout_ms = Some(0);
        let retry = conn.read_partition(trace_request).await.unwrap();
        assert_eq!(retry.result.results[0].rows, next.result.results[0].rows);
        let Some(PartitionTrace::Unavailable { id: Some(trace_id) }) = retry.trace else {
            panic!(
                "expected a trace ID for delayed events, got {:?}",
                retry.trace
            );
        };
        let fetched = conn.fetch_partition_trace(trace_id).await.unwrap();
        let PartitionTrace::Available { id, events, .. } = fetched else {
            panic!("expected trace events after retrying the same ID, got {fetched:?}",);
        };
        assert_eq!(id, trace_id);
        assert!(!events.is_empty());
        assert!(events
            .iter()
            .any(|event| event.source.is_some() && event.activity.is_some()));
        request.continuation = retry.continuation;
        if request.continuation.is_some() {
            let end = conn.read_partition(request.clone()).await.unwrap();
            assert!(end.result.results[0].rows.is_empty());
            assert!(end.trace.is_none());
        }
        request.continuation = None;
        request.keys[0].value = "absent".into();
        let empty = conn.read_partition(request).await.unwrap();
        assert_eq!(empty.result.results[0].columns.len(), 4);
        assert!(empty.result.results[0].rows.is_empty());
        for database in [&first, &second] {
            seed.query_unpaged(format!("DROP KEYSPACE {database}"), &[])
                .await
                .unwrap();
        }
    }
}
