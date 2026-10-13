import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { act } from "react";

import { ExplorerPanel } from "./ExplorerPanel.tsx";
import { resetExplorerTree } from "@/lib/explorerTree.ts";
import { mergeSettings } from "@/lib/settings.ts";
import { installTestBackend, type TestBackend } from "@/lib/testBackend.ts";
import { click, closeDom, mount, type MountedComponent } from "@/lib/testRender.tsx";
import type {
  ConnectionProfile,
  DatabaseInfo,
  DriverDescriptor,
  SessionInfo,
} from "@/lib/types.ts";

import { useWorkspace } from "@/stores/workspace.ts";

const configField = (key: string, fieldType: "text" | "password" = "text") => ({
  key,
  label: key,
  fieldType,
  required: true,
  options: [],
});

const driver = (
  id: string,
  displayName: string,
  accentColor: string,
  configKeys: string[] = [],
): DriverDescriptor => ({
  id,
  displayName,
  defaultPort: 5432,
  accentColor,
  capabilities: {
    queryLanguage: "sql",
    resultShape: "tabular",
    isRelational: true,
    supportsMultipleDatabases: true,
    supportsSchemas: true,
    supportsTransactions: true,
    supportsDdl: true,
    supportsExplain: true,
    supportsCancel: true,
    objectKinds: ["table"],
    supportedActions: [],
  },
  configFields: configKeys.map((key) => configField(key, key === "password" ? "password" : "text")),
});

// A server driver asks for a password; the file-backed one never does, which is
// what decides whether a connection can be reopened without asking the user.
const mysqlDriver = driver("mysql", "MySQL 5.6", "#4479a1", ["host", "port", "username", "password"]);
const postgresDriver = driver("postgres", "PostgreSQL", "#336791", [
  "host",
  "port",
  "username",
  "password",
]);
const sqliteDriver = driver("sqlite", "SQLite", "#003b57", ["path"]);

