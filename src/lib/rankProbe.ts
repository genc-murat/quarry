/**
 * The one thing a test cannot fake is a person typing an identifier, so
 * `scripts/smoke-app.mjs` asks the app to type it: this probe connects to a
 * database, opens a query holding all but the last character of the SQL under
 * test, puts the cursor after it, types that character, and reports what the
 * editor's completion list did with it — the order it opened in, and the order
 * the local model left it in. The cursor matters: the same character at the
 * start of the line completes a keyword, and the list would then be about
 * something the run never asked.
 *
 * It is deliberately the same shape as `updateProbe.ts`, for the same reasons:
 * it exists only in a build that opts in when it is built (`VITE_RANK_PROBE=1`,
 * plus `VITE_RANK_PROBE_URL` for the server to report to), the guard compares
 * against the literal so a normal build reads `false` and the minifier drops the
 * branch, and the observations are posted to the script's server because the
 * webview's console is not visible from outside the app.
 *
 * Every step is a string and carries the milliseconds since the keystroke, so
 * the script can assert a *sequence* — list opened unranked at 162 ms, model's
 * pick first at 772 ms — instead of a final state that would look the same if
 * the ranking had never happened. The probe itself decides nothing: it reports,
 * the script judges, and a phase that never ran shows up as a missing step
 * rather than as a quiet pass.
 *
 * A run can carry a second phase, and the reason it is here is the same one: what
 * the editor does with a statement the *database* rejected — the error on screen
 * and the name the local model suggests under it — is decided by an effect, a
 * store and a request, and none of them is visible from outside the app. So when
 * `VITE_RANK_PROBE_FAILURE` names a statement, the probe runs it once the ranking
 * has been seen, reports the error the run produced, and then reports the
 * suggestion the editor drew — or gives up saying that none came.
 *
 * That phase goes on to *press* the suggestion: the button rewrites the statement
 * in the editor and runs it, which is the whole of what the feature does, and the
 * probe reports the statement the editor was left holding and then the result of
 * running it. A repair that was never written, or that was written and still
 * failed, is a different timeout with its own words.
 */
import type { CompletionSource } from "@codemirror/autocomplete";
import { completionStatus, currentCompletions } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";

import { useWorkspace } from "@/stores/workspace";

import { ipc } from "./ipc";

/** The connection the run seeds, and the SQL it types the last character of. */
const DEFAULT_CONNECTION = "Ranking demo (SQLite)";
const DEFAULT_SQL = "SELECT * FROM or";
const DEFAULT_TYPED = "d";

/** How long a run may take, and how often the list is looked at while it does. */
const DEADLINE_MS = 60_000;
const SAMPLE_MS = 25;

/**
 * What the run has seen so far, so each observation is reported once. The
 * editor's own state is reported alongside the list on screen: a run where no
 * list ever appeared has to say *why*, and "the language offered no completion
 * sources" and "the sources had nothing to say about this token" are different
 * faults.
 */
interface Seen {
  firstOrder: string | null;
  lastOrder: string | null;
  status: string | null;
  completion: string | null;
  ranked: boolean;
}

export function startRankProbe(): void {
  if (import.meta.env.VITE_RANK_PROBE !== "1") return;
  const server = import.meta.env.VITE_RANK_PROBE_URL;
  if (!server) return;

  void (async () => {
    try {
      await run(server);
    } catch (error) {
      await report(server, 0, `error:${error instanceof Error ? error.message : String(error)}`);
    }
  })();
}

