import { useEffect, useMemo, useRef, useState } from "react";
import { FileUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { Select } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage, ipc } from "@/lib/ipc";
import { MAX_IMPORT_BYTES, parseImport, type ImportFormat, type ParsedImport } from "@/lib/importData";
import type { ObjectRef, SqlDialect } from "@/lib/objects";
import type { ColumnSchema, ObjectDetail, RowChangeRequest } from "@/lib/types";
import { useWorkspace } from "@/stores/workspace";

interface Props {
  open: boolean;
  onClose: () => void;
  objectRef: ObjectRef;
  detail: ObjectDetail;
  dialect: SqlDialect;
}

export function ImportDialog({ open, onClose, objectRef, detail, dialect }: Props) {
  const pushToast = useWorkspace((state) => state.pushToast);
  const [format, setFormat] = useState<ImportFormat>("csv");
  const [text, setText] = useState("");
  const [header, setHeader] = useState(true);
  const [parsed, setParsed] = useState<ParsedImport | null>(null);
  const [parseError, setParseError] = useState("");
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setFormat("csv"); setText(""); setHeader(true); setParsed(null); setParseError(""); setMapping({}); setBusy(false); setConfirm(false);
  }, [open]);

  const mapped = useMemo(() => parsed?.columns.filter((source) => mapping[source]).length ?? 0, [parsed, mapping]);
  const canImport = Boolean(parsed && mapped > 0 && !busy);

  async function loadFile(file?: File) {
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) { setParseError("Import file exceeds the 10 MB limit"); return; }
    const nextFormat = /\.json$/i.test(file.name) ? "json" : "csv";
    setFormat(nextFormat);
    setText(await file.text());
    setParsed(null); setParseError(""); setMapping({});
  }

  function preview() {
    try {
      const result = parseImport(text, format, header);
      const initial: Record<string, string> = {};
      for (const source of result.columns) {
        const match = detail.schema.columns.find((column) => column.name.toLowerCase() === source.toLowerCase());
        if (match) initial[source] = match.name;
      }
      setParsed(result); setMapping(initial); setParseError(""); setConfirm(false);
    } catch (error) {
      setParsed(null); setParseError(errorMessage(error));
    }
  }

  const rowRequests = (): RowChangeRequest[] => {
    if (!parsed) return [];
    return parsed.rows.map((row): RowChangeRequest => {
      const values = parsed.columns.flatMap((source, index) => {
        const target = mapping[source];
        if (!target) return [];
        const column = detail.schema.columns.find((candidate) => candidate.name === target);
        if (column?.isAutoIncrement && (row[index] === null || row[index] === "")) return [];
        return [{ column: target, value: row[index] ?? null }];
      });
      return { connectionId: objectRef.sessionId, database: objectRef.database, namespace: objectRef.namespace, object: objectRef.object, kind: "insert", key: [], values };
    });
  };

  const importableCount = rowRequests().filter((request) => request.values.length > 0).length;
  const emptyRowCount = parsed ? parsed.rows.length - importableCount : 0;

  async function runImport() {
    const requests = rowRequests().filter((request) => request.values.length > 0);
    if (requests.length === 0) return;
    setBusy(true);
    try {
      // Execute in batches to keep IPC payloads bounded. Each row remains an
      // individually validated insert; a failed row halts subsequent batches.
      for (let start = 0; start < requests.length; start += 100) {
        const batch = requests.slice(start, start + 100);
        const response = await ipc.applyRowChanges(batch);
        const expected = Math.min(100, requests.length - start);
        const failure = response.results.find((result) => result.error)?.error;
        if (failure) throw new Error(`Import stopped after ${start} rows: ${failure}`);
        if (response.results.length !== expected) {
          throw new Error(`Import stopped after ${start} rows: expected ${expected} results, received ${response.results.length}`);
        }
        if (dialect === "clickhouse") {
          const inserted = response.results.reduce((sum, result) => sum + (result.affectedRows ?? 0), 0);
          if (inserted !== expected) {
            throw new Error(`ClickHouse import batch reported ${inserted} inserted rows; expected ${expected}`);
          }
        }
      }
      pushToast({ title: "Import complete", description: `${requests.length} rows inserted`, variant: "success" });
      onClose();
    } catch (error) {
      pushToast({ title: "Import failed", description: errorMessage(error), variant: "error" });
    } finally {
      setBusy(false); setConfirm(false);
    }
  }

  const formatTypes = (column: ColumnSchema) => `${column.name} · ${column.dataType}${column.isPrimaryKey ? " · PK" : ""}${column.isAutoIncrement ? " · generated" : ""}`;

  return <Dialog open={open} onClose={() => !busy && onClose()} title={`Import into ${objectRef.object}`} description="Preview and map columns before inserting. File size and row count are limited; imports are not transactional across batches." className="max-w-4xl" footer={<>
    <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
    {parsed && !confirm ? <Button size="sm" disabled={!canImport || importableCount === 0} onClick={() => setConfirm(true)}>Review {importableCount} inserts</Button> : null}
    {parsed && confirm ? <><Button variant="ghost" size="sm" onClick={() => setConfirm(false)} disabled={busy}>Back</Button><Button size="sm" variant="destructive" disabled={!canImport || importableCount === 0} onClick={() => void runImport()}>{busy ? "Importing…" : `Insert ${importableCount} rows`}</Button></> : null}
  </>}>
    <div className="space-y-3">
      {!confirm ? <>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}><FileUp className="h-3.5 w-3.5" />Choose CSV/JSON</Button>
          <input ref={fileInput} type="file" accept=".csv,.json,text/csv,application/json" className="hidden" onChange={(event) => void loadFile(event.target.files?.[0])} />
          <Select aria-label="Import format" className="h-8 w-28 text-xs" value={format} onChange={(event) => { setFormat(event.target.value as ImportFormat); setParsed(null); }}><option value="csv">CSV</option><option value="json">JSON</option></Select>
          {format === "csv" ? <Checkbox label="First row contains headers" checked={header} onChange={(event) => { setHeader(event.target.checked); setParsed(null); }} /> : null}
          <span className="ml-auto text-[10px] text-muted-foreground">10 MB · 10,000 rows max</span>
        </div>
        <Textarea aria-label="Import file contents" value={text} onChange={(event) => { setText(event.target.value); setParsed(null); }} placeholder={format === "csv" ? "id,name\n1,Ada" : '[{"id":1,"name":"Ada"}]'} className="min-h-32 resize-y" />
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={preview} disabled={!text.trim()}>Parse preview</Button>
          {parseError ? <span className="text-xs text-destructive">{parseError}</span> : null}
        </div>
        {parsed ? <>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"><span>Source ({parsed.columns.length}) → target mapping ({mapped})</span><span>Preview · {parsed.rows.length} rows</span></div>
          <div className="grid max-h-64 grid-cols-1 gap-3 overflow-auto md:grid-cols-2">
            <div className="space-y-1">{parsed.columns.map((source) => <div key={source} className="grid grid-cols-2 items-center gap-2 rounded border border-border px-2 py-1"><span className="truncate font-mono text-xs">{source}</span><Select aria-label={`Map ${source}`} className="h-7 text-[11px]" value={mapping[source] ?? ""} onChange={(event) => setMapping((current) => ({ ...current, [source]: event.target.value }))}><option value="">Skip column</option>{detail.schema.columns.map((column) => <option key={column.name} value={column.name}>{formatTypes(column)}</option>)}</Select></div>)}</div>
            <div className="overflow-auto rounded border border-border"><table className="w-full text-[10px]"><thead><tr>{parsed.columns.map((column) => <th key={column} className="sticky top-0 bg-surface px-2 py-1 text-left">{column}</th>)}</tr></thead><tbody>{parsed.rows.slice(0, 8).map((row, index) => <tr key={index} className="border-t border-border/50">{row.map((value, columnIndex) => <td key={columnIndex} className="max-w-36 truncate px-2 py-1 font-mono">{value === null ? "NULL" : typeof value === "object" ? JSON.stringify(value) : String(value)}</td>)}</tr>)}</tbody></table></div>
          </div>
        </> : null}
      </> : <div className="space-y-3"><div className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-xs"><p className="font-semibold">Confirm import</p><p className="mt-1 text-muted-foreground">This will attempt to insert {importableCount} rows into {objectRef.database}.{objectRef.object}. {emptyRowCount ? `${emptyRowCount} rows with no mapped values will be skipped. ` : ""}Unmapped source fields are skipped. Generated target columns not mapped are left to the database.</p></div><div className="max-h-48 overflow-auto rounded border border-border p-2"><pre className="whitespace-pre-wrap font-mono text-[10px]">{rowRequests().filter((request) => request.values.length > 0).slice(0, 12).map((request) => JSON.stringify(request.values)).join("\n")}{importableCount > 12 ? `\n… ${importableCount - 12} more rows` : ""}</pre></div>        <p className="text-[10px] text-muted-foreground">Dialect: {dialect}. Every row is validated against the table before it is sent, in batches of up to 100 rows.</p></div>}
    </div>
  </Dialog>;
}
