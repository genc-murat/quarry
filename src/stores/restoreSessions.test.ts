import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { installTestBackend, type TestBackend } from "@/lib/testBackend.ts";
import { mergeSettings } from "@/lib/settings.ts";
import type {
  ConnectionProfile,
  DatabaseInfo,
  DriverDescriptor,
  FieldType,
  SessionInfo,
} from "@/lib/types.ts";

import { useWorkspace } from "./workspace.ts";

/**
 * A launch is not one call: `bootstrap` reads what was persisted, reopens the
 * connections it finds there, and only then creates the first tab. These tests
 * script that whole sequence so "reopened" means "the same connect calls a
 * user's click would have made", not just a flag in the store.
 */

const field = (key: string, fieldType: FieldType = "text") => ({
  key,
  label: key,
  fieldType,
  required: true,
  options: [],
});

const driver = (
  id: string,
  displayName: string,
  configFields: ReturnType<typeof field>[],
): DriverDescriptor => ({
  id,
  displayName,
  defaultPort: 5432,
  accentColor: "#000000",
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
  configFields,
});

const mysqlDriver = driver("mysql", "MySQL 5.6", [
  field("host"),
  field("username"),
  field("password", "password"),
]);
// A file-backed engine asks for a path and nothing else, so it never needs a
// stored password to be reopened.
const sqliteDriver = driver("sqlite", "SQLite", [field("path")]);

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

/** A server profile the user never saved a password for. */
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

const shopDatabase: DatabaseInfo = { name: "shop", isSystem: false };

const sessionOf = (profileId: string): SessionInfo => {
  const profile = [mysqlProfile, passwordlessProfile, sqliteProfile].find(
    (candidate) => candidate.id === profileId,
  );
  return {
    id: `s-${profileId}`,
    profileId,
    driver: profile?.driver ?? "mysql",
    name: profile?.name ?? profileId,
    server: { version: "1.0", currentUser: "root", supportsTls: false },
  };
};

/** A fake backend for a launch that had `open` connections last time. */
function replies(open: string[], settings?: unknown) {
  return {
    list_drivers: () => [mysqlDriver, sqliteDriver],
    list_connections: () => [mysqlProfile, passwordlessProfile, sqliteProfile],
    list_sessions: () => [],
    list_snippets: () => [],
    get_settings: () => ({ connections: { open }, settings }),
    connect: (args?: Record<string, unknown>) => {
      const profileId = String((args?.input as { profileId?: string } | undefined)?.profileId);
      return { session: sessionOf(profileId) };
    },
    list_databases: () => [shopDatabase],
    save_connection: (args?: Record<string, unknown>) => ({
      ...passwordlessProfile,
      ...(args?.input as Partial<ConnectionProfile>),
      hasPassword: true,
    }),
    set_settings: () => undefined,
    disconnect: () => undefined,
  };
}

/**
 * A `window` just wide enough for the toast timer, unref'd so a scheduled
 * dismissal cannot keep the test process alive.
 */
function fakeWindow() {
  Object.defineProperty(globalThis, "window", {
    value: {
      setTimeout: (handler: () => void, ms: number) => {
        const timer = setTimeout(handler, ms);
        timer.unref();
        return timer;
      },
    },
    configurable: true,
    writable: true,
  });
}

/** The store as it stood before any test touched it. */
const pristine = useWorkspace.getState();

function cleanup(t: TestContext, backend: TestBackend) {
  t.after(() => {
    backend.restore();
    useWorkspace.setState(pristine, true);
    Reflect.deleteProperty(globalThis, "window");
  });
}

/**
 * What the last save wrote, as the object the backend would have stored:
 * `set_settings` takes the blob under `value`.
 */
function lastPersisted(backend: TestBackend) {
  return backend.argsFor("set_settings").at(-1)?.value as
    | { connections?: { open?: string[] }; settings?: unknown }
    | undefined;
}

