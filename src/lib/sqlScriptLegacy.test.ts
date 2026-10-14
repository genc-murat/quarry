/**
 * The scanner in `sqlScript.ts` was rewritten to work on character codes, which
 * is most of what a keystroke in a large script costs (it runs twice per
 * keystroke — the active-statement highlight and the completion source's
 * question — and the previous version took 94 ms for a 4 MB script against 11 ms
 * now). A rewrite of a state machine this size is only safe if it can be shown
 * to answer exactly as before, and no hand-written list of cases can show that:
 * the interesting inputs are combinations of quotes, comments, dollar tags and
 * `BEGIN ... END` bodies, and the failures are in the combinations.
 *
 * So the previous implementation is kept here, frozen, as the definition of what
 * the scanner means: it is copied verbatim from `sqlScript.ts` as it stood before
 * the rewrite, comments included, and it is never to be "fixed" or extended. The
 * tests below run both over the same documents — the awkward cases spelled out,
 * and a few hundred generated ones built out of the pieces that switch the
 * scanner's state — and require identical ranges, offsets and all.
 *
 * A failure here means the rewrite changed behaviour, not that the reference is
 * wrong. If a behaviour change is ever wanted, change both sides in one commit
 * and say so; deleting the reference would throw away the only evidence that the
 * fast scanner is the same scanner.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { splitStatements, type StatementRange } from "./sqlScript.ts";

// ------------------------------------------------------- the reference ------

type LegacyState =
  | "normal"
  | "singleQuote"
  | "doubleQuote"
  | "backtick"
  | "lineComment"
  | "blockComment"
  | "dollarQuote";

const LEGACY_BODY_KINDS = ["TRIGGER", "PROCEDURE", "FUNCTION", "EVENT"];
const LEGACY_HEAD_WORDS = 8;

class LegacyBlockTracker {
  private head: string[] = [];
  private depth = 0;
  private pendingEnd = false;

  private inBodyStatement(): boolean {
    return (
      this.head[0] === "CREATE" &&
      this.head.some((word) => LEGACY_BODY_KINDS.includes(word))
    );
  }

  word(word: string): void {
    if (this.head.length < LEGACY_HEAD_WORDS) this.head.push(word);
    if (!this.inBodyStatement()) return;

    if (this.pendingEnd) {
      this.pendingEnd = false;
      if (word === "IF" || word === "LOOP" || word === "WHILE" || word === "REPEAT") return;
      this.depth = Math.max(0, this.depth - 1);
      if (word === "CASE") return;
    }

    if (word === "BEGIN" || word === "CASE") this.depth += 1;
    else if (word === "END") this.pendingEnd = true;
  }

  finishPending(): void {
    if (this.pendingEnd) {
      this.pendingEnd = false;
      this.depth = Math.max(0, this.depth - 1);
    }
  }

  get open(): boolean {
    return this.depth > 0;
  }
}

const LEGACY_WORD_CHAR = /[A-Za-z0-9_]/;

function legacyReadDollarTag(sql: string, index: number): { tag: string; next: number } | null {
  let tag = "$";
  for (let i = index + 1; i < sql.length; i += 1) {
    const char = sql[i];
    if (char === "$") return { tag: `${tag}$`, next: i + 1 };
    if (LEGACY_WORD_CHAR.test(char)) {
      tag += char;
      continue;
    }
    return null;
  }
  return null;
}

function legacySplitStatements(sql: string): StatementRange[] {
  const statements: StatementRange[] = [];
  let start = 0;
  let state: LegacyState = "normal";
  let i = 0;
  let dollarTag: string | null = null;
  let word = "";
  let tracker = new LegacyBlockTracker();

  const flushWord = () => {
    if (word) {
      tracker.word(word);
      word = "";
    }
  };

  const push = (rawEnd: number, end: number) => {
    const raw = sql.slice(start, rawEnd);
    const lead = raw.length - raw.trimStart().length;
    const tail = raw.trimEnd().length;
    if (tail > 0) {
      statements.push({
        text: sql.slice(start + lead, start + tail),
        from: start + lead,
        to: start + tail,
        end,
      });
    }
  };

  while (i < sql.length) {
    const char = sql[i];
    if (state === "normal") {
      if (LEGACY_WORD_CHAR.test(char)) {
        word += char.toUpperCase();
        i += 1;
        continue;
      }
      flushWord();
    }

    switch (state) {
      case "normal":
        if (char === "'") {
          state = "singleQuote";
          i += 1;
        } else if (char === '"') {
          state = "doubleQuote";
          i += 1;
        } else if (char === "`") {
          state = "backtick";
          i += 1;
        } else if (char === "#") {
          state = "lineComment";
          i += 1;
        } else if (char === "-" && sql[i + 1] === "-") {
          state = "lineComment";
          i += 2;
        } else if (char === "$") {
          const tag = legacyReadDollarTag(sql, i);
          if (tag) {
            dollarTag = tag.tag;
            state = "dollarQuote";
            i = tag.next;
          } else {
            i += 1;
          }
        } else if (char === "/" && sql[i + 1] === "*") {
          state = "blockComment";
          i += 2;
        } else if (char === ";") {
          tracker.finishPending();
          if (!tracker.open) {
            push(i, i + 1);
            tracker = new LegacyBlockTracker();
            start = i + 1;
          }
          i += 1;
        } else {
          i += 1;
        }
        break;

      case "singleQuote":
        if (char === "\\") i += 2;
        else if (char === "'") {
          if (sql[i + 1] === "'") i += 2;
          else {
            state = "normal";
            i += 1;
          }
        } else i += 1;
        break;

      case "doubleQuote":
        if (char === '"') {
          if (sql[i + 1] === '"') i += 2;
          else {
            state = "normal";
            i += 1;
          }
        } else i += 1;
        break;

      case "backtick":
        if (char === "`") state = "normal";
        i += 1;
        break;

      case "lineComment":
        if (char === "\n") state = "normal";
        i += 1;
        break;

      case "blockComment":
        if (char === "*" && sql[i + 1] === "/") {
          state = "normal";
          i += 2;
        } else i += 1;
        break;

      case "dollarQuote":
        if (char === "$" && dollarTag && sql.startsWith(dollarTag, i + 1 - dollarTag.length)) {
          state = "normal";
          dollarTag = null;
        }
        i += 1;
        break;
    }
  }

  flushWord();
  tracker.finishPending();
  push(sql.length, sql.length);
  return statements;
}

// -------------------------------------------------------- the agreement -----

/**
 * The documents the two scanners have to agree on. Every one of these is a place
 * where the states meet: a `;` inside each kind of literal or comment, the
 * doubled-quote and backslash escapes, a dollar tag with a body inside it, a
 * `CREATE` body whose `;` must not split it, a body statement whose first word
 * is all the tracker needs, and whitespace that `trim` treats differently from
 * the ASCII space. A one-word body — `CREATE TRIGGER ... BEGIN ... END;` — is
 * here because it is the case the first attempt at the rewrite got wrong: the
 * tracker stopped reading words after the eighth, which for that statement is
 * before the `BEGIN` it has to count.
 */
