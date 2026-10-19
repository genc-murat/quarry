import assert from "node:assert/strict";
import test from "node:test";

import {
  OBJECT_KIND_LABEL,
  OBJECT_KIND_ORDER,
  dialectForDriver,
  groupObjectsByKind,
  qualifiedName,
  quoteIdentifier,
  templateSql,
} from "./objects.ts";
import type { DatabaseObject } from "./types.ts";

function obj(name: string, kind: DatabaseObject["kind"]): DatabaseObject {
  return { name, kind, schema: "shop" };
}

test("brackets quote and escape where the closing differs from the opening", () => {
  assert.equal(quoteIdentifier("orders", "["), "[orders]");
  // A bracket identifier escapes by doubling the closing bracket, not the
  // opening one — the symmetric doubling would produce "[a[[b[".
  assert.equal(quoteIdentifier("a]b", "["), "[a]]b]");
  assert.equal(quoteIdentifier("a`b", "`"), "`a``b`");
  assert.equal(quoteIdentifier('a"b', '"'), "\"a\"\"b\"");
  assert.equal(
    qualifiedName({ database: "shop", namespace: "dbo", object: "orders" }, "["),
    "[dbo].[orders]",
  );
});

test("the sqlserver dialect is its own, and its select template takes TOP", () => {
  assert.equal(dialectForDriver("mssql"), "sqlserver");
  assert.equal(dialectForDriver("postgres"), "postgres");
  const detail = {
    schema: {
      name: "orders",
      kind: "table" as const,
      columns: [
        { name: "id", dataType: "int", nullable: false, isPrimaryKey: true, isAutoIncrement: true, ordinal: 1 },
        { name: "status", dataType: "nvarchar(20)", nullable: false, isPrimaryKey: false, isAutoIncrement: false, ordinal: 2 },
      ],
      indexes: [],
      foreignKeys: [],
    },
    ddl: "",
    rowCount: null,
    sizeBytes: null,
    actions: [],
    identifierQuote: "[",
    sections: [],
  };
  const ref = { database: "shop", namespace: "dbo", object: "orders" };
  assert.equal(
    templateSql("select", ref, detail),
    "SELECT TOP 100 [id], [status]\nFROM [dbo].[orders];",
  );
  // Every other dialect keeps its `LIMIT`.
  const pgDetail = { ...detail, identifierQuote: '"' };
  assert.match(templateSql("select", ref, pgDetail), /LIMIT 100;/);
});

test("groups follow the declared kind order", () => {
  const groups = groupObjectsByKind([
    obj("b", "view"),
    obj("a", "table"),
    obj("t", "trigger"),
    obj("f", "function"),
  ]);
  assert.deepEqual(
    groups.map((group) => group.kind),
    ["table", "view", "function", "trigger"],
  );
});

test("empty groups are dropped", () => {
  const groups = groupObjectsByKind([obj("a", "table")]);
  assert.deepEqual(
    groups.map((group) => group.kind),
    ["table"],
  );
});

test("objects keep their order within a group", () => {
  const groups = groupObjectsByKind([obj("z", "table"), obj("a", "table"), obj("m", "table")]);
  assert.deepEqual(
    groups[0].objects.map((object) => object.name),
    ["z", "a", "m"],
  );
});

test("labels come from the kind label map", () => {
  const groups = groupObjectsByKind([obj("x", "materializedView"), obj("y", "event")]);
  assert.equal(groups[0].label, OBJECT_KIND_LABEL.materializedView);
  assert.equal(groups[1].label, OBJECT_KIND_LABEL.event);
});

test("an unknown kind is folded into other instead of vanishing", () => {
  const groups = groupObjectsByKind([
    obj("a", "table"),
    { name: "mystery", kind: "futureKind" as DatabaseObject["kind"], schema: "shop" },
  ]);
  const other = groups.find((group) => group.kind === "other");
  assert.ok(other, "unknown kind was dropped");
  assert.deepEqual(
    other.objects.map((object) => object.name),
    ["mystery"],
  );
  assert.equal(
    groups.reduce((total, group) => total + group.objects.length, 0),
    2,
  );
});

test("empty input yields no groups", () => {
  assert.deepEqual(groupObjectsByKind([]), []);
});

test("the order lists every labelled kind exactly once", () => {
  assert.deepEqual([...OBJECT_KIND_ORDER].sort(), Object.keys(OBJECT_KIND_LABEL).sort());
  assert.equal(new Set(OBJECT_KIND_ORDER).size, OBJECT_KIND_ORDER.length);
});
