import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Braces,
  CalendarClock,
  ChevronDown,
  Copy,
  Database as DatabaseIcon,
  Download,
  ExternalLink,
  FileCode2,
  Hash,
  KeyRound,
  Layers,
  ListTree,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Table2,
  Trash2,
  Zap,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ContextMenu, type MenuEntry } from "@/components/ui/context-menu";
import { Tabs } from "@/components/ui/tabs";
import { errorMessage, ipc } from "@/lib/ipc";
import { objectKey, type ObjectRef } from "@/lib/objects";
import type { ColumnSchema, ObjectAction, ObjectDetail, ObjectKind } from "@/lib/types";
import { useWorkspace } from "@/stores/workspace";

const KIND_ICON: Record<ObjectKind, typeof Table2> = {
  table: Table2,
  view: FileCode2,
  materializedView: Layers,
  collection: Layers,
  keySpace: KeyRound,
  function: FileCode2,
  procedure: Braces,
  trigger: Zap,
  event: CalendarClock,
  sequence: KeyRound,
  other: Table2,
};

export function ObjectInspector({ objectRef }: { objectRef: ObjectRef }) {
  const detail = useWorkspace((s) => s.objectCache[objectKey(objectRef)]) as ObjectDetail | undefined;
  const loadObjectDetail = useWorkspace((s) => s.loadObjectDetail);
  const newTab = useWorkspace((s) => s.newTab);
  const pushToast = useWorkspace((s) => s.pushToast);
  const openObjectDialog = useWorkspace((s) => s.openObjectDialog);
  const openObjectData = useWorkspace((s) => s.openObjectData);
  const openObjectTemplate = useWorkspace((s) => s.openObjectTemplate);

  const [tab, setTab] = useState("columns");
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [rowCount, setRowCount] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);

  const key = objectKey(objectRef);
  useEffect(() => {
    // This component instance is reused when the active object tab changes, so
    // the object-specific count must not leak from the previous table.
    setRowCount(null);
    void loadObjectDetail(objectRef);
  }, [key, loadObjectDetail]);

  const quote = detail?.identifierQuote || '"';
  const supports = (action: ObjectAction) => detail?.actions.includes(action) ?? false;
  const isTable = objectRef.objectKind === "table";

  async function countRows() {
    setCounting(true);
    try {
      // Counting is a full scan, so it waits for an explicit click instead of
      // running on every inspector open.
      const count = await ipc.countRows(
        objectRef.sessionId,
        objectRef.database,
        objectRef.namespace,
        objectRef.object,
      );
      setRowCount(count);
    } catch (error) {
      pushToast({ title: "Count failed", description: errorMessage(error), variant: "error" });
    } finally {
      setCounting(false);
    }
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      pushToast({ title: `${label} copied`, variant: "success" });
    } catch (error) {
      pushToast({ title: "Clipboard unavailable", description: errorMessage(error), variant: "error" });
    }
  }

  if (!detail) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <p className="text-xs">Loading {objectRef.object}…</p>
      </div>
    );
  }

  const Icon = KIND_ICON[objectRef.objectKind] ?? Table2;
  const maintenanceOptions: ("optimize" | "analyze" | "vacuum")[] =
    quote === "`" ? ["optimize", "analyze"] : ["vacuum", "analyze"];
  const menuEntries: MenuEntry[] = [
    { type: "label", label: "Table" },
    ...(supports("renameObject")
      ? [
          {
            label: "Rename…",
            icon: <Pencil className="h-3.5 w-3.5" />,
            onSelect: () => openObjectDialog({ ref: objectRef, kind: "rename" }),
          },
        ]
      : []),
    ...(supports("duplicateObject")
      ? [
          {
            label: "Duplicate…",
            icon: <Copy className="h-3.5 w-3.5" />,
            onSelect: () => openObjectDialog({ ref: objectRef, kind: "duplicate" }),
          },
        ]
      : []),
    ...(supports("maintenance")
      ? maintenanceOptions.map((maintenance) => ({
          label: `Maintenance: ${maintenance}`,
          icon: <ListTree className="h-3.5 w-3.5" />,
          onSelect: () => openObjectDialog({ ref: objectRef, kind: "maintenance", maintenance }),
        }))
      : []),
    ...(supports("reindex")
      ? [
          {
            label: "Reindex",
            icon: <RefreshCw className="h-3.5 w-3.5" />,
            onSelect: () => openObjectDialog({ ref: objectRef, kind: "reindex" }),
          },
        ]
      : []),
    { type: "separator" },
    { type: "label", label: "Danger" },
    ...(supports("truncate") && isTable
      ? [
          {
            label: "Truncate (delete all rows)",
            icon: <AlertTriangle className="h-3.5 w-3.5" />,
            danger: true,
            onSelect: () => openObjectDialog({ ref: objectRef, kind: "truncate" }),
          },
        ]
      : []),
    ...(supports("dropObject")
      ? [
          {
            label: `Drop ${objectRef.objectKind}`,
            icon: <Trash2 className="h-3.5 w-3.5" />,
            danger: true,
            onSelect: () => openObjectDialog({ ref: objectRef, kind: "drop" }),
          },
        ]
      : []),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border bg-surface/60 px-3 py-2">
        <Icon className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold">{objectRef.object}</span>
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <DatabaseIcon className="h-3 w-3" />
          {objectRef.database}
          {objectRef.namespace && objectRef.namespace !== objectRef.database
            ? `.${objectRef.namespace}`
            : ""}
        </span>
        <Badge variant="muted">{objectRef.objectKind}</Badge>
        {rowCount != null ? <Badge variant="muted">{rowCount} rows</Badge> : null}

        <div className="ml-auto flex items-center gap-1">
          <Button size="xs" variant="outline" disabled={counting} onClick={() => void countRows()}>
            {counting ? "Counting…" : "Count rows"}
          </Button>
          <Button size="xs" variant="outline" onClick={() => void loadObjectDetail(objectRef, true)}>
            <RefreshCw className="h-3 w-3" /> Refresh
          </Button>
          <Button size="xs" variant="outline" onClick={() => void openObjectData(objectRef)}>
            <ExternalLink className="h-3 w-3" /> View data
          </Button>
          <Button size="xs" variant="ghost" onClick={() => copy(detail.ddl, "DDL")}>
            <Copy className="h-3 w-3" /> DDL
          </Button>
          <Button size="xs" variant="ghost" onClick={(e) => setMenuAt({ x: e.clientX, y: e.clientY })}>
            More <ChevronDown className="h-3 w-3" />
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5">
        {supports("createIndex") ? (
          <Button size="xs" variant="ghost" onClick={() => openObjectDialog({ ref: objectRef, kind: "index" })}>
            <Plus className="h-3 w-3" /> Index
          </Button>
        ) : null}
        {supports("addColumn") ? (
          <Button size="xs" variant="ghost" onClick={() => openObjectDialog({ ref: objectRef, kind: "addColumn" })}>
            <Plus className="h-3 w-3" /> Column
          </Button>
        ) : null}
        <Button size="xs" variant="ghost" onClick={() => void openObjectTemplate(objectRef, "select")}>
          SELECT
        </Button>
        <Button size="xs" variant="ghost" onClick={() => void openObjectTemplate(objectRef, "insert")}>
          INSERT
        </Button>
        <Button size="xs" variant="ghost" onClick={() => void openObjectTemplate(objectRef, "update")}>
          UPDATE
        </Button>
        <Button size="xs" variant="ghost" onClick={() => void openObjectTemplate(objectRef, "delete")}>
          DELETE
        </Button>
        {supports("exportData") ? (
          <Button size="xs" variant="ghost" onClick={() => openObjectDialog({ ref: objectRef, kind: "export" })}>
            <Download className="h-3 w-3" /> Export
          </Button>
        ) : null}
      </div>

      <Tabs
        className="min-h-0 flex-1"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "columns", label: "Columns", hint: String(detail.schema.columns.length) },
          { id: "indexes", label: "Indexes", hint: String(detail.schema.indexes.length) },
          { id: "keys", label: "Foreign keys", hint: String(detail.schema.foreignKeys.length) },
          { id: "ddl", label: "DDL" },
        ]}
      >
        {tab === "columns" ? (
          <ColumnsTable
            columns={detail.schema.columns}
            onAlter={(column) => openObjectDialog({ ref: objectRef, kind: "alterColumn", column })}
            onDrop={(column) => openObjectDialog({ ref: objectRef, kind: "dropColumn", column })}
            canAlter={supports("alterColumn")}
            canDrop={supports("dropColumn")}
          />
        ) : null}
        {tab === "indexes" ? (
          <IndexesTable
            indexes={detail.schema.indexes}
            onDrop={(indexName) => openObjectDialog({ ref: objectRef, kind: "dropIndex", indexName })}
            canDrop={supports("dropIndex")}
          />
        ) : null}
        {tab === "keys" ? <KeysTable detail={detail} /> : null}
        {tab === "ddl" ? (
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-end border-b border-border px-3 py-1.5">
              <Button size="xs" variant="ghost" onClick={() => copy(detail.ddl, "DDL")}>
                <Copy className="h-3 w-3" /> Copy
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  newTab({
                    title: `${objectRef.object} ddl`,
                    sessionId: objectRef.sessionId,
                    database: objectRef.database,
                    sql: detail.ddl,
                  })
                }
              >
                Open in editor
              </Button>
            </div>
            <pre className="flex-1 overflow-auto px-3 py-2 font-mono text-[11px] text-foreground/90">
              {detail.ddl}
            </pre>
          </div>
        ) : null}
      </Tabs>

      {menuAt ? (
        <ContextMenu entries={menuEntries} x={menuAt.x} y={menuAt.y} onClose={() => setMenuAt(null)} />
      ) : null}
    </div>
  );
}

