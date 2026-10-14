import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Copy,
  Download,
  Inbox,
  Pencil,
  Plus,
  Rows3,
  Save,
  Trash2,
  Undo2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { StatementRepairHint } from "@/components/query/StatementRepairHint";
import type { FailureRepair } from "@/lib/statementRepair";
import { ContextMenu, type MenuEntry } from "@/components/ui/context-menu";
import { downloadText, serializeExport } from "@/lib/objects";
import { buildRowChanges, type CellEdit, type EditSource } from "@/lib/rowEdit";
import type { QueryResponse, RowChangeRequest, StatementResult } from "@/lib/types";
import { cn, formatDuration } from "@/lib/utils";
import { useWorkspace } from "@/stores/workspace";

const COLUMN_WIDTH = 190;
const SELECT_COLUMN = 34;
/** Row heights keyed by the `appearance.density` setting. */
const ROW_HEIGHTS = { comfortable: 30, compact: 24 } as const;

/** Serialize one result row in the configured copy format. */
function serializeRow(row: unknown[], format: string): string {
  const cell = (value: unknown): string =>
    value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  if (format === "json") return JSON.stringify(row.map((value) => value ?? null));
  if (format === "csv") return row.map((value) => `"${cell(value).replace(/"/g, '""')}"`).join(",");
  return row.map(cell).join("\t");
}

interface Props {
  result: QueryResponse | null;
  error: string | null;
  running: boolean;
  cancelled: boolean;
  /** Present when this result can be edited row by row (table previews). */
  editSource?: EditSource | null;
  onSaveChanges?: (changes: RowChangeRequest[]) => Promise<boolean>;
  /** Pagination window for a table preview. */
  preview?: { limit: number; offset: number } | null;
  onPage?: (offset: number) => void;
  /**
   * What the local model suggested for a statement that failed — and how to act
   * on it, when the statement can still be put right in the editor. A lookup rather
   * than a value because the grid, not the workspace, knows which statement of a
   * multi-statement run is on screen, and the suggestion belongs to exactly the
   * statement and error it was asked about.
   */
  repairFor?: (statement: string, error: string) => FailureRepair | null;
}

