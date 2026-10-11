import type { SqlDialect } from "./objects.ts";
import { quoteIdentifier } from "./objects.ts";
import type { ForeignKeySchema, IndexSchema, ObjectSchema } from "./types.ts";

export type SchemaChangeKind =
  | "tableAdded"
  | "tableRemoved"
  | "columnAdded"
  | "columnRemoved"
  | "columnChanged"
  | "indexChanged"
  | "foreignKeyChanged";

export interface SchemaChange {
  table: string;
  kind: SchemaChangeKind;
  name: string;
  detail: string;
  direction?: "sourceOnly" | "targetOnly" | "different";
  sourceIndex?: IndexSchema;
  sourceForeignKey?: ForeignKeySchema;
}

export interface SchemaDiff {
  changes: SchemaChange[];
  addedTables: ObjectSchema[];
  removedTables: ObjectSchema[];
  columnChanges: { source: ObjectSchema; target: ObjectSchema; change: SchemaChange }[];
}

function columnSignature(column: ObjectSchema["columns"][number]): string {
  return JSON.stringify({
    dataType: column.dataType.trim().toLowerCase(),
    nullable: column.nullable,
    defaultValue: column.defaultValue ?? null,
    primary: column.isPrimaryKey,
    autoIncrement: column.isAutoIncrement,
  });
}

function indexSignature(index: IndexSchema): string {
  return JSON.stringify({ columns: index.columns, unique: index.unique, primary: index.primary });
}

function foreignKeySignature(fk: ForeignKeySchema): string {
  return JSON.stringify({
    columns: fk.columns,
    table: fk.referencedTable,
    referencedColumns: fk.referencedColumns,
  });
}

/** Compare source schema structures to target structures using object names. */
export function compareSchemas(source: ObjectSchema[], target: ObjectSchema[]): SchemaDiff {
  const targetByName = new Map(target.map((table) => [table.name, table]));
  const sourceByName = new Map(source.map((table) => [table.name, table]));
  const changes: SchemaChange[] = [];
  const addedTables = source.filter((table) => !targetByName.has(table.name));
  const removedTables = target.filter((table) => !sourceByName.has(table.name));
  const columnChanges: SchemaDiff["columnChanges"] = [];

  for (const table of addedTables) {
    changes.push({ table: table.name, kind: "tableAdded", name: table.name, detail: "Table exists only in source" });
  }
  for (const table of removedTables) {
    changes.push({ table: table.name, kind: "tableRemoved", name: table.name, detail: "Table exists only in target" });
  }

  for (const sourceTable of source) {
    const targetTable = targetByName.get(sourceTable.name);
    if (!targetTable) continue;
    const sourceColumns = new Map(sourceTable.columns.map((column) => [column.name, column]));
    const targetColumns = new Map(targetTable.columns.map((column) => [column.name, column]));

    for (const column of sourceTable.columns) {
      const targetColumn = targetColumns.get(column.name);
      if (!targetColumn) {
        const change: SchemaChange = {
          table: sourceTable.name,
          kind: "columnAdded",
          name: column.name,
          detail: `Column added in source: ${column.dataType}${column.nullable ? " NULL" : " NOT NULL"}`,
        };
        changes.push(change);
        columnChanges.push({ source: sourceTable, target: targetTable, change });
      } else if (columnSignature(column) !== columnSignature(targetColumn)) {
        const change: SchemaChange = {
          table: sourceTable.name,
          kind: "columnChanged",
          name: column.name,
          detail: `Source: ${column.dataType}${column.nullable ? " NULL" : " NOT NULL"}; target: ${targetColumn.dataType}${targetColumn.nullable ? " NULL" : " NOT NULL"}`,
        };
        changes.push(change);
        columnChanges.push({ source: sourceTable, target: targetTable, change });
      }
    }
    for (const column of targetTable.columns) {
      if (!sourceColumns.has(column.name)) {
        changes.push({ table: sourceTable.name, kind: "columnRemoved", name: column.name, detail: "Column exists only in target" });
      }
    }

    const sourceIndexes = new Map(sourceTable.indexes.map((index) => [index.name, index]));
    const targetIndexes = new Map(targetTable.indexes.map((index) => [index.name, index]));
    for (const index of sourceTable.indexes) {
      const other = targetIndexes.get(index.name);
      if (!other) {
        changes.push({
          table: sourceTable.name,
          kind: "indexChanged",
          name: index.name,
          detail: `Index exists only in source (${index.columns.join(", ")})`,
          direction: "sourceOnly",
          sourceIndex: index,
        });
      } else if (indexSignature(index) !== indexSignature(other)) {
        changes.push({
          table: sourceTable.name,
          kind: "indexChanged",
          name: index.name,
          detail: `Index differs between source and target (${index.columns.join(", ")})`,
          direction: "different",
          sourceIndex: index,
        });
      }
    }
    for (const index of targetTable.indexes) {
      if (!sourceIndexes.has(index.name)) {
        changes.push({
          table: sourceTable.name,
          kind: "indexChanged",
          name: index.name,
          detail: `Index exists only in target (${index.columns.join(", ")})`,
          direction: "targetOnly",
        });
      }
    }

    const sourceForeignKeys = new Map(sourceTable.foreignKeys.map((fk) => [fk.name, fk]));
    const targetForeignKeys = new Map(targetTable.foreignKeys.map((fk) => [fk.name, fk]));
    for (const fk of sourceTable.foreignKeys) {
      const other = targetForeignKeys.get(fk.name);
      if (!other) {
        changes.push({
          table: sourceTable.name,
          kind: "foreignKeyChanged",
          name: fk.name,
          detail: `Foreign key exists only in source (${fk.columns.join(", ")} → ${fk.referencedTable})`,
          direction: "sourceOnly",
          sourceForeignKey: fk,
        });
      } else if (foreignKeySignature(fk) !== foreignKeySignature(other)) {
        changes.push({
          table: sourceTable.name,
          kind: "foreignKeyChanged",
          name: fk.name,
          detail: `Foreign key differs between source and target (${fk.columns.join(", ")} → ${fk.referencedTable})`,
          direction: "different",
          sourceForeignKey: fk,
        });
      }
    }
    for (const fk of targetTable.foreignKeys) {
      if (!sourceForeignKeys.has(fk.name)) {
        changes.push({
          table: sourceTable.name,
          kind: "foreignKeyChanged",
          name: fk.name,
          detail: `Foreign key exists only in target (${fk.columns.join(", ")} → ${fk.referencedTable})`,
          direction: "targetOnly",
        });
      }
    }
  }

  return { changes, addedTables, removedTables, columnChanges };
}

