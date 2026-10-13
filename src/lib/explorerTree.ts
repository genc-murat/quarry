import type { DatabaseObject, NamespaceInfo } from "./types";

/**
 * Cache for the explorer tree, kept outside React so it survives the sidebar
 * switch that unmounts the panel. Every key is session-scoped
 * (`${sessionId}||...`), which lets a disconnect drop exactly one session's
 * entries instead of accumulating them for the lifetime of the app.
 *
 * The cache is also bounded: a "tree" is one session+database pair with every
 * namespace and object-kind group beneath it. At most `MAX_EXPLORER_TREES`
 * trees are retained; the least-recently-viewed ones are evicted, so a very
 * long session browsing hundreds of databases cannot grow it without limit.
 */
export interface ExplorerTreeCache {
  expanded: Record<string, boolean>;
  namespaces: Record<string, NamespaceInfo[]>;
  objects: Record<string, DatabaseObject[]>;
  groupOpen: Record<string, boolean>;
}

/** How many distinct database trees the cache keeps before evicting the LRU. */
export const MAX_EXPLORER_TREES = 64;

const backing: ExplorerTreeCache = {
  expanded: {},
  namespaces: {},
  objects: {},
  groupOpen: {},
};

/**
 * Tree keys (`${sessionId}||${database}`) ordered least- to most-recently used.
 * `touchExplorerTree` pushes a tree to the end whenever it is opened or its
 * data is read.
 */
let recency: string[] = [];

/** Keys are `${sessionId}||${database}||${namespace}` (groups append `#kind`). */
export function explorerSessionPrefix(sessionId: string): string {
  return `${sessionId}||`;
}

/** Identity of one database's tree within a session. */
export function explorerTreeKey(sessionId: string, database: string): string {
  return `${sessionId}||${database}`;
}

function dropByPrefix<T>(entries: Record<string, T>, prefix: string): Record<string, T> {
  return Object.fromEntries(Object.entries(entries).filter(([key]) => !key.startsWith(prefix)));
}

/**
 * The `${sessionId}||${database}` a cache key belongs to, or null when the key
 * is not a database tree at all — a connection's own root row
 * (`${sessionId}||`) is panel state that sits in `expanded` beside the trees
 * but neither counts against nor is evicted by the cap.
 */
function treeOf(key: string): string | null {
  const first = key.indexOf("||");
  if (first === -1) return null;
  const second = key.indexOf("||", first + 2);
  if (second === -1) return null;
  return key.slice(0, second);
}

/** Forget every cached entry of one tree (all namespaces/groups beneath it). */
function dropTree(treeKey: string): void {
  const prefix = `${treeKey}||`;
  backing.expanded = dropByPrefix(backing.expanded, prefix);
  backing.namespaces = dropByPrefix(backing.namespaces, prefix);
  backing.objects = dropByPrefix(backing.objects, prefix);
  backing.groupOpen = dropByPrefix(backing.groupOpen, prefix);
}

/**
 * Enforce the tree cap: evict the least-recently-viewed trees until at most
 * `MAX_EXPLORER_TREES` remain. Trees present in the maps but missing from the
 * recency list count as oldest — that is what keeps a stale tree the panel
 * mirrors back in from sneaking past the cap. Safe to call at any time.
 */
export function pruneExplorerTree(): void {
  const inMaps = new Set<string>();
  for (const map of [backing.expanded, backing.namespaces, backing.objects, backing.groupOpen]) {
    for (const key of Object.keys(map)) {
      const tree = treeOf(key);
      if (tree !== null) inMaps.add(tree);
    }
  }
  const recencySet = new Set(recency);
  const ordered: string[] = [];
  for (const key of inMaps) {
    if (!recencySet.has(key)) ordered.push(key);
  }
  for (const key of recency) ordered.push(key);
  if (ordered.length <= MAX_EXPLORER_TREES) {
    recency = ordered;
    return;
  }
  const cut = ordered.length - MAX_EXPLORER_TREES;
  for (const treeKey of ordered.slice(0, cut)) dropTree(treeKey);
  recency = ordered.slice(cut);
}

/** Mark a tree as the most recently viewed and enforce the cap. */
export function touchExplorerTree(sessionId: string, database: string): void {
  const key = explorerTreeKey(sessionId, database);
  recency = recency.filter((entry) => entry !== key);
  recency.push(key);
  pruneExplorerTree();
}

/**
 * The live cache. Whole-map assignments go through this proxy so the tree cap
 * is re-applied on every write — the cache cannot exceed it no matter how the
 * panel mirrors its React state in (including trees already evicted).
 */
export const explorerTree: ExplorerTreeCache = new Proxy(backing, {
  set(target, property, value) {
    (target as unknown as Record<string, unknown>)[String(property)] = value;
    pruneExplorerTree();
    return true;
  },
});

/**
 * Forget every cached tree entry belonging to a session. Called on disconnect
 * so a long-running app never keeps trees for closed connections.
 */
export function dropExplorerSession(sessionId: string): void {
  const prefix = explorerSessionPrefix(sessionId);
  recency = recency.filter((key) => !key.startsWith(prefix));
  backing.expanded = dropByPrefix(backing.expanded, prefix);
  backing.namespaces = dropByPrefix(backing.namespaces, prefix);
  backing.objects = dropByPrefix(backing.objects, prefix);
  backing.groupOpen = dropByPrefix(backing.groupOpen, prefix);
}

/** Test/bootstrap helper: empty the cache and its LRU ordering. */
export function resetExplorerTree(): void {
  recency = [];
  backing.expanded = {};
  backing.namespaces = {};
  backing.objects = {};
  backing.groupOpen = {};
}
