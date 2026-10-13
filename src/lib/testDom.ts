import { JSDOM } from "jsdom";

/**
 * The DOM the component tests run in, kept in its own module **without** any
 * React import.
 *
 * That separation is the whole point: React DOM decides once, at import time,
 * whether it is running in a browser (`canUseDOM`, and from it
 * `isInputEventSupported`). Imported before a DOM exists it concludes there is
 * none — after which it ignores `input`/`change` events entirely and falls back
 * to an IE-era `attachEvent` polyfill, so a test can never type into a field.
 * Installing the DOM here also runs at import time, so `testRender` (which pulls
 * in `react-dom`) must import this module first.
 */

let dom: JSDOM | null = null;

/**
 * Globals React, the stores and the components read off the global object. The
 * needed event constructors are included, since a test dispatches real events.
 */
const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "localStorage",
  "sessionStorage",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLSelectElement",
  "Element",
  "Node",
  "Event",
  "InputEvent",
  "CustomEvent",
  "MouseEvent",
  "KeyboardEvent",
  "MutationObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "matchMedia",
] as const;

/**
 * A Node global can be read-only (`navigator` is), so a global that refuses the
 * write is left as Node defined it rather than failing the test.
 */
function defineGlobal(key: string, value: unknown): void {
  try {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  } catch {
    /* keep Node's own global */
  }
}

/** The document components mount into, created once per test process. */
export function installDom(): JSDOM {
  if (dom) return dom;
  const created = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const win = created.window as unknown as Record<string, unknown>;
  for (const key of DOM_GLOBALS) {
    const value = win[key];
    // A method has to keep the window as its receiver, or jsdom throws.
    defineGlobal(key, typeof value === "function" ? (value as () => unknown).bind(win) : value);
  }
  // React only schedules effects outside `act` when this is set.
  defineGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  dom = created;
  return dom;
}

/**
 * Throw the document away. jsdom timers (a toast dismissal, a rerender frame)
 * are real timers, so a suite that triggers them should let the cleanup close
 * the window instead of waiting them out; the next `mount` builds a new one.
 */
export function closeDom(): void {
  dom?.window.close();
  dom = null;
}

// Installed on import: by the time `react-dom` is loaded (testRender imports it
// right after this module) the DOM has to exist.
installDom();
