// Unit tests for the render-time SSRF egress predicate (shouldAllowRenderRequest)
// that gates the export browser context. Pure — no DB, no chromium, no browser
// pool. Proves the exact allow/abort decision the context.route handler applies.
//
// Runner: node:test (built-in) via tsx — npx tsx --test test/clauded-docs.html-export-interceptor.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { shouldAllowRenderRequest } from "../src/server/clauded-docs/html-export.js";

test("shouldAllowRenderRequest: Tailwind Play CDN is the ONLY allowed host", () => {
  assert.equal(
    shouldAllowRenderRequest("https://cdn.tailwindcss.com/"),
    true,
    "cdn.tailwindcss.com must continue (JIT runtime required at render)",
  );
  // Any path/query on the tailwind host passes — the gate is host-based.
  assert.equal(
    shouldAllowRenderRequest("https://cdn.tailwindcss.com/3.4.1?plugins=forms"),
    true,
  );
});

test("shouldAllowRenderRequest: every non-tailwind host is aborted (script/style/font/xhr)", () => {
  // The **/* route glob passes ALL request types to this predicate, so a single
  // host check covers script/style/font/xhr alike. One representative URL per host.
  const abortedHosts: readonly string[] = [
    "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js", // script
    "https://fonts.googleapis.com/css2?family=Pretendard", // style
    "https://fonts.gstatic.com/s/pretendard/v1/x.woff2", // font
    "https://ajax.googleapis.com/ajax/libs/jquery/3.7.1/jquery.min.js", // xhr/script
    "https://evil.example.com/x.js", // arbitrary attacker host
    "http://169.254.169.254/latest/meta-data/", // SSRF cloud-metadata probe
  ];
  for (const url of abortedHosts) {
    assert.equal(shouldAllowRenderRequest(url), false, `must abort: ${url}`);
  }
});

test("shouldAllowRenderRequest: suffix-host bypass (cdn.tailwindcss.com.evil.com) is aborted", () => {
  assert.equal(
    shouldAllowRenderRequest("https://cdn.tailwindcss.com.evil.com/x.js"),
    false,
    "exact-host match — a suffix-host bypass must not be allowed",
  );
});

test("shouldAllowRenderRequest: fails CLOSED on an unparseable URL", () => {
  assert.equal(shouldAllowRenderRequest("not a url"), false);
  assert.equal(shouldAllowRenderRequest(""), false);
});
