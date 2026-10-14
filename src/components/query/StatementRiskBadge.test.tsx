import test from "node:test";
import assert from "node:assert/strict";

import { StatementRiskBadge } from "@/components/query/StatementRiskBadge.tsx";
import { mount } from "@/lib/testRender.tsx";
import type { StatementReading } from "@/lib/types.ts";

/** What a real model read `DROP TABLE orders` as (`nimble`, this machine). */
const DESTRUCTIVE: StatementReading = {
  statement: "DROP TABLE orders",
  verdict: "structure",
  level: 2.988,
  confidence: 0.963,
};

test("a destructive reading is marked, in words as well as in colour", async () => {
  const view = await mount(<StatementRiskBadge read={DESTRUCTIVE} />);
  try {
    assert.equal(view.text().trim(), "Removes a table");
    assert.ok(
      view.container.querySelector('[data-statement-risk="structure"]'),
      "the mark is on the element",
    );
  } finally {
    await view.unmount();
  }
});

test("the tooltip says what was read, how sure, and about which statement", async () => {
  const view = await mount(<StatementRiskBadge read={DESTRUCTIVE} />);
  try {
    const element = view.container.querySelector("[data-statement-risk]");
    assert.ok(element, "the badge rendered");
    const title = element.getAttribute("title") ?? "";
    // The words are the model's own step, not a paraphrase: that is what makes the
    // mark say which *kind* of danger it is.
    assert.match(title, /removes a table or its data permanently/);
    assert.match(title, /96%/);
    // The word `this` is the promise that matters: the reading is of the statement
    // as it stands, not of anything it might become.
    assert.match(title, /this exact statement/);
    assert.match(title, /DROP TABLE orders/);
  } finally {
    await view.unmount();
  }
});

test("the mark says which command's statements it is about", async () => {
  // Run and the Script button send different SQL, so their marks have to be
  // tellable apart — by a reader looking at the toolbar as much as by a test.
  const view = await mount(<StatementRiskBadge read={DESTRUCTIVE} subject="script" />);
  try {
    assert.equal(
      view.container
        .querySelector("[data-statement-risk]")
        ?.getAttribute("data-statement-risk-subject"),
      "script",
    );
  } finally {
    await view.unmount();
  }
});

test("an ordinary reading draws nothing", async () => {
  // What a real model read a bounded single-row `UPDATE` and a `SELECT` as, on the
  // scale that puts a one-row `DELETE` beside the bounded `UPDATE`: all three are
  // ordinary edits, and a badge on any of them would be noise on every other one.
  const ordinary: StatementReading[] = [
    { statement: "SELECT * FROM orders WHERE id = 1", verdict: "safe", level: 0.018, confidence: 0.948 },
    {
      statement: "UPDATE orders SET status = 'paid' WHERE id = 1",
      verdict: "bounded",
      level: 1.0,
      confidence: 0.912,
    },
    { statement: "DELETE FROM orders WHERE id = 1", verdict: "bounded", level: 1.052, confidence: 0.782 },
  ];
  for (const read of ordinary) {
    const view = await mount(<StatementRiskBadge read={read} />);
    try {
      assert.equal(view.html(), "", `${read.verdict} drew a badge`);
    } finally {
      await view.unmount();
    }
  }
});

test("a statement the model never read draws nothing", async () => {
  const view = await mount(<StatementRiskBadge read={null} />);
  try {
    assert.equal(view.html(), "", "an unread statement drew a badge");
  } finally {
    await view.unmount();
  }
});

test("every row of a table is its own mark, in its own words", async () => {
  const view = await mount(
    <StatementRiskBadge
      read={{ statement: "DELETE FROM orders", verdict: "rows", level: 1.646, confidence: 0.352 }}
    />,
  );
  try {
    assert.equal(view.text().trim(), "Removes every row");
    assert.ok(view.container.querySelector('[data-statement-risk="rows"]'));
  } finally {
    await view.unmount();
  }
});
