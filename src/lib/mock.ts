/**
 * Development-only fake backend.
 *
 * The real app always talks to the Rust core through Tauri. When the frontend
 * is opened in a plain browser (`npm run dev` without the shell) this module
 * supplies representative data so the UI can be designed and reviewed without
 * a live database. It is never used inside the packaged desktop app.
 */
import type {
  ConnectResult,
  ConnectionProfile,
  DatabaseInfo,
  DatabaseObject,
  DriverDescriptor,
  NamespaceInfo,
  ObjectAction,
  ObjectActionRequest,
  ObjectDetail,
  ObjectSchema,
  CreateTableRequest,
  QueryRequest,
  QueryResponse,
  RowChangeRequest,
  ServerInfo,
  SessionInfo,
  Snippet,
} from "./types";

/** Actions a relational mock driver advertises for the context menu. */
const MOCK_ACTIONS: ObjectAction[] = [
  "inspect",
  "viewData",
  "countRows",
  "copyName",
  "copyQualifiedName",
  "copyDdl",
  "generateDdl",
  "templateSelect",
  "templateInsert",
  "templateUpdate",
  "templateDelete",
  "exportData",
  "renameObject",
  "duplicateObject",
  "dropObject",
  "truncate",
  "maintenance",
  "createIndex",
  "dropIndex",
  "addColumn",
  "alterColumn",
  "dropColumn",
];

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const MYSQL: DriverDescriptor = {
  id: "mysql",
  displayName: "MySQL",
  defaultPort: 3306,
  accentColor: "#0EA5B7",
  capabilities: {
    queryLanguage: "sql",
    resultShape: "tabular",
    isRelational: true,
    supportsMultipleDatabases: true,
    supportsSchemas: false,
    supportsTransactions: true,
    supportsDdl: true,
    supportsExplain: true,
    supportsCancel: true,
    objectKinds: ["table", "view", "function", "procedure", "trigger", "event"],
    supportedActions: MOCK_ACTIONS,
  },
  configFields: [
    { key: "host", label: "Host", fieldType: "text", required: true, defaultValue: "127.0.0.1", options: [] },
    { key: "port", label: "Port", fieldType: "number", required: true, defaultValue: 3306, options: [] },
    { key: "username", label: "Username", fieldType: "text", required: true, defaultValue: "root", options: [] },
    { key: "password", label: "Password", fieldType: "password", required: false, options: [] },
    { key: "database", label: "Database", fieldType: "text", required: false, options: [] },
    {
      key: "sslMode",
      label: "TLS",
      fieldType: "select",
      required: false,
      defaultValue: "preferred",
      help: "Disable TLS for servers older than MySQL 5.6.46.",
      options: [
        { value: "preferred", label: "Preferred" },
        { value: "required", label: "Required" },
        { value: "disabled", label: "Disabled (MySQL < 5.6.46)" },
      ],
    },
  ],
};

const POSTGRES: DriverDescriptor = {
  ...MYSQL,
  id: "postgres",
  displayName: "PostgreSQL",
  defaultPort: 5432,
  accentColor: "#3B82F6",
  capabilities: {
    ...MYSQL.capabilities,
    supportsSchemas: true,
    objectKinds: ["table", "view", "materializedView", "sequence", "function", "procedure", "trigger"],
    supportedActions: [...MOCK_ACTIONS, "reindex"],
  },
};

const PROFILE: ConnectionProfile = {
  id: "demo-profile",
  name: "Local MySQL 5.6",
  driver: "mysql",
  host: "127.0.0.1",
  port: 3306,
  username: "root",
  database: "shop",
  sslMode: "preferred",
  options: {},
  hasPassword: true,
};

const SERVER: ServerInfo = {
  version: "5.6.51-log",
  versionNumber: 50651,
  serverComment: "MySQL Community Server (GPL)",
  currentDatabase: "shop",
  currentUser: "root@localhost",
  supportsTls: true,
};

const SESSION: SessionInfo = {
  id: "demo-session",
  profileId: PROFILE.id,
  driver: "mysql",
  name: PROFILE.name,
  server: SERVER,
};

const DATABASES: DatabaseInfo[] = [
  { name: "shop", isSystem: false },
  { name: "analytics", isSystem: false },
  { name: "information_schema", isSystem: true },
  { name: "mysql", isSystem: true },
];

