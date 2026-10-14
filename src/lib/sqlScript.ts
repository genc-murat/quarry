/**
 * Splits a SQL script into individual statements, and locates the one under a
 * cursor or selection.
 *
 * This mirrors the backend's scanner in `src-tauri/src/sql_split.rs` (string
 * literals, identifiers, line/block comments, PostgreSQL dollar quoting and
 * `BEGIN ... END` bodies) so the statement the editor slices out is exactly the
 * one the backend would have run from the whole script. Unlike the Rust side it
 * also returns each statement's offsets, which is what lets the editor run the
 * statement under the cursor — and highlight it — the way DBeaver does.
 *
 * Why the scan is written the way it is: it runs on **every keystroke**, twice —
 * the active-statement highlight rescans on every change, and the completion
 * source asks for the cursor's statement as well. Measured on this machine, a
 * byte-per-character loop that allocates a one-character string and tests it
 * against a regular expression cost 94 ms for a 4 MB script, i.e. ~190 ms of a
 * keystroke's worth of work across both callers, which is felt. The same scan
 * over character codes, allocating only the words it has to name (see
 * `BlockTracker.needsWords`) and one string per statement, measures 11 ms for
 * the same script — 0.06 ms at 20 KB, 0.9 ms at 200 KB, 2.8 ms at 1 MB. It is
 * the same scanner in every other respect, and
 * `sqlScriptLegacy.test.ts` checks it against the previous implementation move
 * for move.
 */

export interface StatementRange {
  /** Trimmed statement text, ready to send to the backend. */
  text: string;
  /** Offset of the first non-space character. */
  from: number;
  /** Offset just past the last non-space character. */
  to: number;
  /**
   * Offset just past the terminating `;` (or the end of the script). Used only
   * to decide which statement a cursor between two statements belongs to.
   */
  end: number;
}

/** Words that name a body-bearing object when they follow `CREATE`. */
const BODY_KINDS = ["TRIGGER", "PROCEDURE", "FUNCTION", "EVENT"];
/** How many leading words of a statement are remembered to recognise its kind. */
const HEAD_WORDS = 8;

/**
 * Tracks `BEGIN ... END` / `CASE ... END` nesting inside a trigger, procedure,
 * function or event so a `;` inside its body does not end the statement. Only
 * statements that start with `CREATE` and name one of `BODY_KINDS` are tracked.
 */
class BlockTracker {
  private head: string[] = [];
  private depth = 0;
  private pendingEnd = false;
  /** No further word of this statement can change anything here. */
  private settled = false;

  private inBodyStatement(): boolean {
    return this.head[0] === "CREATE" && this.head.some((word) => BODY_KINDS.includes(word));
  }

  /**
   * Whether the scanner still has to read this statement's words out of the
   * document. A statement whose first word is not `CREATE` can never be a body
   * statement, and a `CREATE` that has named its first `HEAD_WORDS` words
   * without naming a body kind never can either — which is every statement of a
   * script except the handful of bodies in it. Reading the rest would mean a
   * substring and an upper-case per word for nothing, and that allocation is
   * most of what a large script costs.
   */
  needsWords(): boolean {
    return !this.settled;
  }

  /** Feed one upper-cased bare word (identifier or keyword) to the tracker. */
  word(word: string): void {
    if (this.head.length < HEAD_WORDS) this.head.push(word);
    if (this.head[0] !== "CREATE") this.settled = true;
    else if (this.head.length >= HEAD_WORDS && !this.inBodyStatement()) this.settled = true;
    if (!this.inBodyStatement()) return;

    if (this.pendingEnd) {
      this.pendingEnd = false;
      // `END IF`, `END LOOP`, ... close constructs whose opener is never
      // counted, so they leave the depth alone. `END CASE` closes a counted CASE.
      if (word === "IF" || word === "LOOP" || word === "WHILE" || word === "REPEAT") return;
      this.depth = Math.max(0, this.depth - 1);
      if (word === "CASE") return;
    }

    if (word === "BEGIN" || word === "CASE") this.depth += 1;
    else if (word === "END") this.pendingEnd = true;
  }

