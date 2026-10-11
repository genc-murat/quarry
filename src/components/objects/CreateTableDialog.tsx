import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { quoteIdentifier, type SqlDialect } from "@/lib/objects";
import type { ColumnDefinition, CreateTableRequest } from "@/lib/types";

interface ColumnDraft {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string;
  isPrimaryKey: boolean;
  isAutoIncrement: boolean;
  comment: string;
}

const COMMON_TYPES = [
  "bigint",
  "int",
  "smallint",
  "tinyint",
  "varchar(255)",
  "char(2)",
  "text",
  "decimal(12,2)",
  "double",
  "datetime",
  "timestamp",
  "date",
  "boolean",
  "json",
];

const CLICKHOUSE_TYPES = [
  "UInt64",
  "Int64",
  "UInt32",
  "Int32",
  "Float64",
  "Decimal(12, 2)",
  "String",
  "FixedString(16)",
  "Date",
  "DateTime",
  "Bool",
  "UUID",
  "Array(String)",
  "JSON",
];

/** Table engines the backend accepts. The engine is written into the SQL, so it must match. */
const CLICKHOUSE_ENGINES = [
  "MergeTree",
  "ReplacingMergeTree",
  "SummingMergeTree",
  "AggregatingMergeTree",
  "Log",
  "Memory",
];


function isMergeTree(engine: string): boolean {
  return engine.endsWith("MergeTree");
}

/** Sorting key the backend uses: the explicit ORDER BY, else the primary-key columns. */
function sortingKey(orderKeys: string[], columns: ColumnDraft[]): string[] {
  if (orderKeys.length > 0) return orderKeys;
  return columns.filter((column) => column.isPrimaryKey && column.name.trim()).map((column) => column.name.trim());
}

function hasNullableSortingKey(orderKeys: string[], columns: ColumnDraft[]): boolean {
  const keys = sortingKey(orderKeys, columns);
  return keys.some((key) => {
    const column = columns.find((candidate) => candidate.name.trim() === key);
    return !column || column.nullable || column.dataType.trim().startsWith("Nullable(");
  });
}

function emptyColumn(dialect: SqlDialect): ColumnDraft {
  return {
    name: "",
    dataType: dialect === "clickhouse" ? "String" : "varchar(255)",
    nullable: dialect !== "clickhouse",
    defaultValue: "",
    isPrimaryKey: false,
    isAutoIncrement: false,
    comment: "",
  };
}

/**
 * Mirror of the backend `ddl::create_clickhouse_table` renderer, used only for
 * the live preview. The authoritative SQL is generated in Rust from the request.
 */
function buildClickHousePreview(
  database: string,
  table: string,
  comment: string,
  columns: ColumnDraft[],
  quote: string,
  engine: string,
  orderKeys: string[],
  partitionBy: string,
  primaryKey: string,
  ttl: string,
  settings: string[],
): string {
  const lines = columns
    .filter((column) => column.name.trim())
    .map((column) => {
      const type = column.dataType.trim() || "String";
      const wrapped = column.nullable && !type.startsWith("Nullable(") ? `Nullable(${type})` : type;
      let sql = `${quoteIdentifier(column.name.trim(), quote)} ${wrapped}`;
      if (column.defaultValue.trim()) sql += ` DEFAULT ${column.defaultValue.trim()}`;
      if (column.comment.trim()) sql += ` COMMENT '${column.comment.trim().replace(/'/g, "''")}'`;
      return `  ${sql}`;
    });
  const name = quoteIdentifier(table.trim() || "…", quote);
  const qualified = database.trim() ? `${quoteIdentifier(database.trim(), quote)}.${name}` : name;
  let sql = `CREATE TABLE ${qualified} (\n${lines.join(",\n")}\n) ENGINE = ${engine}`;
  if (isMergeTree(engine)) {
    if (partitionBy.trim()) sql += ` PARTITION BY ${partitionBy.trim()}`;
    const key = sortingKey(orderKeys, columns);
    if (key.length > 0) sql += ` ORDER BY (${key.map((column) => quoteIdentifier(column, quote)).join(", ")})`;
    if (primaryKey.trim()) sql += ` PRIMARY KEY ${primaryKey.trim()}`;
    if (ttl.trim()) sql += ` TTL ${ttl.trim()}`;
    if (settings.length > 0) sql += ` SETTINGS ${settings.join(", ")}`;
  }
  if (comment.trim()) sql += ` COMMENT '${comment.trim().replace(/'/g, "''")}'`;
  return `${sql};`;
}

