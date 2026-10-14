// The DOM has to exist before CodeMirror is loaded, so this import comes first
// for the same reason `testRender` puts it first: a module that decides at
// import time whether it is in a browser cannot be told afterwards.
import "./testDom.ts";

import test from "node:test";
import assert from "node:assert/strict";

import {
  autocompletion,
  closeCompletion,
  completionStatus,
  currentCompletions,
  startCompletion,
} from "@codemirror/autocomplete";
import { sql, type SQLNamespace } from "@codemirror/lang-sql";
import { EditorState, StateEffect, Transaction, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { createRankCache, type RankQuestion } from "./rankCache.ts";
import { smartCompletionSource, stillAskedThere } from "./smartComplete.ts";
import type { SchemaTable } from "./sqlQualifier.ts";
import type { RankCandidatesResponse } from "./types.ts";

const TABLES = ["orders", "order_items", "orchards"];

/** A schema with columns, which is what a dotted position completes from. */
const COLUMNS: SchemaTable[] = [
  { table: "orders", schema: null, columns: ["id", "order_number", "ordered_at", "total_cents"] },
  { table: "order_items", schema: null, columns: ["id", "order_id", "quantity"] },
];

/** Two schemas, so a schema-qualified position has something to leave out. */
const TWO_SCHEMAS: SchemaTable[] = [
  { table: "orders", schema: "shop", columns: ["id", "total_cents"] },
  { table: "order_items", schema: "shop", columns: ["id", "order_id"] },
  { table: "order_archive", schema: "cold", columns: ["id"] },
];
/** The document every case types, with the cursor left at its end. */
const DOC = "SELECT * FROM or";

function schemaOf(names: readonly string[]): SQLNamespace {
  const root: Record<string, unknown> = {};
  for (const name of names) {
    root[name] = { self: { label: name, type: "class" }, children: [] };
  }
  return root as SQLNamespace;
}

/** What the source handed the model, so the chain is pinned end to end. */
interface Asked {
  line: string;
  candidates: string[];
  question: RankQuestion;
}

/** An answer the test decides when to give. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** What the editor hands its completion source to get a ranking. */
type Rank = (
  line: string,
  candidates: readonly string[],
  question: RankQuestion,
) => Promise<readonly string[]>;

/**
 * The namespace `QueryWorkspace` builds from the same entries: each table with its
 * columns under it, and each schema grouping its own tables. A dotted position
 * completes from this, which is what a qualifier's names have to come from.
 */
function namespaceOf(entries: readonly SchemaTable[]): SQLNamespace {
  const root: Record<string, unknown> = {};
  const qualified: Record<string, Record<string, unknown>> = {};
  for (const entry of entries) {
    const table = {
      self: { label: entry.table, type: "class" },
      children: entry.columns.map((name) => ({ label: name, type: "property" })),
    };
    root[entry.table] = table;
    if (entry.schema) (qualified[entry.schema] ??= {})[entry.table] = table;
  }
  for (const [name, children] of Object.entries(qualified)) {
    root[name] ??= { self: { label: name, type: "namespace" }, children };
  }
  return root as SQLNamespace;
}

/**
 * A real editor configured exactly as `QueryWorkspace` configures it: the SQL
 * language plus an `autocompletion` whose `override` is the smart source. The
 * language registers *two* completion sources (schema and keywords), so this
 * also exercises the source's merge path.
 */
function mountEditorWith(
  rank: Rank,
  hasAnswer: (line: string, candidates: readonly string[]) => boolean,
  doc: string = DOC,
  schema: readonly SchemaTable[] | null = null,
): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      // The cursor is what `startCompletion` completes at; without this it
      // would sit at the start of the document and there would be no token.
      selection: { anchor: doc.length },
      extensions: [
        sql({ schema: schema ? namespaceOf(schema) : schemaOf(TABLES) }),
        autocompletion({
          override: [
            smartCompletionSource({
              tables: schema ? schema.map((entry) => entry.table) : TABLES,
              schema: schema ?? undefined,
              rank,
              hasAnswer,
            }),
          ],
        }),
      ],
    }),
    parent: document.body,
  });
}