const AGREEMENT_CASES: readonly string[] = [
  "",
  "   ",
  ";;;",
  "SELECT 1",
  "SELECT 1;",
  "SELECT 1;;  ",
  "  SELECT 1 ;  SELECT 2 ;  ",
  "SELECT 'a;b' FROM t; SELECT 2",
  "SELECT 'it''s' ; SELECT 2",
  "SELECT 'back\\'slash ; still in' ; SELECT 2",
  'SELECT "odd;name" FROM t; SELECT 2',
  "SELECT `odd;name` FROM t; SELECT 2",
  "-- a ; comment\nSELECT 1; SELECT 2",
  "# a ; comment\nSELECT 1; SELECT 2",
  "/* a ; comment */ SELECT 1; SELECT 2",
  "SELECT 1 /* unterminated ;",
  "SELECT 'unterminated ;",
  "SELECT $tag$ a ; b$tag$; SELECT 2",
  "SELECT $$ a ; b $$; SELECT 2",
  "SELECT $1 ; SELECT 2",
  "SELECT $ ; SELECT 2",
  "SELECT $tag$ unclosed ; SELECT 2",
  "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql; SELECT 2",
  "CREATE FUNCTION f() RETURNS int AS $body$ BEGIN RETURN 1; END; $body$ LANGUAGE plpgsql; SELECT 2",
  "CREATE PROCEDURE p() BEGIN IF x THEN END IF; END; SELECT 2",
  "CREATE PROCEDURE p() BEGIN CASE WHEN x THEN END CASE; END; SELECT 2",
  "CREATE PROCEDURE p() BEGIN LOOP END LOOP; END; SELECT 2",
  "CREATE TRIGGER t BEFORE INSERT ON x BEGIN UPDATE y SET a = 1; END; SELECT 2",
  "CREATE TRIGGER t AFTER INSERT ON a BEGIN INSERT INTO b VALUES (1); UPDATE c SET x = CASE WHEN NEW.x > 0 THEN 1 ELSE 0 END; END; SELECT 2",
  "CREATE EVENT e ON SCHEDULE EVERY 1 DAY DO BEGIN DELETE FROM t; END",
  "SELECT CASE WHEN 1 THEN 2 END; SELECT 3",
  "CREATE TABLE t (a int);\n\n-- c\nSELECT 2;\n",
  "\n\n  \t SELECT 1 ; \n\n",
  "SELECT 1;\r\nSELECT 2;\r\n",
  "SELECT 1;\nSELECT 2;\nSELECT 3",
  "insert into t values (1)\n;select 2",
  "  \u00a0SELECT 1\u2028;\u3000SELECT 2  ",
  "\ufeffSELECT 1;\u205fSELECT 2",
  "SELECT 'ß' ; SELECT 2",
  "SELECT * FROM ord",
];

