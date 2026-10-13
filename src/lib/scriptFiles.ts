import { save } from "@tauri-apps/plugin-dialog";

import { ipc, isTauri } from "@/lib/ipc";
import { downloadText } from "@/lib/objects";

/**
 * The file half of the SQL script editor.
 *
 * Saving a script writes a real `.sql` file so any other tool can open it. The
 * disk write and the native picker only exist inside the Tauri shell; in the
 * browser demo the same actions fall back to a download and a suggested name, so
 * the flow stays reviewable without the desktop runtime.
 */

const SQL_FILTERS = [{ name: "SQL script", extensions: ["sql"] }];

/** The final path segment, used as the tab title for a script. */
export function scriptName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * Ask where a script should live. Returns the chosen absolute path, or null
 * when the user cancels. Outside the shell there is no picker, so the suggested
 * name is accepted directly.
 */
export async function pickScriptPath(suggestedName: string): Promise<string | null> {
  if (!isTauri()) return suggestedName;
  return save({ defaultPath: suggestedName, filters: SQL_FILTERS });
}

/** Write `contents` to `path`. In the browser this downloads `path` instead. */
export async function writeScriptFile(path: string, contents: string): Promise<void> {
  if (!isTauri()) {
    downloadText(scriptName(path) || "query.sql", contents);
    return;
  }
  await ipc.writeScriptFile(path, contents);
}
