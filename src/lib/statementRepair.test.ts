import test from "node:test";
import assert from "node:assert/strict";

import {
  createStatementRepairs,
  failuresIn,
  MAX_REPAIR_CANDIDATES,
  MAX_REPAIR_FAILURES,
  MIN_REPAIR_CANDIDATES,
  REPAIR_SIMILARITY,
  repairCandidates,
  repairedStatement,
  repairTarget,
  repairTitle,
  repairTokens,
  schemaNames,
  similarity,
  suggestionOf,
  type RepairSchema,
} from "./statementRepair.ts";
import type { QueryResponse, RankCandidatesResponse, StatementResult } from "./types.ts";

/**
 * The demo schema the real measurements were taken against: two tables whose
 * names and columns all sit near `ord`, which is what makes a shortlist a
 * question worth asking.
 */
const SCHEMA: RepairSchema[] = [
  { table: "orders", columns: ["id", "order_number", "ordered_at", "total_cents"] },
  { table: "order_items", columns: ["id", "order_id", "quantity", "unit_cents"] },
  { table: "orchards", columns: ["id", "acres"] },
];

const NAMES = schemaNames(SCHEMA);

/** A database error as a driver reports it, and the name the SQL meant. */
const MEASURED: { error: string; intended: string }[] = [
  { error: "no such column: ordred_at", intended: "ordered_at" },
  { error: "Unknown column 'quanity' in 'field list'", intended: "quantity" },
  { error: 'column "oder_number" does not exist', intended: "order_number" },
  { error: "Table 'shop.ordres' doesn't exist", intended: "orders" },
];

/** An answer as the decision layer reports one. */
function answer(over: Partial<RankCandidatesResponse> = {}): RankCandidatesResponse {
  return {
    ranked: [],
    choice: null,
    confidence: 0,
    available: true,
    reason: null,
    readings: [],
    ...over,
  };
}

// ------------------------------------------------------ what the failure says -----

test("the identifiers of an error are its words, folded and deduplicated", () => {
  // `no` is two letters, and two letters match half a schema: it goes.
  assert.deepEqual(repairTokens("no such column: ordred_at"), [
    "such",
    "column",
    "ordred_at",
  ]);
  // A quoted, schema-qualified name contributes both halves, which is what makes
  // a mistake in either half scoreable.
  assert.deepEqual(repairTokens("Table 'shop.ordres' doesn't exist"), [
    "table",
    "shop",
    "ordres",
    "doesn",
    "exist",
  ]);
  // A word twice is one token, and case is not a difference in a SQL name.
  assert.deepEqual(repairTokens("ORDERS orders Orders"), ["orders"]);
});

test("a fragment too short to mean anything, or with no letter in it, is dropped", () => {
  // `id`, `at` and a bare number would match half of any schema. What is left is
  // what could have been typed as a name.
  assert.deepEqual(repairTokens("no such column: at (1, id, 42, x)"), ["such", "column"]);
  assert.deepEqual(repairTokens("1234 -- () ."), []);
});

test("how alike two names are is the share of the longer one that has to change", () => {
  // The measured typos: one edit against names of ten, eight and twelve letters.
  assert.equal(similarity("ordred_at", "ordered_at").toFixed(3), "0.900");
  assert.equal(similarity("quanity", "quantity").toFixed(3), "0.875");
  assert.equal(similarity("oder_number", "order_number").toFixed(3), "0.917");
  // Case is not a difference, and the same name is as close as it gets.
  assert.equal(similarity("ORDERS", "orders"), 1);
  // A column used where a table belongs is a match on its prefix, not a typo — its
  // own name changes seven letters into the table's.
  assert.equal(similarity("order_number", "orders").toFixed(3), "0.417");
  // Not the name at all: below the floor the question is asked above.
  assert.ok(similarity("profit_margin_eur", "order_number") < REPAIR_SIMILARITY);
  assert.equal(similarity("", ""), 1);
  assert.equal(similarity("abc", ""), 0);
});

// ------------------------------------------------------------- the shortlist ------

test("a mistyped name is offered the name it was reaching for, and it leads", () => {
  for (const { error, intended } of MEASURED) {
    const candidates = repairCandidates(NAMES, error);
    assert.ok(
      candidates.includes(intended),
      `${error} did not offer ${intended}: ${candidates.join(", ")}`,
    );
    assert.equal(candidates[0], intended, `${error} did not lead with ${intended}`);
  }
});

