import type { ObjectRef } from "./objects";
import type { RowChangeRequest, RowValue } from "./types";

/**
 * What makes a result set editable: the source table, the key columns used to
 * target exactly one row, the identifier quote, and the column types so values
 * can be sent with the right SQL type instead of always as strings.
 */
export interface EditSource {
  ref: ObjectRef;
  primaryKeys: string[];
  autoIncrement: string[];
  quote: string;
  columnTypes: Record<string, string>;
}

/** A cell the user changed in an existing row. */
export interface CellEdit {
  rowIndex: number;
  column: string;
  value: unknown;
}

// Base type names that must travel as numbers, not quoted strings. The set is
// matched on the first token of the column type so `bigint(20) unsigned` and
// `double precision` resolve correctly while `interval` does not.
const NUMERIC_TYPES = new Set([
  "tinyint",
  "smallint",
  "mediumint",
  "int",
  "integer",
  "bigint",
  "serial",
  "bigserial",
  "smallserial",
  "decimal",
  "numeric",
  "dec",
  "fixed",
  "float",
  "double",
  "real",
  "money",
  "smallmoney",
  "bit",
]);

/** Coerce a grid string into the value type the column expects. */
export function coerce(value: string | null, dataType?: string): unknown {
  if (value === null || value === undefined) return null;
  const base = (dataType ?? "").toLowerCase().split(/[\s(]/)[0];
  if (NUMERIC_TYPES.has(base)) {
    if (value.trim() === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (base === "bool" || base === "boolean") {
    if (/^(true|t|1)$/i.test(value)) return true;
    if (/^(false|f|0)$/i.test(value)) return false;
  }
  return value;
}

function keyFor(source: EditSource, columns: string[], row: unknown[]): RowValue[] | null {
  const key: RowValue[] = [];
  for (const name of source.primaryKeys) {
    const index = columns.indexOf(name);
    // A key column missing from the result undermines the WHERE clause, so the
    // caller must skip (and refuse) this row rather than guess.
    if (index < 0) return null;
    key.push({ column: name, value: row[index] ?? null });
  }
  return key.length > 0 ? key : null;
}

/**
 * Turn the grid's pending state into backend requests. Pure and side-effect
 * free so the mapping from UI state to SQL-bound values is easy to reason
 * about: updates and deletes carry a primary-key `key`, inserts carry only the
 * columns the user filled in.
 */
export function buildRowChanges(args: {
  source: EditSource;
  columns: string[];
  rows: unknown[][];
  edits: CellEdit[];
  selected: number[];
  inserts: Record<string, unknown>[];
}): RowChangeRequest[] {
  const { source, columns, rows, edits, selected, inserts } = args;
  const base = {
    connectionId: source.ref.sessionId,
    database: source.ref.database,
    namespace: source.ref.namespace,
    object: source.ref.object,
  };

  // Group cell edits by the row they belong to.
  const byRow = new Map<number, RowValue[]>();
  for (const edit of edits) {
    const list = byRow.get(edit.rowIndex) ?? [];
    list.push({
      column: edit.column,
      value: coerce(edit.value as string | null, source.columnTypes[edit.column]),
    });
    byRow.set(edit.rowIndex, list);
  }

  const changes: RowChangeRequest[] = [];
  for (const [rowIndex, values] of byRow) {
    const row = rows[rowIndex];
    if (!row) continue;
    const key = keyFor(source, columns, row);
    if (!key) continue;
    changes.push({ ...base, kind: "update", key, values });
  }

  for (const rowIndex of selected) {
    const row = rows[rowIndex];
    if (!row) continue;
    const key = keyFor(source, columns, row);
    if (!key) continue;
    changes.push({ ...base, kind: "delete", key, values: [] });
  }

  for (const draft of inserts) {
    const values: RowValue[] = [];
    for (const [column, value] of Object.entries(draft)) {
      if (value === undefined) continue;
      // Leave auto-increment keys for the server to assign when left blank.
      if (source.autoIncrement.includes(column) && (value === null || value === "")) continue;
      values.push({
        column,
        value: coerce((value ?? null) as string | null, source.columnTypes[column]),
      });
    }
    if (values.length === 0) continue;
    changes.push({ ...base, kind: "insert", key: [], values });
  }

  return changes;
}
