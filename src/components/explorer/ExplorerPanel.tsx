import { useCallback, useEffect, useRef, useState } from "react";
import {
  Braces,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Copy,
  Database as DatabaseIcon,
  Download,
  ExternalLink,
  FileCode2,
  Hash,
  KeyRound,
  Layers,
  Loader2,
  ListTree,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Server,
  Table2,
  Trash2,
  Unplug,
  XCircle,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ContextMenu, type MenuEntry } from "@/components/ui/context-menu";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { CreateTableDialog } from "@/components/objects/CreateTableDialog";
import { errorMessage, ipc } from "@/lib/ipc";
import { explorerTree, touchExplorerTree } from "@/lib/explorerTree";
import { dialectForDriver, groupObjectsByKind, qualifiedName, type ObjectRef } from "@/lib/objects";
import type {
  ConnectionProfile,
  DatabaseInfo,
  DatabaseObject,
  NamespaceInfo,
  ObjectAction,
  ObjectKind,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { canConnectWithoutPrompt, useWorkspace } from "@/stores/workspace";

const OBJECT_ICON: Record<ObjectKind, typeof Table2> = {
  table: Table2,
  view: FileCode2,
  materializedView: Layers,
  collection: Layers,
  keySpace: KeyRound,
  key: KeyRound,
  function: FileCode2,
  procedure: Braces,
  trigger: Zap,
  event: CalendarClock,
  sequence: KeyRound,
  other: Table2,
};

/**
 * The panel's tree state is mirrored into `explorerTree` (see
 * `@/lib/explorerTree`) so a sidebar switch — which unmounts this component —
 * does not collapse the tree. The cache is pruned per session on disconnect.
 */

/**
 * Cache keys are scoped by session so two servers that happen to expose a
 * database with the same name never share a tree.
 */
function cacheKey(sessionId: string, database: string, namespace: string | null) {
  return `${sessionId}||${database}||${namespace ?? ""}`;
}

/** Drop every cache entry belonging to a session. */
function dropSession<T>(entries: Record<string, T>, sessionId: string): Record<string, T> {
  const prefix = `${sessionId}||`;
  return Object.fromEntries(Object.entries(entries).filter(([key]) => !key.startsWith(prefix)));
}

/** Drop every cache entry belonging to any of `sessionIds`. */
function dropSessions<T>(entries: Record<string, T>, sessionIds: Set<string>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(entries).filter(([key]) => {
      const separator = key.indexOf("||");
      return separator === -1 || !sessionIds.has(key.slice(0, separator));
    }),
  );
}

/**
 * Key of a connection's own root row. It keeps the session prefix (so a
 * disconnect drops it with the rest of the session) but carries no database,
 * which is what tells a root apart from the tree beneath it.
 */
function sessionKey(sessionId: string) {
  return `${sessionId}||`;
}

/** Drop a connection's database/namespace rows while keeping its root row. */
function dropSessionTrees(
  entries: Record<string, boolean>,
  sessionId: string,
): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(entries).filter(([key]) => treeParts(key)?.sessionId !== sessionId),
  );
}

/** The open context menu: an object's, or a connection root's. */
type ExplorerMenu =
  | {
      kind: "object";
      x: number;
      y: number;
      sessionId: string;
      database: string;
      object: DatabaseObject;
    }
  | { kind: "session"; x: number; y: number; sessionId: string }
  | { kind: "profile"; x: number; y: number; profileId: string };

/** Split a cache key; null for a connection root or any key without a database. */
function treeParts(
  key: string,
): { sessionId: string; database: string; namespace: string | null } | null {
  const [sessionId, database = "", namespace = ""] = key.split("||");
  if (!sessionId || !database) return null;
  return { sessionId, database, namespace: namespace || null };
}

