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

  // The password goes out with the connect; it is written to the profile only
  // after that connect has worked, so a typo cannot be stored and retried.
  assert.deepEqual(backend.argsFor("connect"), [
    { input: { profileId: "p3", password: "hunter2" } },
  ]);
  const saved = backend.argsFor("save_connection")[0]?.input as Record<string, unknown>;
  assert.equal(saved.password, "hunter2");
  assert.equal(saved.id, "p3");
  assert.equal(session?.id, "s-p3");
  assert.deepEqual(useWorkspace.getState().rememberedProfileIds, ["p3"]);
  assert.deepEqual(lastPersisted(backend)?.connections?.open, ["p3"]);
});

test("a password the user chose not to save is used for that connection only", async (t) => {
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

  const session = await useWorkspace.getState().connectProfile("p3", "hunter2", false);

  // Connected with it, but the profile is untouched: the connection is
  // remembered as open, the password is not remembered at all.
  assert.deepEqual(backend.argsFor("connect"), [
    { input: { profileId: "p3", password: "hunter2" } },
  ]);
  assert.deepEqual(backend.argsFor("save_connection"), []);
  assert.equal(session?.id, "s-p3");
  assert.equal(
    useWorkspace.getState().profiles.find((profile) => profile.id === "p3")?.hasPassword,
    false,
  );
  assert.deepEqual(useWorkspace.getState().rememberedProfileIds, ["p3"]);
});

test("a password the server rejects is not written into the profile", async (t) => {
  const backend = installTestBackend({
    ...replies([]),
    connect: () => {
      throw new Error("access denied");
    },
  });
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

  const session = await useWorkspace.getState().connectProfile("p3", "typo");

  assert.equal(session, null);
  // Nothing was stored and nothing is remembered: the profile is exactly as it
  // was, so the next attempt starts from the same place this one did.
  assert.deepEqual(backend.argsFor("save_connection"), []);
  assert.deepEqual(useWorkspace.getState().rememberedProfileIds, []);
  assert.equal(useWorkspace.getState().toasts.at(-1)?.title, "Connection failed");
});

