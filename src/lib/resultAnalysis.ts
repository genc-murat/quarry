import type { StatementResult } from "@/lib/types";

export const MAX_RESULT_CELLS = 250_000;
export const MAX_RESULT_SNAPSHOTS = 8;
export const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;

export interface ResultSource {
  title: string;
  connection: string | null;
  database: string | null;
  completedAt: number;
  preview: { limit: number; offset: number } | null;
}

export interface ResultSample {
  result: StatementResult;
  source: ResultSource | null;
}

export interface ResultSnapshot extends ResultSample {
  id: string;
  name: string;
  bytes: number;
}

export function canAnalyze(result: StatementResult) {
  return Math.max(1, result.rows.length) * result.columns.length <= MAX_RESULT_CELLS;
}

/** Measure one row at a time so an oversized result does not build a second copy. */
export function measureSnapshot(sample: ResultSample, budget: number) {
  const { rows, ...statement } = sample.result;
  const encoder = new TextEncoder();
  let bytes = encoder.encode(JSON.stringify({ statement, source: sample.source })).length;
  for (const row of rows) {
    if (bytes > budget) break;
    bytes += encoder.encode(JSON.stringify(row)).length + 1;
  }
  return bytes;
}

/** IPC cells are JSON values. Preserve their types and ignore JSON object property order. */
function valueKey(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  return JSON.stringify(value ?? null, (_, nested: unknown) => {
    if (nested === null || typeof nested !== "object" || Array.isArray(nested)) return nested;
    const object = nested as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((name) => [name, object[name]]));
  });
}

export interface ColumnProfile {
  nulls: number;
  blanks: number;
  distinct: number;
  repeats: number;
}

const isBlank = (value: unknown) => typeof value === "string" && value.trim() === "";

export function profileResult(result: StatementResult): ColumnProfile[] {
  return result.columns.map((_, index) => {
    const counts = new Map<string, number>();
    let nulls = 0;
    let blanks = 0;
    let repeats = 0;
    for (const row of result.rows) {
      const value = row[index];
      if (value == null) {
        nulls += 1;
      } else {
        if (isBlank(value)) blanks += 1;
        const key = valueKey(value);
        const count = counts.get(key) ?? 0;
        if (count === 1) repeats += 2;
        else if (count > 1) repeats += 1;
        counts.set(key, count + 1);
      }
    }
    return { nulls, blanks, distinct: counts.size, repeats };
  });
}

export type ProfileFilter = "nulls" | "blanks" | "repeats";

export function profileRows(result: StatementResult, column: number, filter: ProfileFilter) {
  const counts = new Map<string, number>();
  if (filter === "repeats") {
    for (const row of result.rows) {
      if (row[column] == null) continue;
      const key = valueKey(row[column]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return result.rows.flatMap((row, index) => {
    const value = row[column];
    const matches = filter === "nulls"
      ? value == null
      : filter === "blanks"
        ? isBlank(value)
        : (counts.get(valueKey(value)) ?? 0) > 1;
    return matches ? [{ row: index + 1, value }] : [];
  });
}

export function alignResultColumns(before: StatementResult, after: StatementResult) {
  const beforeNames = new Set(before.columns.map(({ name }) => name));
  const afterIndexes = new Map(after.columns.map(({ name }, index) => [name, index]));
  const ambiguous = beforeNames.size !== before.columns.length || afterIndexes.size !== after.columns.length;
  const beforeUnknown = before.columns.length === 0 && before.rows.length === 0;
  const afterUnknown = after.columns.length === 0 && after.rows.length === 0;
  const inferred = beforeUnknown || afterUnknown;
  const shared = before.columns.flatMap(({ name }, index) => {
    const afterIndex = afterIndexes.get(name);
    return afterIndex === undefined ? [] : [{ name, before: index, after: afterIndex }];
  });
  return {
    ambiguous,
    inferred,
    shared: inferred
      ? (beforeUnknown ? after : before).columns.map(({ name }, index) => ({ name, before: index, after: index }))
      : shared,
    onlyBefore: inferred ? [] : before.columns.filter(({ name }) => !afterIndexes.has(name)).map(({ name }) => name),
    onlyAfter: inferred ? [] : after.columns.filter(({ name }) => !beforeNames.has(name)).map(({ name }) => name),
  };
}

export type RowDifference =
  | { kind: "added"; after: unknown[] }
  | { kind: "removed"; before: unknown[] }
  | { kind: "changed"; before: unknown[]; after: unknown[]; fields: string[] };

interface ResultDiff {
  differences: RowDifference[];
  counts: Record<RowDifference["kind"], number>;
  matching: number;
}

export function compareResults(
  before: StatementResult,
  after: StatementResult,
  alignment: ReturnType<typeof alignResultColumns>,
  keyNames: readonly string[],
): ResultDiff | { error: string } {
  const { ambiguous, shared } = alignment;
  const counts = { added: 0, removed: 0, changed: 0 };
  if (ambiguous) return { error: "Use unique column aliases in both queries to compare these results." };
  if (alignment.inferred && before.rows.length === 0 && after.rows.length === 0) {
    return { differences: [], counts, matching: 0 };
  }
  if (!shared.length) return { error: "The results need at least one column with the same name." };

  const keys = keyNames.length ? shared.filter(({ name }) => keyNames.includes(name)) : shared;
  const keyed = keyNames.length > 0;
  if (keyed && keys.length !== keyNames.length) return { error: "Choose key columns shared by both results." };
  const project = (row: unknown[], columns: typeof shared, side: "before" | "after") =>
    columns.map((column) => row[column[side]] ?? null);
  const keyError = (side: "Before" | "After", issue: string) => ({
    error: `${side} contains ${issue} keys. Choose columns whose combined values are unique and non-NULL on both sides.`,
  });

  const beforeGroups = new Map<string, unknown[][]>();
  for (const row of before.rows) {
    const values = project(row, keys, "before");
    if (keyed && values.includes(null)) return keyError("Before", "NULL");
    const key = valueKey(values);
    const group = beforeGroups.get(key);
    if (!group) beforeGroups.set(key, [row]);
    else if (keyed) return keyError("Before", "duplicate");
    else group.push(row);
  }

  const differences: RowDifference[] = [];
  let matching = 0;
  const seenAfter = new Set<string>();
  for (const row of after.rows) {
    const values = project(row, keys, "after");
    if (keyed && values.includes(null)) return keyError("After", "NULL");
    const key = valueKey(values);
    if (keyed) {
      if (seenAfter.has(key)) return keyError("After", "duplicate");
      seenAfter.add(key);
    }
    const group = beforeGroups.get(key);
    const previous = group?.pop();
    if (group?.length === 0) beforeGroups.delete(key);
    if (!previous) {
      counts.added += 1;
      differences.push({ kind: "added", after: row });
      continue;
    }

    const fields = keyed
      ? shared.filter((column) => valueKey(previous[column.before]) !== valueKey(row[column.after]))
        .map(({ name }) => name)
      : [];
    if (fields.length) {
      counts.changed += 1;
      differences.push({ kind: "changed", before: previous, after: row, fields });
    } else {
      matching += 1;
    }
  }

  for (const group of beforeGroups.values()) {
    for (const row of group) {
      counts.removed += 1;
      differences.push({ kind: "removed", before: row });
    }
  }
  return { differences, counts, matching };
}
