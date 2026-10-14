import test from "node:test";
import assert from "node:assert/strict";

import { AssistantIndicator } from "@/components/query/AssistantIndicator.tsx";
import {
  ASSISTANT_LABEL,
  type AssistantCall,
  type AssistantStatus,
} from "@/lib/assistantStatus.ts";
import { mount } from "@/lib/testRender.tsx";

const STATES: AssistantStatus[] = [
  "off",
  "idle",
  "working",
  "ranked",
  "uncertain",
  "unavailable",
];

test("every state says what it is in words, and carries the state itself", async () => {
  for (const status of STATES) {
    const view = await mount(<AssistantIndicator status={status} />);
    try {
      assert.equal(view.text().trim(), ASSISTANT_LABEL[status], status);
      const element = view.container.querySelector(`[data-assistant-status="${status}"]`);
      assert.ok(element, `${status} is on the element`);
    } finally {
      await view.unmount();
    }
  }
});

test("a problem says what to check", async () => {
  const view = await mount(<AssistantIndicator status="unavailable" />);
  try {
    const element = view.container.querySelector("[data-assistant-status]");
    assert.ok(element, "the indicator rendered");
    assert.match(element.getAttribute("title") ?? "", /Ollama/);
  } finally {
    await view.unmount();
  }
});

test("the quiet states still explain themselves on hover", async () => {
  const view = await mount(<AssistantIndicator status="off" />);
  try {
    const element = view.container.querySelector("[data-assistant-status]");
    assert.ok(element, "the indicator rendered");
    assert.match(element.getAttribute("title") ?? "", /Settings/);
  } finally {
    await view.unmount();
  }
});

test("a list that was left alone says which question went unanswered", async () => {
  // The case the words exist for: a completion behind a qualifier whose ranking
  // the model was not sure enough about, so the language's own order stands.
  const call: AssistantCall = {
    pending: false,
    response: {
      ranked: [],
      choice: "order_number",
      confidence: 0.32,
      available: true,
      reason: "the model was not sure enough (0.32 below 0.15)",
      readings: [],
    },
    failed: false,
    asked: "column",
  };
  const view = await mount(<AssistantIndicator status="uncertain" call={call} />);
  try {
    const element = view.container.querySelector("[data-assistant-status]");
    assert.ok(element, "the indicator rendered");
    const title = element.getAttribute("title") ?? "";
    assert.match(title, /which column you meant/, "the question it was about is not named");
    assert.match(title, /0\.32/, "the model's own words are not quoted");
  } finally {
    await view.unmount();
  }
});
