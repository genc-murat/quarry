import assert from "node:assert/strict";
import test from "node:test";

import { changesDatabaseSet, writesWithoutWhere } from "./sqlIntent.ts";

test("creating or dropping a database is detected", () => {
  assert.equal(changesDatabaseSet("CREATE DATABASE shop2;"), true);
  assert.equal(changesDatabaseSet("create database if not exists shop2;"), true);
  assert.equal(changesDatabaseSet("DROP DATABASE olddb;"), true);
  assert.equal(changesDatabaseSet("  drop database `olddb`  "), true);
});

test("schema DDL counts too (MySQL schemas are databases)", () => {
  assert.equal(changesDatabaseSet("CREATE SCHEMA sales;"), true);
  assert.equal(changesDatabaseSet("DROP SCHEMA public CASCADE;"), true);
});

test("table and query statements are not flagged", () => {
  assert.equal(changesDatabaseSet("CREATE TABLE orders (id bigint);"), false);
  assert.equal(changesDatabaseSet("DROP TABLE orders;"), false);
  assert.equal(changesDatabaseSet("SELECT * FROM database_backup;"), false);
  assert.equal(changesDatabaseSet("ALTER DATABASE shop RENAME TO shop2;"), false);
  assert.equal(changesDatabaseSet("INSERT INTO schema_log VALUES (1);"), false);
});

test("word boundaries avoid matching larger identifiers", () => {
  assert.equal(changesDatabaseSet("CREATE DATABASE_NAME;"), false);
  assert.equal(changesDatabaseSet("DROP SCHEMAS;"), false);
});

test("multi-statement scripts are detected when any statement qualifies", () => {
  assert.equal(changesDatabaseSet("SELECT 1; CREATE DATABASE later; SELECT 2;"), true);
});

test("write safety checks each statement and ignores WHERE in comments and literals", () => {
  assert.deepEqual(writesWithoutWhere("UPDATE items SET note = 'note'; DELETE FROM items;"), ["UPDATE items SET note = 'note'", "DELETE FROM items"]);
  assert.deepEqual(writesWithoutWhere("UPDATE items SET name = 1 /* WHERE id = 2 */"), ["UPDATE items SET name = 1 /* WHERE id = 2 */"]);
  assert.deepEqual(writesWithoutWhere("UPDATE items SET name = 'it''s WHERE';"), ["UPDATE items SET name = 'it''s WHERE'"]);
  assert.deepEqual(writesWithoutWhere("DELETE FROM items -- WHERE id = 2\n"), ["DELETE FROM items -- WHERE id = 2"]);
  assert.deepEqual(writesWithoutWhere("UPDATE items SET name = 1 WHERE id IN (SELECT id FROM t)"), []);
});

test("write safety sees top-level commands after CTEs", () => {
  assert.deepEqual(writesWithoutWhere("WITH target AS (SELECT 1) DELETE FROM items"), ["WITH target AS (SELECT 1) DELETE FROM items"]);
  assert.deepEqual(writesWithoutWhere("WITH target AS (SELECT 1) UPDATE items SET name = 2 WHERE id = 1"), []);
});

test("write safety examines nested CTE body writes but ignores nested reads", () => {
  assert.deepEqual(writesWithoutWhere("WITH changed AS (UPDATE items SET name = 1 RETURNING id) SELECT * FROM changed"), ["WITH changed AS (UPDATE items SET name = 1 RETURNING id) SELECT * FROM changed"]);
  assert.deepEqual(writesWithoutWhere("UPDATE items SET name = (SELECT max(name) FROM other) WHERE id = 1"), []);
  assert.deepEqual(writesWithoutWhere("WITH c AS (SELECT 'UPDATE t SET x=1' AS note) UPDATE items SET name = 2 WHERE id = 3"), []);
});
