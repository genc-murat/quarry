import { useEffect, useMemo, useState } from "react";
import { Copy, GitCompareArrows, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage, ipc } from "@/lib/ipc";
import { compareSchemas, migrationDraft, type SchemaDiff } from "@/lib/schemaDiff";
import { dialectForDriver, quoteIdentifier } from "@/lib/objects";
import type { ObjectSchema, SessionInfo } from "@/lib/types";
import { useWorkspace } from "@/stores/workspace";

interface Snapshot { session: SessionInfo; database: string; tables: ObjectSchema[]; quote: string }

export function SchemaToolsPanel() {
  const sessions = useWorkspace((state) => state.sessions);
  const databasesBySession = useWorkspace((state) => state.databasesBySession);
  const activeSessionId = useWorkspace((state) => state.activeSessionId);
  const loadDatabases = useWorkspace((state) => state.loadDatabases);
  const newTab = useWorkspace((state) => state.newTab);
  const pushToast = useWorkspace((state) => state.pushToast);
  const [sourceSessionId, setSourceSessionId] = useState(activeSessionId ?? "");
  const [targetSessionId, setTargetSessionId] = useState(activeSessionId ?? "");
  const [sourceDatabase, setSourceDatabase] = useState("");
  const [targetDatabase, setTargetDatabase] = useState("");
  const [diff, setDiff] = useState<SchemaDiff | null>(null);
  const [sql, setSql] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (activeSessionId && !sourceSessionId) setSourceSessionId(activeSessionId); if (activeSessionId && !targetSessionId) setTargetSessionId(activeSessionId); }, [activeSessionId, sourceSessionId, targetSessionId]);
  useEffect(() => { if (sourceSessionId) void loadDatabases(sourceSessionId); }, [sourceSessionId, loadDatabases]);
  useEffect(() => { if (targetSessionId) void loadDatabases(targetSessionId); }, [targetSessionId, loadDatabases]);

  const sourceSession = sessions.find((session) => session.id === sourceSessionId);
  const targetSession = sessions.find((session) => session.id === targetSessionId);
  const sourceDatabases = sourceSessionId ? databasesBySession[sourceSessionId] ?? [] : [];
  const targetDatabases = targetSessionId ? databasesBySession[targetSessionId] ?? [] : [];

  async function loadSnapshot(sessionId: string, database: string): Promise<Snapshot> {
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session) throw new Error("Choose an open connection");
    const objects = await ipc.listObjects(sessionId, database);
    const tables = await Promise.all(objects.filter((object) => object.kind === "table").map((object) => ipc.describeObject(sessionId, database, object.schema ?? null, object.name)));
    return { session, database, tables, quote: session.driver === "mysql" ? "`" : '"' };
  }

  async function compare() {
    if (!sourceSessionId || !targetSessionId || !sourceDatabase || !targetDatabase) return;
    setBusy(true); setDiff(null); setSql("");
    try {
      const [source, target] = await Promise.all([loadSnapshot(sourceSessionId, sourceDatabase), loadSnapshot(targetSessionId, targetDatabase)]);
      const result = compareSchemas(source.tables, target.tables);
      setDiff(result);
      const quote = target.quote;
      const qualify = (table: string) => {
        const qualifier = target.session.driver === "postgres" ? "public" : target.database;
        return qualifier ? `${quoteIdentifier(qualifier, quote)}.${quoteIdentifier(table, quote)}` : quoteIdentifier(table, quote);
      };
      setSql(migrationDraft(result, quote, qualify, dialectForDriver(target.session.driver)));
    } catch (error) {
      pushToast({ title: "Schema comparison failed", description: errorMessage(error), variant: "error" });
    } finally { setBusy(false); }
  }

  async function copySql() {
    try { await navigator.clipboard.writeText(sql); pushToast({ title: "Migration SQL copied", variant: "success" }); }
    catch (error) { pushToast({ title: "Clipboard unavailable", description: errorMessage(error), variant: "error" }); }
  }
  const canCompare = Boolean(sourceSession && targetSession && sourceDatabase && targetDatabase);
  const changedTables = useMemo(() => new Set(diff?.changes.map((change) => change.table) ?? []), [diff]);
  const connectionOptions = (label: string, value: string, onChange: (value: string) => void) => <label className="block space-y-1"><span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span><select aria-label={label} className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs" value={value} onChange={(event) => onChange(event.target.value)}><option value="">Choose connection</option>{sessions.map((session) => <option key={session.id} value={session.id}>{session.name} · {session.driver}</option>)}</select></label>;
  const databaseOptions = (label: string, value: string, onChange: (value: string) => void, databases: { name: string }[]) => <label className="block space-y-1"><span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span><select aria-label={label} className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs" value={value} onChange={(event) => onChange(event.target.value)}><option value="">Choose database</option>{databases.map((database) => <option key={database.name} value={database.name}>{database.name}</option>)}</select></label>;

  return <div className="flex h-full flex-col">
    <header className="border-b border-border px-3 py-2.5"><h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Schema tools</h2><p className="mt-1 text-[11px] text-muted-foreground">Compare live schemas and draft additive migration SQL.</p></header>
    <div className="flex-1 space-y-3 overflow-y-auto p-3">
      <section className="space-y-2 rounded-lg border border-border bg-card p-2.5"><p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Source</p>{connectionOptions("Source connection", sourceSessionId, (value) => { setSourceSessionId(value); setSourceDatabase(""); })}{databaseOptions("Source database", sourceDatabase, setSourceDatabase, sourceDatabases)}</section>
      <section className="space-y-2 rounded-lg border border-border bg-card p-2.5"><p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Target</p>{connectionOptions("Target connection", targetSessionId, (value) => { setTargetSessionId(value); setTargetDatabase(""); })}{databaseOptions("Target database", targetDatabase, setTargetDatabase, targetDatabases)}</section>
      <Button className="w-full" size="sm" disabled={!canCompare || busy} onClick={() => void compare()}>{busy ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <GitCompareArrows className="h-3.5 w-3.5" />}{busy ? "Comparing…" : "Compare schemas"}</Button>
      {diff ? <><div className="flex items-center justify-between"><p className="text-xs font-semibold">{diff.changes.length} differences</p><span className="text-[10px] text-muted-foreground">{changedTables.size} tables</span></div><div className="space-y-1">{diff.changes.map((change, index) => <div key={`${change.kind}-${change.table}-${change.name}-${index}`} className="rounded border border-border bg-card px-2 py-1.5"><div className="flex items-center gap-1.5 text-[10px] font-medium"><span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">{change.kind}</span><span className="truncate">{change.table}.{change.name}</span></div><p className="mt-1 text-[10px] text-muted-foreground">{change.detail}</p></div>)}{diff.changes.length === 0 ? <p className="rounded border border-border p-2 text-xs text-muted-foreground">Schemas match.</p> : null}</div>
      {diff.changes.length ? <><div className="flex items-center justify-between"><p className="text-xs font-semibold">Migration draft</p><Button size="icon-sm" variant="ghost" title="Copy migration SQL" onClick={() => void copySql()}><Copy className="h-3.5 w-3.5" /></Button></div><Textarea aria-label="Migration SQL draft" className="min-h-48 resize-y" value={sql} onChange={(event) => setSql(event.target.value)} /><p className="text-[10px] text-warning">Review before running. Destructive, type, index and foreign-key changes are intentionally comments.</p><Button size="sm" variant="outline" onClick={() => newTab({ title: "Migration draft", sessionId: targetSessionId, database: targetDatabase, sql })}>Open in query editor</Button></> : null}</> : <div className="rounded-lg border border-dashed border-border p-4 text-center text-[11px] text-muted-foreground">Choose a source and target, then compare their tables.</div>}
    </div>
  </div>;
}
