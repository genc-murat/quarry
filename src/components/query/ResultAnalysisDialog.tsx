import { useId, useMemo, useState } from "react";
import { Camera, Columns3, Download, GitCompareArrows, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { downloadText } from "@/lib/objects";
import {
  alignResultColumns,
  canAnalyze,
  compareResults,
  MAX_RESULT_CELLS,
  MAX_RESULT_SNAPSHOTS,
  MAX_SNAPSHOT_BYTES,
  measureSnapshot,
  profileResult,
  profileRows,
  type ProfileFilter,
  type ColumnProfile,
  type ResultSample,
  type ResultSnapshot,
  type RowDifference,
} from "@/lib/resultAnalysis";
import { cn, formatCount } from "@/lib/utils";

type View = "Profile" | "Snapshots" | "Compare";

const ANALYSIS_LIMIT = `This result exceeds the analysis limit of ${formatCount(MAX_RESULT_CELLS)} cells. Run a narrower query or lower the row limit.`;
const PAGE_SIZE = 25;
const CURRENT = "current";

interface Props {
  sample: ResultSample | null;
  snapshots: ResultSnapshot[];
  onSnapshotsChange: (snapshots: ResultSnapshot[]) => void;
  onClose: () => void;
}

export function ResultAnalysisDialog({ sample, snapshots, onSnapshotsChange, onClose }: Props) {
  const [view, setView] = useState<View>(sample ? "Profile" : "Snapshots");
  const [profileId, setProfileId] = useState(sample ? CURRENT : snapshots[0]?.id ?? "");
  const [name, setName] = useState("");
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const profileLabel = useId();
  const profileSample = profileId === CURRENT ? sample : snapshots.find(({ id }) => id === profileId);

  function capture(event: React.FormEvent) {
    event.preventDefault();
    const label = name.trim();
    if (!sample || !label || !canAnalyze(sample.result)) return;
    if (snapshots.some((snapshot) => snapshot.name === label)) {
      setMessage({ text: "A snapshot already uses that name.", error: true });
      return;
    }
    if (snapshots.length >= MAX_RESULT_SNAPSHOTS) {
      setMessage({ text: "Remove a snapshot to make room for another.", error: true });
      return;
    }
    const remaining = MAX_SNAPSHOT_BYTES - snapshots.reduce((sum, item) => sum + item.bytes, 0);
    const bytes = measureSnapshot(sample, remaining);
    if (bytes > remaining) {
      setMessage({ text: "The snapshots would exceed 20 MiB. Remove a snapshot or capture a smaller result.", error: true });
      return;
    }
    // Query responses are replaced on each run. Keeping this reference pins that exact result.
    onSnapshotsChange([...snapshots, { ...sample, id: crypto.randomUUID(), name: label, bytes }]);
    setName("");
    setMessage({ text: `Captured “${label}”.` });
  }

  return (
    <Dialog open onClose={onClose} title="Result analysis" className="max-w-5xl"
      description="Inspect loaded rows and verify changes between runs.">
      <nav aria-label="Result analysis views" className="mb-4 flex flex-wrap gap-1 border-b border-border pb-2">
        {([
          ["Profile", Columns3],
          ["Snapshots", Camera],
          ["Compare", GitCompareArrows],
        ] as const).map(([label, Icon]) => (
          <Button key={label} size="sm" variant={label === view ? "secondary" : "ghost"}
            aria-pressed={label === view} autoFocus={label === view} onClick={() => setView(label)}>
            <Icon className="h-3.5 w-3.5" /> {label}
          </Button>
        ))}
      </nav>

      {view === "Profile" ? (
        <div className="space-y-3">
          {snapshots.length ? (
            <div className="max-w-sm space-y-1">
              <Label htmlFor={profileLabel}>Profile result</Label>
              <Select id={profileLabel} value={profileSample ? profileId : ""} onChange={(event) => setProfileId(event.target.value)}>
                <ResultOptions sample={sample} snapshots={snapshots} />
              </Select>
            </div>
          ) : null}
          {profileSample ? <ResultProfile key={profileId} sample={profileSample} /> : (
            <p className="py-6 text-sm text-muted-foreground">Choose a snapshot or open Analysis from a query result.</p>
          )}
        </div>
      ) : null}

      {view === "Snapshots" ? (
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">Snapshots stay in memory until you close Quarry. Keep up to {MAX_RESULT_SNAPSHOTS} snapshots.</p>
          {sample ? (
            <form className="space-y-3 rounded-lg border border-border p-3" onSubmit={capture}>
              <SampleDetails sample={sample} />
              {canAnalyze(sample.result) ? (
                <div className="flex flex-wrap items-end gap-2">
                  <label className="min-w-40 flex-1 space-y-1 text-xs text-muted-foreground">
                    <span>Snapshot name</span>
                    <Input value={name} maxLength={100} placeholder="e.g. Before backfill"
                      onChange={(event) => { setName(event.target.value); setMessage(null); }} />
                  </label>
                  <Button type="submit" disabled={!name.trim()}><Camera className="h-4 w-4" /> Capture snapshot</Button>
                </div>
              ) : <p className="text-xs text-warning">{ANALYSIS_LIMIT}</p>}
            </form>
          ) : null}
          {message ? <p role="status" className={cn("text-xs", message.error ? "text-destructive" : "text-success")}>{message.text}</p> : null}
          {snapshots.length ? (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {snapshots.map((snapshot) => (
                <li key={snapshot.id} className="flex items-start justify-between gap-3 p-3">
                  <div className="min-w-0 space-y-1">
                    <div className="break-words text-sm font-medium">{snapshot.name}</div>
                    <SampleDetails sample={snapshot} />
                  </div>
                  <Button size="icon-sm" variant="ghost" title={`Remove ${snapshot.name}`} aria-label={`Remove ${snapshot.name}`}
                    onClick={() => { onSnapshotsChange(snapshots.filter(({ id }) => id !== snapshot.id)); setMessage(null); }}>
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : <p className="py-3 text-sm text-muted-foreground">Capture a result to use it in another run or tab.</p>}
        </div>
      ) : null}

      {view === "Compare" ? <ResultComparison sample={sample} snapshots={snapshots} /> : null}
    </Dialog>
  );
}

function SampleDetails({ sample }: { sample: ResultSample }) {
  const { result, source } = sample;
  const preview = source?.preview;
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 break-all">
        <span className="font-medium text-foreground">{formatCount(result.rows.length)} loaded rows</span>
        {source?.connection ? <span>{source.connection}</span> : null}
        {source?.database ? <span title="Database selected for this run">{source.database}</span> : null}
        {source ? <time dateTime={new Date(source.completedAt).toISOString()}>{new Date(source.completedAt).toLocaleString()}</time> : null}
        {preview ? <Badge variant="warning">{source?.partitionKeys ? "Partition page" : "Preview tab"} · offset {formatCount(preview.offset)}</Badge> : null}
        {result.truncated ? <Badge variant="warning">Truncated</Badge> : null}
      </div>
      <details>
        <summary className="w-fit cursor-pointer hover:text-foreground">Executed statement</summary>
        <pre className="mt-1 max-h-28 overflow-auto rounded bg-background p-2 font-mono-app whitespace-pre-wrap break-words">{result.statement}</pre>
        {source?.partitionKeys?.map(({ column, value }) => (
          <div key={column} className="mt-1 break-all font-mono-app">{column} = {JSON.stringify(value)}</div>
        ))}
      </details>
    </div>
  );
}

function ResultProfile({ sample }: { sample: ResultSample }) {
  const { result } = sample;
  const profiles = useMemo(() => canAnalyze(result) ? profileResult(result) : null, [result]);
  const [selection, setSelection] = useState<{ column: number; filter: ProfileFilter } | null>(null);
  const [page, setPage] = useState(0);
  const rows = useMemo(() => selection ? profileRows(result, selection.column, selection.filter) : [], [result, selection]);

  return (
    <div className="space-y-3">
      <SampleDetails sample={sample} />
      {result.columns.length === 0 ? (
        <p className="text-sm text-muted-foreground">This result has no column metadata to profile.</p>
      ) : profiles ? (
        <>
          <p className="text-xs text-muted-foreground">Distinct and repeated counts exclude NULL. Blank includes empty or whitespace-only text. Select a count to see its rows.</p>
          <div className="max-h-72 overflow-auto rounded-lg border border-border">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-surface text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2">Column</th>
                  <th scope="col" className="px-3 py-2 text-right">NULL</th>
                  <th scope="col" className="px-3 py-2 text-right">Blank</th>
                  <th scope="col" className="px-3 py-2 text-right">Distinct</th>
                  <th scope="col" className="px-3 py-2 text-right">Repeated rows</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((profile, column) => {
                  const { name, dataType } = result.columns[column];
                  return (
                    <tr key={column} className="border-t border-border/60">
                      <th scope="row" className="px-3 py-1.5 text-left font-mono-app font-medium">
                        {name} {dataType ? <span className="text-muted-foreground">{dataType}</span> : null}
                      </th>
                      {(["nulls", "blanks", "distinct", "repeats"] as const).map((filter) => (
                        <td key={filter} className="px-3 py-1 text-right tabular-nums">
                          {filter !== "distinct" && profile[filter] > 0 ? (
                            <Button size="xs" variant="ghost" className="text-primary"
                              aria-label={`${name} (column ${column + 1}): ${profile[filter]} ${filter}`}
                              aria-pressed={selection?.column === column && selection.filter === filter}
                              onClick={() => { setSelection({ column, filter }); setPage(0); }}>
                              {formatCount(profile[filter])}
                            </Button>
                          ) : formatCount(profile[filter])}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {selection ? (
            <section className="rounded-lg border border-border" aria-label="Profile matches">
              <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <h3 className="text-xs font-semibold">{result.columns[selection.column].name} · {selection.filter}</h3>
                <Pagination page={page} count={rows.length} onPage={setPage} />
              </div>
              <ol className="max-h-52 divide-y divide-border/60 overflow-y-auto border-t border-border">
                {rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(({ row, value }) => (
                  <li key={row} className="flex gap-3 px-3 py-1.5 text-xs">
                    <span className="shrink-0 tabular-nums text-muted-foreground">Row {formatCount(row)}</span>
                    <CellValue value={value} />
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
        </>
      ) : <p className="text-xs text-warning">{ANALYSIS_LIMIT}</p>}
    </div>
  );
}

const changeLabels = {
  added: "After only",
  removed: "Before only",
  changed: "Changed",
} as const;

const changeColors = {
  added: "text-success",
  removed: "text-destructive",
  changed: "text-warning",
} as const;

function ResultComparison({ sample, snapshots }: { sample: ResultSample | null; snapshots: ResultSnapshot[] }) {
  const beforeLabel = useId();
  const afterLabel = useId();
  const [beforeId, setBeforeId] = useState(snapshots[0]?.id ?? "");
  const [afterId, setAfterId] = useState(sample ? CURRENT : snapshots[1]?.id ?? "");
  const before = beforeId === CURRENT ? sample : snapshots.find(({ id }) => id === beforeId);
  const after = afterId === CURRENT ? sample : snapshots.find(({ id }) => id === afterId);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0 space-y-2 rounded-lg border border-border p-3">
          <Label htmlFor={beforeLabel}>Before</Label>
          <Select id={beforeLabel} value={beforeId} onChange={(event) => setBeforeId(event.target.value)}>
            <ResultOptions sample={sample} snapshots={snapshots} />
          </Select>
          {before ? <SampleDetails sample={before} /> : null}
        </div>
        <div className="min-w-0 space-y-2 rounded-lg border border-border p-3">
          <Label htmlFor={afterLabel}>After</Label>
          <Select id={afterLabel} value={afterId} onChange={(event) => setAfterId(event.target.value)}>
            <ResultOptions sample={sample} snapshots={snapshots} />
          </Select>
          {after ? <SampleDetails sample={after} /> : null}
        </div>
      </div>
      {!before || !after ? (
        <p className="text-sm text-muted-foreground">Choose two results. Capture a snapshot to keep a result for comparison.</p>
      ) : beforeId === afterId ? (
        <p className="text-sm text-muted-foreground">Choose a different result for each side.</p>
      ) : !canAnalyze(before.result) || !canAnalyze(after.result) ? (
        <p className="text-xs text-warning">{ANALYSIS_LIMIT}</p>
      ) : <ComparePair key={`${beforeId}:${afterId}`} before={before} after={after} />}
    </div>
  );
}

function ResultOptions({ sample, snapshots }: { sample: ResultSample | null; snapshots: ResultSnapshot[] }) {
  return (
    <>
      <option value="">Choose a result</option>
      {sample ? <option value={CURRENT}>Current result</option> : null}
      {snapshots.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
    </>
  );
}

function ComparePair({ before, after }: { before: ResultSample; after: ResultSample }) {
  const [keys, setKeys] = useState<string[]>([]);
  const [filter, setFilter] = useState<"all" | RowDifference["kind"]>("all");
  const [page, setPage] = useState(0);
  const [showQuality, setShowQuality] = useState(false);
  const alignment = useMemo(() => alignResultColumns(before.result, after.result), [before, after]);
  const diff = useMemo(() => compareResults(before.result, after.result, alignment, keys), [before, after, alignment, keys]);
  const changes = useMemo(() => "error" in diff ? [] : filter === "all" ? diff.differences
    : diff.differences.filter(({ kind }) => kind === filter), [diff, filter]);

  function toggleKey(name: string) {
    setKeys((current) => current.includes(name) ? current.filter((key) => key !== name) : [...current, name]);
    setFilter("all");
    setPage(0);
  }

  function downloadReport() {
    if ("error" in diff) return;
    const context = (sample: ResultSample) => ({
      name: "name" in sample ? sample.name : "Current result",
      source: sample.source,
      statement: sample.result.statement,
      columns: sample.result.columns,
      loadedRows: sample.result.rows.length,
      truncated: sample.result.truncated,
    });
    downloadText("result-comparison.json", JSON.stringify({
      before: context(before),
      after: context(after),
      keyColumns: keys,
      sharedColumns: alignment.shared.map(({ name }) => name),
      inferredColumns: alignment.inferred,
      columnsOnlyBefore: alignment.onlyBefore,
      columnsOnlyAfter: alignment.onlyAfter,
      ...diff,
    }, null, 2));
  }

  return (
    <div className="space-y-3">
      {alignment.inferred ? (
        <p className="text-xs text-muted-foreground">An empty result returned without column metadata. Column names come from the available result.</p>
      ) : null}
      {alignment.onlyBefore.length || alignment.onlyAfter.length ? (
        <div className="space-y-1 rounded-md border border-warning/35 bg-warning/5 px-3 py-2 text-xs">
          <p>Row comparison uses the columns shared by both results.</p>
          {alignment.onlyBefore.length ? <p className="break-words">Columns only before · {alignment.onlyBefore.join(", ")}</p> : null}
          {alignment.onlyAfter.length ? <p className="break-words">Columns only after · {alignment.onlyAfter.join(", ")}</p> : null}
        </div>
      ) : null}
      {!alignment.ambiguous && alignment.shared.length ? (
        <>
          <fieldset className="min-w-0 space-y-2">
            <legend className="text-xs font-semibold">Match rows by</legend>
            <p className="text-xs text-muted-foreground">
              {keys.length ? "Selected columns identify a row together." : "Comparing complete rows across shared columns, including duplicates."}
            </p>
            <div className="flex max-h-24 flex-wrap gap-x-3 gap-y-2 overflow-auto py-1">
              {alignment.shared.map(({ name }) => (
                <Checkbox key={name} label={name || "(unnamed column)"} checked={keys.includes(name)} onChange={() => toggleKey(name)} />
              ))}
            </div>
          </fieldset>
          {!alignment.inferred ? (
            <details className="rounded-lg border border-border px-3 py-2" open={showQuality}
              onToggle={(event) => setShowQuality(event.currentTarget.open)}>
              <summary className="w-fit cursor-pointer text-xs font-semibold">Column quality changes</summary>
              {showQuality ? <QualityChanges before={before} after={after} columns={alignment.shared} /> : null}
            </details>
          ) : null}
        </>
      ) : null}
      {"error" in diff ? <p role="alert" className="rounded-md border border-warning/35 bg-warning/5 p-3 text-xs">{diff.error}</p> : (
        <>
          <div className="flex flex-wrap items-center gap-2 border-y border-border py-2">
            <Button size="xs" variant={filter === "all" ? "secondary" : "ghost"}
              aria-pressed={filter === "all"} onClick={() => { setFilter("all"); setPage(0); }}>
              All differences
            </Button>
            {(["removed", "changed", "added"] as const).map((kind) => (
              <Button key={kind} size="xs" variant={filter === kind ? "secondary" : "ghost"}
                aria-pressed={filter === kind} className={changeColors[kind]}
                onClick={() => { setFilter(kind); setPage(0); }}>
                {changeLabels[kind]} <span className="font-mono-app tabular-nums">{formatCount(diff.counts[kind])}</span>
              </Button>
            ))}
            <span className="px-2 text-xs text-muted-foreground">Matching {formatCount(diff.matching)}</span>
            <Button size="xs" variant="outline" className="ml-auto" onClick={downloadReport}>
              <Download className="h-3.5 w-3.5" /> Download row diff
            </Button>
          </div>
          {changes.length ? (
            <>
              <div className="flex justify-end"><Pagination page={page} count={changes.length} onPage={setPage} /></div>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {changes.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((change, index) => {
                  const keyCells = alignment.shared.filter(({ name }) => keys.includes(name)).map((column) =>
                    change.kind === "added" ? change.after[column.after] : change.before[column.before]);
                  return <DifferenceRow key={`${filter}:${page * PAGE_SIZE + index}`} change={change}
                    keyCells={keyCells} before={before} after={after} columns={alignment.shared} />;
                })}
              </ul>
            </>
          ) : (
            <p className="py-2 text-sm text-muted-foreground">
              {diff.differences.length ? "No rows match this filter." : "The loaded rows match across the compared columns."}
            </p>
          )}
        </>
      )}
    </div>
  );
}

type SharedColumns = ReturnType<typeof alignResultColumns>["shared"];

function QualityChanges({ before, after, columns }: { before: ResultSample; after: ResultSample; columns: SharedColumns }) {
  const beforeProfile = useMemo(() => profileResult(before.result), [before]);
  const afterProfile = useMemo(() => profileResult(after.result), [after]);
  const metrics: { key: keyof ColumnProfile; label: string }[] = [
    { key: "nulls", label: "NULL" },
    { key: "blanks", label: "Blank" },
    { key: "distinct", label: "Distinct" },
    { key: "repeats", label: "Repeated rows" },
  ];
  const changedColumns = columns.filter((column) => metrics.some(({ key }) =>
    beforeProfile[column.before][key] !== afterProfile[column.after][key]));

  if (!changedColumns.length) return <p className="mt-2 text-xs text-muted-foreground">Column counts match across the loaded rows.</p>;
  return (
    <div className="mt-2 max-h-52 overflow-auto rounded border border-border">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-surface text-muted-foreground">
          <tr>
            <th scope="col" className="p-2">Column</th>
            {metrics.map(({ key, label }) => <th scope="col" key={key} className="p-2 text-right">{label}</th>)}
          </tr>
        </thead>
        <tbody>
          {changedColumns.map((column) => (
            <tr key={column.name} className="border-t border-border/60">
              <th scope="row" className="p-2 font-mono-app font-medium">{column.name}</th>
              {metrics.map(({ key }) => {
                const previous = beforeProfile[column.before][key];
                const current = afterProfile[column.after][key];
                return (
                  <td key={key} className={cn("p-2 text-right tabular-nums", previous === current ? "text-muted-foreground" : "font-medium")}>
                    {previous === current ? formatCount(current) : `${formatCount(previous)} → ${formatCount(current)}`}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DifferenceRow({ change, keyCells, before, after, columns }: {
  change: RowDifference;
  keyCells: unknown[];
  before: ResultSample;
  after: ResultSample;
  columns: SharedColumns;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="px-3 py-2 text-xs">
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="cursor-pointer break-words">
          <span className={cn("mr-2 font-medium", changeColors[change.kind])}>{changeLabels[change.kind]}</span>
          {keyCells.length ? <span className="font-mono-app">{JSON.stringify(keyCells).slice(0, 160)}</span> : null}
          {change.kind === "changed" ? <span className="ml-2 text-muted-foreground">{change.fields.join(", ")}</span> : null}
        </summary>
        {open ? <DifferenceDetails change={change} before={before} after={after} columns={columns} /> : null}
      </details>
    </li>
  );
}

function DifferenceDetails({ change, before, after, columns }: {
  change: RowDifference;
  before: ResultSample;
  after: ResultSample;
  columns: SharedColumns;
}) {
  const fields = change.kind === "added"
    ? after.result.columns.map(({ name }, index) => ({ name, after: change.after[index], before: undefined }))
    : change.kind === "removed"
      ? before.result.columns.map(({ name }, index) => ({ name, before: change.before[index], after: undefined }))
      : columns.filter(({ name }) => change.fields.includes(name)).map((column) => ({
        name: column.name,
        before: change.before[column.before],
        after: change.after[column.after],
      }));

  return (
    <div className="mt-2 max-h-64 overflow-auto rounded border border-border">
      <table className="w-full table-fixed text-left">
        <thead className="sticky top-0 bg-surface text-muted-foreground">
          <tr>
            <th scope="col" className="w-1/4 p-2">Column</th>
            {change.kind !== "added" ? <th scope="col" className="p-2">Before</th> : null}
            {change.kind !== "removed" ? <th scope="col" className="p-2">After</th> : null}
          </tr>
        </thead>
        <tbody>
          {fields.map((field) => (
            <tr key={field.name} className="border-t border-border/60 align-top">
              <th scope="row" className="break-words p-2 font-mono-app font-medium">{field.name}</th>
              {change.kind !== "added" ? <td className="p-2"><CellValue value={field.before} /></td> : null}
              {change.kind !== "removed" ? <td className="p-2"><CellValue value={field.after} /></td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CellValue({ value }: { value: unknown }) {
  return <span className={cn("min-w-0 whitespace-pre-wrap break-all font-mono-app", value == null && "text-muted-foreground")}>
    {value == null ? "NULL" : JSON.stringify(value)}
  </span>;
}

function Pagination({ page, count, onPage }: { page: number; count: number; onPage: (page: number) => void }) {
  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground">
      <Button size="xs" variant="ghost" disabled={page === 0} onClick={() => onPage(page - 1)}>Previous</Button>
      <span className="tabular-nums" aria-live="polite">
        {formatCount(page * PAGE_SIZE + 1)}–{formatCount(Math.min(count, (page + 1) * PAGE_SIZE))} of {formatCount(count)}
      </span>
      <Button size="xs" variant="ghost" disabled={(page + 1) * PAGE_SIZE >= count} onClick={() => onPage(page + 1)}>Next</Button>
    </div>
  );
}
