import assert from "node:assert/strict";
import test from "node:test";

import { splitStatements, sqlToRun, statementAtCursor } from "./sqlScript.ts";

const texts = (sql: string) => splitStatements(sql).map((statement) => statement.text);

// ------------------------------------------------------------ splitting ----

test("splits simple statements", () => {
  assert.deepEqual(texts("SELECT 1; SELECT 2"), ["SELECT 1", "SELECT 2"]);
});

test("ignores semicolons inside strings", () => {
  assert.deepEqual(texts("SELECT 'a;b'; SELECT 2"), ["SELECT 'a;b'", "SELECT 2"]);
});

test("ignores semicolons inside comments", () => {
  const out = texts("SELECT 1 -- hi; there\n; SELECT 2");
  assert.equal(out.length, 2);
  assert.match(out[0], /SELECT 1/);
  assert.equal(out[1], "SELECT 2");
});

test("handles backticks and escaped quotes", () => {
  assert.deepEqual(texts("SELECT `we;ird`, 'it\\'s' FROM t"), ["SELECT `we;ird`, 'it\\'s' FROM t"]);
});

test("handles PostgreSQL dollar quotes", () => {
  const out = texts("CREATE FUNCTION f() AS $$ BEGIN; END; $$ LANGUAGE plpgsql;");
  assert.equal(out.length, 1);
  assert.match(out[0], /BEGIN; END;/);
});

test("keeps a SQLite trigger body together", () => {
  const sql =
    "CREATE TRIGGER t AFTER INSERT ON a BEGIN INSERT INTO b VALUES (1); UPDATE c SET x = CASE WHEN NEW.x > 0 THEN 1 ELSE 0 END; END; SELECT 2";
  const out = texts(sql);
  assert.equal(out.length, 2);
  assert.match(out[0], /^CREATE TRIGGER/);
  assert.match(out[0], /END$/);
  assert.equal(out[1], "SELECT 2");
});

test("keeps MySQL procedure control flow together", () => {
  const out = texts(
    "CREATE PROCEDURE p() BEGIN IF x THEN SELECT 1; END IF; CASE WHEN 1 THEN SELECT 2; END CASE; END; SELECT 3",
  );
  assert.equal(out.length, 2);
  assert.equal(out[1], "SELECT 3");
});

test("a CASE outside a body statement does not swallow the next statement", () => {
  assert.deepEqual(texts("SELECT CASE WHEN 1 THEN 2 END; SELECT 3"), [
    "SELECT CASE WHEN 1 THEN 2 END",
    "SELECT 3",
  ]);
});

test("empty input yields nothing", () => {
  assert.deepEqual(splitStatements("   ;;  "), []);
});

test("offsets point at the trimmed statement inside the script", () => {
  const sql = "  SELECT 1;\nSELECT 2 ;";
  const [first, second] = splitStatements(sql);
  assert.equal(sql.slice(first.from, first.to), "SELECT 1");
  assert.equal(sql.slice(second.from, second.to), "SELECT 2");
  // `end` reaches past the terminating semicolon.
  assert.equal(sql[second.end - 1], ";");
});

// ----------------------------------------------------- cursor resolution ----

const script = "SELECT 1;\nSELECT 2;\nSELECT 3";

test("a cursor inside a statement picks that statement", () => {
  const sql = script;
  assert.equal(statementAtCursor(sql, 3)?.text, "SELECT 1");
  assert.equal(statementAtCursor(sql, 12)?.text, "SELECT 2");
  assert.equal(statementAtCursor(sql, 22)?.text, "SELECT 3");
});

test("a cursor on a statement boundary or in the gap picks the previous statement", () => {
  // Right on the first `;` belongs to the first statement.
  assert.equal(statementAtCursor(script, 8)?.text, "SELECT 1");
  // Just after the `;`, in the whitespace, still the first statement.
  assert.equal(statementAtCursor(script, 9)?.text, "SELECT 1");
});

test("a cursor before the first statement picks the first one", () => {
  assert.equal(statementAtCursor("   SELECT 1;", 0)?.text, "SELECT 1");
});

test("an empty script has no statement", () => {
  assert.equal(statementAtCursor("   ", 1), null);
});

// ----------------------------------------------------------- sqlToRun ------

test("a non-empty selection wins over the cursor statement", () => {
  const sql = "SELECT 1; SELECT 2;";
  // Select the second statement while the caret is inside the first.
  assert.equal(sqlToRun(sql, 0, sql.indexOf("SELECT 2") + 8), "SELECT 1; SELECT 2");
});

test("a whitespace-only selection falls back to the cursor statement", () => {
  assert.equal(sqlToRun("SELECT 1;   SELECT 2;", 10, 12), "SELECT 1");
});

test("without a selection the cursor statement is used", () => {
  assert.equal(sqlToRun(script, 13, 13), "SELECT 2");
});
