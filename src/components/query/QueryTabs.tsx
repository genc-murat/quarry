import { Plus, Table2, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useWorkspace } from "@/stores/workspace";

export function QueryTabs() {
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const setActiveTab = useWorkspace((s) => s.setActiveTab);
  const closeTab = useWorkspace((s) => s.closeTab);
  const newTab = useWorkspace((s) => s.newTab);

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-surface px-2">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "group flex h-7 max-w-52 shrink-0 items-center gap-2 rounded-md px-2.5 text-xs transition-colors",
              tab.id === activeTabId
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            {tab.running ? (
              <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
            ) : null}
            {tab.kind === "object" ? <Table2 className="h-3 w-3 shrink-0 text-primary" /> : null}
            <span className="truncate">{tab.title}</span>
            <span
              role="button"
              tabIndex={-1}
              onClick={(event) => {
                event.stopPropagation();
                closeTab(tab.id);
              }}
              className="rounded p-0.5 opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100"
            >
              <X className="h-3 w-3" />
            </span>
          </button>
        ))}
      </div>
      <button
        onClick={() => newTab()}
        title="New query tab"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
