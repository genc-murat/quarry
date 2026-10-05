import { useEffect, useState } from "react";
import { AlertTriangle, ListTree, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { QueryResponse, StatementResult } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  plan: QueryResponse | null;
  explaining: boolean;
}

/**
 * Renders EXPLAIN output. Plans are small (a handful of rows), so unlike the
 * results grid this renders every row directly instead of virtualising.
 */
export function PlanPanel({ plan, explaining }: Props) {
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => setActiveIndex(0), [plan]);

  if (explaining) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <p className="text-xs">Building query plan…</p>
      </div>
    );
  }

  const statements = plan?.results ?? [];
  const statement: StatementResult | null =
    statements.length > 0
      ? (statements[Math.min(activeIndex, statements.length - 1)] ?? null)
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border bg-surface/60 px-2 py-1.5">
        <Badge variant="muted">
          <ListTree className="h-3 w-3" />
          query plan
        </Badge>
        {statements.length > 1 ? (
          <div className="flex items-center gap-1">
            {statements.map((_, index) => (
              <button
                key={index}
                onClick={() => setActiveIndex(index)}
                className={cn(
                  "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
                  index === activeIndex
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50",
                )}
              >
                #{index + 1}
              </button>
            ))}
          </div>
        ) : null}
        {plan ? (
          <span className="ml-auto text-[11px] text-muted-foreground/70">
            MySQL/PostgreSQL EXPLAIN output
          </span>
        ) : null}
      </div>

      {statement?.error ? (
        <pre className="max-h-40 overflow-auto border-b border-border bg-destructive/5 px-3 py-2 font-mono text-[11px] text-destructive">
          {statement.error}
        </pre>
      ) : null}

      {!statement || statement.columns.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
          <AlertTriangle className="h-5 w-5" />
          <p className="text-xs">No plan returned</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse font-mono text-[12px]">
            <thead>
              <tr className="sticky top-0 z-10 bg-surface">
                {statement.columns.map((column, index) => (
                  <th
                    key={`${column.name}-${index}`}
                    className="border-b border-border px-3 py-1.5 text-left font-semibold"
                  >
                    {column.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {statement.rows.map((row, rowIndex) => (
                <tr
                  key={rowIndex}
                  className={cn("border-b border-border/40", rowIndex % 2 === 1 && "bg-surface/40")}
                >
                  {statement.columns.map((_, columnIndex) => (
                    <td
                      key={columnIndex}
                      className="whitespace-pre-wrap break-words px-3 py-1 align-top"
                    >
                      {formatCell(row[columnIndex])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
