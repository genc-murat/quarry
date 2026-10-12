import { getBundleType, getVersion } from "@tauri-apps/api/app";

import type { UpdateState, Updater } from "./updater";

/**
 * The one thing a test cannot fake is a person clicking Install, so
 * `scripts/e2e-update.mjs` asks the app to do it: this probe runs the same
 * check → download → install the settings panel runs and reports each step back
 * to the script's server.
 *
 * It only exists in a build that opts in when it is built — `VITE_UPDATE_PROBE=1`
 * plus `VITE_UPDATE_PROBE_URL` for the server to report to. Vite inlines both,
 * so a normal build reads `"1" === "1"` as false and the minifier drops the
 * branch: what ships is untouched. That is also why the guard compares against
 * the literal rather than reading a value it could also have been given at
 * runtime.
 *
 * The reports are posted rather than logged because the webview's console is
 * not visible from outside the app, and because the sequence of steps — found an
 * update, downloaded it, refused a signature, came back current — is exactly
 * what the script asserts on. Each run opens by naming itself, version and
 * bundle type included, because that is how the script knows the process that
 * came back after a restart is the new build rather than the old one.
 */
export function startUpdateProbe(updater: Updater): void {
  if (import.meta.env.VITE_UPDATE_PROBE !== "1") return;
  const server = import.meta.env.VITE_UPDATE_PROBE_URL;
  if (!server) return;

  void (async () => {
    const [running, installer] = await describeSelf();
    await report(server, `start:${running}:${installer}`);
    await updater.check();

    const checked = updater.getState();
    await report(server, describeCheck(checked));
    if (checked.phase !== "available") return;

    const version = checked.update.version;
    await report(server, `installing:${version}`);
    await updater.install();

    // A refused install ends here, and saying why is the whole point of the
    // negative runs. A good one is about to restart instead, and the restart is
    // what the script waits for.
    const installed = updater.getState();
    if (installed.phase === "error") await report(server, `install-error:${installed.message}`);
  })();
}

/**
 * This process as the shell sees it: the version it is running and the bundle
 * type it was installed from. Both come from `core:app:default`, which is part
 * of the `core:default` this app already grants, and both are what the update
 * script compares against the platform it built for.
 */
async function describeSelf(): Promise<[string, string]> {
  try {
    const [version, installer] = await Promise.all([getVersion(), getBundleType()]);
    return [version, installer ?? "unknown"];
  } catch {
    // A build without the app permissions still updates; it just cannot say
    // which build it is.
    return ["unknown", "unknown"];
  }
}

/** What the check found, including both versions so the report names them. */
function describeCheck(state: UpdateState): string {
  if (state.phase === "available") {
    return `after-check:available:${state.update.version}:${state.update.currentVersion}`;
  }
  if (state.phase === "error") return `after-check:error:${state.message}`;
  return `after-check:${state.phase}`;
}

async function report(server: string, step: string): Promise<void> {
  try {
    await fetch(`${server}/probe/${encodeURIComponent(step)}`);
  } catch {
    // The server belongs to the run; if it is gone, the run is over too.
  }
}
