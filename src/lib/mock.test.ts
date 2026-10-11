import assert from "node:assert/strict";
import test from "node:test";

import { mockInvoke, mockLatency } from "./mock.ts";
import { FIXTURES, type EngineFixture } from "./mockFixtures.ts";
import type {
  ConnectionProfile,
  DatabaseInfo,
  DatabaseObject,
  DriverDescriptor,
  InspectorSection,
  ObjectDetail,
  QueryResponse,
  SessionInfo,
  TableColumns,
} from "./types.ts";

// The mock's latency exists so the browser shows its loading states. Scripting
// a sequence of commands should not wait for it, so the tests run at zero.
mockLatency.min = 0;
mockLatency.max = 0;

const call = <T>(cmd: string, args?: Record<string, unknown>) => mockInvoke<T>(cmd, args);

const databaseOf = (fixture: EngineFixture): string =>
  (fixture.databases.find((entry) => !entry.isSystem) ?? fixture.databases[0]).name;

const namespaceOf = (fixture: EngineFixture): string | null =>
  fixture.namespaces[0]?.name ?? null;

/** Objects `list_objects` must return: the selected namespace when the engine
 *  has namespaces, otherwise the selected database (which every adapter filters
 *  on, MySQL by database and PostgreSQL by schema). */
const listedObjects = (fixture: EngineFixture): DatabaseObject[] => {
  const scope = namespaceOf(fixture) ?? databaseOf(fixture);
  return fixture.objects.filter((entry) => entry.schema === scope);
};

test("every engine ships a driver, a saved connection and a session", async () => {
  const drivers = await call<DriverDescriptor[]>("list_drivers");
  const sessions = await call<SessionInfo[]>("list_sessions");
  const profiles = await call<ConnectionProfile[]>("list_connections");

  assert.deepEqual(
    drivers.map((entry) => entry.id),
    FIXTURES.map((fixture) => fixture.driver.id),
  );
  // A driver with no session would be unreachable from the UI.
  assert.deepEqual(
    sessions.map((entry) => entry.driver).sort(),
    drivers.map((entry) => entry.id).sort(),
  );
  assert.equal(new Set(sessions.map((entry) => entry.id)).size, sessions.length);
  assert.deepEqual(
    profiles.map((entry) => entry.driver),
    drivers.map((entry) => entry.id),
  );
});

test("each session is routed to its own engine's data", async () => {
  for (const fixture of FIXTURES) {
    const databases = await call<DatabaseInfo[]>("list_databases", {
      connectionId: fixture.session.id,
    });
    assert.deepEqual(databases, fixture.databases, fixture.driver.id);

    const objects = await call<DatabaseObject[]>("list_objects", {
      connectionId: fixture.session.id,
      database: databaseOf(fixture),
      namespace: namespaceOf(fixture),
    });
    assert.deepEqual(
      objects.map((entry) => entry.name),
      listedObjects(fixture).map((entry) => entry.name),
      fixture.driver.id,
    );
  }
});

test("the explorer never offers an object kind the driver does not advertise", async () => {
  for (const fixture of FIXTURES) {
    const objects = listedObjects(fixture);
    assert.ok(objects.length > 0, `${fixture.driver.id} would show an empty tree`);
    for (const object of objects) {
      assert.ok(
        fixture.driver.capabilities.objectKinds.includes(object.kind),
        `${fixture.driver.id} has no object kind ${object.kind}`,
      );
    }
  }
});

test("PostgreSQL reports its schemas and scopes objects to the selected one", async () => {
  const postgres = FIXTURES.find((fixture) => fixture.driver.id === "postgres");
  assert.ok(postgres);
  const sessionId = postgres.session.id;

  const namespaces = await call<{ name: string }[]>("list_namespaces", { connectionId: sessionId });
  assert.deepEqual(
    namespaces.map((entry) => entry.name),
    ["public", "audit"],
  );

  const audit = await call<DatabaseObject[]>("list_objects", {
    connectionId: sessionId,
    database: "app",
    namespace: "audit",
  });
  assert.ok(audit.length > 0);
  assert.deepEqual([...new Set(audit.map((entry) => entry.schema))], ["audit"]);

  // Every other engine has no schemas, so the namespace list stays empty.
  for (const fixture of FIXTURES.filter((entry) => entry.driver.id !== "postgres")) {
    const none = await call<unknown[]>("list_namespaces", { connectionId: fixture.session.id });
    assert.deepEqual(none, [], fixture.driver.id);
  }
});

