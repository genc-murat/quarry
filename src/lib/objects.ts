import type {
  ColumnSchema,
  DatabaseObject,
  MaintenanceKind,
  ObjectDetail,
  ObjectKind,
} from "./types";

/**
 * The order groups appear under a database/namespace, and the only place the
 * set of known kinds is written down on the frontend. Adding a kind here plus
 * its label is all the explorer needs to group it.
 */
export const OBJECT_KIND_ORDER: ObjectKind[] = [
  "table",
  "view",
  "materializedView",
  "collection",
  "keySpace",
  "key",
  "function",
  "procedure",
  "trigger",
  "event",
  "sequence",
  "other",
];

export const OBJECT_KIND_LABEL: Record<ObjectKind, string> = {
  table: "Tables",
  view: "Views",
  materializedView: "Materialized views",
  collection: "Collections",
  keySpace: "Keyspaces",
  key: "Keys",
  function: "Functions",
  procedure: "Procedures",
  trigger: "Triggers",
  event: "Events",
  sequence: "Sequences",
  other: "Other",
};

export interface ObjectGroup {
  kind: ObjectKind;
  label: string;
  objects: DatabaseObject[];
}

/**
 * Group objects by kind in the declared order, dropping empty groups. Anything
 * with an unrecognised kind at runtime is folded into "other" so a newer driver
 * can never make objects disappear.
 */
export function groupObjectsByKind(objects: DatabaseObject[]): ObjectGroup[] {
  const buckets = new Map<ObjectKind, DatabaseObject[]>();
  for (const object of objects) {
    const kind = OBJECT_KIND_ORDER.includes(object.kind) ? object.kind : "other";
    const bucket = buckets.get(kind);
    if (bucket) bucket.push(object);
    else buckets.set(kind, [object]);
  }
  return OBJECT_KIND_ORDER.filter((kind) => buckets.has(kind)).map((kind) => ({
    kind,
    label: OBJECT_KIND_LABEL[kind],
    objects: buckets.get(kind) ?? [],
  }));
}

export interface ObjectRef {
  sessionId: string;
  database: string;
  namespace: string | null;
  object: string;
  objectKind: ObjectKind;
}

/** Stable cache key for an object tab / detail. */
export function objectKey(ref: ObjectRef): string {
  return `${ref.sessionId}||${ref.database}||${ref.namespace ?? ""}||${ref.object}`;
}

/** Quote an identifier using the driver's quote character. SQL Server's
 *  brackets are the one pair that does not close with its opening character,
 *  so they escape by doubling the closing bracket instead. */
export function quoteIdentifier(name: string, quote = '"'): string {
  if (quote === "[") return `[${name.split("]").join("]]")}]`;
  return `${quote}${name.split(quote).join(quote + quote)}${quote}`;
}

/**
 * The SQL dialect behind a driver id. The identifier quote character alone is
 * not enough to tell PostgreSQL and SQLite apart, yet their generated SQL
 * differs (identity vs. `INTEGER PRIMARY KEY AUTOINCREMENT`), so the preview
 * builders key off the driver id instead.
 */
export type SqlDialect = "mysql" | "postgres" | "sqlite" | "sqlserver" | "clickhouse";

export function dialectForDriver(driverId: string | null | undefined): SqlDialect {
  if (driverId === "mysql") return "mysql";
  if (driverId === "sqlite") return "sqlite";
  if (driverId === "mssql") return "sqlserver";
  if (driverId === "clickhouse") return "clickhouse";
  return "postgres";
}

/** Fully qualified, quoted name (schema for PostgreSQL, database for MySQL). */
export function qualifiedName(
  ref: { database: string; namespace: string | null; object: string },
  quote = '"',
): string {
  const qualifier = ref.namespace && ref.namespace.length > 0 ? ref.namespace : ref.database;
  return qualifier
    ? `${quoteIdentifier(qualifier, quote)}.${quoteIdentifier(ref.object, quote)}`
    : quoteIdentifier(ref.object, quote);
}

export type TemplateKind = "select" | "insert" | "update" | "delete";

