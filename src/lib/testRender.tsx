// Installed before `react-dom` is imported below: React decides at import time
// whether it is in a browser, and a test must be able to type into a field.
import { closeDom, installDom } from "./testDom.ts";

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
 *
 * The document itself lives in `./testDom`, which is imported first so that
 * jsdom exists before React DOM is loaded.
 */

export { closeDom };

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
