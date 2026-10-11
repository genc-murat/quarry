import assert from "node:assert/strict";
import test from "node:test";

import {
  bsonTypeName,
  inferMongoColumns,
  mongoDocumentsToTable,
  mongoStatements,
  redis,
  redisReplyToTable,
  redisStatements,
  splitCommandDocuments,
  tokenizeCommandLine,
  type MongoCollectionFixture,
  type RedisKeyFixture,
} from "./mockReplies.ts";

const keys: RedisKeyFixture[] = [
  {
    name: "order:1001",
    type: "hash",
    elements: [],
    fields: [
      ["status", "paid"],
      ["total", "128.40"],
    ],
  },
  { name: "session:3f9c", type: "string", elements: ["token"], ttlSeconds: 3120 },
  { name: "queue:jobs", type: "list", elements: ["job-1", "job-2", "job-3"] },
  { name: "users:online", type: "set", elements: ["user:1", "user:2"] },
  { name: "products:hot", type: "zset", elements: ["sku-a", "sku-b"] },
];

const collections: Record<string, MongoCollectionFixture> = {
  customers: {
    count: 12480,
    documents: [
      { _id: { $oid: "a1" }, email: "ada@example.com", vip: true },
      { _id: { $oid: "a2" }, email: "linus@example.com" },
      { _id: { $oid: "a3" }, email: "grace@example.com", vip: null },
    ],
  },
};

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

test("a scalar reply is a single cell typed by the reply", () => {
  const integer = redisReplyToTable(redis.integer(42), 10);
  assert.deepEqual(integer.columns, [{ name: "value", dataType: "integer" }]);
  assert.deepEqual(integer.rows, [[42]]);
  assert.equal(integer.truncated, false);

  const status = redisReplyToTable(redis.status("PONG"), 10);
  assert.deepEqual(status.columns, [{ name: "value", dataType: "status" }]);
  assert.deepEqual(status.rows, [["PONG"]]);
});

test("a flat array reply becomes one row per element in a single column", () => {
  const table = redisReplyToTable(redis.array(redis.string("a"), redis.string("b")), 10);
  assert.deepEqual(table.columns, [{ name: "value", dataType: "string" }]);
  assert.deepEqual(table.rows, [["a"], ["b"]]);
});

test("a nested array reply becomes a col_1..col_N matrix, short rows padded", () => {
  const table = redisReplyToTable(
    redis.array(
      redis.array(redis.integer(1), redis.integer(2)),
      redis.array(redis.integer(3)),
    ),
    10,
  );
  assert.deepEqual(
    table.columns.map((column) => column.name),
    ["col_1", "col_2"],
  );
  assert.deepEqual(table.rows, [
    [1, 2],
    [3, null],
  ]);
});

test("a map reply becomes a field/value table", () => {
  const table = redisReplyToTable(
    redis.map([
      [redis.string("status"), redis.string("paid")],
      [redis.string("total"), redis.string("128.40")],
    ]),
    10,
  );
  assert.deepEqual(
    table.columns.map((column) => column.name),
    ["field", "value"],
  );
  assert.deepEqual(table.rows, [
    ["status", "paid"],
    ["total", "128.40"],
  ]);
});

test("a reply longer than the row limit is cut and flagged", () => {
  const table = redisReplyToTable(
    redis.array(redis.integer(1), redis.integer(2), redis.integer(3)),
    2,
  );
  assert.equal(table.rows.length, 2);
  assert.equal(table.truncated, true);
});

test("command lines are tokenized with quotes and escapes", () => {
  assert.deepEqual(tokenizeCommandLine("GET key"), ["GET", "key"]);
  assert.deepEqual(tokenizeCommandLine("SET k 'a b'"), ["SET", "k", "a b"]);
  assert.deepEqual(tokenizeCommandLine('SET k "a\\"b"'), ["SET", "k", 'a"b']);
  assert.deepEqual(tokenizeCommandLine("   "), []);
});