test("a column name used where a table belongs offers the table", () => {
  // The case the measurement got wrong on purpose: `order_number` is a real name,
  // and the repair a person would make is the table whose prefix it shares.
  const candidates = repairCandidates(NAMES, "no such table: order_number");
  assert.ok(candidates.includes("orders"), candidates.join(", "));
  // The name the error actually named is in the list too — it is the closest thing
  // to itself — so a model that thinks the failure was about the name it already
  // tried is free to say so, and the client files whatever it says.
  assert.equal(candidates[0], "order_number");
});

test("a failure the schema has nothing for asks nothing at all", () => {
  // Measured: asked anyway, the model declined this one (0.941). Not asking is
  // cheaper and leaves the same screen — the error, with no suggestion beside it —
  // and it is the rule that keeps a guess from ever being shown as an answer.
  const candidates = repairCandidates(NAMES, "no such column: profit_margin_eur");
  assert.ok(
    candidates.length < MIN_REPAIR_CANDIDATES,
    `a question was built out of nothing: ${candidates.join(", ")}`,
  );
});

test("an error that names no identifier asks nothing either", () => {
  // A syntax error names a position rather than a name, and there is nothing for a
  // model to choose between.
  assert.deepEqual(repairCandidates(NAMES, "syntax error at or near \")\""), []);
  assert.deepEqual(repairCandidates(NAMES, ""), []);
});

test("the shortlist is bounded, best first, and the same on the same failure", () => {
  const sqlError =
    "no such column: order_numbres, order_dates, ordered_ats, unit_cent, total_cent";
  const candidates = repairCandidates(NAMES, sqlError);
  assert.ok(candidates.length > 0);
  assert.ok(candidates.length <= MAX_REPAIR_CANDIDATES);
  // Same question, same request: a list that reshuffled itself between two asks
  // would be a different question each time, and cost a model call for each.
  assert.deepEqual(repairCandidates(NAMES, sqlError), candidates);
  // A caller's own bound is honoured, because the decision layer's is not the only
  // reason to keep a prompt small.
  assert.equal(repairCandidates(NAMES, sqlError, 2).length, 2);
});

test("the schema's names are its tables and its columns, each once", () => {
  // `id` is on every table and every table is named where it is defined: the
  // question is about names, so a name is offered once however often it occurs.
  assert.deepEqual(NAMES, [
    "orders",
    "id",
    "order_number",
    "ordered_at",
    "total_cents",
    "order_items",
    "order_id",
    "quantity",
    "unit_cents",
    "orchards",
    "acres",
  ]);
});

// ---------------------------------------------------------------- the edit ------

test("the mistake a repair is about is the word the error named, as the SQL spells it", () => {
  assert.equal(
    repairTarget("SELECT ordred_at FROM orders", "no such column: ordred_at", "ordered_at"),
    "ordred_at",
  );
  // A schema-qualified error names both halves; the half the SQL spells is the one
  // there is anything to change.
  assert.equal(
    repairTarget("SELECT * FROM ordres", "Table 'shop.ordres' doesn't exist", "orders"),
    "ordres",
  );
  // A word the statement does not hold is not a mistake this statement made: an
  // error about another name, or about a name from another statement, has nothing
  // here to put right.
  assert.equal(
    repairTarget("SELECT total FROM orders", "no such column: ordred_at", "ordered_at"),
    null,
  );
  // And a statement already spelling the suggested name needs no repair.
  assert.equal(
    repairTarget("SELECT ordered_at FROM orders", "no such column: ordered_at", "ordered_at"),
    null,
  );
  // Under the same floor the shortlist was built with, so a repair is never offered
  // for a pairing the question itself would not have made.
  assert.equal(
    repairTarget("SELECT profit_margin_eur FROM orders", "no such column: profit_margin_eur", "ordered_at"),
    null,
  );
});

