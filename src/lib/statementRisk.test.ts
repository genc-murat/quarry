import test from "node:test";
import assert from "node:assert/strict";

import {
  createStatementReads,
  cursorStatement,
  destructiveTitle,
  isDestructive,
  MAX_RISK_STATEMENTS,
  MAX_STATEMENT_CHARS,
  presented,
  reachesEveryRow,
  riskLabel,
  statementsInScript,
  statementsToRun,
  wholeScriptTitle,
  worst,
} from "./statementRisk.ts";
import type { RiskVerdict, StatementReading } from "./types.ts";

/** A reading as the client reports one, at a position the model measured. */
function read(
  statement: string,
  verdict: RiskVerdict,
  level: number,
  confidence = 0.9,
): StatementReading {
  return { statement, verdict, level, confidence };
}

// ------------------------------------------- what a command would send ---------

test("a selection is the whole of what Run sends, not just the statement under the cursor", () => {
  const sql = "SELECT 1;\nDELETE FROM orders;\nSELECT 2";
  // The cursor sits in the first statement while the selection covers three: the
  // question has to be about the three, because they are what would run.
  assert.deepEqual(statementsToRun(sql, 0, sql.length), [
    "SELECT 1",
    "DELETE FROM orders",
    "SELECT 2",
  ]);
});

test("without a selection the statement under the cursor is what Run sends", () => {
  const sql = "SELECT 1;\nDELETE FROM orders WHERE id = 3";
  assert.deepEqual(statementsToRun(sql, sql.length, sql.length), [
    "DELETE FROM orders WHERE id = 3",
  ]);
  assert.deepEqual(statementsToRun(sql, 6, 6), ["SELECT 1"]);
});

test("a whitespace-only selection falls back to the cursor statement, as Run does", () => {
  assert.deepEqual(statementsToRun("SELECT 1;   SELECT 2;", 10, 12), ["SELECT 1"]);
});

test("an empty editor has nothing to ask about", () => {
  assert.deepEqual(statementsToRun("   \n\n ", 2, 2), []);
  assert.deepEqual(statementsInScript("   \n\n "), []);
});

test("the script is every one of its statements, in the order they run", () => {
  // A comment belongs to the statement it precedes — the split keeps it, and Run
  // sends it — so it is part of what the model is shown, and part of what a reading
  // of that statement is about.
  assert.deepEqual(statementsInScript("-- a comment\nSELECT 1;\nDROP TABLE orders;\n"), [
    "-- a comment\nSELECT 1",
    "DROP TABLE orders",
  ]);
});

test("the same statement twice is one question", () => {
  // A reading is keyed by the statement itself, so asking about the same text
  // twice would pay two questions' worth of prompt for one answer.
  assert.deepEqual(statementsInScript("SELECT 1; SELECT 1; SELECT 2"), ["SELECT 1", "SELECT 2"]);
});

test("a script is read up to the bound, in the order it runs", () => {
  const script = Array.from(
    { length: MAX_RISK_STATEMENTS + 5 },
    (_, index) => `SELECT ${index}`,
  ).join(";\n");
  const statements = statementsInScript(script);
  assert.equal(statements.length, MAX_RISK_STATEMENTS, "the bound is what decides, not the file");
  assert.equal(statements[0], "SELECT 0");
  assert.equal(statements.at(-1), `SELECT ${MAX_RISK_STATEMENTS - 1}`);
});

test("an enormous statement keeps its head, which names it and its table", () => {
  const huge = `DELETE FROM orders WHERE id IN (${"1,".repeat(MAX_STATEMENT_CHARS)})`;
  const [statement] = statementsInScript(huge);
  assert.equal(statement.length, MAX_STATEMENT_CHARS);
  assert.ok(statement.startsWith("DELETE FROM orders"));
});

test("the cursor statement is trimmed, and an empty one is nothing to ask about", () => {
  assert.equal(cursorStatement("  \n  SELECT 1  \n", 5), "SELECT 1");
  assert.equal(cursorStatement("", 0), null);
  assert.equal(cursorStatement("   \n\n  ", 3), null);
});

