import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { installTestBackend, type TestBackend } from "@/lib/testBackend.ts";

import { useWorkspace } from "./workspace.ts";

/**
 * Fake the desktop shell for one test: `window.__TAURI_INTERNALS__.invoke`
 * answers the native save dialog, and the toast timer is unref'd so a scheduled
 * dismissal cannot keep the test process alive. Returns the commands the webview
 * sent, in order.
 */
function fakeShell(dialogAnswer: string | null) {
  const sent: { command: string; args?: Record<string, unknown> }[] = [];
  Object.defineProperty(globalThis, "window", {
    value: {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args?: Record<string, unknown>) => {
          sent.push({ command, args });
          return dialogAnswer;
        },
      },
      setTimeout: (handler: () => void, ms: number) => {
        const timer = setTimeout(handler, ms);
        timer.unref();
        return timer;
      },
    },
    configurable: true,
    writable: true,
  });
  return sent;
}

/** The store as it stood before any test touched it. */
const pristine = useWorkspace.getState();

/** Hand the backend, the store and `window` back once the test finishes. */
function cleanup(t: TestContext, backend?: TestBackend) {
  t.after(() => {
    backend?.restore();
    useWorkspace.setState(pristine, true);
    Reflect.deleteProperty(globalThis, "window");
  });
}

test("a cancelled picker leaves an untitled script the user can still type into", async (t) => {
  cleanup(t);
  fakeShell(null);

  const id = await useWorkspace.getState().newScript(null);
  const tab = useWorkspace.getState().tabs.find((candidate) => candidate.id === id);

  assert.equal(tab?.kind, "script");
  assert.equal(tab?.filePath, null);
  assert.match(String(tab?.title), /^Script \d+$/);
});

test("the picked path names the tab, and saving writes the text to that file", async (t) => {
  const backend = installTestBackend({ write_script_file: () => undefined });
  cleanup(t, backend);
  fakeShell("/Users/me/scripts/orders.sql");

  const id = await useWorkspace.getState().newScript("s1");
  assert.equal(useWorkspace.getState().tabs.at(-1)?.title, "orders.sql");
  useWorkspace.getState().updateTab(id, { sql: "SELECT 42;\n" });

  assert.equal(await useWorkspace.getState().saveScript(id), true);
  assert.deepEqual(backend.argsFor("write_script_file"), [
    { path: "/Users/me/scripts/orders.sql", contents: "SELECT 42;\n" },
  ]);
  assert.equal(useWorkspace.getState().toasts.at(-1)?.title, "Script saved");
});

test("a script that already has a path saves again without asking", async (t) => {
  const backend = installTestBackend({ write_script_file: () => undefined });
  cleanup(t, backend);
  const sent = fakeShell("/Users/me/scripts/orders.sql");

  const id = await useWorkspace.getState().newScript("s1");
  assert.equal(sent.length, 1);
  await useWorkspace.getState().saveScript(id);
  await useWorkspace.getState().saveScript(id);

  // The picker asked exactly once; both saves went straight to the file.
  assert.equal(sent.length, 1);
  assert.equal(backend.argsFor("write_script_file")?.length, 2);
});

test("a refused write is reported instead of claiming the script was saved", async (t) => {
  const backend = installTestBackend({
    write_script_file: () => {
      throw new Error("read-only file system");
    },
  });
  cleanup(t, backend);
  fakeShell("/Users/me/scripts/orders.sql");

  const id = await useWorkspace.getState().newScript("s1");
  assert.equal(await useWorkspace.getState().saveScript(id), false);

  const toast = useWorkspace.getState().toasts.at(-1);
  assert.equal(toast?.title, "Could not save script");
  assert.match(String(toast?.description), /read-only file system/);
});