/**
 * The editor's extension set, rebuilt the way a changed prop rebuilds it:
 * `@uiw/react-codemirror` dispatches exactly this whenever one of its props
 * changes identity. What matters here is what it does to an open list, not the
 * extensions themselves.
 */
function rebuiltExtensions(): Extension[] {
  return [
    sql({ schema: schemaOf(TABLES) }),
    autocompletion({
      override: [
        smartCompletionSource({
          tables: TABLES,
          rank: async () => [],
          hasAnswer: () => false,
        }),
      ],
    }),
  ];
}

/** The `rank` `QueryWorkspace` hands the source: a cache in front of the model. */
function cachedRank(
  ask: (line: string, candidates: readonly string[]) => Promise<RankCandidatesResponse>,
  asked: Asked[],
  rankOf: (response: RankCandidatesResponse) => readonly string[] = (r) => r.ranked,
) {
  // The settle window is off: this is about which questions are asked and what
  // the list does with the answers, and `rankCache.test.ts` times the window.
  const answers = createRankCache({
    ask: async (line, candidates, question) => {
      asked.push({ line, candidates: [...candidates], question });
      return ask(line, candidates);
    },
    settle: 0,
  });
  return {
    hasAnswer: answers.hasAnswer,
    rank: async (line: string, candidates: readonly string[], question: RankQuestion) => {
      const { response } = await answers.rank(line, candidates, question);
      return rankOf(response);
    },
  };
}

/** An answer that ranks one table first. */
function ranking(name: string): RankCandidatesResponse {
  return {
    ranked: [name, ...TABLES.filter((table) => table !== name)],
    choice: name,
    confidence: 0.9,
    available: true,
    reason: null,
    readings: [],
  };
}

/** An editor whose model answers with a fixed ranking. */
function mountRankedEditor(
  answer: RankCandidatesResponse,
  asked: Asked[] = [],
): EditorView {
  const wired = cachedRank(async () => answer, asked);
  return mountEditorWith(wired.rank, wired.hasAnswer);
}

/** The editor both of those build on, with a scripted plain answer. */
function mountEditor(answer: readonly string[], asked: Asked[]): EditorView {
  return mountEditorWith(async (line, candidates, question) => {
    asked.push({ line, candidates: [...candidates], question });
    return answer;
  }, () => true);
}

/** Open the completion popup and wait until the async source has answered. */
async function openCompletions(view: EditorView): Promise<void> {
  startCompletion(view);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (completionStatus(view.state) === "active") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`completion never became active: ${completionStatus(view.state)}`);
}

/** Wait until `done` holds, letting the editor's own async work settle. */
async function waitFor(done: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The labels of the open list, in the order the user would read them. */
function visibleLabels(view: EditorView): string[] {
  const rendered = [...view.dom.querySelectorAll(".cm-tooltip-autocomplete li")].map(
    (item) => item.querySelector(".cm-completionLabel")?.textContent ?? "",
  );
  // The rendered list is the observable answer; the state is the fallback if a
  // future CodeMirror stops marking the tooltip up the same way.
  return rendered.length > 0
    ? rendered
    : currentCompletions(view.state).map((completion) => completion.label);
}

/** The table names of a list, keeping their relative order. */
function tablesIn(labels: readonly string[]): string[] {
  return labels.filter((label) => TABLES.includes(label));
}

/** The table the open list leads with, once it has been read. */
function leadsWith(view: EditorView): string | undefined {
  return tablesIn(visibleLabels(view))[0];
}

test("the model is asked about exactly the tables the token could complete to", async () => {
  const asked: Asked[] = [];
  const view = mountRankedEditor(ranking("order_items"), asked);
  try {
    await openCompletions(view);
    assert.equal(asked.length, 1, "one completion session, one question");
    assert.equal(asked[0].line, DOC, "the line under the cursor is the state");
    assert.deepEqual([...asked[0].candidates].sort(), [...TABLES].sort());
    assert.deepEqual(
      asked[0].question.statements,
      [DOC],
      "and the statement it sits in travels too, so it costs no second request",
    );
    assert.equal(asked[0].question.kind, "table", "and what the names are");
  } finally {
    view.destroy();
  }
});

test("the question carries the whole statement, not just the line", async () => {
  // The statement is what Run would send, and the risk question is about all of
  // it — so a source that sent the line, or the document, would be wrong in a way
  // a single-line document could not show.
  const asked: Asked[] = [];
  const wired = cachedRank(async () => ranking("orders"), asked);
  const view = mountEditorWith(wired.rank, wired.hasAnswer, "SELECT 1;\nSELECT *\nFROM or");
  try {
    await openCompletions(view);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].line, "FROM or", "the line is the ranking's question");
    assert.deepEqual(
      asked[0].question.statements,
      ["SELECT *\nFROM or"],
      "the statement is the whole thing the cursor is in",
    );
  } finally {
    view.destroy();
  }
});

