import test from "node:test";
import assert from "node:assert/strict";

import {
  assistantDescription,
  assistantStatus,
  ASSISTANT_LABEL,
  PLAIN_CALL,
  type AssistantCall,
  type AssistantStatus,
} from "./assistantStatus.ts";
import { riskLabel } from "./statementRisk.ts";
import type { RankCandidatesResponse } from "./types.ts";

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

/** Nothing asked yet. */
const quiet: AssistantCall = { ...PLAIN_CALL };

test("only the switch being off reports off", () => {
  const status = assistantStatus({
    enabled: false,
    ...quiet,
    response: answer({ ranked: ["orders"] }),
  });
  assert.equal(status, "off");
});

test("before the first answer the feature is ready, not ranked", () => {
  assert.equal(assistantStatus({ enabled: true, ...quiet }), "idle");
});

test("a question in flight reports working", () => {
  assert.equal(assistantStatus({ enabled: true, ...quiet, pending: true }), "working");
});

test("a ranking that was applied reports ranked", () => {
  const status = assistantStatus({
    enabled: true,
    ...quiet,
    response: answer({ ranked: ["orders"] }),
  });
  assert.equal(status, "ranked");
});

test("a model that answered without conviction is unsure, not unavailable", () => {
  // This is the distinction the whole state exists for: an answer arrived, it
  // was just too weak to act on.
  const status = assistantStatus({
    enabled: true,
    ...quiet,
    response: answer({ ranked: [], choice: "orders", confidence: 0.04 }),
  });
  assert.equal(status, "uncertain");
});

test("no model at all reports unavailable", () => {
  const status = assistantStatus({
    enabled: true,
    ...quiet,
    response: answer({ available: false, reason: "connection refused" }),
  });
  assert.equal(status, "unavailable");
});

test("a call that failed before an answer reports unavailable", () => {
  assert.equal(assistantStatus({ enabled: true, ...quiet, failed: true }), "unavailable");
});

test("a pending call outranks a stale failure", () => {
  assert.equal(
    assistantStatus({ enabled: true, ...quiet, pending: true, failed: true }),
    "working",
  );
});

/**
 * A real answer, recorded from `nimble` over the live path: the exact bytes the
 * `rank_candidates` command returns (the `wire:` line the ignored
 * `ranks_with_a_real_model` test prints) for `SELECT * FROM ord` against the
 * candidates `orchards, customers, order_items, orders`. TypeScript cannot check
 * field names across the IPC boundary, so this is what catches one renamed on
 * the Rust side — the shape would still compile while the indicator quietly
 * stopped reporting a ranking. The endpoint caches its own work, so re-recording
 * the same request gives the same line. Re-record with:
 *
 * ```sh
 * QUARRY_TEST_OLLAMA=1 cargo test --manifest-path src-tauri/Cargo.toml \
 *   -- --ignored --nocapture ranks_with_a_real_model
 * ```
 */
const RECORDED_ANSWER =
  '{"ranked":["orders","orchards","order_items","customers"],"choice":"orders",' +
  '"confidence":0.8197545613738849,"available":true,"reason":null,' +
  '"readings":[{"statement":"SELECT * FROM ord","verdict":"safe",' +
  '"level":0.05064555280967666,"confidence":0.9239880093682756}]}';

test("the answer a real model gave reads as a ranking, field names and all", () => {
  const response = JSON.parse(RECORDED_ANSWER) as RankCandidatesResponse;

  // The wire's field names, exactly — and every one of them, because a field
  // renamed or dropped on the Rust side has to fail here rather than leave the
  // editor reading `undefined`. `readings` is the field the badge consumes: a
  // reply that lost it would read as "no reading" for every statement, which is a
  // silence that no type can catch across the IPC boundary.
  assert.deepEqual(Object.keys(response).sort(), [
    "available",
    "choice",
    "confidence",
    "ranked",
    "readings",
    "reason",
  ]);

  // The candidates were sent with `orders` last — the order the editor's own
  // scoring produces for `FROM ord` — so the model's answer leading with it is
  // a reordering, which is the only thing `ranked` is allowed to mean.
  assert.deepEqual(response.ranked, ["orders", "orchards", "order_items", "customers"]);
  assert.equal(response.choice, "orders");

  // The statement rode along in the same request, so the reply carries a reading
  // of it as well: the graded step it landed on, and the position it came from.
  // `SELECT * FROM ord` can remove nothing, and the model puts it at the bottom of
  // its scale — where the badge says nothing, which is the ordinary case.
  const [reading] = response.readings;
  assert.ok(reading, "the reading did not arrive with the ranking");
  assert.equal(reading.statement, "SELECT * FROM ord", "the reading named another statement");
  assert.equal(reading.verdict, "safe");
  assert.ok(
    reading.level < 1.5,
    `a plain SELECT was read as ${reading.verdict} at ${reading.level}`,
  );
  assert.equal(
    riskLabel(reading),
    null,
    "a plain SELECT drew a mark the editor would have to explain away",
  );

  assert.equal(
    assistantStatus({ enabled: true, ...quiet, response }),
    "ranked",
    "a real answer with a ranking did not read as ranked",
  );
});

