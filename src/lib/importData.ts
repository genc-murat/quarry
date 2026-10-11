export type ImportFormat = "csv" | "json";

export interface ParsedImport {
  columns: string[];
  rows: unknown[][];
}

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 10_000;

function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      if (cell.length > 0) throw new Error("Unexpected quote in an unquoted CSV field");
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value !== "")) records.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error("CSV has an unterminated quoted field");
  row.push(cell);
  if (row.some((value) => value !== "")) records.push(row);
  return records;
}

/** Parse CSV with optional headers, or JSON as an array of plain objects. */
export function parseImport(text: string, format: ImportFormat, hasHeader = true): ParsedImport {
  if (new TextEncoder().encode(text).byteLength > MAX_IMPORT_BYTES) {
    throw new Error("Import file exceeds the 10 MB limit");
  }
  if (format === "csv") {
    const records = parseCsvRecords(text.replace(/^\uFEFF/, ""));
    if (records.length === 0) throw new Error("CSV file is empty");
    const columns = hasHeader
      ? records[0].map((name) => name.trim())
      : records[0].map((_, index) => `column_${index + 1}`);
    if (columns.some((name) => !name)) throw new Error("CSV headers cannot be empty");
    if (new Set(columns).size !== columns.length) throw new Error("CSV headers must be unique");
    const dataRows = hasHeader ? records.slice(1) : records;
    if (dataRows.length > MAX_IMPORT_ROWS) throw new Error(`Import exceeds ${MAX_IMPORT_ROWS} rows`);
    const rows = dataRows.map((record, index) => {
      if (record.length !== columns.length) {
        throw new Error(`CSV row ${index + (hasHeader ? 2 : 1)} has ${record.length} fields; expected ${columns.length}`);
      }
      return record.map((value) => value === "\\N" ? null : value);
    });
    return { columns, rows };
  }
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(value) || value.some((item) => item === null || typeof item !== "object" || Array.isArray(item))) {
    throw new Error("JSON import expects an array of objects");
  }
  if (value.length > MAX_IMPORT_ROWS) throw new Error(`Import exceeds ${MAX_IMPORT_ROWS} rows`);
  const columns = [...new Set(value.flatMap((item) => Object.keys(item)))];
  if (columns.length === 0) throw new Error("JSON objects do not contain any fields");
  const rows = value.map((item) => columns.map((column) => {
    const cell = (item as Record<string, unknown>)[column];
    return cell === undefined ? null : cell;
  }));
  return { columns, rows };
}
