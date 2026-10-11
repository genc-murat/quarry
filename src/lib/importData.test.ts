import assert from "node:assert/strict";
import test from "node:test";

import { parseImport } from "./importData.ts";

test("CSV parser handles quoted commas, quotes, newlines and NULL marker", () => {
  const parsed = parseImport('id,note\n1,"hello, world"\n2,"line 1\nline 2"\n3,\\N\n', "csv");
  assert.deepEqual(parsed.columns, ["id", "note"]);
  assert.deepEqual(parsed.rows, [["1", "hello, world"], ["2", "line 1\nline 2"], ["3", null]]);
});

test("JSON parser unions keys and represents missing fields as null", () => {
  const parsed = parseImport('[{"id":1,"name":"Ada"},{"id":2,"active":true}]', "json");
  assert.deepEqual(parsed.columns, ["id", "name", "active"]);
  assert.deepEqual(parsed.rows, [[1, "Ada", null], [2, null, true]]);
});

test("CSV shape, headers and JSON root are validated", () => {
  assert.throws(() => parseImport("a,a\n1,2", "csv"), /unique/);
  assert.throws(() => parseImport("a,b\n1", "csv"), /expected 2/);
  assert.throws(() => parseImport('{"id":1}', "json"), /array of objects/);
  assert.throws(() => parseImport('"unterminated', "csv"), /unterminated/);
});
