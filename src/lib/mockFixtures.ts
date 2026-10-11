/**
 * One fixture per compiled-in driver, for the development-only fake backend.
 *
 * The mock answers every command from the fixture of the session's engine, so
 * the whole UI — connection form, explorer tree, object inspector, templates —
 * can be walked for each engine without a server. This table is the only place
 * engine differences live: `list_drivers`, `list_connections`, `list_sessions`
 * and every introspection command are generated from it, so adding an engine is
 * adding one entry here.
 *
 * The data mirrors what the Rust adapter really returns for that engine
 * (capabilities, config fields, object kinds, identifier quoting, and the
 * inspector sections the driver declares). Inspector sections are **not**
 * invented here: only ClickHouse declares them today, so only its fixture has
 * any, and the others answer the section commands exactly as their adapters do.
 *
 * `fixtureDrift.test.ts` holds that mirror to the Rust drivers' own
 * declarations (see `fixtures/driver-descriptors.json`): the driver block, the
 * `quote` an engine's templates use and the `explainStatement`/`plan` pair all
 * have to agree with what `src-tauri/src/drivers` declares.
 */
import {
  type MongoCollectionFixture,
  type RedisKeyFixture,
  inferMongoColumns,
  redisKeyLength,
} from "./mockReplies.ts";
import type {
  ColumnMeta,
  ColumnSchema,
  ConnectionProfile,
  DatabaseInfo,
  DatabaseObject,
  DriverDescriptor,
  InspectorSection,
  NamespaceInfo,
  ObjectAction,
  ObjectDetail,
  ObjectKind,
  ObjectSchema,
  ServerInfo,
  SessionInfo,
} from "./types";

/** Context-menu actions the relational adapters advertise (`relational_actions`). */
export const MOCK_ACTIONS: ObjectAction[] = [
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

/** Everything the mock needs to answer for one engine. */
export interface EngineFixture {
  driver: DriverDescriptor;
  profile: ConnectionProfile;
  server: ServerInfo;
  session: SessionInfo;
  /** Identifier quote of the engine's dialect, used by generated templates. */
  quote: string;
  databases: DatabaseInfo[];
  namespaces: NamespaceInfo[];
  /** Objects of the namespace they belong to (`schema` names it). */
  objects: DatabaseObject[];
  /** Introspected schema for one object, as its adapter would report it. */
  schema(object: string, namespace: string | null): ObjectSchema;
  /** Generated DDL for one object. */
  ddl(object: string, namespace: string | null): string;
  /** Inspector sections the adapter declares for an object. */
  sections?: (object: string) => InspectorSection[];
  /** Body of a live section; adapters without one refuse, like the real default. */
  sectionBody?: (section: string) => InspectorSection;
  /** Object kinds `list_table_columns` reports for the engine. Redis keys and
   *  Mongo collections have no column metadata, so their adapters return none. */
  completableKinds: ObjectKind[];
  /** Keys the engine's command replies answer from (Redis). */
  keys?: RedisKeyFixture[];
  /** Sampled documents the engine's commands answer from (MongoDB). */
  collections?: Record<string, MongoCollectionFixture>;
  /** Rows `count_rows` reports for an object. */
  count(object: string): number;
  /** Statement text an `explain_query` runs; `null` when the adapter cannot
   *  explain this statement, and absent when its default (`EXPLAIN`) applies. */
  explainStatement?: (sql: string) => string | null;
  /** Shape of the engine's plan. Adapters without `supports_explain` have none. */
  plan?: { columns: ColumnMeta[]; rows: unknown[][] };
}

function column(
  name: string,
  dataType: string,
  extra: Partial<ColumnSchema> = {},
): Omit<ColumnSchema, "ordinal"> {
  return { name, dataType, nullable: false, isPrimaryKey: false, isAutoIncrement: false, ...extra };
}

function schemaOf(
  name: string,
  kind: ObjectKind,
  columns: Omit<ColumnSchema, "ordinal">[],
  extras: Partial<Pick<ObjectSchema, "indexes" | "foreignKeys">> = {},
): ObjectSchema {
  return {
    name,
    kind,
    columns: columns.map((entry, index) => ({ ...entry, ordinal: index + 1 })),
    indexes: extras.indexes ?? [],
    foreignKeys: extras.foreignKeys ?? [],
  };
}

/** The row estimate one object advertises, which is also what `count_rows`
 *  reports for it: the mock has no data to count, so the two agree. */
function estimateOf(objects: DatabaseObject[], name: string): number {
  return objects.find((entry) => entry.name === name)?.rowEstimate ?? 0;
}

/** The generic schema the explorer falls back to for objects it barely knows. */
function genericSchema(name: string, kind: ObjectKind): ObjectSchema {
  return schemaOf(name, kind, [
    column("id", "bigint", { isPrimaryKey: true }),
    column("name", "varchar"),
    column("updated_at", "datetime"),
  ]);
}

const MYSQL_DDL = (object: string) =>
  `CREATE TABLE \`${object}\` (\n  \`id\` bigint(20) unsigned NOT NULL AUTO_INCREMENT,\n  \`customer_id\` bigint(20) unsigned NOT NULL,\n  \`status\` enum('new','paid','shipped') NOT NULL,\n  \`total\` decimal(12,2) NOT NULL,\n  \`note\` text,\n  \`created_at\` datetime NOT NULL,\n  PRIMARY KEY (\`id\`),\n  KEY \`idx_customer\` (\`customer_id\`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;

const MYSQL_ORDERS = schemaOf("orders", "table", [
  column("id", "bigint(20) unsigned", { isPrimaryKey: true, isAutoIncrement: true }),
  column("customer_id", "bigint(20) unsigned"),
  column("status", "enum('new','paid','shipped')"),
  column("total", "decimal(12,2)"),
  column("note", "text", { nullable: true }),
  column("created_at", "datetime"),
], {
  indexes: [
    { name: "PRIMARY", columns: ["id"], unique: true, primary: true },
    { name: "idx_customer", columns: ["customer_id"], unique: false, primary: false },
  ],
  foreignKeys: [
    {
      name: "fk_orders_customer",
      columns: ["customer_id"],
      referencedTable: "customers",
      referencedColumns: ["id"],
    },
  ],
});

const MYSQL_OBJECTS: DatabaseObject[] = [
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
];

const MYSQL: EngineFixture = {
  quote: "`",
  driver: {
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
      { key: "host", label: "Host", fieldType: "text", placeholder: "127.0.0.1", required: true, defaultValue: "127.0.0.1", options: [] },
      { key: "port", label: "Port", fieldType: "number", placeholder: "3306", required: true, defaultValue: 3306, options: [] },
      { key: "username", label: "Username", fieldType: "text", placeholder: "root", required: true, defaultValue: "root", options: [] },
      { key: "password", label: "Password", fieldType: "password", placeholder: "••••••••", required: false, options: [] },
      {
        key: "database",
        label: "Database",
        fieldType: "text",
        placeholder: "optional",
        required: false,
        options: [],
        help: "Leave empty to browse every schema.",
      },
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
  },
  profile: {
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
  },
  server: {
    version: "5.6.51-log",
    versionNumber: 50651,
    serverComment: "MySQL Community Server (GPL)",
    currentDatabase: "shop",
    currentUser: "root@localhost",
    supportsTls: true,
  },
  session: {
    id: "demo-session",
    profileId: "demo-profile",
    driver: "mysql",
    name: "Local MySQL 5.6",
    server: {
      version: "5.6.51-log",
      versionNumber: 50651,
      serverComment: "MySQL Community Server (GPL)",
      currentDatabase: "shop",
      currentUser: "root@localhost",
      supportsTls: true,
    },
  },
  databases: [
    { name: "shop", isSystem: false },
    { name: "analytics", isSystem: false },
    { name: "information_schema", isSystem: true },
    { name: "mysql", isSystem: true },
  ],
  namespaces: [],
  objects: MYSQL_OBJECTS,
  schema: (object, _namespace) =>
    object === "orders" ? { ...MYSQL_ORDERS, name: object } : genericSchema(object, "table"),
  ddl: MYSQL_DDL,
  // `information_schema.COLUMNS` has a row per column of a table or view; the
  // other kinds MySQL reports (routines, triggers, events) have none.
  completableKinds: ["table", "view"],
  count: (object) => estimateOf(MYSQL_OBJECTS, object),
  // MySQL's `EXPLAIN` returns one row per table in the plan.
  plan: {
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
  },
};

