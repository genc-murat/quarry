import assert from "node:assert/strict";
import test from "node:test";

import { ipc } from "./ipc.ts";
import { mockLatency } from "./mock.ts";
import { installTestBackend } from "./testBackend.ts";
import type { ConnectionProfile } from "./types.ts";

// The demo backend waits on purpose so the browser shows its loading states;
// the assertion that restoring brings it back should not wait for that.
mockLatency.min = 0;
mockLatency.max = 0;

const profile: ConnectionProfile = {
  id: "p1",
  name: "Local MySQL 5.6",
  driver: "mysql",
  host: "127.0.0.1",
  port: 3306,
  username: "root",
  database: "shop",
  sslMode: "preferred",
  options: {},
  hasPassword: true,
};

/** A promise the test settles by hand, so a held-open command stays open. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("a scripted reply answers the call, and the command is recorded with its payload", async (t) => {
  const backend = installTestBackend({
    list_connections: () => [profile],
    disconnect: () => undefined,
  });
  t.after(backend.restore);

  assert.deepEqual(await ipc.listConnections(), [profile]);
  await ipc.disconnect("session-1");

  assert.deepEqual(backend.argsFor("list_connections"), [undefined]);
  assert.deepEqual(backend.argsFor("disconnect"), [{ connectionId: "session-1" }]);
  assert.deepEqual(
    backend.sent.map((entry) => entry.command),
    ["list_connections", "disconnect"],
  );
});

test("an unscripted command fails loudly, and is still recorded", async (t) => {
  const backend = installTestBackend();
  t.after(backend.restore);

  // Resolving to undefined instead would let a component render an empty state
  // that reads like a passing assertion, so the double refuses the command.
  await assert.rejects(ipc.listDrivers(), /unscripted command: list_drivers/);
  assert.deepEqual(
    backend.sent.map((entry) => entry.command),
    ["list_drivers"],
  );
});

test("a reply may hold the command open until the test settles it", async (t) => {
  const rows = deferred<number>();
  const backend = installTestBackend({ count_rows: () => rows.promise });
  t.after(backend.restore);

  let settled = false;
  const call = ipc.countRows("session-1", "shop", null, "orders").then((value) => {
    settled = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(settled, false, "the call must still be waiting on its reply");

  rows.resolve(4821);
  assert.equal(await call, 4821);
});

test("restoring hands the app back to the demo backend", async () => {
  const backend = installTestBackend();
  await assert.rejects(ipc.listDrivers(), /unscripted command/);
  backend.restore();

  assert.ok((await ipc.listDrivers()).length > 0, "the fixtures answer again after a restore");
});
