import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_QUALIFIER_LOOKBEHIND,
  qualifierOf,
  resolveQualifier,
  type SchemaTable,
} from "./sqlQualifier.ts";

const SCHEMA: SchemaTable[] = [
  { table: "orders", schema: null, columns: ["id", "order_number", "ordered_at"] },
  { table: "order_items", schema: null, columns: ["id", "order_id", "quantity"] },
  {
    table: "archived_orders",
    schema: "cold",
    columns: ["id", "order_number"],
  },
];

test("the identifier next to the dot is the qualifier", () => {
  assert.equal(qualifierOf("SELECT orders."), "orders");
  // Two parts: the identifier next to the dot is the table's, which is the one
  // that names the columns.
  assert.equal(qualifierOf("SELECT shop.orders."), "orders");
  assert.equal(qualifierOf("SELECT o."), "o");
  assert.equal(qualifierOf("(SELECT max(x) FROM t WHERE shop."), "shop");
});

test("a quoted identifier is the same qualifier, with its quotes taken off", () => {
  // Measured against `@codemirror/lang-sql`: `"orders".` offers the columns
  // `orders.` offers, so quoting is spelling rather than meaning — and the schema
  // names its tables and columns unquoted, so a quoted spelling has to come out
  // the way the schema has it.
  assert.equal(qualifierOf('SELECT "orders".'), "orders");
  assert.equal(qualifierOf('SELECT shop."orders".'), "orders");
  // The identifier next to the dot is still the one that names the columns.
  assert.equal(qualifierOf('SELECT "shop"."orders".'), "orders");
  assert.equal(qualifierOf('SELECT "cold".'), "cold");
  // A double quote inside a quoted identifier is written twice.
  assert.equal(qualifierOf('SELECT "order""s".'), 'order"s');
});

test("a position with no usable qualifier yields none", () => {
  // Nothing has been typed yet.
  assert.equal(qualifierOf("SELECT "), null);
  // A bare identifier is the table question, not this one.
  assert.equal(qualifierOf("SELECT ord"), null);
  // A dot with no name before it.
  assert.equal(qualifierOf("SELECT ."), null);
  assert.equal(qualifierOf("SELECT 1."), null);
  // A name that only whitespace separates from the token: the language would not
  // read that as a qualifier either.
  assert.equal(qualifierOf("SELECT orders. "), null);
  assert.equal(qualifierOf(""), null);
  // The same is true of a quoted name: whitespace before the dot is not a
  // qualifier, quoting does not change that.
  assert.equal(qualifierOf('SELECT "orders" .'), null);
  // An empty name names nothing, so it is the same answer as no qualifier.
  assert.equal(qualifierOf('SELECT "".'), null);
  // Backticks and brackets are left alone deliberately: the language does not
  // resolve them either — `` `orders`. `` offers the bare list, not that table's
  // columns — so there is nothing behind them to rank.
  assert.equal(qualifierOf("SELECT `orders`."), null);
  assert.equal(qualifierOf("SELECT [orders]."), null);
});

test("a table's name resolves to its columns, as a column question", () => {
  assert.deepEqual(resolveQualifier("orders", SCHEMA), {
    names: ["id", "order_number", "ordered_at"],
    kind: "column",
  });
  // SQL names are case-insensitive, and so is this.
  assert.deepEqual(resolveQualifier("ORDERS", SCHEMA)?.names, [
    "id",
    "order_number",
    "ordered_at",
  ]);
});

test("a schema's name resolves to its tables, which stay a table question", () => {
  assert.deepEqual(resolveQualifier("cold", SCHEMA), {
    names: ["archived_orders"],
    kind: "table",
  });
});

test("a name the schema does not have resolves to nothing", () => {
  // An alias, most importantly: `@codemirror/lang-sql` does not resolve aliases,
  // so `orders`' columns are not behind `o.` at all — asking about them would
  // cost a model call and reorder nothing.
  assert.equal(resolveQualifier("o", SCHEMA), null);
  assert.equal(resolveQualifier("nope", SCHEMA), null);
});

test("a table wins over a schema of the same spelling", () => {
  const colliding: SchemaTable[] = [
    { table: "cold", schema: null, columns: ["id", "frozen_at"] },
    { table: "archived_orders", schema: "cold", columns: ["id"] },
  ];
  // `cold.` is read as the table, because a name the schema really has as a table
  // is the better reading of it than a container that happens to share it.
  assert.deepEqual(resolveQualifier("cold", colliding), {
    names: ["id", "frozen_at"],
    kind: "column",
  });
});

test("the lookbehind is a bound, and its failure mode is harmless", () => {
  // Only the identifier next to the dot has to fit in the window, which is why a
  // window this small is enough for ordinary SQL. An identifier wider than it is
  // read truncated — and a truncated name resolves to nothing, so the worst case
  // is no ranking rather than the wrong table's columns.
  assert.ok(MAX_QUALIFIER_LOOKBEHIND >= 32, String(MAX_QUALIFIER_LOOKBEHIND));
  const wide = "b".repeat(MAX_QUALIFIER_LOOKBEHIND + 10);
  const document = `SELECT ${wide}.x`;
  const before = document.slice(0, document.length - 1).slice(-MAX_QUALIFIER_LOOKBEHIND);
  const qualifier = qualifierOf(before);
  assert.notEqual(qualifier, wide, "the window cannot hold a name this wide");
  assert.equal(resolveQualifier(qualifier ?? "", SCHEMA), null);
});
