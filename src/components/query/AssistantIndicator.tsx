import { Loader2, Sparkles, TriangleAlert } from "lucide-react";

import {
  assistantDescription,
  ASSISTANT_LABEL,
  PLAIN_CALL,
  type AssistantCall,
  type AssistantStatus,
} from "@/lib/assistantStatus";
import { cn } from "@/lib/utils";

/**
 * The editor's smart-autocomplete state, as one small pill.
 *
 * Every state carries its own words as well as its colour, so the indicator is
 * readable without relying on the palette — and `data-assistant-status` makes
 * the state assertable without reading styles.
 *
 * `call` is what lets the tooltip explain an answer that was not acted on: it
 * names what the question was choosing between, and quotes the client's reason
 * when it gave one. A caller that tracks no call asks about tables, which is
 * what a bare position asks.
 */
function look(status: AssistantStatus): {
  Icon: typeof Sparkles;
  className: string;
  spin?: boolean;
} {
  switch (status) {
    case "working":
      return { Icon: Loader2, className: "text-muted-foreground", spin: true };
    case "ranked":
      return { Icon: Sparkles, className: "text-primary" };
    case "uncertain":
      return { Icon: Sparkles, className: "text-warning" };
    case "unavailable":
      return { Icon: TriangleAlert, className: "text-warning" };
    default:
      // `off` and `idle` are the quiet states: nothing is happening yet.
      return { Icon: Sparkles, className: "text-muted-foreground/70" };
  }
}

export function AssistantIndicator({
  status,
  call = PLAIN_CALL,
}: {
  status: AssistantStatus;
  call?: AssistantCall;
}) {
  const { Icon, className, spin } = look(status);
  return (
    <span
      data-assistant-status={status}
      title={assistantDescription(status, call)}
      className={cn("flex select-none items-center gap-1 text-[11px]", className)}
    >
      <Icon className={cn("h-3.5 w-3.5 shrink-0", spin && "animate-spin")} />
      {ASSISTANT_LABEL[status]}
    </span>
  );
}
