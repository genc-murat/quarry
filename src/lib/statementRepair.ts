/**
 * The hint under a statement that did not run: which of the schema's names the
 * failed SQL most likely meant.
 *
 * The question itself belongs to the decision layer (`CandidateKind::Repair` in
 * `src-tauri/src/decision.rs`), which measured the wording and the criterion that
 * lets the model decline. What is decided here is the half the model cannot
 * decide for itself — *what it is asked to choose between* — and what an answer
 * is allowed to say to the reader.
 *
 * The shortlist is the whole design. A schema can hold hundreds of names and one
 * request may carry 25 of them (the endpoint's 26-criteria wall, one of which is
 * the decline criterion), so sending "every name" is both impossible and unkind:
 * a name the user never came close to typing is not a candidate, it is noise that
 * gives a confident model something wrong to pick. So the names are *scored
 * against the identifiers the database's error itself names* — which is where the
 * typo is, whatever dialect is reporting it (`no such column: ordred_at`,
 * `Unknown column 'quanity' in 'field list'`, `column "oder_number" does not
 * exist`, `Table 'shop.ordres' doesn't exist`) — and only the close ones are asked
 * about.
 *
 * The SQL is deliberately *not* scored, though it is what the model is shown.
 * Its names are valid names by definition, so every one of them would match itself
 * at 1.0 and drown out the typo the question exists for: `SELECT * FROM orders
 * WHERE profit_margin_eur = 1` would offer the model `orders` as a candidate with
 * a perfect score, and a model looking for the closest name in a list led by a
 * name that is not the problem is a model invited to answer with the wrong one.
 *
 * That scoring is what makes the hint trustworthy rather than merely present:
 *
 * - `ordred_at` (SQLite's "no such column: ordred_at") is one edit from
 *   `ordered_at`, so `ordered_at` is in the shortlist;
 * - `quanity` and `oder_number` are one edit from `quantity` and
 *   `order_number` the same way;
 * - `profit_margin_eur` against a schema holding none of those words scores
 *   under `REPAIR_SIMILARITY` for every name, and the answer is that there is
 *   nothing to ask about — no request, no hint, and no chance of a suggestion
 *   that would send the reader to a name their SQL never meant. (Asked anyway,
 *   the model declined this case at 0.941; not asking is cheaper and at least as
 *   honest.)
 *
 * A shortlist that comes out with a single name is still asked about, because the
 * question has a "none of these" answer of its own: the model is asked whether
 * that one name is the one the SQL meant, and an unsure or declined answer shows
 * nothing. Only a shortlist with *no* name in it is no question.
 *
 * The three real typos above, and the wording of the question, were measured
 * against `nimble` before any of this was built; the numbers are in
 * `src-tauri/src/decision.rs`. The scoring here is the editor's own, and its
 * floor is set so that the measured cases land on the right side of it.
 *
 * What comes back is reported as the model gave it. A declination and an unsure
 * answer are both "no suggestion" here — but the difference is kept in `reason`,
 * so the client can say which happened rather than blaming a missing model for an
 * answer that arrived. Nothing in this module re-reads the SQL or the error to
 * second-guess the answer: the model saw both, and a client that "improved" its
 * pick would be inventing a claim the model never made.
 *
 * The one thing that *is* recomputed is the edit an answer implies, and only
 * because a suggestion a reader cannot act on is half a feature: which word in the
 * statement the answer is about is a fact about the text, not about the model. It
 * is the identifier the error named, spelled in the SQL, closest to the name the
 * model suggested — and when there is no such word, no repair is offered rather
 * than a guess about where to put the name.
 */
import type { QueryResponse, RankCandidatesResponse, StatementRepair } from "./types";

/**
 * How many names a repair question may offer.
 *
 * The endpoint refuses more than 26 criteria, and a repair question spends one of
 * them on its own decline criterion, which is the same arithmetic the decision
 * layer does (`MAX_CANDIDATES - 1`). The editor's own bound is here rather than
 * derived from the backend's, because what it protects is a different thing: the
 * prompt of a question asked once per failure.
 */
export const MAX_REPAIR_CANDIDATES = 25;

