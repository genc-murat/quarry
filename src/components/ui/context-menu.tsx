import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

export interface MenuEntry {
  /** `item` (default) is clickable, `separator` is a divider, `label` is a header. */
  type?: "item" | "separator" | "label";
  label?: string;
  icon?: React.ReactNode;
  hint?: string;
  onSelect?: () => void;
  disabled?: boolean;
  danger?: boolean;
}

interface Props {
  entries: MenuEntry[];
  x: number;
  y: number;
  onClose: () => void;
}

const WIDTH = 248;
const ROW_HEIGHT = 30;

/**
 * A lightweight right-click menu. Positioned with fixed coordinates and clamped
 * to the viewport; closes on outside click, Escape or scroll.
 */
export function ContextMenu({ entries, x, y, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const height = entries.length * ROW_HEIGHT + 12;
  const left = Math.max(8, Math.min(x, window.innerWidth - WIDTH - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - height - 8));

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left, top, width: WIDTH }}
      className="animate-fade-in fixed z-50 max-h-[80vh] overflow-y-auto rounded-lg border border-border bg-card py-1 shadow-2xl"
    >
      {entries.map((entry, index) => {
        if (entry.type === "separator") {
          return <div key={index} className="my-1 border-t border-border/70" />;
        }
        if (entry.type === "label") {
          return (
            <div
              key={index}
              className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {entry.label}
            </div>
          );
        }
        return (
          <button
            key={index}
            role="menuitem"
            disabled={entry.disabled}
            onClick={() => {
              entry.onSelect?.();
              onClose();
            }}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors",
              entry.disabled
                ? "cursor-not-allowed text-muted-foreground/50"
                : entry.danger
                  ? "text-destructive hover:bg-destructive/10"
                  : "text-foreground hover:bg-accent",
            )}
          >
            <span className="flex h-4 w-4 items-center justify-center">{entry.icon}</span>
            <span className="truncate">{entry.label}</span>
            {entry.hint ? (
              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">
                {entry.hint}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