test("each SQL engine explains in its own dialect and plan shape", async () => {
  const request = { sql: "SELECT * FROM orders;" };
  const explain = (sessionId: string) =>
    call<QueryResponse>("explain_query", { connectionId: sessionId, request });
  const columnsOf = (response: QueryResponse) =>
    response.results[0].columns.map((column) => column.name);

  const mysql = await explain("demo-session");
  assert.equal(mysql.results[0].statement, "EXPLAIN SELECT * FROM orders");
  assert.ok(columnsOf(mysql).includes("table"));

  const postgres = await explain("demo-postgres-session");
  assert.equal(postgres.results[0].statement, "EXPLAIN SELECT * FROM orders");
  assert.deepEqual(columnsOf(postgres), ["QUERY PLAN"]);

  const sqlite = await explain("demo-sqlite-session");
  assert.equal(sqlite.results[0].statement, "EXPLAIN QUERY PLAN SELECT * FROM orders");
  assert.deepEqual(columnsOf(sqlite), ["id", "parent", "notused", "detail"]);

  const clickhouse = await explain("demo-clickhouse-session");
  assert.equal(clickhouse.results[0].statement, "EXPLAIN indexes = 1 SELECT * FROM orders");
  assert.deepEqual(columnsOf(clickhouse), ["explain"]);

  // ClickHouse explains a read and nothing else, so a write is refused before
  // it reaches the server.
  await assert.rejects(
    () =>
      call<QueryResponse>("explain_query", {
        connectionId: "demo-clickhouse-session",
        request: { sql: "INSERT INTO events VALUES (1)" },
      }),
    /cannot explain queries/,
  );
});

test("engines without EXPLAIN refuse it, exactly as the command does", async () => {
  for (const driver of ["mongodb", "redis"]) {
    const fixture = FIXTURES.find((entry) => entry.driver.id === driver);
    assert.ok(fixture);
    assert.equal(fixture.driver.capabilities.supportsExplain, false);
    await assert.rejects(
      () =>
        call<QueryResponse>("explain_query", {
          connectionId: fixture.session.id,
          request: { sql: "SELECT 1" },
        }),
      /cannot explain queries/,
      driver,
    );
  }
});

test("only the engine that declares inspector sections answers the section commands", async () => {
  const detail = await call<ObjectDetail>("object_detail", {
    connectionId: "demo-clickhouse-session",
    database: "default",
    namespace: null,
    object: "events",
  });
  assert.deepEqual(
    detail.sections.map((section) => `${section.id}:${section.source}`),
    ["storage:inline", "query_history:live"],
  );

  const body = await call<InspectorSection>("object_section", {
    request: {
      connectionId: "demo-clickhouse-session",
      database: "default",
      namespace: null,
      object: "events",
      section: "query_history",
    },
  });
  assert.ok(body.blocks.length > 0, "the live section must have a body to render");

  // The inline section is already in the detail, so asking for its body is a
  // mistake the adapter rejects rather than silently re-fetching.
  await assert.rejects(
    () =>
      call<InspectorSection>("object_section", {
        request: {
          connectionId: "demo-clickhouse-session",
          database: "default",
          namespace: null,
          object: "events",
          section: "storage",
        },
      }),
    /not a refreshable section/,
  );

  const action = await call<QueryResponse>("object_section_action", {
    request: {
      connectionId: "demo-clickhouse-session",
      database: "default",
      namespace: null,
      object: "events",
      section: "storage",
      action: "drop_partition",
      param: "202601",
    },
  });
  assert.equal(
    action.results[0].statement,
    `ALTER TABLE "default"."events" DROP PARTITION ID '202601'`,
  );

  for (const fixture of FIXTURES.filter((entry) => entry.driver.id !== "clickhouse")) {
    const other = await call<ObjectDetail>("object_detail", {
      connectionId: fixture.session.id,
      database: databaseOf(fixture),
      namespace: namespaceOf(fixture),
      object: fixture.objects[0].name,
    });
    assert.deepEqual(other.sections, [], fixture.driver.id);
    await assert.rejects(
      () =>
        call<InspectorSection>("object_section", {
          request: {
            connectionId: fixture.session.id,
            database: databaseOf(fixture),
            namespace: namespaceOf(fixture),
            object: fixture.objects[0].name,
            section: "storage",
          },
        }),
      /no on-demand inspector sections/,
      fixture.driver.id,
    );
  }
});

