/**
 * How the two non-tabular engines turn a reply into the shared rows/columns
 * result shape, for the development-only fake backend.
 *
 * These functions mirror the Rust adapters exactly, because the point of the
 * mock is to render what the desktop app renders:
 *
 * * `redisReplyToTable` mirrors `drivers/redis.rs`'s `reply_to_table` +
 *   `array_table`: a scalar becomes a single cell, a flat array one row per
 *   element, a nested array a `col_1 … col_N` matrix, and a map a `field`/`value`
 *   table. The Rust unit tests are the spec.
 * * `mongoDocumentsToTable` mirrors `drivers/mongo.rs`'s `documents_table`:
 *   columns are the union of top-level keys in first-seen order, a missing key
 *   is null in that row, and documents carry no declared column type.
 *   `inferMongoColumns` mirrors `infer_columns` for the inspector.
 */
import type { ColumnMeta, StatementResult } from "./types";

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

/** A RESP reply, reduced to what the table mapping looks at. */
export type RedisReply =
  | { kind: "scalar"; type: string; value: unknown }
  | { kind: "array"; items: RedisReply[] }
  | { kind: "map"; pairs: [RedisReply, RedisReply][] };

export const redis = {
  integer: (value: number): RedisReply => ({ kind: "scalar", type: "integer", value }),
  status: (value: string): RedisReply => ({ kind: "scalar", type: "status", value }),
  string: (value: string): RedisReply => ({ kind: "scalar", type: "string", value }),
  error: (message: string): RedisReply => ({ kind: "scalar", type: "error", value: message }),
  array: (...items: RedisReply[]): RedisReply => ({ kind: "array", items }),
  map: (pairs: [RedisReply, RedisReply][]): RedisReply => ({ kind: "map", pairs }),
};

function scalarValue(reply: RedisReply): unknown {
  if (reply.kind === "scalar") return reply.value;
  if (reply.kind === "array") return reply.items.map(scalarValue);
  return Object.fromEntries(
    reply.pairs.map(([key, value]) => [String(scalarValue(key)), scalarValue(value)]),
  );
}

/** `array_table`: a nested array becomes a matrix, a flat one a single column. */
function arrayTable(items: RedisReply[]): { columns: ColumnMeta[]; rows: unknown[][] } {
  const nested = items.length > 0 && items.every((item) => item.kind === "array");
  if (!nested) {
    return {
      columns: [{ name: "value", dataType: "string" }],
      rows: items.map((item) => [scalarValue(item)]),
    };
  }

  const width = Math.max(
    0,
    ...items.map((item) => (item.kind === "array" ? item.items.length : 0)),
  );
  const columns = Array.from({ length: width }, (_, index) => ({
    name: `col_${index + 1}`,
    dataType: "string",
  }));
  const rows = items.map((item) => {
    const row = item.kind === "array" ? item.items.map(scalarValue) : [scalarValue(item)];
    while (row.length < width) row.push(null);
    return row;
  });
  return { columns, rows };
}

/**
 * `reply_to_table`: the columns, rows and truncation flag one reply produces.
 * `maxRows` is the editor's row limit (`request.max_rows`, default 1000).
 */
export function redisReplyToTable(
  reply: RedisReply,
  maxRows: number,
): { columns: ColumnMeta[]; rows: unknown[][]; truncated: boolean } {
  let table: { columns: ColumnMeta[]; rows: unknown[][] };
  if (reply.kind === "array") {
    table = arrayTable(reply.items);
  } else if (reply.kind === "map") {
    table = {
      columns: [
        { name: "field", dataType: "string" },
        { name: "value", dataType: "string" },
      ],
      rows: reply.pairs.map(([key, value]) => [scalarValue(key), scalarValue(value)]),
    };
  } else {
    table = { columns: [{ name: "value", dataType: reply.type }], rows: [[reply.value]] };
  }

  if (table.rows.length > maxRows) {
    return { columns: table.columns, rows: table.rows.slice(0, maxRows), truncated: true };
  }
  return { ...table, truncated: false };
}