async function run(server: string): Promise<void> {
  const connection = import.meta.env.VITE_RANK_PROBE_CONNECTION || DEFAULT_CONNECTION;
  const sql = import.meta.env.VITE_RANK_PROBE_SQL || DEFAULT_SQL;
  const typed = import.meta.env.VITE_RANK_PROBE_TYPED || DEFAULT_TYPED;

  await report(server, 0, `start:${connection}`);
  const profiles = await ipc.listConnections();
  const profile = profiles.find((entry) => entry.name === connection);
  if (!profile) throw new Error(`no connection named ${connection}`);

  const session = await useWorkspace.getState().connect({ profileId: profile.id });
  if (!session) throw new Error("the connection opened no session");
  const database = session.server.currentDatabase ?? "";
  await report(server, 0, `connected:${session.driver}:${database || "-"}`);

  // The editor is the UI's own: a tab in the workspace, showing the SQL the run
  // is about, with the last character still to be typed.
  const workspace = useWorkspace.getState();
  const tabId = workspace.newTab({ sessionId: session.id, sql });
  workspace.setActiveTab(tabId);
  await report(server, 0, `tab:${tabId.slice(0, 8)}`);

  const tables = await waitForSchema(server, session.id, database);
  await report(server, 0, `schema:${tables.length}:${tables.join("|")}`);

  const view = await waitForEditor(server);
  view.focus();
  // The cursor goes where a person's would be after typing the SQL out: at the
  // end. Typing at the start would complete a keyword, not the table the SQL
  // names, and the run would judge a list the question was never about.
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  await report(
    server,
    0,
    `editor:ready:${document.querySelectorAll(".cm-editor").length}:${sourcesAt(view)}`,
  );

  const failure = import.meta.env.VITE_RANK_PROBE_FAILURE || "";

  const started = performance.now();
  await type(view, typed);
  await report(server, elapsed(started), `typed:${typed}:${docTail(view)}`);

  const seen: Seen = {
    firstOrder: null,
    lastOrder: null,
    status: null,
    completion: null,
    ranked: false,
  };
  while (performance.now() - started < DEADLINE_MS) {
    await sample(server, started, seen, view);
    // A ranking was applied and the list it applied to is on screen: the first
    // phase has seen everything it exists for.
    if (ranked(seen)) break;
    await sleep(SAMPLE_MS);
  }
  if (!ranked(seen)) {
    await report(
      server,
      elapsed(started),
      `timeout:${seen.firstOrder ? (seen.ranked ? "list-not-reordered" : "no-answer") : "no-list"}`,
    );
    return;
  }
  if (failure) {
    await failed(server, started, view, tabId, failure);
    return;
  }
  await report(server, elapsed(started), "done");
}

/** Whether the run has seen the list it opened come back reordered. */
function ranked(seen: Seen): boolean {
  return seen.ranked && seen.firstOrder !== null && seen.lastOrder !== null && seen.lastOrder !== seen.firstOrder;
}

/**
 * The second phase: run a statement the database will reject, the way the Run
 * button runs it, and report the error the app is showing and the suggestion it
 * drew under it.
 *
 * The hint is read from the DOM rather than from the store that holds it, because
 * what the run is checking is what a person would see: the request may have been
 * answered and the answer still not be on screen. A run that never gets a hint is
 * a timeout here rather than a quiet pass, so the script can tell "no suggestion"
 * from "no phase".
 */
async function failed(
  server: string,
  started: number,
  view: EditorView,
  tabId: string,
  sql: string,
): Promise<void> {
  const workspace = useWorkspace.getState();
  // The statement belongs in the editor, so the failure the app reports is the one
  // the run asked for — and so the Run button's own SQL matches it.
  workspace.updateTab(tabId, { sql });
  await workspace.runTab(tabId, sql);
  const result = useWorkspace.getState().tabs.find((tab) => tab.id === tabId)?.result;
  const error = result?.results?.[0]?.error ?? "the statement did not fail";
  await report(server, elapsed(started), `failed:${oneLine(error)}`);

  const deadline = performance.now() + DEADLINE_MS;
  while (performance.now() < deadline) {
    const name = hintName();
    if (name) {
      await report(server, elapsed(started), `repair:${name}`);
      const note = hintNote();
      if (note) await report(server, elapsed(started), `repair-note:${note}`);
      await pressFix(server, started, view, tabId, name);
      return;
    }
    await sleep(SAMPLE_MS);
  }
  await report(server, elapsed(started), "timeout:no-repair");
}

/**
 * The third phase: press the suggestion, and report what it did.
 *
 * The button rewrites the statement in the editor and runs it, so both halves are
 * waited for and each is reported as it happens — the statement the editor was
 * left holding (read from the editor itself, not from the store), and the result
 * of running it. A repair nobody can press, one that never reaches the editor, and
 * one that runs and fails are three different faults, and each says so.
 */
async function pressFix(
  server: string,
  started: number,
  view: EditorView,
  tabId: string,
  name: string,
): Promise<void> {
  const button = document.querySelector<HTMLElement>("[data-statement-repair-fix]");
  if (!button) {
    await report(server, elapsed(started), "no-fix-button");
    return;
  }
  button.click();

  const deadline = performance.now() + DEADLINE_MS;
  let written = false;
  while (performance.now() < deadline) {
    if (!written && docTail(view).includes(name)) {
      written = true;
      await report(server, elapsed(started), `fixed:${docTail(view)}`);
    }
    if (written) {
      const tab = useWorkspace.getState().tabs.find((entry) => entry.id === tabId);
      const error = tab?.result?.results?.[0]?.error ?? null;
      if (tab && !tab.running && !error) {
        await report(server, elapsed(started), "ran:ok");
        await report(server, elapsed(started), "done");
        return;
      }
    }
    await sleep(SAMPLE_MS);
  }
  await report(
    server,
    elapsed(started),
    written ? "timeout:repair-not-run" : "timeout:repair-not-written",
  );
}

