import { JSDOM } from "jsdom";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * A real DOM for component tests.
 *
 * Rendering markup is not enough for a component that reads a store: zustand
 * hands `getInitialState` to `useSyncExternalStore` as the server snapshot, so
 * `react-dom/server` would show a component the state its module was created
 * with — never what the app has loaded since. Mounting into a document also
 * runs effects, which is what lets a test watch a component call the backend
 * through `installTestBackend`, and it gives the app the `window` its toasts
 * and animation frames expect.
 */

let dom: JSDOM | null = null;

/** Globals React, the stores and the components read off the global object. */
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
function installDom(): JSDOM {
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

export interface MountedComponent {
  /** The node the component rendered into, for queries and events. */
  container: HTMLElement;
  html(): string;
  text(): string;
  /** Unmount and detach. Safe to hand straight to `t.after`. */
  unmount(): Promise<void>;
}

/**
 * Render `element`, letting its effects and any command they send settle before
 * the first assertion.
 *
 *   const backend = installTestBackend({ list_connections: () => [profile] });
 *   const view = await mount(<ConnectionList />);
 *   t.after(view.unmount);
 */
export async function mount(element: ReactElement): Promise<MountedComponent> {
  installDom();
  const container = globalThis.document.createElement("div");
  globalThis.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return {
    container,
    html: () => container.innerHTML,
    text: () => container.textContent ?? "",
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** Click a button by its label and let its handler settle. */
export async function click(view: MountedComponent, label: string): Promise<void> {
  const button = [...view.container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) throw new Error(`no button labelled "${label}"`);
  await act(async () => {
    button.click();
    // The handler is async; one turn of the loop is enough for a scripted reply
    // to land in the store before the assertion reads the new markup.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
