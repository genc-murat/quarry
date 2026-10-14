/**
 * Development-only fake backend.
 *
 * The real app always talks to the Rust core through Tauri. When the frontend
 * is opened in a plain browser (`npm run dev` without the shell) this module
 * supplies representative data so the UI can be designed and reviewed without
 * a live database. It is never used inside the packaged desktop app.
 *
 * Every command is answered from the fixture of the session's engine, so each
 * engine's surface — connection form, explorer tree, object inspector, editor —
 * can be walked in the browser. The fixtures themselves live in
 * `./mockFixtures`; this file only routes commands and keeps the small amount
 * of state a session needs (settings, saved queries, the editable result set).
 */
import type {
  ConnectResult,
  ConnectionProfile,
  CreateTableRequest,
  DriverDescriptor,
  ImportConnectionsSummary,
  NamespaceInfo,
  ObjectActionRequest,
  ObjectSectionActionRequest,
  ObjectSectionRequest,
  QueryRequest,
  QueryResponse,
  RankCandidatesResponse,
  RowChangeRequest,
  ServerInfo,
  SessionInfo,
  Snippet,
} from "./types";
// The `.ts` extension keeps this module loadable by `node --test` directly,
// which is how the fixture set is checked (see `mock.test.ts`).
// Explicit `.ts` like `./mockFixtures.ts`, so `node --test` can load this module.
import { mongoStatements, redisStatements } from "./mockReplies.ts";
import {
  FIXTURES,
  type EngineFixture,
  detailOf,
  fixtureFor,
  fixtureForDriver,
  fixtureForProfile,
} from "./mockFixtures.ts";

/**
 * Artificial latency of every mocked command, in milliseconds. Set both bounds
 * to 0 to script a sequence of commands without waiting (the tests do), or
 * raise them to exercise loading and cancellation paths by hand.
 */
export const mockLatency = { min: 90, max: 210 };

/** Long-query simulation: a statement containing `slow` or `sleep` blocks this
 *  long, so the Stop button and the cancelled state are reachable. */
export const mockSlowQueryMs = 4000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function delay(): Promise<void> {
  if (mockLatency.max <= 0) return Promise.resolve();
  const span = Math.max(0, mockLatency.max - mockLatency.min);
  return sleep(mockLatency.min + Math.random() * span);
}

const STATUSES = ["new", "paid", "shipped", "cancelled"];

/** Section-action id the ClickHouse adapter advertises (`drivers/clickhouse.rs`). */
const DROP_PARTITION = "drop_partition";

/** Rows a request gets when it does not set a limit (`max_rows.unwrap_or(1000)`). */
const DEFAULT_MAX_ROWS = 1000;

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
// It is shared by every tabular engine: the point of the grid flow is the edit
// round trip, not per-engine row data.
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
  {
    id: "snippet-pg-vacuum",
    name: "Bloat check",
    sql: "SELECT relname, n_dead_tup\nFROM pg_stat_user_tables\nORDER BY n_dead_tup DESC;",
    database: "app",
    driver: "postgres",
    createdAt: 1_760_000_200_000,
  },
  {
    id: "snippet-redis-hot-keys",
    name: "Sample keys",
    sql: "SCAN 0 COUNT 100",
    database: "0",
    driver: "redis",
    createdAt: 1_760_000_300_000,
  },
  {
    id: "snippet-mongo-new-orders",
    name: "New orders",
    sql: '{"find": "orders", "filter": {"status": "new"}, "limit": 20}',
    database: "app",
    driver: "mongodb",
    createdAt: 1_760_000_400_000,
  },
];

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

/**
 * One editor run in the engine's own result shape. SQL engines share the
 * tabular preview rows; Redis and Mongo build theirs from the reply mapping the
 * adapters use (see `./mockReplies`), and refuse an empty script exactly like
 * the command does.
 */