test("a launch reopens the connections that were open last time", async (t) => {
  const backend = installTestBackend(replies(["p1", "p2"]));
  cleanup(t, backend);
  fakeWindow();

  await useWorkspace.getState().bootstrap();

  const state = useWorkspace.getState();
  assert.deepEqual(backend.argsFor("connect"), [
    { input: { profileId: "p1" } },
    { input: { profileId: "p2" } },
  ]);
  assert.deepEqual(
    state.sessions.map((session) => session.id),
    ["s-p1", "s-p2"],
  );
  // Each reopened server has its database list already, so the explorer has a
  // root to draw the moment it mounts — and no read is repeated for the active.
  assert.deepEqual(backend.argsFor("list_databases"), [
    { connectionId: "s-p1" },
    { connectionId: "s-p2" },
  ]);
  assert.equal(state.activeSessionId, "s-p1");
  // The first tab was created after the restore, so it lands on a live session.
  assert.equal(state.tabs.at(-1)?.sessionId, "s-p1");
  assert.equal(state.toasts.at(-1)?.title, "Reconnected to 2 servers");
  assert.equal(state.toasts.at(-1)?.description, "Local MySQL 5.6, Sample shop.db");
});

test("a server whose password was never saved is left for a manual connect", async (t) => {
  const backend = installTestBackend(replies(["p3", "p2"]));
  cleanup(t, backend);
  fakeWindow();

  await useWorkspace.getState().bootstrap();

  // The MySQL profile would fail (or silently connect with no password), so the
  // launch only brings back the file-backed one.
  assert.deepEqual(backend.argsFor("connect"), [{ input: { profileId: "p2" } }]);
  assert.deepEqual(
    useWorkspace.getState().sessions.map((session) => session.id),
    ["s-p2"],
  );
  assert.equal(useWorkspace.getState().toasts.at(-1)?.title, "Reconnected to Sample shop.db");
});

test("a remembered profile that no longer exists is skipped", async (t) => {
  const backend = installTestBackend(replies(["deleted", "p1"]));
  cleanup(t, backend);
  fakeWindow();

  await useWorkspace.getState().bootstrap();

  assert.deepEqual(backend.argsFor("connect"), [{ input: { profileId: "p1" } }]);
  assert.deepEqual(
    useWorkspace.getState().sessions.map((session) => session.id),
    ["s-p1"],
  );
});

test("switching 'Reconnect on launch' off leaves every connection closed", async (t) => {
  const backend = installTestBackend(
    replies(["p1", "p2"], { general: { reconnectOnLaunch: false } }),
  );
  cleanup(t, backend);
  fakeWindow();

  await useWorkspace.getState().bootstrap();

  assert.deepEqual(backend.argsFor("connect"), []);
  assert.deepEqual(useWorkspace.getState().sessions, []);
  assert.equal(useWorkspace.getState().activeSessionId, null);
  // Nothing was restored, so nothing claims it either.
  assert.equal(useWorkspace.getState().tabs.at(-1)?.sessionId, null);
});

test("a server that is already open is not connected a second time", async (t) => {
  const backend = installTestBackend({
    ...replies(["p1", "p2"]),
    // The backend still had one of them open (a reload, not a fresh process).
    list_sessions: () => [sessionOf("p1")],
  });
  cleanup(t, backend);
  fakeWindow();

  await useWorkspace.getState().bootstrap();

  assert.deepEqual(backend.argsFor("connect"), [{ input: { profileId: "p2" } }]);
  assert.deepEqual(
    useWorkspace.getState().sessions.map((session) => session.id),
    ["s-p1", "s-p2"],
  );
});

test("connecting remembers a profile and disconnecting forgets it", async (t) => {
  const backend = installTestBackend(replies([]));
  cleanup(t, backend);
  fakeWindow();
  useWorkspace.setState({
    drivers: [mysqlDriver, sqliteDriver],
    profiles: [mysqlProfile, sqliteProfile],
    sessions: [],
    activeSessionId: null,
    rememberedProfileIds: [],
    settings: mergeSettings(undefined),
  });

  await useWorkspace.getState().connect({ profileId: "p2" });
  assert.deepEqual(lastPersisted(backend)?.connections?.open, ["p2"]);

  await useWorkspace.getState().disconnect("s-p2");
  assert.deepEqual(lastPersisted(backend)?.connections?.open, []);
});

