import assert from "node:assert/strict";
import test from "node:test";

import { createSectionLoader } from "./sectionLoader.ts";

/** A promise the test resolves by hand, so request ordering is deterministic. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const loader = () => createSectionLoader<string>({ errorMessage: (reason) => String(reason) });

test("a body from the previous object is dropped as soon as the identity changes", async () => {
  const sections = loader();
  await sections.load("default/events", async () => "events rows");
  assert.equal(sections.getState().data, "events rows");

  const slow = deferred<string>();
  const switched = sections.load("default/sessions", () => slow.promise);
  assert.equal(sections.getState().data, null, "the previous body must not stand in");
  assert.equal(sections.getState().loading, true);

  slow.resolve("sessions rows");
  await switched;
  assert.equal(sections.getState().data, "sessions rows");
});

test("a response that arrives after the identity changed is ignored", async () => {
  const sections = loader();
  const slow = deferred<string>();
  const fast = deferred<string>();

  const first = sections.load("default/events", () => slow.promise);
  const second = sections.load("default/sessions", () => fast.promise);

  fast.resolve("sessions rows");
  await second;
  assert.equal(sections.getState().data, "sessions rows");

  // The first request finishes last and must not overwrite the newer body.
  slow.resolve("events rows");
  await first;
  assert.equal(sections.getState().data, "sessions rows");
  assert.equal(sections.getState().loading, false);
});

test("only the newest request commits when two run for the same identity", async () => {
  const sections = loader();
  const slow = deferred<string>();
  const fast = deferred<string>();

  const first = sections.load("default/events", () => slow.promise);
  const second = sections.load("default/events", () => fast.promise);

  fast.resolve("second");
  await second;
  assert.equal(sections.getState().data, "second");

  slow.resolve("stale");
  await first;
  assert.equal(sections.getState().data, "second", "the older response lost the race");
  assert.equal(sections.getState().loading, false, "a stale response cannot flip loading back");
});

test("refreshing keeps the visible body and re-runs the same request", async () => {
  const sections = loader();
  let calls = 0;
  await sections.load("default/events", async () => {
    calls += 1;
    return `rows ${calls}`;
  });
  assert.equal(calls, 1);

  const refreshing = sections.refresh();
  assert.equal(sections.getState().data, "rows 1", "a refresh must not blank the body");
  assert.equal(sections.getState().loading, true);

  await refreshing;
  assert.equal(sections.getState().data, "rows 2");
  assert.equal(calls, 2);
});

test("refresh before any load does nothing", async () => {
  const sections = loader();
  await sections.refresh();
  assert.deepEqual(sections.getState(), { data: null, loading: false, error: "" });
});

test("failures are reported as state and cleared by the next request", async () => {
  const sections = loader();
  await sections.load("default/events", async () => {
    throw new Error("system.query_log is not readable");
  });
  assert.equal(sections.getState().error, "Error: system.query_log is not readable");
  assert.equal(sections.getState().loading, false);
  assert.equal(sections.getState().data, null);

  const pending = deferred<string>();
  const reloading = sections.load("default/events", () => pending.promise);
  assert.equal(sections.getState().error, "", "a new request clears the old error");

  pending.resolve("rows");
  await reloading;
  assert.deepEqual(sections.getState(), { data: "rows", loading: false, error: "" });
});

test("a dropped request cannot report an error", async () => {
  const sections = loader();
  const slow = deferred<string>();
  const fast = deferred<string>();

  const first = sections.load("default/events", () => slow.promise);
  const second = sections.load("default/sessions", () => fast.promise);

  fast.resolve("sessions rows");
  await second;

  slow.reject(new Error("stale failure"));
  await first;
  assert.equal(sections.getState().error, "");
  assert.equal(sections.getState().data, "sessions rows");
});

test("the snapshot is stable until something changes, and subscribers can leave", async () => {
  const sections = loader();
  const snapshot = sections.getState();
  assert.equal(sections.getState(), snapshot, "useSyncExternalStore needs a stable snapshot");

  let notifications = 0;
  const unsubscribe = sections.subscribe(() => {
    notifications += 1;
  });

  const pending = deferred<string>();
  const loading = sections.load("default/events", () => pending.promise);
  assert.notEqual(sections.getState(), snapshot, "a change replaces the snapshot");
  assert.ok(notifications >= 1, "starting a request notifies subscribers");

  pending.resolve("rows");
  await loading;
  const settled = notifications;

  unsubscribe();
  await sections.refresh();
  assert.equal(notifications, settled, "an unsubscribed listener is not called again");
});