test("the list is open before the model has answered, then it is reordered", async () => {
  // The whole point of the two passes: the user never waits for the model. This
  // answer is held open by the test so the order before it lands is not a race.
  const answer = deferred<RankCandidatesResponse>();
  const asked: Asked[] = [];
  const wired = cachedRank(() => answer.promise, asked);
  const view = mountEditorWith(wired.rank, wired.hasAnswer);
  try {
    await openCompletions(view);
    assert.equal(
      leadsWith(view),
      "orchards",
      "the language's own order is on screen while the model is still thinking",
    );

    answer.resolve(ranking("orders"));
    await waitFor(() => leadsWith(view) === "orders", "the ranking to be applied");
    assert.equal(leadsWith(view), "orders", "the answer reordered the open list");
    assert.equal(asked.length, 1, "and the rebuild asked nothing");
  } finally {
    view.destroy();
  }
});

test("a list whose answer is already in hand opens ranked", async () => {
  const asked: Asked[] = [];
  const view = mountRankedEditor(ranking("orders"), asked);
  try {
    await openCompletions(view);
    // The answer arrives in the same turn for a local model this fast, so the
    // list may be shown either way; what must hold is that it ends up ranked.
    await waitFor(() => leadsWith(view) === "orders", "the ranking to be applied");
    assert.equal(leadsWith(view), "orders");
  } finally {
    view.destroy();
  }
});

