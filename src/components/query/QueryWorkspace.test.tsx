// The DOM has to exist before CodeMirror is loaded, for the same reason
// `smartCompleteView.test.ts` imports it first: a module that decides at import
// time whether it is in a browser cannot be told afterwards.
import "@/lib/testDom.ts";

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { completionStatus, startCompletion } from "@codemirror/autocomplete";
import { StateEffect, type TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act } from "react";

import { QueryWorkspace } from "./QueryWorkspace.tsx";
import { SETTLE_MS } from "@/lib/rankCache.ts";
import { mergeSettings } from "@/lib/settings.ts";
import { installTestBackend, type TestBackend } from "@/lib/testBackend.ts";
import { click, closeDom, mount, type MountedComponent } from "@/lib/testRender.tsx";
import type {
  DriverDescriptor,
  RankCandidatesRequest,
  RankCandidatesResponse,
  RiskVerdict,
  SessionInfo,
  TableColumns,
} from "@/lib/types.ts";
import { useThemeStore } from "@/stores/theme.ts";
import { useWorkspace, type QueryTab } from "@/stores/workspace.ts";

/**
 * The editor as the workspace actually wires it: a tab of SQL in a real
 * CodeMirror, completing from a real schema, with the backend scripted.
 *
 * These are the two things no pure test can see — that the qualifier's names are
 * the ones the workspace puts in the request, and that the editor the user types
 * into keeps its open list while the rest of the workspace re-renders.
 */

const sqlite: DriverDescriptor = {
  id: "sqlite",
  displayName: "SQLite",
  defaultPort: 0,
  accentColor: "#003b57",
  capabilities: {
    queryLanguage: "sql",
    resultShape: "tabular",
    isRelational: true,
    supportsMultipleDatabases: false,
    supportsSchemas: false,
    supportsTransactions: true,
    supportsDdl: true,
    supportsExplain: true,
    supportsCancel: false,
    objectKinds: ["table"],
    supportedActions: [],
  },
  configFields: [],
};

const session: SessionInfo = {
  id: "s1",
  profileId: "p1",
  driver: "sqlite",
  name: "Ranking demo (SQLite)",
  server: {
    version: "3.45.0",
    currentDatabase: "main",
    currentUser: "",
    supportsTls: false,
  },
};

const COLUMNS: TableColumns[] = [
  {
    table: "orders",
    schema: null,
    columns: [
      { name: "id" },
      { name: "order_number" },
      { name: "ordered_at" },
      { name: "total_cents" },
    ],
  },
  { table: "orchards", schema: null, columns: [{ name: "id" }, { name: "acres" }] },
];

/** A dotted position: the token is `ord`, and the qualifier is a table. */
const SQL = "SELECT orders.ord";

function tab(): QueryTab {
  return {
    id: "t1",
    title: "Query 1",
    kind: "query",
    filePath: null,
    fileToken: null,
    sql: SQL,
    sessionId: "s1",
    database: "main",
    objectRef: null,
    editSource: null,
    preview: null,
    result: null,
    plan: null,
    error: null,
    running: false,
    explaining: false,
    cancelled: false,
    runId: null,
  };
}

/**
 * The model's answer: the column the SQL is about, which the language does not
 * put first — so a list that leads with it has been reordered rather than left
 * alone.
 */
const ANSWER: RankCandidatesResponse = {
  ranked: ["ordered_at", "order_number"],
  choice: "ordered_at",
  confidence: 0.9,
  available: true,
  reason: null,
  readings: [],
};

/** A reading as the client reports one, at the position the scale measured for it. */
function reading(statement: string, verdict: RiskVerdict, level: number) {
  return { statement, verdict, level, confidence: 0.96 };
}

/** The stores as they stood before any test touched them. */
const pristine = useWorkspace.getState();
const themePristine = useThemeStore.getState();

function seed() {
  // A concrete theme mode: `system` would ask the window for the user's
  // preference, and jsdom has no `matchMedia` to ask.
  useThemeStore.setState({ mode: "light" });
  useWorkspace.setState({
    drivers: [sqlite],
    sessions: [session],
    activeSessionId: "s1",
    tabs: [tab()],
    activeTabId: "t1",
    columnsCache: { "s1||main": COLUMNS },
    settings: mergeSettings({ assistant: { smartAutocomplete: true, model: "nimble" } }),
  });
}

