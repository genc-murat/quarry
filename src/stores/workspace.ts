import { create } from "zustand";

import { dropExplorerSession } from "@/lib/explorerTree";
import { changesDatabaseSet } from "@/lib/sqlIntent";
import { errorMessage, ipc } from "@/lib/ipc";
import type {
  ConnectionProfile,
  CreateTableRequest,
  DatabaseInfo,
  DriverDescriptor,
  ObjectActionRequest,
  ObjectDetail,
  OpenSessionRequest,
  QueryLanguage,
  QueryResponse,
  RowChangeRequest,
  SaveConnectionInput,
  SaveSnippetInput,
  SessionInfo,
  Snippet,
  TableColumns,
} from "@/lib/types";
import {
  type ObjectDialogRequest,
  type ObjectRef,
  type TemplateKind,
  objectKey,
  qualifiedName,
  templateSql,
} from "@/lib/objects";
import type { EditSource } from "@/lib/rowEdit";
import {
  mergeSettings,
  writeSetting,
  type AppSettings,
  type SettingPath,
} from "@/lib/settings";
import { useThemeStore } from "@/stores/theme";
import type { PaletteId, ThemeMode } from "@/theme/themes";

/** Query language of the driver behind a session; SQL when it is unknown. */
function queryLanguageFor(
  drivers: DriverDescriptor[],
  sessions: SessionInfo[],
  sessionId: string,
): QueryLanguage {
  const driverId = sessions.find((s) => s.id === sessionId)?.driver;
  return drivers.find((d) => d.id === driverId)?.capabilities.queryLanguage ?? "sql";
}

/**
 * One page of a collection or table, as a statement the driver understands.
 * SQL gets a quoted `SELECT *`; MongoDB gets a sorted `find` command, so the
 * page order is stable across `skip` windows.
 */
function previewSql(
  ref: ObjectRef,
  quote: string,
  offset: number,
  limit: number,
  language: QueryLanguage,
): string {
  if (language === "mongo") {
    return JSON.stringify({ find: ref.object, filter: {}, sort: { _id: 1 }, skip: offset, limit });
  }
  const table = qualifiedName(
    { database: ref.database, namespace: ref.namespace, object: ref.object },
    quote,
  );
  return `SELECT * FROM ${table} LIMIT ${limit} OFFSET ${offset};`;
}

export type SidebarView = "connections" | "explorer" | "schema" | "history" | "snippets" | "settings";

export interface QueryTab {
  id: string;
  title: string;
  /** `object` tabs render the inspector instead of a query editor. */
  kind: "query" | "object";
  sql: string;
  sessionId: string | null;
  database: string | null;
  /** Set for `object` tabs and data previews: which object is shown. */
  objectRef: ObjectRef | null;
  /** Set for editable table previews (grid row editing). */
  editSource: EditSource | null;
  /** Pagination window for a table preview. */
  preview: { limit: number; offset: number } | null;
  result: QueryResponse | null;
  /** Latest EXPLAIN output, shown in place of the grid until cleared. */
  plan: QueryResponse | null;
  error: string | null;
  running: boolean;
  /** True while an EXPLAIN is in flight. */
  explaining: boolean;
  /** Set when the user stops a run so the late response is ignored. */
  cancelled: boolean;
  /** Identifies the in-flight run for cancellation. */
  runId: string | null;
}

export interface HistoryEntry {
  id: string;
  sql: string;
  /** Session the query ran on, so replaying it targets the same server. */
  sessionId: string | null;
  sessionName: string;
  database: string | null;
  at: number;
  ok: boolean;
  durationMs: number;
  rowCount: number;
}

export interface QueryFavorite {
  id: string;
  sql: string;
  sessionId: string | null;
  sessionName: string;
  database: string | null;
  name: string;
  createdAt: number;
}

function loadLocalList<T>(key: string): T[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value as T[] : [];
  } catch {
    return [];
  }
}

function saveLocalList<T>(key: string, value: T[]) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* keep the in-memory workspace available */ }
}

export interface Toast {
  id: string;
  title: string;
  description?: string;
  variant: "info" | "success" | "error";
}