const OBJECTS: DatabaseObject[] = [
  { name: "customers", kind: "table", schema: "shop", comment: "Registered buyers", rowEstimate: 12480 },
  { name: "orders", kind: "table", schema: "shop", comment: "Order headers", rowEstimate: 58231 },
  { name: "order_items", kind: "table", schema: "shop", comment: null, rowEstimate: 173904 },
  { name: "products", kind: "table", schema: "shop", comment: "Catalogue", rowEstimate: 812 },
  { name: "v_recent_orders", kind: "view", schema: "shop", comment: "Last 30 days", rowEstimate: null },
  { name: "v_order_totals", kind: "view", schema: "shop", comment: "Revenue per order", rowEstimate: null },
  { name: "fn_order_total", kind: "function", schema: "shop", comment: "Grand total for an order", rowEstimate: null },
  { name: "sp_reindex_orders", kind: "procedure", schema: "shop", comment: null, rowEstimate: null },
  { name: "trg_orders_audit", kind: "trigger", schema: "shop", comment: "Audit every order change", rowEstimate: null },
  { name: "ev_purge_carts", kind: "event", schema: "shop", comment: "Nightly cart cleanup", rowEstimate: null },
  { name: "orders_id_seq", kind: "sequence", schema: "shop", comment: null, rowEstimate: null },
];

const SCHEMA: ObjectSchema = {
  name: "orders",
  kind: "table",
  columns: [
    { name: "id", dataType: "bigint(20) unsigned", nullable: false, isPrimaryKey: true, isAutoIncrement: true, ordinal: 1 },
    { name: "customer_id", dataType: "bigint(20) unsigned", nullable: false, isPrimaryKey: false, isAutoIncrement: false, ordinal: 2 },
    { name: "status", dataType: "enum('new','paid','shipped')", nullable: false, isPrimaryKey: false, isAutoIncrement: false, ordinal: 3 },
    { name: "total", dataType: "decimal(12,2)", nullable: false, isPrimaryKey: false, isAutoIncrement: false, ordinal: 4 },
    { name: "note", dataType: "text", nullable: true, isPrimaryKey: false, isAutoIncrement: false, ordinal: 5 },
    { name: "created_at", dataType: "datetime", nullable: false, isPrimaryKey: false, isAutoIncrement: false, ordinal: 6 },
  ],
  indexes: [
    { name: "PRIMARY", columns: ["id"], unique: true, primary: true },
    { name: "idx_customer", columns: ["customer_id"], unique: false, primary: false },
  ],
  foreignKeys: [
    { name: "fk_orders_customer", columns: ["customer_id"], referencedTable: "customers", referencedColumns: ["id"] },
  ],
};

// Mutable so save/delete are observable across mock calls, mirroring the real
// persisted store closely enough to review the flow in the browser.
const SNIPPETS: Snippet[] = [
  {
    id: "snippet-recent-orders",
    name: "Recent orders",
    sql: "SELECT id, customer_id, status, total, created_at\nFROM orders\nORDER BY created_at DESC\nLIMIT 50;",
    database: "shop",
    driver: "mysql",
    createdAt: 1_760_000_000_000,
  },
  {
    id: "snippet-table-sizes",
    name: "Table sizes",
    sql: "SELECT table_name, table_rows\nFROM information_schema.tables\nWHERE table_schema = DATABASE()\nORDER BY table_rows DESC;",
    database: "shop",
    driver: "mysql",
    createdAt: 1_760_000_100_000,
  },
];

const STATUSES = ["new", "paid", "shipped", "cancelled"];

const RESULT_COLUMNS = [
  { name: "id", dataType: "BIGINT" },
  { name: "sku", dataType: "VARBINARY" },
  { name: "customer", dataType: "VARCHAR" },
  { name: "status", dataType: "ENUM" },
  { name: "total", dataType: "DECIMAL" },
  { name: "note", dataType: "TEXT" },
  { name: "created_at", dataType: "DATETIME" },
];

function sampleRows(): unknown[][] {
  return Array.from({ length: 240 }, (_, index) => [
    index + 1,
    `0x${(index * 7919).toString(16).padStart(6, "0")}`,
    `customer_${(index % 97) + 1}`,
    STATUSES[index % STATUSES.length],
    (index * 13.37).toFixed(2),
    index % 11 === 0 ? null : `note ${index}`,
    `2026-0${(index % 9) + 1}-1${index % 9} 09:${String(index % 60).padStart(2, "0")}:00`,
  ]);
}

// A single mutable result set so a row edit made in the grid is visible after
// the preview reloads, mirroring the real backend closely enough to review.
const PREVIEW_ROWS: unknown[][] = sampleRows();
const PREVIEW_COLUMNS = RESULT_COLUMNS.map((column) => column.name);