// ------------------------------------------------------------- the policy ------

test("the steps that take something away are the ones worth a mark", () => {
  // The positions a real model put these at, on its own scale.
  assert.equal(riskLabel(read("DROP TABLE orders", "structure", 2.988)), "Removes a table");
  assert.equal(riskLabel(read("DELETE FROM orders", "rows", 1.646)), "Removes every row");
  // An ordinary edit, and a statement that changes nothing: both are silent, which
  // is what keeps the mark from being noise on every other statement. The scale
  // puts a one-row `DELETE` at 1.05 and a bounded `UPDATE` at 1.00 — the same step,
  // which is why neither is marked.
  assert.equal(
    riskLabel(read("UPDATE orders SET status = 'paid' WHERE id = 1", "bounded", 1.0)),
    null,
  );
  assert.equal(riskLabel(read("SELECT * FROM orders WHERE id = 1", "safe", 0.018)), null);
  // No reading at all is not a safe reading: it is nothing to say.
  assert.equal(riskLabel(null), null);
  assert.equal(riskLabel(undefined), null);
});

test("whether there is something to say is decided in one place", () => {
  assert.equal(isDestructive(read("DROP TABLE orders", "structure", 2.988)), true);
  assert.equal(isDestructive(read("SELECT 1", "safe", 0.018)), false);
  assert.equal(isDestructive(null), false);
});

test("the worst reading of a set decides, and a set with none is not a safe one", () => {
  const drop = read("DROP TABLE orders", "structure", 2.988);
  const remove = read("DELETE FROM orders", "rows", 1.646);
  const select = read("SELECT 1", "safe", 0.018);
  assert.equal(worst([select, remove, drop]), drop);
  assert.equal(worst([select, drop, remove]), drop);
  assert.equal(worst([remove, select]), remove);
  assert.equal(worst([select]), select);
  // Two readings on the same step: the one the model put further along it.
  assert.equal(
    worst([read("TRUNCATE TABLE a", "rows", 1.6), read("DELETE FROM b", "rows", 1.9)])
      ?.statement,
    "DELETE FROM b",
  );
  // Nothing read is null, so a caller can tell "nothing dangerous" from "nothing
  // known" — the two look the same on screen and are not the same fact.
  assert.equal(worst([null, undefined]), null);
  assert.equal(worst([]), null);
});

// -------------------------------------------------------- the text floor -------

test("an UPDATE that names no row is the rows step whatever the model read", () => {
  // Measured, the model reads this 1.06 — a bounded write, one step above a
  // one-row DELETE and two below what the statement's own text says. The floor
  // is what closes that gap; see src-tauri/src/decision.rs for the numbers.
  const unbounded = read("UPDATE orders SET status = 'paid'", "bounded", 1.06);
  assert.equal(riskLabel(unbounded), "Removes every row");
  assert.equal(isDestructive(unbounded), true);
  assert.equal(presented(unbounded)?.verdict, "rows");
  // Raised, not rewritten: the model's position and confidence stay on the
  // reading, which is what lets the tooltip quote both voices.
  assert.equal(presented(unbounded)?.level, 1.06);
  assert.equal(presented(unbounded)?.confidence, 0.9);
  // The same of a statement the model missed entirely — a null reading stays
  // null, because the floor raises a reading and does not invent one.
  assert.equal(presented(null), null);
});