function comment(text: string): string {
  return `-- Manual review required: ${text.replace(/[\r\n]+/g, " ")}`;
}

function columnDefinition(
  column: ObjectSchema["columns"][number],
  dialect: SqlDialect,
  quote: string,
  inlinePrimary = false,
  singlePrimary = false,
): string {
  const name = quoteIdentifier(column.name, quote);
  const type = column.dataType.trim() || "TEXT";
  if (
    dialect === "sqlite" && column.isAutoIncrement && column.isPrimaryKey && singlePrimary &&
    type.toUpperCase() === "INTEGER"
  ) {
    return `${name} INTEGER PRIMARY KEY AUTOINCREMENT`;
  }

  let definition = `${name} ${type}`;
  if (column.isAutoIncrement) {
    if (dialect === "mysql") definition += " AUTO_INCREMENT";
    if (dialect === "postgres") definition += " GENERATED BY DEFAULT AS IDENTITY";
  }
  definition += column.nullable ? " NULL" : " NOT NULL";
  if (column.defaultValue && !column.isAutoIncrement) {
    definition += ` DEFAULT ${column.defaultValue}`;
  }
  if (inlinePrimary && column.isPrimaryKey) definition += " PRIMARY KEY";
  return definition;
}

function foreignKeyDefinition(
  fk: ForeignKeySchema,
  quote: string,
  qualify: (table: string) => string,
  dialect: SqlDialect,
): string {
  const name = fk.name ? `CONSTRAINT ${quoteIdentifier(fk.name, quote)} ` : "";
  const columns = fk.columns.map((column) => quoteIdentifier(column, quote)).join(", ");
  const referencedColumns = fk.referencedColumns.map((column) => quoteIdentifier(column, quote)).join(", ");
  const referencedTable = dialect === "sqlite"
    ? quoteIdentifier(fk.referencedTable, quote)
    : qualify(fk.referencedTable);
  return `${name}FOREIGN KEY (${columns}) REFERENCES ${referencedTable} (${referencedColumns})`;
}

function createIndexSql(
  index: IndexSchema,
  table: string,
  quote: string,
  qualify: (table: string) => string,
  dialect: SqlDialect,
): string | null {
  if (index.primary) return null;
  if (index.columns.length === 0 || dialect === "clickhouse") return null;
  const columns = index.columns.map((column) => quoteIdentifier(column, quote)).join(", ");
  const tableName = dialect === "sqlite" ? quoteIdentifier(table, quote) : qualify(table);
  return `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quoteIdentifier(index.name, quote)} ON ${tableName} (${columns});`;
}

/**
 * Render additive changes for the target dialect. Destructive or ambiguous
 * differences remain comments; unsupported ClickHouse table metadata is never
 * turned into executable, incomplete CREATE TABLE SQL.
 */