function cleanup(t: TestContext, backend: TestBackend) {
  t.after(() => {
    backend.restore();
    useWorkspace.setState(pristine, true);
    useThemeStore.setState(themePristine, true);
    closeDom();
  });
}

/** Mount the workspace on the seeded tab, with the cursor at the end of the SQL. */
async function openEditor(t: TestContext): Promise<{ view: MountedComponent; cm: EditorView }> {
  const view = await mount(<QueryWorkspace />);
  t.after(view.unmount);

  const host = view.container.querySelector<HTMLElement>(".cm-editor");
  assert.ok(host, "the workspace mounted no editor");
  const cm = EditorView.findFromDOM(host);
  assert.ok(cm, "no CodeMirror view behind the editor element");

  // The cursor goes where a person's would be after typing the SQL out: at the
  // end. Anywhere else completes a keyword and asks a different question.
  await act(async () => {
    cm.dispatch({ selection: { anchor: cm.state.doc.length } });
  });
  return { view, cm };
}

/** Wait until `done` holds, letting the editor's own async work settle. */
async function waitFor(done: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (done()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The labels of the open completion list, top to bottom, as the user reads them. */
function labels(cm: EditorView): string[] {
  return [...cm.dom.querySelectorAll(".cm-tooltip-autocomplete li")].map(
    (item) => item.querySelector(".cm-completionLabel")?.textContent ?? "",
  );
}

/** An answer the test decides when to give. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** The questions the editor put to the backend that were about names at all. */
function rankingQuestions(backend: TestBackend): RankCandidatesRequest[] {
  return backend
    .argsFor("rank_candidates")
    .map((args) => args?.request as RankCandidatesRequest)
    .filter((request) => request.candidates.length > 0);
}

test("the workspace asks the model about the columns behind a qualifier", async (t) => {
  const backend = installTestBackend({ rank_candidates: () => ANSWER });
  cleanup(t, backend);
  seed();
  const { cm } = await openEditor(t);

  startCompletion(cm);
  await waitFor(() => completionStatus(cm.state) === "active", "the completion list to open");
  // The question itself waits out the same settle window the app uses, so an
  // open list is not yet a request on its way.
  await waitFor(() => rankingQuestions(backend).length > 0, "the question to be put");

  // The question the editor really put: the names behind the dot, and what they
  // are. Asking the schema's tables here would be a different question, and the
  // model would be answering about names that are not on screen.
  const asked = rankingQuestions(backend);
  assert.equal(asked.length, 1, "one completion session, one question");
  assert.deepEqual([...asked[0].candidates].sort(), ["order_number", "ordered_at"]);
  assert.equal(asked[0].kind, "column");
  assert.equal(asked[0].state, SQL, "the line under the cursor is the state");
  assert.deepEqual(
    asked[0].statements,
    [SQL],
    "and the statement a Run would send travels too, so reading it costs no second request",
  );

  // And the answer is the list the user sees, not a value that only the store
  // ever read.
  await waitFor(() => labels(cm)[0] === "ordered_at", "the column to lead the list");
  assert.equal(labels(cm)[0], "ordered_at");
});

/** Every effect a transaction spec carries, however it states them. */
function effectsOf(spec: TransactionSpec): readonly StateEffect<unknown>[] {
  const effects = spec.effects;
  if (!effects) return [];
  return Array.isArray(effects) ? effects : [effects as StateEffect<unknown>];
}

test("a re-render of the workspace does not rebuild the editor's configuration", async (t) => {
  const backend = installTestBackend({ rank_candidates: () => ANSWER });
  cleanup(t, backend);
  seed();
  const { cm } = await openEditor(t);

  startCompletion(cm);
  await waitFor(() => completionStatus(cm.state) === "active", "the completion list to open");
  await waitFor(() => labels(cm)[0] === "ordered_at", "the ranking to land");

  // What the editor is told while the user has a list open. A rebuild is what
  // `@uiw/react-codemirror` does whenever one of its props changes *identity*,
  // and a rebuild discards the completion state field: the list the user is
  // reading is recomputed, and a question still in flight is answered into a
  // list that is no longer there. An inline handler and an inline `basicSetup`
  // object are new on every render, so a plain re-render is what used to do it.
  //
  // `dispatch` is an own property of the view rather than a prototype method, so
  // the spy goes on the view itself.
  const dispatched: StateEffect<unknown>[] = [];
  const real = cm.dispatch.bind(cm);
  cm.dispatch = ((...specs: readonly TransactionSpec[]) => {
    for (const spec of specs) dispatched.push(...effectsOf(spec));
    return real(...specs);
  }) as EditorView["dispatch"];
  try {
    // The toolbar re-rendering for any reason at all — here a Run starting.
    await act(async () => {
      useWorkspace.getState().updateTab("t1", { running: true });
    });
  } finally {
    cm.dispatch = real as EditorView["dispatch"];
  }

  const rebuilt = dispatched.filter((effect) => effect.is(StateEffect.reconfigure));
  assert.deepEqual(
    rebuilt,
    [],
    "the re-render rebuilt the editor, which is what loses a ranking in flight",
  );
  // And the list the user was reading is still the one on screen.
  assert.equal(completionStatus(cm.state), "active");
  assert.equal(labels(cm)[0], "ordered_at", "the list kept its order");
});

test("the badge's reading arrives with the ranking, not on a request of its own", async (t) => {
  // The ranking answer is held open, so the moment the badge would otherwise ask
  // on its own is not a race: the point is that it never asks.
  const answer = deferred<RankCandidatesResponse>();
  const backend = installTestBackend({ rank_candidates: () => answer.promise });
  cleanup(t, backend);
  seed();
  const { view, cm } = await openEditor(t);

  startCompletion(cm);
  await waitFor(() => completionStatus(cm.state) === "active", "the completion list to open");
  await waitFor(() => rankingQuestions(backend).length > 0, "the ranking question to be put");

  // Well past the window a statement question waits out. A second request here
  // would be the same statement put to the same model twice, and the model
  // answers one request at a time — so the ranking the user is waiting for would
  // be answered behind it.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS + 120));
  });
  assert.deepEqual(
    backend.argsFor("rank_candidates").length,
    1,
    "the statement was put to the model twice",
  );

  // The reading comes back as the second half of that same reply, so the badge
  // still says its piece — about the statement a Run would send.
  await act(async () => {
    answer.resolve({ ...ANSWER, readings: [reading(SQL, "structure", 2.988)] });
  });
  await waitFor(
    () => view.text().includes("Removes a table"),
    "the badge to say what the model read",
  );
  assert.deepEqual(backend.argsFor("rank_candidates").length, 1, "and no second request was made");
});