/**
 * How few names there have to be for the failure not to be worth asking about —
 * one, because a single name is still a question rather than an assertion.
 *
 * The question can always be answered "none of these", which is what makes a
 * shortlist of one worth putting: the model is asked whether that name is the one
 * the SQL meant, and the answer is only shown when it was ranked rather than
 * declined or unsure. A schema whose only near-neighbour is the name the typo was
 * reaching for is the *best* case for a hint, not the worst — `oder_number`
 * against a schema holding `order_number` and little else scores one candidate,
 * and that one is the answer. With nothing close enough there is no question to
 * ask at all, and the editor stays silent instead of putting an empty shortlist to
 * a model that has nothing to choose between.
 */
export const MIN_REPAIR_CANDIDATES = 1;

/**
 * How close a name has to be to a token of the failure to be worth asking about,
 * as a share of the longer of the two strings.
 *
 * Set from the cases that must work and the ones that must not. The four measured
 * mistakes sit at 0.67 or above (`ordres`→`orders` 0.67, `oder_number`→
 * `order_number` 0.92, `quanity`→`quantity` 0.88, `ordred_at`→`ordered_at` 0.90),
 * a column name used where a table belongs is a partial match on its prefix
 * (`order_number`→`orders` 0.42), and a name the error is not about at all falls
 * below 0.4 — `profit_margin_eur` scores 0.24 against the closest name in the demo
 * schema, where the answer is that there is nothing worth asking.
 */
export const REPAIR_SIMILARITY = 0.4;

/**
 * How many failures of one run may be asked about.
 *
 * A script can fail on every statement, and each failure is a question of its
 * own; a run that went wrong in twenty places does not need twenty suggestions,
 * and the first few are the ones on screen.
 */
export const MAX_REPAIR_FAILURES = 4;

/** An identifier-shaped word, which is what a name in a statement is. */
const IDENTIFIER = /[A-Za-z0-9_$]+/g;

/** Every identifier the text spells, folded to lower case and deduplicated. */
function identifiersIn(text: string): string[] {
  const words: string[] = [];
  const seen = new Set<string>();
  for (const word of text.match(IDENTIFIER) ?? []) {
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(key);
  }
  return words;
}

/**
 * The word in the statement that the answer is about: the one the error named,
 * spelled as the SQL spells it, closest to the suggested name.
 *
 * All three conditions matter. The word has to be *named by the error*, because
 * that is what the question was about — a name the model suggested that happens to
 * be close to some other word in the statement is not a repair, it is a
 * coincidence. It has to be *in the statement*, because that is the text a repair
 * could change: an error about a name this statement never mentions has nothing
 * here to put right. And it has to be close to the suggested name, which is the
 * same floor the shortlist was built with, so a repair cannot be offered for a
 * pairing the question itself would not have made.
 *
 * Null when there is no such word, which is also the answer when the statement
 * already spells the suggested name: there is nothing to change.
 */
export function repairTarget(
  statement: string,
  error: string,
  name: string,
): string | null {
  const wanted = name.toLowerCase();
  if (!wanted) return null;
  const written = new Set(identifiersIn(statement));
  let best: { token: string; score: number } | null = null;
  for (const token of repairTokens(error)) {
    if (token === wanted || !written.has(token)) continue;
    const score = similarity(token, name);
    if (score < REPAIR_SIMILARITY) continue;
    // The closest word wins; the longest of equally close ones is the more
    // specific reading of what was typed (`order_number` over `order`).
    if (!best || score > best.score || (score === best.score && token.length > best.token.length)) {
      best = { token, score };
    }
  }
  return best?.token ?? null;
}

/**
 * The statement with the suggested name written into it, or null when there is
 * nothing to write.
 *
 * Every whole-word occurrence of the word the error named is replaced, because a
 * typo is a typo wherever it appears in the statement — a `SELECT` list and its
 * `WHERE` clause usually spell the same mistake twice, and fixing one of them
 * would leave the statement failing for the same reason. Nothing else in the text
 * is touched: the words this function does not recognise are left exactly as they
 * were typed, so a repair can only ever change the name a person got wrong.
 */
