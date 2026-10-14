import assert from "node:assert/strict";
import test from "node:test";

import { listLabels, problems } from "./smokeRanking.mjs";

/**
 * The judgement of the packaged-app smoke run, checked without the run: the run
 * needs a bundle, a GUI session and a live local model, and what it asserts is
 * exactly the part that can be pinned here — that a transcript showing the list
 * open in the language's order and then lead with the model's pick passes, and
 * that each way of looking like that without doing it fails with its own message.
 *
 * The transcripts are the shape `scripts/smoke-app.mjs` collects: the probe's
 * steps in arrival order, and the step that ended the run.
 */

/** The question the run asks the app: the SQL, the last character, the answer. */
const QUESTION = { sql: "SELECT * FROM or", typed: "d", pick: "orders" };

/** The same run with its failure phase: the statement to reject, and the name meant. */
const WITH_FAILURE = {
  ...QUESTION,
  repair: { sql: "SELECT * FROM oder_items", name: "order_items" },
};

/** The failure phase's steps, in the order the probe reports them. */
const FAILURE_STEPS = [
  [1200, "failed:no such table: oder_items"],
  [1680, "repair:order_items"],
  [1680, "repair-note:The local model read this failure and the SQL that produced it…"],
  [1980, "fixed:…ELECT * FROM order_items"],
  [2400, "ran:ok"],
];

/** A transcript from report steps, each with the milliseconds since the keystroke. */
function transcript(...reports) {
  const steps = reports.map((report) => {
    if (typeof report === "string") return { ms: 0, step: report };
    const [ms, step] = report;
    return { ms, step };
  });
  const finished = steps.map((entry) => entry.step).find((step) => /^(done|timeout:|error:)/.test(step));
  return { steps, finished: finished ?? null };
}

/**
 * A run with the steps every run has — the connection, the schema, the one
 * editor, the keystroke — plus what a test adds after them, so a failure test
 * complains about its own fault and nothing else.
 */
function run(...reports) {
  return transcript(
    "start:Ranking demo (SQLite)",
    "connected:sqlite:main",
    "tab:3a33eab9",
    "schema:6:customers|orchards|order_archive|order_items|orders|work_orders",
    "editor:ready:1:2",
    [61, "typed:d:SELECT * FROM ord"],
    ...reports,
    [780, "done"],
  );
}

/** The run that passed on this machine, against the live model (`nimble`). */
function goodRun() {
  return run(
    [67, "completion:pending:"],
    [67, "assistant:idle"],
    [162, "completion:active:order_archive|order_items|orders|order"],
    [162, "list:order_archive|order_items|orders|order"],
    [162, "assistant:working"],
    [713, "assistant:ranked"],
    [772, "completion:active:orders|order_items|order_archive|order"],
    [772, "list:orders|order_items|order_archive|order"],
  );
}

/** Replaces the first step that starts with `prefix`, keeping its position. */
function replace(seen, prefix, step) {
  const at = seen.steps.findIndex((entry) => entry.step.startsWith(prefix));
  assert.ok(at >= 0, `no ${prefix} step in the transcript`);
  seen.steps[at] = { ms: seen.steps[at].ms, step };
  return seen;
}

/** Replaces every step that starts with `prefix`. */
function replaceAll(seen, prefix, step) {
  seen.steps = seen.steps.map((entry) =>
    entry.step.startsWith(prefix) ? { ms: entry.ms, step } : entry,
  );
  return seen;
}

/** The messages a transcript produces, as one string to match a phrase against. */
function complaints(seen, question = QUESTION) {
  return problems(seen, question).join("\n");
}

test("a run where the list opened unranked and then led with the pick passes", () => {
  assert.deepEqual(problems(goodRun(), QUESTION), []);
});

