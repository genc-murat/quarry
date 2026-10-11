import assert from "node:assert/strict";
import test from "node:test";

import { compareSchemas, migrationDraft } from "./schemaDiff.ts";
import type { ObjectSchema } from "./types.ts";

function schema(name: string, columnNames: string[]): ObjectSchema {
  return {
    name,
    kind: "table",
    columns: columnNames.map((column, ordinal) => ({
      name: column,
      dataType: column === "id" ? "INTEGER" : "TEXT",
      nullable: column !== "id",
      defaultValue: null,
      isPrimaryKey: column === "id",
      isAutoIncrement: false,
      ordinal,
    })),
    indexes: [],
    foreignKeys: [],
  };
}

test("compareSchemas finds table, column and definition differences", () => {
  const source = [schema("users", ["id", "name", "email"]), schema("new_table", ["id"])];
  const target = [schema("users", ["id", "name", "legacy"]), schema("old_table", ["id"])];
  const diff = compareSchemas(source, target);
  assert.deepEqual(diff.addedTables.map((table) => table.name), ["new_table"]);
  assert.deepEqual(diff.removedTables.map((table) => table.name), ["old_table"]);
  assert.ok(diff.changes.some((change) => change.kind === "columnAdded" && change.name === "email"));
  assert.ok(diff.changes.some((change) => change.kind === "columnRemoved" && change.name === "legacy"));
  const draft = migrationDraft(diff, '"', (table) => `"public"."${table}"`, "postgres");
  assert.match(draft, /ALTER TABLE "public"\."users" ADD COLUMN "email" TEXT NULL;/);
  assert.match(draft, /CREATE TABLE "public"\."new_table"/);
  assert.match(draft, /Manual review required/);
  assert.doesNotMatch(draft, /DROP TABLE|DROP COLUMN/);
});

test("compareSchemas detects changed columns without rendering risky ALTER SQL", () => {
  const source = schema("users", ["id", "name"]);
  source.columns[1].dataType = "VARCHAR(255)";
  const target = schema("users", ["id", "name"]);
  target.columns[1].dataType = "TEXT";
  const diff = compareSchemas([source], [target]);
  assert.ok(diff.changes.some((change) => change.kind === "columnChanged"));
  assert.match(migrationDraft(diff, '"', (table) => `"${table}"`, "postgres"), /Manual review required/);
  assert.doesNotMatch(migrationDraft(diff, '"', (table) => `"${table}"`, "postgres"), /ALTER TABLE/);
});

test("compareSchemas detects target-only indexes and foreign keys", () => {
  const sourceTable = schema("orders", ["id", "owner_id"]);
  const targetTable = schema("orders", ["id", "owner_id"]);
  targetTable.indexes.push({ name: "idx_orders_owner", columns: ["owner_id"], unique: false, primary: false });
  targetTable.foreignKeys.push({ name: "fk_orders_owner", columns: ["owner_id"], referencedTable: "owners", referencedColumns: ["id"] });

  const diff = compareSchemas([sourceTable], [targetTable]);
  assert.ok(diff.changes.some((change) => change.kind === "indexChanged" && change.direction === "targetOnly"));
  assert.ok(diff.changes.some((change) => change.kind === "foreignKeyChanged" && change.direction === "targetOnly"));
});

test("new-table drafts preserve SQLite autoincrement, indexes, and foreign keys", () => {
  const users = schema("users", ["id", "name"]);
  users.columns[0].isAutoIncrement = true;
  users.indexes.push({ name: "idx_users_name", columns: ["name"], unique: true, primary: false });
  users.foreignKeys.push({ name: "fk_users_org", columns: ["name"], referencedTable: "orgs", referencedColumns: ["name"] });
  const diff = compareSchemas([users], []);
  const sqliteDraft = migrationDraft(diff, '"', (table) => `"${table}"`, "sqlite");
  assert.match(sqliteDraft, /"id" INTEGER PRIMARY KEY AUTOINCREMENT/);
  assert.match(sqliteDraft, /CREATE UNIQUE INDEX "idx_users_name" ON "users" \("name"\);/);
  assert.match(sqliteDraft, /FOREIGN KEY \("name"\) REFERENCES "orgs" \("name"\)/);
  assert.doesNotMatch(sqliteDraft, /"id" INTEGER NOT NULL/);
});

test("source-only indexes and foreign keys are drafted safely by dialect", () => {
  const source = schema("orders", ["id", "owner_id"]);
  source.indexes.push({ name: "idx_orders_owner", columns: ["owner_id"], unique: false, primary: false });
  source.foreignKeys.push({ name: "fk_orders_owner", columns: ["owner_id"], referencedTable: "owners", referencedColumns: ["id"] });
  const target = schema("orders", ["id", "owner_id"]);
  const diff = compareSchemas([source], [target]);

  const postgres = migrationDraft(diff, '"', (table) => `"public"."${table}"`, "postgres");
  assert.match(postgres, /CREATE INDEX "idx_orders_owner" ON "public"\."orders" \("owner_id"\);/);
  assert.match(postgres, /ALTER TABLE "public"\."orders" ADD CONSTRAINT "fk_orders_owner" FOREIGN KEY/);

  const sqlite = migrationDraft(diff, '"', (table) => `"${table}"`, "sqlite");
  assert.match(sqlite, /Manual review required: Foreign key exists only in source/);
  assert.doesNotMatch(sqlite, /ALTER TABLE .* ADD CONSTRAINT/);
});

test("new ClickHouse tables remain manual without engine metadata", () => {
  const diff = compareSchemas([schema("events", ["id"])], []);
  const draft = migrationDraft(diff, '"', (table) => `"db"."${table}"`, "clickhouse");
  assert.match(draft, /ClickHouse table creation requires engine and ORDER BY metadata/);
  assert.doesNotMatch(draft, /CREATE TABLE/);
});

test("compareSchemas is empty for equivalent named structures", () => {
  assert.equal(compareSchemas([schema("users", ["id", "name"])], [schema("users", ["id", "name"])]).changes.length, 0);
});