export function migrationDraft(
  diff: SchemaDiff,
  quote: string,
  qualify: (table: string) => string,
  dialect: SqlDialect,
): string {
  const statements = ["-- Review before running. Destructive, engine-specific and ambiguous changes are comments."];
  const manualTables = new Set<string>();
  const deferredForeignKeys: { table: string; fk: ForeignKeySchema }[] = [];

  for (const table of diff.addedTables) {
    const primaryColumns = table.columns.filter((column) => column.isPrimaryKey);
    const invalidSqliteAutoIncrement = dialect === "sqlite" && table.columns.some((column) =>
      column.isAutoIncrement && (
        !column.isPrimaryKey || primaryColumns.length !== 1 || column.dataType.trim().toUpperCase() !== "INTEGER"
      ),
    );
    if (dialect === "clickhouse" || invalidSqliteAutoIncrement || table.columns.length === 0) {
      manualTables.add(table.name);
      const reason = dialect === "clickhouse"
        ? "ClickHouse table creation requires engine and ORDER BY metadata"
        : invalidSqliteAutoIncrement
          ? "SQLite AUTOINCREMENT requires one INTEGER PRIMARY KEY"
          : "table has no columns";
      statements.push(comment(`${table.name}: ${reason}.`));
      continue;
    }

    const definitions = table.columns.map((column) => columnDefinition(
      column,
      dialect,
      quote,
      primaryColumns.length === 1,
      primaryColumns.length === 1,
    ));
    if (primaryColumns.length > 1) {
      definitions.push(`PRIMARY KEY (${primaryColumns.map((column) => quoteIdentifier(column.name, quote)).join(", ")})`);
    }
    if (dialect === "sqlite") {
      for (const fk of table.foreignKeys) definitions.push(foreignKeyDefinition(fk, quote, qualify, dialect));
    }
    statements.push(`CREATE TABLE ${qualify(table.name)} (\n  ${definitions.join(",\n  ")}\n);`);
    if (dialect !== "sqlite") {
      deferredForeignKeys.push(...table.foreignKeys.map((fk) => ({ table: table.name, fk })));
    }
  }

  for (const item of diff.columnChanges) {
    if (item.change.kind !== "columnAdded") {
      statements.push(comment(`${item.change.detail} (${item.source.name}.${item.change.name}).`));
      continue;
    }
    const column = item.source.columns.find((candidate) => candidate.name === item.change.name);
    if (!column) continue;
    if (dialect === "clickhouse" || column.isPrimaryKey || column.isAutoIncrement ||
      (!column.nullable && !column.defaultValue?.trim())) {
      statements.push(comment(`${item.change.detail} (${item.source.name}.${item.change.name}); target dialect requires a manual migration.`));
      continue;
    }
    statements.push(`ALTER TABLE ${qualify(item.source.name)} ADD COLUMN ${columnDefinition(column, dialect, quote)};`);
  }

  for (const change of diff.changes) {
    if (change.kind === "indexChanged" && change.direction === "sourceOnly" && change.sourceIndex) {
      const sql = createIndexSql(change.sourceIndex, change.table, quote, qualify, dialect);
      statements.push(sql ?? comment(`${change.detail} (${change.table}.${change.name}); index form needs manual review.`));
    } else if (change.kind === "foreignKeyChanged" && change.direction === "sourceOnly" && change.sourceForeignKey) {
      if (dialect === "postgres" || dialect === "mysql") {
        deferredForeignKeys.push({ table: change.table, fk: change.sourceForeignKey });
      } else {
        statements.push(comment(`${change.detail} (${change.table}.${change.name}); target dialect cannot add this constraint in place.`));
      }
    } else if (["tableRemoved", "columnRemoved"].includes(change.kind) ||
      ((change.kind === "indexChanged" || change.kind === "foreignKeyChanged") && change.direction !== "sourceOnly")) {
      statements.push(comment(`${change.detail} (${change.table}.${change.name}).`));
    }
  }

  for (const table of diff.addedTables) {
    if (manualTables.has(table.name)) continue;
    for (const index of table.indexes) {
      const sql = createIndexSql(index, table.name, quote, qualify, dialect);
      if (sql) statements.push(sql);
      else if (!index.primary) statements.push(comment(`Index ${index.name} on ${table.name} needs manual review.`));
    }
  }

  for (const { table, fk } of deferredForeignKeys) {
    if (manualTables.has(table)) continue;
    statements.push(`ALTER TABLE ${qualify(table)} ADD ${foreignKeyDefinition(fk, quote, qualify, dialect)};`);
  }

  return statements.join("\n\n");
}
