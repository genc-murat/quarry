import test from "node:test";
import assert from "node:assert/strict";

import { CompletionContext } from "@codemirror/autocomplete";
import { sql, type SQLNamespace } from "@codemirror/lang-sql";
import { EditorState } from "@codemirror/state";

import { MAX_RANK_CANDIDATES, TOP_BOOST } from "./completionRank.ts";
import {
  MAX_STATE_CHARS,
  smartCompletionSource,
  type SmartCompletionOptions,
} from "./smartComplete.ts";

const TABLES = ["orders", "order_items", "orchards"];

/**
 * The lowest boost a ranking can produce. The SQL language already gives some
 * of its own completions a small (negative) boost, so "unranked" is checked as
 * "outside the ranking band" rather than "no boost at all".
 */
const RANK_BAND = TOP_BOOST - MAX_RANK_CANDIDATES;

function schemaOf(names: readonly string[]): SQLNamespace {
  const root: Record<string, unknown> = {};
  for (const name of names) {
    root[name] = { self: { label: name, type: "class" }, children: [] };
  }
  return root as SQLNamespace;
}

/** A completion context at the end of `doc`, as if the user just typed it. */
function contextAt(doc: string): CompletionContext {
  const state = EditorState.create({
    doc,
    extensions: [sql({ schema: schemaOf(TABLES) })],
  });
  return new CompletionContext(state, doc.length, false);
}

test("the language's own tables are still offered", async () => {
  const source = smartCompletionSource({ tables: TABLES, rank: async () => [] });
  const result = await source(contextAt("SELECT * FROM or"));
  assert.ok(result, "the SQL source answered");
  const labels = result.options.map((option) => option.label);
  for (const table of TABLES) assert.ok(labels.includes(table), `${table} is offered`);
});

/**
 * A source told the ranking is already in hand, which is what the editor looks
 * like on its second pass over a question. This is the pass that hands back the
 * ranked list.
 */
function rankedSource(rank: SmartCompletionOptions["rank"]) {
  return smartCompletionSource({ tables: TABLES, rank, hasAnswer: () => true });
}

/** The same source before any answer has landed. */
function unrankedSource(rank: SmartCompletionOptions["rank"]) {
  return smartCompletionSource({ tables: TABLES, rank, hasAnswer: () => false });
}

test("the model's pick is boosted above the rest when its answer is in hand", async () => {
  const source = rankedSource(async () => ["orchards"]);
  const result = await source(contextAt("SELECT * FROM or"));
  assert.ok(result);
  const boost = new Map(result.options.map((option) => [option.label, option.boost ?? 0]));
  assert.ok((boost.get("orchards") ?? 0) > (boost.get("orders") ?? 0));
  assert.ok((boost.get("orchards") ?? 0) > (boost.get("order_items") ?? 0));
});

test("with no answer in hand yet the language's own list is returned as it is", async () => {
  // The user must not wait for the model, so the first pass is the language's
  // order, unranked — and the question is put anyway, for the second pass.
  let asked = 0;
  const source = unrankedSource(async () => {
    asked += 1;
    return ["orchards"];
  });
  const result = await source(contextAt("SELECT * FROM or"));
  assert.ok(result);
  for (const option of result.options) {
    assert.ok((option.boost ?? 0) < RANK_BAND, `${option.label} is not ranked`);
  }
  // The question goes out before the list is handed over, so the answer can be
  // waiting by the time the editor asks again.
  assert.equal(asked, 1, "the question was put for the second pass to use");
});

test("a model with no opinion leaves the list unranked", async () => {
  const source = rankedSource(async () => []);
  const result = await source(contextAt("SELECT * FROM or"));
  assert.ok(result);
  for (const option of result.options) {
    assert.ok((option.boost ?? 0) < RANK_BAND, `${option.label} is not ranked`);
  }
});

test("a model that fails never costs the user their completions", async () => {
  // Both passes: the one that waits for an answer it was promised, and the one
  // that hands the list over and asks behind it.
  for (const source of [
    rankedSource(async () => {
      throw new Error("ollama is not running");
    }),
    unrankedSource(async () => {
      throw new Error("ollama is not running");
    }),
  ]) {
    const result = await source(contextAt("SELECT * FROM or"));
    assert.ok(result);
    assert.ok(result.options.length > 0);
    for (const option of result.options) {
      assert.ok((option.boost ?? 0) < RANK_BAND, `${option.label} is not ranked`);
    }
  }
  // The rejected question behind the second pass must not escape as an
  // unhandled rejection either.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("one candidate is not worth a model call", async () => {
  let calls = 0;
  const source = smartCompletionSource({
    tables: ["orders"],
    rank: async () => {
      calls += 1;
      return [];
    },
  });
  await source(contextAt("SELECT * FROM o"));
  assert.equal(calls, 0);
});

test("only the line under the cursor is sent as state", async () => {
  let seen = "";
  const source = smartCompletionSource({
    tables: TABLES,
    rank: async (line) => {
      seen = line;
      return ["orders"];
    },
  });
  await source(contextAt("SELECT 1;\nSELECT * FROM or"));
  assert.equal(seen, "SELECT * FROM or");
});

test("a line longer than the limit is trimmed to its tail", async () => {
  let seen = "";
  const source = smartCompletionSource({
    tables: TABLES,
    rank: async (line) => {
      seen = line;
      return ["orders"];
    },
  });
  // Valid SQL that is nonetheless longer than one prompt should be. The long
  // part is one identifier rather than a long list of them: measured, a select
  // list of a thousand names stops the language's own completion from resolving
  // the `FROM` clause at all — it offers the keyword list and no table names —
  // and a question with no names on screen is one this source does not ask (see
  // the guard in `smartComplete.ts`). The point here is the trimming, so the
  // fixture has to be a document the language still offers tables for.
  const long = `SELECT ${"x".repeat(MAX_STATE_CHARS + 100)} FROM or`;
  assert.ok(long.length > MAX_STATE_CHARS, "the fixture must be over the limit");
  await source(contextAt(long));
  assert.ok(seen.length <= MAX_STATE_CHARS);
  assert.ok(seen.endsWith("FROM or"), `the tail is kept: ${seen.slice(-30)}`);
});