/** A statement result, as the grid receives one — failed when it is given an error. */
function failed(statement: string, error?: string) {
  return {
    statement,
    isQuery: true,
    columns: [],
    rows: [],
    rowCount: 0,
    executionMs: 2,
    truncated: false,
    error: error ?? null,
  };
}

test("a statement that failed is asked about, and the answer is shown under the error", async (t) => {
  // The question the editor asks about a failure, and what it does with the answer:
  // a name under the database's own error, attributed to the model rather than
  // offered as a fix.
  const repair: RankCandidatesResponse = {
    ranked: ["ordered_at"],
    choice: "ordered_at",
    confidence: 0.94,
    available: true,
    reason: null,
    readings: [],
  };
  const backend = installTestBackend({
    rank_candidates: (args) => {
      const request = args?.request as RankCandidatesRequest;
      return request.kind === "repair" ? repair : ANSWER;
    },
  });
  cleanup(t, backend);
  seed();
  useWorkspace.setState({
    tabs: [
      {
        ...tab(),
        result: {
          results: [failed("SELECT ordred_at FROM orders", "no such column: ordred_at")],
          totalMs: 4,
        },
      },
    ],
  });
  const { view } = await openEditor(t);

  await waitFor(() => view.text().includes("Did you mean"), "the hint to appear");

  const asked = backend
    .argsFor("rank_candidates")
    .map((args) => args?.request as RankCandidatesRequest)
    .filter((request) => request.kind === "repair");
  assert.equal(asked.length, 1, "one failure, one question");
  // Both halves of the failure travel, because the question is about both: the SQL
  // that did not run and the error it produced.
  assert.deepEqual(asked[0].statements, ["SELECT ordred_at FROM orders"]);
  assert.equal(asked[0].error, "no such column: ordred_at");
  // And the names are the schema's own, close to what the SQL wrote — the name it
  // was reaching for among them, or the question would be unanswerable.
  assert.ok(
    asked[0].candidates.includes("ordered_at"),
    `the intended name was not offered: ${asked[0].candidates.join(", ")}`,
  );
  // Nothing is being typed, so there is no line for the state block.
  assert.equal(asked[0].state, "");

  const hint = view.container.querySelector("[data-statement-repair]");
  assert.ok(hint, "the grid drew no hint");
  assert.equal(hint.getAttribute("data-statement-repair"), "ordered_at");
  assert.equal(hint.textContent?.replace(/\s+/g, " ").trim(), "Did you mean ordered_at?");
  // The confidence is part of the claim: this is the model's answer, and how sure
  // it was of it is what the reader is entitled to know.
  assert.match(hint.getAttribute("title") ?? "", /94%/);
  // The error itself is still there, above it: the hint is beside the fact, not
  // instead of it.
  assert.match(view.text(), /no such column: ordred_at/);
});

