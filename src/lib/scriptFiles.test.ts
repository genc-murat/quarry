import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { installTestBackend } from "@/lib/testBackend.ts";

import { pickScriptPath, scriptName, writeScriptFile } from "./scriptFiles.ts";

test("scriptName takes the final path segment", () => {
  assert.equal(scriptName("/Users/me/scripts/orders.sql"), "orders.sql");
  // Windows separators, which a picked path may use.
  assert.equal(scriptName("C:\\work\\queries\\report.sql"), "report.sql");
  assert.equal(scriptName("query.sql"), "query.sql");
  assert.equal(scriptName(""), "");
});

/**
 * Fake the desktop shell for one test. `window.__TAURI_INTERNALS__` is what
 * `isTauri()` looks for, and the dialog plugin reaches the native picker through
 * its `invoke` — so the stub stands in for the window the human would see.
 * Returns the commands the webview sent, in order.
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
    },
    configurable: true,
    writable: true,
  });
  return sent;
}

/** Hand `window` back to Node once the test finishes. */
function forgetShell(t: TestContext) {
  t.after(() => Reflect.deleteProperty(globalThis, "window"));
}

test("outside the shell there is no picker, so the suggested name is taken", async () => {
  assert.equal(await pickScriptPath("orders.sql"), "orders.sql");
});

test("in the shell the picker's answer becomes the path", async (t) => {
  const sent = fakeShell("/Users/me/scripts/orders.sql");
  forgetShell(t);

  assert.equal(await pickScriptPath("script-2.sql"), "/Users/me/scripts/orders.sql");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.command, "plugin:dialog|save");
  // The dialog opens on the suggested name and stays on `.sql` files.
  assert.deepEqual(sent[0]?.args, {
    options: {
      defaultPath: "script-2.sql",
      filters: [{ name: "SQL script", extensions: ["sql"] }],
    },
  });
});

test("a cancelled picker reports null instead of inventing a path", async (t) => {
  fakeShell(null);
  forgetShell(t);

  assert.equal(await pickScriptPath("orders.sql"), null);
});

test("saving in the shell sends the text to write_script_file", async (t) => {
  // The write path does not ask the picker anything; the tab already knows.
  fakeShell(null);
  forgetShell(t);
  const backend = installTestBackend({ write_script_file: () => undefined });
  t.after(backend.restore);

  await writeScriptFile("/Users/me/scripts/orders.sql", "SELECT 1;\n");

  assert.deepEqual(backend.argsFor("write_script_file"), [
    { path: "/Users/me/scripts/orders.sql", contents: "SELECT 1;\n" },
  ]);
});