/**
 * Mirror of the backend `ddl::create_table_from_columns` renderer, used only for
 * the live preview. The authoritative SQL is generated in Rust from the request.
 */
function buildPreview(
  table: string,
  comment: string,
  columns: ColumnDraft[],
  quote: string,
  dialect: SqlDialect,
): string {
  const filled = columns.filter((column) => column.name.trim());
  const composite = filled.filter((column) => column.isPrimaryKey).length > 1;
  const lines = filled.map((column) => {
    // SQLite's only auto-assigning column is `INTEGER PRIMARY KEY AUTOINCREMENT`,
    // regardless of the declared type; mirror the backend renderer exactly.
    if (dialect === "sqlite" && column.isAutoIncrement) {
      return `  ${quoteIdentifier(column.name.trim(), quote)} INTEGER PRIMARY KEY AUTOINCREMENT`;
    }
    let sql = `${quoteIdentifier(column.name.trim(), quote)} ${column.dataType.trim() || "text"}`;
    if (column.isAutoIncrement) {
      sql += dialect === "mysql" ? " AUTO_INCREMENT" : " GENERATED BY DEFAULT AS IDENTITY";
    }
    sql += column.nullable ? " NULL" : " NOT NULL";
    if (column.defaultValue.trim()) sql += ` DEFAULT ${column.defaultValue.trim()}`;
    if (column.isPrimaryKey && !composite) sql += " PRIMARY KEY";
    if (dialect === "mysql" && column.comment.trim()) {
      sql += ` COMMENT '${column.comment.trim().replace(/'/g, "''")}'`;
    }
    return `  ${sql}`;
  });
  if (composite) {
    const primary = filled
      .filter((column) => column.isPrimaryKey)
      .map((column) => quoteIdentifier(column.name.trim(), quote))
      .join(", ");
    lines.push(`  PRIMARY KEY (${primary})`);
  }
  let sql = `CREATE TABLE ${quoteIdentifier(table.trim() || "…", quote)} (\n${lines.join(",\n")}\n)`;
  if (dialect === "mysql") {
    sql += " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4";
    if (comment.trim()) sql += ` COMMENT='${comment.trim().replace(/'/g, "''")}'`;
  }
  return `${sql};`;
}

interface Props {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  databases: string[];
  defaultDatabase: string;
  quote: string;
  dialect: SqlDialect;
  busy?: boolean;
  onRun: (request: CreateTableRequest) => void;
}

