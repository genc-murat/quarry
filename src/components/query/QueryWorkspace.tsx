import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { autocompletion } from "@codemirror/autocomplete";
import { MySQL, PostgreSQL, SQLite, StandardSQL, sql, type SQLNamespace } from "@codemirror/lang-sql";
import { indentUnit } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import { Bookmark, ListTree, Play, Save, ScrollText, Square, Star, Terminal } from "lucide-react";

import { assistantStatus, type AssistantCall } from "@/lib/assistantStatus";
import { ipc } from "@/lib/ipc";
import { createRankCache, SETTLE_MS, type RankQuestion } from "@/lib/rankCache";
import { smartCompletionSource } from "@/lib/smartComplete";
import { activeStatementHighlight } from "@/lib/sqlHighlight";
import { splitStatements, sqlToRun } from "@/lib/sqlScript";
import type { SchemaTable } from "@/lib/sqlQualifier";
import {
  createStatementRepairs,
  failuresIn,
  MIN_REPAIR_CANDIDATES,
  repairCandidates,
  repairedStatement,
  schemaNames,
  suggestionOf,
  type FailureRepair,
} from "@/lib/statementRepair";
import {
  createStatementReads,
  MAX_RISK_STATEMENTS,
  riskLabel,
  statementsInScript,
  statementsToRun,
  wholeScriptTitle,
  worst,
} from "@/lib/statementRisk";
import type { StatementReading, StatementRepair } from "@/lib/types";

