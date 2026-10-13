import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SETTINGS,
  SETTINGS_REGISTRY,
  SETTINGS_SECTIONS,
  mergeSettings,
  readSetting,
  writeSetting,
} from "./settings.ts";

/**
 * These lock the contract that lets the registry be extended safely: an old,
 * partial or hand-edited settings blob must never produce an invalid tree.
 */

test("defaults come from each field default", () => {
  assert.equal(DEFAULT_SETTINGS.appearance.density, "comfortable");
  assert.equal(DEFAULT_SETTINGS.editor.maxRows, 1000);
  assert.equal(DEFAULT_SETTINGS.editor.timeoutMs, 0);
  assert.equal(DEFAULT_SETTINGS.results.pageSize, 200);
  assert.equal(DEFAULT_SETTINGS.safety.requireWhereForWrites, false);
  // Reopening the last connections is on unless the user turns it off.
  assert.equal(DEFAULT_SETTINGS.general.reconnectOnLaunch, true);
});

test("a non-object blob yields exactly the defaults", () => {
  assert.deepEqual(mergeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(mergeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(mergeSettings("nope"), DEFAULT_SETTINGS);
  assert.deepEqual(mergeSettings(42), DEFAULT_SETTINGS);
});

test("unknown sections and keys are dropped", () => {
  const merged = mergeSettings({
    nonsense: true,
    appearance: { bogus: 1, density: "compact" },
  });
  assert.equal(merged.appearance.density, "compact");
  assert.ok(!("bogus" in merged.appearance), "unknown key survived");
  assert.ok(!("nonsense" in merged), "unknown section survived");
  assert.deepEqual(Object.keys(merged).sort(), Object.keys(SETTINGS_REGISTRY).sort());
});

test("out-of-range numbers are clamped to their field bounds", () => {
  const merged = mergeSettings({
    appearance: { fontSize: 999 },
    editor: { maxRows: 0, timeoutMs: -1 },
    results: { pageSize: -5 },
  });
  assert.equal(merged.appearance.fontSize, 18);
  assert.equal(merged.editor.maxRows, 1);
  assert.equal(merged.editor.timeoutMs, 0);
  assert.equal(merged.results.pageSize, 10);

  const below = mergeSettings({ appearance: { fontSize: 2 } });
  assert.equal(below.appearance.fontSize, 10);
});

test("numeric strings are parsed and rounded", () => {
  const merged = mergeSettings({ editor: { maxRows: "250" }, results: { pageSize: "333.7" } });
  assert.equal(merged.editor.maxRows, 250);
  assert.equal(merged.results.pageSize, 334);
});

test("non-numeric values fall back to the field default", () => {
  assert.equal(mergeSettings({ editor: { maxRows: "abc" } }).editor.maxRows, 1000);
  assert.equal(mergeSettings({ appearance: { fontSize: NaN } }).appearance.fontSize, 12);
});

test("selects only accept declared options", () => {
  const rejected = mergeSettings({
    appearance: { density: "spacious" },
    editor: { tabSize: "3" },
    results: { nullDisplay: "??", copyFormat: "xml" },
  });
  assert.equal(rejected.appearance.density, "comfortable");
  assert.equal(rejected.editor.tabSize, "2");
  assert.equal(rejected.results.nullDisplay, "NULL");
  assert.equal(rejected.results.copyFormat, "tsv");

  const accepted = mergeSettings({ appearance: { density: "compact" }, editor: { tabSize: "4" } });
  assert.equal(accepted.appearance.density, "compact");
  assert.equal(accepted.editor.tabSize, "4");
});

test("an empty-string select option is honoured", () => {
  assert.equal(mergeSettings({ results: { nullDisplay: "" } }).results.nullDisplay, "");
});

test("booleans must be real booleans", () => {
  assert.equal(mergeSettings({ editor: { wordWrap: "yes" } }).editor.wordWrap, false);
  assert.equal(mergeSettings({ editor: { wordWrap: 1 } }).editor.wordWrap, false);
  assert.equal(mergeSettings({ results: { showColumnTypes: false } }).results.showColumnTypes, false);
  assert.equal(mergeSettings({ editor: { lineNumbers: true } }).editor.lineNumbers, true);
});

test("dotted-path write/read round-trips and stays coerced", () => {
  let settings = mergeSettings(undefined);

  settings = writeSetting(settings, "appearance.density", "compact");
  assert.equal(readSetting(settings, "appearance.density"), "compact");

  settings = writeSetting(settings, "editor.maxRows", 500);
  assert.equal(readSetting(settings, "editor.maxRows"), 500);

  // writeSetting clamps too, so the store can never hold an invalid value.
  settings = writeSetting(settings, "editor.timeoutMs", 9_999_999);
  assert.equal(readSetting(settings, "editor.timeoutMs"), 3_600_000);

  settings = writeSetting(settings, "editor.tabSize", "8");
  assert.equal(readSetting(settings, "editor.tabSize"), "8");

  settings = writeSetting(settings, "results.nullDisplay", "∅");
  assert.equal(readSetting(settings, "results.nullDisplay"), "∅");
});

test("writeSetting is immutable", () => {
  const base = mergeSettings(undefined);
  const next = writeSetting(base, "editor.maxRows", 5);
  assert.equal(base.editor.maxRows, 1000, "original was mutated");
  assert.equal(next.editor.maxRows, 5);
  assert.notEqual(base, next);
  assert.notEqual(base.editor, next.editor);
});

test("the panel schema is derived from the registry", () => {
  assert.deepEqual(
    SETTINGS_SECTIONS.map((section) => section.id),
    ["appearance", "editor", "results", "safety", "general"],
  );
  for (const section of SETTINGS_SECTIONS) {
    assert.ok(section.title.length > 0, `${section.id} has no title`);
    assert.ok(section.fields.length > 0, `${section.id} has no fields`);
    for (const field of section.fields) {
      assert.ok(field.label.length > 0, `${field.path} has no label`);
      assert.ok(
        field.path.startsWith(`${section.id}.`),
        `${field.path} is not namespaced under ${section.id}`,
      );
      if (field.kind === "select") assert.ok((field.options?.length ?? 0) > 0, field.path);
    }
  }
});
