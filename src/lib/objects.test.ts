import assert from "node:assert/strict";
import test from "node:test";

import { OBJECT_KIND_LABEL, OBJECT_KIND_ORDER, groupObjectsByKind } from "./objects.ts";
import type { DatabaseObject } from "./types.ts";

function obj(name: string, kind: DatabaseObject["kind"]): DatabaseObject {
  return { name, kind, schema: "shop" };
}

test("groups follow the declared kind order", () => {
  const groups = groupObjectsByKind([
    obj("b", "view"),
    obj("a", "table"),
    obj("t", "trigger"),
    obj("f", "function"),
  ]);
  assert.deepEqual(
    groups.map((group) => group.kind),
    ["table", "view", "function", "trigger"],
  );
});

test("empty groups are dropped", () => {
  const groups = groupObjectsByKind([obj("a", "table")]);
  assert.deepEqual(
    groups.map((group) => group.kind),
    ["table"],
  );
});

test("objects keep their order within a group", () => {
  const groups = groupObjectsByKind([obj("z", "table"), obj("a", "table"), obj("m", "table")]);
  assert.deepEqual(
    groups[0].objects.map((object) => object.name),
    ["z", "a", "m"],
  );
});

test("labels come from the kind label map", () => {
  const groups = groupObjectsByKind([obj("x", "materializedView"), obj("y", "event")]);
  assert.equal(groups[0].label, OBJECT_KIND_LABEL.materializedView);
  assert.equal(groups[1].label, OBJECT_KIND_LABEL.event);
});

test("an unknown kind is folded into other instead of vanishing", () => {
  const groups = groupObjectsByKind([
    obj("a", "table"),
    { name: "mystery", kind: "futureKind" as DatabaseObject["kind"], schema: "shop" },
  ]);
  const other = groups.find((group) => group.kind === "other");
  assert.ok(other, "unknown kind was dropped");
  assert.deepEqual(
    other.objects.map((object) => object.name),
    ["mystery"],
  );
  assert.equal(
    groups.reduce((total, group) => total + group.objects.length, 0),
    2,
  );
});

test("empty input yields no groups", () => {
  assert.deepEqual(groupObjectsByKind([]), []);
});

test("the order lists every labelled kind exactly once", () => {
  assert.deepEqual([...OBJECT_KIND_ORDER].sort(), Object.keys(OBJECT_KIND_LABEL).sort());
  assert.equal(new Set(OBJECT_KIND_ORDER).size, OBJECT_KIND_ORDER.length);
});