function scriptResult(fixture: EngineFixture, request: QueryRequest): QueryResponse {
  const maxRows = request.maxRows && request.maxRows > 0 ? request.maxRows : DEFAULT_MAX_ROWS;
  switch (fixture.driver.capabilities.queryLanguage) {
    case "redis": {
      const results = redisStatements(request.sql, fixture.keys ?? [], maxRows);
      if (results.length === 0) throw new Error("no command to execute");
      return { results, totalMs: results.length };
    }
    case "mongo": {
      const results = mongoStatements(request.sql, fixture.collections ?? {}, maxRows);
      if (results.length === 0) throw new Error("no command to execute");
      return { results, totalMs: results.length };
    }
    default:
      return buildResult(request);
  }
}

/** The trait's default explain: prefix `EXPLAIN`, trailing semicolons dropped. */
function explainSql(sql: string): string {
  return `EXPLAIN ${sql.trim().replace(/;+$/, "").trim()}`;
}

/** The plan an engine's `explain_query` returns, in its own shape. */
function explainResult(fixture: EngineFixture, sql: string): QueryResponse {
  // Engines without `supports_explain` have no plan shape and refuse, exactly
  // like the command does against a real server.
  const plan = fixture.plan;
  if (!plan) {
    throw new Error("this driver cannot explain queries");
  }
  // A driver that builds the statement itself may refuse this one (ClickHouse
  // only explains a read), which the command reports as an error.
  let statement = explainSql(sql);
  if (fixture.explainStatement) {
    const built = fixture.explainStatement(sql);
    if (built === null) {
      throw new Error("this driver cannot explain queries");
    }
    statement = built;
  }
  return {
    results: [
      {
        statement,
        isQuery: true,
        columns: plan.columns,
        rows: plan.rows,
        rowCount: plan.rows.length,
        affectedRows: null,
        lastInsertId: null,
        executionMs: 2,
        truncated: false,
        error: null,
      },
    ],
    totalMs: 2,
  };
}

/**
 * The session a call targets. Most commands take `connectionId` as a top-level
 * argument, but the ones that take a typed request carry it inside that request
 * (and a batch carries one per entry), so all three shapes are read here.
 */
function sessionOf(args?: Record<string, unknown>): unknown {
  if (typeof args?.connectionId === "string") return args.connectionId;
  const request = args?.request as { connectionId?: unknown } | undefined;
  if (typeof request?.connectionId === "string") return request.connectionId;
  const requests = args?.requests as { connectionId?: unknown }[] | undefined;
  return Array.isArray(requests) ? requests[0]?.connectionId : undefined;
}