/** One stored key, with the contents its commands answer from. */
export interface RedisKeyFixture {
  name: string;
  type: "string" | "hash" | "list" | "set" | "zset" | "stream";
  /** The string value, or the members of a collection key. */
  elements: string[];
  /** Field/value pairs of a hash, which `HGETALL` answers. */
  fields?: [string, string][];
  ttlSeconds?: number | null;
}

/**
 * The length the explorer's summary shows: `HLEN` for a hash, `STRLEN` for a
 * string, the member count for everything else (`key_length` in the adapter).
 */
export function redisKeyLength(key: RedisKeyFixture): number {
  if (key.type === "hash") return key.fields?.length ?? 0;
  if (key.type === "string") return key.elements[0]?.length ?? 0;
  return key.elements.length;
}

function findKey(keys: RedisKeyFixture[], name: string): RedisKeyFixture | undefined {
  return keys.find((key) => key.name === name);
}

/**
 * The reply one command gets. A command the mock has no sample for answers with
 * an error rather than a fabricated success, so a typo and an unsampled command
 * both surface as an error row instead of wrong data.
 */
function redisReply(command: string, args: string[], keys: RedisKeyFixture[]): RedisReply {
  const name = command.toUpperCase();
  const key = args.length > 0 ? findKey(keys, args[0]) : undefined;
  const missing = redis.error(`ERR no such key '${args[0] ?? ""}'`);
  const members = (): RedisReply[] => (key?.elements ?? []).map(redis.string);

  /** One of the collection reads, refusing a key of another type. */
  const collection = (
    type: RedisKeyFixture["type"],
    build: (key: RedisKeyFixture) => RedisReply,
  ): RedisReply => (key && key.type === type ? build(key) : missing);

  switch (name) {
    case "PING":
      return redis.status("PONG");
    case "TYPE":
      return redis.status(key?.type ?? "none");
    case "TTL":
      return redis.integer(key ? (key.ttlSeconds ?? -1) : -2);
    case "EXISTS":
      return redis.integer(args.reduce((total, arg) => total + (findKey(keys, arg) ? 1 : 0), 0));
    case "DBSIZE":
      return redis.integer(keys.length);
    case "GET":
      return key?.type === "string" ? redis.string(key.elements[0] ?? "") : missing;
    case "STRLEN":
      return key?.type === "string" ? redis.integer(redisKeyLength(key)) : missing;
    case "HGETALL":
      return collection("hash", (hash) =>
        redis.map(
          (hash.fields ?? []).map(([field, value]) => [redis.string(field), redis.string(value)]),
        ),
      );
    case "HGET":
      return collection("hash", (hash) => {
        const field = hash.fields?.find(([name]) => name === args[1]);
        return redis.string(field ? field[1] : "");
      });
    case "HKEYS":
      return collection("hash", (hash) =>
        redis.array(...(hash.fields ?? []).map(([field]) => redis.string(field))),
      );
    case "HVALS":
      return collection("hash", (hash) =>
        redis.array(...(hash.fields ?? []).map(([, value]) => redis.string(value))),
      );
    case "HLEN":
      return collection("hash", (hash) => redis.integer(hash.fields?.length ?? 0));
    case "LRANGE":
      return collection("list", () => redis.array(...members()));
    case "SMEMBERS":
      return collection("set", () => redis.array(...members()));
    case "SCARD":
      return collection("set", (set) => redis.integer(set.elements.length));
    case "ZRANGE":
      return collection("zset", (zset) =>
        args.some((arg) => arg.toUpperCase() === "WITHSCORES")
          ? // `WITHSCORES` answers one `[member, score]` pair per element, which
            // the table mapping renders as the `col_1`/`col_2` matrix.
            redis.array(
              ...zset.elements.map((member, index) =>
                redis.array(redis.string(member), redis.string(String(index + 1))),
              ),
            )
          : redis.array(...zset.elements.map(redis.string)),
      );
    case "KEYS":
      return redis.array(...keys.map((entry) => redis.string(entry.name)));
    case "SCAN":
      // `SCAN cursor` answers `[cursor, [keys…]]`, the other nested reply shape.
      return redis.array(
        redis.string("0"),
        redis.array(...keys.map((entry) => redis.string(entry.name))),
      );
    case "SET":
      return redis.status("OK");
    case "DEL":
      return redis.integer(args.filter((arg) => findKey(keys, arg)).length);
    case "SADD":
    case "LPUSH":
    case "RPUSH":
      return redis.integer(args.length - 1);
    case "HSET":
      return redis.integer(args.length > 2 ? Math.floor((args.length - 2) / 2) : 0);
    case "INFO":
      return redis.string(`# Server\r\nredis_version:7.2.5\r\n# Keyspace\r\ndb0:keys=${keys.length}\r\n`);
    default:
      return redis.error(`ERR the dev mock has no reply for '${name}'`);
  }
}