test("the suggestion can be written into the statement and run", async (t) => {
  // The half of the feature that acts: the answer becomes the statement, in the
  // editor, and is run — the same text the Run button would send, so what runs is
  // what the person now sees.
  const repair: RankCandidatesResponse = {
    ranked: ["ordered_at"],
    choice: "ordered_at",
    confidence: 0.94,
    available: true,
    reason: null,
    readings: [],
  };
  const backend = installTestBackend({
    rank_candidates: (args) =>
      (args?.request as RankCandidatesRequest).kind === "repair" ? repair : ANSWER,
    execute_query: (args) => {
      const request = args?.request as { sql: string };
      return {
        results: [
          {
            statement: request.sql,
            isQuery: true,
            columns: [],
            rows: [],
            rowCount: 0,
            executionMs: 1,
            truncated: false,
            error: null,
          },
        ],
        totalMs: 2,
      };
    },
  });
  cleanup(t, backend);
  seed();
  useWorkspace.setState({
    tabs: [
      {
        ...tab(),
        sql: "SELECT ordred_at FROM orders",
        result: {
          results: [failed("SELECT ordred_at FROM orders", "no such column: ordred_at")],
          totalMs: 4,
        },
      },
    ],
  });
  const { view } = await openEditor(t);

  await waitFor(() => view.text().includes("Did you mean"), "the hint to appear");
  const button = view.container.querySelector<HTMLElement>("[data-statement-repair-fix]");
  assert.ok(button, "the hint offered nothing to do about it");
  // A control that rewrites the editor and runs it says so before it is pressed.
  assert.match(button.getAttribute("title") ?? "", /Writes ordered_at into the statement/);

  await click(view, "Fix and run");

  await waitFor(
    () => useWorkspace.getState().tabs[0]?.sql === "SELECT ordered_at FROM orders",
    "the statement to be mended",
  );
  const sent = backend.argsFor("execute_query");
  assert.equal(sent.length, 1, "the repaired statement was not run exactly once");
  assert.equal((sent[0]?.request as { sql: string }).sql, "SELECT ordered_at FROM orders");
});

test("only the statement that failed is mended, and only it is run", async (t) => {
  // A script fails on one of its statements: the repair belongs to that statement,
  // and the rest of the file is left exactly as the user wrote it. Running the
  // repaired statement alone is what the Run button would do with the cursor in it.
  const repair: RankCandidatesResponse = {
    ranked: ["ordered_at"],
    choice: "ordered_at",
    confidence: 0.94,
    available: true,
    reason: null,
    readings: [],
  };
  const script = "SELECT ordred_at FROM orders;\nSELECT 1;";
  const backend = installTestBackend({
    rank_candidates: (args) =>
      (args?.request as RankCandidatesRequest).kind === "repair" ? repair : ANSWER,
    execute_query: (args) => {
      const request = args?.request as { sql: string };
      return {
        results: [
          {
            statement: request.sql,
            isQuery: true,
            columns: [],
            rows: [],
            rowCount: 0,
            executionMs: 1,
            truncated: false,
            error: null,
          },
        ],
        totalMs: 2,
      };
    },
  });
  cleanup(t, backend);
  seed();
  useWorkspace.setState({
    tabs: [
      {
        ...tab(),
        sql: script,
        // The failing statement first: the grid shows one statement at a time, and
        // the run stopped there — which is why the rest of the script never ran.
        result: {
          results: [
            failed("SELECT ordred_at FROM orders", "no such column: ordred_at"),
            failed("SELECT 1"),
          ],
          totalMs: 4,
        },
      },
    ],
  });
  const { view } = await openEditor(t);

  await waitFor(() => view.text().includes("Did you mean"), "the hint to appear");
  await click(view, "Fix and run");

  await waitFor(
    () => useWorkspace.getState().tabs[0]?.sql === "SELECT ordered_at FROM orders;\nSELECT 1;",
    "the failing statement to be mended in place",
  );
  const sent = backend.argsFor("execute_query");
  assert.equal(sent.length, 1, "more than the repaired statement was run");
  assert.equal((sent[0]?.request as { sql: string }).sql, "SELECT ordred_at FROM orders".replace("ordred_at", "ordered_at"));
});