const mysqlSession: SessionInfo = {
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

const postgresSession: SessionInfo = {
  id: "s2",
  profileId: "p2",
  driver: "postgres",
  name: "Local PostgreSQL 16",
  server: {
    version: "16.2",
    versionNumber: 160002,
    currentDatabase: "analytics",
    currentUser: "postgres",
    supportsTls: false,
  },
};

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

const postgresProfile: ConnectionProfile = {
  id: "p2",
  name: "Local PostgreSQL 16",
  driver: "postgres",
  host: "127.0.0.1",
  port: 5432,
  username: "postgres",
  database: "analytics",
  sslMode: "preferred",
  options: {},
  hasPassword: true,
};

/** A saved server whose password was never stored. */
const passwordlessProfile: ConnectionProfile = {
  id: "p3",
  name: "Reporting server",
  driver: "mysql",
  host: "10.0.0.9",
  port: 3306,
  username: "reader",
  database: null,
  sslMode: "preferred",
  options: {},
  hasPassword: false,
};

/** A session opened from a config rather than a profile: nothing to reopen. */
const adhocSession: SessionInfo = {
  id: "s3",
  profileId: "",
  driver: "mysql",
  name: "reader@10.0.0.9",
  server: {
    version: "5.6.51-log",
    currentUser: "reader",
    currentDatabase: "shop",
    supportsTls: false,
  },
};

/** The profile the dialog writes when the ad-hoc session above is saved. */
const savedAdhocProfile: ConnectionProfile = {
  id: "p-new",
  name: "reader@10.0.0.9",
  driver: "mysql",
  host: "10.0.0.9",
  port: 3307,
  username: "reader",
  database: "shop",
  sslMode: "preferred",
  options: {},
  hasPassword: false,
};

const shopDatabase: DatabaseInfo = { name: "shop", isSystem: false };
const analyticsDatabase: DatabaseInfo = { name: "analytics", isSystem: false };

/** What the backend hands back for a reconnected profile. */
const sessionFor = (profileId: string): SessionInfo => {
  if (profileId === "p2") return postgresSession;
  if (profileId === "p3") {
    return {
      id: "s3",
      profileId,
      driver: "mysql",
      name: "Reporting server",
      server: { version: "5.6.51-log", currentUser: "reader", supportsTls: false },
    };
  }
  return mysqlSession;
};

/** `list_databases` answers per connection, which is what proves the tree asks
 *  the right session — and asks every open one. */
const replies = () => ({
  list_databases: (args?: Record<string, unknown>) =>
    args?.connectionId === "s2" ? [analyticsDatabase] : [shopDatabase],
  list_namespaces: (args?: Record<string, unknown>) =>
    args?.database === "analytics" ? [{ name: "public" }] : [],
  list_objects: () => [{ name: "orders", kind: "table", schema: null }],
  disconnect: () => undefined,
  connect: (args?: Record<string, unknown>) => {
    const profileId = String((args?.input as { profileId?: string } | undefined)?.profileId);
    return { session: sessionFor(profileId) };
  },
  save_connection: (args?: Record<string, unknown>) => ({
    ...passwordlessProfile,
    ...(args?.input as Partial<ConnectionProfile>),
    hasPassword: true,
  }),
  // Saving a password re-reads the profile list, so the stored password is what
  // the next launch sees.
  list_connections: () => [mysqlProfile, postgresProfile, passwordlessProfile],
  set_settings: () => undefined,
});

/** The store as it stood before any test touched it. */
const pristine = useWorkspace.getState();

/** Two servers open at once: the case a single-session explorer got wrong. */
function twoConnections() {
  useWorkspace.setState({
    drivers: [mysqlDriver, postgresDriver, sqliteDriver],
    profiles: [mysqlProfile, postgresProfile, passwordlessProfile],
    sessions: [mysqlSession, postgresSession],
    activeSessionId: "s1",
    databasesBySession: {},
    rememberedProfileIds: [],
  });
}

function cleanup(t: TestContext, backend: TestBackend) {
  t.after(() => {
    backend.restore();
    useWorkspace.setState(pristine, true);
    resetExplorerTree();
    closeDom();
  });
}

/**
 * Mount and let the panel's first reads land, all inside one `act` — mounting
 * outside it would let the connections' database reads resolve after the act
 * boundary.
 */
async function mounted(): Promise<MountedComponent> {
  let view!: MountedComponent;
  await act(async () => {
    view = await mount(<ExplorerPanel />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return view;
}

async function open(t: TestContext): Promise<{ backend: TestBackend; view: MountedComponent }> {
  const backend = installTestBackend(replies());
  cleanup(t, backend);
  twoConnections();
  const view = await mounted();
  t.after(view.unmount);
  return { backend, view };
}

/** Click a button addressed by its `aria-label`, which has no text to match. */
async function clickLabelled(view: MountedComponent, label: string) {
  const button = view.container.querySelector(`button[aria-label="${label}"]`);
  assert.ok(button, `no button labelled "${label}"`);
  await act(async () => {
    (button as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The connection root rows, in the order the explorer renders them. */
const roots = (view: MountedComponent) =>
  [...view.container.querySelectorAll("button[aria-expanded]")] as HTMLButtonElement[];

/**
 * Type into a controlled input the way a user would: set the value through the
 * element's own setter, then dispatch the `input` event React listens for.
 */
async function typeInto(view: MountedComponent, selector: string, value: string) {
  const input = view.container.querySelector(selector) as HTMLInputElement | null;
  assert.ok(input, `no input matching ${selector}`);
  await act(async () => {
    nativeValueSetter(input)?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/**
 * The element's own `value` setter. The global constructor cannot be used to
 * find it: `testRender` binds jsdom's constructors, and a bound function has no
 * `prototype` to read the descriptor from.
 */
function nativeValueSetter(input: HTMLInputElement): ((this: HTMLInputElement, v: string) => void) | undefined {
  let proto: object | null = Object.getPrototypeOf(input);
  while (proto) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor?.set) return descriptor.set as (this: HTMLInputElement, v: string) => void;
    proto = Object.getPrototypeOf(proto);
  }
  return undefined;
}

test("every open connection is a root node with its own databases", async (t) => {
  const { backend, view } = await open(t);

  // Both connections are browsable at once, not only the active session.
  assert.match(view.text(), /Local MySQL 5\.6/);
  assert.match(view.text(), /Local PostgreSQL 16/);
  assert.match(view.text(), /shop/);
  assert.match(view.text(), /analytics/);
  assert.match(view.text(), /2 connections/);

  // Each root asked its own session for its database list, and both were read
  // even though only the MySQL session is active.
  assert.deepEqual(backend.argsFor("list_databases"), [
    { connectionId: "s1" },
    { connectionId: "s2" },
  ]);
});

test("only the active connection is marked, and the others can be made active", async (t) => {
  const { view } = await open(t);

  // Exactly one root is expanded-and-marked: the active session's.
  assert.equal(roots(view).length, 2);
  assert.equal(
    view.container.querySelectorAll('button[aria-label="Make Local PostgreSQL 16 the active connection"]')
      .length,
    1,
  );
  assert.equal(
    view.container.querySelectorAll('button[aria-label="Make Local MySQL 5.6 the active connection"]')
      .length,
    0,
  );

  await clickLabelled(view, "Make Local PostgreSQL 16 the active connection");

  assert.equal(useWorkspace.getState().activeSessionId, "s2");
  // The marker follows the active connection rather than staying put.
  assert.equal(
    view.container.querySelectorAll('button[aria-label="Make Local MySQL 5.6 the active connection"]')
      .length,
    1,
  );
});

test("collapsing one connection leaves the other's tree alone", async (t) => {
  const { view } = await open(t);

  const [mysqlRoot, postgresRoot] = roots(view);
  await act(async () => {
    mysqlRoot.click();
  });

  assert.equal(mysqlRoot.getAttribute("aria-expanded"), "false");
  assert.equal(postgresRoot.getAttribute("aria-expanded"), "true");
  assert.doesNotMatch(view.text(), /shop/);
  assert.match(view.text(), /analytics/);
});

test("a node under the second connection reads through that connection", async (t) => {
  const { backend, view } = await open(t);

  await click(view, "analytics");
  assert.deepEqual(backend.argsFor("list_namespaces"), [
    { connectionId: "s2", database: "analytics" },
  ]);

  // PostgreSQL has a schema layer, so the objects sit under it — and the read
  // must carry the second session's id, never the active one's.
  await click(view, "public");
  assert.deepEqual(backend.argsFor("list_objects"), [
    { connectionId: "s2", database: "analytics", namespace: "public" },
  ]);
  assert.match(view.text(), /orders/);

  // Expanding the other connection's schema-less database reads through it too.
  await click(view, "shop");
  assert.deepEqual(backend.argsFor("list_objects").at(-1), {
    connectionId: "s1",
    database: "shop",
    namespace: null,
  });
});

test("the refresh button on a root re-reads only that connection", async (t) => {
  const { backend, view } = await open(t);

  await clickLabelled(view, "Refresh Local PostgreSQL 16");

  // The boot read both; refreshing one server adds a read for that server only.
  assert.deepEqual(backend.argsFor("list_databases"), [
    { connectionId: "s1" },
    { connectionId: "s2" },
    { connectionId: "s2" },
  ]);
});

test("the toolbar refresh re-reads every connection", async (t) => {
  const { backend, view } = await open(t);

  await clickLabelled(view, "Refresh all connections");

  assert.deepEqual(backend.argsFor("list_databases"), [
    { connectionId: "s1" },
    { connectionId: "s2" },
    { connectionId: "s1" },
    { connectionId: "s2" },
  ]);
});

test("a session with no profile behind it can be saved as a connection", async (t) => {
  const backend = installTestBackend({
    ...replies(),
    save_connection: () => savedAdhocProfile,
    list_connections: () => [
      mysqlProfile,
      postgresProfile,
      passwordlessProfile,
      savedAdhocProfile,
    ],
    set_session_profile: () => undefined,
  });
  cleanup(t, backend);
  useWorkspace.setState({
    drivers: [mysqlDriver, postgresDriver, sqliteDriver],
    profiles: [mysqlProfile, postgresProfile, passwordlessProfile],
    sessions: [adhocSession],
    activeSessionId: "s3",
    databasesBySession: {},
    rememberedProfileIds: [],
    // What the session was opened with; the connection dialog starts from it.
    adhocConfigs: {
      s3: {
        driver: "mysql",
        host: "10.0.0.9",
        port: 3307,
        username: "reader",
        sslMode: "preferred",
        options: {},
      },
    },
  });
  const view = await mounted();
  t.after(view.unmount);

  const root = roots(view).find((candidate) =>
    candidate.textContent?.includes("reader@10.0.0.9"),
  );
  assert.ok(root, "no root for the ad-hoc session");
  await act(async () => {
    root.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 40 }));
  });

  assert.match(view.text(), /Save this connection/);
  await click(view, "Save this connection…");

  // A new connection, prefilled with the host and port the session used — values
  // the session itself does not carry.
  assert.match(view.text(), /New connection/);
  const host = view.container.querySelector("#field-host") as HTMLInputElement | null;
  const port = view.container.querySelector("#field-port") as HTMLInputElement | null;
  assert.equal(host?.value, "10.0.0.9");
  assert.equal(port?.value, "3307");
  assert.deepEqual(backend.argsFor("save_connection"), []);

  await click(view, "Save");

  // Writing the profile is only half of it: the session that was open becomes
  // that connection, so it is not offered for saving again and the next launch
  // brings it back.
  assert.deepEqual(backend.argsFor("set_session_profile"), [
    { connectionId: "s3", profileId: "p-new" },
  ]);
  assert.equal(
    useWorkspace.getState().sessions.find((session) => session.id === "s3")?.profileId,
    "p-new",
  );
  assert.deepEqual(useWorkspace.getState().rememberedProfileIds, ["p-new"]);
  assert.deepEqual(useWorkspace.getState().adhocConfigs, {});
});

test("a session that came from a profile offers editing it instead", async (t) => {
  const { view } = await open(t);

  const mysqlRoot = roots(view).find((root) => root.textContent?.includes("Local MySQL 5.6"));
  assert.ok(mysqlRoot, "no root for the MySQL session");
  await act(async () => {
    mysqlRoot.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 40 }));
  });

  assert.match(view.text(), /Disconnect/);
  // It already is a connection, so there is nothing to save — only to change.
  assert.doesNotMatch(view.text(), /Save this connection/);
  await click(view, "Edit connection…");

  assert.match(view.text(), /Edit connection/);
  const host = view.container.querySelector("#field-host") as HTMLInputElement | null;
  assert.equal(host?.value, "127.0.0.1");
});

test("a connection's own menu closes just that connection", async (t) => {
  const { backend, view } = await open(t);

  const postgresRoot = roots(view).find((root) => root.textContent?.includes("Local PostgreSQL 16"));
  assert.ok(postgresRoot, "no root for the PostgreSQL session");
  await act(async () => {
    postgresRoot.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 40 }),
    );
  });

  assert.match(view.text(), /Disconnect/);
  await click(view, "Disconnect");

  assert.deepEqual(backend.argsFor("disconnect"), [{ connectionId: "s2" }]);
  assert.doesNotMatch(view.text(), /Local PostgreSQL 16/);
  // The other server keeps its tree, and closing one costs no extra read.
  assert.match(view.text(), /Local MySQL 5\.6/);
  assert.match(view.text(), /shop/);
  assert.deepEqual(backend.argsFor("list_databases"), [
    { connectionId: "s1" },
    { connectionId: "s2" },
  ]);
});