const POSTGRES_ORDERS = schemaOf("orders", "table", [
  column("id", "integer", { isPrimaryKey: true, isAutoIncrement: true }),
  column("customer_id", "bigint"),
  column("status", "text"),
  column("total", "numeric(12,2)"),
  column("note", "text", { nullable: true }),
  column("created_at", "timestamp with time zone"),
], {
  indexes: [
    { name: "orders_pkey", columns: ["id"], unique: true, primary: true },
    { name: "idx_orders_customer", columns: ["customer_id"], unique: false, primary: false },
  ],
  foreignKeys: [
    {
      name: "fk_orders_customer",
      columns: ["customer_id"],
      referencedTable: "customers",
      referencedColumns: ["id"],
    },
  ],
});

const POSTGRES_OBJECTS: DatabaseObject[] = [
  { name: "customers", kind: "table", schema: "public", comment: "Registered buyers", rowEstimate: 12480 },
  { name: "orders", kind: "table", schema: "public", comment: "Order headers", rowEstimate: 58231 },
  { name: "order_items", kind: "table", schema: "public", comment: null, rowEstimate: 173904 },
  { name: "products", kind: "table", schema: "public", comment: "Catalogue", rowEstimate: 812 },
  { name: "v_order_totals", kind: "view", schema: "public", comment: "Revenue per order", rowEstimate: null },
  { name: "monthly_revenue", kind: "materializedView", schema: "public", comment: "Refreshed nightly", rowEstimate: 36 },
  { name: "orders_id_seq", kind: "sequence", schema: "public", comment: null, rowEstimate: null },
  { name: "audit_events", kind: "table", schema: "audit", comment: "Change log", rowEstimate: 402113 },
  { name: "v_recent_audit", kind: "view", schema: "audit", comment: "Last 24 hours", rowEstimate: null },
];