test("the floor applies only where the statement's own text says every row", () => {
  // A WHERE at the top level bounds the statement, and the model's step stands.
  assert.equal(
    riskLabel(read("UPDATE orders SET status = 'paid' WHERE id = 1", "bounded", 1.0)),
    null,
  );
  assert.equal(reachesEveryRow("DELETE FROM orders WHERE id IN (1, 2)"), false);
  // A LIMIT bounds the count where the dialect offers one (MySQL), and a
  // subquery's own clauses bound only the subquery.
  assert.equal(reachesEveryRow("UPDATE t SET a = 1 LIMIT 1"), false);
  assert.equal(reachesEveryRow("DELETE FROM orders ORDER BY id LIMIT 10"), false);
  assert.equal(reachesEveryRow("UPDATE t SET a = (SELECT x FROM s LIMIT 1)"), true);
  // Statements keep their leading comment (the splitter's contract), so the
  // floor has to read past one to find the head at all.
  assert.equal(reachesEveryRow("-- a comment\nUPDATE t SET a = 1"), true);
  // One inside a literal, a quoted identifier, a comment or a subquery does not
  // bound anything — the statement is still unbounded.
  assert.equal(reachesEveryRow("UPDATE t SET note = 'WHERE id = 1'"), true);
  assert.equal(reachesEveryRow("UPDATE t SET note = 'it''s WHERE id = 1'"), true);
  assert.equal(reachesEveryRow("UPDATE `where` SET a = 1"), true);
  assert.equal(reachesEveryRow("UPDATE t SET a = 1 /* WHERE id = 1 */"), true);
  assert.equal(reachesEveryRow("UPDATE t SET a = 1 -- WHERE id = 1\n"), true);
  assert.equal(reachesEveryRow("UPDATE t SET a = (SELECT x FROM s WHERE s.id = t.id)"), true);
  assert.equal(reachesEveryRow("UPDATE t SET a = $$WHERE id = 1$$"), true);
  // A placeholder is not a dollar quote, and a word that only holds WHERE is not
  // a WHERE.
  assert.equal(reachesEveryRow("UPDATE t SET a = $1"), true);
  assert.equal(reachesEveryRow("UPDATE t SET a = 1 WHERE x LIKE '%elsewhere%'"), false);
  // DELETE bounds itself the same way; TRUNCATE is unbounded outright; and the
  // match is on words, not case or identifiers that merely contain them.
  assert.equal(reachesEveryRow("DELETE FROM orders"), true);
  assert.equal(reachesEveryRow("truncate table orders"), true);
  assert.equal(reachesEveryRow("SELECT updated_at FROM orders WHERE id = 1"), false);
  assert.equal(reachesEveryRow("INSERT INTO orders SELECT * FROM old_orders"), false);
});

test("a statement cut at the head is out of the floor's reach", () => {
  // A statement this long was truncated before the model saw it: the tail where
  // a WHERE would sit was read by nobody, so the model's answer stands alone.
  const tail = ` WHERE id IN (${"1,".repeat(MAX_STATEMENT_CHARS - 200)})`;
  const truncated = `UPDATE orders SET status = 'paid'${tail}`.slice(0, MAX_STATEMENT_CHARS);
  assert.equal(truncated.length, MAX_STATEMENT_CHARS);
  assert.equal(reachesEveryRow(truncated), false);
  assert.equal(riskLabel(read(truncated, "bounded", 1.06)), null);
});

test("the worst reading decides on the raised step and hands back the model's own", () => {
  const unbounded = read("UPDATE orders SET status = 'paid'", "bounded", 1.06);
  const bounded = read("UPDATE orders SET note = 'x' WHERE id = 1", "bounded", 1.4);
  // The floored reading wins the set even though the model put it lower: the
  // set's worst is the worst of what each statement reaches.
  assert.equal(worst([bounded, unbounded]), unbounded);
  // Raised, never lowered — a structure reading still outranks a floored one.
  const drop = read("DROP TABLE orders", "structure", 2.988);
  assert.equal(worst([unbounded, drop]), drop);
  // And the returned reading is the model's own, so a caller that quotes it
  // quotes the model, not the floor.
  assert.equal(worst([unbounded])?.verdict, "bounded");
});