test("a password typed in the explorer is stored with the profile", async (t) => {
  const backend = installTestBackend(replies([]));
  cleanup(t, backend);
  fakeWindow();
  useWorkspace.setState({
    drivers: [mysqlDriver, sqliteDriver],
    profiles: [passwordlessProfile, sqliteProfile],
    sessions: [],
    activeSessionId: null,
    rememberedProfileIds: [],
    settings: mergeSettings(undefined),
  });

  const session = await useWorkspace.getState().connectProfile("p3", "hunter2");

  // Saved first (so the next launch can reopen it), then connected.
  const saved = backend.argsFor("save_connection")[0]?.input as Record<string, unknown>;
  assert.equal(saved.password, "hunter2");
  assert.equal(saved.id, "p3");
  assert.deepEqual(backend.argsFor("connect"), [{ input: { profileId: "p3" } }]);
  assert.equal(session?.id, "s-p3");
  assert.deepEqual(useWorkspace.getState().rememberedProfileIds, ["p3"]);
  assert.deepEqual(lastPersisted(backend)?.connections?.open, ["p3"]);
});

test("forgetting a connection clears it from the saved list", async (t) => {
  const backend = installTestBackend(replies([]));
  cleanup(t, backend);
  fakeWindow();
  useWorkspace.setState({
    drivers: [mysqlDriver, sqliteDriver],
    profiles: [mysqlProfile, sqliteProfile],
    sessions: [],
    activeSessionId: null,
    rememberedProfileIds: ["p1", "p2"],
    settings: mergeSettings(undefined),
  });

  useWorkspace.getState().forgetProfile("p1");

  assert.deepEqual(useWorkspace.getState().rememberedProfileIds, ["p2"]);
  assert.deepEqual(lastPersisted(backend)?.connections?.open, ["p2"]);
});

test("a session opened without a profile is not remembered", async (t) => {
  const backend = installTestBackend({
    ...replies([]),
    connect: () => ({
      session: {
        id: "s-raw",
        profileId: "",
        driver: "mysql",
        name: "adhoc",
        server: { supportsTls: false },
      } satisfies SessionInfo,
    }),
  });
  cleanup(t, backend);
  fakeWindow();
  useWorkspace.setState({
    drivers: [mysqlDriver, sqliteDriver],
    profiles: [mysqlProfile, sqliteProfile],
    sessions: [],
    activeSessionId: null,
    rememberedProfileIds: [],
    settings: mergeSettings(undefined),
  });

  await useWorkspace.getState().connect({
    config: {
      driver: "mysql",
      host: "127.0.0.1",
      port: 3306,
      username: "root",
      sslMode: "preferred",
      options: {},
    },
  });

  // Nothing to reopen next launch: there is no profile behind this session.
  assert.deepEqual(useWorkspace.getState().rememberedProfileIds, []);
  assert.deepEqual(lastPersisted(backend)?.connections?.open, []);
});

test("a failed restore is reported once, without the successful ones", async (t) => {
  const backend = installTestBackend({
    ...replies(["p2", "p1"]),
    connect: (args?: Record<string, unknown>) => {
      const profileId = String((args?.input as { profileId?: string } | undefined)?.profileId);
      if (profileId === "p1") throw new Error("connection refused");
      return { session: sessionOf(profileId) };
    },
  });
  cleanup(t, backend);
  fakeWindow();

  await useWorkspace.getState().bootstrap();

  const state = useWorkspace.getState();
  assert.deepEqual(
    state.sessions.map((session) => session.id),
    ["s-p2"],
  );
  const toasts = state.toasts.map((toast) => toast.title);
  assert.deepEqual(toasts, ["Reconnected to Sample shop.db", "Could not restore a connection"]);
  assert.match(String(state.toasts.at(-1)?.description), /Local MySQL 5\.6 \(connection refused\)/);
});
