import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, Waypoints, X } from "lucide-react";

import { isTauri } from "@/lib/ipc";

async function withWindow(action: (win: ReturnType<typeof getCurrentWindow>) => Promise<void>) {
  if (!isTauri()) return;
  try {
    await action(getCurrentWindow());
  } catch {
    // Window controls are best-effort.
  }
}

export function TitleBar() {
  return (
    <div
      data-tauri-drag-region
      className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-surface pl-3 select-none"
    >
      <div data-tauri-drag-region className="flex items-center gap-2 text-xs font-medium">
        <span className="flex h-5 w-5 items-center justify-center rounded bg-primary text-primary-foreground">
          <Waypoints className="h-3 w-3" />
        </span>
        <span className="text-foreground/90">Quarry</span>
        <span className="text-muted-foreground">Database Studio</span>
      </div>

      <div className="flex items-center">
        <button
          onClick={() => withWindow((w) => w.minimize())}
          className="flex h-9 w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Minimize"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => withWindow((w) => w.toggleMaximize())}
          className="flex h-9 w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Maximize"
        >
          <Square className="h-3 w-3" />
        </button>
        <button
          onClick={() => withWindow((w) => w.close())}
          className="flex h-9 w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
          aria-label="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