test("a failure whose statement is no longer in the editor offers no button", async (t) => {
  // A hint is worth showing for the failure that happened, but a *fix* is only
  // worth offering while the text it would mend is still there: the editor may
  // have been rewritten since, and a button that changed nothing would be worse
  // than no button.
  const repair: RankCandidatesResponse = {
    ranked: ["ordered_at"],
    choice: "ordered_at",
    confidence: 0.94,
    available: true,
    reason: null,
    readings: [],
  };
  const backend = installTestBackend({
    rank_candidates: (args) =>
      (args?.request as RankCandidatesRequest).kind === "repair" ? repair : ANSWER,
  });
  cleanup(t, backend);
  seed();
  useWorkspace.setState({
    tabs: [
      {
        ...tab(),
        // The tab holds other SQL now — the failing text was edited away.
        sql: "SELECT 1",
        result: {
          results: [failed("SELECT ordred_at FROM orders", "no such column: ordred_at")],
          totalMs: 4,
        },
      },
    ],
  });
  const { view } = await openEditor(t);

  await waitFor(() => view.text().includes("Did you mean"), "the hint to appear");
  assert.equal(
    view.container.querySelector("[data-statement-repair-fix]"),
    null,
    "a fix was offered for a statement the editor no longer holds",
  );
});

test("a failure nothing in the schema is close to gets no question and no hint", async (t) => {
  // The rule that keeps a guess from ever being shown as an answer: a model asked
  // to choose between names the SQL never came near has no choice to make, so it is
  // not asked. The screen keeps the error and gains nothing else.
  const backend = installTestBackend({ rank_candidates: () => ANSWER });
  cleanup(t, backend);
  seed();
  useWorkspace.setState({
    tabs: [
      {
        ...tab(),
        result: {
          results: [failed("SELECT profit_margin_eur FROM orders", "no such column: profit_margin_eur")],
          totalMs: 4,
        },
      },
    ],
  });
  const { view } = await openEditor(t);

  await waitFor(
    () => view.text().includes("profit_margin_eur"),
    "the failure to be on screen",
  );
  // Long enough for a question to have been put and answered, if one were going to
  // be.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS + 120));
  });
  const repairs = backend
    .argsFor("rank_candidates")
    .map((args) => args?.request as RankCandidatesRequest)
    .filter((request) => request.kind === "repair");
  assert.deepEqual(repairs, [], "a question was put with nothing to choose between");
  assert.equal(view.container.querySelector("[data-statement-repair]"), null);
});

