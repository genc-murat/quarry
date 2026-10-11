import type { SectionAction, SectionCell, SectionColumn, SectionTone } from "./types";

/** Rendered wherever a driver supplied no value. */
export const EMPTY_CELL = "—";

const TONES: SectionTone[] = ["neutral", "success", "warning", "danger"];

/**
 * Section cells are plain JSON values, except when the driver needs a value to
 * carry its own accent (a mutation still running, a failed one). Those arrive as
 * `{ text, tone }`, which every renderer unwraps through these helpers.
 */
export function cellValue(cell: SectionCell): unknown {
  if (cell && typeof cell === "object" && !Array.isArray(cell) && "text" in cell) {
    return (cell as { text: unknown }).text;
  }
  return cell;
}

/** The accent for a cell: its own when it is rich, otherwise the column's. */
export function cellTone(column: SectionColumn, cell: SectionCell): SectionTone {
  if (cell && typeof cell === "object" && !Array.isArray(cell)) {
    const tone = (cell as { tone?: unknown }).tone;
    if (TONES.includes(tone as SectionTone)) return tone as SectionTone;
  }
  return column.tone;
}

/** Format one cell using the column's declared format. */
export function formatCell(column: SectionColumn, cell: SectionCell): string {
  const value = cellValue(cell);
  if (value == null || value === "") return EMPTY_CELL;
  if (column.format === "bytes" && typeof value === "number") return formatBytes(value);
  if (column.format === "number") {
    const numeric = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(numeric)) return formatNumber(numeric);
  }
  return String(value);
}

/** A formatted value plus its unit, e.g. `18 ms`. */
export function cellText(column: SectionColumn, cell: SectionCell): string {
  const value = formatCell(column, cell);
  if (value === EMPTY_CELL || !column.unit) return value;
  return `${value} ${column.unit}`;
}

/** A log chip: the column label followed by the value and its unit. */
export function chipText(column: SectionColumn, cell: SectionCell): string {
  const value = cellText(column, cell);
  return value === EMPTY_CELL ? `${column.label} ${EMPTY_CELL}` : `${column.label} ${value}`;
}

/** The value a row-scoped action forwards, or `null` when this row has none. */
export function actionParam(
  action: SectionAction,
  row: Record<string, SectionCell>,
): string | null {
  if (!action.param) return null;
  const value = cellValue(row[action.param]);
  if (value == null) return null;
  const text = typeof value === "string" ? value : String(value);
  return text.trim() === "" ? null : text;
}

/**
 * Confirmation copy for an action. Building it here keeps one dialog for every
 * driver: the section supplies labels and wording, this supplies the shape.
 */
export function actionConfirm(action: SectionAction, param?: string | null) {
  const label = action.confirmLabel ?? action.label;
  return {
    title: param ? `${label} ${param}?` : `${label}?`,
    description: action.description ?? undefined,
    confirmLabel: label,
    destructive: action.danger,
    requireText: action.requireParam && param ? param : undefined,
  };
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let amount = value;
  let unit = -1;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[unit]}`;
}
