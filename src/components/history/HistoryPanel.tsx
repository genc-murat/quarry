import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useWorkspace } from "@/stores/workspace";

export function HistoryPanel() {
  const history = useWorkspace((s) => s.history);
  const clearHistory = useWorkspace((s) => s.clearHistory);
  const newTab = useWorkspace((s) => s.newTab);
  const sessions = useWorkspace((s) => s.sessions);

  // Replay on the session the query originally ran on, but only while that
  // session is still open — otherwise fall back to whatever is active now.
  const replaySession = (sessionId: string | null) =>
    sessionId && sessions.some((s) => s.id === sessionId) ? sessionId : undefined;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between px-3 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          History
        </h2>
        {history.length > 0 ? (
          <Button size="icon-sm" variant="ghost" title="Clear history" onClick={clearHistory}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </header>

      <div className="flex-1 space-y-1.5 overflow-y-auto px-2 pb-3">
        {history.length === 0 ? (
          <p className="mx-1 mt-6 text-center text-xs text-muted-foreground">
            Queries you run will show up here.
          </p>
        ) : null}

        {history.map((entry) => (
          <button
            key={entry.id}
            onClick={() =>
              newTab({
                sql: entry.sql,
                database: entry.database,
                sessionId: replaySession(entry.sessionId),
                title: "History",
              })
            }
            className="w-full rounded-lg border border-border bg-card p-2 text-left transition-colors hover:border-primary/50"
          >
            <div className="flex items-center gap-2">
              <Badge variant={entry.ok ? "success" : "danger"}>
                {entry.ok ? `${entry.rowCount} rows` : "failed"}
              </Badge>
              <span className="ml-auto text-[10px] text-muted-foreground">
                {entry.durationMs} ms
              </span>
            </div>
            <pre className="mt-1.5 line-clamp-2 whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
              {entry.sql}
            </pre>
            <p className="mt-1 text-[10px] text-muted-foreground/70">
              {entry.sessionName}
              {entry.database ? ` · ${entry.database}` : ""}
            </p>
          </button>
        ))}
      </div>
    </div>
  );
}