export function ResultsGrid({
  result,
  error,
  running,
  cancelled,
  editSource = null,
  onSaveChanges,
  preview = null,
  onPage,
  repairFor,
}: Props) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [cellMenu, setCellMenu] = useState<{ x: number; y: number; row: unknown[]; value: unknown } | null>(
    null,
  );

  // Row-editing state: pending cell edits keyed `rowIndex:colIndex`, delete
  // selections, and drafted new rows keyed by column name.
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [selected, setSelected] = useState<number[]>([]);
  const [inserts, setInserts] = useState<Record<string, unknown>[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Behaviour is driven entirely by settings; this component never hard-codes
  // row height, null rendering or confirmation policy.
  const density = useWorkspace((s) => s.settings.appearance.density);
  const rowStripes = useWorkspace((s) => s.settings.appearance.rowStripes);
  const nullDisplay = useWorkspace((s) => s.settings.results.nullDisplay);
  const showColumnTypes = useWorkspace((s) => s.settings.results.showColumnTypes);
  const copyFormat = useWorkspace((s) => s.settings.results.copyFormat);
  const confirmRowDelete = useWorkspace((s) => s.settings.safety.confirmRowDelete);
  const warnUnsavedEdits = useWorkspace((s) => s.settings.safety.warnUnsavedEdits);
  const rowHeight = ROW_HEIGHTS[density];

  // Each new run should start on its first statement, otherwise the selection
  // from the previous run silently carries over.
  useEffect(() => setActiveIndex(0), [result]);
  // Drop any pending edits when the result itself changes (e.g. after a save).
  useEffect(() => {
    setEdits({});
    setSelected([]);
    setInserts([]);
    setEditing(false);
  }, [result]);

  const statements = result?.results ?? [];
  const statement: StatementResult | null =
    statements.length > 0 ? (statements[Math.min(activeIndex, statements.length - 1)] ?? null) : null;

  // The failure the banner is about, and what the workspace has to say about it:
  // the suggestion, and whether the statement can still be put right. Both come
  // from the workspace, which is the only thing that knows what the editor holds.
  const failure =
    statement && statement.error
      ? { statement: statement.statement, error: statement.error }
      : null;
  const repair = failure ? (repairFor?.(failure.statement, failure.error) ?? null) : null;

  const columnNames = useMemo(() => statement?.columns.map((column) => column.name) ?? [], [statement]);
  const source = editSource;
  const keyPresent =
    source != null &&
    source.primaryKeys.length > 0 &&
    source.primaryKeys.every((pk) => columnNames.includes(pk));
  const canEdit =
    Boolean(source) &&
    keyPresent &&
    statements.length === 1 &&
    Boolean(statement?.isQuery) &&
    !statement?.error;
  const editReason = !source
    ? "Not a table preview"
    : source.primaryKeys.length === 0
      ? "Table has no primary key"
      : !keyPresent
        ? "Primary key missing from result"
        : statements.length > 1
          ? "Single-statement results only"
          : "Only SELECT results are editable";

  const pendingCount = Object.keys(edits).length + selected.length + inserts.length;

  function discard() {
    setEdits({});
    setSelected([]);
    setInserts([]);
  }

  function setCell(rowIndex: number, colIndex: number, raw: string) {
    const key = `${rowIndex}:${colIndex}`;
    const original = statement?.rows[rowIndex]?.[colIndex];
    const originalText = original === null || original === undefined ? "" : String(original);
    // Collapse back to "unchanged" when the typed value matches the original.
    const value = raw === originalText ? undefined : raw === "" ? null : raw;
    setEdits((current) => {
      const copy = { ...current };
      if (value === undefined) delete copy[key];
      else copy[key] = value;
      return copy;
    });
  }

  function toggleRow(rowIndex: number) {
    setSelected((current) =>
      current.includes(rowIndex) ? current.filter((index) => index !== rowIndex) : [...current, rowIndex],
    );
  }

  function setInsertValue(rowIndex: number, column: string, value: string) {
    setInserts((current) =>
      current.map((draft, index) =>
        index === rowIndex ? { ...draft, [column]: value === "" ? null : value } : draft,
      ),
    );
  }

  async function save() {
    if (!source || !statement || !onSaveChanges) return;
    const edits_: CellEdit[] = Object.entries(edits).map(([key, value]) => {
      const [rowIndex, colIndex] = key.split(":").map(Number);
      return { rowIndex, column: columnNames[colIndex], value };
    });
    const changes = buildRowChanges({
      source,
      columns: columnNames,
      rows: statement.rows,
      edits: edits_,
      selected,
      inserts,
    });
    if (changes.length === 0) {
      discard();
      return;
    }
    setSaving(true);
    const ok = await onSaveChanges(changes);
    setSaving(false);
    if (ok) {
      discard();
      setEditing(false);
    }
  }

  if (running) {
    return <Placeholder icon={<Rows3 className="h-5 w-5 animate-pulse" />} text="Running query…" />;
  }

  if (cancelled) {
    return (
      <Placeholder icon={<Ban className="h-5 w-5 text-muted-foreground" />} text="Query cancelled" />
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-start gap-3 overflow-auto p-4">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <pre className="whitespace-pre-wrap font-mono text-xs text-destructive">{error}</pre>
      </div>
    );
  }

  if (!result) {
    return <Placeholder icon={<Inbox className="h-5 w-5" />} text="Run a query to see results" />;
  }

  if (statements.length === 0) {
    return <Placeholder icon={<Inbox className="h-5 w-5" />} text="No statements executed" />;
  }

  const exportRows = (format: "csv" | "json") => {
    if (!statement) return;
    const names = statement.columns.map((column) => column.name);
    const text = serializeExport(
      format,
      names,
      statement.rows,
      { database: "", namespace: null, object: "result" },
      '"',
      true,
    );
    downloadText(`result.${format}`, text);
  };

  const cellEntries: MenuEntry[] = cellMenu
    ? [
        {
          label: "Copy value",
          icon: <Copy className="h-3.5 w-3.5" />,
          onSelect: () =>
            void navigator.clipboard.writeText(
              cellMenu.value === null || cellMenu.value === undefined
                ? "NULL"
                : typeof cellMenu.value === "object"
                  ? JSON.stringify(cellMenu.value)
                  : String(cellMenu.value),
            ),
        },
        {
          label: `Copy row (${copyFormat.toUpperCase()})`,
          icon: <Copy className="h-3.5 w-3.5" />,
          onSelect: () => void navigator.clipboard.writeText(serializeRow(cellMenu.row, copyFormat)),
        },
      ]
    : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border bg-surface/60 px-2 py-1.5">
        {statements.length > 1 ? (
          <div className="flex items-center gap-1">
            {statements.map((s, index) => (
              <button
                key={index}
                onClick={() => setActiveIndex(index)}
                className={cn(
                  "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
                  index === activeIndex
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50",
                )}
              >
                #{index + 1}
                {s.error ? " ✕" : ""}
              </button>
            ))}
          </div>
        ) : null}

        {statement ? (
          <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
            {statement.error ? (
              <Badge variant="danger">
                <AlertTriangle className="h-3 w-3" />
                failed
              </Badge>
            ) : statement.isQuery ? (
              <Badge variant="muted">{statement.rowCount} rows</Badge>
            ) : (
              <Badge variant="success">
                <CheckCircle2 className="h-3 w-3" />
                {statement.affectedRows ?? 0} affected
              </Badge>
            )}
            {statement.lastInsertId ? (
              <Badge variant="muted">insert id {statement.lastInsertId}</Badge>
            ) : null}
            {statement.truncated ? <Badge variant="warning">truncated</Badge> : null}
            <span>{formatDuration(statement.executionMs)}</span>
            {statement.columns.length > 0 ? (
              <span className="flex items-center gap-0.5">
                <Button size="icon-sm" variant="ghost" title="Export CSV" onClick={() => exportRows("csv")}>
                  <Download className="h-3.5 w-3.5" />
                </Button>
                <Button size="icon-sm" variant="ghost" title="Export JSON" onClick={() => exportRows("json")}>
                  <Download className="h-3.5 w-3.5" />
                </Button>
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {source ? (
        <div className="flex items-center gap-2 border-b border-border bg-surface/40 px-2 py-1.5">
          {preview && onPage ? (
            <div className="flex items-center gap-1">
              <Button
                size="xs"
                variant="ghost"
                disabled={preview.offset === 0 || running}
                onClick={() => onPage(Math.max(0, preview.offset - preview.limit))}
              >
                Prev
              </Button>
              <span className="tabular-nums text-[11px] text-muted-foreground">
                {preview.offset + 1}–{preview.offset + (statement?.rows.length ?? 0)}
              </span>
              <Button
                size="xs"
                variant="ghost"
                disabled={(statement?.rows.length ?? 0) < preview.limit || running}
                onClick={() => onPage(preview.offset + preview.limit)}
              >
                Next
              </Button>
            </div>
          ) : null}
          {editing ? (
            <>
              <Button
                size="xs"
                variant="outline"
                onClick={() => setInserts((current) => [...current, {}])}
              >
                <Plus className="h-3 w-3" /> Add row
              </Button>
              <Button
                size="xs"
                variant="destructive"
                disabled={selected.length === 0 || saving}
                onClick={() => (confirmRowDelete ? setConfirmDelete(true) : void save())}
              >
                <Trash2 className="h-3 w-3" /> Delete{selected.length ? ` (${selected.length})` : ""}
              </Button>
              <Button
                size="xs"
                disabled={pendingCount === 0 || saving}
                onClick={() => void save()}
              >
                <Save className="h-3 w-3" />
                {saving ? "Saving…" : `Save${pendingCount ? ` (${pendingCount})` : ""}`}
              </Button>
              <Button size="xs" variant="ghost" disabled={pendingCount === 0 || saving} onClick={discard}>
                <Undo2 className="h-3 w-3" /> Discard
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  if (warnUnsavedEdits && pendingCount > 0) {
                    setConfirmDiscard(true);
                    return;
                  }
                  discard();
                  setEditing(false);
                }}
              >
                Done
              </Button>
            </>
          ) : (
            <Button
              size="xs"
              variant="outline"
              disabled={!canEdit}
              title={canEdit ? `Edit ${source.ref.object} rows` : editReason}
              onClick={() => setEditing(true)}
            >
              <Pencil className="h-3 w-3" /> Edit rows
            </Button>
          )}
          <span className="ml-auto text-[11px] text-muted-foreground">
            {canEdit
              ? source.primaryKeys.length > 0
                ? `key: ${source.primaryKeys.join(", ")}`
                : ""
              : editReason}
          </span>
        </div>
      ) : null}

      {failure ? (
        <div className="border-b border-border bg-destructive/5">
          <pre className="max-h-32 overflow-auto px-3 py-2 font-mono text-[11px] text-destructive">
            {failure.error}
          </pre>
          {/* Below the error, because the error is what happened and this is only
              what the model made of it — and the fix, when the statement in the
              editor is still the one that failed. */}
          <StatementRepairHint repair={repair?.repair ?? null} onFix={repair?.fix ?? null} />
        </div>
      ) : null}

      <ResultBody
        statement={statement}
        editing={editing}
        primaryKeys={editing && source ? source.primaryKeys : []}
        edits={edits}
        onCellChange={setCell}
        selected={selected}
        onToggleRow={toggleRow}
        inserts={inserts}
        onInsertChange={setInsertValue}
        onRemoveInsert={(index) =>
          setInserts((current) => current.filter((_, currentIndex) => currentIndex !== index))
        }
        onCellContextMenu={(event, row, value) => {
          event.preventDefault();
          setCellMenu({ x: event.clientX, y: event.clientY, row, value });
        }}
        rowHeight={rowHeight}
        rowStripes={rowStripes}
        nullDisplay={nullDisplay}
        showColumnTypes={showColumnTypes}
      />

      {cellMenu ? (
        <ContextMenu entries={cellEntries} x={cellMenu.x} y={cellMenu.y} onClose={() => setCellMenu(null)} />
      ) : null}

      <ConfirmDialog
        open={confirmDiscard}
        title="Discard unsaved changes?"
        description="Pending cell edits, drafted rows and selected deletions will be lost."
        confirmLabel="Discard"
        destructive
        onClose={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false);
          discard();
          setEditing(false);
        }}
      />

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${selected.length} row${selected.length === 1 ? "" : "s"}?`}
        description="The selected rows are removed from the table. This cannot be undone."
        confirmLabel="Delete"
        destructive
        busy={saving}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          void save();
        }}
      />
    </div>
  );
}

function ResultBody({
  statement,
  editing,
  primaryKeys,
  edits,
  onCellChange,
  selected,
  onToggleRow,
  inserts,
  onInsertChange,
  onRemoveInsert,
  onCellContextMenu,
  rowHeight,
  rowStripes,
  nullDisplay,
  showColumnTypes,
}: {
  statement: StatementResult | null;
  editing: boolean;
  primaryKeys: string[];
  edits: Record<string, unknown>;
  onCellChange: (rowIndex: number, colIndex: number, raw: string) => void;
  selected: number[];
  onToggleRow: (rowIndex: number) => void;
  inserts: Record<string, unknown>[];
  onInsertChange: (rowIndex: number, column: string, value: string) => void;
  onRemoveInsert: (rowIndex: number) => void;
  onCellContextMenu: (event: React.MouseEvent, row: unknown[], value: unknown) => void;
  rowHeight: number;
  rowStripes: boolean;
  nullDisplay: string;
  showColumnTypes: boolean;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const rows = statement?.rows ?? [];
  const columns = statement?.columns ?? [];

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  // A density change alters every row's height; re-measure so the list reflows.
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, rowHeight]);

  const totalWidth = useMemo(
    () => Math.max(columns.length * COLUMN_WIDTH + (editing ? SELECT_COLUMN : 0), 320),
    [columns.length, editing],
  );

  if (!statement || columns.length === 0) {
    const failed = Boolean(statement?.error);
    return (
      <Placeholder
        icon={
          failed ? (
            <AlertTriangle className="h-5 w-5 text-destructive" />
          ) : (
            <CheckCircle2 className="h-5 w-5 text-success" />
          )
        }
        text={
          !statement
            ? "No columns"
            : failed
              ? "Statement failed"
              : `Statement executed · ${statement.affectedRows ?? 0} rows affected`
        }
      />
    );
  }

  return (
    <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
      <div style={{ minWidth: totalWidth }}>
        <div className="sticky top-0 z-10 flex border-b border-border bg-surface">
          {editing ? <div className="shrink-0 border-r border-border/60" style={{ width: SELECT_COLUMN }} /> : null}
          {columns.map((column, index) => (
            <div
              key={`${column.name}-${index}`}
              className="flex shrink-0 flex-col justify-center border-r border-border/60 px-2 py-1.5"
              style={{ width: COLUMN_WIDTH }}
            >
              <span className="truncate text-mono-size font-semibold">
                {column.name}
                {editing && primaryKeys.includes(column.name) ? (
                  <span className="ml-1 text-[10px] font-normal text-primary">PK</span>
                ) : null}
              </span>
              {showColumnTypes && column.dataType ? (
                <span className="truncate text-[10px] font-normal text-muted-foreground/80">
                  {column.dataType.toLowerCase()}
                </span>
              ) : null}
            </div>
          ))}
        </div>

        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            const isSelected = selected.includes(virtualRow.index);
            const dirty = columns.some((_, columnIndex) => edits[`${virtualRow.index}:${columnIndex}`] !== undefined);
            return (
              <div
                key={virtualRow.key}
                className={cn(
                  "absolute left-0 flex w-full border-b border-border/40 font-mono-app text-mono-size",
                  rowStripes && virtualRow.index % 2 === 1 && "bg-surface/40",
                  dirty && "bg-primary/10",
                  isSelected && "bg-destructive/10",
                )}
                style={{ top: virtualRow.start, height: virtualRow.size }}
              >
                {editing ? (
                  <div
                    className="flex shrink-0 items-center justify-center border-r border-border/40"
                    style={{ width: SELECT_COLUMN }}
                  >
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-primary"
                      checked={isSelected}
                      onChange={() => onToggleRow(virtualRow.index)}
                    />
                  </div>
                ) : null}
                {columns.map((column, columnIndex) => (
                  <Cell
                    key={columnIndex}
                    value={row[columnIndex]}
                    width={COLUMN_WIDTH}
                    editing={editing}
                    readOnly={primaryKeys.includes(column.name)}
                    pending={edits[`${virtualRow.index}:${columnIndex}`]}
                    nullDisplay={nullDisplay}
                    onChange={(raw) => onCellChange(virtualRow.index, columnIndex, raw)}
                    onContextMenu={(event) => onCellContextMenu(event, row, row[columnIndex])}
                  />
                ))}
              </div>
            );
          })}
        </div>

        {editing && inserts.length > 0 ? (
          <div className="border-t border-border">
            {inserts.map((draft, insertIndex) => (
              <div key={insertIndex} className="flex border-b border-border/40 bg-success/10">
                <div
                  className="flex shrink-0 items-center justify-center border-r border-border/40"
                  style={{ width: SELECT_COLUMN }}
                >
                  <Button size="icon-sm" variant="ghost" title="Remove draft" onClick={() => onRemoveInsert(insertIndex)}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
                {columns.map((column) => (
                  <div
                    key={column.name}
                    className="shrink-0 border-r border-border/40 px-1"
                    style={{ width: COLUMN_WIDTH }}
                  >
                    <input
                      className="h-6 w-full rounded border border-border/60 bg-background px-1 font-mono-app text-mono-size outline-none focus:border-primary"
                      value={draft[column.name] === null || draft[column.name] === undefined ? "" : String(draft[column.name])}
                      placeholder={column.name}
                      onChange={(event) => onInsertChange(insertIndex, column.name, event.target.value)}
                    />
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Cell({
  value,
  width,
  editing,
  readOnly,
  pending,
  nullDisplay,
  onChange,
  onContextMenu,
}: {
  value: unknown;
  width: number;
  editing?: boolean;
  readOnly?: boolean;
  pending?: unknown;
  nullDisplay: string;
  onChange?: (raw: string) => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  const isNull = value === null || value === undefined;
  const display = isNull
    ? nullDisplay
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);

  if (editing && !readOnly) {
    const inputValue =
      pending === undefined
        ? isNull
          ? ""
          : display
        : pending === null
          ? ""
          : String(pending);
    return (
      <div className="flex shrink-0 items-center border-r border-border/40 px-1" style={{ width }}>
        <input
          className="h-6 w-full rounded border border-transparent bg-transparent px-1 font-mono-app text-mono-size outline-none focus:border-primary focus:bg-background"
          value={inputValue}
          placeholder="NULL"
          onContextMenu={onContextMenu}
          onChange={(event) => onChange?.(event.target.value)}
        />
      </div>
    );
  }

  const numeric = typeof value === "number";

  return (
    <div
      className={cn(
        "flex shrink-0 items-center overflow-hidden border-r border-border/40 px-2",
        isNull && "italic text-muted-foreground/60",
        numeric && "justify-end tabular-nums text-primary",
      )}
      style={{ width }}
      title={isNull ? "NULL" : display}
      onContextMenu={onContextMenu}
    >
      <span className="truncate">{display}</span>
    </div>
  );
}

function Placeholder({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
      {icon}
      <p className="text-xs">{text}</p>
    </div>
  );
}
