/**
 * What the local model read about the statements a command would send, and how
 * long the editor keeps it.
 *
 * The model is asked one graded question per statement — how far running it
 * could go, on a scale from reading data to removing a table — and this module is
 * where those answers live until the editor needs them. Three rules keep them
 * honest:
 *
 * - A reading belongs to the exact statement it was asked about. The model never
 *   sees an edited statement, so a reading is never carried across to one: an
 *   answer about `DELETE FROM orders` is not evidence about
 *   `DELETE FROM orders WHERE id = 1`. They are simply two statements, and a
 *   statement with no reading of its own has none, so the badge that consumes
 *   this says nothing rather than guessing.
 * - What is asked about is what a command would *send*: the statements of the
 *   selection when there is one, and otherwise the statement under the cursor —
 *   read through `sqlToRun`, the same function Run itself resolves its text with,
 *   so the question cannot drift from the button. A whole script is read too,
 *   because the Script button sends all of it: the cursor sitting in a `SELECT`
 *   says nothing about the `TRUNCATE` on the last line.
 * - The scale, and the wording of the question, are the client's, and both were
 *   chosen by measurement (`src-tauri/src/decision.rs`, `RISK_SCALE`). Which step
 *   is worth a warning is the editor's policy, so it is defined here and nowhere
 *   else: the client reports a step and holds no opinion about it.
 *
 * The scale has one measured blind spot, and the statement's own text closes it:
 * an `UPDATE` that names no row reads as a bounded write (1.06, measured) where
 * its text says the rows step outright. Where the text is that much more precise
 * than the model, the reading is raised to the step the text describes — never
 * lowered, and the model's own words stay on the reading. See `presented`.
 */
import { splitStatements, sqlToRun, statementAtCursor } from "./sqlScript";
import type { RiskVerdict, StatementReading } from "./types";

/**
 * How many statements one request may ask about.
 *
 * The client bounds this too, and its bound is what the endpoint's 64 KiB of text
 * allows; this is the editor's own, and it is the same number rather than a
 * smaller one, so the editor never asks for more than it can be given. A script
 * longer than this is read in the order its statements appear — the rest are
 * asked about as they come up, and a caller that wants to say how much of the
 * script has been read has to count its statements itself.
 */
export const MAX_RISK_STATEMENTS = 12;

/**
 * Longest statement sent as one block. A statement is normally a few lines, so
 * this only bounds the pathological case of one enormous `INSERT ... VALUES`. The
 * head is kept because it names the statement's kind and its table, which is what
 * the question turns on; a truncation is at worst a reading of a shorter
 * statement, never a reading attributed to more than was sent.
 */
export const MAX_STATEMENT_CHARS = 4000;

/**
 * The steps worth warning about before Run is pressed, and the words for them.
 *
 * A bounded write is deliberately not among them: the model's own scale puts a
 * one-row `DELETE` and a bounded `UPDATE` on the same step — measured, 1.05 and
 * 1.00 — and an ordinary edit is not what a warning is for. The two that are here
 * are the steps that take something away: every row of a table, or the table.
 */
const WARNING_LABELS: Record<"rows" | "structure", string> = {
  rows: "Removes every row",
  structure: "Removes a table",
};

/**
 * The badge's words for a reading, or null when it is not worth a mark.
 *
 * Null covers both "this is an ordinary statement" and "there is no reading":
 * the badge draws nothing either way, and what it must never do is draw nothing
 * for a statement the model called dangerous — or for one whose own text says
 * what the model's step missed.
 */
export function riskLabel(input: StatementReading | null | undefined): string | null {
  const read = presented(input);
  if (!read) return null;
  return read.verdict === "rows" || read.verdict === "structure"
    ? WARNING_LABELS[read.verdict]
    : null;
}

/** Whether there is something to say about this reading before Run is pressed. */
export function isDestructive(read: StatementReading | null | undefined): boolean {
  return riskLabel(read) !== null;
}

/**
 * The steps in the model's own words, for the tooltip: the scale it chose
 * between, as `RISK_SCALE` in `src-tauri/src/decision.rs` states it.
 */
const STEP_WORDS: Record<RiskVerdict, string> = {
  safe: "reads existing data and changes nothing",
  bounded: "writes a bounded number of existing rows",
  rows: "removes or rewrites every row of a table",
  structure: "removes a table or its data permanently",
};