/**
 * The pieces a generated document is built from. Each one either changes the
 * scanner's state or ends a statement, so a document made of them exercises the
 * state machine at every boundary rather than only at the ones a person thought
 * to write down.
 */
const PIECES: readonly string[] = [
  "SELECT a, b FROM t WHERE a = 'x;y'",
  "SELECT 'it''s'",
  "-- comment ; here\n",
  "# comment ; here\n",
  "/* block ; */",
  "/* unterminated",
  'SELECT "quoted;name"',
  "SELECT `quoted;name`",
  "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql",
  "CREATE PROCEDURE p() BEGIN IF x THEN SELECT 1; END IF; END",
  "CREATE TRIGGER t BEFORE INSERT ON x BEGIN UPDATE y SET z = 1; END",
  "SELECT $q$ ; $q$",
  "SELECT $tag$ BEGIN; END $tag$",
  "DELETE FROM t WHERE id = 1",
  "UPDATE t SET a = CASE WHEN 1 THEN 2 END",
  " \t\n",
  ";",
  ";;",
];

/** A document built out of `PIECES`, deterministically, for a given seed. */
function generatedDocument(length: number, seed: number): string {
  let state = seed >>> 0;
  const next = () => (state = (state * 1103515245 + 12345) & 0x7fffffff);
  let text = "";
  while (text.length < length) {
    text += PIECES[next() % PIECES.length];
    if (next() % 3 === 0) text += ";\n";
  }
  return text;
}

/** Both scanners, over one document: identical ranges, offsets and all. */
function assertAgrees(sql: string, label: string): void {
  const previous = legacySplitStatements(sql);
  const now = splitStatements(sql);
  assert.deepEqual(
    now,
    previous,
    `${label}: the scanner answers differently than it did before the rewrite`,
  );
  // And the ranges are internally sound, which a shared mistake could still
  // satisfy in both copies but which is what the rest of the app relies on.
  for (const statement of now) {
    assert.equal(sql.slice(statement.from, statement.to), statement.text, label);
    assert.ok(statement.from < statement.to, `${label}: an empty range survived`);
    assert.ok(statement.end >= statement.to, `${label}: the statement ends before its text`);
    assert.ok(statement.to <= sql.length, `${label}: a range past the document`);
  }
}

test("the scanner answers exactly as it did before it was rewritten", () => {
  AGREEMENT_CASES.forEach((sql, index) => assertAgrees(sql, `case[${index}]`));
});

test("it also agrees on documents generated out of the state-switching pieces", () => {
  for (let seed = 1; seed <= 120; seed += 1) {
    assertAgrees(generatedDocument(120 + seed * 211, seed), `generated(${seed})`);
  }
});

test("the reference itself splits the cases it is here for", () => {
  // A differential test proves the two agree; it does not prove either is right.
  // These two anchors are what the rest of the suite already pins, repeated here
  // so that the reference cannot quietly rot into agreeing with a broken scanner.
  assert.deepEqual(
    legacySplitStatements("SELECT 1; SELECT 2").map((statement) => statement.text),
    ["SELECT 1", "SELECT 2"],
  );
  assert.equal(
    legacySplitStatements("CREATE TRIGGER t BEFORE INSERT ON x BEGIN UPDATE y SET a = 1; END; SELECT 2")
      .length,
    2,
  );
});