test("every state has words and an explanation", () => {
  const states: AssistantStatus[] = [
    "off",
    "idle",
    "working",
    "ranked",
    "uncertain",
    "unavailable",
  ];
  // An answer with something to quote in it, so the states that append the
  // model's own words are covered too — and a field that failed to reach the
  // tooltip shows up as `undefined` in the text rather than as a quiet gap.
  const call: AssistantCall = {
    pending: false,
    response: answer({ available: false, reason: "the model was not sure enough" }),
    failed: false,
    asked: "column",
  };
  for (const state of states) {
    assert.ok(ASSISTANT_LABEL[state].length > 0, `${state} has no label`);
    const description = assistantDescription(state, call);
    assert.ok(description.length > 1, `${state} has no tooltip`);
    assert.doesNotMatch(description, /undefined/, `${state} leaked an empty field`);
  }
});

/** An answer the model gave without convincing itself, as the model words it. */
const UNSURE = "the model was not sure enough (0.32 below 0.15)";

function callAbout(
  asked: AssistantCall["asked"],
  over: Partial<RankCandidatesResponse> = {},
): AssistantCall {
  return {
    pending: false,
    response: answer({ available: true, ranked: [], reason: UNSURE, ...over }),
    failed: false,
    asked,
  };
}

test("an unsure answer says which name it was unsure of, and why, verbatim", () => {
  const column = callAbout("column");
  assert.equal(assistantStatus({ enabled: true, ...column }), "uncertain");

  const description = assistantDescription("uncertain", column);
  // The list the user is looking at is a list of columns, so that is what the
  // explanation has to be about.
  assert.match(description, /which column you meant/);
  assert.doesNotMatch(description, /table/, "a column question was explained as a table one");
  // And the client's own sentence — the number included — is what makes the
  // difference between "unsure" and "the assistant is broken" visible.
  assert.match(description, /0\.32/, "the reported reason was dropped");
});

test("a ranking says which kind of name it moved, not just that it moved one", () => {
  const ranked = callAbout("column", {
    ranked: ["ordered_at", "order_number"],
    choice: "ordered_at",
    reason: null,
  });
  assert.equal(assistantStatus({ enabled: true, ...ranked }), "ranked");
  const description = assistantDescription("ranked", ranked);
  assert.match(description, /the column it thinks you mean first/);
  // Nothing to quote: the model answered.
  assert.doesNotMatch(description, /Reported:/);
  assert.doesNotMatch(description, /undefined/);
});

test("a model that never answered quotes why, when the client said", () => {
  const silent: AssistantCall = {
    pending: false,
    response: answer({
      available: false,
      reason: "the local model is unavailable: HTTP 503",
    }),
    failed: false,
    asked: "table",
  };
  assert.equal(assistantStatus({ enabled: true, ...silent }), "unavailable");
  const description = assistantDescription("unavailable", silent);
  assert.match(description, /Ollama/);
  assert.match(description, /Reported:/, "the reason was not marked off from the editor's own words");
  assert.match(description, /HTTP 503/, "the transport's own words were dropped");
});

test("the wrong state's question is never named", () => {
  // `off` and `idle` have no question behind them, so an explanation that named
  // a column there would be talking about a question nobody asked.
  const asked = callAbout("column");
  assert.doesNotMatch(assistantDescription("off", asked), /column|table/);
  assert.doesNotMatch(assistantDescription("idle", asked), /column|table/);
});
