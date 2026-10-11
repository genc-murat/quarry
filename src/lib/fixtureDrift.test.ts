/**
 * The drift check between the Rust drivers and the development mock.
 *
 * The frontend cannot import Rust, so `fixtures/driver-descriptors.json` is the
 * contract: every registered driver's `list_drivers` descriptor plus the two
 * facts the driver declares that are not part of it — the identifier quote and
 * the statement a read is explained with. The Rust half
 * (`descriptor_snapshot_matches_the_registry` in `src-tauri/src/drivers/mod.rs`)
 * keeps that file honest against the registry; this test keeps the mock honest
 * against the file. A capability flag, an object kind, a context-menu action, a
 * connection field, an identifier quote or an explain statement that exists on
 * one side only fails here instead of silently showing the browser a surface the
 * engine does not have.
 *
 * After an intentional change to a driver:
 *
 * ```sh
 * QUARRY_UPDATE_SNAPSHOT=1 cargo test --manifest-path src-tauri/Cargo.toml descriptor_snapshot
 * npm run check:drift
 * ```
 *
 * `check:drift` runs both halves of the check; `npm test` runs this half.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { FIXTURES, type EngineFixture } from "./mockFixtures.ts";
import { mockInvoke, mockLatency } from "./mock.ts";
import type { DriverDescriptor, QueryResponse } from "./types.ts";

// The mock's latency exists so the browser shows its loading states; this check
// scripts six commands and should not wait for them.
mockLatency.min = 0;
mockLatency.max = 0;

const SNAPSHOT = new URL("./fixtures/driver-descriptors.json", import.meta.url);

/** What the Rust registry declares about one driver: the descriptor the
 *  frontend receives, plus the facts the mock also mirrors. */
interface DeclaredDriver extends DriverDescriptor {
  /** Character the engine's dialect wraps identifiers in. */
  identifierQuote: string;
  /** The statement a read is explained with; `null` when it cannot be. */
  explainSelect: string | null;
}

/**
 * Rust always serializes an optional field, as `null` when it is unset, while a
 * fixture simply leaves it out; both sides are therefore compared with absent
 * values removed. Everything else — including array order, which decides the
 * order of the connection form — has to match exactly.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === null || entry === undefined) continue;
      out[key] = canonical(entry);
    }
    return out;
  }
  return value;
}

/** What the Rust drivers declare, keyed by driver id. */
function declared(): Map<string, DeclaredDriver> {
  const parsed: unknown = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  assert.ok(Array.isArray(parsed), `${SNAPSHOT.pathname} must hold an array of declarations`);
  const drivers = parsed as DeclaredDriver[];
  return new Map(drivers.map((entry) => [entry.id, entry]));
}

/**
 * The mock must explain exactly what its driver declares, through the same
 * command the editor's Explain button uses: the declared statement for a read,
 * or the same refusal when the engine declares no EXPLAIN at all.
 */
async function assertExplainPath(fixture: EngineFixture, declaredStatement: string | null) {
  const args = {
    connectionId: fixture.session.id,
    request: { sql: "SELECT 1" },
  };
  const call = () => mockInvoke<QueryResponse>("explain_query", args);

  if (declaredStatement === null) {
    await assert.rejects(
      call,
      /cannot explain queries/,
      `${fixture.driver.id} declares no EXPLAIN, so the mock must refuse one`,
    );
    return;
  }

  const response = await call();
  assert.equal(
    response.results[0].statement,
    declaredStatement,
    `${fixture.driver.id} explains a read differently than the driver declares`,
  );
}

test("every Rust driver has exactly one mock fixture, and no orphan fixture is left", () => {
  const fixtures = FIXTURES.map((fixture) => fixture.driver.id);
  assert.equal(new Set(fixtures).size, fixtures.length, "each engine needs exactly one fixture");

  assert.deepEqual(
    [...declared().keys()].sort(),
    [...fixtures].sort(),
    "a driver exists on one side only: add its `EngineFixture`, or regenerate " +
      "`fixtures/driver-descriptors.json` with QUARRY_UPDATE_SNAPSHOT=1",
  );
});

test("each mock fixture declares exactly what its Rust driver declares", async () => {
  const descriptors = declared();

  for (const fixture of FIXTURES) {
    const entry = descriptors.get(fixture.driver.id);
    assert.ok(entry, `${fixture.driver.id} has no declaration in the snapshot`);
    const { identifierQuote, explainSelect, ...descriptor } = entry;

    assert.deepEqual(
      canonical(fixture.driver),
      canonical(descriptor),
      `${fixture.driver.id} disagrees with the Rust driver: the mock would show a surface ` +
        "the engine does not have (or hide one it does)",
    );
    assert.equal(
      fixture.quote,
      identifierQuote,
      `${fixture.driver.id} quotes identifiers differently than the driver declares`,
    );

    await assertExplainPath(fixture, explainSelect);
  }
});

test("the mock has a plan exactly for the engines that declare EXPLAIN", () => {
  for (const fixture of FIXTURES) {
    assert.equal(
      fixture.plan !== undefined,
      fixture.driver.capabilities.supportsExplain,
      `${fixture.driver.id}: a plan shape must exist exactly when supportsExplain does`,
    );
  }
});
