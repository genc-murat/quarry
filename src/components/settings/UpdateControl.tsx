import { CheckCircle2, DownloadCloud, Loader2, RefreshCw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { UpdateState } from "@/lib/updater";
import { cn } from "@/lib/utils";
import { useUpdaterStore } from "@/stores/updater";

/**
 * The updates block of the settings panel. It renders one line of state and the
 * single action that state allows, so there is never a button whose effect the
 * user has to guess at — including the two failure states, where "retry" means
 * checking again after a failed check and installing again after a failed
 * download.
 */
export function UpdateControl() {
  const state = useUpdaterStore((s) => s.state);
  const check = useUpdaterStore((s) => s.check);
  const install = useUpdaterStore((s) => s.install);

  // The browser demo has no shell, so there is nothing to check or install.
  if (state.phase === "unsupported") {
    return (
      <p className="mt-3 text-[11px] text-muted-foreground">
        Updates are delivered by the desktop app; this browser build has no shell to update.
      </p>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-border bg-surface/70 p-2.5">
      <div className="flex items-center gap-2">
        <UpdateIcon phase={state.phase} />
        <p className={cn("min-w-0 flex-1", state.phase === "error" && "text-destructive")}>
          {summarise(state)}
        </p>

        {state.phase === "idle" ? (
          <Button size="xs" variant="outline" onClick={() => void check()}>
            Check
          </Button>
        ) : null}

        {state.phase === "current" ? (
          <Button size="xs" variant="outline" onClick={() => void check()}>
            <RefreshCw className="h-3 w-3" /> Check again
          </Button>
        ) : null}

        {state.phase === "available" ? (
          <Button size="xs" onClick={() => void install()}>
            <DownloadCloud className="h-3 w-3" /> Install
          </Button>
        ) : null}

        {state.phase === "error" ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => void (state.operation === "install" ? install() : check())}
          >
            <RefreshCw className="h-3 w-3" /> Retry
          </Button>
        ) : null}
      </div>

      {state.phase === "downloading" ? (
        <>
          {/* No length from the server means no honest bar — only the byte count. */}
          {state.total ? (
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-border">
              <div
                className="h-full bg-primary"
                style={{ width: `${downloadPercent(state.downloaded, state.total)}%` }}
              />
            </div>
          ) : null}
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            {transfer(state.downloaded, state.total)}
          </p>
        </>
      ) : null}

      {state.phase === "installing" ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Quarry restarts into the new version by itself.
        </p>
      ) : null}

      {state.phase === "error" ? (
        <p className="mt-1.5 break-words text-[11px] text-muted-foreground">{state.message}</p>
      ) : null}

      {state.phase === "available" && state.update.body ? (
        <p className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap text-[11px] text-muted-foreground">
          {state.update.body}
        </p>
      ) : null}
    </div>
  );
}

function UpdateIcon({ phase }: { phase: UpdateState["phase"] }) {
  if (phase === "checking" || phase === "downloading" || phase === "installing") {
    return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />;
  }
  if (phase === "error") {
    return <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-destructive" />;
  }
  return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

function summarise(state: UpdateState): string {
  switch (state.phase) {
    case "checking":
      return "Checking for updates…";
    case "current":
      return "Quarry is up to date.";
    case "available":
      return `Quarry ${state.update.version} is available.`;
    case "downloading":
      return `Downloading Quarry ${state.update.version}…`;
    case "installing":
      return `Installing Quarry ${state.update.version}…`;
    case "error":
      return state.operation === "install"
        ? "The update could not be installed."
        : "The update check failed.";
    default:
      return "Quarry updates itself from its releases.";
  }
}

function downloadPercent(downloaded: number, total: number): number {
  return Math.min(100, Math.round((downloaded / total) * 100));
}

function transfer(downloaded: number, total: number | null): string {
  if (!total) return `${formatBytes(downloaded)} downloaded`;
  return `${formatBytes(downloaded)} of ${formatBytes(total)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
