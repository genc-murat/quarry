/**
 * Keeps the local model from being asked the same question twice, holds a
 * question back until the writer stops, and answers a slightly longer line from
 * what it already knows.
 *
 * Measurements against a real Ollama (`nimble`, `/v1/systemone`) shaped the
 * rules here:
 *
 * - The endpoint reuses its own work only for a request it has already answered
 *   *byte for byte*: an identical body comes back in ~52 ms, while any change —
 *   including one character more at the end of a line — costs the full prompt
 *   again (~450 ms). Whether the volatile `state` is serialized before or after
 *   the questions makes no difference (measured both ways: whichever order is
 *   sent first is slow and the second is fast), so the prompt cache cannot be
 *   made to survive a keystroke. The only lever left is not sending the request.
 * - With the candidate list held fixed, the model named the same table for
 *   every longer fragment of the identifier — twelve `order*` names from `o`
 *   through `orders`, and `orders` against `pending_orders` the same way. A
 *   question asked about these choices a moment ago is therefore still its
 *   answer while the user keeps typing, as long as a table the identifier no
 *   longer matches has not dropped out of the list — which is exactly what a
 *   changed candidate list means.
 *
 * That second rule is not licence to reuse an old answer in general: the same
 * experiment showed the model switching its pick the moment the fragment began
 * to point at a different name, so reuse is refused unless the choices are
 * identical. A question the model could not answer is remembered like any other
 * — re-asking a dead endpoint on every keystroke would help nobody — while a
 * request that *failed* is forgotten at once, so the next try can succeed.
 *
 * Because a question costs ~450 ms, asking one per keystroke is the real waste:
 * a question therefore waits `SETTLE_MS` for the writer to stop, and a line that
 * arrives while it is still waiting replaces the one that has not gone out yet
 * and starts the window again. The choices are the question; the line is only
 * where the cursor happens to be, so writing a word without pausing puts one
 * question, for the line it ended on.
 *
 * The window is per set of choices, so writing that narrows the choices puts one
 * question for each set — which is right, since a different list of choices is a
 * different question. A writer who never pauses for `SETTLE_MS` is asked nothing
 * until they do; that is what "until the writing stops" means.
 *
 * The statements a request should also ask about are carried with the question
 * rather than keyed into it. They are part of the request — the model is asked
 * about them — but they are not part of the *ranking*, and a line asked about
 * while the statement was a character shorter is still an answered line. The
 * answer says which statement each reading belongs to, which is what lets a
 * caller acting on them tell that it is holding a reading of a statement that has
 * since changed. `kind` — whether the names are tables or columns — travels the
 * same way for the same reason: it picks the wording of the question rather than
 * the answer, so it is carried and not keyed.
 */
import type { RankCandidatesResponse, RankCandidateKind } from "./types";

/**
 * The half of a question that is not the candidate names themselves.
 *
 * Both fields travel with the request and neither is part of the ranking: two
 * questions over the same line and the same names are the same question. They
 * are here rather than as loose parameters because a caller that passes one
 * almost always passes the other, and because a caller that passes neither is
 * asking the plain question — which is what a test wants.
 */
export interface RankQuestion {
  /**
   * The statements this request should also ask the model about, so each adds a
   * risk question to the same request instead of a call of its own. A caller that
   * knows what a command would send is what keeps the editor's questions about
   * exactly that text; the source this is handed from can only know the statement
   * the cursor is in, which is the one reading that can be had for free here. An
   * empty list asks the ranking alone.
   */
  statements: string[];
  /** What the names are, which picks the wording of the ranking question. */
  kind: RankCandidateKind;
}

/** The question a caller that says nothing asks: the names, and only the names. */
export const PLAIN_QUESTION: RankQuestion = { statements: [], kind: "table" };

/**
 * How long a question waits for the writer to stop, in milliseconds.
 *
 * This is a compromise, and the numbers behind it are measured: a question costs
 * the model ~450 ms, so waiting a fraction of that is always worth it, while the
 * wait is also time the ranking spends not being applied. Ordinary typing runs
 * at roughly 150–300 ms a keystroke, so this collapses a word into one question
 * without holding the answer back for a whole word's worth of typing. A faster
 * writer will still put more than one.
 */
export const SETTLE_MS = 150;

/** An answer, and whether asking for it cost anything. */
export interface RankedCandidates {
  response: RankCandidatesResponse;
  /** True when it came from memory: the model was not asked again. */
  reused: boolean;
}