/** Apply one grid row change to the mutable fixture. */
function applyRowChange(request: RowChangeRequest) {
  const idIndex = PREVIEW_COLUMNS.indexOf("id");
  const idOf = (value: unknown) =>
    PREVIEW_ROWS.findIndex((row) => String(row[idIndex]) === String(value));
  if (request.kind === "delete") {
    const index = idOf(request.key.find((key) => key.column === "id")?.value);
    if (index >= 0) PREVIEW_ROWS.splice(index, 1);
  } else if (request.kind === "update") {
    const index = idOf(request.key.find((key) => key.column === "id")?.value);
    if (index >= 0) {
      for (const entry of request.values) {
        const column = PREVIEW_COLUMNS.indexOf(entry.column);
        if (column >= 0) PREVIEW_ROWS[index][column] = entry.value;
      }
    }
  } else {
    const row: unknown[] = PREVIEW_COLUMNS.map(() => null);
    for (const entry of request.values) {
      const column = PREVIEW_COLUMNS.indexOf(entry.column);
      if (column >= 0) row[column] = entry.value;
    }
    row[idIndex] = PREVIEW_ROWS.length + 1;
    PREVIEW_ROWS.push(row);
  }
}

function changeResponse(kind: string): QueryResponse {
  return {
    results: [
      {
        statement: `-- ${kind}`,
        isQuery: false,
        columns: [],
        rows: [],
        rowCount: 0,
        affectedRows: 1,
        lastInsertId: null,
        executionMs: 2,
        truncated: false,
        error: null,
      },
    ],
    totalMs: 2,
  };
}

let SETTINGS: Record<string, unknown> = {};

/**
 * Mirror the real backend: one result per statement, so the multi-statement UI
 * (per-statement tabs, inline errors) can be reviewed in the browser. A
 * statement containing the word `fail` returns an error, which makes the
 * partial-success path easy to exercise.
 */
function buildResult(request: QueryRequest): QueryResponse {
  const started = Date.now();
  const parts = request.sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  const statements = parts.length > 0 ? parts : ["SELECT 1"];

  const results = statements.map((statement) => {
    if (/\bfail\b/i.test(statement)) {
      return {
        statement,
        isQuery: false,
        columns: [],
        rows: [],
        rowCount: 0,
        affectedRows: null,
        lastInsertId: null,
        executionMs: 1,
        truncated: false,
        error: `mock error for: ${statement}`,
      };
    }
    const rows = PREVIEW_ROWS;
    return {
      statement,
      isQuery: true,
      columns: RESULT_COLUMNS,
      rows,
      rowCount: rows.length,
      affectedRows: null,
      lastInsertId: null,
      executionMs: Math.max(3, Date.now() - started),
      truncated: false,
      error: null,
    };
  });

  return { results, totalMs: Math.max(3, Date.now() - started) };
}