test("a repair writes the name where the mistake is and touches nothing else", () => {
  assert.equal(
    repairedStatement("SELECT ordred_at FROM orders", "no such column: ordred_at", "ordered_at"),
    "SELECT ordered_at FROM orders",
  );
  // A typo is a typo wherever it appears: a `SELECT` list and its `WHERE` clause
  // usually spell the same mistake twice, and mending one of them would leave the
  // statement failing for the same reason.
  assert.equal(
    repairedStatement(
      "UPDATE orders SET ordred_at = 1 WHERE ordred_at > 2",
      "no such column: ordred_at",
      "ordered_at",
    ),
    "UPDATE orders SET ordered_at = 1 WHERE ordered_at > 2",
  );
  // Quoting is the writer's, not the repair's: only the word inside the quotes is
  // ever replaced.
  assert.equal(
    repairedStatement(
      'SELECT "oder_number" FROM orders',
      'column "oder_number" does not exist',
      "order_number",
    ),
    'SELECT "order_number" FROM orders',
  );
  // A word that merely contains what was typed is not that word.
  assert.equal(
    repairedStatement("SELECT my_ordres FROM ordres", "no such table: ordres", "orders"),
    "SELECT my_ordres FROM orders",
  );
  // Nothing to write means no repair, rather than a guess about where to put it.
  assert.equal(repairedStatement("SELECT 1", "no such column: ordred_at", "ordered_at"), null);
});

// ------------------------------------------------------------- the failures ------

/** A statement result as the grid receives one. */
function result(statement: string, error?: string): StatementResult {
  return {
    statement,
    isQuery: true,
    columns: [],
    rows: [],
    rowCount: 0,
    executionMs: 1,
    truncated: false,
    error: error ?? null,
  };
}

test("only the statements that failed are asked about", () => {
  const run: QueryResponse = {
    results: [
      result("SELECT 1"),
      result("SELECT * FROM oder_items", "no such table: oder_items"),
      result("SELECT 2"),
    ],
    totalMs: 3,
  };
  assert.deepEqual(failuresIn(run), [
    { statement: "SELECT * FROM oder_items", error: "no such table: oder_items" },
  ]);
  // A run that never happened is not a run that failed, and a failure with nothing
  // to have meant anything by — no error text, or no SQL — is not a question.
  assert.deepEqual(failuresIn(null), []);
  assert.deepEqual(failuresIn({ results: [result("SELECT 1", "   ")], totalMs: 1 }), []);
});

test("a run that failed everywhere is asked about at most a few times", () => {
  const run: QueryResponse = {
    results: Array.from({ length: MAX_REPAIR_FAILURES + 3 }, (_, index) =>
      result(`SELECT ${index} FROM orders`, "no such column: ordred_at"),
    ),
    totalMs: 5,
  };
  const failures = failuresIn(run);
  assert.equal(failures.length, MAX_REPAIR_FAILURES);
  // The first ones, which are the ones on screen.
  assert.equal(failures[0].statement, "SELECT 0 FROM orders");
});

// -------------------------------------------------------------- the answer -------

test("a ranked answer is a suggestion, and an unranked one is not", () => {
  const ranked = suggestionOf("SELECT ordred_at FROM orders", "no such column: ordred_at", {
    ranked: ["ordered_at", "order_number"],
    choice: "ordered_at",
    confidence: 0.94,
    available: true,
    reason: null,
    readings: [],
  });
  assert.equal(ranked.name, "ordered_at");
  assert.equal(ranked.confidence, 0.94);
  assert.equal(ranked.reason, null);

  // Declined: the question's own "none of these" was the answer, and the client
  // says so rather than offering the name it did not stand behind.
  const declined = suggestionOf("SELECT x FROM orders", "no such column: profit_margin_eur", {
    ranked: [],
    choice: null,
    confidence: 0.941,
    available: true,
    reason: "no listed name fits the error",
    readings: [],
  });
  assert.equal(declined.name, null);
  assert.equal(declined.reason, "no listed name fits the error");

  // Unsure: the decision layer still fills in `choice`, and it is *not* a
  // suggestion — reading it as one would offer a name the model refused to stand
  // behind. This is the difference the client must not lose.
  const unsure = suggestionOf("SELECT ordred_at FROM orders", "no such column: ordred_at", {
    ranked: [],
    choice: "ordered_at",
    confidence: 0.08,
    available: true,
    reason: "the model was not sure enough (0.08 below 0.15)",
    readings: [],
  });
  assert.equal(unsure.name, null);
  assert.match(unsure.reason ?? "", /not sure enough/);

  // No model at all: a suggestion of nothing, with the reason for it.
  const offline = suggestionOf("SELECT 1", "no such column: ordred_at", answer());
  assert.equal(offline.name, null);
});

