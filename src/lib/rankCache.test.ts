import test from "node:test";
import assert from "node:assert/strict";

import { candidateNames } from "./completionRank.ts";
import {
  createRankCache,
  type RankCache,
  type RankCacheOptions,
  type RankQuestion,
} from "./rankCache.ts";
import type { RankCandidatesResponse } from "./types.ts";

function answer(over: Partial<RankCandidatesResponse> = {}): RankCandidatesResponse {
  return {
    ranked: ["orders", "order_items"],
    choice: "orders",
    confidence: 0.9,
    available: true,
    reason: null,
    readings: [],
    ...over,
  };
}

/** A stand-in model that counts what it was asked. */
function countingModel(response: RankCandidatesResponse = answer()) {
  const asked: { line: string; candidates: string[]; question: RankQuestion }[] = [];
  return {
    asked,
    ask: async (line: string, candidates: readonly string[], question: RankQuestion) => {
      asked.push({ line, candidates: [...candidates], question });
      return response;
    },
  };
}

/** A question over table names, carrying `statements` to read as well. */
function about(...statements: string[]): RankQuestion {
  return { statements, kind: "table" };
}

/**
 * A cache over a counting model with the settle window switched off. These cases
 * are about which questions get put, and a timer would only make them slow; the
 * burst cases below are the ones that put the timer to work.
 */
function cacheOver(
  model: ReturnType<typeof countingModel>,
  over: Partial<RankCacheOptions> = {},
): RankCache {
  return createRankCache({ ask: model.ask, settle: 0, ...over });
}

const CHOICES = ["orders", "order_items"];

test("the same question is put to the model once", async () => {
  const model = countingModel();
  const cache = cacheOver(model);

  const first = await cache.rank("SELECT * FROM ord", CHOICES);
  const second = await cache.rank("SELECT * FROM ord", CHOICES);

  assert.equal(model.asked.length, 1, "the model was asked once");
  assert.equal(first.reused, false, "the first answer was asked for");
  assert.equal(second.reused, true, "the second was answered from memory");
  assert.equal(second.response, first.response, "and it is the same answer");
});

test("a question asked twice at once is one request", async () => {
  const model = countingModel();
  const cache = cacheOver(model);

  // Both start before either can finish: an editor can invoke the source again
  // while the model is still thinking, and that must not double the work.
  const [a, b] = await Promise.all([
    cache.rank("SELECT * FROM ord", CHOICES),
    cache.rank("SELECT * FROM ord", CHOICES),
  ]);

  assert.equal(model.asked.length, 1, "only one request went out");
  assert.deepEqual(a.response, b.response);
  // Neither of them started the request on its own; both waited on the one that
  // did, which is the point of sharing it.
  assert.equal(a.reused, false);
  assert.equal(b.reused, true);
});

test("a longer line over the same choices is answered without asking again", async () => {
  const model = countingModel();
  const cache = cacheOver(model);

  await cache.rank("SELECT * FROM ord", CHOICES);
  const typed = await cache.rank("SELECT * FROM orde", CHOICES);

  assert.equal(model.asked.length, 1, "typing on did not cost a request");
  assert.equal(typed.reused, true);
  assert.deepEqual(typed.response.ranked, ["orders", "order_items"]);
});

test("the statements to read travel with the question", async () => {
  const model = countingModel();
  const cache = cacheOver(model);

  await cache.rank("SELECT * FROM ord", CHOICES, about("DELETE FROM orders", "DROP TABLE orders"));

  // They ride in the same request as the ranking, which is what makes each
  // reading cost a question rather than a call.
  assert.equal(model.asked.length, 1, "one request, all the questions");
  assert.deepEqual(model.asked[0].question.statements, ["DELETE FROM orders", "DROP TABLE orders"]);
});

test("a longer line over the same choices is answered without asking again", async () => {
  const model = countingModel();
  const cache = cacheOver(model);

  // Typed in one statement, then the statement grows. The ranking is the same
  // question — the statements are not what it ranks — so it is answered from
  // memory. The readings such an answer carries are the ones the model was
  // actually asked about, which is what keeps a reading of `DELETE FROM orders`
  // off the statement the cursor has since grown into.
  await cache.rank("SELECT * FROM ord", CHOICES, about("DELETE FROM orders"));
  const typed = await cache.rank(
    "SELECT * FROM orde",
    CHOICES,
    about("DELETE FROM orders WHERE id = 1"),
  );

  assert.equal(model.asked.length, 1, "the statement grew; the ranking did not change");
  assert.equal(typed.reused, true);
});