export function CreateTableDialog({
  open,
  onClose,
  sessionId,
  databases,
  defaultDatabase,
  quote,
  dialect,
  busy,
  onRun,
}: Props) {
  const clickhouse = dialect === "clickhouse";
  const [database, setDatabase] = useState(defaultDatabase);
  const [table, setTable] = useState("");
  const [comment, setComment] = useState("");
  const [engine, setEngine] = useState("MergeTree");
  const [orderBy, setOrderBy] = useState("");
  const [partitionBy, setPartitionBy] = useState("");
  const [primaryKey, setPrimaryKey] = useState("");
  const [ttl, setTtl] = useState("");
  const [settings, setSettings] = useState("");
  const [columns, setColumns] = useState<ColumnDraft[]>([emptyColumn(dialect)]);

  useEffect(() => {
    if (!open) return;
    setDatabase(defaultDatabase);
    setTable("");
    setComment("");
    setEngine("MergeTree");
    setOrderBy("");
    setPartitionBy("");
    setPrimaryKey("");
    setTtl("");
    setSettings("");
    // ClickHouse has no auto-increment, so the starter key column is not one.
    setColumns([{ ...emptyColumn(dialect), isPrimaryKey: true, isAutoIncrement: !clickhouse }]);
  }, [open, defaultDatabase, dialect, clickhouse]);

  function update(index: number, patch: Partial<ColumnDraft>) {
    setColumns((current) =>
      current.map((column, i) => (i === index ? { ...column, ...patch } : column)),
    );
  }

  const definitions: ColumnDefinition[] = columns
    .filter((column) => column.name.trim())
    .map((column) => ({
      name: column.name.trim(),
      dataType: column.dataType.trim() || (clickhouse ? "String" : "text"),
      nullable: column.nullable,
      defaultValue: column.defaultValue.trim() ? column.defaultValue.trim() : null,
      isPrimaryKey: column.isPrimaryKey,
      isAutoIncrement: column.isAutoIncrement,
      comment: column.comment.trim() ? column.comment.trim() : null,
    }));

  const orderKeys = orderBy
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
  const sortingKeyMissing =
    clickhouse && isMergeTree(engine) && sortingKey(orderKeys, columns).length === 0;
  const nullableSortingKey =
    clickhouse && isMergeTree(engine) && hasNullableSortingKey(orderKeys, columns);
  const hasBlankName = columns.some((column) => !column.name.trim());
  const canRun =
    table.trim().length > 0 &&
    definitions.length > 0 &&
    !hasBlankName &&
    !sortingKeyMissing &&
    !nullableSortingKey &&
    !busy;
  const previewSettings = settings.split(",").map((setting) => setting.trim()).filter(Boolean);
  const preview = clickhouse
    ? buildClickHousePreview(database, table, comment, columns, quote, engine, orderKeys, partitionBy, primaryKey, ttl, previewSettings)
    : buildPreview(table, comment, columns, quote, dialect);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New table"
      description="Define the columns. Indexes and foreign keys can be added afterwards."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!canRun}
            onClick={() =>
              onRun({
                connectionId: sessionId,
                database,
                table: table.trim(),
                columns: definitions,
                ifNotExists: false,
                comment: comment.trim() || null,
                engine: clickhouse ? engine : null,
                orderBy: clickhouse ? orderKeys : [],
                partitionBy: clickhouse ? partitionBy.trim() || null : null,
                primaryKey: clickhouse ? primaryKey.trim() || null : null,
                ttl: clickhouse ? ttl.trim() || null : null,
                settings: clickhouse
                  ? settings.split(",").map((setting) => setting.trim()).filter(Boolean)
                  : [],
              })
            }
          >
            {busy ? "Creating…" : "Create table"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label className="mb-1.5 block">Database</Label>
            <Select value={database} onChange={(event) => setDatabase(event.target.value)}>
              {databases.length === 0 ? (
                <option value={database}>{database || "default"}</option>
              ) : (
                databases.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))
              )}
            </Select>
          </div>
          <div>
            <Label className="mb-1.5 block">Table name</Label>
            <Input value={table} placeholder="orders" onChange={(event) => setTable(event.target.value)} />
          </div>
        </div>

        {clickhouse ? (
          <div className="space-y-3">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="mb-1.5 block">Engine</Label>
              <Select value={engine} onChange={(event) => setEngine(event.target.value)}>
                {CLICKHOUSE_ENGINES.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label className="mb-1.5 block">ORDER BY</Label>
              <Input
                value={orderBy}
                disabled={!isMergeTree(engine)}
                placeholder={isMergeTree(engine) ? "id, created_at" : "not used by this engine"}
                onChange={(event) => setOrderBy(event.target.value)}
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                {isMergeTree(engine)
                  ? sortingKeyMissing
                    ? "Choose sorting key columns, or mark primary-key columns below."
                    : nullableSortingKey
                      ? "Sorting-key columns cannot be Nullable. Clear Nullable or choose another key."
                      : "Sorting key. Leave empty to use the primary-key columns."
                  : "Only MergeTree-family engines take a sorting key."}
              </p>
            </div>
          </div>
          {isMergeTree(engine) ? (
            <div className="grid grid-cols-2 gap-3">
              <div><Label className="mb-1.5 block">PARTITION BY expression</Label><Input value={partitionBy} placeholder="toYYYYMM(created_at)" onChange={(event) => setPartitionBy(event.target.value)} /></div>
              <div><Label className="mb-1.5 block">PRIMARY KEY expression (optional)</Label><Input value={primaryKey} placeholder="tenant_id, created_at" onChange={(event) => setPrimaryKey(event.target.value)} /></div>
              <div><Label className="mb-1.5 block">TTL expression</Label><Input value={ttl} placeholder="created_at + INTERVAL 90 DAY" onChange={(event) => setTtl(event.target.value)} /></div>
              <div><Label className="mb-1.5 block">SETTINGS (comma-separated)</Label><Input value={settings} placeholder="index_granularity = 8192" onChange={(event) => setSettings(event.target.value)} /></div>
              <p className="col-span-2 text-[10px] text-warning">Expressions and settings are sent as SQL fragments. Review the preview carefully; TTL cleanup is asynchronous.</p>
            </div>
          ) : null}
          </div>
        ) : null}

        <div>
          <Label className="mb-1.5 block">Comment</Label>
          <Input
            value={comment}
            placeholder="optional"
            onChange={(event) => setComment(event.target.value)}
          />
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <Label>Columns</Label>
            <Button
              size="xs"
              variant="outline"
              onClick={() => setColumns((current) => [...current, emptyColumn(dialect)])}
            >
              <Plus className="h-3 w-3" /> Add column
            </Button>
          </div>
          <div className="max-h-56 space-y-2 overflow-y-auto rounded-md border border-border p-2">
            {columns.map((column, index) => (
              <div key={index} className="space-y-1.5 rounded border border-border/60 p-2">
                <div className="flex items-center gap-2">
                  <Input
                    className="h-8"
                    placeholder="column name"
                    value={column.name}
                    onChange={(event) => update(index, { name: event.target.value })}
                  />
                  <Input
                    className="h-8 w-40"
                    placeholder="type"
                    list={`column-types-${index}`}
                    value={column.dataType}
                    onChange={(event) => update(index, { dataType: event.target.value })}
                  />
                  <datalist id={`column-types-${index}`}>
                    {(clickhouse ? CLICKHOUSE_TYPES : COMMON_TYPES).map((type) => (
                      <option key={type} value={type} />
                    ))}
                  </datalist>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={columns.length === 1}
                    title="Remove column"
                    onClick={() => setColumns((current) => current.filter((_, i) => i !== index))}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Checkbox
                    label={clickhouse ? "Sorting key" : "Primary key"}
                    checked={column.isPrimaryKey}
                    onChange={(event) => update(index, { isPrimaryKey: event.target.checked })}
                  />
                  {clickhouse ? null : (
                    <Checkbox
                      label="Auto increment"
                      checked={column.isAutoIncrement}
                      onChange={(event) => update(index, { isAutoIncrement: event.target.checked })}
                    />
                  )}
                  <Checkbox
                    label="Nullable"
                    checked={column.nullable}
                    onChange={(event) => update(index, { nullable: event.target.checked })}
                  />
                  <Input
                    className="h-7 w-36"
                    placeholder="default"
                    value={column.defaultValue}
                    onChange={(event) => update(index, { defaultValue: event.target.value })}
                  />
                </div>
              </div>
            ))}
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