/** The dimmed roots the explorer offers for connections it remembers. */
function pendingRoot(view: MountedComponent, name: string) {
  return view.container.querySelector(`button[aria-label="Connect to ${name}"]`);
}

/**
 * Assert that no dimmed root is offered for `name`. Written as a boolean rather
 * than `assert.equal(node, null)`: on failure the latter hands a DOM node to
 * node's `inspect`, which walks it and takes the whole test run down with it
 * instead of reporting one failing test.
 */
function assertNoPendingRoot(view: MountedComponent, name: string, why: string) {
  assert.ok(pendingRoot(view, name) === null, `${name} was offered as a remembered root ${why}`);
}

/** A workspace where one remembered server is closed, with or without a password. */
function oneClosedConnection(profile: ConnectionProfile, open = false) {
  useWorkspace.setState({
    drivers: [mysqlDriver, postgresDriver, sqliteDriver],
    profiles: [mysqlProfile, postgresProfile, passwordlessProfile],
    sessions: open ? [mysqlSession] : [],
    activeSessionId: open ? "s1" : null,
    databasesBySession: {},
    rememberedProfileIds: ["p1", profile.id],
  });
}

test("a remembered connection that is not open is offered, and one click reopens it", async (t) => {
  const backend = installTestBackend(replies());
  cleanup(t, backend);
  oneClosedConnection(postgresProfile, true);
  const view = await mounted();
  t.after(view.unmount);

  assert.ok(pendingRoot(view, "Local PostgreSQL 16"), "the closed connection is not offered");
  assert.match(view.text(), /was open/);
  // The one already open is a normal root, not offered a second time.
  assertNoPendingRoot(view, "Local MySQL 5.6", "because it is already open");
  assert.equal(roots(view).length, 1);

  await clickLabelled(view, "Connect to Local PostgreSQL 16");

  assert.deepEqual(backend.argsFor("connect"), [{ input: { profileId: "p2" } }]);
  // It turned into the root it would have been: expanded, with its databases.
  assert.equal(pendingRoot(view, "Local PostgreSQL 16"), null);
  assert.equal(roots(view).length, 2);
  assert.match(view.text(), /analytics/);
});