import { ObjectInspector } from "@/components/objects/ObjectInspector";
import { AssistantIndicator } from "@/components/query/AssistantIndicator";
import { DatabaseSelect } from "@/components/query/DatabaseSelect";
import { PlanPanel } from "@/components/query/PlanPanel";
import { StatementRiskBadge } from "@/components/query/StatementRiskBadge";
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
  const assistant = useWorkspace((s) => s.settings.assistant);
  const columnsCache = useWorkspace((s) => s.columnsCache);
  const loadColumns = useWorkspace((s) => s.loadColumns);

  const [editorRatio, setEditorRatio] = useState(46);
  const [saveOpen, setSaveOpen] = useState(false);
  const [snippetName, setSnippetName] = useState("");
  // Where the caret is. Only the statement it sits in reads it, so this is a
  // plain position rather than the selection the Run button needs.
  // The selection only: with an empty one CodeMirror reports its start and end as
  // the cursor, so this is the cursor as well. It is state as well as a ref because
  // a reading has to be about what a Run would send, and a Run sends the selection
  // when there is one — so the question cannot be asked from a ref that never
  // re-renders.
  const [selection, setSelection] = useState<{ from: number; to: number }>({ from: 0, to: 0 });
  // Bumped whenever a statement reading lands, so the badge that shows one
  // re-renders: the readings themselves live in a store, not in state.
  const [readsChanged, setReadsChanged] = useState(0);
  const dragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // Latest CodeMirror selection, so Run can resolve a statement without React
  // state churn on every cursor move.
  const selectionRef = useRef<{ from: number; to: number }>({ from: 0, to: 0 });

  const tab = tabs.find((t) => t.id === activeTabId) ?? null;
  const tabId = tab?.id ?? null;
  const tabSql = tab?.sql ?? "";
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
    setSelection({ from: 0, to: 0 });
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

  // What the smart ranking chooses between, as names only: the model decides
  // between table and column names, and it never sees a row. One list serves both
  // halves — the flat table names for a bare identifier, and the same entries with
  // their columns for one behind a qualifier — so the two can never disagree about
  // which tables exist.
  const schemaTables = useMemo<SchemaTable[]>(() => {
    if (!sessionId || !database) return [];
    const entries = columnsCache[`${sessionId}||${database}`];
    if (!entries) return [];
    return entries.slice(0, MAX_COMPLETION_TABLES).map((entry) => ({
      table: entry.table,
      schema: entry.schema ?? null,
      columns: entry.columns.map((column) => column.name),
    }));
  }, [columnsCache, sessionId, database]);

  const tables = useMemo(() => schemaTables.map((entry) => entry.table), [schemaTables]);

  // Every name the schema holds, tables and columns alike, which is what a repair
  // question chooses between: a name that did not run could have been either, and
  // the failure is what says which one was meant.
  const allNames = useMemo(() => schemaNames(schemaTables), [schemaTables]);

  // What the last question to the model did. The indicator is its only reader,
  // and it is what lets "the model was unsure" be reported differently from
  // "no model answered".
  const [assistantCall, setAssistantCall] = useState<AssistantCall>({
    pending: false,
    response: null,
    failed: false,
    // Nothing has been asked yet: a bare position asks about tables.
    asked: "table",
  });

  // A new switch or a new model makes the last answer stale: it describes a
  // list this editor is no longer building.
  useEffect(() => {
    setAssistantCall({ pending: false, response: null, failed: false, asked: "table" });
  }, [assistant.smartAutocomplete, assistant.model]);

  /**
   * How a question reaches the model: it is asked of one model, by name, with the
   * statements a command would send carried alongside the line, so the one request
   * answers both which table the line means and how far running those statements
   * could go. Neither half waits for the other, and each reading costs a question
   * rather than a request.
   */
  const askModel = useCallback(
    (line: string, candidates: readonly string[], question: RankQuestion) =>
      ipc.rankCandidates({
        state: line,
        candidates: [...candidates],
        model: assistant.model,
        kind: question.kind,
        statements: question.statements,
      }),
    [assistant.model],
  );

  // The model's answers so far, so a question the editor has already put is not
  // put again and a line merely longer than an answered one costs nothing. It
  // holds the model it was built for, so switching models cannot answer from the
  // previous one's memory.
  const answers = useMemo(() => createRankCache({ ask: askModel }), [askModel]);

  /**
   * What the model has read about each statement it has answered about, keyed by
   * the statement itself. Rebuilt with the model, so one model's reading of a
   * statement is never shown as another's.
   */
  const reads = useMemo(() => createStatementReads(), [assistant.model]);

  /**
   * What the model suggested for each failure it has been shown, keyed by the
   * failure — the statement *and* the error, because a statement that failed two
   * different ways is two questions. Rebuilt with the model for the same reason
   * the readings are.
   */
  const repairs = useMemo(() => createStatementRepairs(), [assistant.model]);
  // Bumped when a suggestion lands, so the grid that draws one re-renders: the
  // suggestion lives in that store rather than in React state.
  const [repairsChanged, setRepairsChanged] = useState(0);

  /** File a reading, and let the badge know there is one. */
  const rememberReading = useCallback(
    (reading: StatementReading | null | undefined) => {
      if (!reading?.statement) return;
      reads.remember(reading);
      setReadsChanged((changed) => changed + 1);
    },
    [reads],
  );

  /**
   * How many ranking questions are out with the model right now.
   *
   * A ranking request already carries the statement under the cursor, so its
   * reply includes the reading the badge shows. Asking for that reading again in
   * a request of its own while the ranking is in flight is therefore the same
   * question twice — and the local model answers one request at a time, so the
   * second one can only make the list the user is waiting for wait longer
   * (measured: ~240 ms for one request, ~300 ms for the ranking when a reading
   * goes out beside it). The badge's own question waits for these to land
   * instead; see the effect below.
   */
  const [rankingsInFlight, setRankingsInFlight] = useState(0);

  // Ask the local model to rank candidates; a model that is off, missing, slow
  // or unsure answers with no opinion, which leaves the ordinary order in place.
  const rank = useCallback(
    async (line: string, candidates: readonly string[], question: RankQuestion) => {
      // Only a question that actually has to be put is work in flight. A
      // remembered answer would otherwise flash the indicator through "working"
      // on its way to the ranking it is already reporting.
      const asking = !answers.knows(line, candidates);
      if (asking) {
        setAssistantCall((current) =>
          current.pending && current.asked === question.kind
            ? current
            : { ...current, pending: true, asked: question.kind },
        );
        setRankingsInFlight((count) => count + 1);
      }
      try {
        const answered = await answers.rank(line, candidates, question);
        const { response } = answered;
        // Each reading echoes the statement the model was actually shown, which
        // for a reused answer may be shorter than the one the editor is holding.
        // Filing it under its own text is what stops the badge from ever naming a
        // statement the model did not see.
        for (const reading of response.readings) rememberReading(reading);
        setAssistantCall((current) =>
          current.response === response &&
          !current.pending &&
          !current.failed &&
          current.asked === question.kind
            ? current
            : { pending: false, response, failed: false, asked: question.kind },
        );
        return response.ranked;
      } catch {
        setAssistantCall({
          pending: false,
          response: null,
          failed: true,
          asked: question.kind,
        });
        return [];
      } finally {
        // Whatever the answer was, the model is free again — including when the
        // request failed, which is what lets the badge ask on its own.
        if (asking) setRankingsInFlight((count) => count - 1);
      }
    },
    [answers, rememberReading],
  );

  /**
   * The statements a Run would send, as the model is shown them: the selection
   * when there is one, and otherwise the statement under the cursor. Resolved the
   * same way the button resolves its text — `currentSql` calls the same function —
   * so the question and the run can never be about different SQL. This is the case
   * the cursor statement alone got wrong: a selection can hold several statements,
   * and Run sends all of them.
   */
  const runStatements = useMemo(
    () => statementsToRun(tabSql, selection.from, selection.to),
    [tabSql, selection],
  );

  /** Every statement of the tab, because the Script button sends all of them. */
  const scriptStatements = useMemo(() => statementsInScript(tabSql), [tabSql]);

  /** How many statements the tab holds, which is what "read 3 of 20" counts against. */
  const scriptTotal = useMemo(() => splitStatements(tabSql).length, [tabSql]);

  /**
   * The statements nothing has read yet, Run's set first and then the script's:
   * what the next question is about. This is how a script's reading fills in — each
   * pass asks about the statements that came up since the last — so a long file is
   * read over a few settles rather than in one enormous request. A statement the
   * model answered nothing about keeps no reading, and is asked about again only
   * when the SQL or the selection moves, which is what stops an absent model from
   * being asked in a loop.
   */
  const unread = useMemo(() => {
    const wanted: string[] = [];
    for (const statement of [...runStatements, ...scriptStatements]) {
      if (reads.get(statement) || wanted.includes(statement)) continue;
      wanted.push(statement);
      if (wanted.length >= MAX_RISK_STATEMENTS) break;
    }
    return wanted;
    // `readsChanged` is what makes a reading that just landed visible: the store
    // is not React state, so it cannot trigger this on its own.
  }, [runStatements, scriptStatements, reads, readsChanged]);

  // The worst reading among the statements each command would send, and how many of
  // the script's statements have a reading at all — the mark says which statement,
  // and how much of the file it can speak for.
  const runRisk = useMemo(
    () => worst(runStatements.map((statement) => reads.get(statement))),
    [runStatements, reads, readsChanged],
  );
  const scriptRisk = useMemo(
    () => worst(scriptStatements.map((statement) => reads.get(statement))),
    [scriptStatements, reads, readsChanged],
  );
  const scriptRead = useMemo(
    () => scriptStatements.filter((statement) => reads.get(statement) !== null).length,
    [scriptStatements, reads, readsChanged],
  );

  /**
   * Whether the ranking question should carry the statement under the cursor.
   * That reading is the one that can be had without a request of its own, so it is
   * worth asking for while it is wanted — and worth leaving out once it is in hand,
   * since prompt tokens spent on an answer the editor already holds buy nothing.
   * The callback reads the store rather than a snapshot, so it stays the same
   * function while the readings change — which is what keeps the editor's
   * extensions from being rebuilt on every reading that lands.
   */
  const riskNeeded = useCallback(
    (statement: string) => assistant.smartAutocomplete && reads.get(statement) === null,
    [reads, assistant.smartAutocomplete],
  );

  /**
   * Ask about the statements on their own, when nothing else is going to.
   *
   * A reading usually rides along with a ranking question — which is what makes it
   * cost no extra request — but that question is put by the completion source,
   * which can see only the statement the cursor is in. What a command would send is
   * more: a Run sends the selection, and the Script button sends the file. This
   * asks about everything else in one request, and about nothing that already has a
   * reading.
   */
  const askStatements = useCallback(
    async (statements: readonly string[]) => {
      try {
        const response = await ipc.rankCandidates({
          state: "",
          candidates: [],
          model: assistant.model,
          statements: [...statements],
        });
        for (const reading of response.readings) rememberReading(reading);
      } catch {
        // A reading the model could not give costs the badge and nothing else.
      }
    },
    [assistant.model, rememberReading],
  );

  /**
   * The failures of the last run, which are what a repair question is about.
   *
   * A failure is an event rather than a position: it does not wait for anything to
   * settle, and it is asked about once. The same failure will not be asked about
   * twice, because an answer is filed under the statement *and* the error it was
   * given for — a run that fails the same way again is answered from what the
   * model already said.
   */
  const failures = useMemo(() => failuresIn(tab?.result), [tab?.result]);

  /**
   * Ask the model which name a failed statement meant, once per failure.
   *
   * Two things are deliberately not done here. The question is not put when the
   * schema holds nothing close to what the failure named — a model asked to choose
   * between names the SQL never came near has no choice to make, and its answer
   * would be a guess dressed as a suggestion. And the answer is not second-guessed:
   * what comes back is filed as it was given, because the model is the one that
   * read the error and the SQL.
   */
  const askRepair = useCallback(
    async (statement: string, error: string) => {
      const candidates = repairCandidates(allNames, error);
      if (candidates.length < MIN_REPAIR_CANDIDATES) {
        // Remembered as asked with no suggestion, so this failure is not put to the
        // model again on every re-render.
        repairs.remember({ statement, error, name: null, confidence: 0, reason: null });
        setRepairsChanged((changed) => changed + 1);
        return;
      }
      try {
        const response = await ipc.rankCandidates({
          // Nothing is being typed, so there is no line for the state block; the
          // question is about the two halves of the failure, which travel with it.
          state: "",
          candidates,
          model: assistant.model,
          kind: "repair",
          statements: [statement],
          error,
        });
        repairs.remember(suggestionOf(statement, error, response));
        setRepairsChanged((changed) => changed + 1);
      } catch {
        // A request that failed is not an answer: forgetting it means the next run
        // — or the next failure — can ask again.
        repairs.forget(statement, error);
      }
    },
    [allNames, assistant.model, repairs],
  );

  useEffect(() => {
    if (!assistant.smartAutocomplete) return;
    for (const failure of failures) {
      // `start` is the claim: an answer already in hand, or a question already in
      // flight, keeps the question for itself.
      if (!repairs.start(failure.statement, failure.error)) continue;
      void askRepair(failure.statement, failure.error);
    }
  }, [failures, repairs, askRepair, assistant.smartAutocomplete]);

  /**
   * Put a suggestion into the statement and run it.
   *
   * The edit is the model's answer written where the text is wrong, and the run
   * that follows is an ordinary Run of the repaired statement — the same text the
   * button would send, so what runs is what the editor now holds. Nothing is
   * remembered as "fixed": a repair that still fails is a new failure, and it is
   * asked about like any other.
   */
  const fixRepair = useCallback(
    (repair: StatementRepair): (() => void) | null => {
      if (!tabId || !repair.name) return null;
      const mended = repairedStatement(repair.statement, repair.error, repair.name);
      if (!mended) return null;
      // The statement as the editor holds it. A failure whose SQL is no longer in
      // the tab — the user edited it, or a later run replaced the text — has
      // nothing to put right, and gets a hint without a button.
      const at = tabSql.indexOf(repair.statement);
      if (at < 0) return null;
      const next = `${tabSql.slice(0, at)}${mended}${tabSql.slice(at + repair.statement.length)}`;
      return () => {
        updateTab(tabId, { sql: next });
        void runTab(tabId, mended);
      };
    },
    [tabId, tabSql, updateTab, runTab],
  );

  /**
   * What the grid draws for a failure: the suggestion, and how to act on it — and
   * nothing when the assistant is switched off, which is what "off" has to mean
   * for a hint that is only ever an assist. The store is kept, so switching it back
   * on shows what the model already said rather than asking again.
   */
  const repairFor = useCallback(
    (statement: string, error: string): FailureRepair | null => {
      if (!assistant.smartAutocomplete) return null;
      const repair = repairs.get(statement, error);
      if (!repair) return null;
      return { repair, fix: fixRepair(repair) };
    },
    // `repairsChanged` is the suggestion arriving: the store is not React state,
    // so this is what turns a filed answer into a render the grid can see.
    [repairs, repairsChanged, assistant.smartAutocomplete, fixRepair],
  );

  useEffect(() => {
    if (!assistant.smartAutocomplete || unread.length === 0) return;
    // A ranking question in flight is already reading the statement under the
    // cursor, and its answer carries that reading. Waiting for it is what keeps the
    // badge from putting the same question to the model a second time — and from
    // making a single-model endpoint answer the list the user is waiting for behind
    // it. When the ranking lands, this effect runs again: by then that reading is in
    // hand (and is not asked for here), or the ranking answered without it and the
    // statement is asked about here.
    if (rankingsInFlight > 0) return;
    const timer = setTimeout(() => void askStatements(unread), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [unread, askStatements, assistant.smartAutocomplete, rankingsInFlight]);

  const assistantState = assistantStatus({
    enabled: assistant.smartAutocomplete,
    ...assistantCall,
  });

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

  /**
   * The two props the editor is handed that are *not* primitives, held still.
   *
   * `@uiw/react-codemirror` rebuilds the editor's whole configuration — a
   * `StateEffect.reconfigure` built from freshly created extensions — whenever
   * one of its props changes identity, and a rebuild discards the completion
   * state field: the open list is closed and restarted. An inline handler and an
   * inline object are new on every render, so the toolbar re-rendering for any
   * reason at all (the assistant indicator, a reading landing, a result) used to
   * restart the user's open list — and the ranking that arrives while a list is
   * being rebuilt is thrown away with it.
   */
  const handleSqlChange = useCallback(
    (value: string) => {
      if (tabId) updateTab(tabId, { sql: value });
    },
    [tabId, updateTab],
  );
  const basicSetup = useMemo(
    () => ({
      lineNumbers: editor.lineNumbers,
      highlightActiveLine: editor.highlightActiveLine,
      foldGutter: editor.foldGutter,
      autocompletion: editor.autocomplete,
    }),
    [editor.lineNumbers, editor.highlightActiveLine, editor.foldGutter, editor.autocomplete],
  );

  // Editor settings are extensions rather than props, so they are rebuilt when
  // any of them changes.
  const extensions = useMemo(
    () => [
      ...(usesSql ? [sql({ dialect, schema })] : []),
      // Smart autocomplete replaces the language's completion sources with a
      // wrapper that runs them and lifts the model's pick to the top. `@uiw`
      // appends this array after its basic setup, and the last `override` wins.
      ...(usesSql && editor.autocomplete && assistant.smartAutocomplete
        ? [
            autocompletion({
              override: [
                smartCompletionSource({
                  tables,
                  schema: schemaTables,
                  rank,
                  // So a list whose ranking is already in hand is shown ranked
                  // straight away, and only a genuinely new question is answered
                  // after the fact.
                  hasAnswer: answers.hasAnswer,
                  // And so the statement under the cursor is read only while the
                  // editor has no reading of it: carrying it costs prompt tokens,
                  // and carrying it for an answer already in hand buys nothing.
                  riskNeeded,
                }),
              ],
            }),
          ]
        : []),
      ...(editor.wordWrap ? [EditorView.lineWrapping] : []),
      EditorState.tabSize.of(Number(editor.tabSize)),
      indentUnit.of(" ".repeat(Number(editor.tabSize))),
      // Track the selection: Run resolves its SQL from it — a selection when there
      // is one, and the cursor's own position otherwise — and the question the
      // editor puts to the model is about exactly that SQL.
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) {
          const range = update.state.selection.main;
          selectionRef.current = { from: range.from, to: range.to };
          // Setting the value it already has is a no-op, which is what keeps an
          // ordinary keystroke from re-rendering twice.
          setSelection((current) =>
            current.from === range.from && current.to === range.to
              ? current
              : { from: range.from, to: range.to },
          );
        }
      }),
      activeStatementHighlight(),
    ],
    [
      usesSql,
      dialect,
      schema,
      editor.wordWrap,
      editor.tabSize,
      editor.autocomplete,
      assistant.smartAutocomplete,
      tables,
      schemaTables,
      rank,
      answers,
      riskNeeded,
    ],
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

        {/* What the local model read about the SQL Run would send — the selection
            when there is one, and otherwise the statement under the cursor — said
            before Run is pressed rather than after. */}
        <StatementRiskBadge read={runRisk} />

        <Button
          size="sm"
          variant="outline"
          onClick={() => void runTab(tab.id, tab.sql)}
          disabled={!session || tab.running || !tab.sql.trim()}
          title={
            scriptRisk && riskLabel(scriptRisk)
              ? wholeScriptTitle(scriptRisk, scriptRead, scriptTotal)
              : "Run whole script (⌘/Ctrl + Alt + Enter)"
          }
        >
          <ScrollText className="h-3.5 w-3.5" />
          Script
          {/* The whole file is about to run, so its own worst statement is marked
              here rather than folded into Run's badge: the two commands send
              different SQL, and one mark for both would be about neither. */}
          <StatementRiskBadge read={scriptRisk} subject="script" />
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

        {usesSql ? (
          <AssistantIndicator status={assistantState} call={assistantCall} />
        ) : null}

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
          onChange={handleSqlChange}
          basicSetup={basicSetup}
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
            repairFor={repairFor}
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