test("a remembered profile with an unknown driver is left for a manual connect", async (t) => {
  // `redis` is not in the registry, so nothing here can say whether it needs a
  // password — it must not be assumed passwordless and attempted on every launch.
  const redisProfile: ConnectionProfile = {
    id: "p4",
    name: "Cache",
    driver: "redis",
    host: "127.0.0.1",
    port: 6379,
    username: "",
    database: null,
    sslMode: "disabled",
    options: {},
    hasPassword: true,
  };
  const backend = installTestBackend({
    ...replies(["p4", "p2"]),
    list_connections: () => [mysqlProfile, passwordlessProfile, sqliteProfile, redisProfile],
  });
  cleanup(t, backend);
  fakeWindow();

  await useWorkspace.getState().bootstrap();

  assert.deepEqual(backend.argsFor("connect"), [{ input: { profileId: "p2" } }]);
  assert.deepEqual(
    useWorkspace.getState().sessions.map((session) => session.id),
    ["s-p2"],
  );
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

test("a session with no profile keeps what it could be saved with", async (t) => {
  const backend = installTestBackend({
    ...replies([]),
    connect: () => ({
      session: {
        id: "s-raw",
        profileId: "",
        driver: "mysql",
        name: "reader@10.0.0.9",
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
    adhocConfigs: {},
    settings: mergeSettings(undefined),
  });

  const config = {
    driver: "mysql",
    host: "10.0.0.9",
    port: 3307,
    username: "reader",
    sslMode: "preferred" as const,
    options: {},
  };
  await useWorkspace.getState().connect({ config });

  // Kept per session, so the explorer can offer to save it as a connection.
  assert.deepEqual(useWorkspace.getState().adhocConfigs["s-raw"], config);

  await useWorkspace.getState().disconnect("s-raw");

  assert.deepEqual(useWorkspace.getState().adhocConfigs, {});
});

/** A workspace with one open session that was opened from a config. */
function withAdhocSession() {
  useWorkspace.setState({
    drivers: [mysqlDriver, sqliteDriver],
    profiles: [mysqlProfile, sqliteProfile],
    sessions: [
      {
        id: "s-raw",
        profileId: "",
        driver: "mysql",
        name: "reader@10.0.0.9",
        server: { supportsTls: false },
      } satisfies SessionInfo,
    ],
    activeSessionId: "s-raw",
    rememberedProfileIds: [],
    adhocConfigs: {
      "s-raw": {
        driver: "mysql",
        host: "10.0.0.9",
        port: 3307,
        username: "reader",
        sslMode: "preferred",
        options: {},
      },
    },
    settings: mergeSettings(undefined),
  });
}

test("saving a session as a connection points that session at it", async (t) => {
  const backend = installTestBackend({ ...replies([]), set_session_profile: () => undefined });
  cleanup(t, backend);
  fakeWindow();
  withAdhocSession();

  await useWorkspace.getState().bindSessionToProfile("s-raw", "p-new");

  // Recorded on both sides: the backend keeps it across a reload, the store so
  // the explorer and the remembered list follow immediately.
  assert.deepEqual(backend.argsFor("set_session_profile"), [
    { connectionId: "s-raw", profileId: "p-new" },
  ]);
  assert.equal(useWorkspace.getState().sessions[0]?.profileId, "p-new");
  assert.deepEqual(useWorkspace.getState().rememberedProfileIds, ["p-new"]);
  assert.deepEqual(useWorkspace.getState().adhocConfigs, {});
  assert.deepEqual(lastPersisted(backend)?.connections?.open, ["p-new"]);
});

test("a backend that cannot record it still leaves the session saved", async (t) => {
  const backend = installTestBackend({
    ...replies([]),
    set_session_profile: () => {
      throw new Error("no such session");
    },
  });
  cleanup(t, backend);
  fakeWindow();
  withAdhocSession();

  await useWorkspace.getState().bindSessionToProfile("s-raw", "p-new");

  // What the backend failed to remember only costs a later reload, so the
  // session still becomes the saved connection here — and the user is told.
  assert.equal(useWorkspace.getState().sessions[0]?.profileId, "p-new");
  assert.deepEqual(useWorkspace.getState().rememberedProfileIds, ["p-new"]);
  assert.equal(
    useWorkspace.getState().toasts.at(-1)?.title,
    "Could not record the saved connection",
  );
});

test("binding a session that is no longer open does nothing", async (t) => {
  const backend = installTestBackend({ ...replies([]), set_session_profile: () => undefined });
  cleanup(t, backend);
  fakeWindow();
  withAdhocSession();
  useWorkspace.setState({ sessions: [] });

  await useWorkspace.getState().bindSessionToProfile("s-raw", "p-new");

  assert.deepEqual(backend.argsFor("set_session_profile"), []);
  assert.deepEqual(useWorkspace.getState().rememberedProfileIds, []);
});

/** A workspace with the MySQL profile open, as a session in the store. */
function withOpenConnection() {
  useWorkspace.setState({
    drivers: [mysqlDriver, sqliteDriver],
    profiles: [mysqlProfile, sqliteProfile],
    sessions: [sessionOf("p1")],
    activeSessionId: "s-p1",
    rememberedProfileIds: ["p1"],
    settings: mergeSettings(undefined),
  });
}

test("editing an open connection offers to reconnect the session using it", async (t) => {
  // A backend hands out a new session id for every connect, as the real one does.
  const backend = installTestBackend({
    ...replies([]),
    connect: () => ({ session: { ...sessionOf("p1"), id: "s-fresh" } }),
  });
  cleanup(t, backend);
  fakeWindow();
  withOpenConnection();

  useWorkspace.getState().offerReconnect("p1");
  assert.deepEqual(useWorkspace.getState().reconnectOffer, {
    sessionId: "s-p1",
    name: "Local MySQL 5.6",
  });

  assert.equal(await useWorkspace.getState().reconnectSession(), true);

  // A fresh session for the same profile, and the stale one is gone.
  assert.deepEqual(backend.argsFor("connect"), [{ input: { profileId: "p1" } }]);
  assert.deepEqual(backend.argsFor("disconnect"), [{ connectionId: "s-p1" }]);
  assert.deepEqual(
    useWorkspace.getState().sessions.map((session) => session.id),
    ["s-fresh"],
  );
  assert.equal(useWorkspace.getState().activeSessionId, "s-fresh");
  // The new session stands for the profile, so it is still reopened next launch.
  assert.deepEqual(useWorkspace.getState().rememberedProfileIds, ["p1"]);
  assert.deepEqual(lastPersisted(backend)?.connections?.open, ["p1"]);
  assert.equal(useWorkspace.getState().reconnectOffer, null);
});

test("a reconnect that fails leaves the working session alone", async (t) => {
  const backend = installTestBackend({
    ...replies([]),
    connect: () => {
      throw new Error("access denied");
    },
  });
  cleanup(t, backend);
  fakeWindow();
  withOpenConnection();

  useWorkspace.getState().offerReconnect("p1");

  assert.equal(await useWorkspace.getState().reconnectSession(), false);
  // The old session was never closed, so the user is not left with nothing.
  assert.deepEqual(backend.argsFor("disconnect"), []);
  assert.deepEqual(
    useWorkspace.getState().sessions.map((session) => session.id),
    ["s-p1"],
  );
  assert.deepEqual(useWorkspace.getState().rememberedProfileIds, ["p1"]);
});

test("nothing is offered for a connection that is not open", async (t) => {
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

  useWorkspace.getState().offerReconnect("p1");

  assert.equal(useWorkspace.getState().reconnectOffer, null);
  assert.equal(await useWorkspace.getState().reconnectSession(), false);
  assert.deepEqual(backend.argsFor("connect"), []);
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
