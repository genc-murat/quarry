import assert from "node:assert/strict";
import test from "node:test";

import type { DatabaseObject } from "./types.ts";

import {
  MAX_EXPLORER_TREES,
  dropExplorerSession,
  explorerSessionPrefix,
  explorerTree,
  resetExplorerTree,
  touchExplorerTree,
} from "./explorerTree.ts";

/** A cache key for a namespace-less database, as the panel writes it. */
function objectKey(sessionId: string, database: string) {
  return `${sessionId}||${database}||`;
}

function reset() {
  resetExplorerTree();
}

function seed() {
  reset();
  explorerTree.expanded["a||shop||"] = true;
  explorerTree.expanded["b||shop||"] = true;
  explorerTree.namespaces["a||shop||"] = [{ name: "public" }];
  explorerTree.objects["a||shop||"] = [{ name: "orders", kind: "table", schema: "shop" }];
  explorerTree.objects["a||shop||public"] = [{ name: "users", kind: "table", schema: "public" }];
  explorerTree.groupOpen["a||shop||#table"] = false;
  explorerTree.groupOpen["b||shop||#table"] = false;
}

test("the prefix is the session plus the key separator", () => {
  assert.equal(explorerSessionPrefix("abc"), "abc||");
});

test("disconnect drops every entry for that session", () => {
  seed();
  dropExplorerSession("a");
  assert.deepEqual(Object.keys(explorerTree.expanded), ["b||shop||"]);
  assert.deepEqual(Object.keys(explorerTree.namespaces), []);
  assert.deepEqual(Object.keys(explorerTree.objects), []);
  // Group keys share the session prefix even though they carry a `#kind` suffix.
  assert.deepEqual(Object.keys(explorerTree.groupOpen), ["b||shop||#table"]);
});

test("other sessions are untouched", () => {
  seed();
  dropExplorerSession("a");
  assert.equal(explorerTree.expanded["b||shop||"], true);
  assert.equal(explorerTree.groupOpen["b||shop||#table"], false);
});

test("dropping an unknown session is a no-op", () => {
  seed();
  dropExplorerSession("missing");
  assert.equal(Object.keys(explorerTree.expanded).length, 2);
  assert.equal(Object.keys(explorerTree.objects).length, 2);
});

test("a session id that is a prefix of another is not over-matched", () => {
  // `a` must not delete `ab`'s entries: the separator keeps them distinct.
  reset();
  explorerTree.expanded["a||shop||"] = true;
  explorerTree.expanded["ab||shop||"] = true;
  dropExplorerSession("a");
  assert.deepEqual(Object.keys(explorerTree.expanded), ["ab||shop||"]);
});

test("a connection's root row is untouched by the cap and does not consume a slot", () => {
  resetExplorerTree();
  // The root key carries no database: it is the explorer's own panel state.
  explorerTree.expanded["s||"] = false;
  for (let i = 0; i < MAX_EXPLORER_TREES; i++) {
    explorerTree.objects[objectKey("s", `db${i}`)] = [];
    touchExplorerTree("s", `db${i}`);
  }
  // A full cap of real trees survived, none of them pushed out by the root.
  assert.equal(Object.keys(explorerTree.objects).length, MAX_EXPLORER_TREES);
  assert.notEqual(explorerTree.objects[objectKey("s", "db0")], undefined);
  assert.equal(explorerTree.expanded["s||"], false);
});

test("the cache evicts the least-recently-viewed trees past the cap", () => {
  resetExplorerTree();
  const total = MAX_EXPLORER_TREES + 10;
  for (let i = 0; i < total; i++) {
    const db = `db${i}`;
    explorerTree.objects[objectKey("s", db)] = [];
    touchExplorerTree("s", db);
  }
  assert.equal(Object.keys(explorerTree.objects).length, MAX_EXPLORER_TREES);
  // The ten oldest trees were evicted; the ten newest survived.
  for (let i = 0; i < 10; i++) {
    assert.equal(explorerTree.objects[objectKey("s", `db${i}`)], undefined);
  }
  assert.notEqual(explorerTree.objects[objectKey("s", `db${total - 1}`)], undefined);
});

test("re-viewing a tree keeps it while the next oldest is evicted", () => {
  resetExplorerTree();
  for (let i = 0; i < MAX_EXPLORER_TREES; i++) {
    explorerTree.objects[objectKey("s", `db${i}`)] = [];
    touchExplorerTree("s", `db${i}`);
  }
  touchExplorerTree("s", "db5"); // db5 is now the newest tree
  explorerTree.objects[objectKey("s", "dbNew")] = [];
  touchExplorerTree("s", "dbNew"); // must evict db0, not db5
  assert.equal(explorerTree.objects[objectKey("s", "db0")], undefined);
  assert.notEqual(explorerTree.objects[objectKey("s", "db5")], undefined);
});

test("eviction is scoped to the exact tree, not a shared prefix", () => {
  resetExplorerTree();
  explorerTree.objects[objectKey("s", "shop2")] = [];
  explorerTree.objects[objectKey("s", "shop")] = [];
  touchExplorerTree("s", "shop2");
  touchExplorerTree("s", "shop");
  for (let i = 0; i < MAX_EXPLORER_TREES - 1; i++) {
    explorerTree.objects[objectKey("s", `other${i}`)] = [];
    touchExplorerTree("s", `other${i}`);
  }
  // `shop2` is the oldest of MAX+1 trees, so it drops alone.
  assert.equal(explorerTree.objects[objectKey("s", "shop2")], undefined);
  assert.notEqual(explorerTree.objects[objectKey("s", "shop")], undefined);
});

test("disconnecting frees the session's LRU slots", () => {
  resetExplorerTree();
  for (let i = 0; i < MAX_EXPLORER_TREES; i++) {
    explorerTree.objects[objectKey("a", `db${i}`)] = [];
    touchExplorerTree("a", `db${i}`);
  }
  dropExplorerSession("a");
  assert.deepEqual(Object.keys(explorerTree.objects), []);
  // Another session's trees fill the freed slots without evicting each other.
  for (let i = 0; i < MAX_EXPLORER_TREES; i++) {
    explorerTree.objects[objectKey("b", `db${i}`)] = [];
    touchExplorerTree("b", `db${i}`);
  }
  assert.equal(Object.keys(explorerTree.objects).length, MAX_EXPLORER_TREES);
  assert.notEqual(explorerTree.objects[objectKey("b", "db0")], undefined);
});

test("a stale tree mirrored back in cannot exceed the cap", () => {
  resetExplorerTree();
  // Fill one past the cap so `db0` is evicted and dropped from the LRU order.
  for (let i = 0; i <= MAX_EXPLORER_TREES; i++) {
    explorerTree.objects[objectKey("s", `db${i}`)] = [];
    touchExplorerTree("s", `db${i}`);
  }
  assert.equal(explorerTree.objects[objectKey("s", "db0")], undefined);
  // The panel still holds `db0` and mirrors the whole map back; the cache must
  // stay capped because `db0` is no longer in the LRU order.
  const mirrored: Record<string, DatabaseObject[]> = {};
  for (let i = 0; i <= MAX_EXPLORER_TREES; i++) mirrored[objectKey("s", `db${i}`)] = [];
  explorerTree.objects = mirrored;
  assert.equal(Object.keys(explorerTree.objects).length, MAX_EXPLORER_TREES);
  assert.equal(explorerTree.objects[objectKey("s", "db0")], undefined);
});
