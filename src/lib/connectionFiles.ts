import { open, save } from "@tauri-apps/plugin-dialog";

import { isTauri } from "@/lib/ipc";

/**
 * The file half of moving saved connections between machines.
 *
 * The transfer itself is the backend's job (`export_connections` /
 * `import_connections`); this module only finds the path, exactly as
 * `scriptFiles.ts` does for SQL scripts. Passwords take no part in either
 * direction: they live in this machine's encrypted vault, and the transfer file
 * has no field for one.
 */

const CONNECTION_FILTERS = [{ name: "Quarry connections", extensions: ["json"] }];

/** What an export is called before the user renames it. */
export const CONNECTIONS_FILE_NAME = "quarry-connections.json";

/**
 * Ask where the transfer file should live. Returns the chosen absolute path, or
 * null when the user cancels. Outside the shell there is no picker and no disk,
 * so the suggested name is accepted as-is — the same fallback scripts use, so
 * the stubbed flow stays reviewable in the browser.
 */
export async function pickConnectionExportPath(): Promise<string | null> {
  if (!isTauri()) return CONNECTIONS_FILE_NAME;
  return save({ defaultPath: CONNECTIONS_FILE_NAME, filters: CONNECTION_FILTERS });
}

/**
 * Ask which transfer file to read. Returns the chosen absolute path, or null
 * when the user cancels — and, in the browser, the suggested name, which in the
 * demo answers from the mock backend rather than from a disk.
 */
export async function pickConnectionImportPath(): Promise<string | null> {
  if (!isTauri()) return CONNECTIONS_FILE_NAME;
  const picked = await open({ multiple: false, directory: false, filters: CONNECTION_FILTERS });
  return typeof picked === "string" ? picked : null;
}
