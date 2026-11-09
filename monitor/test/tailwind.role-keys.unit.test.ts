// Tailwind role keys in public/index.html: each names a tokens.css custom property, each config section
// holds its role set, and the shared shim emits exactly the utilities each section allows.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { getRoleKeyCss, getRoleKeys, type RoleSection } from "./lib/role-keys.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKENS_CSS = readFileSync(resolve(HERE, "../public/styles/tokens.css"), "utf8");

const SECTIONS: RoleSection[] = ["padding", "gap", "margin", "space"];
const GAP_FAMILY = [
  "header", "section", "block", "group-above", "group-below", "label",
  "label-inline", "stack", "list", "control", "control-group",
];
const PREFIXES: Record<RoleSection, string[]> = {
  padding: ["p", "px", "py", "pt", "pr", "pb", "pl"],
  gap: ["gap", "gap-x", "gap-y"],
  margin: ["m", "mx", "my", "mt", "mr", "mb", "ml"],
  space: ["space-x", "space-y"],
};

const keys = getRoleKeys();

describe("every role key names a custom property tokens.css defines", () => {
  for (const section of SECTIONS) {
    test(`theme.extend.${section}`, () => {
      const entries = Object.entries(keys[section]);
      assert.ok(entries.length > 0, `theme.extend.${section} is empty`);
      for (const [key, value] of entries) {
        const prop = /^var\((--[a-z0-9-]+)\)$/.exec(value)?.[1];
        assert.ok(prop, `${section}.${key} = "${value}" is not a var() of one custom property`);
        assert.match(TOKENS_CSS, new RegExp(`${prop}\\s*:`), `${section}.${key} names ${prop}, undefined in tokens.css`);
      }
    });
  }
});

describe("each config section holds its role set", () => {
  test("padding holds only the page gutter and the card padding", () => {
    assert.deepEqual(keys.padding, { page: "var(--gap-page)", "card-pad": "var(--card-pad)" });
  });

  for (const section of ["gap", "margin", "space"] as const) {
    test(`${section} holds the --gap-* family without page`, () => {
      const expected = Object.fromEntries(GAP_FAMILY.map((key) => [key, `var(--gap-${key})`]));
      assert.deepEqual(keys[section], expected, `${section} drifted from the --gap-* family; a card key would collide with .gap-card`);
    });
  }
});

describe("the shim emits the utilities each section allows", () => {
  const css = getRoleKeyCss(keys);
  const selectors = new Set([...css.matchAll(/^\.([a-z0-9-]+)[\s{]/gm)].map((m) => m[1]));
  const expected = SECTIONS.flatMap((section) =>
    Object.keys(keys[section]).flatMap((key) => PREFIXES[section].map((prefix) => `${prefix}-${key}`)),
  );

  test("one rule per allowed prefix × key pair", () => {
    assert.deepEqual([...selectors].sort(), [...new Set(expected)].sort());
  });

  test("space utilities space the children, never the container", () => {
    assert.match(css, /^\.space-y-stack > :not\(\[hidden\]\) ~ :not\(\[hidden\]\) \{ margin-top: var\(--gap-stack\); \}$/m);
  });
});
