import assert from "node:assert/strict";
import test from "node:test";

import { alignResultColumns, compareResults, profileResult, profileRows } from "./resultAnalysis.ts";
import type { StatementResult } from "./types.ts";

function result(names: string[], rows: unknown[][]): StatementResult {
  return {
    statement: "SELECT sample",
    isQuery: true,
    columns: names.map((name) => ({ name })),
    rows,
    rowCount: rows.length,
    executionMs: 1,
    truncated: false,
  };
}

test("keyed comparison aligns reordered columns and reports changes in shared fields", () => {
  const before = result(["tenant", "id", "value", "old"], [
    [1, "a", null, 0], [2, "a", "keep", 0], [2, "b", "remove", 0],
  ]);
  const after = result(["value", "id", "tenant", "new"], [
    ["keep", "a", 2, true], ["", "a", 1, true], ["add", "c", 2, true],
  ]);
  const aligned = alignResultColumns(before, after);
  assert.deepEqual(aligned.onlyBefore, ["old"]);
  assert.deepEqual(aligned.onlyAfter, ["new"]);
  const diff = compareResults(before, after, aligned, ["tenant", "id"]);
  assert.ok(!("error" in diff));
  assert.deepEqual(diff.counts, { added: 1, removed: 1, changed: 1 });
  assert.equal(diff.matching, 1);
  assert.deepEqual(diff.differences[0], {
    kind: "changed", fields: ["value"], before: before.rows[0], after: after.rows[1],
  });
});

test("unkeyed comparison preserves duplicate counts and JSON value types", () => {
  const before = result(["value"], [[{ z: 2, a: [1] }], [1], [1], [null]]);
  const after = result(["value"], [[null], [{ a: [1], z: 2 }], [1], ["1"]]);
  const diff = compareResults(before, after, alignResultColumns(before, after), []);
  assert.deepEqual(diff, {
    differences: [{ kind: "added", after: ["1"] }, { kind: "removed", before: [1] }],
    counts: { added: 1, removed: 1, changed: 0 },
    matching: 3,
  });
});

test("CQL decimal comparison preserves precision and the original report values", () => {
  const before = result(["cluster", "amount", "status"], [
    ["12.0", "9007199254740993.01", "old"], ["13.00", "-0.00", "same"],
  ]);
  const after = result(["cluster", "amount", "status"], [
    ["1.200e+1", "9007199254740993.02", "new"], ["13.0", "0E+10", "same"],
  ]);
  for (const sample of [before, after]) {
    sample.columns[0].compareAsDecimal = true;
    sample.columns[1].compareAsDecimal = true;
  }
  const aligned = alignResultColumns(before, after);
  assert.deepEqual(compareResults(before, after, aligned, ["cluster"]), {
    differences: [{ kind: "changed", fields: ["amount", "status"], before: before.rows[0], after: after.rows[0] }],
    counts: { added: 0, removed: 0, changed: 1 },
    matching: 1,
  });
  const unkeyed = compareResults(before, after, aligned, []);
  assert.ok(!("error" in unkeyed));
  assert.deepEqual(unkeyed.counts, { added: 1, removed: 1, changed: 0 });
  assert.equal(unkeyed.matching, 1);

  before.columns[0].compareAsDecimal = false;
  after.columns[0].compareAsDecimal = false;
  assert.deepEqual(compareResults(before, after, alignResultColumns(before, after), ["cluster"]), {
    differences: [
      { kind: "added", after: after.rows[0] }, { kind: "added", after: after.rows[1] },
      { kind: "removed", before: before.rows[0] }, { kind: "removed", before: before.rows[1] },
    ],
    counts: { added: 2, removed: 2, changed: 0 },
    matching: 0,
  });
});

test("CQL decimal profiling groups equal values and shows their stored scale", () => {
  const sample = result(["amount"], [["12.0"], ["12.00"], ["12.01"]]);
  sample.columns[0].compareAsDecimal = true;
  assert.deepEqual(profileResult(sample), [{ nulls: 0, blanks: 0, distinct: 2, repeats: 2 }]);
  assert.deepEqual(profileRows(sample, 0, "repeats"), [{ row: 1, value: "12.0" }, { row: 2, value: "12.00" }]);
});

test("invalid row identities and ambiguous column names produce explicit errors", () => {
  const before = result(["id"], [[1]]);
  for (const [after, message] of [
    [result(["id"], [[1], [1]]), /After contains duplicate keys/],
    [result(["id"], [[null]]), /After contains NULL keys/],
    [result(["id", "id"], [[1, 2]]), /unique column aliases/],
    [result(["different"], [[1]]), /same name/],
  ] as const) {
    const diff = compareResults(before, after, alignResultColumns(before, after), ["id"]);
    assert.ok("error" in diff);
    assert.match(diff.error, message);
  }
});

test("profiles count NULL, whitespace, and repeated typed values and locate their rows", () => {
  const sample = result(["value"], [[null], [" "], [""], [0], ["0"], [false], [0], [" "]]);
  assert.deepEqual(profileResult(sample), [{ nulls: 1, blanks: 3, distinct: 5, repeats: 4 }]);
  assert.deepEqual(profileRows(sample, 0, "blanks").map(({ row }) => row), [2, 3, 8]);
  assert.deepEqual(profileRows(sample, 0, "repeats").map(({ row }) => row), [2, 4, 7, 8]);
});

test("a document query with no matches can be compared without inferred removal of columns", () => {
  const before = result(["_id", "status"], [[1, "open"]]);
  const after = result([], []);
  const aligned = alignResultColumns(before, after);
  assert.equal(aligned.inferred, true);
  assert.deepEqual(aligned.onlyBefore, []);
  assert.deepEqual(compareResults(before, after, aligned, ["_id"]), {
    differences: [{ kind: "removed", before: [1, "open"] }],
    counts: { added: 0, removed: 1, changed: 0 },
    matching: 0,
  });
});
