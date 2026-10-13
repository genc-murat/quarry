import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { act } from "react";

import { ConnectionDialog, type ConnectionDialogMode } from "./ConnectionDialog.tsx";
import { mergeSettings } from "@/lib/settings.ts";
import { installTestBackend, type TestBackend } from "@/lib/testBackend.ts";
import { click, closeDom, mount, type MountedComponent } from "@/lib/testRender.tsx";
import type {
  ConnectionProfile,
  DriverDescriptor,
  FieldType,
  SessionInfo,
} from "@/lib/types.ts";

import { useWorkspace } from "@/stores/workspace.ts";

/**
 * The dialog's two endings: a profile that is written to disk (the default) and
 * an ad-hoc session that is not. The second is why `connect` accepts a config
 * rather than only a profile id, so the test asserts the payload the backend
 * would actually receive.
 */

const field = (key: string, fieldType: FieldType = "text", defaultValue?: unknown) => ({
  key,
  label: key,
  fieldType,
  required: true,
  options: [],
  ...(defaultValue === undefined ? {} : { defaultValue }),
});

const mysqlDriver: DriverDescriptor = {
  id: "mysql",
  displayName: "MySQL 5.6",
  defaultPort: 3306,
  accentColor: "#4479a1",
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
  configFields: [
    field("host", "text", "127.0.0.1"),
    field("port", "text", 3306),
    field("username", "text", "root"),
    field("password", "password"),
  ],
};

/** What the backend hands back for an ad-hoc connection: no profile behind it. */
const adhocSession: SessionInfo = {
  id: "s-adhoc",
  profileId: "",
  driver: "mysql",
  name: "root@127.0.0.1",
  server: { version: "5.6.51-log", versionNumber: 50651, supportsTls: false },
};

const savedSession: SessionInfo = {
  id: "s-saved",
  profileId: "p-new",
  driver: "mysql",
  name: "root@127.0.0.1",
  server: { version: "5.6.51-log", versionNumber: 50651, supportsTls: false },
};

const replies = () => ({
  // A saved profile keeps its id, which is what the follow-up connect names.
  save_connection: (args?: Record<string, unknown>) => ({
    ...(args?.input as Record<string, unknown>),
    id: "p-new",
    hasPassword: false,
  }),
  connect: (args?: Record<string, unknown>) => ({
    session: (args?.input as { profileId?: string } | undefined)?.profileId
      ? savedSession
      : adhocSession,
  }),
  list_connections: () => [],
  list_databases: () => [],
  set_settings: () => undefined,
  disconnect: () => undefined,
});

/** The store as it stood before any test touched it. */
const pristine = useWorkspace.getState();

function cleanup(t: TestContext, backend: TestBackend) {
  t.after(() => {
    backend.restore();
    useWorkspace.setState(pristine, true);
    closeDom();
  });
}

/** A workspace with the one driver the form is generated from. */
function seed() {
  useWorkspace.setState({
    drivers: [mysqlDriver],
    profiles: [],
    sessions: [],
    tabs: [],
    activeSessionId: null,
    rememberedProfileIds: [],
    settings: mergeSettings(undefined),
  });
}

/** Type into a controlled input the way a user would. */
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
function nativeValueSetter(
  input: HTMLInputElement,
): ((this: HTMLInputElement, v: string) => void) | undefined {
  let proto: object | null = Object.getPrototypeOf(input);
  while (proto) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor?.set) return descriptor.set as (this: HTMLInputElement, v: string) => void;
    proto = Object.getPrototypeOf(proto);
  }
  return undefined;
}

async function open(t: TestContext, editing: ConnectionProfile | null = null) {
  const backend = installTestBackend(replies());
  cleanup(t, backend);
  seed();
  let closes = 0;
  // Built as the dialog's own mode, so a test cannot pass a profile to create
  // with or leave it out of an edit — the compiler rejects both.
  const opened: ConnectionDialogMode = editing
    ? { mode: "edit", editing }
    : { mode: "create" };
  const view = await mount(
    <ConnectionDialog
      open
      {...opened}
      onClose={() => {
        closes += 1;
      }}
    />,
  );
  t.after(view.unmount);
  return { backend, view, closed: () => closes };
}