test("a remembered server without a stored password asks for it, then stores it", async (t) => {
  const backend = installTestBackend(replies());
  cleanup(t, backend);
  oneClosedConnection(passwordlessProfile);
  const view = await mounted();
  t.after(view.unmount);

  // Nothing is open, so the panel shows the remembered server instead of the
  // "connect to a server" placeholder.
  assert.match(view.text(), /Reporting server/);
  assert.doesNotMatch(view.text(), /Connect to a server to browse/);

  await clickLabelled(view, "Connect to Reporting server");
  assert.match(view.text(), /Password/);

  await typeInto(view, "#connect-password", "hunter2");
  await click(view, "Connect");

  // The typed password goes out with the connect itself; it is stored with the
  // profile only after that connect has worked — what the user typed must not be
  // written down and retried on every launch if it was a typo.
  assert.deepEqual(backend.argsFor("connect"), [
    { input: { profileId: "p3", password: "hunter2" } },
  ]);
  const saved = backend.argsFor("save_connection")[0]?.input as Record<string, unknown>;
  assert.equal(saved.password, "hunter2");
  assert.equal(saved.id, "p3");
  const commands = backend.sent.map((entry) => entry.command);
  assert.ok(
    commands.indexOf("connect") < commands.indexOf("save_connection"),
    "the password was stored before the connect was known to work",
  );
  assert.equal(useWorkspace.getState().rememberedProfileIds.includes("p3"), true);
  assertNoPendingRoot(view, "Reporting server", "after connecting to it");
});

