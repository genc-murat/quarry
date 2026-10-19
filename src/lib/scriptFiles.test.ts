import assert from "node:assert/strict";
import test from "node:test";

import { installTestBackend } from "@/lib/testBackend.ts";

import { pickScriptPath, scriptName, writeScriptFile } from "./scriptFiles.ts";

/** Make `isTauri()` true so the helpers take the shell path; the backend
 *  installed beside it answers the commands. Node has no `window` otherwise. */
function fakeShell() {
  Object.defineProperty(globalThis, "window", {
    value: { __TAURI_INTERNALS__: { invoke: async () => null } },
    configurable: true,
    writable: true,
  });
}

/** Hand `window` back to Node once the test finishes. */
function forgetShell(t: import("node:test").TestContext) {
  t.after(() => Reflect.deleteProperty(globalThis, "window"));
}

test("scriptName takes the final path segment", () => {
  assert.equal(scriptName("/Users/me/scripts/orders.sql"), "orders.sql");
  // Windows separators, which a picked path may use.
  assert.equal(scriptName("C:\\work\\queries\\report.sql"), "report.sql");
  assert.equal(scriptName("query.sql"), "query.sql");
  assert.equal(scriptName(""), "");
});

test("outside the shell there is no picker, so the suggested name is taken", async () => {
  const granted = await pickScriptPath("orders.sql");
  assert.equal(granted?.path, "orders.sql");
  assert.equal(granted?.token, null, "a download needs no capability");
});

test("in the shell the picker lives on the Rust side and grants the path", async (t) => {
  fakeShell();
  forgetShell(t);
  const backend = installTestBackend({
    pick_script_path: () => ({ path: "/Users/me/scripts/orders.sql", token: "tok-1" }),
  });
  try {
    const granted = await pickScriptPath("script-2.sql");
    assert.deepEqual(granted, { path: "/Users/me/scripts/orders.sql", token: "tok-1" });
    // The webview sends only the suggested name: the dialog, the path and the
    // capability all belong to the shell.
    assert.deepEqual(backend.argsFor("pick_script_path"), [{ fileName: "script-2.sql" }]);
  } finally {
    backend.restore();
  }
});

test("a cancelled picker reports null instead of inventing a path", async (t) => {
  fakeShell();
  forgetShell(t);
  const backend = installTestBackend({ pick_script_path: () => null });
  try {
    assert.equal(await pickScriptPath("orders.sql"), null);
  } finally {
    backend.restore();
  }
});

test("outside the shell saving downloads the text and reports the name", async (t) => {
  // The browser fallback downloads through an anchor; Node has no DOM, so the
  // two pieces the download touches stand in here.
  const clicks: string[] = [];
  Object.defineProperty(globalThis, "document", {
    value: {
      createElement: () => ({
        set href(_: string) {},
        set download(_: string) {},
        click() {
          clicks.push("clicked");
        },
      }),
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "URL", {
    value: { createObjectURL: () => "blob:fake", revokeObjectURL: () => {} },
    configurable: true,
    writable: true,
  });
  t.after(() => {
    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "URL");
  });

  const saved = await writeScriptFile(null, "orders.sql", "SELECT 1;\n");
  assert.deepEqual(saved, { path: "orders.sql", token: null });
  assert.deepEqual(clicks, ["clicked"]);
});

test("saving in the shell trades the token for the write", async (t) => {
  fakeShell();
  forgetShell(t);
  const backend = installTestBackend({
    save_script_file: () => ({ path: "/Users/me/scripts/orders.sql", token: "tok-2" }),
  });
  try {
    const granted = await writeScriptFile("tok-1", "orders.sql", "SELECT 1;\n");
    assert.deepEqual(granted, { path: "/Users/me/scripts/orders.sql", token: "tok-2" });
    // The token is what the shell accepts; the suggested name rides along for
    // the dialog it may still have to open.
    assert.deepEqual(backend.argsFor("save_script_file"), [
      { token: "tok-1", fileName: "orders.sql", contents: "SELECT 1;\n" },
    ]);
  } finally {
    backend.restore();
  }
});

test("a first save sends no token, so the shell asks where to put it", async (t) => {
  fakeShell();
  forgetShell(t);
  const backend = installTestBackend({
    save_script_file: () => ({ path: "/Users/me/scripts/new.sql", token: "tok-3" }),
  });
  try {
    const granted = await writeScriptFile(null, "script-7.sql", "SELECT 2;");
    assert.deepEqual(granted, { path: "/Users/me/scripts/new.sql", token: "tok-3" });
    assert.deepEqual(backend.argsFor("save_script_file"), [
      { token: null, fileName: "script-7.sql", contents: "SELECT 2;" },
    ]);
  } finally {
    backend.restore();
  }
});

test("a cancelled save dialog reports null", async (t) => {
  fakeShell();
  forgetShell(t);
  const backend = installTestBackend({ save_script_file: () => null });
  try {
    assert.equal(await writeScriptFile(null, "orders.sql", "SELECT 1;"), null);
  } finally {
    backend.restore();
  }
});