export interface RankCacheOptions {
  /**
   * How to actually ask. Called only for questions this cache cannot answer.
   * `question` is the rest of the request the answer belongs to: the statements to
   * read as well, and what the names are.
   */
  ask: (
    line: string,
    candidates: readonly string[],
    question: RankQuestion,
  ) => Promise<RankCandidatesResponse>;
  /** How many questions to remember. The oldest is forgotten first. */
  limit?: number;
  /**
   * How long a question waits for the writer to stop. `0` puts every question
   * the moment it is asked, which is what a test of the lookup rules wants; the
   * app wants the default.
   */
  settle?: number;
}

export interface RankCache {
  /**
   * The model's answer for this line. The model is asked only when this
   * question, or a shorter line over the same choices, has not been answered,
   * and not before the writer has stopped for `settle` milliseconds.
   */
  rank(
    line: string,
    candidates: readonly string[],
    /** The rest of the question. A caller with neither statements nor a kind to
     *  give asks the plain one, which is what `PLAIN_QUESTION` is. */
    question?: RankQuestion,
  ): Promise<RankedCandidates>;
  /**
   * Whether the model is already being asked, or has been asked, about this
   * question. The editor uses this to decide whether there is anything to wait
   * for, so a remembered answer does not flash the indicator through "working".
   */
  knows(line: string, candidates: readonly string[]): boolean;
  /**
   * Whether an answer is in hand *now*, so `rank` returns without waiting for
   * the model. Finer than `knows`, which also counts a question still in flight
   * — that one has to be waited for, and the editor uses this to decide whether
   * it can rank the list it is showing instead of showing it unranked.
   */
  hasAnswer(line: string, candidates: readonly string[]): boolean;
}

/** One answered question, kept so a longer line can be answered from it. */
interface Answered {
  line: string;
  /** The question the answer belongs to. */
  question: RankQuestion;
  response: RankCandidatesResponse;
}

/** One question, in flight or answered, and what it carried. */
interface Asked {
  promise: Promise<RankCandidatesResponse>;
  /** The question it was put with, which its answer belongs to. */
  question: RankQuestion;
}

/** A question waiting out the settle window, one per set of choices. */
interface Burst {
  /** The line the question will be put with: the newest one, until it goes. */
  line: string;
  /** The rest of the question, replaced along with the line. */
  question: RankQuestion;
  candidates: readonly string[];
  /** Resolves when the answer lands, for everyone this burst is answering. */
  answer: Promise<RankCandidatesResponse>;
  /** The pending timer, or null once the request has gone out. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Start the settle window again, from now. */
  arm: () => void;
}

/**
 * The candidate list is part of the question in its own right — it is what the
 * model chooses between, and its order breaks ties in the ranking — so two
 * questions offering the same names in a different order are not the same
 * question. NUL cannot appear in either half, so the two cannot collide.
 *
 * The rest of the question — the statement and the kind — is deliberately *not*
 * part of this key. The answer says which statement it belongs to instead, so the
 * same line is never asked twice for differing in something the ranking does not
 * depend on. (The kind cannot vary over identical names in practice: the same
 * twelve names are not both tables and columns — but the absorb check below
 * requires it to match anyway, because a question put under the wrong wording is
 * not the answer that was asked for.)
 */
function askedKey(line: string, candidates: readonly string[]): string {
  return `${line}\u0000${candidates.join("\u0000")}`;
}

/** The choices alone, for looking up what was answered over them. */
function choices(candidates: readonly string[]): string {
  return candidates.join("\u0000");
}

/**
 * Whether `next` asks about the same statements as `previous`, each of them
 * merely longer — the list form of "the writer went on typing without the question
 * changing". A list of a different length is a different question: the statements
 * of a selection are what they are, and one that has appeared or gone means the
 * answer in flight is about another request.
 */
function extendsStatements(next: readonly string[], previous: readonly string[]): boolean {
  if (next.length !== previous.length) return false;
  return next.every((text, index) => text.startsWith(previous[index]));
}

/** Forget the eldest entries once a map is over its bound. */
function evict(entries: Map<string, unknown>, limit: number): void {
  while (entries.size > limit) {
    const eldest = entries.keys().next();
    if (eldest.done) return;
    entries.delete(eldest.value);
  }
}

/**
 * Mark an entry as the most recently used one. A `Map` iterates in insertion
 * order, so re-inserting moves it to the back and puts it last in line to be
 * evicted — which is what a hit should do.
 */
function touch<V>(entries: Map<string, V>, key: string): void {
  const value = entries.get(key);
  if (value === undefined) return;
  entries.delete(key);
  entries.set(key, value);
}