test("a list that already led with the pick is refused", () => {
  // The failure this exists for: a run where nothing moved can otherwise look
  // exactly like one where the model agreed with the language.
  const seen = run(
    [162, "list:orders|order_items|order_archive"],
    [162, "assistant:working"],
    [713, "assistant:ranked"],
  );
  assert.deepEqual(problems(seen, QUESTION), [
    "the list already led with orders, so a reordering could not be seen",
  ]);
});

test("a list that never opened fails, and says so rather than passing quietly", () => {
  const seen = run([67, "assistant:idle"], [60_013, "timeout:no-list"]);
  assert.deepEqual(problems(seen, QUESTION), [
    "the probe gave up: timeout:no-list",
    "the completion list never opened",
    "the assistant never reported a ranked answer",
    "the question was never reported as in flight",
  ]);
});

test("a probe that failed or never finished proves nothing", () => {
  const failed = run([67, "assistant:idle"], [200, "error:no connection named Ranking demo (SQLite)"]);
  assert.match(complaints(failed), /the probe failed: error:no connection named/);
  assert.match(complaints(failed), /the completion list never opened/);

  const unfinished = goodRun();
  unfinished.finished = null;
  assert.match(complaints(unfinished), /the probe never finished, so the run proves nothing/);
});

test("a keystroke that landed somewhere else fails, and shows what the editor read", () => {
  // A real failure seen while writing the run: the cursor was at the start of
  // the document, so the character began the SQL instead of finishing it, and
  // the list that opened was about a keyword rather than the table.
  const seen = replace(goodRun(), "typed:", "typed:d:dSELECT * FROM or");
  replaceAll(seen, "list:", "list:data|database|databases");
  assert.deepEqual(problems(seen, QUESTION), [
    "the keystroke did not land in SELECT * FROM or: the editor read “yped:d:dSELECT * FROM or”",
    "the model's pick never reached the top: the list ended data > database > databases",
  ]);
});

test("an answer no question stands behind is refused", () => {
  // The list opened in the language's order and the last list led with the pick,
  // so this looks like a pass on order alone: what is missing is the question.
  const unasked = run(
    [162, "list:order_archive|order_items|orders"],
    [713, "assistant:ranked"],
    // The list did end up ranked, so only the missing question is complained of.
    [900, "list:orders|order_items|order_archive"],
  );
  assert.deepEqual(problems(unasked, QUESTION), [
    "the question was never reported as in flight",
  ]);

  // And an answer reported before the question that produced it: nothing waited
  // for it, so the list it reordered is not the one the user was looking at.
  const reversed = run(
    [162, "list:order_archive|order_items|orders"],
    [200, "assistant:ranked"],
    [400, "assistant:working"],
    [900, "list:orders|order_items|order_archive"],
  );
  assert.deepEqual(problems(reversed, QUESTION), [
    "the answer was reported before the question",
  ]);
});

test("a run that typed into something other than the one editor is refused", () => {
  assert.deepEqual(problems(replace(goodRun(), "editor:ready:", "editor:ready:2:2"), QUESTION), [
    "2 editors were mounted: the run cannot say which one it typed into",
  ]);
  assert.deepEqual(problems(replace(goodRun(), "editor:ready:", "editor:ready:1:0"), QUESTION), [
    "the editor offered no completion sources at the cursor",
  ]);
  assert.match(
    complaints(replace(goodRun(), "editor:ready:", "editor:ready:0:0")),
    /0 editors were mounted/,
  );

  const unconnected = goodRun();
  unconnected.steps = unconnected.steps.filter(
    (entry) => !entry.step.startsWith("connected:") && !entry.step.startsWith("schema:"),
  );
  assert.deepEqual(problems(unconnected, QUESTION), [
    "the app never connected to the demo database",
    "the editor's schema never loaded",
  ]);
});