/** Routes a command name to representative fixture data. */
export async function mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  await delay(90 + Math.random() * 120);
  const respond = (value: unknown) => value as T;

  switch (cmd) {
    case "list_drivers":
      return respond([MYSQL, POSTGRES]);
    case "list_connections":
      return respond([PROFILE]);
    case "list_sessions":
      return respond([SESSION]);
    case "save_connection": {
      const input = (args?.input ?? {}) as Partial<ConnectionProfile>;
      return respond({ ...PROFILE, ...input, hasPassword: true } as ConnectionProfile);
    }
    case "delete_connection":
    case "disconnect":
      return respond(undefined);
    case "set_settings":
      SETTINGS = (args?.value as Record<string, unknown>) ?? {};
      return respond(undefined);
    case "connect":
      return respond({ session: SESSION } satisfies ConnectResult);
    case "test_connection":
      return respond(SERVER);
    case "list_databases":
      return respond(DATABASES);
    case "list_namespaces":
      return respond([] satisfies NamespaceInfo[]);
    case "list_objects":
      return respond(OBJECTS);
    case "describe_object":
      return respond(SCHEMA);
    case "list_table_columns":
      return respond(
        OBJECTS.filter((object) =>
          ["table", "view", "materializedView"].includes(object.kind),
        ).map((object) => ({
          table: object.name,
          schema: "shop",
          columns:
            object.name === "orders"
              ? SCHEMA.columns.map((column) => ({
                  name: column.name,
                  dataType: column.dataType,
                }))
              : [
                  { name: "id", dataType: "bigint" },
                  { name: "name", dataType: "varchar" },
                  { name: "updated_at", dataType: "datetime" },
                ],
        })),
      );
    case "execute_query": {
      const request = (args?.request as QueryRequest) ?? { sql: "SELECT 1" };
      // A `slow`/`sleep` statement simulates a long query so the Stop button
      // and cancelled state can be exercised in the browser.
      if (/\b(slow|sleep)\b/i.test(request.sql)) {
        await delay(4000);
      }
      return respond(buildResult(request));
    }
    case "cancel_query":
      return respond(true);
    case "explain_query": {
      const request = (args?.request as QueryRequest) ?? { sql: "SELECT 1" };
      return respond({
        results: [
          {
            statement: `EXPLAIN ${request.sql.trim()}`,
            isQuery: true,
            columns: [
              { name: "id", dataType: "INT" },
              { name: "select_type", dataType: "VARCHAR" },
              { name: "table", dataType: "VARCHAR" },
              { name: "type", dataType: "VARCHAR" },
              { name: "possible_keys", dataType: "VARCHAR" },
              { name: "key", dataType: "VARCHAR" },
              { name: "rows", dataType: "BIGINT" },
              { name: "Extra", dataType: "VARCHAR" },
            ],
            rows: [
              [1, "SIMPLE", "orders", "ref", "idx_customer", "idx_customer", 137, "Using where"],
              [1, "SIMPLE", "customers", "eq_ref", "PRIMARY", "PRIMARY", 1, "Using index"],
            ],
            rowCount: 2,
            affectedRows: null,
            lastInsertId: null,
            executionMs: 2,
            truncated: false,
            error: null,
          },
        ],
        totalMs: 2,
      } satisfies QueryResponse);
    }
    case "object_detail": {
      const object = (args?.object as string) ?? "orders";
      const schema: ObjectSchema = { ...SCHEMA, name: object };
      const ddl = `CREATE TABLE \`${object}\` (\n  \`id\` bigint(20) unsigned NOT NULL AUTO_INCREMENT,\n  \`customer_id\` bigint(20) unsigned NOT NULL,\n  \`status\` enum('new','paid','shipped') NOT NULL,\n  \`total\` decimal(12,2) NOT NULL,\n  \`note\` text,\n  \`created_at\` datetime NOT NULL,\n  PRIMARY KEY (\`id\`),\n  KEY \`idx_customer\` (\`customer_id\`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
      return respond({
        schema,
        ddl,
        rowCount: 58231,
        sizeBytes: null,
        actions: MOCK_ACTIONS,
        identifierQuote: "`",
      } satisfies ObjectDetail);
    }
    case "apply_row_change": {
      const request = (args?.request as RowChangeRequest) ?? ({ kind: "update" } as RowChangeRequest);
      applyRowChange(request);
      return respond(changeResponse(request.kind));
    }
    case "apply_row_changes": {
      const requests = (args?.requests as RowChangeRequest[]) ?? [];
      const results = requests.flatMap((request) => {
        applyRowChange(request);
        return changeResponse(request.kind).results;
      });
      return respond({ results, totalMs: 2 } satisfies QueryResponse);
    }
    case "create_table": {
      const request = (args?.request as CreateTableRequest) ?? { table: "table" };
      return respond({
        results: [
          {
            statement: `CREATE TABLE ${request.table}`,
            isQuery: false,
            columns: [],
            rows: [],
            rowCount: 0,
            affectedRows: 0,
            lastInsertId: null,
            executionMs: 4,
            truncated: false,
            error: null,
          },
        ],
        totalMs: 4,
      } satisfies QueryResponse);
    }
    case "count_rows":
      return respond(58231);
    case "object_action": {
      const request = (args?.request as ObjectActionRequest) ?? { action: "dropObject" };
      return respond({
        results: [
          {
            statement: `-- ${request.action} ${request.object}`,
            isQuery: false,
            columns: [],
            rows: [],
            rowCount: 0,
            affectedRows: 1,
            lastInsertId: null,
            executionMs: 3,
            truncated: false,
            error: null,
          },
        ],
        totalMs: 3,
      } satisfies QueryResponse);
    }
    case "list_snippets":
      return respond([...SNIPPETS]);
    case "save_snippet": {
      const input = (args?.input ?? {}) as Partial<Snippet>;
      const snippet = {
        id: input.id ?? `snippet-${Date.now()}`,
        name: input.name ?? "Untitled",
        sql: input.sql ?? "",
        database: input.database ?? null,
        driver: input.driver ?? null,
        createdAt: Date.now(),
      } as Snippet;
      const existing = SNIPPETS.findIndex((s) => s.id === snippet.id);
      if (existing >= 0) SNIPPETS[existing] = snippet;
      else SNIPPETS.unshift(snippet);
      return respond(snippet);
    }
    case "delete_snippet": {
      const id = args?.id as string | undefined;
      const index = SNIPPETS.findIndex((s) => s.id === id);
      if (index >= 0) SNIPPETS.splice(index, 1);
      return respond(undefined);
    }
    case "get_settings":
      return respond(SETTINGS);
    default:
      return respond(undefined);
  }
}
