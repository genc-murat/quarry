import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DatabaseSelect } from "./DatabaseSelect.tsx";
import type { DatabaseInfo } from "@/lib/types";

const database = (name: string, isSystem = false): DatabaseInfo => ({ name, isSystem });

/**
 * The toolbar picker as the browser would receive it, reduced to the options
 * that carry the collision: their value, which decides what the tab stores, and
 * their label, which is all the user sees.
 */
function render(databases: DatabaseInfo[], value = "") {
  const html = renderToStaticMarkup(
    <DatabaseSelect databases={databases} value={value} onChange={() => {}} />,
  );
  return [...html.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map(
    ([, optionValue, label]) => ({ value: optionValue, label }),
  );
}

test("no two options share a label when a database is called `default`", () => {
  // ClickHouse ships a database named `default`. The placeholder used to carry
  // that same label, so the toolbar showed two identical `default` entries and
  // there was no way to tell the "unset" one from the real database.
  const options = render([database("default"), database("analytics"), database("system", true)]);
  const labels = options.map((option) => option.label);
  assert.equal(new Set(labels).size, labels.length);
  assert.deepEqual(labels.filter((label) => label === "default"), ["default"]);
});

test("the only empty-valued option is the unset placeholder, and it comes first", () => {
  const databases = [database("default"), database("shop")];
  const options = render(databases);
  assert.deepEqual(options.filter((option) => option.value === ""), [options[0]]);
  for (const { name } of databases) assert.notEqual(options[0].label, name);
});

test("a database named after the placeholder still gets its own option", () => {
  const options = render([database("Connection default")]);
  assert.deepEqual(options, [
    { value: "", label: "Connection default 2" },
    { value: "Connection default", label: "Connection default" },
  ]);
});

test("databases follow the placeholder in the order given", () => {
  assert.deepEqual(render([database("shop"), database("analytics")], "shop"), [
    { value: "", label: "Connection default" },
    { value: "shop", label: "shop" },
    { value: "analytics", label: "analytics" },
  ]);
});