test("typing on inside the word does not ask the model again", async () => {
  const asked: Asked[] = [];
  const view = mountRankedEditor(ranking("order_items"), asked);
  try {
    await openCompletions(view);
    await waitFor(() => leadsWith(view) === "order_items", "the ranking to be applied");
    assert.equal(asked.length, 1);

    // One more character of the same identifier, annotated the way the editor
    // annotates a real keystroke — an unannotated dispatch is a programmatic
    // change and CodeMirror discards the open list for it. The SQL language's
    // own `validFor` is what decides whether the source is asked again.
    view.dispatch({
      changes: { from: DOC.length, insert: "d" },
      annotations: Transaction.userEvent.of("input.type"),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(completionStatus(view.state), "active", "the list stayed open");
    assert.equal(asked.length, 1, "the open answer was reused, not re-asked");
  } finally {
    view.destroy();
  }
});

test("a qualifier ranks the columns behind it, as a column question", async () => {
  const asked: Asked[] = [];
  const wired = cachedRank(async () => ranking("ordered_at"), asked);
  const view = mountEditorWith(wired.rank, wired.hasAnswer, "SELECT orders.ord", COLUMNS);
  try {
    await openCompletions(view);
    assert.equal(asked.length, 1, "one completion session, one question");
    // The token is `ord`, so the candidates are the table's columns that could
    // still complete to it. The schema's tables are the other question — and the
    // wrong one here — which is what `kind` tells the model.
    assert.deepEqual([...asked[0].candidates].sort(), ["order_number", "ordered_at"]);
    assert.equal(asked[0].question.kind, "column");
    assert.equal(asked[0].line, "SELECT orders.ord", "the line is the state");
    // The list the language produced is reordered around the model's pick, with
    // the keywords it offered alongside them left where they were.
    await waitFor(() => visibleLabels(view)[0] === "ordered_at", "the columns to be ranked");
    assert.equal(visibleLabels(view)[0], "ordered_at");
  } finally {
    view.destroy();
  }
});

test("a schema qualifier ranks the tables it actually offers", async () => {
  const asked: Asked[] = [];
  const wired = cachedRank(async () => ranking("orders"), asked);
  const view = mountEditorWith(wired.rank, wired.hasAnswer, "SELECT shop.ord", TWO_SCHEMAS);
  try {
    await openCompletions(view);
    assert.equal(asked.length, 1);
    // `order_archive` matches the token too, but it lives in another schema and
    // the language does not offer it here. Asking about a name that is not on
    // screen would cost a request and reorder nothing.
    assert.deepEqual([...asked[0].candidates].sort(), ["order_items", "orders"]);
    assert.equal(asked[0].question.kind, "table", "a schema's members are tables");
  } finally {
    view.destroy();
  }
});

test("a quoted qualifier is the same question as an unquoted one", async () => {
  // Measured against `@codemirror/lang-sql`: `"orders".` offers exactly the
  // columns `orders.` offers, so a script that quotes its identifiers gets the
  // column question rather than falling back to a table question about names
  // that are not in the list at all.
  const asked: Asked[] = [];
  const wired = cachedRank(async () => ranking("ordered_at"), asked);
  const view = mountEditorWith(wired.rank, wired.hasAnswer, 'SELECT "orders".ord', COLUMNS);
  try {
    await openCompletions(view);
    assert.equal(asked.length, 1, "one completion session, one question");
    assert.deepEqual([...asked[0].candidates].sort(), ["order_number", "ordered_at"]);
    assert.equal(asked[0].question.kind, "column");
    await waitFor(() => visibleLabels(view)[0] === "ordered_at", "the quoted table's columns to rank");
    assert.equal(visibleLabels(view)[0], "ordered_at");
  } finally {
    view.destroy();
  }
});

test("a qualifier the language did not resolve costs no model call", async () => {
  // The language resolves a name **exactly**, case included, and does not follow
  // a quoted schema prefix — so `ORDERS.` and `"shop".orders.` offer the bare
  // list. Asking about the columns behind them would be a request whose every
  // candidate is absent from the list, which is a model call that can reorder
  // nothing.
  for (const doc of ["SELECT ORDERS.ord", 'SELECT "shop".orders.ord']) {
    const asked: Asked[] = [];
    const wired = cachedRank(async () => ranking("ordered_at"), asked);
    const view = mountEditorWith(wired.rank, wired.hasAnswer, doc, COLUMNS);
    try {
      await openCompletions(view);
      // Well past the point the question would have been put.
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.deepEqual(asked, [], `${doc} asked the model about a list that is not on screen`);
    } finally {
      view.destroy();
    }
  }
});

test("the model's answer changes the order the suggestions are shown in", async () => {
  // The same editor and the same schema; only the model's answer differs.
  const baseline = mountRankedEditor({ ...ranking("orders"), ranked: [] });
  const ranked = mountRankedEditor(ranking("order_items"));
  try {
    await openCompletions(baseline);
    await openCompletions(ranked);
    await waitFor(() => leadsWith(ranked) === "order_items", "the ranking to land");

    // Ranking reorders rather than replaces: every table is still offered.
    assert.deepEqual([...tablesIn(visibleLabels(baseline))].sort(), [...TABLES].sort());
    assert.deepEqual([...tablesIn(visibleLabels(ranked))].sort(), [...TABLES].sort());

    // Without an answer the ordinary match order stands; with one, the table the
    // model named leads it.
    assert.equal(leadsWith(baseline), "orchards", "the fixture's start order");
    assert.equal(leadsWith(ranked), "order_items");
  } finally {
    baseline.destroy();
    ranked.destroy();
  }
});

test("the rendered popup really is the reordered list", async () => {
  // `orders` starts last, so leading proves the ranking did the work rather
  // than the language's own order happening to agree.
  const view = mountRankedEditor(ranking("orders"));
  try {
    await openCompletions(view);
    await waitFor(() => leadsWith(view) === "orders", "the ranking to be applied");
    const rendered = [...view.dom.querySelectorAll(".cm-tooltip-autocomplete li")];
    assert.ok(rendered.length > 0, "the popup is on screen");
    const labels = rendered.map(
      (item) => item.querySelector(".cm-completionLabel")?.textContent ?? "",
    );
    assert.equal(tablesIn(labels)[0], "orders");
  } finally {
    view.destroy();
  }
});

test("with no model answering, the popup is the language's own list untouched", async () => {
  const view = mountRankedEditor({ ...ranking("orders"), ranked: [] });
  try {
    await openCompletions(view);
    // Nothing to apply, so the order must be exactly the one the language gave.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const labels = visibleLabels(view);
    for (const table of TABLES) assert.ok(labels.includes(table), `${table} is offered`);
    assert.equal(tablesIn(labels)[0], "orchards");
  } finally {
    view.destroy();
  }
});

/**
 * The control for the case below: reopening really does invoke the source with
 * the same question again, so what the cache prevents is a second *request* and
 * not a popup that quietly refuses to reopen. `hasAnswer` is always true here,
 * so the source answers from the scripted list and asks nothing by itself — the
 * count is only of the opens.
 */
test("reopening the list without a cache is a second question", async () => {
  const asked: Asked[] = [];
  const view = mountEditor(["orders"], asked);
  try {
    await openCompletions(view);
    closeCompletion(view);
    await openCompletions(view);
    assert.equal(asked.length, 2, "the source was invoked again");
    assert.deepEqual(asked[1], asked[0], "with exactly the same question");
  } finally {
    view.destroy();
  }
});

test("reopening the list on the same line does not ask again", async () => {
  const asked: Asked[] = [];
  const view = mountRankedEditor(ranking("orders"), asked);
  try {
    await openCompletions(view);
    assert.equal(asked.length, 1, "the first open asked once");
    await waitFor(() => leadsWith(view) === "orders", "the ranking to be applied");

    closeCompletion(view);
    assert.notEqual(completionStatus(view.state), "active", "the list really closed");
    await openCompletions(view);

    assert.equal(asked.length, 1, "the second open was answered from memory");
    assert.equal(
      leadsWith(view),
      "orders",
      "the remembered ranking is still applied",
    );
  } finally {
    view.destroy();
  }
});

test("a list being recomputed is still the place the question was asked about", async () => {
  // This is the rule that decides whether a late answer has a list to reorder at
  // all. CodeMirror reports an open list as `active` and one whose sources are
  // still answering as `pending` — and `pending` is what an open list becomes
  // for a moment whenever the editor's extensions are rebuilt, which is the one
  // moment a late answer used to be thrown away.
  const view = mountRankedEditor(ranking("orders"));
  try {
    await openCompletions(view);
    const position = view.state.selection.main.head;
    assert.equal(stillAskedThere(view, position, DOC), true, "an open list is this place");

    view.dispatch({ effects: StateEffect.reconfigure.of(rebuiltExtensions()) });
    assert.equal(completionStatus(view.state), "pending", "the list is being recomputed");
    assert.equal(
      stillAskedThere(view, position, DOC),
      true,
      "a list that is being recomputed is still where the question was asked",
    );

    // And a list that is really gone is not: the answer has nothing to reorder.
    closeCompletion(view);
    assert.equal(completionStatus(view.state), null, "the list really closed");
    assert.equal(stillAskedThere(view, position, DOC), false, "a dismissed list is not");
  } finally {
    view.destroy();
  }
});
