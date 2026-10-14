import { TriangleAlert } from "lucide-react";

import { destructiveTitle, riskLabel } from "@/lib/statementRisk";
import type { StatementReading } from "@/lib/types";

/**
 * What the local model read about the statements a command is about to send, said
 * before Run is pressed rather than after.
 *
 * A reading that is not worth acting on draws nothing at all, and neither does a
 * statement with no reading: the point is to mark a statement that could take
 * something away, so a badge on an ordinary edit would be noise, and a badge on a
 * statement the model never saw would be a claim nothing supports. The words are
 * the message — the colour only reinforces them — and `data-statement-risk` makes
 * the mark assertable without reading styles, the way `data-assistant-status` does
 * for the indicator.
 *
 * `subject` says which command's text the reading is about. Run and the Script
 * button send different sets of statements, so their marks have to be tellable
 * apart — as much by a reader looking at the toolbar as by a test.
 */
export function StatementRiskBadge({
  read,
  subject = "run",
}: {
  read: StatementReading | null;
  subject?: "run" | "script";
}) {
  const label = riskLabel(read);
  if (!read || !label) return null;
  return (
    <span
      data-statement-risk={read.verdict}
      data-statement-risk-subject={subject}
      title={destructiveTitle(read)}
      className="flex select-none items-center gap-1 text-[11px] text-warning"
    >
      <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
      {label}
    </span>
  );
}