test("each command line answers with the shape of its reply", () => {
  const results = redisStatements(
    [
      "# a comment is skipped",
      "TYPE order:1001",
      "HGETALL order:1001",
      "LRANGE queue:jobs 0 -1",
      "SMEMBERS users:online",
      "SCAN 0 COUNT 100",
      "GET session:3f9c",
      "TTL session:3f9c",
    ].join("\n"),
    keys,
    10,
  );

  assert.deepEqual(
    results.map((result) => result.statement),
    [
      "TYPE order:1001",
      "HGETALL order:1001",
      "LRANGE queue:jobs 0 -1",
      "SMEMBERS users:online",
      "SCAN 0 COUNT 100",
      "GET session:3f9c",
      "TTL session:3f9c",
    ],
  );
  assert.ok(results.every((result) => result.isQuery && result.error === null));

  const [type, hashes, list, set, scan, get, ttl] = results;
  assert.deepEqual(type.rows, [["hash"]]);
  assert.deepEqual(
    hashes.columns.map((column) => column.name),
    ["field", "value"],
  );
  assert.equal(hashes.rowCount, 2);
  assert.deepEqual(list.rows, [["job-1"], ["job-2"], ["job-3"]]);
  assert.deepEqual(set.rows, [["user:1"], ["user:2"]]);
  // `SCAN` answers `[cursor, [keys…]]`: only the *second* element is an array,
  // so the flat branch applies and the reply is two rows of one column, with
  // the key list kept as JSON — exactly what `array_table` does.
  assert.deepEqual(scan.columns, [{ name: "value", dataType: "string" }]);
  assert.deepEqual(scan.rows, [
    ["0"],
    [["order:1001", "session:3f9c", "queue:jobs", "users:online", "products:hot"]],
  ]);
  assert.deepEqual(get.rows, [["token"]]);
  assert.deepEqual(ttl.rows, [[3120]]);

  // Every element of a `WITHSCORES` reply is an array, which is the case that
  // does render as the col_1/col_2 matrix.
  const [zset] = redisStatements("ZRANGE products:hot 0 -1 WITHSCORES", keys, 10);
  assert.deepEqual(
    zset.columns.map((column) => column.name),
    ["col_1", "col_2"],
  );
  assert.deepEqual(zset.rows, [
    ["sku-a", "1"],
    ["sku-b", "2"],
  ]);
});

test("a long collection truncates at the row limit", () => {
  const long: RedisKeyFixture[] = [
    { name: "big:set", type: "set", elements: Array.from({ length: 2500 }, (_, i) => `m${i}`) },
  ];
  const [result] = redisStatements("SMEMBERS big:set", long, 1000);
  assert.equal(result.rowCount, 1000);
  assert.equal(result.truncated, true);
});

test("an unsampled command is an error, not fabricated data", () => {
  const [result] = redisStatements("CONFIG GET maxmemory", keys, 10);
  assert.equal(result.isQuery, false);
  assert.match(String(result.error), /no reply for 'CONFIG'/);
  assert.deepEqual(result.columns, []);

  const [missingKey] = redisStatements("GET nope", keys, 10);
  assert.equal(missingKey.isQuery, false);
  assert.match(String(missingKey.error), /no such key/);

  // Writing against the wrong type is refused as it is by the server.
  const [wrongType] = redisStatements("LRANGE order:1001 0 -1", keys, 10);
  assert.match(String(wrongType.error), /no such key/);
});

test("an empty script produces no statements for the caller to refuse", () => {
  assert.deepEqual(redisStatements("\n# only a comment\n", keys, 10), []);
  assert.deepEqual(redisStatements("", keys, 10), []);
});

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------

test("documents flatten to the union of their top-level keys", () => {
  const table = mongoDocumentsToTable(collections.customers.documents, 10);
  assert.deepEqual(
    table.columns,
    [
      { name: "_id", dataType: null },
      { name: "email", dataType: null },
      { name: "vip", dataType: null },
    ],
  );
  // A document without `vip` carries a null, and extended JSON stays intact.
  assert.deepEqual(table.rows, [
    [{ $oid: "a1" }, "ada@example.com", true],
    [{ $oid: "a2" }, "linus@example.com", null],
    [{ $oid: "a3" }, "grace@example.com", null],
  ]);
  assert.equal(table.truncated, false);
});

