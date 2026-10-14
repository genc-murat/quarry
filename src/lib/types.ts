/**
 * TypeScript mirror of the Rust DTOs in `src-tauri/src/models.rs`.
 *
 * These are kept in sync by hand; the wire format is camelCase on both sides.
 * Keeping a single source of truth here is what lets every driver share one UI.
 */

export type SslMode = "disabled" | "preferred" | "required";
export type QueryLanguage = "sql" | "redis" | "mongo" | "http" | "none";
export type ResultShape = "tabular" | "document" | "keyValue";
export type ObjectKind =
  | "table"
  | "view"
  | "materializedView"
  | "collection"
  | "keySpace"
  | "key"
  | "function"
  | "procedure"
  | "trigger"
  | "event"
  | "sequence"
  | "other";
export type FieldType = "text" | "number" | "password" | "select" | "boolean";

export type ObjectAction =
  | "inspect"
  | "viewData"
  | "countRows"
  | "copyName"
  | "copyQualifiedName"
  | "copyDdl"
  | "generateDdl"
  | "templateSelect"
  | "templateInsert"
  | "templateUpdate"
  | "templateDelete"
  | "exportData"
  | "renameObject"
  | "duplicateObject"
  | "dropObject"
  | "truncate"
  | "maintenance"
  | "reindex"
  | "createIndex"
  | "dropIndex"
  | "addColumn"
  | "alterColumn"
  | "dropColumn";

export type IndexKind = "btree" | "hash" | "fullText";
export type MaintenanceKind = "optimize" | "analyze" | "vacuum";

export interface SelectOption {
  value: string;
  label: string;
}

export interface ConfigField {
  key: string;
  label: string;
  fieldType: FieldType;
  placeholder?: string | null;
  required: boolean;
  defaultValue?: unknown;
  options: SelectOption[];
  help?: string | null;
}

export interface DriverCapabilities {
  queryLanguage: QueryLanguage;
  resultShape: ResultShape;
  isRelational: boolean;
  supportsMultipleDatabases: boolean;
  supportsSchemas: boolean;
  supportsTransactions: boolean;
  supportsDdl: boolean;
  supportsExplain: boolean;
  supportsCancel: boolean;
  objectKinds: ObjectKind[];
  supportedActions: ObjectAction[];
}

export interface DriverDescriptor {
  id: string;
  displayName: string;
  defaultPort: number;
  accentColor: string;
  capabilities: DriverCapabilities;
  configFields: ConfigField[];
}

export interface ConnectionProfile {
  id: string;
  name: string;
  driver: string;
  host: string;
  port: number;
  username: string;
  database?: string | null;
  sslMode: SslMode;
  options: Record<string, unknown>;
  hasPassword: boolean;
}

export interface ServerInfo {
  version?: string | null;
  versionNumber?: number | null;
  serverComment?: string | null;
  currentDatabase?: string | null;
  currentUser?: string | null;
  supportsTls: boolean;
}

export interface SessionInfo {
  id: string;
  profileId: string;
  driver: string;
  name: string;
  server: ServerInfo;
}

export interface ConnectResult {
  session: SessionInfo;
}

/**
 * What a request's candidates are. It picks the wording of the question the
 * model is asked — nothing else about the answer's shape changes.
 *
 * `repair` is the odd one out: its question is about a failure rather than about
 * a line being typed, it is the only one that carries an `error`, and it is the
 * only one whose answer may be "none of these" (an empty `ranked`, with the
 * client's own reason beside it).
 */
export type RankCandidateKind = "table" | "column" | "repair";

/**
 * How far running a statement could go, as the model's scale is stepped.
 *
 * The steps are ordered, and the words behind them — the scale the model was
 * asked to place the statement on — are defined and measured in
 * `src-tauri/src/decision.rs`. The client reports which step the answer landed
 * on and where on the scale it landed; which steps are worth a mark is the
 * editor's policy, and it lives in `src/lib/statementRisk.ts`.
 */
export type RiskVerdict = "safe" | "bounded" | "rows" | "structure";

/** What the model read about one statement, as the client reports it. */
export interface StatementReading {
  /** The statement as it was sent, which is the only text it describes. */
  statement: string;
  verdict: RiskVerdict;
  /** Where on the scale the model put it, in steps: 0 is the first step. */
  level: number;
  /** How sure the model was of that position, 0..1. */
  confidence: number;
}

/** What the editor sends to the local decision model to rank its suggestions. */
export interface RankCandidatesRequest {
  /** The line being typed; the block the ranking question is asked about. */
  state: string;
  /** Names the identifier could still complete to. Fewer than two is no question
   *  at all — unless `statements` is sent, which is a question of its own. */
  candidates: string[];
  model: string;
  /** What the candidates are: table names at a `FROM` position, column names
   *  after a qualifier. Omitted means tables. */
  kind?: RankCandidateKind;
  /**
   * The statements a command would send, in the order it would send them: the
   * statement under the cursor, the statements of a selection, or a script's.
   * Each adds a risk question to this same request, so a reading costs a
   * question rather than a call.
   */
  statements?: string[];
  /**
   * The database's own error for a statement that failed. It is the subject of
   * the `repair` question — which name the SQL most likely meant — and nothing
   * else reads it. A repair question needs both halves of a failure: this one and
   * the statement in `statements`.
   */
  error?: string | null;
}

