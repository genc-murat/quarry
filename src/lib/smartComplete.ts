/**
 * A CodeMirror completion source that asks the local decision model which name
 * the user most likely means and lifts it to the top of the list.
 *
 * Which name depends on where the cursor is: a bare identifier asks about the
 * schema's *tables*, and one after a qualifier (`orders.ord`, `o.ord`) asks about
 * that table's *columns*. The question put to the model says which of the two it
 * is — `./sqlQualifier` decides what the qualifier names — but nothing else
 * differs, which is why a dotted completion reuses this whole arrangement.
 *
 * It *wraps* the sources the SQL language already registered (via
 * `state.languageDataAt("autocomplete")`) instead of adding a second set, so no
 * name is ever offered twice. It is installed as the `override` source, which
 * is why the wrapper has to run the language's own sources itself.
 *
 * The model is never something the user waits for. A question costs ~450 ms, and
 * a completion list that appears half a second after the keystroke is worse than
 * one in the language's own order, so the list is returned as soon as the
 * language's sources have answered, and the ranking is applied when it lands:
 * the open list is rebuilt, and the source then finds the answer waiting in the
 * cache and hands back the ranked order. That second pass asks nothing, which is
 * what keeps a late answer from rebuilding the list forever.
 */
import type {
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
import { completionStatus, startCompletion } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";

import { applyBoosts, candidateNames } from "./completionRank";
import type { RankQuestion } from "./rankCache";
import { cursorStatement } from "./statementRisk";
import {
  MAX_QUALIFIER_LOOKBEHIND,
  qualifierOf,
  resolveQualifier,
  type SchemaTable,
} from "./sqlQualifier";

/**
 * Upper bound on the text sent as `state`. A minified one-line script can be
 * huge, and the decision only needs what surrounds the cursor, so the tail of
 * the line is what is kept.
 */
export const MAX_STATE_CHARS = 2000;

export interface SmartCompletionOptions {
  /** Table names the connected schema offers for completion. */
  tables: readonly string[];
  /**
   * The same schema with its columns, which is what a completion after a
   * qualifier ranks. Absent means a dotted position ranks nothing, which is the
   * right answer for a caller that has no column names to offer.
   */
  schema?: readonly SchemaTable[];
  /**
   * The model's ranking of `candidates`, best first. An empty array (or a
   * rejection) means "no opinion" and the ordinary order stands.
   *
   * `question` is the rest of what is being asked — the statement the cursor is
   * in, and whether the names are tables or columns. It travels with the request
   * so the same call can also ask whether running the statement would destroy
   * data. None of it is part of the ranking.
   */
  rank: (
    line: string,
    candidates: readonly string[],
    question: RankQuestion,
  ) => Promise<readonly string[]>;
  /**
   * Whether the ranking for this question is already in hand, so it can be
   * applied without waiting for the model at all. The editor passes its cache
   * here; a source without one can only ever show the list now and rank it
   * later.
   */
  hasAnswer?: (line: string, candidates: readonly string[]) => boolean;
  /**
   * Whether the statement under the cursor still needs a reading. The reading
   * rides along with the ranking for free, so it is worth asking for while it is
   * wanted — and worth leaving out once the editor has one, since asking again
   * would pay prompt tokens for an answer already in hand. A caller that does not
   * say has not read anything, which is what a test wants.
   */
  riskNeeded?: (statement: string) => boolean;
}

/**
 * Collect what the language's own sources would have returned. Their results
 * are merged into one so the caller can reorder a single list.
 */
async function languageCompletions(
  context: CompletionContext,
): Promise<CompletionResult | null> {
  const sources = context.state.languageDataAt<CompletionSource>(
    "autocomplete",
    context.pos,
  );
  const results = await Promise.all(sources.map((source) => source(context)));
  const present = results.filter(
    (result): result is CompletionResult => result != null,
  );
  if (present.length === 0) return null;
  if (present.length === 1) return present[0];
  return {
    from: Math.min(...present.map((result) => result.from)),
    options: present.flatMap((result) => result.options),
    validFor: present[0].validFor,
  };
}

/**
 * Whether any of `candidates` is a name the language offered here — compared
 * case-insensitively, which is how `applyBoosts` matches a ranked name to an
 * option, so the two agree about what is on screen.
 */
function offered(base: CompletionResult, candidates: readonly string[]): boolean {
  const names = new Set(base.options.map((option) => option.label.toLowerCase()));
  return candidates.some((name) => names.has(name.toLowerCase()));
}

/** The text of one line, trimmed to the tail the model is shown. */
function stateOf(text: string): string {
  return text.length > MAX_STATE_CHARS ? text.slice(-MAX_STATE_CHARS) : text;
}

/**
 * Whether the editor is still completing the very place the question was asked
 * about. The same offset on the same line means the same token, and therefore
 * the same choices: anywhere else, rebuilding the list would rank something the
 * answer says nothing about.
 *
 * A list that is *being recomputed* counts. `completionStatus` reports
 * `"pending"` while a query for this position is in flight, which is what an
 * open list becomes for a moment whenever the editor's extensions are rebuilt —
 * the schema arriving, an editor setting changed, a tab switched — and that is
 * the same list, still about this place. Only a list that is actually gone
 * reports `null` (dismissed with Escape, closed on blur, dropped by a
 * programmatic change), and an answer arriving then is still thrown away.
 *
 * Exported because it is the whole rule deciding whether a late answer has a
 * list to reorder, and it is worth checking without a model: see
 * `smartCompleteView.test.ts`.
 */
export function stillAskedThere(
  view: EditorView,
  position: number,
  line: string,
): boolean {
  if (completionStatus(view.state) === null) return false;
  const head = view.state.selection.main.head;
  if (head !== position) return false;
  return stateOf(view.state.doc.lineAt(head).text) === line;
}

export function smartCompletionSource(
  options: SmartCompletionOptions,
): CompletionSource {
  const hasAnswer = options.hasAnswer ?? (() => false);
  const riskNeeded = options.riskNeeded ?? (() => true);
  /**
   * The place a late answer has already been applied at. A caller that passes
   * `rank` without `hasAnswer` would otherwise ask, rebuild the list, be asked
   * again by that rebuild, and never stop; with this, one place is rebuilt once.
   */
  let refreshedAt: string | null = null;

  return async (context) => {
    const base = await languageCompletions(context);
    if (!base || options.tables.length === 0) return base;

    const token = context.state.sliceDoc(base.from, context.pos);

    // The line under the cursor, not the whole document: it is the whole
    // question, and it keeps the prompt small.
    const line = stateOf(context.state.doc.lineAt(context.pos).text);

    // The statement the cursor is in, so the same request can also read it. It is
    // read from the whole document for the same reason `sqlToRun` is: a statement
    // can span lines, and only the document holds all of it. What a *command*
    // would send is more than this — a Run sends the selection when there is one,
    // and the Script button sends the file — and this source can see neither, so
    // it offers the one statement it knows and leaves the rest to the editor.
    const statement = cursorStatement(context.state.doc.toString(), context.pos);

    // A dotted position is about the names behind the dot rather than the
    // schema's tables, and the question says which of the two it is asking about.
    // The lookbehind is read from the document rather than the line because the
    // qualifier and the dot are adjacent, so a window this small always holds it.
    const qualifier = qualifierOf(
      context.state.sliceDoc(Math.max(0, base.from - MAX_QUALIFIER_LOOKBEHIND), base.from),
    );
    const behind = qualifier ? resolveQualifier(qualifier, options.schema ?? []) : null;
    const candidates = candidateNames(behind?.names ?? options.tables, token);
    // A single candidate is no choice at all, and an answer to an aborted query
    // would be thrown away — neither is worth a model call.
    if (candidates.length < 2 || context.aborted) return base;
    // The question also has to be about names this list is actually showing. The
    // language resolves a qualifier its own way — exactly, case included — so a
    // spelling this module read differently (`SELECT ORDERS.ord`) or a prefix it
    // did not follow (`SELECT "shop".orders.ord` offers the bare list) would send
    // the model after names that are not on screen. `applyBoosts` can only ignore
    // a name that matches no option, so that request would cost a model call and
    // reorder nothing; measured, every such spelling is one where the language
    // offered none of the candidates. A document its parser has not caught up
    // with lands here too — a 3.6 KB one-line select list of a thousand names
    // offers the keyword list and no tables at all — and refusing is the same
    // answer for the same reason: nothing on screen could be reordered.
    if (!offered(base, candidates)) return base;
    const question: RankQuestion = {
      statements: statement && riskNeeded(statement) ? [statement] : [],
      kind: behind?.kind ?? "table",
    };

    // The answer is in hand, so this is the second pass over the same question:
    // hand back the ranked list. `rank` is a lookup now, not a question.
    if (hasAnswer(line, candidates)) {
      let ranked: readonly string[] = [];
      try {
        ranked = await options.rank(line, candidates, question);
      } catch {
        // Best effort: an unreachable model must never cost the user their
        // ordinary completions. This is the one place the model is waited for,
        // and only because it owes an answer it said it had.
        return base;
      }
      return ranked.length === 0
        ? base
        : { ...base, options: applyBoosts(base.options, ranked) };
    }

    // Otherwise the list the language produced is what the user gets, now. The
    // question is put in the background and the list rebuilt when the answer
    // lands, as long as that is still the list it is about.
    const view = context.view;
    const position = context.pos;
    const place = `${position}\u0000${line}`;
    void options
      .rank(line, candidates, question)
      .then((ranked) => {
        // No opinion: there is nothing to reorder.
        if (ranked.length === 0) return;
        if (!view) return;
        if (refreshedAt === place) return;
        if (!stillAskedThere(view, position, line)) return;
        refreshedAt = place;
        startCompletion(view);
      })
      // A model that cannot answer costs the user the ranking and nothing else.
      .catch(() => {});

    return base;
  };
}