test("a document limit is applied and flagged", () => {
  const table = mongoDocumentsToTable(collections.customers.documents, 2);
  assert.equal(table.rows.length, 2);
  assert.equal(table.truncated, true);
});

test("inferred columns put _id first and union the field types", () => {
  const columns = inferMongoColumns([
    { _id: 1, orders: 12, tags: ["a"], createdAt: { $date: "2026-01-01" } },
    { _id: 2, orders: null, name: "Ada", createdAt: { $date: "2026-01-02" } },
  ]);
  assert.deepEqual(
    columns.map((column) => column.name),
    ["_id", "orders", "tags", "createdAt", "name"],
  );
  assert.deepEqual(columns[1], {
    name: "orders",
    dataType: "int | null",
    nullable: true,
    isPrimaryKey: false,
  });
  // Present in one of two documents, so it is nullable as well.
  assert.equal(columns[4].nullable, true);
  assert.deepEqual(columns[0], {
    name: "_id",
    dataType: "int",
    nullable: false,
    isPrimaryKey: true,
  });
});

test("BSON type names match the adapter's vocabulary", () => {
  assert.equal(bsonTypeName({ $oid: "a1" }), "objectId");
  assert.equal(bsonTypeName({ $date: "2026-01-01" }), "date");
  assert.equal(bsonTypeName({ $numberDecimal: "1.5" }), "decimal");
  assert.equal(bsonTypeName(1), "int");
  assert.equal(bsonTypeName(1.5), "double");
  assert.equal(bsonTypeName(true), "bool");
  assert.equal(bsonTypeName(["a"]), "array");
  assert.equal(bsonTypeName({ width: 1 }), "object");
  assert.equal(bsonTypeName(null), "null");
});

test("commands are split on separators, ignoring braces inside strings", () => {
  assert.deepEqual(splitCommandDocuments('{"find": "orders"}, {"count": "orders"}'), [
    '{"find": "orders"}',
    '{"count": "orders"}',
  ]);
  assert.deepEqual(splitCommandDocuments('{"find": "orders", "filter": {"note": "a } brace"}}'), [
    '{"find": "orders", "filter": {"note": "a } brace"}}',
  ]);
});

test("find returns documents while other commands return one reply row", () => {
  const results = mongoStatements(
    '{"find": "customers"}\n{"count": "customers"}\n{"ping": 1}',
    collections,
    10,
  );
  assert.equal(results.length, 3);
  assert.equal(results[0].rowCount, 3);
  assert.equal(results[0].columns.length, 3);

  assert.deepEqual(
    results[1].columns.map((column) => column.name),
    ["n", "ok"],
  );
  assert.deepEqual(results[1].rows, [[12480, 1]]);
  assert.deepEqual(results[2].rows, [[1]]);
});

test("an unsampled command fails instead of answering ok", () => {
  const [unknown] = mongoStatements('{"collStats": "orders"}', collections, 10);
  assert.equal(unknown.isQuery, false);
  assert.match(String(unknown.error), /no reply for 'collStats'/);
});

test("a script that is not a sequence of command documents fails the run", () => {
  // The adapter propagates these instead of reporting one bad statement among
  // good ones, so the caller (and the editor) sees a single failure.
  assert.throws(() => mongoStatements('{"find": "customers"', collections, 10), /unterminated/);
  assert.throws(() => mongoStatements('find customers', collections, 10), /expected a JSON command/);
  assert.throws(() => mongoStatements('{}', collections, 10), /empty command document/);
  assert.throws(() => mongoStatements('{"find": }', collections, 10), /invalid JSON command/);
});

test("an empty script produces no statements for the caller to refuse", () => {
  assert.deepEqual(mongoStatements("  \n", collections, 10), []);
});

test("find on an unknown collection is an empty result, not an error", () => {
  const [result] = mongoStatements('{"find": "nope"}', collections, 10);
  assert.equal(result.isQuery, true);
  assert.equal(result.rowCount, 0);
  assert.deepEqual(result.columns, []);
  assert.equal(result.error, null);
});