/**
 * The model's ranking. `available` is false when no model answered (not
 * installed, not running, too slow); `ranked` is then empty and the caller
 * keeps its ordinary order.
 */
export interface RankCandidatesResponse {
  ranked: string[];
  choice: string | null;
  confidence: number;
  /** True when the *ranking* question was answered, which is a different fact
   *  from any of the risk ones, and from a model that said nothing at all. */
  available: boolean;
  reason: string | null;
  /**
   * One reading per statement the model answered about, each echoing the
   * statement as it was sent. Empty when no statement was sent, and when no
   * question was answered: a statement with no reading has none, which is what
   * keeps a silent model from reading as "safe".
   */
  readings: StatementReading[];
}

/**
 * What the local model suggested for a statement that did not run.
 *
 * `name` is null whenever there is no suggestion to make — the model declined,
 * was not sure enough, or no model answered at all — and `reason` is what tells
 * those apart, in the client's own words (`src-tauri/src/decision.rs`). Nothing
 * here is a claim about the SQL: it is what the model said when it was shown the
 * failure and the schema's names, and nothing else.
 */
export interface StatementRepair {
  /** The statement as it was sent, which is the only text it describes. */
  statement: string;
  /** The database's own error it was asked about. */
  error: string;
  /** The name the SQL most likely meant, or null when there is none to offer. */
  name: string | null;
  /** How sure the model was of that name, 0..1. */
  confidence: number;
  /** Why there is no suggestion, when the layer below gave a reason. */
  reason: string | null;
}

export interface DatabaseInfo {
  name: string;
  isSystem: boolean;
}

export interface NamespaceInfo {
  name: string;
}

export interface DatabaseObject {
  name: string;
  kind: ObjectKind;
  schema?: string | null;
  comment?: string | null;
  rowEstimate?: number | null;
}

export interface ColumnSchema {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue?: string | null;
  isPrimaryKey: boolean;
  isAutoIncrement: boolean;
  comment?: string | null;
  ordinal: number;
}