test("a different statement over an answered line does not become a second question", async () => {
  const model = countingModel();
  const cache = cacheOver(model);

  await cache.rank("SELECT * FROM ord", CHOICES, about("DELETE FROM orders"));
  const after = await cache.rank("SELECT * FROM ord", CHOICES, about("DROP TABLE orders"));

  // The line is the whole ranking question, and it has an answer. Whether the new
  // statement is dangerous is asked by the editor as a question of its own — one
  // that the answer to the earlier question does not cover — which is what keeps
  // this from being a request per statement change; here it must not be a second
  // request either way.
  assert.equal(model.asked.length, 1);
  assert.equal(after.reused, true);
});

test("the reuse keeps extending while the choices are unchanged", async () => {
  const model = countingModel();
  const cache = cacheOver(model);

  await cache.rank("SELECT * FROM o", CHOICES);
  for (const line of ["SELECT * FROM or", "SELECT * FROM ord", "SELECT * FROM orde"]) {
    const ranked = await cache.rank(line, CHOICES);
    assert.equal(ranked.reused, true, `${line} was answered from memory`);
  }
  assert.equal(model.asked.length, 1, "one question covered the whole word");
});

test("a shorter line is a different question", async () => {
  const model = countingModel();
  const cache = cacheOver(model);

  await cache.rank("SELECT * FROM orde", CHOICES);
  const deleted = await cache.rank("SELECT * FROM ord", CHOICES);

  // Deleting a character can bring a table back into the choices; the answer to
  // the longer line is not evidence about the shorter one.
  assert.equal(deleted.reused, false);
  assert.equal(model.asked.length, 2);
});

test("a line that is not an extension of the asked one is a new question", async () => {
  const model = countingModel();
  const cache = cacheOver(model);

  await cache.rank("SELECT * FROM orders", CHOICES);
  await cache.rank("SELECT id FROM orders2", CHOICES);
  assert.equal(model.asked.length, 2, "the second line was really asked");
});

test("narrower choices are a new question, even on a longer line", async () => {
  // This is the case the live model settled: with both names still offered it
  // answers `orders`, and the moment the fragment points at the other one it
  // switches. The candidate list is what tells the two apart, so a changed list
  // must always be asked afresh.
  const model = countingModel();
  const cache = cacheOver(model);

  await cache.rank("SELECT * FROM order", ["orders", "order_items"]);
  const narrowed = await cache.rank("SELECT * FROM order_i", ["order_items", "orders"]);

  assert.equal(narrowed.reused, false, "the narrowed list was asked about");
  assert.equal(model.asked.length, 2);
});

test("the same names in a different order are a different question", async () => {
  const model = countingModel();
  const cache = cacheOver(model);

  await cache.rank("SELECT * FROM o", ["orders", "order_items"]);
  await cache.rank("SELECT * FROM o", ["order_items", "orders"]);
  // The ranking is a permutation: its order decides how ties are broken, so the
  // list as sent is part of the question.
  assert.equal(model.asked.length, 2);
});

test("a failed request is not remembered as an answer", async () => {
  let attempts = 0;
  const cache = createRankCache({
    settle: 0,
    ask: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("ollama is not running");
      return answer();
    },
  });

  await assert.rejects(cache.rank("SELECT * FROM ord", CHOICES), /not running/);
  const retried = await cache.rank("SELECT * FROM ord", CHOICES);

  assert.equal(attempts, 2, "the second try reached the model");
  assert.equal(retried.reused, false);
});

test("an answer with no ranking is remembered too", async () => {
  // "No model answered" is an answer: re-asking a dead endpoint on every
  // keystroke would help nobody.
  const model = countingModel(answer({ ranked: [], choice: null, available: false, reason: "off" }));
  const cache = cacheOver(model);

  await cache.rank("SELECT * FROM ord", CHOICES);
  const again = await cache.rank("SELECT * FROM ord", CHOICES);
  assert.equal(model.asked.length, 1);
  assert.equal(again.response.available, false);
});

