// Shared esbuild + node:vm harness for the browser-global client screens under
// public/src/screens/*.jsx. Those files carry NO import/export (top-level
// `const { useState } = React`, `window.Screen* =` export), so esbuild emits a plain
// script whose top-level function declarations land on the vm context global — the
// sandbox therefore exercises the ACTUAL shipped source, not a drift-prone copy.
// No DB / no network is touched.
//
// Not a *.test.ts file → outside the `test/*.test.ts` runner glob by design.

import vm from "node:vm";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const UI_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../public/src/ui.jsx");

async function transformScript(srcPath: string): Promise<string> {
  const built = await esbuild.build({
    entryPoints: [srcPath],
    bundle: false,
    write: false,
    loader: { ".jsx": "jsx" },
    jsx: "transform",
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
    target: "es2022",
    // No import/export → top-level fn decls become vm-context-global properties.
    format: "esm",
  });
  const output = built.outputFiles[0];
  if (output === undefined) {
    throw new Error(`esbuild produced no output for ${srcPath}`);
  }
  return output.text;
}

export async function buildUiSandbox<T>(): Promise<T> {
  const ctx = await runSandbox([]);
  return (ctx.window as { UI: T }).UI;
}

export async function buildScreenSandbox<T>(srcPath: string): Promise<T> {
  return (await runSandbox([await transformScript(srcPath)])) as unknown as T;
}

// ui.jsx is evaluated FIRST and wrapped in an IIFE: it exports only `window.UI`, so its
// top-level consts must stay out of the shared vm global — a screen redeclaring `formatUsd`
// at top level would otherwise be a SyntaxError rather than a test.
// The screen scripts stay unwrapped, because their top-level fn decls ARE the test surface.
async function runSandbox(screenCodes: string[]): Promise<Record<string, unknown>> {
  const uiCode = `(function(){\n${await transformScript(UI_SRC)}\n})();`;

  // Every hook returns a benign default — only the (uninvoked) component bodies touch
  // React, so the stubs never actually drive a render.
  const reactStub = new Proxy(
    {
      createElement: () => ({}),
      Fragment: "frag",
      useState: () => [undefined, () => {}],
      useEffect: () => {},
      useRef: () => ({ current: null }),
      useMemo: (fn: () => unknown) => fn(),
      useCallback: (fn: unknown) => fn,
    },
    { get: (t: Record<string, unknown>, p: string) => (p in t ? t[p] : () => ({})) },
  );
  // The REAL ui.jsx is evaluated into the same context and self-registers window.UI.
  // A hand-written stub of the shared outcome-rate rule would make every assertion
  // against it an echo of the stub, which is the one thing these suites must not be.
  const ctx: Record<string, unknown> = {
    window: {},
    React: reactStub,
    document: { documentElement: {} },
    Intl,
    console,
    fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) }),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(uiCode, ctx);
  for (const code of screenCodes) {
    vm.runInContext(code, ctx);
  }
  return ctx;
}
