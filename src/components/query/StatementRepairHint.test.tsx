import test from "node:test";
import assert from "node:assert/strict";

import { StatementRepairHint } from "@/components/query/StatementRepairHint.tsx";
import { mount } from "@/lib/testRender.tsx";
import type { StatementRepair } from "@/lib/types.ts";

/** What the model answered for a mistyped column, as the client reports it. */
const SUGGESTION: StatementRepair = {
  statement: "SELECT ordred_at FROM orders",
  error: "no such column: ordred_at",
  name: "ordered_at",
  confidence: 0.94,
  reason: null,
};

test("the hint says which name the model thinks was meant, in words", async () => {
  const view = await mount(<StatementRepairHint repair={SUGGESTION} />);
  try {
    assert.equal(view.text().replace(/\s+/g, " ").trim(), "Did you mean ordered_at?");
    assert.equal(
      view.container.querySelector("[data-statement-repair]")?.getAttribute("data-statement-repair"),
      "ordered_at",
    );
  } finally {
    await view.unmount();
  }
});

test("the tooltip says it is the model's answer, how sure it was, and about which statement", async () => {
  const view = await mount(<StatementRepairHint repair={SUGGESTION} />);
  try {
    const title = view.container.querySelector("[data-statement-repair]")?.getAttribute("title") ?? "";
    // Attributed to the model, because that is what the claim is: the editor did
    // not decide this, and a tooltip that did not say so would read as one.
    assert.match(title, /local model/);
    assert.match(title, /ordered_at/);
    assert.match(title, /94%/);
    // The statement as it was sent, which is the only text the answer describes.
    assert.match(title, /this exact statement/);
    assert.match(title, /SELECT ordred_at FROM orders/);
  } finally {
    await view.unmount();
  }
});

test("the suggestion can be acted on, and the button says what pressing it does", async () => {
  let fixed = 0;
  const view = await mount(<StatementRepairHint repair={SUGGESTION} onFix={() => (fixed += 1)} />);
  try {
    const button = view.container.querySelector<HTMLElement>("[data-statement-repair-fix]");
    assert.ok(button, "no way to act on the suggestion");
    assert.equal(button.textContent?.trim(), "Fix and run");
    // What it does is the editor's statement, so the tooltip says so rather than
    // leaving a control that rewrites SQL and runs it to be discovered.
    assert.match(button.getAttribute("title") ?? "", /Writes ordered_at into the statement/);
    assert.match(button.getAttribute("title") ?? "", /runs it/);
    button.click();
    assert.equal(fixed, 1, "the button did not call back");
  } finally {
    await view.unmount();
  }
});

test("a hint with nothing to act on draws no button", async () => {
  // The workspace only passes a fix while the statement it would mend is still in
  // the editor. Without one the hint is still worth reading — and still has the
  // name to offer — but it offers no control that would do nothing.
  const view = await mount(<StatementRepairHint repair={SUGGESTION} />);
  try {
    assert.equal(view.container.querySelector("[data-statement-repair-fix]"), null);
    assert.ok(view.container.querySelector("[data-statement-repair]"));
    assert.equal(
      [...view.container.querySelectorAll("button")].length,
      0,
      "a button appeared with nothing to do",
    );
  } finally {
    await view.unmount();
  }
});

test("no name to offer draws nothing at all", async () => {
  // Declined, unsure, and no model ever asked all look the same here — deliberately:
  // the reader is looking at a failure, and "the model had no idea" would be noise
  // beside it. A name the model did not stand behind would be worse than noise.
  const quiet: (StatementRepair | null | undefined)[] = [
    null,
    undefined,
    { ...SUGGESTION, name: null, confidence: 0.94 },
    { ...SUGGESTION, name: null, confidence: 0.08, reason: "the model was not sure enough (0.08 below 0.15)" },
    {
      statement: "SELECT 1",
      error: "no such column: profit_margin_eur",
      name: null,
      confidence: 0,
      reason: "no listed name fits the error",
    },
  ];
  for (const repair of quiet) {
    const view = await mount(<StatementRepairHint repair={repair} />);
    try {
      assert.equal(view.html(), "", `drew a hint for ${JSON.stringify(repair?.name ?? repair)}`);
    } finally {
      await view.unmount();
    }
  }
});
