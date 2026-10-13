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

type State =
  | "normal"
  | "singleQuote"
  | "doubleQuote"
  | "backtick"
  | "lineComment"
  | "blockComment"
  | "dollarQuote";

/**
 * Tracks `BEGIN ... END` / `CASE ... END` nesting inside a trigger, procedure,
 * function or event so a `;` inside its body does not end the statement. Only
 * statements that start with `CREATE` and name one of `BODY_KINDS` are tracked.
 */
class BlockTracker {
  private head: string[] = [];
  private depth = 0;
  private pendingEnd = false;

  private inBodyStatement(): boolean {
    return this.head[0] === "CREATE" && this.head.some((word) => BODY_KINDS.includes(word));
  }

  /** Feed one upper-cased bare word (identifier or keyword) to the tracker. */
  word(word: string): void {
    if (this.head.length < HEAD_WORDS) this.head.push(word);
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

const WORD_CHAR = /[A-Za-z0-9_]/;

/**
 * Read a `$tag$` dollar-quote opener starting at `index` (which holds `$`).
 * Returns the tag and the offset after it, or null when this `$` is not one.
 */
function readDollarTag(sql: string, index: number): { tag: string; next: number } | null {
  let tag = "$";
  for (let i = index + 1; i < sql.length; i += 1) {
    const char = sql[i];
    if (char === "$") return { tag: `${tag}$`, next: i + 1 };
    if (WORD_CHAR.test(char)) {
      tag += char;
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
  let start = 0;
  let state: State = "normal";
  let i = 0;
  let dollarTag: string | null = null;
  let word = "";
  let tracker = new BlockTracker();

  const flushWord = () => {
    if (word) {
      tracker.word(word);
      word = "";
    }
  };

  /** Record the statement spanning `[start, rawEnd)`, ending at `end`. */
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
      if (WORD_CHAR.test(char)) {
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
          const tag = readDollarTag(sql, i);
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
            tracker = new BlockTracker();
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
