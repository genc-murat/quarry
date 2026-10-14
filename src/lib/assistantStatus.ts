/**
 * What the editor's assistant indicator reports.
 *
 * The rules live here, once, as pure functions: the component only draws the
 * answer and the workspace only supplies what it knows.
 *
 * `uncertain` is deliberately its own state rather than being folded into
 * `unavailable`. A model that answered without conviction is a different fact
 * from no model at all — "is Ollama running?" would be the wrong thing to tell
 * the user about an answer that arrived.
 *
 * Which *question* was asked matters as much as which answer came back. Tables
 * at a bare position and columns behind a qualifier are asked the same way and
 * answered very differently — the column question measured between 0.03 and 0.20
 * for a bare `ORDER BY o.ord` (`src-tauri/src/decision.rs`), below the
 * confidence the editor acts on, so a list left in its own order is the ordinary
 * outcome there rather than a fault. A reading that does not say which question
 * went unanswered leaves the user to guess between "the assistant is broken" and
 * "this one is hard", and the reason the client reports is the only other thing
 * that can tell them.
 */
import type { RankCandidateKind, RankCandidatesResponse } from "./types";

export type AssistantStatus =
  | "off"
  | "idle"
  | "working"
  | "ranked"
  | "uncertain"
  | "unavailable";

/** What the workspace tracks about the last (or in-flight) question. */
export interface AssistantCall {
  /** A question is in flight. */
  pending: boolean;
  /** The last answer, or null before the first one landed. */
  response: RankCandidatesResponse | null;
  /** The last call never produced an answer (the IPC itself failed). */
  failed: boolean;
  /**
   * What the last (or in-flight) question was choosing between, so the tooltip
   * can say which name the answer is about.
   */
  asked: RankCandidateKind;
}

/** Nobody has asked anything, and nothing has said what the names would be. */
export const PLAIN_CALL: AssistantCall = {
  pending: false,
  response: null,
  failed: false,
  asked: "table",
};

/** The state to show. `enabled` comes from the setting, not from the call. */
export function assistantStatus(
  run: AssistantCall & { enabled: boolean },
): AssistantStatus {
  if (!run.enabled) return "off";
  if (run.pending) return "working";
  if (run.failed) return "unavailable";
  if (!run.response) return "idle";
  if (!run.response.available) return "unavailable";
  return run.response.ranked.length > 0 ? "ranked" : "uncertain";
}

/** Short label, so the state reads as words and not only as a colour. */
export const ASSISTANT_LABEL: Record<AssistantStatus, string> = {
  off: "AI off",
  idle: "AI ready",
  working: "AI…",
  ranked: "AI ranked",
  uncertain: "AI unsure",
  unavailable: "AI unavailable",
};

/**
 * The tooltip: what the state means, which question it is about, and — when
 * there is one — the reason the layer below gave.
 *
 * `reason` is the client's own sentence rather than the UI's ("the model was not
 * sure enough (0.32 below 0.15)", "the local model is unavailable: …"; both are
 * built in `src-tauri/src/decision.rs`, not by the model). The editor says its
 * piece first and quotes that after it, so a reader who wants to know why the
 * list did not move gets the number instead of a shrug.
 */
export function assistantDescription(
  status: AssistantStatus,
  call: AssistantCall,
): string {
  const noun = call.asked === "column" ? "column" : "table";
  // Quoted verbatim and attributed to nothing it did not come from: the
  // sentence is the client's, and paraphrasing it here would lose the number in
  // it — which is the whole reason it is carried this far.
  const said = call.response?.reason
    ? ` Reported: “${call.response.reason}”.`
    : "";
  switch (status) {
    case "off":
      return "Smart autocomplete is off. Turn it on under Settings → Assistant.";
    case "idle":
      return "Waiting for something to complete.";
    case "working":
      return `Asking the local model which ${noun} you mean…`;
    case "ranked":
      return `The local model put the ${noun} it thinks you mean first.`;
    case "uncertain":
      return (
        `The model was asked which ${noun} you meant and was not sure, so the list ` +
        `kept the language's own order.${said}`
      );
    case "unavailable":
      return `No local model answered, so the list kept its own order. Is Ollama running?${said}`;
  }
}