function ColumnsTable({
  columns,
  onAlter,
  onDrop,
  canAlter,
  canDrop,
}: {
  columns: ColumnSchema[];
  onAlter: (column: ColumnSchema) => void;
  onDrop: (column: ColumnSchema) => void;
  canAlter: boolean;
  canDrop: boolean;
}) {
  return (
    <table className="w-full border-collapse text-xs">
      <thead>
        <tr className="sticky top-0 bg-surface text-left text-[10px] uppercase tracking-wide text-muted-foreground">
          <th className="px-3 py-1.5">#</th>
          <th className="px-3 py-1.5">Name</th>
          <th className="px-3 py-1.5">Type</th>
          <th className="px-3 py-1.5">Null</th>
          <th className="px-3 py-1.5">Default</th>
          <th className="px-3 py-1.5">Key</th>
          <th className="px-3 py-1.5" />
        </tr>
      </thead>
      <tbody>
        {columns.map((column) => (
          <tr key={column.name} className="border-b border-border/40 hover:bg-accent/30">
            <td className="px-3 py-1 text-muted-foreground/60">{column.ordinal}</td>
            <td className="px-3 py-1 font-medium">{column.name}</td>
            <td className="px-3 py-1 font-mono text-muted-foreground">{column.dataType}</td>
            <td className="px-3 py-1 text-muted-foreground">{column.nullable ? "yes" : "no"}</td>
            <td className="px-3 py-1 font-mono text-muted-foreground">
              {column.defaultValue ?? "—"}
            </td>
            <td className="px-3 py-1">
              <span className="flex items-center gap-1">
                {column.isPrimaryKey ? <Badge variant="success">PK</Badge> : null}
                {column.isAutoIncrement ? (
                  <Badge variant="muted">
                    <Hash className="h-3 w-3" /> auto
                  </Badge>
                ) : null}
              </span>
            </td>
            <td className="px-3 py-1 text-right">
              <span className="inline-flex items-center gap-0.5">
                {canAlter ? (
                  <Button size="icon-sm" variant="ghost" title="Alter column" onClick={() => onAlter(column)}>
                    <Pencil className="h-3 w-3" />
                  </Button>
                ) : null}
                {canDrop ? (
                  <Button size="icon-sm" variant="ghost" title="Drop column" onClick={() => onDrop(column)}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                ) : null}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function IndexesTable({
  indexes,
  onDrop,
  canDrop,
}: {
  indexes: ObjectDetail["schema"]["indexes"];
  onDrop: (index: string) => void;
  canDrop: boolean;
}) {
  if (indexes.length === 0) {
    return <Placeholder text="No indexes on this object" />;
  }
  return (
    <table className="w-full border-collapse text-xs">
      <thead>
        <tr className="sticky top-0 bg-surface text-left text-[10px] uppercase tracking-wide text-muted-foreground">
          <th className="px-3 py-1.5">Name</th>
          <th className="px-3 py-1.5">Columns</th>
          <th className="px-3 py-1.5">Unique</th>
          <th className="px-3 py-1.5" />
        </tr>
      </thead>
      <tbody>
        {indexes.map((index) => (
          <tr key={index.name} className="border-b border-border/40 hover:bg-accent/30">
            <td className="px-3 py-1 font-medium">
              <span className="flex items-center gap-1.5">
                {index.primary ? <KeyRound className="h-3 w-3 text-primary" /> : null}
                {index.name}
              </span>
            </td>
            <td className="px-3 py-1 font-mono text-muted-foreground">{index.columns.join(", ")}</td>
            <td className="px-3 py-1 text-muted-foreground">{index.unique ? "yes" : "no"}</td>
            <td className="px-3 py-1 text-right">
              {canDrop && !index.primary ? (
                <Button size="icon-sm" variant="ghost" title="Drop index" onClick={() => onDrop(index.name)}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function KeysTable({ detail }: { detail: ObjectDetail }) {
  if (detail.schema.foreignKeys.length === 0) {
    return <Placeholder text="No foreign keys on this object" />;
  }
  return (
    <table className="w-full border-collapse text-xs">
      <thead>
        <tr className="sticky top-0 bg-surface text-left text-[10px] uppercase tracking-wide text-muted-foreground">
          <th className="px-3 py-1.5">Name</th>
          <th className="px-3 py-1.5">Columns</th>
          <th className="px-3 py-1.5">References</th>
        </tr>
      </thead>
      <tbody>
        {detail.schema.foreignKeys.map((fk) => (
          <tr key={fk.name} className="border-b border-border/40">
            <td className="px-3 py-1 font-medium">{fk.name}</td>
            <td className="px-3 py-1 font-mono text-muted-foreground">{fk.columns.join(", ")}</td>
            <td className="px-3 py-1 font-mono text-primary">
              {fk.referencedTable} ({fk.referencedColumns.join(", ")})
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">{text}</div>
  );
}
