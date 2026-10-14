/**
 * Resolving what a `qualifier.` in the editor names, so the model can be asked
 * about the right list of names.
 *
 * A dotted completion is a different question from a bare one. `SELECT * FROM
 * ord` asks which *table* is meant; `SELECT orders.ord` asks which *column* — and
 * the names to choose between are the columns behind the qualifier, not the
 * schema's tables. Everything downstream is unchanged: the candidates are ranked
 * and their options boosted by label, exactly as table names are, so this module
 * is only about the front half.
 *
 * What a qualifier can be, and what the language offers behind it, was measured
 * against `@codemirror/lang-sql` rather than assumed:
 *
 * - a table's own name — `orders.` — offers that table's columns, so those are
 *   the candidates and the question is a column question;
 * - a schema's name — `shop.` — offers that schema's tables, so the candidates
 *   are tables and the question stays a table question;
 * - two parts — `shop.orders.` — resolve like the first case, because the
 *   identifier next to the dot is the table's;
 * - an alias — `o.` in `FROM orders o` — offers the bare list instead: `o`,
 *   `orders`, `object`, `of`, … The language does not resolve aliases, so
 *   `orders`' columns are not in the list at all, and there is nothing behind an
 *   alias to reorder. Offering them would mean *adding* names the language never
 *   offered, which is a different feature from ranking the ones it did — so an
 *   alias resolves to nothing here, and `o.ord` is completed exactly as it was
 *   before this module existed.
 *
 * That last case is why the resolution is deliberately narrow: a qualifier the
 * schema does not name resolves to nothing, and nothing is what gets asked. A
 * wrong qualifier costs the reader nothing, and an unresolvable one costs no
 * model call.
 *
 * How a qualifier may be *spelled* was measured the same way, because a spelling
 * this module does not recognise would silently drop the ranking rather than
 * fail:
 *
 * - a double-quoted identifier is the same qualifier — `"orders".` offers the
 *   same columns as `orders.` — so the quotes are stripped and the name is read;
 * - the language matches that name **exactly**, case included: `ORDERS.` and
 *   `"ORDERS".` offer nothing at all, and `"orders".` offers nothing when the
 *   schema spells the table `Orders`. This module is deliberately more forgiving
 *   than that (SQL names are case-insensitive on most engines) — but a question
 *   is only worth asking about names the list is actually showing, so the
 *   completion source drops one whose candidates are not on screen at all
 *   (`offered` in `./smartComplete`). Between the two, an uppercased qualifier
 *   costs no model call, and a quoted one is ranked like any other.
 * - backticks and brackets are **not** recognised, because the language does not
 *   recognise them either: `` `orders`. `` and `[orders].` offer the bare list
 *   (`orders`, `object`, …) rather than that table's columns, so there is nothing
 *   behind them to reorder. Reading them here would produce candidates that are
 *   not on screen — exactly what the guard above exists to refuse.
 */
import type { RankCandidateKind } from "./types";

/** The part of a table this needs: what a qualifier may name, and the names under it. */
export interface SchemaTable {
  table: string;
  schema: string | null;
  /** Column names, in the order the schema reported them. */
  columns: readonly string[];
}

/**
 * How far before the token is read looking for a qualifier. Identifiers are
 * short, and the qualifier ends at the dot, so this only bounds the pathological;
 * a miss means no ranking, not a wrong one.
 */
export const MAX_QUALIFIER_LOOKBEHIND = 64;

/**
 * A name at the very end of the text, either quoted or bare. A quoted one keeps
 * the double quote as its escape, so `"a""b"` is the single name `a"b`.
 */
const NAME_AT_END = /(?:"((?:[^"]|"")*)"|([A-Za-z_][\w$]*))$/;

/**
 * The identifier a dotted completion is qualified by, given the text that ends
 * exactly at the token: `orders` for `SELECT orders.|`, `orders` for
 * `SELECT shop.orders.|`, `o` for `SELECT o.|`, and the same name for the quoted
 * spellings `SELECT "orders".|` and `SELECT "shop"."orders".|`. `null` when
 * there is no dot, or nothing that could be a name before it.
 *
 * The quotes are removed rather than carried: the language offers the same names
 * behind `"orders".` as behind `orders.`, and the schema names tables and columns
 * unquoted, so comparing the quoted spelling would only ever miss.
 */
export function qualifierOf(before: string): string | null {
  if (!before.endsWith(".")) return null;
  const match = NAME_AT_END.exec(before.slice(0, -1));
  if (!match) return null;
  // Group 1 is the quoted spelling, group 2 the bare one; an empty name — `""` —
  // names nothing, which is the same answer as no qualifier at all.
  const name = match[1] !== undefined ? match[1].replace(/""/g, '"') : match[2];
  return name.length > 0 ? name : null;
}

/** What a qualifier names, and therefore what to ask the model about. */
export interface QualifierNames {
  /** The names to offer, in the order to offer them. */
  names: readonly string[];
  /** What those names are, which picks how the model is asked. */
  kind: RankCandidateKind;
}

/**
 * The names `qualifier` offers: a table's columns, or a schema's tables. `null`
 * when the qualifier names neither.
 *
 * A table name wins over a schema name of the same spelling, which is the rarer
 * collision and the more useful reading of it.
 */
export function resolveQualifier(
  qualifier: string,
  schema: readonly SchemaTable[],
): QualifierNames | null {
  const needle = qualifier.toLowerCase();

  const table = schema.find((entry) => entry.table.toLowerCase() === needle);
  if (table) return { names: table.columns, kind: "column" };

  const inSchema = schema.filter((entry) => entry.schema?.toLowerCase() === needle);
  if (inSchema.length > 0) return { names: inSchema.map((entry) => entry.table), kind: "table" };

  return null;
}