/** A request to open one of the shared object dialogs (hosted globally). */
export type ObjectDialogRequest =
  | { ref: ObjectRef; kind: "index" }
  | { ref: ObjectRef; kind: "addColumn" }
  | { ref: ObjectRef; kind: "alterColumn"; column: ColumnSchema }
  | { ref: ObjectRef; kind: "export" }
  | { ref: ObjectRef; kind: "rename" }
  | { ref: ObjectRef; kind: "duplicate" }
  | { ref: ObjectRef; kind: "truncate" }
  | { ref: ObjectRef; kind: "drop" }
  | { ref: ObjectRef; kind: "reindex" }
  | { ref: ObjectRef; kind: "dropIndex"; indexName: string }
  | { ref: ObjectRef; kind: "dropColumn"; column: ColumnSchema }
  | { ref: ObjectRef; kind: "maintenance"; maintenance: MaintenanceKind };

export type ExportFormat = "csv" | "json" | "sql";

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Serialize query rows to CSV, JSON or SQL INSERT statements. */
export function serializeExport(
  format: ExportFormat,
  columns: string[],
  rows: unknown[][],
  ref: { database: string; namespace: string | null; object: string },
  quote: string,
  header: boolean,
): string {
  if (format === "json") {
    return JSON.stringify(
      rows.map((row) => Object.fromEntries(columns.map((name, i) => [name, row[i]]))),
      null,
      2,
    );
  }
  if (format === "sql") {
    const table = qualifiedName(ref, quote);
    const columnList = columns.map((name) => quoteIdentifier(name, quote)).join(", ");
    return rows
      .map((row) => {
        const values = row
          .map((value) =>
            value === null || value === undefined
              ? "NULL"
              : typeof value === "number" || typeof value === "boolean"
                ? scalar(value)
                : `'${String(value).replace(/'/g, "''")}'`,
          )
          .join(", ");
        return `INSERT INTO ${table} (${columnList}) VALUES (${values});`;
      })
      .join("\n");
  }
  const escape = (value: unknown) => {
    const raw = value === null || value === undefined ? "" : scalar(value);
    return /[\",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
  };
  const lines = rows.map((row) => row.map(escape).join(","));
  return (header ? [columns.join(","), ...lines] : lines).join("\n");
}

/** Trigger a browser download of a generated text file. */
export function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Build a starter query for the requested object from its columns. */
export function templateSql(
  kind: TemplateKind,
  ref: { database: string; namespace: string | null; object: string },
  detail: ObjectDetail,
): string {
  const quote = detail.identifierQuote || '"';
  const table = qualifiedName(ref, quote);
  const columns = detail.schema.columns.map((column) => column.name);
  const quoted = (name: string) => quoteIdentifier(name, quote);
  const primary = detail.schema.columns.filter((column) => column.isPrimaryKey);
  const whereColumns = (primary.length > 0 ? primary : detail.schema.columns.slice(0, 1)).map(
    (column) => column.name,
  );

  switch (kind) {
    case "select":
      // T-SQL has no `LIMIT`; its row bound rides on `TOP`. The brackets are
      // what tell the dialect apart here, the same fact the quoting uses.
      return quote === "["
        ? `SELECT TOP 100 ${columns.map(quoted).join(", ") || "*"}\nFROM ${table};`
        : `SELECT ${columns.map(quoted).join(", ") || "*"}\nFROM ${table}\nLIMIT 100;`;
    case "insert":
      return `INSERT INTO ${table} (${columns.map(quoted).join(", ")})\nVALUES (${columns
        .map(() => "?")
        .join(", ")});`;
    case "update":
      return `UPDATE ${table}\nSET ${quoted(columns[1] ?? columns[0] ?? "column")} = ?\nWHERE ${whereColumns
        .map((column) => `${quoted(column)} = ?`)
        .join(" AND ")};`;
    case "delete":
      return `DELETE FROM ${table}\nWHERE ${whereColumns
        .map((column) => `${quoted(column)} = ?`)
        .join(" AND ")};`;
  }
}