test("knows says whether a question would cost a request", async () => {
  const model = countingModel();
  const cache = cacheOver(model);

  assert.equal(cache.knows("SELECT * FROM ord", CHOICES), false);
  await cache.rank("SELECT * FROM ord", CHOICES);
  assert.equal(cache.knows("SELECT * FROM ord", CHOICES), true, "exactly this question");
  assert.equal(cache.knows("SELECT * FROM orde", CHOICES), true, "an extension of it");
  assert.equal(cache.knows("SELECT * FROM or", CHOICES), false, "a shorter line");

  // Anything `knows` promises must hold: nothing it accepts may ask.
  for (const line of ["SELECT * FROM ord", "SELECT * FROM orde"]) {
    assert.ok(cache.knows(line, CHOICES));
    const before = model.asked.length;
    await cache.rank(line, CHOICES);
    assert.equal(model.asked.length, before, `${line} was answered without asking`);
  }
});

/** A commerce schema with the sort of names a real one has. */
const SCHEMA = [
  "orders",
  "order_items",
  "order_status",
  "order_audit",
  "order_discounts",
  "order_shipments",
  "order_returns",
  "order_events",
  "order_totals",
  "order_tags",
  "order_notes",
  "orders_archive",
  "orchards",
  "customers",
];

/**
 * The editor's own question stream for `word`, typed one character at a time,
 * using the real candidate selection. This is the case where the source runs on
 * every keystroke — while the popup is closed, which is what `activateOnTyping`
 * does — and the case the cache exists for.
 */
function typedQuestions(word: string): { line: string; candidates: string[] }[] {
  const stream: { line: string; candidates: string[] }[] = [];
  for (let end = 1; end <= word.length; end += 1) {
    const token = word.slice(0, end);
    const candidates = candidateNames(SCHEMA, token);
    // The source asks nothing at all about a token with fewer than two takers.
    if (candidates.length < 2) continue;
    stream.push({ line: `SELECT * FROM ${token}`, candidates });
  }
  return stream;
}

test("a word costs one question per set of choices, not one per keystroke", async () => {
  for (const word of ["orders", "order_items", "orchards"]) {
    const stream = typedQuestions(word);
    assert.ok(stream.length >= 2, `${word} is long enough to be worth ranking`);

    const model = countingModel();
    const cache = cacheOver(model);
    for (const { line, candidates } of stream) {
      await cache.rank(line, candidates);
    }

    // As many questions as there are distinct lists of choices — the set the
    // user is choosing from is the question, and it narrows far less often than
    // the cursor moves. Without the cache every one of these would be a request.
    const distinct = new Set(stream.map(({ candidates }) => candidates.join("\u0000")));
    assert.equal(
      model.asked.length,
      distinct.size,
      `${word}: ${stream.length} invocations, ${distinct.size} distinct choice lists, ` +
        `${model.asked.length} questions`,
    );
    assert.ok(
      model.asked.length < stream.length,
      `${word}: the cache saved nothing over ${stream.length} invocations`,
    );
  }
});

test("hasAnswer is about an answer in hand, not a question in flight", async () => {
  const asked: Asked[] = [];
  const cache = createRankCache({ ask: slowModel(asked, 40), settle: 0 });

  const pending = cache.rank("SELECT * FROM ord", CHOICES);
  assert.equal(cache.knows("SELECT * FROM ord", CHOICES), true, "the model is being asked");
  assert.equal(
    cache.hasAnswer("SELECT * FROM ord", CHOICES),
    false,
    "but nothing is in hand, so a caller would still wait",
  );

  await pending;
  assert.equal(cache.hasAnswer("SELECT * FROM ord", CHOICES), true);
  assert.equal(cache.hasAnswer("SELECT * FROM orde", CHOICES), true, "an extension of it");
  assert.equal(
    cache.hasAnswer("SELECT * FROM or", CHOICES),
    false,
    "a longer line's answer says nothing about a shorter one",
  );
});

test("memory stays bounded, and the eldest question is the one forgotten", async () => {
  const model = countingModel();
  const cache = cacheOver(model, { limit: 2 });

  await cache.rank("SELECT * FROM a", ["a1", "a2"]);
  await cache.rank("SELECT * FROM b", ["b1", "b2"]);
  await cache.rank("SELECT * FROM c", ["c1", "c2"]);
  assert.equal(model.asked.length, 3);

  // The first question is past the bound now, so it is asked again rather than
  // answered from something the cache no longer holds.
  await cache.rank("SELECT * FROM a", ["a1", "a2"]);
  assert.equal(model.asked.length, 4, "the eldest question was forgotten");

  // The newest one is still there.
  const recent = await cache.rank("SELECT * FROM c", ["c1", "c2"]);
  assert.equal(model.asked.length, 4, "the newest question is still remembered");
  assert.equal(recent.reused, true);
});