export function ExplorerPanel() {
  const activeSessionId = useWorkspace((s) => s.activeSessionId);
  const sessions = useWorkspace((s) => s.sessions);
  const drivers = useWorkspace((s) => s.drivers);
  const databasesBySession = useWorkspace((s) => s.databasesBySession);
  const objectsRevision = useWorkspace((s) => s.objectsRevision);
  const profiles = useWorkspace((s) => s.profiles);
  const rememberedProfileIds = useWorkspace((s) => s.rememberedProfileIds);
  const loadDatabases = useWorkspace((s) => s.loadDatabases);
  const setActiveSession = useWorkspace((s) => s.setActiveSession);
  const connectProfile = useWorkspace((s) => s.connectProfile);
  const forgetProfile = useWorkspace((s) => s.forgetProfile);
  const disconnect = useWorkspace((s) => s.disconnect);
  const loadObjectDetail = useWorkspace((s) => s.loadObjectDetail);
  const openObjectTab = useWorkspace((s) => s.openObjectTab);
  const openObjectDialog = useWorkspace((s) => s.openObjectDialog);
  const openObjectData = useWorkspace((s) => s.openObjectData);
  const openObjectTemplate = useWorkspace((s) => s.openObjectTemplate);
  const pushToast = useWorkspace((s) => s.pushToast);
  const createTable = useWorkspace((s) => s.createTable);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  // A remembered connection being reopened, and the one still waiting for the
  // password the explorer was never given.
  const [connectingProfileId, setConnectingProfileId] = useState<string | null>(null);
  const [passwordFor, setPasswordFor] = useState<ConnectionProfile | null>(null);
  // Which object-kind groups are collapsed. Absent means open, so a freshly
  // loaded database shows every group expanded.
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>(explorerTree.groupOpen);

  const toggleGroup = useCallback((key: string) => {
    setGroupOpen((current) => ({ ...current, [key]: current[key] === false }));
  }, []);

  const [menu, setMenu] = useState<ExplorerMenu | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(explorerTree.expanded);
  const [namespaces, setNamespaces] = useState<Record<string, NamespaceInfo[]>>(
    explorerTree.namespaces,
  );
  const [objects, setObjects] = useState<Record<string, DatabaseObject[]>>(explorerTree.objects);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  // Which connections are being re-read right now, so each root shows its own
  // spinner instead of one panel-wide flag.
  const [refreshing, setRefreshing] = useState<Record<string, boolean>>({});

  // Keep the cache current so a remount restores exactly what was on screen.
  useEffect(() => {
    explorerTree.expanded = expanded;
  }, [expanded]);
  useEffect(() => {
    explorerTree.namespaces = namespaces;
  }, [namespaces]);
  useEffect(() => {
    explorerTree.objects = objects;
  }, [objects]);
  useEffect(() => {
    explorerTree.groupOpen = groupOpen;
  }, [groupOpen]);

  /** The driver descriptor behind a session, for capability-driven affordances. */
  const driverOf = (sessionId: string) =>
    drivers.find((driver) => driver.id === sessions.find((s) => s.id === sessionId)?.driver);
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  // The table wizard and the header toolbar act on the active connection.
  const activeDatabases = activeSessionId ? (databasesBySession[activeSessionId] ?? []) : [];
  const activeDriver = drivers.find((driver) => driver.id === activeSession?.driver);
  const supportsDdl = activeDriver?.capabilities.supportsDdl ?? true;
  const activeQuote = activeDriver?.id === "mysql" ? "`" : '"';

  /**
   * Servers that were open last time but are not open now: a restore that could
   * not run without a password, or a server that was down when the app started.
   * They are offered as dimmed roots so the connection the user had is still
   * one click away instead of being hidden in the connection list.
   */
  const pendingProfiles = rememberedProfileIds
    .map((id) => profiles.find((profile) => profile.id === id))
    .filter((profile): profile is ConnectionProfile => Boolean(profile))
    .filter((profile) => !sessions.some((session) => session.profileId === profile.id));

  /** Reopen a remembered connection, asking for a password only when needed. */
  async function reopenProfile(profile: ConnectionProfile) {
    if (!canConnectWithoutPrompt(profile, drivers)) {
      setPasswordFor(profile);
      return;
    }
    setConnectingProfileId(profile.id);
    await connectProfile(profile.id);
    setConnectingProfileId(null);
  }

  const loadObjectsFor = useCallback(
    async (sessionId: string, database: string, namespace: string | null) => {
      // Reading a tree's data makes it the most recently viewed one.
      touchExplorerTree(sessionId, database);
      const key = cacheKey(sessionId, database, namespace);
      setLoading((l) => ({ ...l, [key]: true }));
      try {
        const result = await ipc.listObjects(sessionId, database, namespace);
        setObjects((o) => ({ ...o, [key]: result }));
      } catch (error) {
        pushToast({
          title: "Could not load objects",
          description: errorMessage(error),
          variant: "error",
        });
      } finally {
        setLoading((l) => ({ ...l, [key]: false }));
      }
    },
    [pushToast],
  );

  // Re-read every node the user currently has expanded — across every open
  // connection — so objects created by another client (or a table added
  // out-of-band) show up without a manual Refresh. Shared by the
  // focus/visibility handler and the mutation-revision effect below.
  const refreshExpanded = useCallback(async () => {
    const openTrees = Object.keys(expanded)
      .filter((key) => expanded[key])
      .map((key) => treeParts(key))
      .filter((parts): parts is NonNullable<typeof parts> => parts !== null);
    if (openTrees.length === 0) return;
    // Drop the cached nodes of every connection being re-read, so a database
    // dropped server-side does not linger in the tree.
    const stale = new Set(openTrees.map((parts) => parts.sessionId));
    setObjects((o) => dropSessions(o, stale));
    setNamespaces((n) => dropSessions(n, stale));
    for (const { sessionId, database, namespace } of openTrees) {
      if (namespace) {
        await loadObjectsFor(sessionId, database, namespace);
        continue;
      }
      try {
        const list = await ipc.listNamespaces(sessionId, database);
        setNamespaces((n) => ({ ...n, [cacheKey(sessionId, database, null)]: list }));
        if (list.length === 0) await loadObjectsFor(sessionId, database, null);
      } catch {
        // Best effort — a dropped database simply disappears on next refresh.
      }
    }
  }, [expanded, loadObjectsFor]);

  // Every open connection contributes a root node, so each one's database list
  // is read once — not only the active session's.
  useEffect(() => {
    for (const entry of sessions) {
      if (!databasesBySession[entry.id]) void loadDatabases(entry.id);
    }
  }, [sessions, databasesBySession, loadDatabases]);

  // The list is cached, so it can go stale while the window is in the
  // background (another client created a database, etc.). Re-read it on focus,
  // coalescing the burst of focus/visibility events a single switch produces.
  const lastFocusRefresh = useRef(0);
  useEffect(() => {
    if (sessions.length === 0) return;
    const refreshIfVisible = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastFocusRefresh.current < 1500) return;
      lastFocusRefresh.current = now;
      for (const entry of sessions) void loadDatabases(entry.id);
      // Also re-read the tables/views inside every expanded node.
      void refreshExpanded();
    };
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [sessions, loadDatabases, refreshExpanded]);

  // A mutation elsewhere (rename/drop/column edit/row edit) bumps the revision;
  // refetch every expanded node so the tree never shows a stale table.
  const seenRevision = useRef(objectsRevision);
  useEffect(() => {
    if (seenRevision.current === objectsRevision) return;
    seenRevision.current = objectsRevision;
    void refreshExpanded();
  }, [objectsRevision, refreshExpanded]);

  // A connection's root row is open by default: connecting to several servers
  // should show every one of them without a click each.
  const toggleSession = useCallback((sessionId: string) => {
    const key = sessionKey(sessionId);
    setExpanded((e) => ({ ...e, [key]: e[key] === false }));
  }, []);

  const toggleDatabase = useCallback(
    async (sessionId: string, database: DatabaseInfo) => {
      // Opening a database counts as viewing its tree (drivers without a schema
      // layer still list namespaces here).
      touchExplorerTree(sessionId, database.name);
      const key = cacheKey(sessionId, database.name, null);
      const wasOpen = expanded[key];
      setExpanded((e) => ({ ...e, [key]: !wasOpen }));
      if (wasOpen) return;
      if (namespaces[key]) return;
      try {
        const result = await ipc.listNamespaces(sessionId, database.name);
        setNamespaces((n) => ({ ...n, [key]: result }));
        // Drivers without a schema layer (e.g. MySQL) expose objects directly.
        if (result.length === 0) {
          await loadObjectsFor(sessionId, database.name, null);
        }
      } catch (error) {
        pushToast({
          title: "Could not load namespaces",
          description: errorMessage(error),
          variant: "error",
        });
      }
    },
    [expanded, namespaces, loadObjectsFor, pushToast],
  );

  const toggleNamespace = useCallback(
    async (sessionId: string, database: string, namespace: string) => {
      const key = cacheKey(sessionId, database, namespace);
      const wasOpen = expanded[key];
      setExpanded((e) => ({ ...e, [key]: !wasOpen }));
      if (wasOpen || objects[key]) return;
      await loadObjectsFor(sessionId, database, namespace);
    },
    [expanded, objects, loadObjectsFor],
  );

  /**
   * Re-read one connection: its tree is invalidated first so a table created by
   * another client actually shows up, then its database list is fetched again.
   * The connection's own root row stays open and every other server is left
   * untouched, so refreshing one does not cost a round trip per connection.
   */
  const refreshSession = useCallback(
    async (sessionId: string) => {
      setRefreshing((r) => ({ ...r, [sessionId]: true }));
      setNamespaces((n) => dropSession(n, sessionId));
      setObjects((o) => dropSession(o, sessionId));
      setLoading((l) => dropSession(l, sessionId));
      setExpanded((e) => dropSessionTrees(e, sessionId));
      try {
        await loadDatabases(sessionId);
      } finally {
        setRefreshing((r) => ({ ...r, [sessionId]: false }));
      }
    },
    [loadDatabases],
  );

  const refresh = useCallback(async () => {
    await Promise.all(sessions.map((entry) => refreshSession(entry.id)));
  }, [sessions, refreshSession]);

  /** The dialect's identifier quote, which also picks the maintenance verbs. */
  const quoteFor = (sessionId: string) => (driverOf(sessionId)?.id === "mysql" ? "`" : '"');

  function refFor(sessionId: string, database: string, object: DatabaseObject): ObjectRef {
    return {
      sessionId,
      database,
      namespace: object.schema ?? null,
      object: object.name,
      objectKind: object.kind,
    };
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      pushToast({ title: `${label} copied`, variant: "success" });
    } catch (error) {
      pushToast({ title: "Clipboard unavailable", description: errorMessage(error), variant: "error" });
    }
  }

  async function countRows(sessionId: string, database: string, object: DatabaseObject) {
    try {
      const count = await ipc.countRows(sessionId, database, object.schema ?? null, object.name);
      pushToast({ title: `${object.name}: ${count} rows`, variant: "info" });
    } catch (error) {
      pushToast({ title: "Count failed", description: errorMessage(error), variant: "error" });
    }
  }

  async function copyDdl(ref: ObjectRef) {
    const detail = await loadObjectDetail(ref);
    if (detail) await copy(detail.ddl, "DDL");
  }

  /**
   * What right-clicking a connection root offers. It mirrors the panel's own
   * per-connection actions, so one server can be re-read or closed without
   * touching the others (a disconnect only ever closes this session).
   */
  function sessionMenuEntries(sessionId: string): MenuEntry[] {
    const target = sessions.find((s) => s.id === sessionId);
    if (!target) return [];
    return [
      { type: "label", label: target.name },
      {
        label: "Refresh",
        icon: <RefreshCw className="h-3.5 w-3.5" />,
        onSelect: () => void refreshSession(sessionId),
      },
      ...(target.id === activeSessionId
        ? []
        : [
            {
              label: "Make active",
              icon: <Plug className="h-3.5 w-3.5" />,
              onSelect: () => setActiveSession(target.id),
            },
          ]),
      { type: "separator" },
      {
        label: "Disconnect",
        icon: <Unplug className="h-3.5 w-3.5" />,
        danger: true,
        onSelect: () => void disconnect(target.id),
      },
    ];
  }

  /** What right-clicking a dimmed, remembered connection offers. */
  function profileMenuEntries(profileId: string): MenuEntry[] {
    const profile = profiles.find((candidate) => candidate.id === profileId);
    if (!profile) return [];
    return [
      { type: "label", label: profile.name },
      { type: "label", label: "not connected" },
      {
        label: "Connect",
        icon: <Plug className="h-3.5 w-3.5" />,
        onSelect: () => void reopenProfile(profile),
      },
      { type: "separator" },
      {
        label: "Forget",
        icon: <XCircle className="h-3.5 w-3.5" />,
        danger: true,
        onSelect: () => forgetProfile(profile.id),
      },
    ];
  }

  function objectMenuEntries(
    sessionId: string,
    database: string,
    object: DatabaseObject,
  ): MenuEntry[] {
    const ref = refFor(sessionId, database, object);
    const capabilities = driverOf(sessionId)?.capabilities;
    // SQL-only affordances (qualified names, DDL, query templates) are hidden
    // for non-relational drivers such as Redis.
    const relational = capabilities?.isRelational ?? true;
    const quote = quoteFor(sessionId);
    const supports = (action: ObjectAction) => capabilities?.supportedActions.includes(action) ?? false;
    const isTable = object.kind === "table";
    const trigger = object.kind === "trigger";
    const canObjectAction = (action: ObjectAction) =>
      supports(action) && (!trigger || action === "dropObject");
    const maintenance: ("optimize" | "analyze" | "vacuum")[] =
      quote === "`" ? ["optimize", "analyze"] : ["vacuum", "analyze"];

    const entries: MenuEntry[] = [
      { type: "label", label: `${object.kind}: ${object.name}` },
      ...(supports("inspect")
        ? [
            {
              label: "Inspect structure",
              icon: <Table2 className="h-3.5 w-3.5" />,
              onSelect: () => openObjectTab(ref),
            },
          ]
        : []),
      ...(supports("viewData")
        ? [
            {
              label: "View data",
              icon: <ExternalLink className="h-3.5 w-3.5" />,
              onSelect: () => void openObjectData(ref),
            },
          ]
        : []),
      ...(supports("countRows") && isTable
        ? [
            {
              label: "Count rows",
              icon: <Hash className="h-3.5 w-3.5" />,
              onSelect: () => void countRows(sessionId, database, object),
            },
          ]
        : []),
      { type: "separator" },
      { type: "label", label: "Copy" },
      { label: "Copy name", icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => void copy(object.name, "Name") },
      ...(relational && !trigger
        ? [
            {
              label: "Copy qualified name",
              icon: <Copy className="h-3.5 w-3.5" />,
              onSelect: () =>
                void copy(
                  qualifiedName(
                    { database, namespace: object.schema ?? null, object: object.name },
                    quote,
                  ),
                  "Qualified name",
                ),
            },
            {
              label: "Copy DDL",
              icon: <Copy className="h-3.5 w-3.5" />,
              onSelect: () => void copyDdl(ref),
            },
            { type: "separator" } as MenuEntry,
            { type: "label", label: "Templates" } as MenuEntry,
            { label: "SELECT", onSelect: () => void openObjectTemplate(ref, "select") },
            { label: "INSERT", onSelect: () => void openObjectTemplate(ref, "insert") },
            { label: "UPDATE", onSelect: () => void openObjectTemplate(ref, "update") },
            { label: "DELETE", onSelect: () => void openObjectTemplate(ref, "delete") },
          ]
        : []),
      ...(!trigger && supports("exportData")
        ? [
            {
              label: "Export…",
              icon: <Download className="h-3.5 w-3.5" />,
              onSelect: () => openObjectDialog({ ref, kind: "export" }),
            },
          ]
        : []),
      { type: "separator" },
      { type: "label", label: "Structure" },
      ...(!trigger && supports("createIndex")
        ? [
            {
              label: "Create index…",
              icon: <Plus className="h-3.5 w-3.5" />,
              onSelect: () => openObjectDialog({ ref, kind: "index" }),
            },
          ]
        : []),
      ...(!trigger && supports("addColumn")
        ? [
            {
              label: "Add column…",
              icon: <Plus className="h-3.5 w-3.5" />,
              onSelect: () => openObjectDialog({ ref, kind: "addColumn" }),
            },
          ]
        : []),
      ...(!trigger && supports("renameObject")
        ? [
            {
              label: "Rename…",
              icon: <Pencil className="h-3.5 w-3.5" />,
              onSelect: () => openObjectDialog({ ref, kind: "rename" }),
            },
          ]
        : []),
      ...(!trigger && supports("duplicateObject")
        ? [
            {
              label: "Duplicate…",
              onSelect: () => openObjectDialog({ ref, kind: "duplicate" }),
            },
          ]
        : []),
      ...(!trigger && supports("maintenance")
        ? maintenance.map((kind) => ({
            label: `Maintenance: ${kind}`,
            icon: <ListTree className="h-3.5 w-3.5" />,
            onSelect: () => openObjectDialog({ ref, kind: "maintenance", maintenance: kind }),
          }))
        : []),
      ...(!trigger && supports("reindex")
        ? [{ label: "Reindex", onSelect: () => openObjectDialog({ ref, kind: "reindex" }) }]
        : []),
      { type: "separator" },
      { type: "label", label: "Danger" },
      ...(!trigger && supports("truncate") && isTable
        ? [
            {
              label: "Truncate…",
              icon: <Trash2 className="h-3.5 w-3.5" />,
              danger: true,
              onSelect: () => openObjectDialog({ ref, kind: "truncate" }),
            },
          ]
        : []),
      ...(canObjectAction("dropObject")
        ? [
            {
              label: `Drop ${object.kind}…`,
              icon: <Trash2 className="h-3.5 w-3.5" />,
              danger: true,
              onSelect: () => openObjectDialog({ ref, kind: "drop" }),
            },
          ]
        : []),
    ];
    return entries;
  }

  if (sessions.length === 0 && pendingProfiles.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <DatabaseIcon className="h-6 w-6 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          Connect to a server to browse its schemas and tables.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-2 px-3 py-2.5">
        <div className="min-w-0">
          <h2 className="truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Explorer
          </h2>
          <p className="truncate text-[11px] text-muted-foreground/80">
            {sessions.length === 1 ? "1 connection" : `${sessions.length} connections`}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {supportsDdl ? (
            <Button
              size="icon-sm"
              variant="ghost"
              title={activeSession ? `New table on ${activeSession.name}` : "New table"}
              disabled={!activeSessionId}
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          ) : null}
          <Button
            size="icon-sm"
            variant="ghost"
            title="Refresh all connections"
            aria-label="Refresh all connections"
            onClick={refresh}
          >
            <RefreshCw
              className={cn(
                "h-3.5 w-3.5",
                sessions.some((entry) => refreshing[entry.id]) && "animate-spin",
              )}
            />
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-1.5 pb-3 text-sm">
        {/* One root per open connection: every server you are connected to is
            browsable at once, not only the active session. */}
        {sessions.map((entry) => {
          const rootOpen = expanded[sessionKey(entry.id)] !== false;
          const databases = databasesBySession[entry.id] ?? [];
          // True only until this connection's databases have been fetched once;
          // the list is then cached, so the tree never flashes an empty node.
          const databasesPending = !databasesBySession[entry.id];
          const isActive = entry.id === activeSessionId;
          const accent =
            drivers.find((driver) => driver.id === entry.driver)?.accentColor ?? "var(--primary)";
          return (
            <div key={entry.id} className="mb-1">
              <div
                className="flex items-center gap-1 rounded-md pr-1 hover:bg-accent/60"
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({
                    kind: "session",
                    x: event.clientX,
                    y: event.clientY,
                    sessionId: entry.id,
                  });
                }}
              >
                <button
                  onClick={() => toggleSession(entry.id)}
                  aria-expanded={rootOpen}
                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left"
                >
                  {rootOpen ? (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <Server className="h-3.5 w-3.5 shrink-0" style={{ color: accent }} />
                  <span className={cn("truncate", isActive ? "font-semibold" : "font-medium")}>
                    {entry.name}
                  </span>
                  {isActive ? (
                    <span className="shrink-0 rounded bg-primary/15 px-1 text-[10px] font-medium text-primary">
                      active
                    </span>
                  ) : null}
                </button>
                {refreshing[entry.id] ? (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <button
                    onClick={() => void refreshSession(entry.id)}
                    title={`Refresh ${entry.name}`}
                    aria-label={`Refresh ${entry.name}`}
                    className="shrink-0 rounded p-0.5 text-muted-foreground/60 hover:text-foreground"
                  >
                    <RefreshCw className="h-3 w-3" />
                  </button>
                )}
                {isActive ? null : (
                  <button
                    onClick={() => setActiveSession(entry.id)}
                    title={`Make ${entry.name} the active connection`}
                    aria-label={`Make ${entry.name} the active connection`}
                    className="shrink-0 rounded p-0.5 text-muted-foreground/60 hover:text-foreground"
                  >
                    <Plug className="h-3 w-3" />
                  </button>
                )}
              </div>
              <p className="truncate pl-7 text-[11px] text-muted-foreground/70">
                {entry.driver}
                {entry.server.version ? ` · ${entry.server.version}` : ""}
              </p>

              {rootOpen ? (
                <div className="pl-2">
                  {databasesPending ? (
                    <div className="flex items-center gap-2 py-1 pl-4 text-[11px] text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" /> loading databases…
                    </div>
                  ) : null}

                  {!databasesPending && databases.length === 0 ? (
                    <p className="py-1 pl-4 text-[11px] text-muted-foreground/70">no databases</p>
                  ) : null}

                  {databases.map((database) => {
                    const dbKey = cacheKey(entry.id, database.name, null);
                    const dbOpen = expanded[dbKey];
                    const dbNamespaces = namespaces[dbKey] ?? [];
                    return (
                      <div key={database.name}>
                        <button
                          onClick={() => toggleDatabase(entry.id, database)}
                          className="group flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-accent/60"
                        >
                          {dbOpen ? (
                            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                          <DatabaseIcon className="h-3.5 w-3.5 text-primary" />
                          <span className="truncate">{database.name}</span>
                          {database.isSystem ? (
                            <span className="ml-auto text-[10px] text-muted-foreground/70">
                              system
                            </span>
                          ) : null}
                        </button>

                        {dbOpen && dbNamespaces.length === 0 ? (
                          <ObjectList
                            containerKey={dbKey}
                            objects={objects[dbKey]}
                            loading={loading[dbKey]}
                            open={groupOpen}
                            onToggle={toggleGroup}
                            onActivate={(object) =>
                              openObjectTab(refFor(entry.id, database.name, object))
                            }
                            onContextMenu={(object, event) =>
                              setMenu({
                                kind: "object",
                                x: event.clientX,
                                y: event.clientY,
                                sessionId: entry.id,
                                database: database.name,
                                object,
                              })
                            }
                          />
                        ) : null}

                        {dbOpen
                          ? dbNamespaces.map((namespace) => {
                              const key = cacheKey(entry.id, database.name, namespace.name);
                              const nsOpen = expanded[key];
                              return (
                                <div key={key}>
                                  <button
                                    onClick={() =>
                                      toggleNamespace(entry.id, database.name, namespace.name)
                                    }
                                    className="flex w-full items-center gap-1.5 rounded-md py-1 pl-5 pr-1.5 text-left hover:bg-accent/60"
                                  >
                                    {nsOpen ? (
                                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                                    ) : (
                                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                                    )}
                                    <Layers className="h-3.5 w-3.5 text-secondary-foreground/70" />
                                    <span className="truncate">{namespace.name}</span>
                                  </button>
                                  {nsOpen ? (
                                    <ObjectList
                                      containerKey={key}
                                      objects={objects[key]}
                                      loading={loading[key]}
                                      open={groupOpen}
                                      onToggle={toggleGroup}
                                      onActivate={(object) =>
                                        openObjectTab(refFor(entry.id, database.name, object))
                                      }
                                      onContextMenu={(object, event) =>
                                        setMenu({
                                          kind: "object",
                                          x: event.clientX,
                                          y: event.clientY,
                                          sessionId: entry.id,
                                          database: database.name,
                                          object,
                                        })
                                      }
                                    />
                                  ) : null}
                                </div>
                              );
                            })
                          : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}

        {/* Remembered servers that are not open: a click reopens one. */}
        {pendingProfiles.map((profile) => {
          const accent =
            drivers.find((driver) => driver.id === profile.driver)?.accentColor ?? "var(--primary)";
          const connecting = connectingProfileId === profile.id;
          return (
            <div
              key={profile.id}
              className="mb-1"
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({
                  kind: "profile",
                  x: event.clientX,
                  y: event.clientY,
                  profileId: profile.id,
                });
              }}
            >
              <div className="flex items-center gap-1 rounded-md pr-1 hover:bg-accent/60">
                <button
                  onClick={() => void reopenProfile(profile)}
                  title={`Connect to ${profile.name}`}
                  aria-label={`Connect to ${profile.name}`}
                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-muted-foreground"
                >
                  {connecting ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                  ) : (
                    <Plug className="h-3.5 w-3.5 shrink-0 opacity-60" style={{ color: accent }} />
                  )}
                  <span className="truncate font-medium">{profile.name}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground/70">was open</span>
                </button>
              </div>
              <p className="truncate pl-7 text-[11px] text-muted-foreground/60">
                {profile.driver} · not connected
              </p>
            </div>
          );
        })}
      </div>

      {menu ? (
        <ContextMenu
          entries={
            menu.kind === "session"
              ? sessionMenuEntries(menu.sessionId)
              : menu.kind === "profile"
                ? profileMenuEntries(menu.profileId)
                : objectMenuEntries(menu.sessionId, menu.database, menu.object)
          }
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {passwordFor ? (
        <ConnectDialog
          profile={passwordFor}
          busy={connectingProfileId === passwordFor.id}
          onClose={() => setPasswordFor(null)}
          onSubmit={async (password) => {
            setConnectingProfileId(passwordFor.id);
            const session = await connectProfile(passwordFor.id, password || undefined);
            setConnectingProfileId(null);
            // A failed attempt keeps the dialog open so the password can be
            // corrected instead of starting over.
            if (session) setPasswordFor(null);
          }}
        />
      ) : null}

      <CreateTableDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        sessionId={activeSessionId ?? ""}
        databases={activeDatabases.map((database) => database.name)}
        defaultDatabase={
          activeDatabases[0]?.name ?? activeSession?.server.currentDatabase ?? ""
        }
        quote={activeQuote}
        dialect={dialectForDriver(activeSession?.driver)}
        busy={creating}
        onRun={async (request) => {
          setCreating(true);
          const ok = await createTable(request);
          setCreating(false);
          if (ok) setCreateOpen(false);
        }}
      />
    </div>
  );
}

/**
 * The one thing the explorer needs from the user before it can open a server it
 * remembers: the password it was never given. Typing it here stores it with the
 * connection — the same thing the connection dialog does — which is what lets
 * the next launch reopen this server without asking.
 */
function ConnectDialog({
  profile,
  busy,
  onSubmit,
  onClose,
}: {
  profile: ConnectionProfile;
  busy: boolean;
  onSubmit: (password: string) => void;
  onClose: () => void;
}) {
  const [password, setPassword] = useState("");

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Connect to ${profile.name}`}
      description={`${profile.driver} · ${profile.username}@${profile.host}:${profile.port}`}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" disabled={busy} onClick={() => onSubmit(password)}>
            {busy ? "Connecting…" : "Connect"}
          </Button>
        </>
      }
    >
      <Label htmlFor="connect-password" className="mb-2 block">
        Password
      </Label>
      <Input
        id="connect-password"
        type="password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !busy) onSubmit(password);
        }}
      />
      <p className="mt-2 text-[11px] text-muted-foreground">
        Saved with the connection, so this server can be reopened on the next launch.
      </p>
    </Dialog>
  );
}

function ObjectList({
  containerKey,
  objects,
  loading,
  open,
  onToggle,
  onActivate,
  onContextMenu,
}: {
  /** Identifies the database/namespace this list belongs to (for group keys). */
  containerKey: string;
  objects?: DatabaseObject[];
  loading?: boolean;
  open: Record<string, boolean>;
  onToggle: (key: string) => void;
  onActivate: (object: DatabaseObject) => void;
  onContextMenu: (object: DatabaseObject, event: React.MouseEvent) => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 py-1 pl-9 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> loading…
      </div>
    );
  }
  if (!objects) return null;
  if (objects.length === 0) {
    return <p className="py-1 pl-9 text-[11px] text-muted-foreground/70">empty</p>;
  }

  const groups = groupObjectsByKind(objects);

  return (
    <div>
      {groups.map((group) => {
        const groupKey = `${containerKey}#${group.kind}`;
        const isOpen = open[groupKey] !== false;
        const GroupIcon = OBJECT_ICON[group.kind] ?? Table2;
        return (
          <div key={group.kind}>
            <button
              onClick={() => onToggle(groupKey)}
              title={`${group.objects.length} ${group.label.toLowerCase()}`}
              className="flex w-full items-center gap-1.5 rounded-md py-1 pl-6 pr-1.5 text-left hover:bg-accent/60"
            >
              {isOpen ? (
                <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
              )}
              <GroupIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80" />
              <span className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {group.label}
              </span>
              <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
                {group.objects.length}
              </span>
            </button>

            {isOpen
              ? group.objects.map((object) => {
                  const Icon = OBJECT_ICON[object.kind] ?? Table2;
                  return (
                    <button
                      key={`${object.schema ?? ""}.${object.name}`}
                      onClick={() => onActivate(object)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        onContextMenu(object, event);
                      }}
                      title={object.comment ?? object.name}
                      className="flex w-full items-center gap-1.5 rounded-md py-1 pl-12 pr-1.5 text-left hover:bg-accent/60"
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{object.name}</span>
                      {object.rowEstimate ? (
                        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/60">
                          ~{object.rowEstimate}
                        </span>
                      ) : null}
                    </button>
                  );
                })
              : null}
          </div>
        );
      })}
    </div>
  );
}