const POSTGRES: EngineFixture = {
  quote: '"',
  driver: {
    id: "postgres",
    displayName: "PostgreSQL",
    defaultPort: 5432,
    accentColor: "#3B82F6",
    capabilities: {
      queryLanguage: "sql",
      resultShape: "tabular",
      isRelational: true,
      supportsMultipleDatabases: true,
      supportsSchemas: true,
      supportsTransactions: true,
      supportsDdl: true,
      supportsExplain: true,
      supportsCancel: true,
      objectKinds: ["table", "view", "materializedView", "sequence"],
      supportedActions: [...MOCK_ACTIONS, "reindex"],
    },
    configFields: [
      { key: "host", label: "Host", fieldType: "text", placeholder: "127.0.0.1", required: true, defaultValue: "127.0.0.1", options: [] },
      { key: "port", label: "Port", fieldType: "number", placeholder: "5432", required: true, defaultValue: 5432, options: [] },
      { key: "username", label: "Username", fieldType: "text", placeholder: "postgres", required: true, defaultValue: "postgres", options: [] },
      { key: "password", label: "Password", fieldType: "password", placeholder: "••••••••", required: false, options: [] },
      { key: "database", label: "Database", fieldType: "text", placeholder: "postgres", required: true, defaultValue: "postgres", options: [] },
      {
        key: "sslMode",
        label: "TLS",
        fieldType: "select",
        required: false,
        defaultValue: "preferred",
        options: [
          { value: "preferred", label: "Preferred" },
          { value: "required", label: "Required" },
          { value: "disabled", label: "Disabled" },
        ],
      },
    ],
  },
  profile: {
    id: "demo-postgres",
    name: "Local PostgreSQL 16",
    driver: "postgres",
    host: "127.0.0.1",
    port: 5432,
    username: "postgres",
    database: "app",
    sslMode: "preferred",
    options: {},
    hasPassword: true,
  },
  server: {
    version: "16.4",
    versionNumber: 160004,
    serverComment: "PostgreSQL 16.4 on aarch64-apple-darwin",
    currentDatabase: "app",
    currentUser: "postgres",
    supportsTls: true,
  },
  session: {
    id: "demo-postgres-session",
    profileId: "demo-postgres",
    driver: "postgres",
    name: "Local PostgreSQL 16",
    server: {
      version: "16.4",
      versionNumber: 160004,
      serverComment: "PostgreSQL 16.4 on aarch64-apple-darwin",
      currentDatabase: "app",
      currentUser: "postgres",
      supportsTls: true,
    },
  },
  // `pg_database` without templates; the adapter marks `postgres` as a system
  // database because that is where the default connection lands.
  databases: [
    { name: "app", isSystem: false },
    { name: "analytics", isSystem: false },
    { name: "postgres", isSystem: true },
  ],
  // `pg_namespace` without `pg_*` and `information_schema`.
  namespaces: [{ name: "public" }, { name: "audit" }],
  objects: POSTGRES_OBJECTS,
  schema: (object, _namespace) =>
    object === "orders" ? { ...POSTGRES_ORDERS, name: object } : genericSchema(object, "table"),
  ddl: (object) =>
    `CREATE TABLE "public"."${object}" (\n  "id" integer NOT NULL GENERATED BY DEFAULT AS IDENTITY,\n  "customer_id" bigint NOT NULL,\n  "status" text NOT NULL,\n  "total" numeric(12,2) NOT NULL,\n  "note" text,\n  "created_at" timestamp with time zone NOT NULL,\n  CONSTRAINT "orders_pkey" PRIMARY KEY ("id")\n);`,
  // `information_schema.columns` covers tables, views and materialized views
  // in one schema; a sequence has no columns to offer.
  completableKinds: ["table", "view", "materializedView"],
  count: (object) => estimateOf(POSTGRES_OBJECTS, object),
  // PostgreSQL returns a single text column of plan lines.
  plan: {
    columns: [{ name: "QUERY PLAN", dataType: "TEXT" }],
    rows: [
      [
        "Hash Join  (cost=28.50..1120.75 rows=137 width=64) (actual time=0.312..2.114 rows=137 loops=1)",
      ],
      ["  Hash Cond: (orders.customer_id = customers.id)"],
      ["  ->  Index Scan using idx_customer on orders  (cost=0.29..980.20 rows=137 width=40)"],
      ["  ->  Hash  (cost=17.80..17.80 rows=680 width=32)"],
      ["Planning Time: 0.284 ms"],
      ["Execution Time: 2.306 ms"],
    ],
  },
};

const SQLITE_ORDERS = schemaOf("orders", "table", [
  column("id", "INTEGER", { isPrimaryKey: true, isAutoIncrement: true }),
  column("customer_id", "INTEGER"),
  column("status", "TEXT"),
  column("total", "REAL"),
  column("note", "TEXT", { nullable: true }),
  column("created_at", "TEXT"),
], {
  // A rowid primary key has no entry in `PRAGMA index_list`, which is why the
  // adapter reports no `PRIMARY` index for a table like this one.
  indexes: [{ name: "idx_orders_customer", columns: ["customer_id"], unique: false, primary: false }],
  foreignKeys: [
    {
      name: "fk_orders_customer",
      columns: ["customer_id"],
      referencedTable: "customers",
      referencedColumns: ["id"],
    },
  ],
});

const SQLITE_OBJECTS: DatabaseObject[] = [
  { name: "customers", kind: "table", schema: "main", comment: null, rowEstimate: 12480 },
  { name: "orders", kind: "table", schema: "main", comment: null, rowEstimate: 58231 },
  { name: "order_items", kind: "table", schema: "main", comment: null, rowEstimate: 173904 },
  { name: "products", kind: "table", schema: "main", comment: null, rowEstimate: 812 },
  { name: "v_recent_orders", kind: "view", schema: "main", comment: null, rowEstimate: null },
  { name: "trg_orders_audit", kind: "trigger", schema: "main", comment: null, rowEstimate: null },
];

