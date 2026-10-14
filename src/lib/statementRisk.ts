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
 * for a statement the model called dangerous.
 */
export function riskLabel(read: StatementReading | null | undefined): string | null {
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
 */
export function destructiveTitle(read: StatementReading): string {
  return (
    `The local model put this statement at “${STEP_WORDS[read.verdict]}” on its scale ` +
    `(${Math.round(read.confidence * 100)}% sure, position ${read.level.toFixed(2)}). ` +
    `It was asked about this exact statement: ${oneLine(read.statement)}`
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
 * The worst reading of a set: the highest step, and among readings on the same
 * step the one the model put furthest along it. Null when the set holds no
 * reading at all — which is not the same as a set of safe ones, and is why this
 * hands back null rather than a made-up safe reading.
 */
export function worst(
  readings: Iterable<StatementReading | null | undefined>,
): StatementReading | null {
  let found: StatementReading | null = null;
  for (const read of readings) {
    if (!read) continue;
    if (
      !found ||
      STEP_ORDER[read.verdict] > STEP_ORDER[found.verdict] ||
      (STEP_ORDER[read.verdict] === STEP_ORDER[found.verdict] && read.level > found.level)
    ) {
      found = read;
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
