import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { act } from "react";

import { ConnectionList } from "./ConnectionList.tsx";
import { installTestBackend, type TestBackend } from "@/lib/testBackend.ts";
import { click, closeDom, mount, type MountedComponent } from "@/lib/testRender.tsx";
import type {
  ConnectionProfile,
  DatabaseInfo,
  DriverDescriptor,
  SessionInfo,
} from "@/lib/types.ts";

import { useWorkspace } from "@/stores/workspace.ts";

const driver = (
  id: string,
  displayName: string,
  accentColor: string,
  configKeys: string[],
): DriverDescriptor => ({
  id,
  displayName,
  defaultPort: 3306,
  accentColor,
  capabilities: {
    queryLanguage: "sql",
    resultShape: "tabular",
    isRelational: true,
    supportsMultipleDatabases: true,
    supportsSchemas: false,
    supportsTransactions: true,
    supportsDdl: true,
    supportsExplain: true,
    supportsCancel: true,
    objectKinds: ["table"],
    supportedActions: [],
  },
  configFields: configKeys.map((key) => ({
    key,
    label: key,
    fieldType: "text",
    required: true,
    options: [],
  })),
});

const mysqlDriver = driver("mysql", "MySQL 5.6", "#4479a1", ["host", "port", "username"]);
// Its form has no host field, which is how the list knows to show the file path.
const sqliteDriver = driver("sqlite", "SQLite", "#003b57", ["path"]);

const mysqlProfile: ConnectionProfile = {
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

const sqliteProfile: ConnectionProfile = {
  id: "p2",
  name: "Sample shop.db",
  driver: "sqlite",
  host: "",
  port: 0,
  username: "",
  database: null,
  sslMode: "disabled",
  options: { path: "/Users/me/data/shop.db" },
  hasPassword: false,
};

const shopSession: SessionInfo = {
  id: "s1",
  profileId: "p1",
  driver: "mysql",
  name: "Local MySQL 5.6",
  server: {
    version: "5.6.51-log",
    versionNumber: 50651,
    currentDatabase: "shop",
    currentUser: "root",
    supportsTls: true,
  },
};

const shopDatabase: DatabaseInfo = { name: "shop", isSystem: false };

/** What connecting to the second, currently disconnected profile hands back. */
const fileSession: SessionInfo = {
  id: "s2",
  profileId: "p2",
  driver: "sqlite",
  name: "Sample shop.db",
  server: { version: "3.45.3", versionNumber: 34503, supportsTls: false },
};

/** What the app asks for on mount, as a fresh table per test. */
const bootReplies = () => ({
  list_drivers: () => [mysqlDriver, sqliteDriver],
  list_connections: () => [mysqlProfile, sqliteProfile],
  list_sessions: () => [shopSession],
  list_snippets: () => [],
  get_settings: () => null,
  list_databases: () => [shopDatabase],
  connect: () => ({ session: fileSession }),
  disconnect: () => undefined,
});

/** The store as it stood before any test touched it. */
const pristine = useWorkspace.getState();

/** How many rows currently offer to disconnect, so how many are connected. */
const disconnectButtons = (view: MountedComponent) =>
  [...view.container.querySelectorAll("button")].filter(
    (button) => button.textContent?.trim() === "Disconnect",
  ).length;

/** Hand the backend, the store and the document back once the test finishes. */
function cleanup(t: TestContext, backend: TestBackend) {
  t.after(() => {
    backend.restore();
    useWorkspace.setState(pristine, true);
    closeDom();
  });
}

/** Boot the app the way `App` does on mount, but against scripted replies. */
async function boot(t: TestContext) {
  const backend = installTestBackend(bootReplies());
  cleanup(t, backend);
  await useWorkspace.getState().bootstrap();
  return backend;
}

test("booting over the double renders the connections it answered with", async (t) => {
  await boot(t);
  const view = await mount(<ConnectionList />);
  t.after(view.unmount);

  assert.match(view.html(), /Local MySQL 5\.6/);
  assert.match(view.html(), /root@127\.0\.0\.1:3306\/shop/);
  assert.match(view.html(), /connected · 5\.6\.51-log/);
  // The file-backed profile shows its path, so the driver's own form decided it.
  assert.match(view.html(), /Sample shop\.db/);
  assert.match(view.html(), /\/Users\/me\/data\/shop\.db/);
});

test("the boot sends exactly these commands, with these payloads", async (t) => {
  const backend = await boot(t);

  assert.deepEqual(
    [...new Set(backend.sent.map((entry) => entry.command))].sort(),
    [
      "get_settings",
      "list_connections",
      "list_databases",
      "list_drivers",
      "list_sessions",
      "list_snippets",
    ],
  );
  assert.deepEqual(backend.argsFor("list_databases"), [{ connectionId: "s1" }]);
  assert.deepEqual(backend.argsFor("list_sessions"), [undefined]);
});

test("clicking Connect sends the command and shows the session it returns", async (t) => {
  const backend = await boot(t);
  const view = await mount(<ConnectionList />);
  t.after(view.unmount);

  // Only the file-backed profile is unconnected, so its button is the one here.
  assert.equal(disconnectButtons(view), 1);
  await click(view, "Connect");

  assert.deepEqual(backend.argsFor("connect"), [{ input: { profileId: "p2" } }]);
  assert.equal(disconnectButtons(view), 2);
  assert.match(view.html(), /connected · 3\.45\.3/);
});

test("disconnecting through the store takes the connected row away", async (t) => {
  const backend = await boot(t);
  const view = await mount(<ConnectionList />);
  t.after(view.unmount);

  await useWorkspace.getState().disconnect("s1");

  assert.deepEqual(backend.argsFor("disconnect"), [{ connectionId: "s1" }]);
  assert.doesNotMatch(view.html(), /Disconnect/);
  assert.match(view.html(), /Connect<\/button>/);
});

test("an unscripted command surfaces as an error rather than an empty list", async (t) => {
  // Everything but `list_connections`, so the boot fails the way a broken
  // backend would instead of quietly rendering "No connections yet".
  const backend = installTestBackend({ list_drivers: () => [mysqlDriver, sqliteDriver] });
  cleanup(t, backend);

  await useWorkspace.getState().bootstrap();

  const toast = useWorkspace.getState().toasts.at(-1);
  assert.equal(toast?.title, "Could not load application state");
  assert.match(String(toast?.description), /unscripted command: list_connections/);

  const view = await mount(<ConnectionList />);
  t.after(view.unmount);
  assert.match(view.text(), /No connections yet\./);
});

/** Right-click a connection card and settle the menu's state update. */
async function openConnectionMenu(view: MountedComponent, name: string) {
  // The card is the only `bg-card` element outside the menu, and the open menu
  // carries that class too, so it is excluded explicitly rather than by order.
  const card = [...view.container.querySelectorAll("div")].find(
    (candidate) =>
      candidate.className.includes("bg-card") &&
      !candidate.closest('[role="menu"]') &&
      candidate.textContent?.includes(name),
  );
  assert.ok(card, `no connection card for ${name}`);
  await act(async () => {
    card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 40 }));
  });
}

