import { useState } from "react";
import { Loader2, Pencil, Plug, Plus, ShieldCheck, Trash2 } from "lucide-react";

import { ConnectionDialog } from "@/components/connections/ConnectionDialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ConnectionProfile } from "@/lib/types";
import { useWorkspace } from "@/stores/workspace";

export function ConnectionList() {
  const profiles = useWorkspace((s) => s.profiles);
  const sessions = useWorkspace((s) => s.sessions);
  const drivers = useWorkspace((s) => s.drivers);
  const connect = useWorkspace((s) => s.connect);
  const disconnect = useWorkspace((s) => s.disconnect);
  const deleteConnection = useWorkspace((s) => s.deleteConnection);
  const setActiveSession = useWorkspace((s) => s.setActiveSession);
  const activeSessionId = useWorkspace((s) => s.activeSessionId);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ConnectionProfile | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);

  const accentFor = (driverId: string) =>
    drivers.find((d) => d.id === driverId)?.accentColor ?? "var(--primary)";

  const sessionForProfile = (profileId: string) =>
    sessions.find((s) => s.profileId === profileId);

  // Server drivers show `user@host:port`; file-backed ones (SQLite) show the
  // file path. Detected from the driver's own form, so no driver id is hardcoded.
  const endpointFor = (profile: ConnectionProfile) => {
    const driver = drivers.find((d) => d.id === profile.driver);
    const serverBased = driver?.configFields.some((field) => field.key === "host") ?? true;
    if (!serverBased) {
      const path = profile.options?.path;
      return typeof path === "string" && path ? path : (driver?.displayName ?? profile.driver);
    }
    return `${profile.username}@${profile.host}:${profile.port}${
      profile.database ? `/${profile.database}` : ""
    }`;
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between px-3 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Connections
        </h2>
        <Button
          size="icon-sm"
          variant="ghost"
          title="New connection"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </header>

      <div className="flex-1 space-y-2 overflow-y-auto px-2 pb-3">
        {profiles.length === 0 ? (
          <div className="mx-1 mt-6 rounded-lg border border-dashed border-border p-4 text-center">
            <p className="text-xs text-muted-foreground">
              No connections yet. Add a MySQL 5.6, PostgreSQL, SQLite or Redis server to get
              started.
            </p>
            <Button
              size="sm"
              className="mt-3"
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              New connection
            </Button>
          </div>
        ) : null}

        {profiles.map((profile) => {
          const session = sessionForProfile(profile.id);
          const accent = accentFor(profile.driver);
          const isActive = session && session.id === activeSessionId;
          return (
            <div
              key={profile.id}
              className={cn(
                "group rounded-lg border bg-card p-2.5 transition-colors",
                isActive ? "border-primary/60" : "border-border hover:border-border/80",
              )}
            >
              <div className="flex items-start gap-2">
                <span
                  className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: accent }}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{profile.name}</p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {endpointFor(profile)}
                  </p>
                  <div className="mt-1 flex items-center gap-1.5">
                    {profile.hasPassword ? (
                      <span className="inline-flex items-center gap-1 text-[10px] text-success">
                        <ShieldCheck className="h-3 w-3" /> encrypted
                      </span>
                    ) : null}
                    {session ? (
                      <button
                        onClick={() => setActiveSession(session.id)}
                        className="text-[10px] font-medium text-success hover:underline"
                      >
                        connected{session.server.version ? ` · ${session.server.version}` : ""}
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="mt-2 flex items-center gap-1">
                {session ? (
                  <Button
                    size="xs"
                    variant="secondary"
                    className="flex-1"
                    onClick={() => disconnect(session.id)}
                  >
                    Disconnect
                  </Button>
                ) : (
                  <Button
                    size="xs"
                    className="flex-1"
                    disabled={connecting === profile.id}
                    onClick={async () => {
                      setConnecting(profile.id);
                      await connect({ profileId: profile.id }, profile.name);
                      setConnecting(null);
                    }}
                  >
                    {connecting === profile.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Plug className="h-3 w-3" />
                    )}
                    Connect
                  </Button>
                )}
                <Button
                  size="icon-sm"
                  variant="ghost"
                  title="Edit"
                  onClick={() => {
                    setEditing(profile);
                    setDialogOpen(true);
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  title="Delete"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => deleteConnection(profile.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <ConnectionDialog
        open={dialogOpen}
        editing={editing}
        onClose={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
      />
    </div>
  );
}