test("the hint's tooltip names the suggestion, how sure, and which statement", () => {
  const repair = suggestionOf("SELECT ordred_at FROM orders", "no such column: ordred_at", {
    ranked: ["ordered_at"],
    choice: "ordered_at",
    confidence: 0.942,
    available: true,
    reason: null,
    readings: [],
  });
  const title = repairTitle(repair);
  assert.match(title, /ordered_at/);
  // The number is why a suggestion can be shown at all: it is the model's own
  // confidence, not the editor's opinion.
  assert.match(title, /94%/);
  // And the statement, because a command can fail on one of several.
  assert.match(title, /this exact statement/);
  assert.match(title, /SELECT ordred_at FROM orders/);
});

// --------------------------------------------------------------- the store -------

test("a failure is asked about once, whoever notices it first", () => {
  const repairs = createStatementRepairs();
  assert.equal(repairs.start("SELECT ordred_at FROM orders", "no such column: ordred_at"), true);
  // The second caller — a re-render of the grid, or the next run failing the same
  // way — does not get to ask the model the same question again.
  assert.equal(repairs.start("SELECT ordred_at FROM orders", "no such column: ordred_at"), false);
  // Nothing has been answered yet, which is what the store says until it has.
  assert.equal(repairs.get("SELECT ordred_at FROM orders", "no such column: ordred_at"), null);
});

test("an answer is filed under the statement and the error it was given for", () => {
  const repairs = createStatementRepairs();
  const repair = suggestionOf("SELECT ordred_at FROM orders", "no such column: ordred_at", {
    ranked: ["ordered_at"],
    choice: "ordered_at",
    confidence: 0.94,
    available: true,
    reason: null,
    readings: [],
  });
  repairs.start(repair.statement, repair.error);
  repairs.remember(repair);
  assert.equal(repairs.get(repair.statement, repair.error)?.name, "ordered_at");

  // The same statement failing two ways is two questions, and one answer is not
  // the other's. A store keyed by the statement alone would answer with it.
  assert.equal(repairs.get(repair.statement, "no such table: orders"), null);
  // And a statement nobody has asked about has no answer, in either direction.
  assert.equal(repairs.get("SELECT 1", repair.error), null);
  assert.equal(repairs.get(null, null), null);
  assert.equal(repairs.get("", repair.error), null);
});

test("the text the key is made of is the text the model is shown", () => {
  // The decision layer trims both halves before sending them, so a grid holding
  // the untrimmed statement still finds the answer filed under the trimmed one.
  const repairs = createStatementRepairs();
  repairs.remember({
    statement: "  SELECT ordred_at FROM orders  ",
    error: " no such column: ordred_at\n",
    name: "ordered_at",
    confidence: 0.94,
    reason: null,
  });
  assert.equal(
    repairs.get("SELECT ordred_at FROM orders", "no such column: ordred_at")?.name,
    "ordered_at",
  );
});

test("a request that failed is not an answer, so it can be asked again", () => {
  const repairs = createStatementRepairs();
  const id: [string, string] = ["SELECT ordred_at FROM orders", "no such column: ordred_at"];
  assert.equal(repairs.start(...id), true);
  // The request never came back. Remembering the claim would stop the hint from
  // ever appearing, which is what `forget` is for.
  repairs.forget(...id);
  assert.equal(repairs.start(...id), true);
  assert.equal(repairs.get(...id), null);
});

test("only the failures in recent use are kept", () => {
  const repairs = createStatementRepairs({ limit: 2 });
  const answered = (statement: string) => ({
    statement,
    error: "no such column: ordred_at",
    name: "ordered_at",
    confidence: 0.9,
    reason: null,
  });
  repairs.remember(answered("A"));
  repairs.remember(answered("B"));
  repairs.remember(answered("C"));
  // A is the least recently asked, so it went first.
  assert.equal(repairs.get("A", "no such column: ordred_at"), null);
  assert.equal(repairs.get("B", "no such column: ordred_at")?.name, "ordered_at");
});