test("an answer the model did not stand behind draws no hint", async (t) => {
  // A declination and an unsure answer are both "no suggestion": the decision layer
  // reports them with an empty `ranked` while still filling in `choice`, and a
  // client that read that as a suggestion would offer a name the model refused to
  // back.
  const declined: RankCandidatesResponse = {
    ranked: [],
    choice: null,
    confidence: 0.941,
    available: true,
    reason: "no listed name fits the error",
    readings: [],
  };
  const backend = installTestBackend({
    rank_candidates: (args) =>
      (args?.request as RankCandidatesRequest).kind === "repair" ? declined : ANSWER,
  });
  cleanup(t, backend);
  seed();
  useWorkspace.setState({
    tabs: [
      {
        ...tab(),
        result: {
          results: [failed("SELECT ordred_at FROM orders", "no such column: ordred_at")],
          totalMs: 4,
        },
      },
    ],
  });
  const { view } = await openEditor(t);

  await waitFor(
    () =>
      backend
        .argsFor("rank_candidates")
        .some((args) => (args?.request as RankCandidatesRequest).kind === "repair"),
    "the question to be put",
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS + 120));
  });
  assert.equal(view.container.querySelector("[data-statement-repair]"), null);
  // Asked once and answered once: a declination is an answer, so it is not put to
  // the model again on the next render.
  assert.equal(
    backend
      .argsFor("rank_candidates")
      .filter((args) => (args?.request as RankCandidatesRequest).kind === "repair").length,
    1,
    "a declined failure was asked about twice",
  );
});

test("a list left in its own order says which question went unanswered", async (t) => {
  // A column behind a qualifier is the question the model is least sure about —
  // the one measured between 0.03 and 0.20 against a 0.15 threshold — so a list
  // that keeps its own order is the ordinary outcome there, not a fault. "AI
  // unsure" alone leaves the user to guess between a broken assistant and a hard
  // question; the pill has to name the question and quote the model.
  const unsure: RankCandidatesResponse = {
    ranked: [],
    choice: "order_number",
    confidence: 0.32,
    available: true,
    reason: "the model was not sure enough (0.32 below 0.15)",
    // A reading, so the badge has one and does not put its own question: this
    // test is about the pill the ranking alone decides.
    readings: [reading(SQL, "bounded", 1.0)],
  };
  const backend = installTestBackend({ rank_candidates: () => unsure });
  cleanup(t, backend);
  seed();
  const { view, cm } = await openEditor(t);

  startCompletion(cm);
  await waitFor(() => completionStatus(cm.state) === "active", "the completion list to open");
  await waitFor(() => rankingQuestions(backend).length > 0, "the question to be put");
  await waitFor(
    () => view.container.querySelector("[data-assistant-status=\"uncertain\"]") !== null,
    "the pill to report an answer it did not act on",
  );

  // The list on screen is still the language's own: the model had no opinion,
  // and no opinion is not a reordering.
  assert.equal(labels(cm)[0], "order_number", "an unsure answer moved the list anyway");

  const pill = view.container.querySelector<HTMLElement>("[data-assistant-status]");
  assert.ok(pill, "the workspace rendered no assistant pill");
  const title = pill.getAttribute("title") ?? "";
  assert.match(title, /which column you meant/, "the pill did not say what was asked about");
  assert.doesNotMatch(title, /table/, "a column question was explained as a table one");
  assert.match(title, /0\.32/, "the model's own words did not reach the user");
  assert.deepEqual(
    backend.argsFor("rank_candidates").length,
    1,
    "an answer with nothing to say cost a second question",
  );
});

test("a ranking answer with no reading still leaves the badge to ask", async (t) => {
  // The other half of the rule: the badge waits for a ranking question, it does
  // not depend on one. A model that answered the ranking without the reading —
  // or a request that failed — must not leave the badge silent for good.
  const rankingOnly: RankCandidatesResponse = { ...ANSWER, readings: [] };
  const answeredAlone: RankCandidatesResponse = {
    ranked: [],
    choice: null,
    confidence: 0,
    available: true,
    reason: null,
    readings: [reading(SQL, "structure", 2.988)],
  };
  const backend = installTestBackend({
    rank_candidates: (args) => {
      const request = args?.request as RankCandidatesRequest;
      return request.candidates.length > 0 ? rankingOnly : answeredAlone;
    },
  });
  cleanup(t, backend);
  seed();
  const { view, cm } = await openEditor(t);

  startCompletion(cm);
  await waitFor(() => labels(cm)[0] === "ordered_at", "the ranking to land");

  await waitFor(
    () => view.text().includes("Removes a table"),
    "the badge to ask on its own once the ranking was answered",
  );
  const asked = backend.argsFor("rank_candidates");
  const alone = asked.filter(
    (args) => (args?.request as RankCandidatesRequest).candidates.length === 0,
  );
  assert.equal(alone.length, 1, "the statement was asked about exactly once on its own");
  assert.deepEqual((alone[0]?.request as RankCandidatesRequest).statements, [SQL]);
});