test("a password can be used for one connection without being stored", async (t) => {
  const backend = installTestBackend(replies());
  cleanup(t, backend);
  oneClosedConnection(passwordlessProfile);
  const view = await mounted();
  t.after(view.unmount);

  await clickLabelled(view, "Connect to Reporting server");
  await typeInto(view, "#connect-password", "hunter2");

  const remember = view.container.querySelector("#connect-remember") as HTMLInputElement | null;
  assert.ok(remember, "no 'Save with this connection' box in the prompt");
  assert.equal(remember.checked, true);
  await act(async () => {
    remember.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(remember.checked, false);
  assert.match(view.text(), /Used for this connection only/);

  await click(view, "Connect");

  // The password still goes out with the connect, but the profile is left
  // exactly as it was — the next launch asks for it again rather than reopening
  // the server with a password the user did not want written down.
  assert.deepEqual(backend.argsFor("connect"), [
    { input: { profileId: "p3", password: "hunter2" } },
  ]);
  assert.deepEqual(backend.argsFor("save_connection"), []);
  assert.equal(
    useWorkspace.getState().profiles.find((profile) => profile.id === "p3")?.hasPassword,
    false,
  );
  assertNoPendingRoot(view, "Reporting server", "after connecting to it");
});

test("forgetting a remembered connection stops offering it", async (t) => {
  const backend = installTestBackend(replies());
  cleanup(t, backend);
  oneClosedConnection(passwordlessProfile);
  const view = await mounted();
  t.after(view.unmount);

  const root = pendingRoot(view, "Reporting server");
  assert.ok(root);
  await act(async () => {
    root.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 30, clientY: 30 }));
  });
  assert.match(view.text(), /Forget/);
  await click(view, "Forget");

  assertNoPendingRoot(view, "Reporting server", "after forgetting it");
  // Forgetting is persistent: the stored list no longer carries the profile.
  const written = backend.argsFor("set_settings").at(-1)?.value as {
    connections: { open: string[] };
  };
  assert.deepEqual(written.connections.open, ["p1"]);
});