interface WorkspaceState {
  booting: boolean;
  drivers: DriverDescriptor[];
  profiles: ConnectionProfile[];
  sessions: SessionInfo[];
  activeSessionId: string | null;
  databasesBySession: Record<string, DatabaseInfo[]>;
  /** Table/column metadata per `sessionId||database`, used for editor completion. */
  columnsCache: Record<string, TableColumns[]>;

  sidebar: SidebarView;
  tabs: QueryTab[];
  activeTabId: string | null;
  history: HistoryEntry[];
  favorites: QueryFavorite[];
  snippets: Snippet[];
  /** Cached object inspector payloads, keyed by `objectKey`. */
  objectCache: Record<string, ObjectDetail>;
  /** Currently open shared object dialog (hosted globally). */
  objectDialog: ObjectDialogRequest | null;
  /** Bumped after a mutation so the explorer tree refetches stale nodes. */
  objectsRevision: number;
  toasts: Toast[];
  settings: AppSettings;

  bootstrap: () => Promise<void>;
  refreshConnections: () => Promise<void>;
  saveConnection: (input: SaveConnectionInput) => Promise<ConnectionProfile | null>;
  deleteConnection: (id: string) => Promise<void>;
  connect: (input: OpenSessionRequest, label?: string) => Promise<SessionInfo | null>;
  disconnect: (sessionId: string) => Promise<void>;
  setActiveSession: (sessionId: string) => void;
  loadDatabases: (sessionId: string) => Promise<DatabaseInfo[]>;
  loadColumns: (sessionId: string, database: string) => Promise<void>;
  setSidebar: (view: SidebarView) => void;

  newTab: (init?: Partial<QueryTab>) => string;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateTab: (id: string, patch: Partial<QueryTab>) => void;
  runTab: (id: string) => Promise<void>;
  explainTab: (id: string) => Promise<void>;
  cancelTab: (id: string) => Promise<void>;
  openObjectTab: (ref: ObjectRef) => string;
  loadObjectDetail: (ref: ObjectRef, force?: boolean) => Promise<ObjectDetail | null>;
  invalidateObject: (ref: ObjectRef) => void;
  runObjectAction: (request: ObjectActionRequest) => Promise<boolean>;
  saveRowChanges: (tabId: string, changes: RowChangeRequest[]) => Promise<boolean>;
  pageObjectData: (tabId: string, offset: number) => Promise<void>;
  createTable: (request: CreateTableRequest) => Promise<boolean>;
  persistSettings: () => void;
  openObjectDialog: (dialog: ObjectDialogRequest) => void;
  closeObjectDialog: () => void;
  openObjectData: (ref: ObjectRef) => Promise<void>;
  openObjectTemplate: (ref: ObjectRef, kind: TemplateKind) => Promise<void>;
  clearHistory: () => void;
  toggleFavorite: (tabId: string, name?: string) => void;
  removeFavorite: (id: string) => void;
  updateSetting: (path: SettingPath, value: string | number | boolean) => void;
  resetSettings: () => void;

  loadSnippets: () => Promise<void>;
  saveSnippet: (input: SaveSnippetInput) => Promise<void>;
  deleteSnippet: (id: string) => Promise<void>;

  pushToast: (toast: Omit<Toast, "id">) => void;
  dismissToast: (id: string) => void;
}

