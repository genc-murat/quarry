import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { ReconnectPrompt } from "./ReconnectPrompt.tsx";
import { mergeSettings } from "@/lib/settings.ts";
import { installTestBackend, type TestBackend } from "@/lib/testBackend.ts";
import { click, closeDom, mount } from "@/lib/testRender.tsx";
import type { ConnectionProfile, SessionInfo } from "@/lib/types.ts";

import { useWorkspace } from "@/stores/workspace.ts";

/**
 * The prompt only decides *when* the store reconnects; the store does the work.
 * What is asserted here is that the offer is what the user sees, that declining
 * it touches nothing, and that accepting it runs exactly one reconnect.
 */

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

const session: SessionInfo = {
  id: "s1",
  profileId: "p1",
  driver: "mysql",
  name: "Local MySQL 5.6",
  server: { version: "5.6.51-log", currentUser: "root", supportsTls: false },
};

const replies = () => ({
  // A fresh session per connect, as the real backend hands out.
  connect: () => ({ session: { ...session, id: "s-fresh" } }),
  disconnect: () => undefined,
  list_databases: () => [],
  set_settings: () => undefined,
});

const pristine = useWorkspace.getState();

function cleanup(t: TestContext, backend: TestBackend) {
  t.after(() => {
    backend.restore();
    useWorkspace.setState(pristine, true);
    closeDom();
  });
}

/** An open connection whose settings were just edited. */
function withOffer() {
  useWorkspace.setState({
    drivers: [],
    profiles: [profile],
    sessions: [session],
    activeSessionId: "s1",
    rememberedProfileIds: ["p1"],
    reconnectOffer: { sessionId: "s1", name: session.name },
    settings: mergeSettings(undefined),
  });
}

test("the offer names the session and can be declined", async (t) => {
  const backend = installTestBackend(replies());
  cleanup(t, backend);
  withOffer();

  const view = await mount(<ReconnectPrompt />);
  t.after(view.unmount);

  assert.match(view.text(), /Reconnect with the new settings\?/);
  assert.match(view.text(), /Local MySQL 5\.6 is still open/);

  await click(view, "Later");

  // Declining costs nothing: no session is closed and no connection is opened.
  assert.equal(useWorkspace.getState().reconnectOffer, null);
  assert.deepEqual(backend.argsFor("connect"), []);
  assert.deepEqual(backend.argsFor("disconnect"), []);
  assert.doesNotMatch(view.text(), /Reconnect with the new settings/);
});

test("accepting it opens a fresh session and closes the stale one", async (t) => {
  const backend = installTestBackend(replies());
  cleanup(t, backend);
  withOffer();

  const view = await mount(<ReconnectPrompt />);
  t.after(view.unmount);

  await click(view, "Reconnect");

  assert.deepEqual(backend.argsFor("connect"), [{ input: { profileId: "p1" } }]);
  assert.deepEqual(backend.argsFor("disconnect"), [{ connectionId: "s1" }]);
  assert.deepEqual(
    useWorkspace.getState().sessions.map((entry) => entry.id),
    ["s-fresh"],
  );
  assert.equal(useWorkspace.getState().reconnectOffer, null);
});

test("with nothing offered the prompt renders nothing", async (t) => {
  const backend = installTestBackend(replies());
  cleanup(t, backend);

  const view = await mount(<ReconnectPrompt />);
  t.after(view.unmount);

  assert.equal(view.text().trim(), "");
});
