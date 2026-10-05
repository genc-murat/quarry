import { Bookmark, FolderTree, History, Plug, Plus, Settings, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { type SidebarView, useWorkspace } from "@/stores/workspace";

const ITEMS: { id: SidebarView; icon: typeof Plug; label: string }[] = [
  { id: "connections", icon: Plug, label: "Connections" },
  { id: "explorer", icon: FolderTree, label: "Explorer" },
  { id: "history", icon: History, label: "History" },
  { id: "snippets", icon: Bookmark, label: "Saved queries" },
  { id: "settings", icon: Settings, label: "Settings" },
];

export function ActivityRail() {
  const sidebar = useWorkspace((s) => s.sidebar);
  const setSidebar = useWorkspace((s) => s.setSidebar);
  const newTab = useWorkspace((s) => s.newTab);

  return (
    <nav className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-surface py-2">
      <button
        onClick={() => newTab()}
        title="New query"
        className="mb-1 flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm transition-transform hover:scale-105"
      >
        <Plus className="h-4 w-4" />
      </button>

      {ITEMS.map(({ id, icon: Icon, label }) => (
        <button
          key={id}
          onClick={() => setSidebar(id)}
          title={label}
          className={cn(
            "relative flex h-9 w-9 items-center justify-center rounded-lg transition-colors",
            sidebar === id
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
        >
          {sidebar === id ? (
            <span className="absolute -left-2 h-5 w-1 rounded-r-full bg-primary" />
          ) : null}
          <Icon className="h-4 w-4" />
        </button>
      ))}

      <div className="mt-auto flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground/60">
        <Sparkles className="h-3.5 w-3.5" />
      </div>
    </nav>
  );
}
