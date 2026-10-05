import assert from "node:assert/strict";
import test from "node:test";

import { buildRowChanges, coerce, type EditSource } from "./rowEdit.ts";

const source: EditSource = {
  ref: {
    sessionId: "s1",
    database: "shop",
    namespace: "public",
    object: "orders",
    objectKind: "table",
  },
  primaryKeys: ["id"],
  autoIncrement: ["id"],
  quote: '"',
  columnTypes: {
    id: "bigint",
    tenant: "text",
    total: "decimal(12,2)",
    active: "boolean",
    note: "text",
  },
};

// ---------------------------------------------------------------- coerce ----

test("numeric columns travel as numbers", () => {
  assert.equal(coerce("42", "bigint(20) unsigned"), 42);
  assert.equal(coerce("3.5", "decimal(12,2)"), 3.5);
  assert.equal(coerce("1e3", "double precision"), 1000);
  assert.equal(coerce("-7", "int"), -7);
  assert.equal(coerce("7", "INTEGER"), 7); // type matching is case-insensitive
});

test("blank numeric cells become NULL", () => {
  assert.equal(coerce("", "int"), null);
  assert.equal(coerce("   ", "numeric"), null);
});

test("a non-numeric string in a numeric column is passed through unchanged", () => {
  // The grid stays stringly typed rather than inventing a value the user did not type.
  assert.equal(coerce("abc", "int"), "abc");
  assert.equal(coerce("1,5", "decimal"), "1,5");
});

test("first-token matching keeps interval and other non-numeric types strings", () => {
  assert.equal(coerce("5", "interval"), "5");
  assert.equal(coerce("12", "text"), "12");
  assert.equal(coerce("12"), "12");
});

test("boolean columns accept the common spellings", () => {
  for (const value of ["true", "TRUE", "t", "T", "1"]) {
    assert.equal(coerce(value, "boolean"), true, value);
  }
  for (const value of ["false", "FALSE", "f", "F", "0"]) {
    assert.equal(coerce(value, "boolean"), false, value);
  }
  assert.equal(coerce("true", "bool"), true);
});

test("an unrecognised boolean value is left as a string", () => {
  assert.equal(coerce("yes", "boolean"), "yes");
  assert.equal(coerce("2", "boolean"), "2");
});

test("null and undefined always coerce to null", () => {
  assert.equal(coerce(null, "int"), null);
  assert.equal(coerce(null, "boolean"), null);
  assert.equal(coerce(undefined as unknown as string, "int"), null);
});

// ------------------------------------------------------- buildRowChanges ----

const columns = ["id", "total", "active", "note"];
const rows: unknown[][] = [
  [1, "10.00", "true", "first"],
  [2, "20.50", "false", null],
];

function build(overrides: Partial<Parameters<typeof buildRowChanges>[0]> = {}) {
  return buildRowChanges({ source, columns, rows, edits: [], selected: [], inserts: [], ...overrides });
}

test("cell edits become one update per row with coerced values", () => {
  const changes = build({
    edits: [
      { rowIndex: 0, column: "total", value: "15.75" },
      { rowIndex: 0, column: "active", value: "false" },
      { rowIndex: 1, column: "note", value: "hello" },
    ],
  });
  assert.equal(changes.length, 2);

  assert.deepEqual(changes[0], {
    connectionId: "s1",
    database: "shop",
    namespace: "public",
    object: "orders",
    kind: "update",
    key: [{ column: "id", value: 1 }],
    values: [
      { column: "total", value: 15.75 },
      { column: "active", value: false },
    ],
  });

  assert.deepEqual(changes[1], {
    connectionId: "s1",
    database: "shop",
    namespace: "public",
    object: "orders",
    kind: "update",
    key: [{ column: "id", value: 2 }],
    values: [{ column: "note", value: "hello" }],
  });
});

test("an edited NULL value is sent as NULL, not dropped", () => {
  const changes = build({ edits: [{ rowIndex: 0, column: "note", value: null }] });
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].values, [{ column: "note", value: null }]);
});

test("selected rows become deletes that carry a key and no values", () => {
  const changes = build({ selected: [0, 1] });
  assert.equal(changes.length, 2);
  assert.deepEqual(changes[0].kind, "delete");
  assert.deepEqual(changes[0].key, [{ column: "id", value: 1 }]);
  assert.deepEqual(changes[0].values, []);
  assert.deepEqual(changes[1].key, [{ column: "id", value: 2 }]);
});

test("a null primary-key cell is preserved in the key", () => {
  const changes = buildRowChanges({
    source,
    columns: ["id", "note"],
    rows: [[null, "a"]],
    edits: [{ rowIndex: 0, column: "note", value: "z" }],
    selected: [],
    inserts: [],
  });
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].key, [{ column: "id", value: null }]);
});

test("insert drafts become inserts with only the filled-in columns", () => {
  const changes = build({
    inserts: [
      { id: "", total: "9.99", active: "true", note: null },
      { total: "1" },
    ],
  });
  assert.equal(changes.length, 2);

  // A blank auto-increment key is left to the server.
  assert.deepEqual(changes[0], {
    connectionId: "s1",
    database: "shop",
    namespace: "public",
    object: "orders",
    kind: "insert",
    key: [],
    values: [
      { column: "total", value: 9.99 },
      { column: "active", value: true },
      { column: "note", value: null },
    ],
  });
  assert.deepEqual(changes[1].key, []);
  assert.deepEqual(changes[1].values, [{ column: "total", value: 1 }]);
});

test("undefined insert cells are skipped, not sent as NULL", () => {
  const changes = build({ inserts: [{ total: "1", note: undefined }] });
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].values, [{ column: "total", value: 1 }]);
});

test("an insert with nothing to send is dropped", () => {
  assert.deepEqual(build({ inserts: [{}] }), []);
  assert.deepEqual(build({ inserts: [{ id: "" }] }), []);
});

test("updates, then deletes, then inserts are emitted in order", () => {
  const changes = build({
    edits: [{ rowIndex: 0, column: "total", value: "1" }],
    selected: [1],
    inserts: [{ total: "2" }],
  });
  assert.deepEqual(
    changes.map((change) => change.kind),
    ["update", "delete", "insert"],
  );
});

test("rows without a full primary key are refused", () => {
  // `id` is not in the result set, so neither edit nor delete can target a row.
  const changes = buildRowChanges({
    source,
    columns: ["total", "note"],
    rows: [["1", "a"]],
    edits: [{ rowIndex: 0, column: "note", value: "z" }],
    selected: [0],
    inserts: [],
  });
  assert.deepEqual(changes, []);
});

test("edits and selections pointing past the loaded rows are ignored", () => {
  const changes = build({
    edits: [{ rowIndex: 9, column: "note", value: "z" }],
    selected: [9],
  });
  assert.deepEqual(changes, []);
});

test("a composite primary key produces a multi-column key", () => {
  const composite: EditSource = { ...source, primaryKeys: ["tenant", "id"] };
  const changes = buildRowChanges({
    source: composite,
    columns: ["tenant", "id", "note"],
    rows: [["t1", 5, "v"]],
    edits: [{ rowIndex: 0, column: "note", value: "z" }],
    selected: [],
    inserts: [],
  });
  assert.deepEqual(changes[0].key, [
    { column: "tenant", value: "t1" },
    { column: "id", value: 5 },
  ]);
});
