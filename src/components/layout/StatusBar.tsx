import { CircleDot, Loader2 } from "lucide-react";

import { formatCount, formatDuration } from "@/lib/utils";
import { useWorkspace } from "@/stores/workspace";

export function StatusBar() {
  const sessions = useWorkspace((s) => s.sessions);
  const activeSessionId = useWorkspace((s) => s.activeSessionId);
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const maxRows = useWorkspace((s) => s.settings.editor.maxRows);

  const session = sessions.find((s) => s.id === activeSessionId) ?? null;
  const tab = tabs.find((t) => t.id === activeTabId) ?? null;
  const lastResult = tab?.result?.results.filter((r) => r.isQuery).at(-1) ?? null;

  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-border bg-surface px-3 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        {session ? (
          <>
            <span className="h-2 w-2 rounded-full bg-success" />
            <span className="text-foreground/85">{session.name}</span>
            <span className="text-muted-foreground/70">· {session.driver}</span>
            {session.server.version ? (
              <span className="text-muted-foreground/70">v{session.server.version}</span>
            ) : null}
          </>
        ) : (
          <>
            <CircleDot className="h-3 w-3" />
            <span>No connection</span>
          </>
        )}
      </span>

      <span className="ml-auto flex items-center gap-4">
        {tab?.running ? (
          <span className="flex items-center gap-1.5 text-primary">
            <Loader2 className="h-3 w-3 animate-spin" />
            Running
          </span>
        ) : null}
        {lastResult ? (
          <>
            <span>{formatCount(lastResult.rowCount)} rows</span>
            <span>{formatDuration(lastResult.executionMs)}</span>
            {lastResult.truncated ? (
              <span className="text-warning">truncated at {formatCount(maxRows)}</span>
            ) : null}
          </>
        ) : null}
        <span className="text-muted-foreground/70">limit {formatCount(maxRows)}</span>
      </span>
    </footer>
  );
}