/** A promise whose settling is handed to the caller. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function createRankCache({
  ask,
  limit = 32,
  settle = SETTLE_MS,
}: RankCacheOptions): RankCache {
  /** Questions already put to the model, in flight or answered. */
  const asked = new Map<string, Asked>();
  /** The last line answered for each set of choices. */
  const answered = new Map<string, Answered>();
  /** Questions inside the settle window, keyed by the choices alone. */
  const bursts = new Map<string, Burst>();

  /** Put a question, and remember it under the line it was put with. */
  function askOnce(
    line: string,
    candidates: readonly string[],
    question: RankQuestion,
  ): Promise<RankCandidatesResponse> {
    const key = askedKey(line, candidates);
    const already = asked.get(key);
    if (already) {
      touch(asked, key);
      return already.promise;
    }
    const request = ask(line, candidates, question);
    asked.set(key, { promise: request, question });
    evict(asked, limit);
    // A failure is not an answer: remembering it would stop the editor from
    // ever trying this line again, so it is forgotten the moment it lands.
    request.catch(() => asked.delete(key));
    return request.then((response) => {
      answered.set(choices(candidates), { line, question, response });
      evict(answered, limit);
      return response;
    });
  }

  /** An earlier answer to a line this one merely extends, if there is one. */
  function extendsAnswered(
    line: string,
    candidates: readonly string[],
  ): Answered | null {
    const previous = answered.get(choices(candidates));
    if (!previous) return null;
    // Same choices, longer line: the user went on typing the same identifier
    // without narrowing it, so the question has not changed.
    if (line.length <= previous.line.length) return null;
    if (!line.startsWith(previous.line)) return null;
    return previous;
  }

  /**
   * Put a question to the model, but not before the writer has stopped. A line
   * that arrives while the burst is still waiting takes the place of the one
   * that has not gone out — the choices, the question itself, are the same — and
   * the window starts again from there, so the question is put once the writing
   * stops rather than part way through it.
   */
  function put(
    line: string,
    candidates: readonly string[],
    question: RankQuestion,
  ): Promise<RankCandidatesResponse> {
    if (settle <= 0) return askOnce(line, candidates, question);

    const key = choices(candidates);
    const waiting = bursts.get(key);
    if (waiting) {
      if (waiting.timer !== null) {
        waiting.line = line;
        waiting.question = question;
        waiting.arm();
        return waiting.answer;
      }
      // The request is already out. It answers a line this one extends over the
      // same choices — the reuse allowed above — so there is nothing to send.
      // The statements have to extend too, and the kind has to match: a question
      // put with either one different is a different question, and the answer in
      // flight would not be about it.
      if (
        line.startsWith(waiting.line) &&
        line.length > waiting.line.length &&
        question.kind === waiting.question.kind &&
        extendsStatements(question.statements, waiting.question.statements)
      ) {
        return waiting.answer;
      }
      // Otherwise it is answering something else, and the waiters on it already
      // hold its promise: this question starts its own burst in its place.
    }

    const landing = deferred<RankCandidatesResponse>();
    const burst: Burst = {
      line,
      question,
      candidates,
      answer: landing.promise,
      timer: null,
      arm: () => {
        if (burst.timer !== null) clearTimeout(burst.timer);
        burst.timer = setTimeout(fire, settle);
      },
    };
    bursts.set(key, burst);

    /** Put the question for whatever line the burst reached. */
    function fire(): void {
      burst.timer = null;
      askOnce(burst.line, candidates, burst.question).then(
        (response) => {
          if (bursts.get(key) === burst) bursts.delete(key);
          landing.resolve(response);
        },
        (error: unknown) => {
          if (bursts.get(key) === burst) bursts.delete(key);
          landing.reject(error);
        },
      );
    }

    burst.arm();
    return landing.promise;
  }

  function knows(line: string, candidates: readonly string[]): boolean {
    return (
      asked.has(askedKey(line, candidates)) ||
      extendsAnswered(line, candidates) !== null
    );
  }

  function hasAnswer(line: string, candidates: readonly string[]): boolean {
    const previous = answered.get(choices(candidates));
    // The same line was answered, or a shorter one was and this is an extension
    // of it — either way `rank` needs no help from the model. A *longer* line's
    // answer is no evidence about a shorter one, which is why it does not count.
    return previous !== undefined && line.startsWith(previous.line);
  }

  async function rank(
    line: string,
    candidates: readonly string[],
    question: RankQuestion = PLAIN_QUESTION,
  ): Promise<RankedCandidates> {
    const key = askedKey(line, candidates);

    const pending = asked.get(key);
    if (pending) {
      // A question already in flight is the same answer; waiting for that one
      // request is better than starting a second. The answer belongs to the
      // question that request carried, which need not be this one.
      touch(asked, key);
      return { response: await pending.promise, reused: true };
    }

    const earlier = extendsAnswered(line, candidates);
    if (earlier) {
      return { response: earlier.response, reused: true };
    }

    return { response: await put(line, candidates, question), reused: false };
  }

  return { rank, knows, hasAnswer };
}
