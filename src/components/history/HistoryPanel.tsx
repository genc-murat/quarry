import { Play, Star, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useWorkspace } from "@/stores/workspace";

export function HistoryPanel() {
  const history = useWorkspace((s) => s.history);
  const clearHistory = useWorkspace((s) => s.clearHistory);
  const favorites = useWorkspace((s) => s.favorites);
  const removeFavorite = useWorkspace((s) => s.removeFavorite);
  const newTab = useWorkspace((s) => s.newTab);
  const runTab = useWorkspace((s) => s.runTab);
  const sessions = useWorkspace((s) => s.sessions);

  // Replay on the session the query originally ran on, but only while that
  // session is still open — otherwise fall back to whatever is active now.
  const replaySession = (sessionId: string | null) =>
    sessionId && sessions.some((s) => s.id === sessionId) ? sessionId : undefined;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between px-3 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          History & favorites
        </h2>
        {history.length > 0 ? (
          <Button size="icon-sm" variant="ghost" title="Clear history" onClick={clearHistory}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </header>

      <div className="border-b border-border px-2 pb-2">
        <p className="px-1 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Favorites · {favorites.length}</p>
        {favorites.length === 0 ? <p className="px-1 py-1 text-[11px] text-muted-foreground">Star a query in the editor to pin it.</p> : null}
        <div className="max-h-48 space-y-1 overflow-y-auto">{favorites.map((favorite) => (
          <div key={favorite.id} className="group rounded-md border border-border bg-card p-2">
            <div className="flex items-center gap-1.5"><Star className="h-3 w-3 shrink-0 fill-warning text-warning" /><span className="min-w-0 flex-1 truncate text-xs font-medium">{favorite.name}</span><Button size="icon-sm" variant="ghost" title="Run favorite" onClick={() => { const id = newTab({ sql: favorite.sql, database: favorite.database, sessionId: replaySession(favorite.sessionId), title: favorite.name }); void runTab(id); }}><Play className="h-3 w-3" /></Button><Button size="icon-sm" variant="ghost" title="Remove favorite" onClick={() => removeFavorite(favorite.id)}><X className="h-3 w-3" /></Button></div>
            <pre className="mt-1 line-clamp-2 whitespace-pre-wrap break-words font-mono text-[10px] text-muted-foreground">{favorite.sql}</pre>
          </div>
        ))}</div>
      </div>
      <div className="flex-1 space-y-1.5 overflow-y-auto px-2 pb-3">
        <p className="px-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Recent executions</p>
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
