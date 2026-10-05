import assert from "node:assert/strict";
import test from "node:test";

import { changesDatabaseSet } from "./sqlIntent.ts";

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
