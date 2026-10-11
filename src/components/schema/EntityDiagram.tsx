import { useEffect, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { errorMessage, ipc } from "@/lib/ipc";
import type { ObjectRef } from "@/lib/objects";
import type { ObjectDetail, ObjectSchema } from "@/lib/types";
import { useWorkspace } from "@/stores/workspace";

interface Props { objectRef: ObjectRef; detail: ObjectDetail }

export function EntityDiagram({ objectRef, detail }: Props) {
  const [related, setRelated] = useState<ObjectSchema[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const openObjectTab = useWorkspace((state) => state.openObjectTab);
  const tables = [
    detail.schema,
    ...related.filter((table) => table.name !== detail.schema.name),
  ];
  const neighbors = [...new Set(
    detail.schema.foreignKeys
      .map((fk) => fk.referencedTable)
      .filter((table) => table !== detail.schema.name),
  )];

  useEffect(() => {
    let current = true;
    if (!neighbors.length) { setRelated([]); setLoading(false); setError(""); return () => { current = false; }; }
    setLoading(true); setError("");
    void Promise.all(neighbors.map((table) => ipc.describeObject(objectRef.sessionId, objectRef.database, objectRef.namespace, table)))
      .then((schemas) => { if (current) setRelated(schemas); })
      .catch((failure) => { if (current) setError(errorMessage(failure)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [objectRef.sessionId, objectRef.database, objectRef.namespace, detail.schema.name, neighbors.join("|")]);

  const width = Math.max(600, tables.length * 280);
  const height = Math.max(300, Math.max(...tables.map((table) => table.columns.length), 1) * 29 + 92);
  return <div className="h-full overflow-auto bg-background/50 p-4">
    <div className="mb-3 flex items-center gap-2 text-[11px] text-muted-foreground"><span className="rounded bg-primary/10 px-2 py-1 text-primary">{objectRef.database}</span><span>FKs shown from selected table → referenced tables</span>{loading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}</div>
    {error ? <p className="mb-3 text-xs text-destructive">Could not load related tables: {error}</p> : null}
    <div className="relative" style={{ width, height }}>
      <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-label="Foreign key relationships">
        {detail.schema.foreignKeys.map((fk, index) => {
          const sourceIndex = 0;
          const targetIndex = tables.findIndex((table) => table.name === fk.referencedTable);
          if (targetIndex < 0) return null;
          const sourceColumnIndex = Math.max(0, detail.schema.columns.findIndex((column) => column.name === fk.columns[0]));
          const targetColumnIndex = Math.max(0, tables[targetIndex].columns.findIndex((column) => column.name === fk.referencedColumns[0]));
          const x1 = sourceIndex * 280 + 240;
          const y1 = 62 + sourceColumnIndex * 29;
          const x2 = targetIndex * 280;
          const y2 = 62 + targetColumnIndex * 29;
          const middle = (x1 + x2) / 2;
          return <g key={`${fk.name}-${index}`}><path d={`M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}`} fill="none" stroke="var(--color-primary)" strokeOpacity=".7" strokeWidth="1.5" /><circle cx={x1} cy={y1} r="3" fill="var(--color-primary)" /><circle cx={x2} cy={y2} r="3" fill="var(--color-primary)" /><text x={middle} y={(y1 + y2) / 2 - 6} textAnchor="middle" className="fill-muted-foreground" fontSize="9">{fk.name}</text></g>;
        })}
      </svg>
      {tables.map((table, tableIndex) => {
        const ref: ObjectRef = { ...objectRef, object: table.name, objectKind: "table" };
        return <article key={table.name} className={`absolute w-60 overflow-hidden rounded-lg border ${tableIndex === 0 ? "border-primary shadow-md shadow-primary/10" : "border-border shadow-sm"} bg-card`} style={{ left: tableIndex * 280, top: 0 }}>
          <header className="flex items-center justify-between border-b border-border bg-surface/80 px-2.5 py-2"><div className="min-w-0"><p className="truncate text-xs font-semibold">{table.name}</p><p className="text-[9px] uppercase tracking-wide text-muted-foreground">{tableIndex === 0 ? "Selected table" : "Referenced table"}</p></div>{tableIndex > 0 ? <Button size="icon-sm" variant="ghost" title={`Inspect ${table.name}`} onClick={() => openObjectTab(ref)}><ExternalLink className="h-3 w-3" /></Button> : null}</header>
          <div>{table.columns.map((column) => {
            const fkIndex = tableIndex === 0 ? detail.schema.foreignKeys.findIndex((fk) => fk.columns.includes(column.name)) : detail.schema.foreignKeys.findIndex((fk) => fk.referencedTable === table.name && fk.referencedColumns.includes(column.name));
            return <div key={column.name} className="flex h-[29px] items-center gap-1.5 border-b border-border/40 px-2.5 last:border-0"><span className={`w-5 text-[9px] font-bold ${column.isPrimaryKey ? "text-warning" : fkIndex >= 0 ? "text-primary" : "text-transparent"}`}>{column.isPrimaryKey ? "PK" : fkIndex >= 0 ? "FK" : "·"}</span><span className="min-w-0 flex-1 truncate font-mono text-[10px]">{column.name}</span><span className="max-w-24 truncate text-[9px] text-muted-foreground">{column.dataType}{column.nullable ? "?" : ""}</span></div>;
          })}</div>
        </article>;
      })}
    </div>
    {!loading && detail.schema.foreignKeys.length === 0 ? <div className="mt-3 rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">No outgoing foreign keys from this table. Related tables are loaded through declared foreign keys.</div> : null}
  </div>;
}