const SQLITE: EngineFixture = {
  quote: '"',
  driver: {
    id: "sqlite",
    displayName: "SQLite",
    defaultPort: 0,
    accentColor: "#003B57",
    capabilities: {
      queryLanguage: "sql",
      resultShape: "tabular",
      isRelational: true,
      supportsMultipleDatabases: false,
      supportsSchemas: false,
      supportsTransactions: true,
      supportsDdl: true,
      supportsExplain: true,
      supportsCancel: false,
      objectKinds: ["table", "view", "trigger"],
      supportedActions: [...MOCK_ACTIONS, "reindex"],
    },
    configFields: [
      {
        key: "path",
        label: "Database file",
        fieldType: "text",
        required: true,
        placeholder: "/Users/me/data/shop.db",
        options: [],
        help: "Path to the SQLite file. Use :memory: for a scratch database.",
      },
      {
        key: "createIfMissing",
        label: "Create if missing",
        fieldType: "select",
        required: false,
        defaultValue: "true",
        options: [
          { value: "true", label: "Yes — create the file" },
          { value: "false", label: "No — open an existing file only" },
        ],
      },
    ],
  },
  profile: {
    id: "demo-sqlite",
    name: "Sample shop.db",
    driver: "sqlite",
    host: "",
    port: 0,
    username: "",
    database: "main",
    sslMode: "disabled",
    options: { path: "/Users/me/data/shop.db", createIfMissing: "true" },
    hasPassword: false,
  },
  server: {
    version: "3.45.3",
    versionNumber: 3045003,
    serverComment: "SQLite",
    currentDatabase: "main",
    currentUser: "",
    supportsTls: false,
  },
  session: {
    id: "demo-sqlite-session",
    profileId: "demo-sqlite",
    driver: "sqlite",
    name: "Sample shop.db",
    server: {
      version: "3.45.3",
      versionNumber: 3045003,
      serverComment: "SQLite",
      currentDatabase: "main",
      currentUser: "",
      supportsTls: false,
    },
  },
  // `PRAGMA database_list`.
  databases: [
    { name: "main", isSystem: false },
    { name: "temp", isSystem: true },
  ],
  namespaces: [],
  objects: SQLITE_OBJECTS,
  schema: (object, _namespace) =>
    object === "orders" ? { ...SQLITE_ORDERS, name: object } : genericSchema(object, "table"),
  // The adapter replays `sqlite_master.sql` for the object.
  ddl: (object) =>
    `CREATE TABLE "${object}" (\n  "id" INTEGER PRIMARY KEY AUTOINCREMENT,\n  "customer_id" INTEGER NOT NULL REFERENCES "customers"("id"),\n  "status" TEXT NOT NULL DEFAULT 'new',\n  "total" REAL NOT NULL,\n  "note" TEXT,\n  "created_at" TEXT NOT NULL\n);`,
  // `sqlite_master` joined to `pragma_table_info`, restricted to tables and
  // views; a trigger has no column metadata.
  completableKinds: ["table", "view"],
  count: (object) => estimateOf(SQLITE_OBJECTS, object),
  explainStatement: (sql) => `EXPLAIN QUERY PLAN ${sql.trim().replace(/;+$/, "")}`,
  // SQLite's query plan has the same four columns for every statement.
  plan: {
    columns: [
      { name: "id", dataType: "INTEGER" },
      { name: "parent", dataType: "INTEGER" },
      { name: "notused", dataType: "INTEGER" },
      { name: "detail", dataType: "TEXT" },
    ],
    rows: [
      [2, 0, 0, "SCAN orders USING INDEX idx_orders_customer"],
      [7, 0, 0, "SEARCH customers USING INTEGER PRIMARY KEY (rowid=?)"],
      [10, 0, 0, "USE TEMP B-TREE FOR ORDER BY"],
    ],
  },
};

/**
 * The keys the mock's command replies answer from. `elements` holds a string's
 * value or the members of a collection key, `fields` the pairs of a hash, and
 * the explorer's `type · length` summary is derived from them the way `HLEN`,
 * `STRLEN`, `SCARD`, `ZCARD`, `LLEN` and `XLEN` report it.
 */
const REDIS_KEYS: RedisKeyFixture[] = [
  {
    name: "order:1001",
    type: "hash",
    elements: [],
    fields: [
      ["status", "paid"],
      ["total", "128.40"],
      ["customer", "customer_42"],
      ["sku", "0x1eef10"],
      ["note", "shipped 2026-10-02"],
      ["created_at", "2026-10-02T09:14:00Z"],
    ],
  },
  {
    name: "order:1002",
    type: "hash",
    elements: [],
    fields: [
      ["status", "new"],
      ["total", "54.00"],
      ["customer", "customer_7"],
      ["sku", "0x2b1ac4"],
      ["created_at", "2026-10-09T11:02:00Z"],
    ],
  },
  {
    name: "cart:42",
    type: "hash",
    elements: [],
    fields: [
      ["0x1eef10", "2"],
      ["0x2b1ac4", "1"],
      ["0x9f00aa", "5"],
    ],
  },
  {
    name: "session:3f9c…",
    type: "string",
    elements: ["eyJ1aWQiOjQyLCJyb2xlIjoiYWRtaW4ifQ"],
    ttlSeconds: 3120,
  },
  {
    name: "products:hot",
    type: "zset",
    elements: Array.from({ length: 25 }, (_, index) => `0x${(index * 4093).toString(16).padStart(6, "0")}`),
  },
  {
    name: "queue:jobs",
    type: "list",
    elements: Array.from(
      { length: 12 },
      (_, index) => `{"job":"reindex","order":${1001 + index}}`,
    ),
  },
  {
    name: "users:online",
    type: "set",
    // Deliberately larger than the editor's default row limit, so the
    // `truncated` affordance is reachable without a server.
    elements: Array.from({ length: 1500 }, (_, index) => `user:${index + 1}`),
  },
];