export interface IndexSchema {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface ForeignKeySchema {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
}

export interface ObjectSchema {
  name: string;
  kind: ObjectKind;
  columns: ColumnSchema[];
  indexes: IndexSchema[];
  foreignKeys: ForeignKeySchema[];
}

export interface ColumnMeta {
  name: string;
  dataType?: string | null;
}

export interface StatementResult {
  statement: string;
  isQuery: boolean;
  columns: ColumnMeta[];
  rows: unknown[][];
  rowCount: number;
  affectedRows?: number | null;
  lastInsertId?: number | null;
  executionMs: number;
  truncated: boolean;
  error?: string | null;
}

export interface QueryResponse {
  results: StatementResult[];
  totalMs: number;
}

export interface TableColumns {
  table: string;
  schema?: string | null;
  columns: ColumnMeta[];
}

export interface QueryRequest {
  database?: string | null;
  sql: string;
  maxRows?: number | null;
  timeoutMs?: number | null;
  /** Caller-generated id, used to cancel the run via `cancelQuery`. */
  runId?: string | null;
}

export interface ColumnDefinition {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue?: string | null;
  isPrimaryKey: boolean;
  isAutoIncrement: boolean;
  comment?: string | null;
  after?: string | null;
}

export interface IndexDefinition {
  name?: string | null;
  columns: string[];
  unique: boolean;
  kind: IndexKind;
  prefixLengths: number[];
}

export interface ObjectActionRequest {
  connectionId: string;
  database: string;
  namespace?: string | null;
  object: string;
  objectKind?: ObjectKind | null;
  action: ObjectAction;
  newName?: string | null;
  withData?: boolean | null;
  ifExists?: boolean | null;
  cascade?: boolean | null;
  maintenance?: MaintenanceKind | null;
  index?: IndexDefinition | null;
  indexName?: string | null;
  column?: ColumnDefinition | null;
  renameTo?: string | null;
}

export interface ObjectDetail {
  schema: ObjectSchema;
  ddl: string;
  rowCount?: number | null;
  sizeBytes?: number | null;
  actions: ObjectAction[];
  identifierQuote: string;
  /** Panels the driver declares for this object, rendered generically. */
  sections: InspectorSection[];
}

/** Where a section's body comes from. */
export type SectionSource = "inline" | "live";

/** How a cell value is formatted. */
export type SectionFormat = "text" | "number" | "bytes";

/** Which part of a record a column belongs to. */
export type SectionColumnRole = "meta" | "body";

/** Accent for a value; a per-row value may override its column's tone. */
export type SectionTone = "neutral" | "success" | "warning" | "danger";

export interface SectionColumn {
  key: string;
  label: string;
  role: SectionColumnRole;
  format: SectionFormat;
  tone: SectionTone;
  /** Suffix appended to the formatted value, e.g. `ms`. */
  unit?: string | null;
}

export interface SectionField {
  label: string;
  /** `null` renders as an em dash. */
  value?: string | null;
}

/**
 * An operation a section offers. When `param` names a column the action is
 * rendered once per row and that row's value is sent back as the parameter.
 */
export interface SectionAction {
  id: string;
  label: string;
  /** Longer label for the confirmation title; falls back to `label`. */
  confirmLabel?: string | null;
  description?: string | null;
  danger: boolean;
  param?: string | null;
  requireParam: boolean;
}

/** A cell is a plain JSON value, or `{ text, tone }` to accent it per row. */
export type SectionCell = unknown;

export type SectionBlock =
  | { type: "fields"; title?: string | null; fields: SectionField[] }
  | {
      type: "table";
      title?: string | null;
      columns: SectionColumn[];
      rows: Record<string, SectionCell>[];
      emptyText?: string | null;
      actions: SectionAction[];
    }
  | {
      type: "log";
      title?: string | null;
      columns: SectionColumn[];
      rows: Record<string, SectionCell>[];
      emptyText?: string | null;
    };

/** One panel in the object inspector, described by the driver itself. */
export interface InspectorSection {
  id: string;
  label: string;
  source: SectionSource;
  /** Extra context next to the section title, e.g. `system.query_log`. */
  hint?: string | null;
  /** Shown when a `live` body cannot be loaded. */
  errorHint?: string | null;
  /** Empty for a `live` section until its body is fetched. */
  blocks: SectionBlock[];
  /** Actions that apply to the object rather than to a single row. */
  actions: SectionAction[];
}

export interface ObjectSectionRequest {
  connectionId: string;
  database: string;
  namespace?: string | null;
  object: string;
  section: string;
  limit?: number | null;
}

export interface ObjectSectionActionRequest {
  connectionId: string;
  database: string;
  namespace?: string | null;
  object: string;
  section: string;
  action: string;
  param?: string | null;
}

export type RowChangeKind = "insert" | "update" | "delete";

/** One column/value pair in a row mutation. */
export interface RowValue {
  column: string;
  value: unknown;
}

/**
 * A single-row edit produced by the results grid. The backend renders dialect
 * SQL from it (never interpolating identifiers) and refuses any update/delete
 * whose key does not cover the table's primary key.
 */
export interface RowChangeRequest {
  connectionId: string;
  database: string;
  namespace?: string | null;
  object: string;
  kind: RowChangeKind;
  key: RowValue[];
  values: RowValue[];
}

export interface CreateTableRequest {
  connectionId: string;
  database: string;
  namespace?: string | null;
  table: string;
  columns: ColumnDefinition[];
  ifNotExists?: boolean | null;
  comment?: string | null;
  /** ClickHouse only: table engine. Defaults to MergeTree. */
  engine?: string | null;
  /** ClickHouse only: sorting key columns (ORDER BY). */
  orderBy?: string[];
  /** ClickHouse only: raw SQL partition expression. */
  partitionBy?: string | null;
  /** ClickHouse only: raw SQL primary-key expression. */
  primaryKey?: string | null;
  /** ClickHouse only: raw SQL TTL expression. */
  ttl?: string | null;
  /** ClickHouse only: explicit MergeTree settings. */
  settings?: string[];
}

export interface Snippet {
  id: string;
  name: string;
  sql: string;
  database?: string | null;
  driver?: string | null;
  createdAt: number;
}

export interface SaveSnippetInput {
  id?: string | null;
  name: string;
  sql: string;
  database?: string | null;
  driver?: string | null;
}

export interface SaveConnectionInput {
  id?: string | null;
  name: string;
  driver: string;
  host: string;
  port: number;
  username: string;
  database?: string | null;
  sslMode: SslMode;
  options: Record<string, unknown>;
  password?: string | null;
}

/**
 * What an import of a connection transfer file did. Mirrors `ImportSummary` in
 * `src-tauri/src/transfer.rs`: the connections added here, the ones whose id was
 * already stored and left alone, and the entries this build has no driver for.
 */
export interface ImportConnectionsSummary {
  imported: number;
  skipped: number;
  unsupported: string[];
}

export interface OpenSessionRequest {
  profileId?: string | null;
  /**
   * A password typed at connect time. It is tried for this connection only and
   * is not stored by the backend; save it with the profile once it works.
   */
  password?: string | null;
  config?: {
    driver: string;
    host: string;
    port: number;
    username: string;
    password?: string | null;
    database?: string | null;
    sslMode: SslMode;
    options: Record<string, unknown>;
  } | null;
}