test("generated DDL is quoted in the engine's own dialect", async () => {
  for (const fixture of FIXTURES) {
    const object = fixture.objects[0];
    const detail = await call<ObjectDetail>("object_detail", {
      connectionId: fixture.session.id,
      database: databaseOf(fixture),
      namespace: namespaceOf(fixture),
      object: object.name,
    });
    const quote = fixture.driver.id === "mysql" ? "`" : '"';
    assert.equal(detail.identifierQuote, quote, fixture.driver.id);
    if (fixture.driver.capabilities.isRelational) {
      assert.ok(
        detail.ddl.startsWith("CREATE TABLE"),
        `${fixture.driver.id} has no CREATE: ${detail.ddl.split("\n")[0]}`,
      );
      assert.ok(
        detail.ddl.includes(`${quote}${object.name}${quote}`),
        `${fixture.driver.id} did not quote ${object.name}: ${detail.ddl.split("\n")[0]}`,
      );
    } else {
      // Redis and MongoDB have no DDL to generate; their adapters describe the
      // object instead of inventing a CREATE TABLE (# Redis key / // collection).
      assert.match(detail.ddl, /^(#|\/\/)/, fixture.driver.id);
    }
  }
});

test("the row count the inspector shows is the one count_rows returns", async () => {
  for (const fixture of FIXTURES) {
    const database = databaseOf(fixture);
    const namespace = namespaceOf(fixture);
    for (const object of listedObjects(fixture).filter((entry) => entry.rowEstimate !== null)) {
      const detail = await call<ObjectDetail>("object_detail", {
        connectionId: fixture.session.id,
        database,
        namespace,
        object: object.name,
      });
      const count = await call<number>("count_rows", {
        connectionId: fixture.session.id,
        database,
        namespace,
        object: object.name,
      });
      assert.equal(detail.rowCount, object.rowEstimate, `${fixture.driver.id}/${object.name}`);
      assert.equal(count, object.rowEstimate, `${fixture.driver.id}/${object.name}`);
    }
  }
});

test("completion lists exactly the kinds the adapter can report columns for", async () => {
  for (const fixture of FIXTURES) {
    const tables = await call<TableColumns[]>("list_table_columns", {
      connectionId: fixture.session.id,
      database: databaseOf(fixture),
      namespace: namespaceOf(fixture),
    });
    assert.deepEqual(
      tables.map((entry) => entry.table),
      listedObjects(fixture)
        .filter((entry) => fixture.completableKinds.includes(entry.kind))
        .map((entry) => entry.name),
      fixture.driver.id,
    );
    for (const entry of tables) {
      assert.ok(entry.columns.length > 0, `${fixture.driver.id}/${entry.table} has no columns`);
    }
  }

  // A key and a collection have no column metadata at all.
  for (const driver of ["redis", "mongodb"]) {
    const fixture = FIXTURES.find((entry) => entry.driver.id === driver);
    assert.ok(fixture);
    assert.deepEqual(fixture.completableKinds, [], driver);
    const tables = await call<TableColumns[]>("list_table_columns", {
      connectionId: fixture.session.id,
      database: databaseOf(fixture),
      namespace: namespaceOf(fixture),
    });
    assert.deepEqual(tables, [], driver);
  }
});

test("the editor answers every engine in its own result shape", async () => {
  // SQL engines share the tabular preview: one result per statement.
  for (const fixture of FIXTURES.filter(
    (entry) => entry.driver.capabilities.queryLanguage === "sql",
  )) {
    const response = await call<QueryResponse>("execute_query", {
      connectionId: fixture.session.id,
      request: { sql: "SELECT 1; SELECT 2;" },
    });
    assert.equal(response.results.length, 2, fixture.driver.id);
    assert.equal(response.results[1].error, null, fixture.driver.id);
    assert.equal(
      response.results[0].rows.length,
      response.results[0].rowCount,
      fixture.driver.id,
    );
    assert.ok(response.results[0].rowCount > 0, fixture.driver.id);
  }

  // Redis: one result per command line, each shaped by its reply (a scalar, a
  // field/value map, and one row per list element).
  const redis = await call<QueryResponse>("execute_query", {
    connectionId: "demo-redis-session",
    request: { sql: "TYPE order:1001\nHGETALL order:1001\nLRANGE queue:jobs 0 -1" },
  });
  assert.deepEqual(
    redis.results.map((result) => result.statement),
    ["TYPE order:1001", "HGETALL order:1001", "LRANGE queue:jobs 0 -1"],
  );
  assert.deepEqual(redis.results[0].rows, [["hash"]]);
  assert.deepEqual(
    redis.results[1].columns.map((column) => column.name),
    ["field", "value"],
  );
  assert.equal(redis.results[2].rowCount, 12);

  // The row limit is the request's, and a longer collection is flagged.
  const truncated = await call<QueryResponse>("execute_query", {
    connectionId: "demo-redis-session",
    request: { sql: "SMEMBERS users:online", maxRows: 100 },
  });
  assert.equal(truncated.results[0].rowCount, 100);
  assert.equal(truncated.results[0].truncated, true);

  // Mongo: `find` returns documents (no declared column types, extended JSON
  // intact), every other command answers with a single reply row.
  const mongo = await call<QueryResponse>("execute_query", {
    connectionId: "demo-mongo-session",
    request: { sql: '{"find": "customers"}\n{"count": "customers"}' },
  });
  assert.deepEqual(
    mongo.results[0].columns.map((column) => column.name),
    ["_id", "email", "name", "orders", "vip", "createdAt"],
  );
  assert.ok(mongo.results[0].columns.every((column) => column.dataType === null));
  assert.equal(mongo.results[0].rowCount, 3);
  assert.deepEqual(mongo.results[0].rows[0][0], { $oid: "6512f0c1b7e4a1d2c3e4f5a1" });
  assert.deepEqual(
    mongo.results[1].columns.map((column) => column.name),
    ["n", "ok"],
  );
  assert.deepEqual(mongo.results[1].rows, [[12480, 1]]);

  // A script with no command at all is refused, exactly as the command is.
  for (const sessionId of ["demo-redis-session", "demo-mongo-session"]) {
    await assert.rejects(
      () =>
        call<QueryResponse>("execute_query", {
          connectionId: sessionId,
          request: { sql: "  \n" },
        }),
      /no command to execute/,
      sessionId,
    );
  }
});