const REDIS: EngineFixture = {
  quote: '"',
  driver: {
    id: "redis",
    displayName: "Redis",
    defaultPort: 6379,
    accentColor: "#DC382D",
    capabilities: {
      queryLanguage: "redis",
      resultShape: "keyValue",
      isRelational: false,
      supportsMultipleDatabases: false,
      supportsSchemas: false,
      supportsTransactions: false,
      supportsDdl: false,
      supportsExplain: false,
      supportsCancel: false,
      objectKinds: ["key"],
      supportedActions: ["inspect"],
    },
    configFields: [
      { key: "host", label: "Host", fieldType: "text", placeholder: "127.0.0.1", required: true, defaultValue: "127.0.0.1", options: [] },
      { key: "port", label: "Port", fieldType: "number", placeholder: "6379", required: true, defaultValue: 6379, options: [] },
      {
        key: "username",
        label: "Username",
        fieldType: "text",
        placeholder: "default",
        required: false,
        options: [],
        help: "Optional. Only ACL users (Redis 6+) need a username.",
      },
      { key: "password", label: "Password", fieldType: "password", placeholder: "••••••••", required: false, options: [] },
      {
        key: "database",
        label: "Database",
        fieldType: "number",
        placeholder: "0",
        required: false,
        defaultValue: 0,
        options: [],
        help: "Redis database index (0–15 by default).",
      },
      {
        key: "sslMode",
        label: "TLS",
        fieldType: "select",
        required: false,
        defaultValue: "disabled",
        help: "Required connects over TLS using the system certificate store.",
        options: [
          { value: "disabled", label: "Disabled" },
          { value: "required", label: "Required (rediss)" },
        ],
      },
    ],
  },
  profile: {
    id: "demo-redis",
    name: "Local Redis 7",
    driver: "redis",
    host: "127.0.0.1",
    port: 6379,
    username: "",
    database: "0",
    sslMode: "disabled",
    options: {},
    hasPassword: false,
  },
  server: {
    version: "7.2.5",
    versionNumber: 70205,
    serverComment: "Redis",
    currentDatabase: "0",
    currentUser: "default",
    supportsTls: false,
  },
  session: {
    id: "demo-redis-session",
    profileId: "demo-redis",
    driver: "redis",
    name: "Local Redis 7",
    server: {
      version: "7.2.5",
      versionNumber: 70205,
      serverComment: "Redis",
      currentDatabase: "0",
      currentUser: "default",
      supportsTls: false,
    },
  },
  // The session is pinned to the configured index, so that is the only entry.
  databases: [{ name: "0", isSystem: false }],
  namespaces: [],
  objects: REDIS_KEYS.map((key) => ({
    name: key.name,
    kind: "key" as ObjectKind,
    schema: "0",
    comment: `${key.type} · ${redisKeyLength(key)}`,
    rowEstimate: null,
  })),
  // A key has no real columns; these stand in where a table would list them.
  schema: (object) => {
    const key = REDIS_KEYS.find((entry) => entry.name === object);
    return schemaOf(object, "key", [
      column("type", key?.type ?? "string"),
      column("length", "integer", { defaultValue: String(key ? redisKeyLength(key) : 0) }),
      column("ttl", "integer", { nullable: true, defaultValue: String(key?.ttlSeconds ?? -1) }),
    ]);
  },
  // Redis has no DDL: the adapter shows the key's type and a runnable command
  // instead of a fabricated CREATE TABLE.
  ddl: (object) => {
    const type = REDIS_KEYS.find((entry) => entry.name === object)?.type ?? "string";
    const command: Record<string, string> = {
      string: "GET",
      list: "LRANGE",
      set: "SMEMBERS",
      zset: "ZRANGE",
      hash: "HGETALL",
      stream: "XRANGE",
    };
    const read = command[type] ?? "TYPE";
    const invocation = type === "list" || type === "stream" ? `${read} ${object} - +` : `${read} ${object}`;
    return `# Redis key: ${object}\n# Type: ${type}\n${invocation}`;
  },
  // No column metadata exists for a key.
  completableKinds: [],
  keys: REDIS_KEYS,
  count: () => 0,
};

/**
 * The documents the mock's `find` and `aggregate` answers return, and what the
 * adapter's 200-document sample sees. BSON is written the way the app receives
 * it (relaxed extended JSON), and the inspector's columns are inferred from
 * these documents rather than declared next to them, exactly like `infer_columns`.
 * `count` is the collection's document count, which `count_rows` also reports:
 * the sample is a sample, the count is not.
 */
const MONGO_COLLECTIONS: Record<string, MongoCollectionFixture> = {
  customers: {
    count: 12480,
    documents: [
      {
        _id: { $oid: "6512f0c1b7e4a1d2c3e4f5a1" },
        email: "ada@example.com",
        name: "Ada Lovelace",
        orders: 12,
        vip: true,
        createdAt: { $date: "2025-11-02T08:15:00Z" },
      },
      {
        _id: { $oid: "6512f0c1b7e4a1d2c3e4f5a2" },
        email: "linus@example.com",
        name: "Linus Torvalds",
        orders: 3,
        createdAt: { $date: "2026-01-19T17:40:00Z" },
      },
      {
        // No `vip`, and a null `orders`: the inferred column is nullable and
        // the row carries a null, which is the shape the grid renders.
        _id: { $oid: "6512f0c1b7e4a1d2c3e4f5a3" },
        email: "grace@example.com",
        name: "Grace Hopper",
        orders: null,
        vip: null,
        createdAt: { $date: "2026-03-08T06:05:00Z" },
      },
    ],
  },
  orders: {
    count: 58231,
    documents: [
      {
        _id: { $oid: "6520aa41c9f1e007d1a2b301" },
        customerId: 42,
        status: "paid",
        total: 128.4,
        items: [
          { sku: "0x1eef10", qty: 2 },
          { sku: "0x2b1ac4", qty: 1 },
        ],
        tags: ["priority", "gift"],
        createdAt: { $date: "2026-10-02T09:14:00Z" },
      },
      {
        _id: { $oid: "6520aa41c9f1e007d1a2b302" },
        customerId: 7,
        status: "new",
        total: 54,
        items: [{ sku: "0x9f00aa", qty: 5 }],
        createdAt: { $date: "2026-10-09T11:02:00Z" },
      },
    ],
  },
  products: {
    count: 812,
    documents: [
      {
        _id: { $oid: "64f1120a88aa10bb99cc001" },
        sku: "0x1eef10",
        title: "Standing desk",
        price: 549.9,
        stock: 18,
        dimensions: { width: 160, depth: 80, unit: "cm" },
      },
      {
        _id: { $oid: "64f1120a88aa10bb99cc002" },
        sku: "0x2b1ac4",
        title: "Monitor arm",
        price: 89.5,
        stock: 0,
        dimensions: { width: 42, depth: 12, unit: "cm" },
      },
    ],
  },
  // A view is described by its pipeline; showing the documents it would read
  // keeps the grid honest without evaluating the pipeline.
  order_summary: {
    count: 100,
    documents: [
      { _id: "paid", count: 4120, total: 528913.4 },
      { _id: "new", count: 890, total: 48012.0 },
      { _id: "shipped", count: 3380, total: 410277.9 },
    ],
  },
  events: {
    count: 402113,
    documents: [
      {
        _id: { $oid: "6500aa01bb22cc33dd44ee01" },
        type: "click",
        path: "/checkout",
        at: { $date: "2026-10-11T18:31:02Z" },
      },
      {
        _id: { $oid: "6500aa01bb22cc33dd44ee02" },
        type: "purchase",
        path: "/checkout/done",
        amount: { $numberDecimal: "128.40" },
        at: { $date: "2026-10-11T18:32:41Z" },
      },
    ],
  },
};