test("a selection is read in full, and the badge names the statement that is dangerous", async (t) => {
  // What Run sends is the selection, so the question is about the selection. A
  // badge that described only the statement under the cursor would say nothing
  // about the `DROP` on the last line — which is the statement about to run.
  const selected = "SELECT 1;\nDROP TABLE orders;";
  const backend = installTestBackend({
    rank_candidates: (args) => {
      const request = args?.request as RankCandidatesRequest;
      return {
        ranked: [],
        choice: null,
        confidence: 0,
        available: true,
        reason: null,
        // The model answers about each statement it was asked about, echoing it.
        readings: (request.statements ?? []).map((statement) =>
          statement.startsWith("DROP")
            ? reading(statement, "structure", 2.988)
            : reading(statement, "safe", 0.018),
        ),
      };
    },
  });
  cleanup(t, backend);
  seed();
  useWorkspace.setState({ tabs: [{ ...tab(), sql: selected }] });
  const { view, cm } = await openEditor(t);

  // Select the whole script, which is what Run would then send.
  await act(async () => {
    cm.dispatch({ selection: { anchor: 0, head: cm.state.doc.length } });
  });

  await waitFor(
    () => view.container.querySelector('[data-statement-risk-subject="run"]') !== null,
    "the selection to be read",
  );
  const asked = backend
    .argsFor("rank_candidates")
    .map((args) => args?.request as RankCandidatesRequest)
    .filter((request) => (request.statements ?? []).length > 0);
  assert.deepEqual(
    asked[0].statements,
    ["SELECT 1", "DROP TABLE orders"],
    "the selection was not read in full",
  );
  const mark = view.container.querySelector('[data-statement-risk-subject="run"]');
  assert.equal(mark?.getAttribute("data-statement-risk"), "structure");
  assert.match(view.text(), /Removes a table/);
  // The whole script is selected, so the Script button's own mark agrees — and it
  // is a separate mark, because the two commands can send different SQL.
  assert.ok(
    view.container.querySelector('[data-statement-risk-subject="script"]'),
    "the Script button's own mark went missing",
  );
});

test("a script is read even while the cursor sits in a harmless statement", async (t) => {
  // The hole this closes: the Script button sends the whole file, and the cursor
  // being in a `SELECT` says nothing about the `TRUNCATE` below it.
  const script = "SELECT 1;\nTRUNCATE TABLE orders;";
  const backend = installTestBackend({
    rank_candidates: (args) => {
      const request = args?.request as RankCandidatesRequest;
      return {
        ranked: [],
        choice: null,
        confidence: 0,
        available: true,
        reason: null,
        readings: (request.statements ?? []).map((statement) =>
          statement.startsWith("TRUNCATE")
            ? reading(statement, "rows", 1.973)
            : reading(statement, "safe", 0.018),
        ),
      };
    },
  });
  cleanup(t, backend);
  seed();
  useWorkspace.setState({ tabs: [{ ...tab(), sql: script }] });
  const { view, cm } = await openEditor(t);

  // The cursor goes back into the `SELECT`: Run would send that one alone.
  await act(async () => {
    cm.dispatch({ selection: { anchor: 3 } });
  });

  await waitFor(
    () => view.container.querySelector('[data-statement-risk-subject="script"]') !== null,
    "the script's own statements to be read",
  );
  assert.equal(
    view.container.querySelector('[data-statement-risk-subject="run"]'),
    null,
    "the harmless statement Run would send was marked anyway",
  );
  const mark = view.container.querySelector('[data-statement-risk-subject="script"]');
  assert.equal(mark?.getAttribute("data-statement-risk"), "rows");
  // The mark's own words, quoted from the model's scale, and the statement they
  // are about — which for a command that sends a whole file is the whole point.
  assert.match(mark?.getAttribute("title") ?? "", /removes or rewrites every row of a table/);
  assert.match(mark?.getAttribute("title") ?? "", /TRUNCATE TABLE orders/);
  // And the button itself says how much of the file has been read, because the
  // statements nobody has read are the ones its mark cannot speak for.
  const scriptButton = [...view.container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Script"),
  );
  assert.match(scriptButton?.getAttribute("title") ?? "", /2 of 2 statements/);
});