/**
 * Split one line into arguments, honouring quotes and backslash escapes — the
 * shape the Redis editor sends (`split_commands` in the adapter).
 */
export function tokenizeCommandLine(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaped = false;

  for (const character of line) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (quote && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** One statement result per non-empty, non-comment command line. */
export function redisStatements(
  script: string,
  keys: RedisKeyFixture[],
  maxRows: number,
): StatementResult[] {
  return script
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const args = tokenizeCommandLine(line);
      const statement = args.join(" ");
      if (args.length === 0) return failed(statement, "empty command");
      const reply = redisReply(args[0], args.slice(1), keys);
      if (reply.kind === "scalar" && reply.type === "error") {
        return failed(statement, String(reply.value));
      }
      const { columns, rows, truncated } = redisReplyToTable(reply, maxRows);
      return {
        statement,
        isQuery: true,
        columns,
        rows,
        rowCount: rows.length,
        affectedRows: null,
        lastInsertId: null,
        executionMs: 1,
        truncated,
        error: null,
      };
    });
}

function failed(statement: string, error: string): StatementResult {
  return {
    statement,
    isQuery: false,
    columns: [],
    rows: [],
    rowCount: 0,
    affectedRows: null,
    lastInsertId: null,
    executionMs: 1,
    truncated: false,
    error,
  };
}

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------

/** A document as the app receives it: BSON in relaxed extended JSON form. */
export type MongoDocument = Record<string, unknown>;

/** One collection: the documents `find` answers with, and its document count. */
export interface MongoCollectionFixture {
  documents: MongoDocument[];
  count: number;
}

/** `documents_table`: union of top-level keys, missing keys are null. */
export function mongoDocumentsToTable(
  documents: MongoDocument[],
  maxRows: number,
): { columns: ColumnMeta[]; rows: unknown[][]; truncated: boolean } {
  const names: string[] = [];
  for (const document of documents) {
    for (const key of Object.keys(document)) {
      if (!names.includes(key)) names.push(key);
    }
  }
  // A document declares no column type, so the adapter leaves `dataType` unset
  // and the grid shows the value alone.
  const columns: ColumnMeta[] = names.map((name) => ({ name, dataType: null }));
  const rows = documents.slice(0, maxRows).map((document) => names.map((name) => document[name] ?? null));
  return { columns, rows, truncated: documents.length > maxRows };
}

/** BSON type name of an extended-JSON value, as `bson_type_name` reports it. */
export function bsonTypeName(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "double";
  if (typeof value === "object") {
    const tagged = value as Record<string, unknown>;
    if ("$oid" in tagged) return "objectId";
    if ("$date" in tagged) return "date";
    if ("$numberLong" in tagged) return "long";
    if ("$numberInt" in tagged) return "int";
    if ("$numberDouble" in tagged) return "double";
    if ("$numberDecimal" in tagged) return "decimal";
    if ("$binary" in tagged) return "binData";
    if ("$timestamp" in tagged) return "timestamp";
    return "object";
  }
  return "value";
}

/**
 * `infer_columns`: the field types of the sample joined with ` | `, `_id`
 * first, nullable when a document omits the field or stores null.
 */