/** The rows `count_rows` reports for a collection. */
function mongoCount(object: string): number {
  return MONGO_COLLECTIONS[object]?.count ?? 0;
}

const MONGO: EngineFixture = {
  quote: '"',
  driver: {
    id: "mongodb",
    displayName: "MongoDB",
    defaultPort: 27017,
    accentColor: "#47A248",
    capabilities: {
      queryLanguage: "mongo",
      resultShape: "document",
      isRelational: false,
      supportsMultipleDatabases: true,
      supportsSchemas: false,
      supportsTransactions: false,
      supportsDdl: false,
      supportsExplain: false,
      supportsCancel: false,
      objectKinds: ["collection", "view"],
      supportedActions: ["inspect", "viewData", "countRows", "copyName"],
    },
    configFields: [
      { key: "host", label: "Host", fieldType: "text", placeholder: "127.0.0.1", required: true, defaultValue: "127.0.0.1", options: [] },
      { key: "port", label: "Port", fieldType: "number", placeholder: "27017", required: true, defaultValue: 27017, options: [] },
      {
        key: "username",
        label: "Username",
        fieldType: "text",
        required: false,
        placeholder: "app",
        options: [],
        help: "Optional. Authenticates against the database below, or admin when it is empty.",
      },
      { key: "password", label: "Password", fieldType: "password", placeholder: "••••••••", required: false, options: [] },
      {
        key: "database",
        label: "Database",
        fieldType: "text",
        required: false,
        placeholder: "app",
        options: [],
        help: "Optional default database for commands that do not name one.",
      },
      {
        key: "sslMode",
        label: "TLS",
        fieldType: "select",
        required: false,
        defaultValue: "disabled",
        help: "Required connects with TLS using the system certificate store.",
        options: [
          { value: "disabled", label: "Disabled" },
          { value: "required", label: "Required" },
        ],
      },
    ],
  },
  profile: {
    id: "demo-mongo",
    name: "Local MongoDB 7",
    driver: "mongodb",
    host: "127.0.0.1",
    port: 27017,
    username: "",
    database: "app",
    sslMode: "disabled",
    options: {},
    hasPassword: false,
  },
  server: {
    version: "7.0.12",
    versionNumber: 700012,
    serverComment: "MongoDB",
    currentDatabase: "app",
    currentUser: "",
    supportsTls: false,
  },
  session: {
    id: "demo-mongo-session",
    profileId: "demo-mongo",
    driver: "mongodb",
    name: "Local MongoDB 7",
    server: {
      version: "7.0.12",
      versionNumber: 700012,
      serverComment: "MongoDB",
      currentDatabase: "app",
      currentUser: "",
      supportsTls: false,
    },
  },
  databases: [
    { name: "app", isSystem: false },
    { name: "analytics", isSystem: false },
    { name: "admin", isSystem: true },
    { name: "config", isSystem: true },
    { name: "local", isSystem: true },
  ],
  namespaces: [],
  objects: [
    { name: "customers", kind: "collection", schema: "app", comment: null, rowEstimate: mongoCount("customers") },
    { name: "orders", kind: "collection", schema: "app", comment: null, rowEstimate: mongoCount("orders") },
    { name: "products", kind: "collection", schema: "app", comment: null, rowEstimate: mongoCount("products") },
    { name: "order_summary", kind: "view", schema: "app", comment: null, rowEstimate: mongoCount("order_summary") },
    { name: "events", kind: "collection", schema: "analytics", comment: null, rowEstimate: mongoCount("events") },
  ],
  // Columns come from the sampled documents, so the inspector shows what a real
  // collection sample would report (including a nullable union-typed field).
  schema: (object) => {
    const collection = MONGO_COLLECTIONS[object];
    const kind: ObjectKind = object === "order_summary" ? "view" : "collection";
    if (!collection) return genericSchema(object, kind);
    return schemaOf(
      object,
      kind,
      inferMongoColumns(collection.documents).map((field) =>
        column(field.name, field.dataType, {
          nullable: field.nullable,
          isPrimaryKey: field.isPrimaryKey,
        }),
      ),
      {
        indexes: [{ name: "_id_", columns: ["_id"], unique: true, primary: true }],
      },
    );
  },
  // MongoDB has no DDL: the adapter describes the collection as a `create`
  // command, or points at the pipeline that defines a view.
  ddl: (object) =>
    object === "order_summary"
      ? `// view ${object} is defined by its pipeline; see the listCollections output`
      : `// collection ${object}\n{ "create": "${object}" }`,
  // A collection has samples to describe, but no column metadata to complete.
  completableKinds: [],
  collections: MONGO_COLLECTIONS,
  count: mongoCount,
};

const CLICKHOUSE_EVENTS = schemaOf("events", "table", [
  column("day", "Date"),
  column("sku", "String", { isPrimaryKey: true }),
  column("qty", "UInt32"),
  column("note", "Nullable(String)", { nullable: true }),
], {
  indexes: [{ name: "primary_key", columns: ["sku"], unique: false, primary: true }],
});