/** The labels of the dialog's footer actions, in order. */
const actions = (view: MountedComponent) =>
  [...view.container.querySelectorAll("button")]
    .map((button) => button.textContent?.trim() ?? "")
    .filter((label) => ["Cancel", "Test", "Save", "Save & connect", "Connect"].includes(label));

test("by default the form saves the profile, then connects by profile id", async (t) => {
  const { backend, view, closed } = await open(t);

  assert.deepEqual(actions(view), ["Cancel", "Test", "Save", "Save & connect"]);

  await click(view, "Save & connect");

  const saved = backend.argsFor("save_connection")[0]?.input as Record<string, unknown>;
  assert.equal(saved.driver, "mysql");
  assert.equal(saved.host, "127.0.0.1");
  assert.equal(saved.username, "root");
  // A new profile with no password typed stores nothing rather than an empty one.
  assert.equal(saved.password, null);
  assert.deepEqual(backend.argsFor("connect"), [{ input: { profileId: "p-new" } }]);
  assert.equal(closed(), 1);
});

test("clearing the box opens an ad-hoc session and writes no profile", async (t) => {
  const { backend, view, closed } = await open(t);

  const box = view.container.querySelector("#conn-save") as HTMLInputElement | null;
  assert.ok(box, "no 'Save this connection' box");
  assert.equal(box.checked, true);
  await act(async () => {
    box.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(box.checked, false);
  assert.match(view.text(), /Used for this session only/);

  // The save actions are replaced by the single one that opens the server.
  assert.deepEqual(actions(view), ["Cancel", "Test", "Connect"]);

  await typeInto(view, "#field-password", "hunter2");
  await click(view, "Connect");

  assert.deepEqual(backend.argsFor("save_connection"), []);
  const input = backend.argsFor("connect")[0]?.input as {
    profileId?: string;
    config?: Record<string, unknown>;
  };
  assert.equal(input.profileId, undefined);
  assert.deepEqual(input.config, {
    driver: "mysql",
    password: "hunter2",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    database: "",
    sslMode: "preferred",
    options: {},
  });
  // The session exists; nothing about it is remembered for the next launch.
  assert.deepEqual(
    useWorkspace.getState().sessions.map((session) => session.id),
    ["s-adhoc"],
  );
  assert.deepEqual(useWorkspace.getState().rememberedProfileIds, []);
  assert.equal(closed(), 1);
});

test("a new connection can start from the values a session was opened with", async (t) => {
  const backend = installTestBackend(replies());
  cleanup(t, backend);
  seed();
  const view = await mount(
    <ConnectionDialog
      open
      mode="create"
      prefill={{
        driver: "mysql",
        name: "reader@10.0.0.9",
        host: "10.0.0.9",
        port: 3307,
        username: "reader",
        database: "shop",
        sslMode: "preferred",
        options: {},
      }}
      onClose={() => undefined}
    />,
  );
  t.after(view.unmount);

  // Still a *new* connection — the values are seeded, not edited into a profile.
  assert.match(view.text(), /New connection/);
  await click(view, "Save");

  assert.deepEqual(backend.argsFor("save_connection")[0]?.input, {
    id: null,
    name: "reader@10.0.0.9",
    driver: "mysql",
    host: "10.0.0.9",
    port: 3307,
    username: "reader",
    database: "shop",
    sslMode: "preferred",
    options: {},
    password: null,
  });
});

test("an edited connection still saves its changes when the box is left on", async (t) => {
  const { backend, view } = await open(t, {
    id: "p1",
    name: "Local MySQL 5.6",
    driver: "mysql",
    host: "10.0.0.5",
    port: 3306,
    username: "root",
    database: "shop",
    sslMode: "preferred",
    options: {},
    hasPassword: true,
  });

  await click(view, "Save");

  const saved = backend.argsFor("save_connection")[0]?.input as Record<string, unknown>;
  assert.equal(saved.id, "p1");
  assert.equal(saved.host, "10.0.0.5");
  // No password typed and none cleared, so the stored secret is left alone.
  assert.equal(saved.password, undefined);
  assert.deepEqual(backend.argsFor("connect"), []);
});
