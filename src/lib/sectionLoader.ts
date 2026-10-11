/**
 * State machine behind a `live` inspector section, kept out of the component so
 * its guarantees can be tested without a DOM:
 *
 * - loading a **different** identity drops the previous body before fetching, so
 *   a slow response can never leave another object's rows on screen;
 * - requests are sequenced, so only the newest one may commit its body or its
 *   error — a response that arrives late is ignored rather than applied;
 * - refreshing the same identity keeps the visible body instead of blanking it.
 *
 * `getState` returns a stable snapshot and only replaces it when something
 * changed, which is what `useSyncExternalStore` requires.
 */
export interface SectionState<T> {
  /** Body of the current identity, or `null` before the first one lands. */
  data: T | null;
  /** A request for the current identity is in flight. */
  loading: boolean;
  /** Message for a failed request to the current identity, else `""`. */
  error: string;
}

export interface SectionLoader<T> {
  getState(): SectionState<T>;
  subscribe(listener: () => void): () => void;
  /**
   * Fetch `identity`. A different identity than the current one clears the body
   * first; the same identity keeps it, which is what makes this a refresh.
   * Failures are reported through `getState().error` — `load` never rejects.
   */
  load(identity: string, fetch: () => Promise<T>): Promise<void>;
  /** Refetch the current identity, keeping the visible body. */
  refresh(): Promise<void>;
}

export function createSectionLoader<T>(options: {
  /** Turns a thrown value into the message shown in place of the body. */
  errorMessage: (reason: unknown) => string;
}): SectionLoader<T> {
  let state: SectionState<T> = { data: null, loading: false, error: "" };
  let identity = "";
  let fetch: (() => Promise<T>) | null = null;
  // Bumped on every request; only the newest number is allowed to commit.
  let latest = 0;
  const listeners = new Set<() => void>();

  function commit(next: Partial<SectionState<T>>) {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  }

  async function load(nextIdentity: string, nextFetch: () => Promise<T>) {
    const request = (latest += 1);
    const switched = nextIdentity !== identity;
    identity = nextIdentity;
    fetch = nextFetch;
    commit({ data: switched ? null : state.data, loading: true, error: "" });
    try {
      const data = await nextFetch();
      if (request === latest) commit({ data, loading: false, error: "" });
    } catch (reason) {
      if (request === latest) {
        commit({ loading: false, error: options.errorMessage(reason) });
      }
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load,
    refresh: () => (fetch ? load(identity, fetch) : Promise.resolve()),
  };
}
