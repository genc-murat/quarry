import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { qualifiedName, quoteIdentifier, type ObjectRef, type SqlDialect } from "@/lib/objects";
import type { IndexDefinition, IndexKind, ObjectDetail } from "@/lib/types";

interface Props {
  open: boolean;
  onClose: () => void;
  objectRef: ObjectRef;
  detail: ObjectDetail;
  dialect: SqlDialect;
  busy?: boolean;
  onRun: (index: IndexDefinition) => void;
}

export function IndexDialog({ open, onClose, objectRef, detail, dialect, busy, onRun }: Props) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [unique, setUnique] = useState(false);
  const [kind, setKind] = useState<IndexKind>("btree");

  useEffect(() => {
    if (open) {
      setName("");
      setSelected([]);
      setUnique(false);
      setKind("btree");
    }
  }, [open]);

  const columns = detail.schema.columns;
  const quote = detail.identifierQuote || '"';

  const defaultName = useMemo(() => {
    const base = `idx_${objectRef.object}_${selected.join("_")}`;
    return base.replace(/[^A-Za-z0-9_]/g, "");
  }, [objectRef.object, selected]);

  function toggle(column: string) {
    setSelected((current) =>
      current.includes(column) ? current.filter((c) => c !== column) : [...current, column],
    );
  }

  function move(column: string, delta: number) {
    setSelected((current) => {
      const index = current.indexOf(column);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  const table = qualifiedName(objectRef, quote);
  const columnList = selected.map((column) => quoteIdentifier(column, quote)).join(", ");
  const keyword = kind === "fullText" ? "FULLTEXT INDEX" : unique ? "UNIQUE INDEX" : "INDEX";
  const preview = `CREATE ${keyword} ${quoteIdentifier(name.trim() || defaultName, quote)} ON ${table} (${columnList || "…"});`;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Create index on ${objectRef.object}`}
      description={
        dialect === "sqlite"
          ? "Pick the columns in index order. SQLite supports B-tree indexes only."
          : "Pick the columns in index order. PostgreSQL may reorder per its own rules."
      }
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={selected.length === 0 || busy}
            onClick={() =>
              onRun({
                name: name.trim() || null,
                columns: selected,
                unique,
                kind,
                prefixLengths: [],
              })
            }
          >
            {busy ? "Running…" : "Create index"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Label className="mb-2 block">Index name</Label>
          <Input
            value={name}
            placeholder={defaultName || "idx_..."}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div>
          <Label className="mb-2 block">Columns</Label>
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border p-2">
            {columns.map((column) => (
              <Checkbox
                key={column.name}
                label={`${column.name} · ${column.dataType}`}
                checked={selected.includes(column.name)}
                onChange={() => toggle(column.name)}
              />
            ))}
          </div>
        </div>

        {selected.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {selected.map((column, index) => (
              <span
                key={column}
                className="flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px]"
              >
                <span className="text-muted-foreground/70">{index + 1}.</span>
                {column}
                <button
                  onClick={() => move(column, -1)}
                  className="text-muted-foreground hover:text-foreground"
                  title="Move up"
                >
                  <ChevronUp className="h-3 w-3" />
                </button>
                <button
                  onClick={() => move(column, 1)}
                  className="text-muted-foreground hover:text-foreground"
                  title="Move down"
                >
                  <ChevronDown className="h-3 w-3" />
                </button>
                <button
                  onClick={() => toggle(column)}
                  className="text-muted-foreground hover:text-destructive"
                  title="Remove"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="flex items-center gap-4">
          <Checkbox label="Unique" checked={unique} onChange={(e) => setUnique(e.target.checked)} />
          <div className="flex items-center gap-2">
            <Label htmlFor="index-kind">Type</Label>
            <Select
              id="index-kind"
              className="h-8 w-28 text-xs"
              value={kind}
              onChange={(event) => setKind(event.target.value as IndexKind)}
            >
              <option value="btree">BTREE</option>
              {dialect === "sqlite" ? null : <option value="hash">HASH</option>}
              {dialect === "sqlite" ? null : <option value="fullText">FULLTEXT</option>}
            </Select>
          </div>
        </div>

        <div>
          <Label className="mb-2 block">SQL preview</Label>
          <pre className="max-h-32 overflow-auto rounded-md border border-border bg-surface px-3 py-2 font-mono text-[11px] text-muted-foreground">
            {preview}
          </pre>
        </div>
      </div>
    </Dialog>
  );
}