const CLICKHOUSE_SECTIONS: InspectorSection[] = [
  {
    id: "storage",
    label: "Storage",
    source: "inline",
    blocks: [
      {
        type: "fields",
        title: "MergeTree layout",
        fields: [
          { label: "Engine", value: "ReplacingMergeTree" },
          { label: "Partition by", value: "toYYYYMM(day)" },
          { label: "Order by", value: "sku" },
          { label: "Primary key", value: "sku" },
        ],
      },
      {
        type: "table",
        title: "Active partitions",
        columns: [
          { key: "partition", label: "Partition", role: "meta", format: "text", tone: "neutral" },
          { key: "rows", label: "Rows", role: "meta", format: "number", tone: "neutral" },
          { key: "bytes", label: "Bytes", role: "meta", format: "bytes", tone: "neutral" },
          { key: "parts", label: "Parts", role: "meta", format: "number", tone: "neutral" },
        ],
        rows: [
          { partition: "202601", partitionId: "202601", rows: 1200, bytes: 65536, parts: 3 },
          { partition: "202602", partitionId: "202602", rows: 980, bytes: 49152, parts: 2 },
        ],
        emptyText: "No active partitions or insufficient system.parts permissions.",
        actions: [
          {
            id: "optimize_partition",
            label: "Optimize",
            confirmLabel: "Optimize partition",
            description:
              "This forces a merge for the selected partition and may consume substantial I/O.",
            danger: false,
            param: "partitionId",
            requireParam: false,
          },
          {
            id: "drop_partition",
            label: "Drop",
            confirmLabel: "Drop partition",
            description:
              "This deletes all data in the selected partition. This operation is replicated and cannot be undone.",
            danger: true,
            param: "partitionId",
            requireParam: true,
          },
        ],
      },
      {
        type: "log",
        title: "Recent mutations",
        columns: [
          { key: "id", label: "Mutation", role: "meta", format: "text", tone: "neutral" },
          { key: "status", label: "Status", role: "meta", format: "text", tone: "neutral" },
          { key: "command", label: "Command", role: "body", format: "text", tone: "neutral" },
          { key: "failure", label: "Error", role: "body", format: "text", tone: "danger" },
        ],
        rows: [
          {
            id: "mutation_9",
            status: { text: "2 parts remaining", tone: "warning" },
            command: "ALTER TABLE default.events DELETE WHERE sku = 'retired'",
            failure: "",
          },
        ],
        emptyText: "No recent mutations or insufficient system.mutations permissions.",
      },
    ],
    actions: [],
  },
  {
    id: "query_history",
    label: "Query history",
    source: "live",
    hint: "system.query_log · latest 50",
    errorHint: "Check system.query_log permissions and whether query logging is enabled.",
    blocks: [],
    actions: [],
  },
];

/** What `object_section` answers for the live `query_history` section. */
const CLICKHOUSE_QUERY_HISTORY: InspectorSection = {
  ...CLICKHOUSE_SECTIONS[1],
  blocks: [
    {
      type: "log",
      title: "Recent successful queries",
      columns: [
        { key: "eventTime", label: "Time", role: "meta", format: "text", tone: "neutral" },
        {
          key: "durationMs",
          label: "Duration",
          role: "meta",
          format: "number",
          tone: "neutral",
          unit: "ms",
        },
        { key: "readRows", label: "Rows read", role: "meta", format: "number", tone: "neutral" },
        { key: "readBytes", label: "Read", role: "meta", format: "bytes", tone: "neutral" },
        {
          key: "writtenRows",
          label: "Rows written",
          role: "meta",
          format: "number",
          tone: "neutral",
        },
        { key: "writtenBytes", label: "Written", role: "meta", format: "bytes", tone: "neutral" },
        { key: "memoryBytes", label: "Peak", role: "meta", format: "bytes", tone: "neutral" },
        { key: "query", label: "Query", role: "body", format: "text", tone: "neutral" },
        { key: "exception", label: "Error", role: "body", format: "text", tone: "danger" },
      ],
      rows: [
        {
          eventTime: "2026-10-11 18:32:02.129",
          durationMs: 18,
          readRows: 58231,
          readBytes: 1835008,
          writtenRows: 0,
          writtenBytes: 0,
          memoryBytes: 262144,
          query: "SELECT status, count() FROM orders GROUP BY status",
          exception: "",
        },
        {
          eventTime: "2026-10-11 18:31:02.130",
          durationMs: 2,
          readRows: 1,
          readBytes: 8,
          writtenRows: 0,
          writtenBytes: 0,
          memoryBytes: 4096,
          query: "SELECT 1",
          exception: "",
        },
      ],
      emptyText: "No query history is available, or the server has not flushed its logs yet.",
    },
  ],
};

const CLICKHOUSE_OBJECTS: DatabaseObject[] = [
  { name: "events", kind: "table", schema: "default", comment: null, rowEstimate: 2180 },
  { name: "sessions", kind: "table", schema: "default", comment: null, rowEstimate: 904 },
  { name: "daily_rollup", kind: "materializedView", schema: "default", comment: null, rowEstimate: 365 },
  { name: "v_errors", kind: "view", schema: "default", comment: null, rowEstimate: null },
];