/** A statement as one line, for a tooltip. */
function oneLine(statement: string): string {
  const line = statement.replace(/\s+/g, " ").trim();
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

/**
 * The badge's tooltip: what the model was asked, what it answered, and the
 * statement it answered about — the last because a command can be about to send
 * several statements, and a mark that did not say which one it meant would leave
 * the reader to guess.
 *
 * A reading the text floor raised says both halves: the step the text states and
 * the lower one the model read, because the tooltip's promise is that it quotes
 * the model faithfully, and a raised reading quoted as the model's own would be
 * a claim the model never made.
 */
export function destructiveTitle(input: StatementReading): string {
  const read = presented(input);
  if (read && read !== input) {
    return (
      `The statement's own text reaches “${STEP_WORDS[read.verdict]}” — it names no row to stop at — ` +
      `where the local model read “${STEP_WORDS[input.verdict]}” ` +
      `(${Math.round(input.confidence * 100)}% sure, position ${input.level.toFixed(2)}). ` +
      `It was asked about this exact statement: ${oneLine(read.statement)}`
    );
  }
  return (
    `The local model put this statement at “${STEP_WORDS[input.verdict]}” on its scale ` +
    `(${Math.round(input.confidence * 100)}% sure, position ${input.level.toFixed(2)}). ` +
    `It was asked about this exact statement: ${oneLine(input.statement)}`
  );
}

/**
 * The Script button's tooltip: every statement of the script is about to run, so
 * the mark is about the worst reading in the script — and about how much of it has
 * been read, because the statements nobody has read are exactly the ones such a
 * mark cannot speak for.
 */
export function wholeScriptTitle(
  read: StatementReading,
  readCount: number,
  total: number,
): string {
  return (
    `${riskLabel(read) ?? "Nothing to warn about"}: ${oneLine(read.statement)} — ` +
    `${readCount} of ${total} statement${total === 1 ? "" : "s"} read by the local model.`
  );
}

/** The steps in order, so "the worst reading" is the highest step with a value. */
const STEP_ORDER: Record<RiskVerdict, number> = { safe: 0, bounded: 1, rows: 2, structure: 3 };

/**
 * The head a statement that can reach every row starts with, read off masked
 * code: `UPDATE` and `DELETE` are every-row statements exactly when they bound
 * themselves, and `TRUNCATE` is one unconditionally.
 */
const EVERY_ROW_HEAD = /^\s*(update|delete|truncate)\b/i;

/**
 * `statement` with every literal and comment blanked to spaces, so what is left
 * is the code alone: keywords and the parens that bound them.
 *
 * The state machine mirrors the splitter in `sqlScript.ts` (and behind it
 * `src-tauri/src/sql_split.rs`) state for state — strings with their escapes and
 * doublings, quoted identifiers, `--`, `#` and block comments, dollar quotes —
 * because the statement this is handed was cut by that splitter, and a scanner
 * that disagreed with it about where a literal ends could read a keyword the
 * splitter kept inside one. One deliberate difference of *reach*: a `#` that the
 * dialect treats as an operator rather than a comment can only hide a `WHERE`
 * here, which leaves the model's reading standing — a missed floor, never a
 * false one.
 */
function masked(statement: string): string {
  let out = "";
  let state: "normal" | "single" | "double" | "backtick" | "line" | "block" | "dollar" = "normal";
  for (let i = 0; i < statement.length; ) {
    const ch = statement[i];
    const next = statement[i + 1] ?? "";
    if (state === "normal") {
      if (ch === "'" || ch === '"' || ch === "`") {
        state = ch === "'" ? "single" : ch === '"' ? "double" : "backtick";
        out += " ";
        i += 1;
      } else if ((ch === "-" && next === "-") || ch === "#") {
        state = "line";
        out += ch === "-" ? "  " : " ";
        i += ch === "-" ? 2 : 1;
      } else if (ch === "/" && next === "*") {
        state = "block";
        out += "  ";
        i += 2;
      } else if (ch === "$") {
        // A `$tag$` opener as the splitter reads it; a lone `$` is an ordinary
        // character, which is what keeps a placeholder like `$1` in code.
        const tag = dollarTagAt(statement, i);
        if (!tag) {
          out += ch;
          i += 1;
        } else {
          // The literal's own text is blanked too: nothing inside it is code.
          const close = statement.slice(i + tag.length).indexOf(tag);
          const end = close < 0 ? statement.length : i + tag.length + close + tag.length;
          out += " ".repeat(end - i);
          i = end;
        }
      } else {
        out += ch;
        i += 1;
      }
      continue;
    }
    if (state === "single") {
      // The MySQL escape, which the splitter honours only inside single quotes.
      if (ch === "\\") {
        out += "  ";
        i += 2;
        continue;
      }
      if (ch === "'" && next === "'") {
        out += "  ";
        i += 2;
        continue;
      }
      if (ch === "'") state = "normal";
    } else if (state === "double") {
      if (ch === '"' && next === '"') {
        out += "  ";
        i += 2;
        continue;
      }
      if (ch === '"') state = "normal";
    } else if (state === "backtick") {
      if (ch === "`") state = "normal";
    } else if (state === "line") {
      if (ch === "\n") state = "normal";
    } else if (state === "block") {
      if (ch === "*" && next === "/") {
        out += "  ";
        i += 2;
        state = "normal";
        continue;
      }
    }
    out += " ";
    i += 1;
  }
  return out;
}

/** A `$tag$` opener at `at`, as `readDollarTag` in `sqlScript.ts` reads one. */
function dollarTagAt(statement: string, at: number): string | null {
  let tag = "$";
  for (let i = at + 1; i < statement.length; i += 1) {
    const ch = statement[i];
    if (ch === "$") return `${tag}$`;
    if (/[A-Za-z0-9_]/.test(ch)) {
      tag += ch;
      continue;
    }
    return null;
  }
  return null;
}

/** Whether a `WHERE` or a `LIMIT` at the top level bounds the statement. */
function hasTopLevelBound(code: string): boolean {
  let depth = 0;
  for (const match of code.matchAll(/\bwhere\b|\blimit\b|\(|\)/gi)) {
    if (match[0] === "(") depth += 1;
    else if (match[0] === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) return true;
  }
  return false;
}

/**
 * Whether the statement's own text says it reaches every row.
 *
 * The measured gap this closes: an `UPDATE` that names no row reads as a bounded
 * write on the model's scale (1.06, against 1.00 for a bounded one —
 * `src-tauri/src/decision.rs` keeps the numbers), because the question it was
 * worded from turns on what the statement does and not on what it fails to name.
 * The text has the answer the scale misses: an `UPDATE` or `DELETE` that bounds
 * itself is not one — and bounding is a `WHERE` at the top level, or a `LIMIT`
 * where the dialect offers one (MySQL does); a clause inside a literal, a
 * comment or a subquery does not bound anything. A `TRUNCATE` is unbounded
 * outright.
 *
 * A statement cut at the head (`MAX_STATEMENT_CHARS`) is out of bounds here: its
 * tail, where a `WHERE` would sit, was never read by the model or by this, so
 * "none in sight" is not evidence. The model's answer, which saw the same head,
 * stands alone — the floor speaks only where it has read the whole statement.
 */
export function reachesEveryRow(statement: string): boolean {
  if (statement.length >= MAX_STATEMENT_CHARS) return false;
  const code = masked(statement);
  const head = code.match(EVERY_ROW_HEAD);
  if (!head) return false;
  if (head[1].toUpperCase() === "TRUNCATE") return true;
  return !hasTopLevelBound(code);
}

/**
 * A reading as the badge shows it: the model's step, raised to `rows` when the
 * statement's own text already reaches that far.
 *
 * Raised, never lowered — a `structure` reading of a statement with a `WHERE`
 * stays a `structure` reading — and everything else on the reading stays as the
 * model said it: the level, the confidence and the statement are its answer's,
 * and the tooltip quotes both voices where they differ. Null in, null out.
 */
export function presented(read: StatementReading | null | undefined): StatementReading | null {
  if (!read) return null;
  if (STEP_ORDER[read.verdict] >= STEP_ORDER.rows) return read;
  return reachesEveryRow(read.statement) ? { ...read, verdict: "rows" } : read;
}

/**
 * The worst reading of a set: the highest step — the step the text floor leaves
 * a reading on, where that is higher than the model's — and among readings on
 * the same step the one the model put furthest along it. The reading handed back
 * is the model's own, unraised: what the text adds is the badge's business, and
 * the tooltip needs both voices to tell it honestly. Null when the set holds no
 * reading at all — which is not the same as a set of safe ones, and is why this
 * hands back null rather than a made-up safe reading.
 */
export function worst(
  readings: Iterable<StatementReading | null | undefined>,
): StatementReading | null {
  let found: StatementReading | null = null;
  let shown: StatementReading | null = null;
  for (const read of readings) {
    if (!read) continue;
    const readShown = presented(read);
    if (!readShown) continue;
    if (
      !shown ||
      STEP_ORDER[readShown.verdict] > STEP_ORDER[shown.verdict] ||
      (STEP_ORDER[readShown.verdict] === STEP_ORDER[shown.verdict] && readShown.level > shown.level)
    ) {
      found = read;
      shown = readShown;
    }
  }
  return found;
}

/** A statement as the model is shown it: trimmed, and bounded at the head. */
function bounded(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_STATEMENT_CHARS
    ? trimmed.slice(0, MAX_STATEMENT_CHARS)
    : trimmed;
}

/**
 * Some statements as the model is shown them: blank ones dropped, duplicates
 * dropped — a reading is keyed by the statement itself, so the same text twice is
 * one question's answer for two questions' worth of prompt — and the list cut at
 * `MAX_RISK_STATEMENTS`.
 */
function boundedStatements(texts: Iterable<string>): string[] {
  const statements: string[] = [];
  for (const text of texts) {
    const statement = bounded(text);
    if (!statement || statements.includes(statement)) continue;
    statements.push(statement);
    if (statements.length >= MAX_RISK_STATEMENTS) break;
  }
  return statements;
}

/** The statement a cursor at `position` is in, as the model is shown it. */
export function cursorStatement(sql: string, position: number): string | null {
  return bounded(statementAtCursor(sql, position)?.text ?? "");
}

/**
 * The statements a Run would send, as the model is shown them.
 *
 * Resolved through `sqlToRun` rather than beside it, so the question is about the
 * same text the button sends: the selection when there is one, and otherwise the
 * statement under the cursor. A selection holding several statements — the case
 * this exists for — is therefore asked about in full, and the badge can name the
 * statement that is dangerous instead of describing whichever one the cursor
 * happens to sit in.
 */
export function statementsToRun(
  sql: string,
  selectionFrom: number,
  selectionTo: number,
): string[] {
  return boundedStatements(
    splitStatements(sqlToRun(sql, selectionFrom, selectionTo)).map((statement) => statement.text),
  );
}

/** Every statement of a script, in the order it would be sent. */
export function statementsInScript(sql: string): string[] {
  return boundedStatements(splitStatements(sql).map((statement) => statement.text));
}

export interface StatementReads {
  /**
   * Keep a reading. It is filed under the statement it echoes, and replaces any
   * earlier reading of that same statement — a later answer is the model's
   * current one.
   */
  remember(read: StatementReading | null | undefined): void;
  /** The reading for exactly this statement, or null when there is none. */
  get(statement: string | null | undefined): StatementReading | null;
}

/**
 * A small most-recently-used store, keyed by the statement itself.
 *
 * Bounded because a session can visit many statements and the readings are only
 * ever wanted for the ones a command would send.
 */
export function createStatementReads({ limit = 32 }: { limit?: number } = {}): StatementReads {
  const reads = new Map<string, StatementReading>();

  return {
    remember(read) {
      if (!read?.statement) return;
      // Re-inserting moves the entry to the back of the map's order, so the
      // least recently *read* statement is the one forgotten first.
      reads.delete(read.statement);
      reads.set(read.statement, read);
      while (reads.size > limit) {
        const eldest = reads.keys().next();
        if (eldest.done) return;
        reads.delete(eldest.value);
      }
    },

    get(statement) {
      if (!statement) return null;
      const read = reads.get(statement);
      if (read) {
        reads.delete(statement);
        reads.set(statement, read);
      }
      return read ?? null;
    },
  };
}