test("the rules are pinned to the question the run was given", () => {
  // The same transcript, judged against a different demo: the keystroke and the
  // pick are what the run was pointed at, not constants of the judge.
  const other = transcript(
    "connected:sqlite:main",
    "schema:3:user_archive|user_roles|users",
    "editor:ready:1:2",
    [30, "typed:s:SELECT * FROM users"],
    [90, "list:user_archive|user_roles|users"],
    [400, "assistant:working"],
    [900, "assistant:ranked"],
    [950, "list:users|user_roles|user_archive"],
    [980, "done"],
  );
  assert.deepEqual(problems(other, { sql: "SELECT * FROM user", typed: "s", pick: "users" }), []);
  assert.match(
    complaints(other, { sql: "SELECT * FROM staff", typed: "s", pick: "staff" }),
    /the keystroke did not land in SELECT \* FROM staff/,
  );
});

test("the failure phase passes when the suggestion is the name a person would act on", () => {
  const seen = run(
    [162, "list:order_archive|order_items|orders|order"],
    [162, "assistant:working"],
    [713, "assistant:ranked"],
    [772, "list:orders|order_items|order_archive|order"],
    ...FAILURE_STEPS,
  );
  assert.deepEqual(problems(seen, WITH_FAILURE), []);
  // And the same transcript without a failure phase configured — a run pointed at
  // the ranking alone — is judged on the ranking alone.
  assert.deepEqual(problems(seen, QUESTION), []);
});

test("a failure phase that suggested nothing fails, and says which name was wanted", () => {
  // The probe reports the failure and then times out waiting for a hint, which is
  // what "the editor showed nothing" looks like from outside the app.
  const timedOut = run(
    [162, "list:order_archive|order_items|orders|order"],
    [162, "assistant:working"],
    [713, "assistant:ranked"],
    [772, "list:orders|order_items|order_archive|order"],
    [1200, "failed:no such table: oder_items"],
    [60_000, "timeout:no-repair"],
  );
  assert.match(complaints(timedOut, WITH_FAILURE), /the probe gave up: timeout:no-repair/);
  assert.match(complaints(timedOut, WITH_FAILURE), /the editor never suggested a name/);

  // And a run that finished without a hint at all is refused too, rather than
  // passing on the strength of its ranking.
  const silently = run(
    [162, "list:order_archive|order_items|orders|order"],
    [162, "assistant:working"],
    [713, "assistant:ranked"],
    [772, "list:orders|order_items|order_archive|order"],
    [1200, "failed:no such table: oder_items"],
  );
  assert.deepEqual(problems(silently, WITH_FAILURE), [
    "the editor never suggested a name for the failure",
  ]);
});

test("a suggestion that names something else is refused", () => {
  // The failure this exists for: the model answered, the hint appeared, and the
  // name under the error is not the name the statement was reaching for — which is
  // worse than no hint, because it is a suggestion a reader may act on.
  const seen = run(
    [162, "list:order_archive|order_items|orders|order"],
    [162, "assistant:working"],
    [713, "assistant:ranked"],
    [772, "list:orders|order_items|order_archive|order"],
    [1200, "failed:no such table: oder_items"],
    [1500, "repair:orders"],
    // The wrong name is written and run just as the right one would be: what this
    // run is complained about is the name, and nothing else.
    [1800, "fixed:…ELECT * FROM orders"],
    [2200, "ran:ok"],
  );
  assert.deepEqual(problems(seen, WITH_FAILURE), ["the suggestion was orders, not order_items"]);
});

test("a suggestion reported before its failure, or before the ranking, is refused", () => {
  // A hint with nothing before it was not an answer to this failure, and the phase
  // that runs it is only reached once the ranking has been seen.
  const outOfOrder = run(
    [162, "list:order_archive|order_items|orders|order"],
    [162, "assistant:working"],
    [713, "assistant:ranked"],
    [772, "list:orders|order_items|order_archive|order"],
    [1200, "repair:order_items"],
    [1400, "failed:no such table: oder_items"],
  );
  assert.match(complaints(outOfOrder, WITH_FAILURE), /before the failure/);

  const beforeRanking = transcript(
    "connected:sqlite:main",
    "schema:6:customers|orchards|order_archive|order_items|orders|work_orders",
    "editor:ready:1:2",
    [61, "typed:d:SELECT * FROM ord"],
    [162, "list:order_archive|order_items|orders"],
    [400, "failed:no such table: oder_items"],
    [600, "repair:order_items"],
    [700, "assistant:working"],
    [900, "assistant:ranked"],
    [950, "list:orders|order_items|order_archive"],
    [980, "done"],
  );
  assert.match(complaints(beforeRanking, WITH_FAILURE), /before the ranking was seen/);
});