const CLICKHOUSE: EngineFixture = {
  quote: '"',
  driver: {
    id: "clickhouse",
    displayName: "ClickHouse",
    defaultPort: 8123,
    accentColor: "#FFCC01",
    capabilities: {
      queryLanguage: "sql",
      resultShape: "tabular",
      isRelational: true,
      supportsMultipleDatabases: true,
      supportsSchemas: false,
      supportsTransactions: false,
      supportsDdl: true,
      supportsExplain: true,
      supportsCancel: false,
      objectKinds: ["table", "view", "materializedView"],
      supportedActions: ["inspect", "viewData", "countRows", "copyName"],
    },
    configFields: [
      { key: "host", label: "Host", fieldType: "text", placeholder: "127.0.0.1", required: true, defaultValue: "127.0.0.1", options: [] },
      {
        key: "port",
        label: "HTTP port",
        fieldType: "number",
        placeholder: "8123",
        required: true,
        defaultValue: 8123,
        options: [],
        help: "The HTTP interface port (8123 by default).",
      },
      { key: "username", label: "Username", fieldType: "text", placeholder: "default", required: false, options: [] },
      { key: "password", label: "Password", fieldType: "password", placeholder: "••••••••", required: false, options: [] },
      {
        key: "sslMode",
        label: "Transport security",
        fieldType: "select",
        required: true,
        defaultValue: "disabled",
        help: "TLS requires a ClickHouse HTTPS endpoint (commonly port 8443). Certificate validation is enabled.",
        options: [
          { value: "disabled", label: "HTTP (no TLS)" },
          { value: "required", label: "HTTPS (TLS required)" },
        ],
      },
      {
        key: "database",
        label: "Database",
        fieldType: "text",
        placeholder: "default",
        required: false,
        options: [],
        help: "Optional default database for statements that do not name one.",
      },
    ],
  },
  profile: {
    id: "demo-clickhouse",
    name: "Playground ClickHouse",
    driver: "clickhouse",
    host: "127.0.0.1",
    port: 8123,
    username: "default",
    database: "default",
    sslMode: "disabled",
    options: {},
    hasPassword: false,
  },
  server: {
    version: "24.3.1.2672",
    versionNumber: 240301,
    serverComment: "ClickHouse",
    currentDatabase: "default",
    currentUser: "default",
    supportsTls: false,
  },
  session: {
    id: "demo-clickhouse-session",
    profileId: "demo-clickhouse",
    driver: "clickhouse",
    name: "Playground ClickHouse",
    server: {
      version: "24.3.1.2672",
      versionNumber: 240301,
      serverComment: "ClickHouse",
      currentDatabase: "default",
      currentUser: "default",
      supportsTls: false,
    },
  },
  databases: [
    { name: "default", isSystem: false },
    { name: "analytics", isSystem: false },
    { name: "system", isSystem: true },
  ],
  namespaces: [],
  objects: CLICKHOUSE_OBJECTS,
  schema: (object) =>
    object === "events" ? { ...CLICKHOUSE_EVENTS, name: object } : genericSchema(object, "table"),
  ddl: (object) =>
    `CREATE TABLE "default"."${object}" (\n  "day" Date,\n  "sku" String,\n  "qty" UInt32,\n  "note" Nullable(String)\n)\nENGINE = ReplacingMergeTree\nPARTITION BY toYYYYMM(day)\nORDER BY ("sku");`,
  // The only engine that declares inspector sections today.
  sections: () => CLICKHOUSE_SECTIONS,
  sectionBody: (section) => {
    if (section !== "query_history") {
      throw new Error(`${section} is not a refreshable section of this object`);
    }
    return CLICKHOUSE_QUERY_HISTORY;
  },
  // `system.columns` for the database, so every table-like object it stores
  // (including a view, which ClickHouse keeps as a table with a View engine).
  completableKinds: ["table", "view", "materializedView"],
  count: (object) => estimateOf(CLICKHOUSE_OBJECTS, object),
  // ClickHouse only explains a read: `EXPLAIN indexes = 1` on anything else is
  // refused by the adapter rather than sent to the server.
  explainStatement: (sql) => {
    const statement = sql.trim().replace(/;+$/, "");
    const normalized = statement.trimStart().toUpperCase();
    if (!normalized.startsWith("SELECT ") && !normalized.startsWith("WITH ")) return null;
    return `EXPLAIN indexes = 1 ${statement}`;
  },
  // ClickHouse explains index granularity pruning as one text column.
  plan: {
    columns: [{ name: "explain", dataType: "String" }],
    rows: [
      ["Expression ((Projection + Before ORDER BY))"],
      ["  ReadFromMergeTree (default.events)"],
      ["  Indexes:"],
      ["    PrimaryKey"],
      ["      Keys: sku"],
      ["      Condition: true"],
      ["      Parts: 2/2"],
      ["      Granules: 2/2"],
    ],
  },
};

/** One fixture per driver; everything else in the mock is generated from it. */
export const FIXTURES: EngineFixture[] = [MYSQL, POSTGRES, SQLITE, REDIS, MONGO, CLICKHOUSE];

const BY_DRIVER = new Map(FIXTURES.map((fixture) => [fixture.driver.id, fixture]));
const BY_SESSION = new Map(FIXTURES.map((fixture) => [fixture.session.id, fixture]));
const BY_PROFILE = new Map(FIXTURES.map((fixture) => [fixture.profile.id, fixture]));

/** MySQL answers for an unknown id, so a command the UI always sends still runs. */
export function fixtureFor(connectionId: unknown): EngineFixture {
  return (typeof connectionId === "string" && BY_SESSION.get(connectionId)) || MYSQL;
}

export function fixtureForDriver(driverId: unknown): EngineFixture {
  return (typeof driverId === "string" && BY_DRIVER.get(driverId)) || MYSQL;
}

export function fixtureForProfile(profileId: unknown): EngineFixture | undefined {
  return typeof profileId === "string" ? BY_PROFILE.get(profileId) : undefined;
}

/** Assemble the object inspector payload from a fixture's introspection. */
export function detailOf(
  fixture: EngineFixture,
  object: string,
  namespace: string | null,
): ObjectDetail {
  return {
    schema: fixture.schema(object, namespace),
    ddl: fixture.ddl(object, namespace),
    rowCount: fixture.objects.find((entry) => entry.name === object)?.rowEstimate ?? null,
    sizeBytes: null,
    actions: fixture.driver.capabilities.supportedActions,
    identifierQuote: fixture.quote,
    sections: fixture.sections?.(object) ?? [],
  };
}

