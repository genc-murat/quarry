import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

import { errorMessage, isTauri } from "./ipc";

/**
 * Self-updates are the one feature that talks to something other than a
 * database: the manifest `tauri-action` attaches to each GitHub release.
 *
 * The flow is split in two. A gateway is the part only the desktop shell can
 * do — ask the release endpoint, install what it downloaded, restart into it —
 * and `createUpdater` is the state machine the UI renders. Tests drive the
 * state machine with a fake gateway, so no shell (and no network) is involved.
 */

/** A release the manifest offers, without the shell handle behind it. */
export interface PendingUpdate {
  version: string;
  currentVersion: string;
  /** Publish date of the release, when the manifest carried one. */
  date?: string;
  /** Release notes, when the manifest carried them. */
  body?: string;
}

/** Bytes downloaded so far; `total` is null when the server did not say. */
export interface DownloadProgress {
  downloaded: number;
  total: number | null;
}

/**
 * One update as the shell sees it: the release data plus the two calls on its
 * handle. The shell keeps a resource behind it, which is why it must be closed
 * when the update is not installed.
 */
export interface UpdateHandle extends PendingUpdate {
  downloadAndInstall(onProgress: (progress: DownloadProgress) => void): Promise<void>;
  close(): Promise<void>;
}

export interface UpdateGateway {
  /** The newer release, or null when this build is the newest one. */
  check(): Promise<UpdateHandle | null>;
  relaunch(): Promise<void>;
}

export type UpdateState =
  | { phase: "idle" }
  /** No shell to update: the browser demo build. */
  | { phase: "unsupported" }
  | { phase: "checking" }
  | { phase: "current" }
  | { phase: "available"; update: PendingUpdate }
  | { phase: "downloading"; update: PendingUpdate; downloaded: number; total: number | null }
  /** Downloaded and applied; the app is on its way to the new version. */
  | { phase: "installing"; update: PendingUpdate }
  /** Which call failed matters: a failed check is retried by checking again, a
   *  failed download by installing again. */
  | { phase: "error"; operation: "check" | "install"; message: string };

export interface Updater {
  getState(): UpdateState;
  /** Notified on every phase change; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  check(): Promise<void>;
  install(): Promise<void>;
}

/** The last progress the user actually saw. */
interface ShownProgress {
  percent: number;
  bytes: number;
}

/** Unknown-length downloads advance the label one megabyte at a time. */
const PROGRESS_STEP_BYTES = 1024 * 1024;

/**
 * Progress arrives once per network chunk — thousands of times for a bundle of
 * a few megabytes, and each report re-renders the panel. Only a change the user
 * can see is worth that: one step per percent when the server sent a length,
 * otherwise one per megabyte (the label counts bytes, the bar has nothing to
 * fill). Returns the new "shown" state, or null when this chunk changes nothing.
 */
function reportableProgress(
  next: DownloadProgress,
  shown: ShownProgress,
): ShownProgress | null {
  if (next.total !== null && next.total > 0) {
    const percent = Math.floor((next.downloaded / next.total) * 100);
    if (percent === shown.percent) return null;
    return { percent, bytes: next.downloaded };
  }
  if (Math.abs(next.downloaded - shown.bytes) < PROGRESS_STEP_BYTES) return null;
  return { percent: shown.percent, bytes: next.downloaded };
}

function toPending(handle: UpdateHandle): PendingUpdate {
  return {
    version: handle.version,
    currentVersion: handle.currentVersion,
    date: handle.date,
    body: handle.body,
  };
}

export function createUpdater(gateway: UpdateGateway | null): Updater {
  let state: UpdateState = gateway ? { phase: "idle" } : { phase: "unsupported" };
  /** The handle behind the `available` phase, until it is installed. */
  let handle: UpdateHandle | null = null;
  const listeners = new Set<() => void>();

  function set(next: UpdateState) {
    state = next;
    for (const listener of listeners) listener();
  }

  /** Release a superseded handle: the shell holds a resource behind it. */
  async function dropHandle() {
    const stale = handle;
    handle = null;
    if (!stale) return;
    try {
      await stale.close();
    } catch {
      // Best effort — the next check replaces it either way.
    }
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async check() {
      if (!gateway) {
        set({ phase: "unsupported" });
        return;
      }
      await dropHandle();
      set({ phase: "checking" });
      try {
        const found = await gateway.check();
        if (!found) {
          set({ phase: "current" });
          return;
        }
        handle = found;
        set({ phase: "available", update: toPending(found) });
      } catch (error) {
        set({ phase: "error", operation: "check", message: errorMessage(error) });
      }
    },

    async install() {
      // A second install while one is running would download and apply the same
      // update twice; the button disappearing is a render behind the click.
      if (state.phase === "downloading" || state.phase === "installing") return;
      const pending = handle && toPending(handle);
      if (!gateway || !handle || !pending) return;
      let progress: DownloadProgress = { downloaded: 0, total: null };
      let shown: ShownProgress = { percent: -1, bytes: 0 };
      set({ phase: "downloading", update: pending, ...progress });
      try {
        await handle.downloadAndInstall((next) => {
          progress = next;
          const step = reportableProgress(next, shown);
          if (!step) return;
          shown = step;
          set({ phase: "downloading", update: pending, ...progress });
        });
        // Windows leaves the app to the installer; macOS and Linux only pick the
        // new version up on restart, so the restart is part of installing.
        set({ phase: "installing", update: pending });
        handle = null;
        await gateway.relaunch();
      } catch (error) {
        set({ phase: "error", operation: "install", message: errorMessage(error) });
      }
    },
  };
}

/** The shell's gateway: the updater plugin's manifest plus the restart that
 *  runs the version it installed. */
const shellGateway: UpdateGateway = {
  async check() {
    const update = await check();
    if (!update) return null;
    return {
      version: update.version,
      currentVersion: update.currentVersion,
      date: update.date,
      body: update.body,
      async downloadAndInstall(onProgress) {
        let downloaded = 0;
        let total: number | null = null;
        await update.downloadAndInstall((event) => {
          if (event.event === "Started") {
            total = event.data.contentLength ?? null;
          } else if (event.event === "Progress") {
            downloaded += event.data.chunkLength;
          } else {
            // Finished: the install follows immediately, so the bar is done.
            return;
          }
          onProgress({ downloaded, total });
        });
      },
      close: () => update.close(),
    };
  },

  relaunch,
};

/** Null in the browser demo, where there is no shell to update. */
export function defaultUpdateGateway(): UpdateGateway | null {
  return isTauri() ? shellGateway : null;
}
