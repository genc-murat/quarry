/**
 * Small helpers that classify a statement by intent. Keeping them pure lets the
 * store stay thin and makes the rules unit-testable.
 */

/**
 * True when a statement creates or drops a database/schema, i.e. when it can
 * change the set of databases the explorer lists.
 *
 * This is a deliberately simple keyword check: it can match inside a string
 * literal or comment, which at worst causes one harmless extra refresh.
 */
export function changesDatabaseSet(sql: string): boolean {
  return /\b(create|drop)\s+(database|schema)\b/i.test(sql);
}