export function repairedStatement(
  statement: string,
  error: string,
  name: string,
): string | null {
  const target = repairTarget(statement, error, name);
  if (!target) return null;
  let changed = false;
  const repaired = statement.replace(IDENTIFIER, (word) => {
    if (word.toLowerCase() !== target) return word;
    changed = true;
    return name;
  });
  return changed ? repaired : null;
}

/** A name of unknown kind, as the shortlist is built from one. */
export interface RepairSchema {
  table: string;
  columns: readonly string[];
}

/**
 * The identifiers a failure names, folded to lower case and deduplicated.
 *
 * These are the error's own words — the identifier the driver could not find is
 * always among them — and a qualified one contributes both halves of its name
 * (`shop.ordres` gives `shop` and `ordres`), which is what makes a
 * schema-qualified mistake scoreable at all. Fragments of two letters or fewer are
 * dropped because they match half a schema (`id`, `at`, `no`), and a token with no
 * letter in it names nothing.
 */
export function repairTokens(text: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[^A-Za-z0-9_$]+/)) {
    if (raw.length < 3 || !/[A-Za-z_]/.test(raw)) continue;
    const token = raw.toLowerCase();
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

/** Edit distance between two strings, the row above kept as two columns. */
function distance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const substitute = previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1);
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, substitute);
    }
    previous = current;
  }
  return previous[right.length];
}

/**
 * How alike two names are, from 1 (the same name, case folded — SQL names are
 * case-insensitive on most engines) down to 0 (nothing in common), measured as
 * the share of the longer name that has to change.
 */
export function similarity(left: string, right: string): number {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (a === b) return 1;
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - distance(a, b) / longest;
}

/** Every name the schema holds, tables and columns alike, in schema order. */
export function schemaNames(entries: readonly RepairSchema[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const name of [entry.table, ...entry.columns]) {
      const key = name.toLowerCase();
      if (!name.trim() || seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }
  }
  return names;
}

/**
 * The names worth asking about: those close enough to something the failure says,
 * best first and cut at `limit`.
 *
 * The order is by score and is stable for the same failure, because it is part of
 * the request — the same names in a different order are a different question, and
 * a question that reshuffled itself would be asked twice. The answer that matters
 * is the model's pick, so this order only decides what it is looking at.
 */
export function repairCandidates(
  names: readonly string[],
  error: string,
  limit: number = MAX_REPAIR_CANDIDATES,
): string[] {
  const tokens = repairTokens(error);
  if (tokens.length === 0) return [];
  const scored: { name: string; score: number }[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key) || !name.trim()) continue;
    seen.add(key);
    let best = 0;
    for (const token of tokens) best = Math.max(best, similarity(token, key));
    if (best < REPAIR_SIMILARITY) continue;
    scored.push({ name, score: best });
  }
  scored.sort(
    (left, right) =>
      right.score - left.score ||
      (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
  );
  return scored.slice(0, Math.max(0, limit)).map((entry) => entry.name);
}

/** The statement the shortlist is about, and the error that says it failed. */
export interface StatementFailure {
  statement: string;
  error: string;
}

/**
 * The failures of one run, as a repair question needs them.
 *
 * A statement error is the only thing here: the tab-level `error` is a transport
 * failure, where there is no statement to have meant anything and nothing for a
 * model to read. A failure with no error text, or no SQL to be about, is not a
 * question either, so it is dropped rather than asked about.
 */
export function failuresIn(result: QueryResponse | null | undefined): StatementFailure[] {
  const failures: StatementFailure[] = [];
  for (const statement of result?.results ?? []) {
    const error = statement.error?.trim();
    const sql = statement.statement?.trim();
    if (!error || !sql) continue;
    failures.push({ statement: sql, error });
    if (failures.length >= MAX_REPAIR_FAILURES) break;
  }
  return failures;
}

/**
 * What an answer means as a hint, or null when it is not one.
 *
 * An answer is a suggestion only when the decision layer ranked it, which is
 * exactly when it was neither declined nor unsure: the layer reports both of
 * those with an empty `ranked` while still filling in `choice` — so `choice` on
 * its own is *not* a suggestion, and a client that read it as one would offer a
 * name the model explicitly did not stand behind.
 */
