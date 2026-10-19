import { ipc, isTauri, type GrantedScript } from "@/lib/ipc";
import { downloadText } from "@/lib/objects";

/**
 * The file half of the SQL script editor.
 *
 * Saving a script writes a real `.sql` file so any other tool can open it. The
 * disk write and the native picker only exist inside the Tauri shell — and both
 * live on the Rust side there: the webview suggests a *name*, and what it gets
 * back is the file's path plus an opaque token that alone can save there again.
 * It never handles a path as authority. In the browser demo the same actions
 * fall back to a download and a suggested name, so the flow stays reviewable
 * without the desktop runtime.
 */

/**
 * The final path segment, used as the tab title for a script.
 */
export function scriptName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * Ask where a script should live. Returns the grant — where it lives, and the
 * capability to save there — or null when the user cancels. Outside the shell
 * there is no picker, so the suggested name is accepted with a null token.
 */
export async function pickScriptPath(suggestedName: string): Promise<GrantedScript | null> {
  if (!isTauri()) return { path: suggestedName, token: null };
  return ipc.pickScriptPath(suggestedName);
}

/**
 * Save `contents`. `token` is the capability a previous grant carried, which
 * the shell trades for the write; anything else — no token, or one from an
 * earlier run — puts the save dialog up first. Returns the fresh grant, or
 * null when the dialog was cancelled. In the browser this downloads
 * `suggestedName` instead and reports it.
 */
export async function writeScriptFile(
  token: string | null,
  suggestedName: string,
  contents: string,
): Promise<GrantedScript | null> {
  if (!isTauri()) {
    downloadText(scriptName(suggestedName) || "query.sql", contents);
    return { path: suggestedName, token: null };
  }
  return ipc.saveScriptFile(token, suggestedName, contents);
}
