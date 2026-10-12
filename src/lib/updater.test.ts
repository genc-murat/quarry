import assert from "node:assert/strict";
import test from "node:test";

import {
  createUpdater,
  type DownloadProgress,
  type PendingUpdate,
  type UpdateGateway,
  type UpdateHandle,
  type UpdateState,
} from "./updater.ts";

/**
 * The state machine is the part worth locking down: which phase each outcome
 * lands in, that a failed update never restarts the app, that a chunk storm does
 * not turn into a render storm, and that the handle the shell holds behind an
 * available update is released rather than leaked.
 */

const RELEASE: PendingUpdate = {
  version: "0.2.0",
  currentVersion: "0.1.0",
  date: "2026-01-02T03:04:05Z",
  body: "- fixes the thing",
};

interface FakeOptions {
  release?: PendingUpdate | null;
  fail?: "check" | "install";
  /** The progress events the download emits, in order. */
  chunks?: DownloadProgress[];
  /** Milliseconds the install takes, so two callers can overlap. */
  installMs?: number;
}

interface Fake {
  gateway: UpdateGateway;
  calls: { checks: number; relaunches: number; closed: number; installs: number };
}

function fakeGateway(options: FakeOptions = {}): Fake {
  const calls = { checks: 0, relaunches: 0, closed: 0, installs: 0 };
  const chunks = options.chunks ?? [
    { downloaded: 512, total: 1024 },
    { downloaded: 1024, total: 1024 },
  ];

  const gateway: UpdateGateway = {
    async check() {
      calls.checks += 1;
      if (options.fail === "check") throw new Error("offline");
      const release = options.release === undefined ? RELEASE : options.release;
      if (!release) return null;
      const handle: UpdateHandle = {
        ...release,
        async downloadAndInstall(onProgress) {
          calls.installs += 1;
          if (options.installMs) await new Promise((r) => setTimeout(r, options.installMs));
          if (options.fail === "install") throw new Error("signature mismatch");
          for (const chunk of chunks) onProgress(chunk);
        },
        async close() {
          calls.closed += 1;
        },
      };
      return handle;
    },
    async relaunch() {
      calls.relaunches += 1;
    },
  };

  return { gateway, calls };
}

function phases(state: UpdateState): string {
  return state.phase;
}

test("without a shell the updater stays unsupported and never checks", async () => {
  const updater = createUpdater(null);
  assert.equal(phases(updater.getState()), "unsupported");
  await updater.check();
  assert.equal(phases(updater.getState()), "unsupported");
});

test("a check that finds nothing reports the app is current", async () => {
  const { gateway, calls } = fakeGateway({ release: null });
  const updater = createUpdater(gateway);
  assert.equal(phases(updater.getState()), "idle");

  await updater.check();

  assert.equal(calls.checks, 1);
  assert.equal(phases(updater.getState()), "current");
});

test("a check carries the version, notes and date of the release", async () => {
  const { gateway } = fakeGateway();
  const updater = createUpdater(gateway);

  await updater.check();

  const state = updater.getState();
  assert.equal(state.phase, "available");
  assert.deepEqual(state.phase === "available" ? state.update : null, RELEASE);
});

test("installing reports progress and then restarts the app", async () => {
  const { gateway, calls } = fakeGateway();
  const updater = createUpdater(gateway);
  const seen: string[] = [];
  updater.subscribe(() => seen.push(phases(updater.getState())));

  await updater.check();
  await updater.install();

  assert.equal(calls.installs, 1);
  assert.equal(calls.relaunches, 1);
  assert.equal(phases(updater.getState()), "installing");
  assert.deepEqual(seen, [
    "checking",
    "available",
    // The first phase change starts the bar; the two halves of the download
    // (50%, then 100%) each advance it.
    "downloading",
    "downloading",
    "downloading",
    "installing",
  ]);
});

