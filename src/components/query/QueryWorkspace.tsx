import { useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { MySQL, PostgreSQL, SQLite, StandardSQL, sql, type SQLNamespace } from "@codemirror/lang-sql";
import { indentUnit } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import { Bookmark, ListTree, Play, Save, ScrollText, Square, Star, Terminal } from "lucide-react";

import { activeStatementHighlight } from "@/lib/sqlHighlight";
import { sqlToRun } from "@/lib/sqlScript";

import { ObjectInspector } from "@/components/objects/ObjectInspector";
import { DatabaseSelect } from "@/components/query/DatabaseSelect";
import { PlanPanel } from "@/components/query/PlanPanel";
import { ResultsGrid } from "@/components/query/ResultsGrid";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { useThemeStore, resolveMode } from "@/stores/theme";
import { useWorkspace } from "@/stores/workspace";

/** Upper bound on tables fed to the autocompleter so huge schemas stay snappy. */
const MAX_COMPLETION_TABLES = 400;

export function QueryWorkspace() {
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const updateTab = useWorkspace((s) => s.updateTab);
  const runTab = useWorkspace((s) => s.runTab);
  const explainTab = useWorkspace((s) => s.explainTab);
  const cancelTab = useWorkspace((s) => s.cancelTab);
  const saveSnippet = useWorkspace((s) => s.saveSnippet);
  const saveScript = useWorkspace((s) => s.saveScript);
  const toggleFavorite = useWorkspace((s) => s.toggleFavorite);
  const favorites = useWorkspace((s) => s.favorites);
  const saveRowChanges = useWorkspace((s) => s.saveRowChanges);
  const pageObjectData = useWorkspace((s) => s.pageObjectData);
  const sessions = useWorkspace((s) => s.sessions);
  const drivers = useWorkspace((s) => s.drivers);
  const databasesBySession = useWorkspace((s) => s.databasesBySession);
  const mode = useThemeStore((s) => s.mode);
  const editor = useWorkspace((s) => s.settings.editor);
  const columnsCache = useWorkspace((s) => s.columnsCache);
  const loadColumns = useWorkspace((s) => s.loadColumns);

  const [editorRatio, setEditorRatio] = useState(46);
  const [saveOpen, setSaveOpen] = useState(false);
  const [snippetName, setSnippetName] = useState("");
  const dragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // Latest CodeMirror selection, so Run can resolve a statement without React
  // state churn on every cursor move.
  const selectionRef = useRef<{ from: number; to: number }>({ from: 0, to: 0 });

  const tab = tabs.find((t) => t.id === activeTabId) ?? null;
  const session = sessions.find((s) => s.id === tab?.sessionId) ?? null;
  const databases = session ? (databasesBySession[session.id] ?? []) : [];
  const dark = resolveMode(mode) === "dark";
  const sessionId = tab?.sessionId ?? null;
  // Fall back to the database the session is connected to so completion works
  // before the user explicitly picks one.
  const database = tab?.database ?? session?.server.currentDatabase ?? null;

  // Fetch the schema once per session+database so the editor can complete
  // table and column names (not just keywords).
  useEffect(() => {
    if (sessionId && database) void loadColumns(sessionId, database);
  }, [sessionId, database, loadColumns]);

  // A different tab's cursor is meaningless here; start from the top again.
  useEffect(() => {
    selectionRef.current = { from: 0, to: 0 };
  }, [tab?.id]);

  const schema = useMemo<SQLNamespace | undefined>(() => {
    if (!sessionId || !database) return undefined;
    const entries = columnsCache[`${sessionId}||${database}`];
    if (!entries || entries.length === 0) return undefined;

    const root: Record<string, unknown> = {};
    const qualified: Record<string, Record<string, unknown>> = {};

    for (const entry of entries.slice(0, MAX_COMPLETION_TABLES)) {
      // NOTE: a namespace leaf must be an *array* of completions; a bare
      // completion object is read as a nested namespace and recurses forever.
      const table = {
        self: { label: entry.table, type: "class" },
        children: entry.columns.map((column) => ({
          label: column.name,
          type: "property",
          detail: column.dataType ?? undefined,
        })),
      };
      // Flat entry so `orders.` and `FROM ord…` work.
      root[entry.table] = table;
      // Grouped entry so `shop.orders.` works too.
      if (entry.schema) {
        (qualified[entry.schema] ??= {})[entry.table] = table;
      }
    }

    for (const [name, children] of Object.entries(qualified)) {
      // Never shadow a table that happens to share the schema's name.
      root[name] ??= { self: { label: name, type: "namespace" }, children };
    }

    return root as SQLNamespace;
  }, [columnsCache, sessionId, database]);

  const dialect = useMemo(() => {
    switch (session?.driver) {
      case "mysql":
        return MySQL;
      case "postgres":
        return PostgreSQL;
      case "sqlite":
        return SQLite;
      default:
        return StandardSQL;
    }
  }, [session?.driver]);

  const capabilities = drivers.find((d) => d.id === session?.driver)?.capabilities;
  // Non-SQL engines (Redis) get a plain editor: a SQL dialect would offer
  // meaningless keyword completion and highlighting.
  const usesSql = (capabilities?.queryLanguage ?? "sql") === "sql";
  // An engine with no planner (Redis) must not be offered the action at all —
  // otherwise every click just fails with "this driver cannot explain queries".
  const supportsExplain = capabilities?.supportsExplain ?? true;

  // Editor settings are extensions rather than props, so they are rebuilt when
  // any of them changes.
  const extensions = useMemo(
    () => [
      ...(usesSql ? [sql({ dialect, schema })] : []),
      ...(editor.wordWrap ? [EditorView.lineWrapping] : []),
      EditorState.tabSize.of(Number(editor.tabSize)),
      indentUnit.of(" ".repeat(Number(editor.tabSize))),
      // Track the cursor so Run can pick the statement under it.
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) {
          const selection = update.state.selection.main;
          selectionRef.current = { from: selection.from, to: selection.to };
        }
      }),
      activeStatementHighlight(),
    ],
    [usesSql, dialect, schema, editor.wordWrap, editor.tabSize],
  );

  function startDrag() {
    dragging.current = true;
    const onMove = (event: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const ratio = ((event.clientY - rect.top) / rect.height) * 100;
      setEditorRatio(Math.min(80, Math.max(20, ratio)));
    };
    const onUp = () => {
      dragging.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  if (!tab) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        <Terminal className="mr-2 h-4 w-4" /> No query open
      </div>
    );
  }

  // Object tabs reuse this workspace slot to render the table inspector.
  if (tab.kind === "object" && tab.objectRef) {
    return <ObjectInspector objectRef={tab.objectRef} />;
  }

  // The SQL a Run/Explain targets: the selection when there is one, otherwise
  // the statement under the cursor.
  function currentSql(): string {
    if (!tab) return "";
    const { from, to } = selectionRef.current;
    return sqlToRun(tab.sql, from, to);
  }

  function runCurrent() {
    if (tab) void runTab(tab.id, currentSql());
  }

  function explainCurrent() {
    if (tab) void explainTab(tab.id, currentSql());
  }

  function handleSaveSnippet() {
    const name = snippetName.trim();
    if (!name || !tab) return;
    void saveSnippet({
      name,
      sql: tab.sql,
      database: tab.database,
      driver: session?.driver ?? null,
    });
    setSnippetName("");
    setSaveOpen(false);
  }

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface/60 px-3 py-2">
        {tab.running ? (
          <Button
            size="sm"
            variant="destructive"
            onClick={() => cancelTab(tab.id)}
            title="Stop (⌘/Ctrl + .)"
          >
            <Square className="h-3.5 w-3.5" />
            Stop
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={runCurrent}
            disabled={!session}
            title="Run statement under cursor / selection (⌘/Ctrl + Enter)"
          >
            <Play className="h-3.5 w-3.5" />
            Run
          </Button>
        )}

        <Button
          size="sm"
          variant="outline"
          onClick={() => void runTab(tab.id, tab.sql)}
          disabled={!session || tab.running || !tab.sql.trim()}
          title="Run whole script (⌘/Ctrl + Alt + Enter)"
        >
          <ScrollText className="h-3.5 w-3.5" />
          Script
        </Button>

        {supportsExplain ? (
          <Button
            size="sm"
            variant="outline"
            onClick={explainCurrent}
            disabled={!session || tab.running || tab.explaining}
            title="Explain statement under cursor / selection (⌘/Ctrl + Shift + Enter)"
          >
            <ListTree className="h-3.5 w-3.5" />
            Explain
          </Button>
        ) : null}

        <Button
          size="sm"
          variant="ghost"
          onClick={() => toggleFavorite(tab.id)}
          disabled={!tab.sql.trim()}
          title={favorites.some((favorite) => favorite.sql === tab.sql.trim() && favorite.sessionId === tab.sessionId && favorite.database === tab.database) ? "Remove favorite" : "Add to favorites"}
        >
          <Star className={`h-3.5 w-3.5 ${favorites.some((favorite) => favorite.sql === tab.sql.trim() && favorite.sessionId === tab.sessionId && favorite.database === tab.database) ? "fill-warning text-warning" : ""}`} />
          Favorite
        </Button>

        {tab.kind === "script" ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void saveScript(tab.id)}
            title={
              tab.filePath
                ? `Save to ${tab.filePath} (⌘/Ctrl + S)`
                : "Save script as… (⌘/Ctrl + S)"
            }
          >
            <Save className="h-3.5 w-3.5" />
            Save file
          </Button>
        ) : null}

        <Button
          size="sm"
          variant="ghost"
          onClick={() => setSaveOpen(true)}
          disabled={!tab.sql.trim()}
          title="Save as snippet"
        >
          <Bookmark className="h-3.5 w-3.5" />
          Save query
        </Button>

        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Session</span>
          <Select
            className="h-7 w-44 text-xs"
            value={tab.sessionId ?? ""}
            onChange={(event) => updateTab(tab.id, { sessionId: event.target.value || null })}
          >
            <option value="">none</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Database</span>
          <DatabaseSelect
            className="h-7 w-44 text-xs"
            databases={databases}
            value={tab.database ?? ""}
            disabled={databases.length === 0}
            onChange={(database) => updateTab(tab.id, { database })}
          />
        </div>

        {session ? (
          <span className="ml-auto text-[11px] text-muted-foreground">
            {session.server.currentUser ?? ""}
            {session.server.supportsTls ? " · TLS" : ""}
          </span>
        ) : null}
      </div>

      <div
        onKeyDown={(event) => {
          if (!(event.metaKey || event.ctrlKey)) return;
          // A plain ⌘/Ctrl + S writes a script tab's `.sql` file. Another tab
          // kind has no file to write, and a modified shortcut (⌘⇧S, ⌘⌥S) is
          // somebody else's — both are left alone.
          if (
            event.key.toLowerCase() === "s" &&
            !event.shiftKey &&
            !event.altKey &&
            tab.kind === "script"
          ) {
            event.preventDefault();
            void saveScript(tab.id);
            return;
          }
          if (event.key === "." && tab.running) {
            event.preventDefault();
            void cancelTab(tab.id);
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            if (tab.running) {
              void cancelTab(tab.id);
            } else if (event.shiftKey && supportsExplain) {
              void explainTab(tab.id, currentSql());
            } else if (event.altKey) {
              // ⌘/Ctrl + Alt + Enter runs the whole script, not one statement.
              void runTab(tab.id, tab.sql);
            } else {
              void runTab(tab.id, currentSql());
            }
          }
        }}
        style={{ height: `${editorRatio}%` }}
        className="min-h-0 shrink-0 overflow-hidden"
      >
        <CodeMirror
          value={tab.sql}
          height="100%"
          theme={dark ? oneDark : "light"}
          extensions={extensions}
          onChange={(value) => updateTab(tab.id, { sql: value })}
          basicSetup={{
            lineNumbers: editor.lineNumbers,
            highlightActiveLine: editor.highlightActiveLine,
            foldGutter: editor.foldGutter,
            autocompletion: editor.autocomplete,
          }}
        />
      </div>

      <div
        onMouseDown={startDrag}
        className="h-1 shrink-0 cursor-row-resize bg-border transition-colors hover:bg-primary"
      />

      <div className="min-h-0 flex-1">
        {tab.explaining || tab.plan ? (
          <PlanPanel plan={tab.plan} explaining={tab.explaining} />
        ) : (
          <ResultsGrid
            result={tab.result}
            error={tab.error}
            running={tab.running}
            cancelled={tab.cancelled}
            editSource={tab.editSource}
            onSaveChanges={(changes) => saveRowChanges(tab.id, changes)}
            preview={tab.preview}
            onPage={(offset) => void pageObjectData(tab.id, offset)}
          />
        )}
      </div>

      <Dialog
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title="Save query"
        description="Reuse this query later from the Saved panel."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSaveSnippet} disabled={!snippetName.trim()}>
              Save
            </Button>
          </>
        }
      >
        <Label htmlFor="snippet-name" className="mb-2 block">
          Name
        </Label>
        <Input
          id="snippet-name"
          autoFocus
          value={snippetName}
          placeholder="e.g. Recent orders"
          onChange={(event) => setSnippetName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") handleSaveSnippet();
          }}
        />
      </Dialog>
    </div>
  );
}