test("the tooltip of a raised reading quotes both voices", () => {
  const title = destructiveTitle(read("UPDATE orders SET status = 'paid'", "bounded", 1.06, 0.9));
  // The step the text states, and the lower one the model read: a raised reading
  // quoted as the model's own would be a claim the model never made.
  assert.ok(title.includes("removes or rewrites every row of a table"), title);
  assert.ok(title.includes("writes a bounded number of existing rows"), title);
  assert.match(title, /90%/, title);
  assert.match(title, /position 1\.06/, title);
  assert.match(title, /this exact statement/, title);
  assert.ok(title.includes("UPDATE orders SET status = 'paid'"), title);
  // An unraised reading keeps the model-words-only tooltip.
  const plain = destructiveTitle(read("DROP TABLE orders", "structure", 2.988, 0.963));
  assert.ok(plain.includes("The local model put this statement"), plain);
});

// -------------------------------------------------------------- the store ------

test("a reading belongs to the exact statement it was asked about", () => {
  const reads = createStatementReads();
  reads.remember(read("DELETE FROM orders", "rows", 1.646));
  assert.equal(reads.get("DELETE FROM orders")?.verdict, "rows");
  assert.equal(reads.get("DELETE FROM orders")?.level, 1.646);
  // A different statement, which the model never saw: its reading of the first one
  // is no evidence about this one, in either direction.
  assert.equal(reads.get("DELETE FROM orders WHERE id = 1"), null);
  assert.equal(reads.get("DELETE FROM orders WHERE 1 = 1"), null);
});

test("a later reading of the same statement is the current one", () => {
  const reads = createStatementReads();
  reads.remember(read("DELETE FROM orders", "safe", 0.02));
  reads.remember(read("DELETE FROM orders", "rows", 1.65));
  assert.equal(reads.get("DELETE FROM orders")?.verdict, "rows");
});

test("a question that was not asked keeps no answer", () => {
  const reads = createStatementReads();
  reads.remember(null);
  reads.remember(undefined);
  // A reading with no statement is a reading of nothing, and filing it under the
  // empty string would answer every statement that happens to be blank.
  reads.remember({ statement: "", verdict: "rows", level: 1.6, confidence: 0.9 });
  assert.equal(reads.get("DELETE FROM orders"), null);
  assert.equal(reads.get(""), null);
});

test("only the statements in recent use are kept", () => {
  const reads = createStatementReads({ limit: 2 });
  reads.remember(read("A", "structure", 3));
  reads.remember(read("B", "rows", 2));
  reads.remember(read("C", "rows", 2));
  // A is the least recently read, so it went first.
  assert.equal(reads.get("A"), null);
  assert.equal(reads.get("B")?.verdict, "rows");
  // Reading B makes it the most recent, so C is the next to go.
  reads.get("B");
  reads.remember(read("D", "rows", 2));
  assert.equal(reads.get("C"), null);
  assert.equal(reads.get("B")?.verdict, "rows");
});

// -------------------------------------------------------------- the words -----

test("the badge's tooltip says what was read, how sure, and about which statement", () => {
  const title = destructiveTitle(read("DROP TABLE orders", "structure", 2.988, 0.963));
  // The model's own step, quoted: the words are its scale's, not the editor's.
  assert.ok(title.includes("removes a table or its data permanently"), title);
  assert.match(title, /96%/, title);
  assert.match(title, /position 2\.99/, title);
  // And the statement itself: a command can be about to send several, so a mark
  // that did not say which would leave the reader to guess.
  assert.ok(title.includes("DROP TABLE orders"), title);
  assert.match(title, /this exact statement/, title);
});

test("the script's tooltip says which statement, and how much of the file was read", () => {
  const title = wholeScriptTitle(read("TRUNCATE TABLE orders", "rows", 1.973), 3, 20);
  assert.ok(title.includes("Removes every row"), title);
  assert.ok(title.includes("TRUNCATE TABLE orders"), title);
  // The statements nobody has read are the ones such a mark cannot speak for, so
  // the count is part of the message.
  assert.match(title, /3 of 20 statements/, title);
});

test("a one-statement script says so in the singular", () => {
  assert.match(
    wholeScriptTitle(read("DROP TABLE orders", "structure", 2.988), 1, 1),
    /1 of 1 statement read/,
  );
});