let tabCounter = 0;

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  booting: true,
  drivers: [],
  profiles: [],
  sessions: [],
  activeSessionId: null,
  databasesBySession: {},
  columnsCache: {},

  sidebar: "connections",
  tabs: [],
  activeTabId: null,
  history: loadLocalList<HistoryEntry>("quarry.query-history"),
  favorites: loadLocalList<QueryFavorite>("quarry.query-favorites"),
  snippets: [],
  objectCache: {},
  objectDialog: null,
  objectsRevision: 0,
  toasts: [],
  settings: mergeSettings(undefined),

  bootstrap: async () => {
    try {
      const [drivers, profiles, sessions, snippets, loadedSettings] = await Promise.all([
        ipc.listDrivers(),
        ipc.listConnections(),
        ipc.listSessions(),
        ipc.listSnippets(),
        ipc.getSettings(),
      ]);
      // A fresh install has no settings.json yet, so the backend can hand back
      // null; treat anything that is not an object as empty rather than crashing.
      const stored =
        loadedSettings && typeof loadedSettings === "object"
          ? (loadedSettings as Record<string, unknown>)
          : {};
      // Restore persisted appearance and query settings. The theme store still
      // keeps localStorage so the first paint is themed before this lands.
      const theme = stored.theme as { mode?: ThemeMode; palette?: PaletteId } | undefined;
      if (theme?.mode) useThemeStore.getState().setMode(theme.mode);
      if (theme?.palette) useThemeStore.getState().setPalette(theme.palette);
      const settings = mergeSettings(stored.settings);
      // Migrate the pre-namespaced shape where the row limit lived at the root.
      if (typeof stored.maxRows === "number" && stored.settings === undefined) {
        settings.editor.maxRows =
          mergeSettings({ editor: { maxRows: stored.maxRows } }).editor.maxRows;
      }
      set({
        drivers,
        profiles,
        sessions,
        snippets,
        settings,
        activeSessionId: get().activeSessionId ?? sessions[0]?.id ?? null,
        booting: false,
      });
      if (get().tabs.length === 0) {
        get().newTab();
      }
      const active = get().activeSessionId;
      if (active) {
        await get().loadDatabases(active);
      }
    } catch (error) {
      set({ booting: false });
      get().pushToast({
        title: "Could not load application state",
        description: errorMessage(error),
        variant: "error",
      });
    }
  },

  refreshConnections: async () => {
    const profiles = await ipc.listConnections();
    set({ profiles });
  },

  saveConnection: async (input) => {
    try {
      const profile = await ipc.saveConnection(input);
      await get().refreshConnections();
      get().pushToast({ title: "Connection saved", variant: "success" });
      return profile;
    } catch (error) {
      get().pushToast({
        title: "Could not save connection",
        description: errorMessage(error),
        variant: "error",
      });
      return null;
    }
  },

  deleteConnection: async (id) => {
    try {
      await ipc.deleteConnection(id);
      await get().refreshConnections();
      get().pushToast({ title: "Connection removed", variant: "info" });
    } catch (error) {
      get().pushToast({
        title: "Could not remove connection",
        description: errorMessage(error),
        variant: "error",
      });
    }
  },

  connect: async (input, label) => {
    try {
      const { session } = await ipc.connect(input);
      set((state) => ({
        sessions: [...state.sessions.filter((s) => s.id !== session.id), session],
        activeSessionId: session.id,
        sidebar: "explorer",
      }));
      // Seed the active tab so queries land on the new session.
      const activeTab = get().tabs.find((t) => t.id === get().activeTabId);
      if (activeTab) {
        get().updateTab(activeTab.id, {
          sessionId: session.id,
          title: label ?? activeTab.title,
        });
      }
      await get().loadDatabases(session.id);
      get().pushToast({
        title: `Connected to ${session.name}`,
        description: session.server.version ?? undefined,
        variant: "success",
      });
      return session;
    } catch (error) {
      get().pushToast({
        title: "Connection failed",
        description: errorMessage(error),
        variant: "error",
      });
      return null;
    }
  },

  disconnect: async (sessionId) => {
    await ipc.disconnect(sessionId);
    // Reclaim the explorer tree cached for this session, otherwise a long-lived
    // app keeps trees for every connection it has ever opened.
    dropExplorerSession(sessionId);
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== sessionId);
      const databasesBySession = { ...state.databasesBySession };
      delete databasesBySession[sessionId];
      // Drop the autocompletion schema too, otherwise a re-connect reusing the
      // key would keep serving the old session's tables.
      const columnsCache = Object.fromEntries(
        Object.entries(state.columnsCache).filter(
          ([key]) => !key.startsWith(`${sessionId}||`),
        ),
      );
      const activeSessionId =
        state.activeSessionId === sessionId ? (sessions[0]?.id ?? null) : state.activeSessionId;
      return { sessions, databasesBySession, columnsCache, activeSessionId };
    });
  },

  setActiveSession: (sessionId) => {
    set({ activeSessionId: sessionId });
    const activeTab = get().tabs.find((t) => t.id === get().activeTabId);
    if (activeTab) {
      get().updateTab(activeTab.id, { sessionId });
    }
  },

  loadDatabases: async (sessionId) => {
    try {
      const databases = await ipc.listDatabases(sessionId);
      set((state) => ({
        databasesBySession: { ...state.databasesBySession, [sessionId]: databases },
      }));
      return databases;
    } catch (error) {
      get().pushToast({
        title: "Could not list databases",
        description: errorMessage(error),
        variant: "error",
      });
      return [];
    }
  },

  loadColumns: async (sessionId, database) => {
    if (!database) return;
    const key = `${sessionId}||${database}`;
    if (get().columnsCache[key]) return;
    try {
      const columns = await ipc.listTableColumns(sessionId, database);
      set((state) => ({ columnsCache: { ...state.columnsCache, [key]: columns } }));
    } catch {
      // Autocompletion is a best-effort enhancement; never surface a failure.
    }
  },

  setSidebar: (view) => set({ sidebar: view }),

  newTab: (init) => {
    tabCounter += 1;
    const id = crypto.randomUUID();
    const state = get();
    const tab: QueryTab = {
      id,
      title: init?.title ?? `Query ${tabCounter}`,
      kind: "query",
      sql: init?.sql ?? "",
      sessionId: init?.sessionId ?? state.activeSessionId,
      database: init?.database ?? null,
      objectRef: null,
      editSource: init?.editSource ?? null,
      preview: init?.preview ?? null,
      result: null,
      plan: null,
      error: null,
      running: false,
      explaining: false,
      cancelled: false,
      runId: null,
    };
    set({ tabs: [...state.tabs, tab], activeTabId: id });
    return id;
  },

  closeTab: (id) => {
    set((state) => {
      const tabs = state.tabs.filter((t) => t.id !== id);
      const activeTabId =
        state.activeTabId === id ? (tabs[tabs.length - 1]?.id ?? null) : state.activeTabId;
      return { tabs, activeTabId };
    });
    if (get().tabs.length === 0) {
      get().newTab();
    }
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  updateTab: (id, patch) => {
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)),
    }));
  },

  runTab: async (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    if (!tab.sessionId) {
      get().pushToast({
        title: "No active connection",
        description: "Connect to a database before running a query.",
        variant: "error",
      });
      return;
    }
    const sql = tab.sql.trim();
    if (!sql) return;

    if (get().settings.safety.requireWhereForWrites) {
      const isWrite = /\b(update|delete)\b/i.test(sql);
      const scoped = /\bwhere\b/i.test(sql);
      if (isWrite && !scoped) {
        get().pushToast({
          title: "Statement blocked",
          description:
            "UPDATE/DELETE without a WHERE clause is disabled in Settings \u2192 Safety.",
          variant: "error",
        });
        return;
      }
    }

    const runId = crypto.randomUUID();
    get().updateTab(id, {
      running: true,
      error: null,
      cancelled: false,
      runId,
      plan: null,
    });
    const started = Date.now();
    const session = get().sessions.find((s) => s.id === tab.sessionId);
    const recordHistory = (ok: boolean, rowCount: number) => {
      set((state) => {
        const history = [{
          id: crypto.randomUUID(),
          sql,
          sessionId: tab.sessionId,
          sessionName: session?.name ?? "unknown",
          database: tab.database,
          at: Date.now(),
          ok,
          durationMs: Date.now() - started,
          rowCount,
        }, ...state.history].slice(0, 200);
        saveLocalList("quarry.query-history", history);
        return { history };
      });
    };
    try {
      const result = await ipc.executeQuery(tab.sessionId, {
        sql,
        database: tab.database,
        maxRows: get().settings.editor.maxRows,
        timeoutMs:
          get().settings.editor.timeoutMs > 0 ? get().settings.editor.timeoutMs : undefined,
        runId,
      });

      // The user may have stopped the run while it was in flight; if so the
      // late response must not resurrect the grid.
      if (get().tabs.find((t) => t.id === id)?.cancelled) {
        get().updateTab(id, { running: false, result: null, runId: null });
        return;
      }

      const firstError = result.results.find((r) => r.error)?.error ?? null;
      // Statement failures are rendered inside the results grid (per-statement
      // tabs plus an inline banner), so the tab-level `error` stays reserved for
      // transport failures. Mirroring a statement error here would replace the
      // whole grid and hide the statements that did succeed.
      get().updateTab(id, { result, error: null, running: false, runId: null });

      // A database/schema DDL changes what the explorer lists, so re-read it
      // rather than making the user press Refresh.
      if (changesDatabaseSet(sql)) {
        void get().loadDatabases(tab.sessionId);
      }

      const rowCount = result.results.reduce((sum, r) => sum + r.rowCount, 0);
      recordHistory(!firstError, rowCount);
    } catch (error) {
      // A stopped run will reject once the server-side cancel lands — that is
      // the expected outcome, not a failure worth showing.
      if (get().tabs.find((t) => t.id === id)?.cancelled) {
        get().updateTab(id, { running: false, result: null, runId: null });
        return;
      }
      const message = errorMessage(error);
      get().updateTab(id, { error: message, running: false, runId: null });
      recordHistory(false, 0);
    }
  },

  explainTab: async (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    if (!tab.sessionId) {
      get().pushToast({
        title: "No active connection",
        description: "Connect to a database before explaining a query.",
        variant: "error",
      });
      return;
    }
    const sql = tab.sql.trim();
    if (!sql) return;

    get().updateTab(id, { explaining: true, error: null, plan: null });
    try {
      const plan = await ipc.explainQuery(tab.sessionId, {
        sql,
        database: tab.database,
        maxRows: get().settings.editor.maxRows,
        timeoutMs:
          get().settings.editor.timeoutMs > 0 ? get().settings.editor.timeoutMs : undefined,
      });
      // Ignore a plan that arrives after a subsequent Run/Explain replaced it.
      if (!get().tabs.find((t) => t.id === id)?.explaining) return;
      get().updateTab(id, { plan, explaining: false });
    } catch (error) {
      get().updateTab(id, { explaining: false, error: errorMessage(error) });
    }
  },

  cancelTab: async (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab?.running) return;
    // Flip the UI immediately so Stop feels instant; the in-flight promise is
    // ignored once `cancelled` is set.
    get().updateTab(id, { cancelled: true, running: false });
    if (tab.runId) {
      try {
        await ipc.cancelQuery(tab.runId);
      } catch {
        // Best effort — the run may have finished a moment earlier.
      }
    }
  },

  openObjectTab: (ref) => {
    const key = objectKey(ref);
    const existing = get().tabs.find(
      (tab) => tab.kind === "object" && tab.objectRef && objectKey(tab.objectRef) === key,
    );
    if (existing) {
      set({ activeTabId: existing.id });
      return existing.id;
    }

    const id = crypto.randomUUID();
    const tab: QueryTab = {
      id,
      title: ref.object,
      kind: "object",
      sql: "",
      sessionId: ref.sessionId,
      database: ref.database,
      objectRef: ref,
      editSource: null,
      preview: null,
      result: null,
      plan: null,
      error: null,
      running: false,
      explaining: false,
      cancelled: false,
      runId: null,
    };
    set((state) => ({ tabs: [...state.tabs, tab], activeTabId: id }));
    void get().loadObjectDetail(ref, true);
    return id;
  },

  loadObjectDetail: async (ref, force = false) => {
    const key = objectKey(ref);
    if (!force) {
      const cached = get().objectCache[key];
      if (cached) return cached;
    }
    try {
      const detail = await ipc.objectDetail(
        ref.sessionId,
        ref.database,
        ref.namespace,
        ref.object,
      );
      set((state) => ({ objectCache: { ...state.objectCache, [key]: detail } }));
      return detail;
    } catch (error) {
      get().pushToast({
        title: `Could not load ${ref.object}`,
        description: errorMessage(error),
        variant: "error",
      });
      return null;
    }
  },

  openObjectDialog: (dialog) => set({ objectDialog: dialog }),
  closeObjectDialog: () => set({ objectDialog: null }),

  openObjectData: async (ref) => {
    const detail = await get().loadObjectDetail(ref);
    if (!detail) return;
    // The editor and the grid must show the same query: build the preview SQL
    // once, use it as the tab's text, and run it through the normal path.
    const quote = detail.identifierQuote || '"';
    const language = queryLanguageFor(get().drivers, get().sessions, ref.sessionId);
    const isTable = ref.objectKind === "table";
    const columnTypes: Record<string, string> = {};
    for (const column of detail.schema.columns) columnTypes[column.name] = column.dataType;
    const pageSize = get().settings.results.pageSize;
    const id = get().newTab({
      title: `${ref.object} data`,
      sessionId: ref.sessionId,
      database: ref.database,
      sql: previewSql(ref, quote, 0, pageSize, language),
      objectRef: ref,
      preview: { limit: pageSize, offset: 0 },
      editSource: isTable
        ? {
            ref,
            quote,
            columnTypes,
            primaryKeys: detail.schema.columns.filter((c) => c.isPrimaryKey).map((c) => c.name),
            autoIncrement: detail.schema.columns
              .filter((c) => c.isAutoIncrement)
              .map((c) => c.name),
          }
        : null,
    });
    await get().runTab(id);
  },

  pageObjectData: async (tabId, offset) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab?.preview || offset < 0) return;
    const limit = tab.preview.limit;
    const language = tab.sessionId
      ? queryLanguageFor(get().drivers, get().sessions, tab.sessionId)
      : "sql";
    let sql: string;
    if (language === "mongo") {
      if (!tab.objectRef) return;
      sql = previewSql(tab.objectRef, "", offset, limit, language);
    } else {
      if (!tab.editSource) return;
      sql = previewSql(tab.editSource.ref, tab.editSource.quote, offset, limit, language);
    }
    get().updateTab(tabId, { sql, preview: { limit, offset } });
    await get().runTab(tabId);
  },

  createTable: async (request) => {
    try {
      const response = await ipc.createTable(request);
      const failure = response.results.find((result) => result.error)?.error ?? null;
      if (failure) {
        get().pushToast({ title: "Create table failed", description: failure, variant: "error" });
        return false;
      }
      get().pushToast({ title: "Table created", description: request.table, variant: "success" });
      // The new table must show up in the tree and stop poisoning completion.
      const prefix = `${request.connectionId}||${request.database}`;
      set((state) => ({
        columnsCache: Object.fromEntries(
          Object.entries(state.columnsCache).filter(([key]) => !key.startsWith(prefix)),
        ),
        objectsRevision: state.objectsRevision + 1,
      }));
      return true;
    } catch (error) {
      get().pushToast({
        title: "Create table failed",
        description: errorMessage(error),
        variant: "error",
      });
      return false;
    }
  },

  openObjectTemplate: async (ref, kind) => {
    const detail = await get().loadObjectDetail(ref);
    if (!detail) return;
    get().newTab({
      title: `${ref.object} ${kind}`,
      sessionId: ref.sessionId,
      database: ref.database,
      sql: templateSql(kind, ref, detail),
    });
  },

  invalidateObject: (ref) => {
    const key = objectKey(ref);
    set((state) => {
      const objectCache = { ...state.objectCache };
      delete objectCache[key];
      return { objectCache };
    });
  },

  runObjectAction: async (request) => {
    try {
      const response = await ipc.objectAction(request);
      const failure = response.results.find((result) => result.error)?.error ?? null;
      if (failure) {
        get().pushToast({ title: `${request.action} failed`, description: failure, variant: "error" });
        return false;
      }
      get().pushToast({ title: "Done", description: `${request.action} · ${request.object}`, variant: "success" });

      // Refresh the inspector and drop the autocompletion schema, which may no
      // longer match after a rename/drop/column change.
      const ref: ObjectRef = {
        sessionId: request.connectionId,
        database: request.database,
        namespace: request.namespace ?? null,
        object: request.object,
        objectKind: request.objectKind ?? "table",
      };
      get().invalidateObject(ref);
      const prefix = `${request.connectionId}||${request.database}`;
      set((state) => ({
        columnsCache: Object.fromEntries(
          Object.entries(state.columnsCache).filter(([key]) => !key.startsWith(prefix)),
        ),
        // Signal the explorer tree that its cached nodes are stale.
        objectsRevision: state.objectsRevision + 1,
      }));
      return true;
    } catch (error) {
      get().pushToast({
        title: `${request.action} failed`,
        description: errorMessage(error),
        variant: "error",
      });
      return false;
    }
  },

  saveRowChanges: async (tabId, changes) => {
    if (changes.length === 0) return true;
    try {
      // One batch call describes each table once instead of once per row.
      const response = await ipc.applyRowChanges(changes);
      const failure = response.results.find((result) => result.error)?.error ?? null;
      if (failure) {
        get().pushToast({ title: "Row change failed", description: failure, variant: "error" });
        return false;
      }
      get().pushToast({
        title: changes.length === 1 ? "Row saved" : `${changes.length} rows saved`,
        variant: "success",
      });
      set((state) => ({ objectsRevision: state.objectsRevision + 1 }));
      // Reload the preview so the grid reflects what the server stored.
      await get().runTab(tabId);
      return true;
    } catch (error) {
      get().pushToast({
        title: "Row change failed",
        description: errorMessage(error),
        variant: "error",
      });
      return false;
    }
  },

  clearHistory: () => {
    saveLocalList("quarry.query-history", []);
    set({ history: [] });
  },

  toggleFavorite: (tabId, name) => {
    const tab = get().tabs.find((candidate) => candidate.id === tabId);
    if (!tab?.sql.trim()) return;
    const session = get().sessions.find((candidate) => candidate.id === tab.sessionId);
    set((state) => {
      const existing = state.favorites.find((favorite) => favorite.sql === tab.sql.trim() && favorite.sessionId === tab.sessionId && favorite.database === tab.database);
      const favorites = existing
        ? state.favorites.filter((favorite) => favorite.id !== existing.id)
        : [{ id: crypto.randomUUID(), sql: tab.sql.trim(), sessionId: tab.sessionId, sessionName: session?.name ?? "unknown", database: tab.database, name: name?.trim() || tab.title || "Favorite query", createdAt: Date.now() }, ...state.favorites].slice(0, 200);
      saveLocalList("quarry.query-favorites", favorites);
      return { favorites };
    });
  },

  removeFavorite: (id) => set((state) => {
    const favorites = state.favorites.filter((favorite) => favorite.id !== id);
    saveLocalList("quarry.query-favorites", favorites);
    return { favorites };
  }),

  updateSetting: (path, value) => {
    set({ settings: writeSetting(get().settings, path, value) });
    get().persistSettings();
  },

  resetSettings: () => {
    set({ settings: mergeSettings(undefined) });
    get().persistSettings();
  },

  persistSettings: () => {
    const theme = useThemeStore.getState();
    void ipc
      .setSettings({
        theme: { mode: theme.mode, palette: theme.palette },
        settings: get().settings,
      })
      .catch(() => {
        // Persisting is best effort; the UI keeps working without it.
      });
  },

  loadSnippets: async () => {
    try {
      const snippets = await ipc.listSnippets();
      set({ snippets });
    } catch (error) {
      get().pushToast({
        title: "Could not load saved queries",
        description: errorMessage(error),
        variant: "error",
      });
    }
  },

  saveSnippet: async (input) => {
    try {
      await ipc.saveSnippet(input);
      await get().loadSnippets();
      get().pushToast({ title: "Query saved", variant: "success" });
    } catch (error) {
      get().pushToast({
        title: "Could not save query",
        description: errorMessage(error),
        variant: "error",
      });
    }
  },

  deleteSnippet: async (id) => {
    try {
      await ipc.deleteSnippet(id);
      set((state) => ({ snippets: state.snippets.filter((s) => s.id !== id) }));
    } catch (error) {
      get().pushToast({
        title: "Could not delete query",
        description: errorMessage(error),
        variant: "error",
      });
    }
  },

  pushToast: (toast) => {
    const id = crypto.randomUUID();
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
    window.setTimeout(() => get().dismissToast(id), get().settings.general.toastDurationMs);
  },

  dismissToast: (id) => {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },
}));

/** Convenience selector for the currently focused session. */
export function activeSession(state: WorkspaceState): SessionInfo | null {
  return state.sessions.find((s) => s.id === state.activeSessionId) ?? null;
}
