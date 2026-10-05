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

export interface OpenSessionRequest {
  profileId?: string | null;
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
