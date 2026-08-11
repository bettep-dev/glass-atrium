// Shared esbuild + node:vm harness for the browser-global client screens under
// public/src/screens/*.jsx. Those files carry NO import/export (top-level
// `const { useState } = React`, `window.Screen* =` export), so esbuild emits a plain
// script whose top-level function declarations land on the vm context global — the
// sandbox therefore exercises the ACTUAL shipped source, not a drift-prone copy.
// No DB / no network is touched.
//
// Not a *.test.ts file → outside the `test/*.test.ts` runner glob by design.

import vm from "node:vm";
import esbuild from "esbuild";

// ui.jsx mirror — the rollup skips samples below it.
export const LOW_N_MIN = 30;

export async function buildScreenSandbox<T>(srcPath: string): Promise<T> {
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
  // Module-top reads window.UI.* at evaluation time.
  const uiStub = {
    formatUsd: () => "",
    formatUsdCompact: () => "",
    formatInt: (n: number) => String(n),
    formatTokenCompact: () => "",
    formatPctWithDenominator: (n: number, d: number) => `${((n / d) * 100).toFixed(1)}% (${n}/${d})`,
    LOW_N_MIN,
  };
  const ctx: Record<string, unknown> = {
    window: { UI: uiStub },
    React: reactStub,
    document: { documentElement: {} },
    Intl,
    console,
    fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) }),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(output.text, ctx);
  return ctx as unknown as T;
}