test("a chunk storm is coalesced to one update per percent point", async () => {
  const TOTAL = 25 * 1024 * 1024;
  const CHUNKS = 1600; // 25 MiB at 16 KiB, which is what a macOS bundle costs.
  const chunks: DownloadProgress[] = [];
  for (let i = 1; i <= CHUNKS; i += 1) {
    chunks.push({ downloaded: Math.round((TOTAL / CHUNKS) * i), total: TOTAL });
  }
  const { gateway } = fakeGateway({ chunks });
  const updater = createUpdater(gateway);
  let updates = 0;
  updater.subscribe(() => {
    updates += 1;
  });

  await updater.check();
  const afterCheck = updates;
  await updater.install();
  const duringInstall = updates - afterCheck;

  // One per percent point plus the phase change into "installing", not 1600.
  assert.ok(duringInstall <= 103, `expected <=103 updates, saw ${duringInstall}`);
  assert.ok(duringInstall >= 50, `expected the bar to keep moving, saw ${duringInstall}`);
  assert.equal(phases(updater.getState()), "installing");
});

test("an unknown download length reports by megabyte, not by chunk", async () => {
  const chunks: DownloadProgress[] = [
    { downloaded: 64 * 1024, total: null },
    { downloaded: 512 * 1024, total: null },
    { downloaded: 2 * 1024 * 1024, total: null },
  ];
  const { gateway } = fakeGateway({ chunks });
  const updater = createUpdater(gateway);
  const seen: UpdateState[] = [];
  updater.subscribe(() => seen.push(updater.getState()));

  await updater.check();
  await updater.install();

  const downloaded = seen.filter((state) => state.phase === "downloading");
  // The phase change, then only the chunk that crossed a megabyte.
  assert.equal(downloaded.length, 2);
  assert.equal(downloaded.at(-1)?.phase === "downloading" ? downloaded.at(-1)!.downloaded : 0, 2 * 1024 * 1024);
});

test("a second install while one is running is ignored", async () => {
  const { gateway, calls } = fakeGateway({ installMs: 20 });
  const updater = createUpdater(gateway);

  await updater.check();
  await Promise.all([updater.install(), updater.install()]);

  assert.equal(calls.installs, 1, "the same update must not be downloaded twice");
  assert.equal(calls.relaunches, 1);
  assert.equal(phases(updater.getState()), "installing");
});

test("a failed install is retried by installing again, not by checking", async () => {
  const { gateway, calls } = fakeGateway({ fail: "install" });
  const updater = createUpdater(gateway);

  await updater.check();
  await updater.install();

  const state = updater.getState();
  assert.equal(state.phase, "error");
  assert.equal(state.phase === "error" ? state.operation : "", "install");
  assert.equal(state.phase === "error" ? state.message : "", "signature mismatch");
  assert.equal(calls.relaunches, 0);

  // The update is still in hand, so the retry installs the same release.
  await updater.install();
  assert.equal(calls.installs, 2);
});

test("a failed check reports the message instead of throwing", async () => {
  const { gateway } = fakeGateway({ fail: "check" });
  const updater = createUpdater(gateway);

  await updater.check();

  const state = updater.getState();
  assert.equal(state.phase, "error");
  assert.equal(state.phase === "error" ? state.operation : "", "check");
  assert.equal(state.phase === "error" ? state.message : "", "offline");
});

test("a later check releases the handle it replaced", async () => {
  const { gateway, calls } = fakeGateway();
  const updater = createUpdater(gateway);

  await updater.check();
  await updater.check();

  assert.equal(calls.checks, 2);
  assert.equal(calls.closed, 1);

  // The superseded handle must not be the one that gets installed.
  await updater.install();
  assert.equal(calls.installs, 1);
  assert.equal(calls.closed, 1);
});

test("installing without an available update does nothing", async () => {
  const { gateway, calls } = fakeGateway({ release: null });
  const updater = createUpdater(gateway);

  await updater.check();
  await updater.install();

  assert.equal(calls.installs, 0);
  assert.equal(calls.relaunches, 0);
  assert.equal(phases(updater.getState()), "current");
});

test("subscribers stop hearing about changes once they unsubscribe", async () => {
  const { gateway } = fakeGateway();
  const updater = createUpdater(gateway);
  let notifications = 0;
  const unsubscribe = updater.subscribe(() => {
    notifications += 1;
  });

  await updater.check();
  const afterCheck = notifications;
  unsubscribe();
  await updater.check();

  assert.ok(afterCheck > 0, "the subscriber saw the check");
  assert.equal(notifications, afterCheck);
});