/**
 * Put `text` in the editor the way a person would: one transaction per
 * character, annotated as typing, which is exactly what opens the completion
 * list. `ViewPlugin`-level input is not needed — and not available to a probe —
 * because the annotation is what the autocompletion extension reads.
 */
async function type(view: EditorView, text: string): Promise<void> {
  for (const character of text) {
    const position = view.state.selection.main.head;
    view.dispatch({
      changes: { from: position, insert: character },
      selection: { anchor: position + 1 },
      userEvent: "input.type",
    });
    await sleep(60);
  }
}

/** One look at the list, the editor's completion state, and the indicator. */
async function sample(
  server: string,
  started: number,
  seen: Seen,
  view: EditorView,
): Promise<void> {
  const ms = elapsed(started);
  const completion = `${completionStatus(view.state)}:${currentCompletions(view.state)
    .map((item) => item.label)
    .join("|")}`;
  if (completion !== seen.completion) {
    seen.completion = completion;
    await report(server, ms, `completion:${completion}`);
  }
  const order = openOrder();
  if (order && order !== seen.lastOrder) {
    seen.lastOrder = order;
    seen.firstOrder ??= order;
    await report(server, ms, `list:${order.split("\n").join("|")}`);
  }
  const status = indicatorStatus();
  if (status && status !== seen.status) {
    seen.status = status;
    if (status === "ranked") seen.ranked = true;
    await report(server, ms, `assistant:${status}`);
    // And what the pill would say if a person hovered it. A run that reported
    // only the state would read the same whatever words the app put behind it,
    // which is exactly what the tooltip exists to get right.
    const note = indicatorNote();
    if (note) await report(server, ms, `assistant-note:${note}`);
  }
}

/** How many completion sources the language offers at the cursor. */
function sourcesAt(view: EditorView): number {
  const position = view.state.selection.main.head;
  return view.state.languageDataAt<CompletionSource>("autocomplete", position).length;
}

/** The end of the document, so a run can show the typed character landed. */
function docTail(view: EditorView): string {
  return view.state.doc.toString().slice(-40).replace(/\s+/g, " ").trim();
}

/** The name the editor is suggesting for the failure, or null when it suggests none. */
function hintName(): string | null {
  return (
    document.querySelector("[data-statement-repair]")?.getAttribute("data-statement-repair") ?? null
  );
}

/** The suggestion's tooltip: what the app says behind it, in its own words. */
function hintNote(): string | null {
  const title = document.querySelector("[data-statement-repair]")?.getAttribute("title");
  return title && title.length > 0 ? title : null;
}

/** One line of text, bounded, so a step stays a step. */
function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

/** The labels of the open completion list, top to bottom, or null when closed. */
function openOrder(): string | null {
  const list = document.querySelector(".cm-tooltip-autocomplete");
  if (!list) return null;
  const labels = [...list.querySelectorAll("li")].map((item) =>
    (item.querySelector(".cm-completionLabel")?.textContent ?? item.textContent ?? "").trim(),
  );
  return labels.length > 0 ? labels.join("\n") : null;
}

/** What the assistant indicator says it is doing, as the editor labels it. */
function indicatorStatus(): string | null {
  return document.querySelector("[data-assistant-status]")?.getAttribute("data-assistant-status") ?? null;
}

/** The indicator's tooltip: the explanation behind the state, in the app's words. */
function indicatorNote(): string | null {
  const title = document.querySelector("[data-assistant-status]")?.getAttribute("title");
  return title && title.length > 0 ? title : null;
}

/** The table names the editor can complete, once the session's schema is in. */
async function waitForSchema(
  server: string,
  sessionId: string,
  database: string,
): Promise<string[]> {
  const key = `${sessionId}||${database}`;
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    const entries = useWorkspace.getState().columnsCache[key];
    if (entries && entries.length > 0) return entries.map((entry) => entry.table);
    await sleep(SAMPLE_MS);
  }
  await report(server, 0, "timeout:schema");
  throw new Error(`the schema for ${database || "(none)"} never arrived`);
}

/** The workspace editor's own view — the one the user types into. */
async function waitForEditor(server: string): Promise<EditorView> {
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    const host = document.querySelector<HTMLElement>(".cm-editor");
    const view = host ? EditorView.findFromDOM(host) : null;
    if (view) return view;
    await sleep(SAMPLE_MS);
  }
  await report(server, 0, "timeout:editor");
  throw new Error("the editor never mounted");
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Post one step to the run's server; a server that is gone means the run is. */
async function report(server: string, ms: number, step: string): Promise<void> {
  try {
    await fetch(`${server}/probe/${ms}/${encodeURIComponent(step)}`);
  } catch {
    // The server belongs to the run; if it is gone, the run is over too.
  }
}
