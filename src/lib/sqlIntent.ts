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
import { splitStatements } from "./sqlScript";

export function changesDatabaseSet(sql: string): boolean {
  return /\b(create|drop)\s+(database|schema)\b/i.test(sql);
}

const ROOT_COMMANDS = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE"]);

/** Return true when a statement is an UPDATE/DELETE with no top-level WHERE. */
function isUnscopedWrite(sql: string): boolean {
  // Keep tokens in separate parenthesized scopes so a WHERE in a subquery
  // cannot make its enclosing UPDATE/DELETE appear safely scoped.
  const scopes: string[][] = [[]];
  const scopeStack = [scopes[0]];
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    if (char === "-" && sql[index + 1] === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (char === "#") {
      while (index < sql.length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      index += 2;
      let comments = 1;
      while (index < sql.length && comments > 0) {
        if (sql[index] === "/" && sql[index + 1] === "*") {
          comments += 1;
          index += 2;
        } else if (sql[index] === "*" && sql[index + 1] === "/") {
          comments -= 1;
          index += 2;
        } else index += 1;
      }
      continue;
    }
    if (char === "'") {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "\\") {
          index += 2;
          continue;
        }
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (char === '"' || char === "`" || char === "[") {
      const close = char === "[" ? "]" : char;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "\\") {
          index += 2;
          continue;
        }
        if (sql[index] === close) {
          if (sql[index + 1] === close) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (char === "$") {
      const opener = sql.slice(index).match(/^\$[A-Za-z0-9_]*\$/)?.[0];
      if (opener) {
        const closeAt = sql.indexOf(opener, index + opener.length);
        index = closeAt < 0 ? sql.length : closeAt + opener.length;
        continue;
      }
    }
    if (char === "(") {
      const nestedScope: string[] = [];
      scopes.push(nestedScope);
      scopeStack.push(nestedScope);
      index += 1;
      continue;
    }
    if (char === ")") {
      if (scopeStack.length > 1) scopeStack.pop();
      index += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = index;
      index += 1;
      while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index])) index += 1;
      scopeStack[scopeStack.length - 1].push(sql.slice(start, index).toUpperCase());
      continue;
    }
    index += 1;
  }

  const rootTokens = scopes[0];
  let command = rootTokens[0];
  let commandIndex = 0;
  if (command === "WITH" || command === "EXPLAIN") {
    commandIndex = rootTokens.findIndex((token, index) => index > 0 && ROOT_COMMANDS.has(token));
    command = rootTokens[commandIndex] ?? "";
  }
  if (
    (command === "UPDATE" || command === "DELETE") &&
    !rootTokens.slice(commandIndex + 1).includes("WHERE")
  ) {
    return true;
  }
  // CTEs may contain data-changing statements. A nested read does not make
  // that write scoped, and a nested write does not inherit the outer WHERE.
  for (const tokens of scopes.slice(1)) {
    const nestedCommand = tokens[0];
    if (
      (nestedCommand === "UPDATE" || nestedCommand === "DELETE") &&
      !tokens.slice(1).includes("WHERE")
    ) {
      return true;
    }
  }
  return false;
}

/** List the UPDATE/DELETE statements that have no syntactic top-level WHERE. */
export function writesWithoutWhere(sql: string): string[] {
  return splitStatements(sql)
    .filter((statement) => isUnscopedWrite(statement.text))
    .map((statement) => statement.text);
}
