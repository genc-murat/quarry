import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_CELL,
  actionConfirm,
  actionParam,
  cellText,
  cellTone,
  chipText,
  formatBytes,
  formatCell,
} from "./sections.ts";
import type { SectionAction, SectionColumn } from "./types.ts";

const column = (overrides: Partial<SectionColumn> = {}): SectionColumn => ({
  key: "value",
  label: "Value",
  role: "meta",
  format: "text",
  tone: "neutral",
  ...overrides,
});

const action = (overrides: Partial<SectionAction> = {}): SectionAction => ({
  id: "do_it",
  label: "Do it",
  danger: false,
  requireParam: false,
  ...overrides,
});

test("formats numbers, bytes and text using the column format", () => {
  assert.equal(formatCell(column({ format: "bytes" }), 1835008), "1.8 MiB");
  assert.equal(formatCell(column({ format: "bytes" }), 512), "512 B");
  assert.equal(formatCell(column({ format: "number" }), 58231), "58,231");
  assert.equal(formatCell(column(), "MergeTree"), "MergeTree");
  // A value the declared format cannot parse is still shown verbatim.
  assert.equal(formatCell(column({ format: "number" }), "n/a"), "n/a");
});

test("shows an em dash for values a driver could not read", () => {
  assert.equal(formatCell(column(), null), EMPTY_CELL);
  assert.equal(formatCell(column(), ""), EMPTY_CELL);
  assert.equal(chipText(column({ label: "Peak", unit: "ms" }), null), "Peak —");
});

test("appends the column unit", () => {
  assert.equal(cellText(column({ label: "Duration", unit: "ms" }), 18), "18 ms");
  assert.equal(chipText(column({ label: "Duration", unit: "ms" }), 18), "Duration 18 ms");
  assert.equal(chipText(column({ label: "Rows read", format: "number" }), 58231), "Rows read 58,231");
});

test("lets a rich cell override its column tone", () => {
  const status = column({ key: "status", tone: "neutral" });
  assert.equal(cellTone(status, { text: "2 parts remaining", tone: "warning" }), "warning");
  assert.equal(cellTone(status, "plain"), "neutral");
  assert.equal(cellTone(column({ tone: "danger" }), "boom"), "danger");
  // An unknown tone from a newer backend falls back to the column's.
  assert.equal(cellTone(status, { text: "x", tone: "chartreuse" }), "neutral");
});

test("unwraps rich cells for display", () => {
  assert.equal(formatCell(column(), { text: "Complete", tone: "success" }), "Complete");
});

test("reads a row-scoped parameter and disables rows without one", () => {
  const drop = action({ param: "partitionId" });
  assert.equal(actionParam(drop, { partitionId: "202601" }), "202601");
  assert.equal(actionParam(drop, { partitionId: "" }), null);
  assert.equal(actionParam(drop, { partitionId: null }), null);
  assert.equal(actionParam(drop, {}), null);
  // A section-scoped action carries no parameter at all.
  assert.equal(actionParam(action(), { partitionId: "202601" }), null);
});

test("builds one confirmation dialog from the declared copy", () => {
  const drop = action({
    label: "Drop",
    confirmLabel: "Drop partition",
    description: "This cannot be undone.",
    danger: true,
    param: "partitionId",
    requireParam: true,
  });
  assert.deepEqual(actionConfirm(drop, "202601"), {
    title: "Drop partition 202601?",
    description: "This cannot be undone.",
    confirmLabel: "Drop partition",
    destructive: true,
    requireText: "202601",
  });
  // Without a parameter the label stands alone and nothing needs retyping.
  assert.deepEqual(actionConfirm(action(), null), {
    title: "Do it?",
    description: undefined,
    confirmLabel: "Do it",
    destructive: false,
    requireText: undefined,
  });
});

test("formatBytes scales through IEC units", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1.0 KiB");
  assert.equal(formatBytes(65536), "64 KiB");
  assert.equal(formatBytes(1073741824), "1.0 GiB");
});
