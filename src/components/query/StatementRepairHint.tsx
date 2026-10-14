import { Sparkles, Wand2 } from "lucide-react";

import { fixTitle, repairTitle } from "@/lib/statementRepair";
import type { StatementRepair } from "@/lib/types";

/**
 * What the local model thinks a failed statement meant, said under the database's
 * own error rather than instead of it.
 *
 * The error is the fact and the hint is a suggestion, so the error keeps the
 * space it had and the hint sits below it — in the model's own words being
 * attributed to the model: "did you mean" is the whole claim, and a name offered
 * as a fix would be a stronger claim than an answer to a question supports.
 *
 * The button is the one thing here that acts, and it is passed in rather than
 * worked out here: whether the statement can still be put right — it may have been
 * edited since it failed — is the workspace's business, and a caller that has no
 * fix to offer gets a hint without a button rather than a button that does
 * nothing. What it does is stated in `fixTitle`, because a control that rewrites
 * the editor and runs it has to say so before it is pressed.
 *
 * Nothing is drawn when there is no name to offer. A declination, an unsure
 * answer and an absent model all look the same here, which is deliberate: the
 * reader is looking at a failure, and a line saying "the model had no idea" would
 * add noise to it. The `name` in `data-statement-repair` is what a test asserts on.
 */
export function StatementRepairHint({
  repair,
  onFix = null,
}: {
  repair: StatementRepair | null | undefined;
  /** Put the suggestion into the statement and run it, when that is possible. */
  onFix?: (() => void) | null;
}) {
  if (!repair?.name) return null;
  return (
    <div
      data-statement-repair={repair.name}
      title={repairTitle(repair)}
      className="flex select-none items-center gap-1.5 border-t border-destructive/20 px-3 py-1.5 text-[11px] text-muted-foreground"
    >
      <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
      <span>
        Did you mean{" "}
        <code className="rounded bg-accent px-1 py-0.5 font-mono text-[11px] text-foreground">
          {repair.name}
        </code>
        ?
      </span>
      {onFix ? (
        <button
          type="button"
          onClick={onFix}
          title={fixTitle(repair)}
          data-statement-repair-fix={repair.name}
          className="ml-auto flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-foreground transition-colors hover:bg-accent"
        >
          <Wand2 className="h-3 w-3" />
          Fix and run
        </button>
      ) : null}
    </div>
  );
}
