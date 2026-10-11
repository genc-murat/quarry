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
  Plus,
  RefreshCw,
  Table2,
  Trash2,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ContextMenu, type MenuEntry } from "@/components/ui/context-menu";
import { CreateTableDialog } from "@/components/objects/CreateTableDialog";
import { errorMessage, ipc } from "@/lib/ipc";
import { explorerTree, touchExplorerTree } from "@/lib/explorerTree";
import { dialectForDriver, groupObjectsByKind, qualifiedName, type ObjectRef } from "@/lib/objects";
import type { DatabaseInfo, DatabaseObject, NamespaceInfo, ObjectAction, ObjectKind } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/stores/workspace";

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

export function ExplorerPanel() {
  const activeSessionId = useWorkspace((s) => s.activeSessionId);
  const sessions = useWorkspace((s) => s.sessions);
  const drivers = useWorkspace((s) => s.drivers);
  const databasesBySession = useWorkspace((s) => s.databasesBySession);
  const objectsRevision = useWorkspace((s) => s.objectsRevision);
  const loadDatabases = useWorkspace((s) => s.loadDatabases);
  const loadObjectDetail = useWorkspace((s) => s.loadObjectDetail);
  const openObjectTab = useWorkspace((s) => s.openObjectTab);
  const openObjectDialog = useWorkspace((s) => s.openObjectDialog);
  const openObjectData = useWorkspace((s) => s.openObjectData);
  const openObjectTemplate = useWorkspace((s) => s.openObjectTemplate);
  const pushToast = useWorkspace((s) => s.pushToast);
  const createTable = useWorkspace((s) => s.createTable);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  // Which object-kind groups are collapsed. Absent means open, so a freshly
  // loaded database shows every group expanded.
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>(explorerTree.groupOpen);

  const toggleGroup = useCallback((key: string) => {
    setGroupOpen((current) => ({ ...current, [key]: current[key] === false }));
  }, []);

  const [menu, setMenu] = useState<{ x: number; y: number; database: string; object: DatabaseObject } | null>(
    null,
  );
  const [expanded, setExpanded] = useState<Record<string, boolean>>(explorerTree.expanded);
  const [namespaces, setNamespaces] = useState<Record<string, NamespaceInfo[]>>(
    explorerTree.namespaces,
  );
  const [objects, setObjects] = useState<Record<string, DatabaseObject[]>>(explorerTree.objects);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [refreshing, setRefreshing] = useState(false);

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

  const session = sessions.find((s) => s.id === activeSessionId) ?? null;
  const sessionId = session?.id ?? null;
  const databases = sessionId ? (databasesBySession[sessionId] ?? []) : [];
  // True only until this session's databases have been fetched once; the list
  // is then cached, so returning to the explorer never flashes an empty panel.
  const databasesPending = Boolean(sessionId) && !databasesBySession[sessionId ?? ""];

  const loadObjectsFor = useCallback(
    async (database: string, namespace: string | null) => {
      if (!sessionId) return;
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
    [sessionId, pushToast],
  );

  // Re-read every node the user currently has expanded, so objects created by
  // another client (or a table added out-of-band) show up without a manual
  // Refresh. Shared by the focus/visibility handler and the mutation-revision
  // effect below.
  const refreshExpanded = useCallback(async () => {
    if (!sessionId) return;
    const openKeys = Object.keys(expanded).filter(
      (key) => expanded[key] && key.startsWith(`${sessionId}||`),
    );
    setObjects((o) => dropSession(o, sessionId));
    setNamespaces((n) => dropSession(n, sessionId));
    for (const key of openKeys) {
      const [, database, namespace] = key.split("||");
      if (namespace) {
        await loadObjectsFor(database, namespace);
      } else {
        try {
          const list = await ipc.listNamespaces(sessionId, database);
          setNamespaces((n) => ({ ...n, [key]: list }));
          if (list.length === 0) await loadObjectsFor(database, null);
        } catch {
          // Best effort — a dropped database simply disappears on next refresh.
        }
      }
    }
  }, [sessionId, expanded, loadObjectsFor]);

  useEffect(() => {
    if (sessionId && !databasesBySession[sessionId]) void loadDatabases(sessionId);
  }, [sessionId, databasesBySession, loadDatabases]);

  // The list is cached, so it can go stale while the window is in the
  // background (another client created a database, etc.). Re-read it on focus,
  // coalescing the burst of focus/visibility events a single switch produces.
  const lastFocusRefresh = useRef(0);
  useEffect(() => {
    if (!sessionId) return;
    const refreshIfVisible = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastFocusRefresh.current < 1500) return;
      lastFocusRefresh.current = now;
      void loadDatabases(sessionId);
      // Also re-read the tables/views inside every expanded node.
      void refreshExpanded();
    };
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [sessionId, loadDatabases, refreshExpanded]);

  // A mutation elsewhere (rename/drop/column edit/row edit) bumps the revision;
  // refetch every expanded node so the tree never shows a stale table.
  const seenRevision = useRef(objectsRevision);
  useEffect(() => {
    if (seenRevision.current === objectsRevision) return;
    seenRevision.current = objectsRevision;
    void refreshExpanded();
  }, [objectsRevision, refreshExpanded]);

  const toggleDatabase = useCallback(
    async (database: DatabaseInfo) => {
      if (!sessionId) return;
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
          await loadObjectsFor(database.name, null);
        }
      } catch (error) {
        pushToast({
          title: "Could not load namespaces",
          description: errorMessage(error),
          variant: "error",
        });
      }
    },
    [expanded, namespaces, sessionId, loadObjectsFor, pushToast],
  );

  const toggleNamespace = useCallback(
    async (database: string, namespace: string) => {
      if (!sessionId) return;
      const key = cacheKey(sessionId, database, namespace);
      const wasOpen = expanded[key];
      setExpanded((e) => ({ ...e, [key]: !wasOpen }));
      if (wasOpen || objects[key]) return;
      await loadObjectsFor(database, namespace);
    },
    [expanded, objects, sessionId, loadObjectsFor],
  );

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    setRefreshing(true);
    // Invalidate this session's tree before re-reading the database list so a
    // newly created table actually shows up.
    setNamespaces((n) => dropSession(n, sessionId));
    setObjects((o) => dropSession(o, sessionId));
    setLoading((l) => dropSession(l, sessionId));
    setExpanded((e) => dropSession(e, sessionId));
    try {
      await loadDatabases(sessionId);
    } finally {
      setRefreshing(false);
    }
  }, [sessionId, loadDatabases]);

  const sessionDriver = drivers.find((driver) => driver.id === session?.driver);
  const supportedActions = sessionDriver?.capabilities.supportedActions ?? [];
  // SQL-only affordances (qualified names, DDL, query templates, the table
  // wizard) are hidden for non-relational drivers such as Redis.
  const relational = sessionDriver?.capabilities.isRelational ?? true;
  const supportsDdl = sessionDriver?.capabilities.supportsDdl ?? true;
  const quote = sessionDriver?.id === "mysql" ? "`" : '"';

  function refFor(database: string, object: DatabaseObject): ObjectRef {
    return {
      sessionId: sessionId ?? "",
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

  async function countRows(database: string, object: DatabaseObject) {
    if (!sessionId) return;
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

  function menuEntries(database: string, object: DatabaseObject): MenuEntry[] {
    const ref = refFor(database, object);
    const supports = (action: ObjectAction) => supportedActions.includes(action);
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
              onSelect: () => void countRows(database, object),
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

  if (!session) {
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
            {session.name}
          </h2>
          <p className="truncate text-[11px] text-muted-foreground/80">
            {session.server.version ?? session.driver}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {supportsDdl ? (
            <Button
              size="icon-sm"
              variant="ghost"
              title="New table"
              disabled={!sessionId}
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          ) : null}
          <Button size="icon-sm" variant="ghost" title="Refresh" onClick={refresh}>
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-1.5 pb-3 text-sm">
        {databasesPending ? (
          <div className="flex items-center gap-2 px-1.5 py-2 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> loading databases…
          </div>
        ) : null}

        {databases.map((database) => {
          const dbKey = cacheKey(session.id, database.name, null);
          const dbOpen = expanded[dbKey];
          const dbNamespaces = namespaces[dbKey] ?? [];
          return (
            <div key={database.name}>
              <button
                onClick={() => toggleDatabase(database)}
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
                  <span className="ml-auto text-[10px] text-muted-foreground/70">system</span>
                ) : null}
              </button>

              {dbOpen && dbNamespaces.length === 0 ? (
                <ObjectList
                  containerKey={dbKey}
                  objects={objects[dbKey]}
                  loading={loading[dbKey]}
                  open={groupOpen}
                  onToggle={toggleGroup}
                  onActivate={(object) => openObjectTab(refFor(database.name, object))}
                  onContextMenu={(object, event) =>
                    setMenu({ x: event.clientX, y: event.clientY, database: database.name, object })
                  }
                />
              ) : null}

              {dbOpen
                ? dbNamespaces.map((namespace) => {
                    const key = cacheKey(session.id, database.name, namespace.name);
                    const nsOpen = expanded[key];
                    return (
                      <div key={key}>
                        <button
                          onClick={() => toggleNamespace(database.name, namespace.name)}
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
                            onActivate={(object) => openObjectTab(refFor(database.name, object))}
                            onContextMenu={(object, event) =>
                              setMenu({
                                x: event.clientX,
                                y: event.clientY,
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

      {menu ? (
        <ContextMenu
          entries={menuEntries(menu.database, menu.object)}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      ) : null}

      <CreateTableDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        sessionId={sessionId ?? ""}
        databases={databases.map((database) => database.name)}
        defaultDatabase={databases[0]?.name ?? session.server.currentDatabase ?? ""}
        quote={quote}
        dialect={dialectForDriver(session?.driver)}
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