export function inferMongoColumns(
  documents: MongoDocument[],
): { name: string; dataType: string; nullable: boolean; isPrimaryKey: boolean }[] {
  const fields: { name: string; types: string[]; present: number; hasNull: boolean }[] = [];
  for (const document of documents) {
    for (const [key, value] of Object.entries(document)) {
      let field = fields.find((entry) => entry.name === key);
      if (!field) {
        field = { name: key, types: [], present: 0, hasNull: false };
        fields.push(field);
      }
      field.present += 1;
      if (value === null || value === undefined) field.hasNull = true;
      const type = bsonTypeName(value);
      if (!field.types.includes(type)) field.types.push(type);
    }
  }

  fields.sort((left, right) => Number(right.name === "_id") - Number(left.name === "_id"));
  return fields.map((field) => ({
    name: field.name,
    dataType: field.types.join(" | "),
    nullable: field.present < documents.length || field.hasNull,
    isPrimaryKey: field.name === "_id",
  }));
}

/**
 * One statement result per JSON command document. `find` and `aggregate`
 * answers are the collection's sample documents flattened into a table; every
 * other command's reply is a single row, exactly like the adapter.
 */
export function mongoStatements(
  script: string,
  collections: Record<string, MongoCollectionFixture>,
  maxRows: number,
): StatementResult[] {
  const singleRow = (statement: string, reply: MongoDocument): StatementResult => {
    const { columns, rows } = mongoDocumentsToTable([reply], maxRows);
    return {
      statement,
      isQuery: true,
      columns,
      rows,
      rowCount: rows.length,
      affectedRows: null,
      lastInsertId: null,
      executionMs: 1,
      truncated: false,
      error: null,
    };
  };

  return splitCommandDocuments(script).map((command) => {
    // `parse_commands` fails the whole run on a command it cannot parse, so this
    // throws rather than reporting one bad statement among good ones.
    const parsed = tryParseCommand(command);
    if (!parsed) throw new Error(`invalid JSON command: ${command}`);
    if (Object.keys(parsed).length === 0) throw new Error("empty command document");
    const name = Object.keys(parsed)[0] ?? "";
    const target = typeof parsed[name] === "string" ? String(parsed[name]) : "";
    if (name === "find" || name === "aggregate") {
      // The pipeline of an `aggregate` is not evaluated: a review fixture shows
      // the collection's documents, which is what the grid has to render.
      const { columns, rows, truncated } = mongoDocumentsToTable(
        collections[target]?.documents ?? [],
        maxRows,
      );
      return {
        statement: command,
        isQuery: true,
        columns,
        rows,
        rowCount: rows.length,
        affectedRows: null,
        lastInsertId: null,
        executionMs: 1,
        truncated,
        error: null,
      };
    }
    if (name === "count" || name === "countDocuments") {
      return singleRow(command, { n: collections[target]?.count ?? 0, ok: 1 });
    }
    if (name === "insert" || name === "update" || name === "delete") {
      return singleRow(command, { n: 1, ok: 1 });
    }
    if (name === "ping") return singleRow(command, { ok: 1 });
    // An unsampled command fails the way a real one does, instead of inventing
    // an `ok` reply.
    return failed(command, `the dev mock has no reply for '${name}'`);
  });
}

/** `split_documents`: the script must be a sequence of complete `{ … }` documents. */

/** The `{ … }` documents of a script, in order (`split_documents`). */
export function splitCommandDocuments(script: string): string[] {
  const documents: string[] = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < script.length; index += 1) {
    const character = script[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"' && depth > 0) inString = true;
    else if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth < 0) throw new Error("unexpected `}` outside a command");
      if (depth === 0) documents.push(script.slice(start, index + 1));
    } else if (character === "[") depth += 1;
    else if (character === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && !/\s/.test(character) && character !== "," && character !== ";") {
      throw new Error(
        `expected a JSON command such as {"find": "users"}, found \`` + character + "`",
      );
    }
  }

  if (depth !== 0 || inString) throw new Error("unterminated command document");
  return documents;
}

function tryParseCommand(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}