  /** An `END` directly before a `;` closes its block now. */
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

/*
 * The scan compares character codes rather than one-character strings: indexing
 * a string allocates one, and at a few million characters that allocation is the
 * dominant cost. Names keep the loop readable.
 */
const TAB = 0x09;
const NEWLINE = 0x0a;
const VERTICAL_TAB = 0x0b;
const FORM_FEED = 0x0c;
const CARRIAGE_RETURN = 0x0d;
const SPACE = 0x20;
const HASH = 0x23;
const DOLLAR = 0x24;
const QUOTE = 0x27;
const DOUBLE_QUOTE = 0x22;
const STAR = 0x2a;
const DASH = 0x2d;
const SLASH = 0x2f;
const ZERO = 0x30;
const NINE = 0x39;
const SEMICOLON = 0x3b;
const UPPER_A = 0x41;
const UPPER_Z = 0x5a;
const BACKSLASH = 0x5c;
const UNDERSCORE = 0x5f;
const BACKTICK = 0x60;
const LOWER_A = 0x61;
const LOWER_Z = 0x7a;

/** Whether `code` is a character an identifier or keyword is made of. */
function isWordCode(code: number): boolean {
  return (
    (code >= ZERO && code <= NINE) ||
    (code >= UPPER_A && code <= UPPER_Z) ||
    (code >= LOWER_A && code <= LOWER_Z) ||
    code === UNDERSCORE
  );
}

/**
 * Whether `code` is whitespace as `String.prototype.trim` means it — the
 * Unicode set, not just the ASCII space — because the offsets this scanner
 * reports are the offsets of the *trimmed* statement, and a scanner that
 * disagreed with `trim` about a `\u00a0` would hand the backend a statement
 * with a different beginning than the one the editor highlighted.
 */
function isSpaceCode(code: number): boolean {
  return (
    code === SPACE ||
    code === TAB ||
    code === NEWLINE ||
    code === VERTICAL_TAB ||
    code === FORM_FEED ||
    code === CARRIAGE_RETURN ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

type State =
  | "normal"
  | "singleQuote"
  | "doubleQuote"
  | "backtick"
  | "lineComment"
  | "blockComment"
  | "dollarQuote";

/**
 * Read a `$tag$` dollar-quote opener starting at `index` (which holds `$`).
 * Returns the tag and the offset after it, or null when this `$` is not one.
 */
function readDollarTag(sql: string, index: number): { tag: string; next: number } | null {
  let tag = "$";
  for (let i = index + 1; i < sql.length; i += 1) {
    const code = sql.charCodeAt(i);
    if (code === DOLLAR) return { tag: `${tag}$`, next: i + 1 };
    if (isWordCode(code)) {
      tag += sql[i];
      continue;
    }
    return null;
  }
  return null;
}

/**
 * Split `sql` into non-empty, trimmed statements with their offsets.
 *
 * Offsets are UTF-16 code-unit indices, which is exactly what CodeMirror editor
 * positions are, so a range can be handed straight back to the editor.
 */
export function splitStatements(sql: string): StatementRange[] {
  const statements: StatementRange[] = [];
  const length = sql.length;
  let start = 0;
  let state: State = "normal";
  let i = 0;
  let dollarTag: string | null = null;
  let dollarLength = 0;
  // Where the word being read began, or -1 between words. Only a statement that
  // can still be a body statement is read word by word at all.
  let wordStart = -1;
  let tracker = new BlockTracker();

  /** Hand the word ending at `end` to the tracker, upper-cased like a keyword. */
  const flushWord = (end: number) => {
    if (wordStart >= 0) {
      tracker.word(sql.slice(wordStart, end).toUpperCase());
      wordStart = -1;
    }
  };

  /** Record the statement spanning `[start, rawEnd)`, ending at `end`. */
  const push = (rawEnd: number, end: number) => {
    // The same trimming `raw.trim()` would do, without the two strings it would
    // allocate to find the bounds.
    let from = start;
    while (from < rawEnd && isSpaceCode(sql.charCodeAt(from))) from += 1;
    let to = rawEnd;
    while (to > from && isSpaceCode(sql.charCodeAt(to - 1))) to -= 1;
    if (to <= from) return;
    statements.push({ text: sql.slice(from, to), from, to, end });
  };

  while (i < length) {
    const code = sql.charCodeAt(i);
    if (state === "normal") {
      if (isWordCode(code)) {
        if (wordStart < 0 && tracker.needsWords()) wordStart = i;
        i += 1;
        continue;
      }
      flushWord(i);
    }

    switch (state) {
      case "normal":
        if (code === QUOTE) {
          state = "singleQuote";
          i += 1;
        } else if (code === DOUBLE_QUOTE) {
          state = "doubleQuote";
          i += 1;
        } else if (code === BACKTICK) {
          state = "backtick";
          i += 1;
        } else if (code === HASH) {
          state = "lineComment";
          i += 1;
        } else if (code === DASH && sql.charCodeAt(i + 1) === DASH) {
          state = "lineComment";
          i += 2;
        } else if (code === DOLLAR) {
          const tag = readDollarTag(sql, i);
          if (tag) {
            dollarTag = tag.tag;
            dollarLength = tag.tag.length;
            state = "dollarQuote";
            i = tag.next;
          } else {
            i += 1;
          }
        } else if (code === SLASH && sql.charCodeAt(i + 1) === STAR) {
          state = "blockComment";
          i += 2;
        } else if (code === SEMICOLON) {
          tracker.finishPending();
          if (!tracker.open) {
            push(i, i + 1);
            tracker = new BlockTracker();
            start = i + 1;
          }
          i += 1;
        } else {
          i += 1;
        }
        break;

      case "singleQuote":
        if (code === BACKSLASH) i += 2;
        else if (code === QUOTE) {
          if (sql.charCodeAt(i + 1) === QUOTE) i += 2;
          else {
            state = "normal";
            i += 1;
          }
        } else i += 1;
        break;

      case "doubleQuote":
        if (code === DOUBLE_QUOTE) {
          if (sql.charCodeAt(i + 1) === DOUBLE_QUOTE) i += 2;
          else {
            state = "normal";
            i += 1;
          }
        } else i += 1;
        break;

      case "backtick":
        if (code === BACKTICK) state = "normal";
        i += 1;
        break;

      case "lineComment":
        if (code === NEWLINE) state = "normal";
        i += 1;
        break;

      case "blockComment":
        if (code === STAR && sql.charCodeAt(i + 1) === SLASH) {
          state = "normal";
          i += 2;
        } else i += 1;
        break;

      case "dollarQuote":
        if (code === DOLLAR && dollarTag && sql.startsWith(dollarTag, i + 1 - dollarLength)) {
          state = "normal";
          dollarTag = null;
        }
        i += 1;
        break;
    }
  }

  flushWord(length);
  tracker.finishPending();
  push(length, length);
  return statements;
}

/**
 * The statement a cursor at `position` belongs to, or null for an empty script.
 *
 * A cursor in the whitespace between two statements (or after the last `;`)
 * resolves to the statement before it, which is what a script editor expects
 * when the caret trails the statement the user just typed.
 */
export function statementAtCursor(sql: string, position: number): StatementRange | null {
  const statements = splitStatements(sql);
  if (statements.length === 0) return null;

  for (const statement of statements) {
    if (position >= statement.from && position <= statement.end) return statement;
  }

  let chosen = statements[0];
  for (const statement of statements) {
    if (statement.from > position) break;
    chosen = statement;
  }
  return chosen;
}

/**
 * The SQL a Run should send: the selection when there is one, otherwise the
 * statement under the cursor. Falls back to the whole script so a Run on an
 * empty editor does nothing surprising.
 */
export function sqlToRun(sql: string, selectionFrom: number, selectionTo: number): string {
  if (selectionTo > selectionFrom) {
    const selected = sql.slice(selectionFrom, selectionTo).trim();
    if (selected) return selected;
  }
  return statementAtCursor(sql, selectionFrom)?.text ?? sql.trim();
}
