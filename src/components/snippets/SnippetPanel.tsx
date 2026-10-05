import { Play, Trash2, PlusCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useWorkspace } from "@/stores/workspace";

export function SnippetPanel() {
  const snippets = useWorkspace((s) => s.snippets);
  const sessions = useWorkspace((s) => s.sessions);
  const activeSessionId = useWorkspace((s) => s.activeSessionId);
  const newTab = useWorkspace((s) => s.newTab);
  const runTab = useWorkspace((s) => s.runTab);
  const deleteSnippet = useWorkspace((s) => s.deleteSnippet);

  // Prefer a session with the snippet's driver (so a saved PostgreSQL query
  // doesn't run against MySQL), otherwise whatever is active.
  const sessionFor = (driver: string | null | undefined) =>
    (driver && sessions.find((s) => s.driver === driver)?.id) || activeSessionId || undefined;

  return (
    <div className="flex h-full flex-col">
      <header className="px-3 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Saved queries
        </h2>
      </header>

      <div className="flex-1 space-y-1.5 overflow-y-auto px-2 pb-3">
        {snippets.length === 0 ? (
          <p className="mx-1 mt-6 text-center text-xs text-muted-foreground">
            Save a query from the editor to reuse it here.
          </p>
        ) : null}

        {snippets.map((snippet) => (
          <div
            key={snippet.id}
            className="group rounded-lg border border-border bg-card p-2 transition-colors hover:border-primary/50"
          >
            <div className="flex items-center gap-2">
              <span className="truncate text-xs font-medium">{snippet.name}</span>
              {snippet.driver ? <Badge variant="muted">{snippet.driver}</Badge> : null}
              <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  title="Insert into a new tab"
                  onClick={() =>
                    newTab({
                      sql: snippet.sql,
                      database: snippet.database ?? null,
                      sessionId: sessionFor(snippet.driver) ?? null,
                      title: snippet.name,
                    })
                  }
                >
                  <PlusCircle className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  title="Run"
                  onClick={() => {
                    const id = newTab({
                      sql: snippet.sql,
                      database: snippet.database ?? null,
                      sessionId: sessionFor(snippet.driver) ?? null,
                      title: snippet.name,
                    });
                    void runTab(id);
                  }}
                >
                  <Play className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  title="Delete"
                  onClick={() => void deleteSnippet(snippet.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <pre className="mt-1.5 line-clamp-2 whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
              {snippet.sql}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
