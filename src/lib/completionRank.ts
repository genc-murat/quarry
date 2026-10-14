/**
 * Ranking helpers for the editor's "smart" autocomplete.
 *
 * Pure functions only: the CodeMirror source in `./smartComplete` decides *when*
 * to ask the local decision model, and these decide which candidates are worth
 * asking about and how the answer is folded back into the completion options.
 * Keeping the arithmetic here is what makes it unit-testable without an editor,
 * a schema or a model.
 *
 * Nothing here cares whether the names are tables or columns: a boost is a boost,
 * and `applyBoosts` matches an option by its own label, which is what lets a
 * `qualifier.` position reuse the whole arrangement unchanged.
 */

/**
 * How many candidates one keystroke may send to the model. A schema can hold
 * hundreds of tables; the model decides between a handful, not all of them.
 */
export const MAX_RANK_CANDIDATES = 12;

/**
 * The highest `boost` CodeMirror accepts. The model's pick is lifted above
 * every other option that matched the typed prefix equally well.
 */
export const TOP_BOOST = 99;

/**
 * The names a partially typed identifier could still complete to — table names
 * at a `FROM` position, column names after a qualifier: a case-insensitive
 * match, with prefix matches ranked above interior ones so the list is stable
 * and sensible even before the model answers. An empty token yields nothing,
 * because "every name" is not a question worth asking.
 */
export function candidateNames(
  names: readonly string[],
  token: string,
  limit: number = MAX_RANK_CANDIDATES,
): string[] {
  if (token.length === 0) return [];
  const needle = token.toLowerCase();
  const prefixes: string[] = [];
  const interiors: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    if (lower.startsWith(needle)) {
      seen.add(lower);
      prefixes.push(name);
    } else if (lower.includes(needle)) {
      seen.add(lower);
      interiors.push(name);
    }
  }
  return [...prefixes, ...interiors].slice(0, limit);
}

/**
 * Return `options` with the tables named in `ranked` boosted so the model's
 * pick sorts first and the rest follow. The array order is left alone —
 * CodeMirror ranks by `boost` among completions that matched the input equally
 * well — and anything the model named that is not an option is simply ignored.
 */
export function applyBoosts<T extends { label: string; boost?: number }>(
  options: readonly T[],
  ranked: readonly string[],
): T[] {
  if (ranked.length === 0) return options.slice();
  const ranks = new Map<string, number>();
  ranked.forEach((name, index) => {
    const key = name.toLowerCase();
    // First mention wins, so a duplicated name cannot tie itself.
    if (!ranks.has(key)) ranks.set(key, index);
  });
  return options.map((option) => {
    const rank = ranks.get(option.label.toLowerCase());
    if (rank === undefined) return option;
    // The model only ever answers about at most `MAX_RANK_CANDIDATES` names, so
    // this stays in the top of the range; the clamp keeps a caller that hands
    // us a longer ranking inside CodeMirror's documented -99..99.
    const boost = Math.min(TOP_BOOST, Math.max(-TOP_BOOST, TOP_BOOST - rank));
    return { ...option, boost };
  });
}