/** Routes a command name to the fixture of the session's engine. */
export async function mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  await delay();
  const respond = (value: unknown) => value as T;
  const fixture = fixtureFor(sessionOf(args));
  const namespace = typeof args?.namespace === "string" ? args.namespace : null;

  switch (cmd) {
    case "list_drivers":
      return respond(FIXTURES.map((entry) => entry.driver) satisfies DriverDescriptor[]);
    case "list_connections":
      return respond(FIXTURES.map((entry) => entry.profile) satisfies ConnectionProfile[]);
    // The browser has no disk and no second machine. Export still reports the
    // connections it would have written, and an import answers as one would
    // when the file came from here: everything in it is already in the list.
    case "export_connections":
      return respond(FIXTURES.length);
    case "import_connections":
      return respond({
        imported: 0,
        skipped: FIXTURES.length,
        unsupported: [],
      } satisfies ImportConnectionsSummary);
    case "list_sessions":
      // MySQL stays first so the default demo session is unchanged; every other
      // engine is reachable from the session picker.
      return respond(FIXTURES.map((entry) => entry.session) satisfies SessionInfo[]);
    case "save_connection": {
      const input = (args?.input ?? {}) as Partial<ConnectionProfile> & { driver?: string };
      const base = fixtureForDriver(input.driver).profile;
      return respond({ ...base, ...input, hasPassword: true } as ConnectionProfile);
    }
    case "delete_connection":
    case "disconnect":
      return respond(undefined);
    case "set_settings":
      SETTINGS = (args?.value as Record<string, unknown>) ?? {};
      return respond(undefined);
    case "connect": {
      const input = (args?.input ?? {}) as {
        profileId?: string | null;
        config?: { driver?: string } | null;
      };
      const target = fixtureForProfile(input.profileId) ?? fixtureForDriver(input.config?.driver);
      return respond({ session: target.session } satisfies ConnectResult);
    }
    case "test_connection": {
      const config = (args?.config ?? {}) as { driver?: string };
      return respond(fixtureForDriver(config.driver).server satisfies ServerInfo);
    }
    case "list_databases":
      return respond(fixture.databases);
    case "list_namespaces":
      return respond(fixture.namespaces satisfies NamespaceInfo[]);
    case "list_objects": {
      const database = typeof args?.database === "string" ? args.database : "";
      // Objects are tagged with the database/namespace they live in, exactly as
      // the adapters report them: a namespace narrows the list, and a database
      // with no fixture simply lists nothing.
      return respond(
        fixture.objects.filter((entry) =>
          namespace ? entry.schema === namespace : !database || entry.schema === database,
        ),
      );
    }
    case "describe_object": {
      const object = String(args?.object ?? fixture.objects[0]?.name ?? "orders");
      return respond(fixture.schema(object, namespace));
    }
    case "list_table_columns": {
      // Only the kinds this adapter can report columns for, scoped to the
      // selected namespace or database exactly like `list_objects`.
      const database = typeof args?.database === "string" ? args.database : "";
      return respond(
        fixture.objects
          .filter((entry) => fixture.completableKinds.includes(entry.kind))
          .filter((entry) =>
            namespace ? entry.schema === namespace : !database || entry.schema === database,
          )
          .map((entry) => ({
            table: entry.name,
            schema: entry.schema,
            columns: fixture.schema(entry.name, entry.schema ?? null).columns.map((column) => ({
              name: column.name,
              dataType: column.dataType,
            })),
          })),
      );
    }
    case "execute_query": {
      const request = (args?.request as QueryRequest) ?? { sql: "SELECT 1" };
      // A `slow`/`sleep` statement simulates a long query so the Stop button
      // and cancelled state can be exercised in the browser.
      if (/\b(slow|sleep)\b/i.test(request.sql)) {
        await sleep(mockSlowQueryMs);
      }
      return respond(scriptResult(fixture, request));
    }
    case "cancel_query":
      return respond(true);
    case "explain_query": {
      const request = (args?.request as QueryRequest) ?? { sql: "SELECT 1" };
      return respond(explainResult(fixture, request.sql));
    }
    case "object_section": {
      const request = (args?.request as ObjectSectionRequest) ?? null;
      const section = request?.section ?? "";
      // Engines without on-demand sections refuse exactly like the adapter's
      // default, so the UI's error path is the one a real server would produce.
      if (!fixture.sectionBody) {
        throw new Error("this driver has no on-demand inspector sections");
      }
      return respond(fixture.sectionBody(section));
    }
    case "object_section_action": {
      const request = args?.request as ObjectSectionActionRequest | undefined;
      if (!fixture.sectionBody || !request) {
        throw new Error("this driver has no inspector section actions");
      }
      const param = request.param ?? "";
      const statement =
        request.action === DROP_PARTITION
          ? `ALTER TABLE "${request.database}"."${request.object}" DROP PARTITION ID '${param}'`
          : `OPTIMIZE TABLE "${request.database}"."${request.object}" PARTITION ID '${param}'`;
      return respond({
        results: [
          {
            statement,
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
    case "object_detail": {
      const object = String(args?.object ?? fixture.objects[0]?.name ?? "orders");
      return respond(detailOf(fixture, object, namespace));
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
      return respond(fixture.count(String(args?.object ?? fixture.objects[0]?.name ?? "orders")));
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
    // The browser has no local model to ask. Ranking is a desktop assist, so
    // the demo answers as an app without Ollama would: no opinion, and the
    // editor keeps its ordinary order.
    case "rank_candidates":
      return respond({
        ranked: [],
        choice: null,
        confidence: 0,
        available: false,
        reason: "no local model in the browser demo",
        // Nothing was read either: the browser has no model to read it with, and a
        // reading is never invented.
        readings: [],
      } satisfies RankCandidatesResponse);
    // The browser has no disk: `scriptFiles.ts` downloads instead of calling
    // this, so the reply only keeps the command set total.
    case "write_script_file":
      return respond(undefined);
    default:
      return respond(undefined);
  }
}