export function suggestionOf(
  statement: string,
  error: string,
  response: RankCandidatesResponse,
): StatementRepair {
  return {
    statement,
    error,
    name: response.ranked[0] ?? null,
    confidence: response.confidence,
    reason: response.reason,
  };
}

/**
 * What the grid is handed for one failure: the suggestion, and how to act on it.
 *
 * `fix` is null when the failure cannot be put right in the SQL the tab holds —
 * the statement has been edited since it failed, or the answer implies no edit —
 * which is what keeps the button from being a control that does nothing.
 */
export interface FailureRepair {
  repair: StatementRepair;
  fix: (() => void) | null;
}

/** A statement as one line, for a tooltip. */
function oneLine(statement: string): string {
  const line = statement.replace(/\s+/g, " ").trim();
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

/**
 * The hint's tooltip: what the model was asked, what it answered, and how sure it
 * was — the confidence included because a suggestion is the client acting on an
 * answer, and the reader is entitled to know how strong it was.
 */
/** The fix button's tooltip: what pressing it will do, in the app's own words. */
export function fixTitle(repair: StatementRepair): string {
  return (
    `Writes ${repair.name} into the statement in place of the name the error complained about, and ` +
    `runs it. It was asked about this exact statement: ${oneLine(repair.statement)}`
  );
}

export function repairTitle(repair: StatementRepair): string {
  return (
    `The local model read this failure and the SQL that produced it, and answered that the name ` +
    `meant is ${repair.name} (${Math.round(repair.confidence * 100)}% sure). ` +
    `It was asked about this exact statement: ${oneLine(repair.statement)}`
  );
}

/** Where one answered failure is kept, so it is not asked about twice. */
export interface StatementRepairs {
  /**
   * Claim the question for this failure. True when this caller is the one to put
   * it: an answer already in hand, or a question already in flight, takes it
   * instead — which is what keeps a re-render of the grid from asking the model
   * the same thing again.
   */
  start(statement: string, error: string): boolean;
  /** File an answer. A later answer for the same failure replaces an earlier one. */
  remember(repair: StatementRepair): void;
  /** The answer for exactly this failure, or null when there is none yet. */
  get(statement: string | null | undefined, error: string | null | undefined): StatementRepair | null;
  /**
   * Forget a failure, so it can be asked about again. A request that *failed* is
   * not an answer: remembering it would stop the hint from ever appearing.
   */
  forget(statement: string, error: string): void;
}

/**
 * The failures the editor has asked about, in asked order.
 *
 * Keyed by the failure itself — the statement *and* the error — because that is
 * what the question is about: the same statement failing two different ways is
 * two questions, and a bare statement key would answer one with the other's
 * suggestion. Both halves are trimmed before keying, which is the text the
 * decision layer trims and sends, so the key cannot drift from what the model was
 * shown.
 */
export function createStatementRepairs({ limit = 16 }: { limit?: number } = {}): StatementRepairs {
  const repairs = new Map<string, StatementRepair | null>();

  function key(statement: string, error: string): string {
    return `${statement.trim()}\u0000${error.trim()}`;
  }

  return {
    start(statement, error) {
      const id = key(statement, error);
      if (repairs.has(id)) return false;
      repairs.set(id, null);
      while (repairs.size > limit) {
        const eldest = repairs.keys().next();
        if (eldest.done) break;
        repairs.delete(eldest.value);
      }
      return true;
    },

    remember(repair) {
      const id = key(repair.statement, repair.error);
      // Re-inserting moves the entry to the back of the map's order, so the
      // least recently asked failure is the one forgotten first.
      repairs.delete(id);
      repairs.set(id, repair);
      while (repairs.size > limit) {
        const eldest = repairs.keys().next();
        if (eldest.done) return;
        repairs.delete(eldest.value);
      }
    },

    get(statement, error) {
      if (!statement || !error) return null;
      return repairs.get(key(statement, error)) ?? null;
    },

    forget(statement, error) {
      repairs.delete(key(statement, error));
    },
  };
}