/** Wait for real time to pass, for the tests that need a timer to fire. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One question, as the model saw it. */
interface Asked {
  line: string;
  candidates: string[];
}

/**
 * A model that takes `delay` to answer, and counts a question the moment it is
 * put. The delay is what makes the in-flight window real: with an instant model
 * the answer is back before the next keystroke and almost everything is reused,
 * which is not what a ~450 ms model does.
 */
function slowModel(asked: Asked[], delay: number) {
  return async (line: string, candidates: readonly string[]) => {
    asked.push({ line, candidates: [...candidates] });
    await sleep(delay);
    return answer();
  };
}

/** Type `fragments` the way a keyboard does: fire, wait a moment, fire again. */
async function typeThrough(
  cache: RankCache,
  fragments: readonly string[],
  gap: number,
): Promise<void> {
  for (const fragment of fragments) {
    void cache.rank(`SELECT * FROM ${fragment}`, CHOICES);
    await sleep(gap);
  }
  await sleep(200);
}

test("a burst of writing is one question, not one per keystroke", async () => {
  // The case this exists for. A question costs the model ~450 ms, so while the
  // user is still writing, every keystroke that arrives before the last answer
  // lands is a request of its own.
  const fragments = ["o", "or", "ord", "orde", "order", "orders"];

  const unthrottled: Asked[] = [];
  await typeThrough(createRankCache({ ask: slowModel(unthrottled, 200), settle: 0 }), fragments, 8);

  const settled: Asked[] = [];
  await typeThrough(createRankCache({ ask: slowModel(settled, 200), settle: 30 }), fragments, 8);

  assert.equal(unthrottled.length, fragments.length, "every keystroke was its own question");
  assert.equal(settled.length, 1, "writing without pausing is one question");
  assert.equal(
    settled[0].line,
    "SELECT * FROM orders",
    "and it was put for the line the writer stopped on",
  );
  // The whole point: an order of magnitude fewer questions for one word.
  assert.ok(settled.length * 3 < unthrottled.length);
});

test("a typed word costs one question per set of choices, even on a slow model", async () => {
  const stream = typedQuestions("orders");
  const asked: Asked[] = [];
  const cache = createRankCache({ ask: slowModel(asked, 120), settle: 20 });

  for (const { line, candidates } of stream) {
    void cache.rank(line, candidates);
    // Faster than the settle window, the way writing is.
    await sleep(5);
  }
  await sleep(250);

  const distinct = new Set(stream.map(({ candidates }) => candidates.join("\u0000")));
  assert.equal(
    asked.length,
    distinct.size,
    `${stream.length} invocations over ${distinct.size} choice lists put ${asked.length} questions`,
  );
  assert.ok(asked.length < stream.length, "the settle window saved nothing");
});

test("a question that arrives while the answer is in flight joins it", async () => {
  const asked: Asked[] = [];
  const cache = createRankCache({ ask: slowModel(asked, 60), settle: 10 });

  const first = cache.rank("SELECT * FROM ord", CHOICES);
  // Long enough for the settle window to close and the request to be out.
  await sleep(30);
  assert.equal(asked.length, 1, "the first burst's question is in flight");

  const second = cache.rank("SELECT * FROM orde", CHOICES);
  await Promise.all([first, second]);

  assert.equal(asked.length, 1, "the longer line was answered by the request already out");
});

test("a line that is not an extension of the one in flight is its own question", async () => {
  const asked: Asked[] = [];
  const cache = createRankCache({ ask: slowModel(asked, 60), settle: 10 });

  const first = cache.rank("SELECT * FROM orders", CHOICES);
  await sleep(30);
  const second = cache.rank("SELECT id FROM orders", CHOICES);
  await Promise.all([first, second]);

  // The in-flight request says nothing about a different line's statement, so
  // the reuse rule does not cover it.
  assert.equal(asked.length, 2);
});

test("a pause between words puts a question for each word", async () => {
  const asked: Asked[] = [];
  const cache = createRankCache({ ask: slowModel(asked, 5), settle: 30 });

  await cache.rank("SELECT * FROM orders", CHOICES);
  assert.equal(asked.length, 1);
  // A second word after a pause is a second question — settling collapses
  // writing, it does not stop the model being asked about new writing.
  await sleep(50);
  await cache.rank("SELECT * FROM order_items", CHOICES);
  assert.equal(asked.length, 2);
});