test("'Reconnect on launch' off hides the remembered roots as well", async (t) => {
  const backend = installTestBackend(replies());
  cleanup(t, backend);
  oneClosedConnection(postgresProfile, true);
  // Off means no part of the last session is offered — not reopening it and not
  // drawing it as a dimmed root either.
  useWorkspace.setState({
    settings: mergeSettings({ general: { reconnectOnLaunch: false } }),
  });
  const view = await mounted();
  t.after(view.unmount);

  assertNoPendingRoot(view, "Local PostgreSQL 16", "with 'Reconnect on launch' off");
  assert.doesNotMatch(view.text(), /was open/);
  // The connection that is actually open is unaffected.
  assert.equal(roots(view).length, 1);
});

test("coming back to the window re-reads only the active connection", async (t) => {
  const backend = installTestBackend(replies());
  cleanup(t, backend);
  twoConnections();
  const view = await mounted();
  t.after(view.unmount);

  // Both roots read their database list once when they mount.
  assert.deepEqual(backend.argsFor("list_databases"), [
    { connectionId: "s1" },
    { connectionId: "s2" },
  ]);

  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  // Only the connection the user is looking at is re-read: the refresh must not
  // fan out to every open server on each focus.
  assert.deepEqual(backend.argsFor("list_databases"), [
    { connectionId: "s1" },
    { connectionId: "s2" },
    { connectionId: "s1" },
  ]);
});

test("with nothing connected the panel still asks for a connection", async (t) => {
  const backend = installTestBackend(replies());
  cleanup(t, backend);
  useWorkspace.setState({
    drivers: [mysqlDriver, postgresDriver],
    sessions: [],
    activeSessionId: null,
    databasesBySession: {},
  });

  const view = await mount(<ExplorerPanel />);
  t.after(view.unmount);

  assert.match(view.text(), /Connect to a server to browse its schemas and tables\./);
  assert.deepEqual(backend.argsFor("list_databases"), []);
});