test("right-clicking a connection shows the SQL editor group", async (t) => {
  await boot(t);
  const view = await mount(<ConnectionList />);
  t.after(view.unmount);

  await openConnectionMenu(view, "Local MySQL 5.6");

  assert.match(view.text(), /SQL editor/);
  assert.match(view.text(), /New SQL script/);
  assert.match(view.text(), /Open SQL console/);
});

test("Open SQL console opens a console tab bound to the connection", async (t) => {
  await boot(t);
  const view = await mount(<ConnectionList />);
  t.after(view.unmount);

  await openConnectionMenu(view, "Local MySQL 5.6");
  await click(view, "Open SQL console");

  assert.equal(useWorkspace.getState().activeSessionId, "s1");
  const consoleTab = useWorkspace.getState().tabs.at(-1);
  assert.equal(consoleTab?.kind, "query");
  assert.equal(consoleTab?.sessionId, "s1");
});

test("New SQL script opens a file-backed script tab", async (t) => {
  await boot(t);
  const view = await mount(<ConnectionList />);
  t.after(view.unmount);

  await openConnectionMenu(view, "Local MySQL 5.6");
  await click(view, "New SQL script");

  const scriptTab = useWorkspace.getState().tabs.at(-1);
  assert.equal(scriptTab?.kind, "script");
  // The browser has no picker, so the suggested `.sql` name is accepted as-is.
  assert.match(String(scriptTab?.filePath), /\.sql$/);
  assert.equal(scriptTab?.title, String(scriptTab?.filePath).split("/").pop());
});

test("a script for a disconnected connection is left unbound", async (t) => {
  await boot(t);
  const view = await mount(<ConnectionList />);
  t.after(view.unmount);
  // The MySQL profile is the connected one, so an unbound script must not pick
  // up its session just because that session is active.
  assert.equal(useWorkspace.getState().activeSessionId, "s1");

  await openConnectionMenu(view, "Sample shop.db");
  await click(view, "New SQL script");

  const scriptTab = useWorkspace.getState().tabs.at(-1);
  assert.equal(scriptTab?.kind, "script");
  assert.equal(scriptTab?.sessionId, null);
});
