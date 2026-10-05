import { invoke } from "@tauri-apps/api/core";

import { mockInvoke } from "./mock";
import type {
  ConnectResult,
  ConnectionProfile,
  CreateTableRequest,
  DatabaseInfo,
  DatabaseObject,
  DriverDescriptor,
  NamespaceInfo,
  ObjectActionRequest,
  ObjectDetail,
  ObjectSchema,
  OpenSessionRequest,
  QueryRequest,
  QueryResponse,
  RowChangeRequest,
  SaveConnectionInput,
  SaveSnippetInput,
  ServerInfo,
  SessionInfo,
  Snippet,
  TableColumns,
} from "./types";

/** True when running inside the Tauri shell (as opposed to a plain browser). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** In-browser backend so the UI can be reviewed without the desktop shell.
 *  Inside the packaged app `__TAURI_INTERNALS__` always exists, so this branch
 *  is never taken there. */
const useMock = !isTauri();

function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (useMock) return mockInvoke<T>(cmd, args);
  return invoke<T>(cmd, args);
}

/**
 * Typed access to every backend command. Nothing driver-specific lives here —
 * new engines are picked up automatically through `listDrivers`.
 */
export const ipc = {
  listDrivers: () => call<DriverDescriptor[]>("list_drivers"),

  listConnections: () => call<ConnectionProfile[]>("list_connections"),
  saveConnection: (input: SaveConnectionInput) =>
    call<ConnectionProfile>("save_connection", { input }),
  deleteConnection: (id: string) => call<void>("delete_connection", { id }),
  testConnection: (config: OpenSessionRequest["config"]) =>
    call<ServerInfo>("test_connection", { config }),

  connect: (input: OpenSessionRequest) => call<ConnectResult>("connect", { input }),
  disconnect: (connectionId: string) => call<void>("disconnect", { connectionId }),
  listSessions: () => call<SessionInfo[]>("list_sessions"),

  listDatabases: (connectionId: string) => call<DatabaseInfo[]>("list_databases", { connectionId }),
  listNamespaces: (connectionId: string, database: string) =>
    call<NamespaceInfo[]>("list_namespaces", { connectionId, database }),
  listObjects: (connectionId: string, database: string, namespace?: string | null) =>
    call<DatabaseObject[]>("list_objects", { connectionId, database, namespace }),
  describeObject: (
    connectionId: string,
    database: string,
    namespace: string | null,
    object: string,
  ) => call<ObjectSchema>("describe_object", { connectionId, database, namespace, object }),
  listTableColumns: (connectionId: string, database: string, namespace?: string | null) =>
    call<TableColumns[]>("list_table_columns", { connectionId, database, namespace }),

  executeQuery: (connectionId: string, request: QueryRequest) =>
    call<QueryResponse>("execute_query", { connectionId, request }),
  cancelQuery: (runId: string) => call<boolean>("cancel_query", { runId }),
  explainQuery: (connectionId: string, request: QueryRequest) =>
    call<QueryResponse>("explain_query", { connectionId, request }),

  objectDetail: (connectionId: string, database: string, namespace: string | null, object: string) =>
    call<ObjectDetail>("object_detail", { connectionId, database, namespace, object }),
  objectAction: (request: ObjectActionRequest) =>
    call<QueryResponse>("object_action", { request }),
  applyRowChange: (request: RowChangeRequest) =>
    call<QueryResponse>("apply_row_change", { request }),
  applyRowChanges: (requests: RowChangeRequest[]) =>
    call<QueryResponse>("apply_row_changes", { requests }),
  createTable: (request: CreateTableRequest) =>
    call<QueryResponse>("create_table", { request }),
  countRows: (connectionId: string, database: string, namespace: string | null, object: string) =>
    call<number>("count_rows", { connectionId, database, namespace, object }),

  listSnippets: () => call<Snippet[]>("list_snippets"),
  saveSnippet: (input: SaveSnippetInput) => call<Snippet>("save_snippet", { input }),
  deleteSnippet: (id: string) => call<void>("delete_snippet", { id }),

  getSettings: () => call<Record<string, unknown>>("get_settings"),
  setSettings: (value: Record<string, unknown>) => call<void>("set_settings", { value }),
};

/** Normalise an unknown thrown value into a readable message. */
export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}
