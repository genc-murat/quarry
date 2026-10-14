import test from "node:test";
import assert from "node:assert/strict";

import {
  applyBoosts,
  candidateNames,
  MAX_RANK_CANDIDATES,
  TOP_BOOST,
} from "./completionRank.ts";

/** The slice of a completion this module works with. */
type Option = { label: string; boost?: number };

function optionsOf(...labels: string[]): Option[] {
  return labels.map((label) => ({ label }));
}

test("prefix matches are offered before interior ones", () => {
  assert.deepEqual(candidateNames(["suborders", "orders"], "ord"), ["orders", "suborders"]);
});

test("an empty token is not a question worth asking", () => {
  assert.deepEqual(candidateNames(["orders", "order_items"], ""), []);
});

test("duplicate names collapse, case-insensitively and first one wins", () => {
  assert.deepEqual(candidateNames(["Orders", "orders"], "ord"), ["Orders"]);
});

test("non-matching tables are left out", () => {
  assert.deepEqual(candidateNames(["orders", "customers"], "ord"), ["orders"]);
});

test("the candidate list is capped so one keystroke stays small", () => {
  const many = Array.from({ length: MAX_RANK_CANDIDATES + 5 }, (_, index) => `order_${index}`);
  assert.equal(candidateNames(many, "order").length, MAX_RANK_CANDIDATES);
});

test("ranking lifts the model's pick above the rest, in order", () => {
  const boosted = applyBoosts(optionsOf("orders", "order_items", "orchards"), [
    "order_items",
    "orders",
    "orchards",
  ]);
  assert.deepEqual(
    boosted.map((option) => option.boost),
    [TOP_BOOST - 1, TOP_BOOST, TOP_BOOST - 2],
  );
});

test("no ranking returns an unboosted copy", () => {
  const options = optionsOf("orders");
  const boosted = applyBoosts(options, []);
  assert.equal(boosted[0].boost, undefined);
  assert.notEqual(boosted, options);
});

test("names the model invented are ignored", () => {
  const boosted = applyBoosts([{ label: "orders", boost: 3 }], ["not_a_table", "orders"]);
  // "orders" is second in the ranking, so it lands at TOP_BOOST - 1.
  assert.equal(boosted[0].boost, TOP_BOOST - 1);
});

test("boosting matches labels without regard to case", () => {
  const boosted = applyBoosts(optionsOf("Orders"), ["orders"]);
  assert.equal(boosted[0].boost, TOP_BOOST);
});

test("a ranking longer than we would ever send stays inside the boost range", () => {
  const long = Array.from({ length: 250 }, (_, index) => `table_${index}`);
  const boosted = applyBoosts(optionsOf("table_200"), long);
  assert.ok(boosted[0].boost !== undefined);
  assert.ok(boosted[0].boost >= -TOP_BOOST && boosted[0].boost <= TOP_BOOST);
});