test("a suggestion nobody can act on is refused, and so is one the editor never took", () => {
  // The button is the point of the phase: a hint that cannot be pressed leaves the
  // reader to retype the name themselves, which is the work it exists to save.
  const unpressed = run(
    [162, "list:order_archive|order_items|orders|order"],
    [162, "assistant:working"],
    [713, "assistant:ranked"],
    [772, "list:orders|order_items|order_archive|order"],
    [1200, "failed:no such table: oder_items"],
    [1680, "repair:order_items"],
    [1980, "no-fix-button"],
  );
  assert.deepEqual(problems(unpressed, WITH_FAILURE), [
    "the editor offered no way to act on the suggestion",
  ]);

  // Pressed, and the editor was left holding something else: the repair has to be
  // the statement, not a run of text the app happened to send.
  const untouched = run(
    [162, "list:order_archive|order_items|orders|order"],
    [162, "assistant:working"],
    [713, "assistant:ranked"],
    [772, "list:orders|order_items|order_archive|order"],
    [1200, "failed:no such table: oder_items"],
    [1680, "repair:order_items"],
    [1980, "fixed:…ELECT * FROM oder_items"],
    [2400, "ran:ok"],
  );
  assert.deepEqual(problems(untouched, WITH_FAILURE), [
    "the editor was left with fixed:…ELECT * FROM oder_items, which does not hold order_items",
  ]);

  // Written and not run, or run and failed: both are the phase's own failure.
  const unrun = replace(
    run(
      [162, "list:order_archive|order_items|orders|order"],
      [162, "assistant:working"],
      [713, "assistant:ranked"],
      [772, "list:orders|order_items|order_archive|order"],
      ...FAILURE_STEPS,
    ),
    "ran:ok",
    "timeout:repair-not-run",
  );
  assert.match(complaints(unrun, WITH_FAILURE), /the repaired statement was never run to a result/);
  assert.match(complaints(unrun, WITH_FAILURE), /the probe gave up: timeout:repair-not-run/);
});

test("the repair has to come after the hint that produced it", () => {
  const outOfOrder = run(
    [162, "list:order_archive|order_items|orders|order"],
    [162, "assistant:working"],
    [713, "assistant:ranked"],
    [772, "list:orders|order_items|order_archive|order"],
    [1200, "failed:no such table: oder_items"],
    [1300, "fixed:…ELECT * FROM order_items"],
    [1400, "ran:ok"],
    [1680, "repair:order_items"],
  );
  assert.deepEqual(problems(outOfOrder, WITH_FAILURE), [
    "the repair was written before the suggestion was reported",
  ]);
});

test("a failure phase with no failure to report is refused", () => {
  const seen = run(
    [162, "list:order_archive|order_items|orders|order"],
    [162, "assistant:working"],
    [713, "assistant:ranked"],
    [772, "list:orders|order_items|order_archive|order"],
    [1680, "repair:order_items"],
    [1980, "fixed:…ELECT * FROM order_items"],
    [2400, "ran:ok"],
  );
  assert.deepEqual(problems(seen, WITH_FAILURE), [
    "the app never reported a failure for SELECT * FROM oder_items",
  ]);
});

test("a list step is read as its labels", () => {
  assert.deepEqual(listLabels("list:orders|order_items"), ["orders", "order_items"]);
});
