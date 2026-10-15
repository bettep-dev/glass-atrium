// Screen-level render harness for the browser screens. The sandbox harness the
// client tests already use evaluates a screen module but never renders a
// component; this one supplies a recording React plus a depth-bounded expander,
// so an element-tree assertion is possible without a DOM or react-dom.

import vm from "node:vm";
import esbuild from "esbuild";

export interface RenderedNode {
  type: string;
  props: Record<string, unknown>;
  children: Array<RenderedNode | string>;
}

interface ElementNode {
  __element: true;
  type: unknown;
  props: Record<string, unknown>;
}

const FRAGMENT = Symbol("Fragment");
const MAX_DEPTH = 60;
const IIFE_OPEN = "(() => {";
const IIFE_CLOSE = "})();";

export function createReactStub(): Record<string, unknown> {
  const createElement = (
    type: unknown,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ): ElementNode => ({
    __element: true,
    type,
    props: { ...(props ?? {}), ...(children.length > 0 ? { children } : {}) },
  });

  return {
    createElement,
    Fragment: FRAGMENT,
    useState: (initial: unknown) => [
      typeof initial === "function" ? (initial as () => unknown)() : initial,
      () => undefined,
    ],
    useReducer: (_reducer: unknown, initial: unknown) => [initial, () => undefined],
    useEffect: () => undefined,
    useLayoutEffect: () => undefined,
    useMemo: (factory: () => unknown) => factory(),
    useCallback: (fn: unknown) => fn,
    useRef: (initial: unknown) => ({ current: initial }),
    useContext: () => undefined,
    memo: (fn: unknown) => fn,
  };
}

type EffectCallback = () => void | (() => void);
type RefAttach = (element: ElementNode) => unknown;

export interface EffectReact {
  react: Record<string, unknown>;
  mount: (render: () => unknown, attach: RefAttach) => { tree: unknown; unmount: () => void };
}

/**
 * React stub that commits one render the way React does: host refs attach, then layout effects,
 * then passive effects, each in declaration order. Unmount runs layout cleanups, detaches refs,
 * then passive cleanups — also in declaration order.
 */
export function createEffectReact(): EffectReact {
  let layout: EffectCallback[] = [];
  let passive: EffectCallback[] = [];
  const react = {
    ...createReactStub(),
    useEffect: (effect: EffectCallback) => { passive.push(effect); },
    useLayoutEffect: (effect: EffectCallback) => { layout.push(effect); },
  };

  function mount(render: () => unknown, attach: RefAttach) {
    layout = [];
    passive = [];
    const tree = render();
    const refs = putRefs(tree, attach, []);
    const layoutCleanups = layout.map((effect) => effect());
    const passiveCleanups = passive.map((effect) => effect());
    const unmount = () => {
      runCleanups(layoutCleanups);
      for (const ref of refs) ref.current = null;
      runCleanups(passiveCleanups);
    };
    return { tree, unmount };
  }

  return { react, mount };
}

function putRefs(node: unknown, attach: RefAttach, refs: Array<{ current: unknown }>): Array<{ current: unknown }> {
  if (Array.isArray(node)) {
    for (const child of node) putRefs(child, attach, refs);
    return refs;
  }
  if (!isElement(node)) return refs;

  const ref = node.props.ref as { current: unknown } | undefined;
  if (ref && typeof ref === "object") {
    ref.current = attach(node);
    refs.push(ref);
  }
  return putRefs(node.props.children, attach, refs);
}

function runCleanups(cleanups: Array<void | (() => void)>): void {
  for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
}

export interface FakeDocument {
  activeElement: unknown;
  body: { style: { overflow: string } };
  addEventListener: (type: string, listener: (event: unknown) => void) => void;
  removeEventListener: (type: string, listener: (event: unknown) => void) => void;
  dispatch: (type: string, event: Record<string, unknown>) => void;
  getElementById: (id: string) => unknown;
  elements: Map<string, unknown>;
  querySelector: (selector: string) => unknown;
  attached: Array<{ props: Record<string, unknown> }>;
  reset: () => void;
}

// Just enough `document` for focus, listener and scroll-lock effects; reset() between tests.
export function createFakeDocument(): FakeDocument {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const doc: FakeDocument = {
    activeElement: null,
    body: { style: { overflow: "auto" } },
    addEventListener: (type, listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(listener);
    },
    removeEventListener: (type, listener) => { listeners.get(type)?.delete(listener); },
    dispatch: (type, event) => {
      for (const listener of Array.from(listeners.get(type) ?? [])) listener({ preventDefault: () => undefined, ...event });
    },
    getElementById: (id) => doc.elements.get(id) ?? null,
    elements: new Map(),
    // attribute-presence selectors (`[name]`) only, over `attached` in attach order
    querySelector: (selector) => {
      const name = /^\[([\w-]+)\]$/.exec(selector)?.[1];
      const node = name ? doc.attached.find((candidate) => candidate.props[name] != null) : undefined;
      return node ? { getAttribute: (attr: string) => (node.props[attr] == null ? null : String(node.props[attr])) } : null;
    },
    attached: [],
    reset: () => {
      listeners.clear();
      doc.elements.clear();
      doc.attached.length = 0;
      doc.activeElement = doc.body;
      doc.body.style.overflow = "auto";
    },
  };
  return doc;
}

// Evaluates the shipped screen module in a sandbox and returns its top-level
// bindings (functions and consts), the same shape the existing client tests read.
export async function loadScreenModule(
  src: string,
  globals: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const built = await esbuild.build({
    entryPoints: [src],
    bundle: false,
    write: false,
    loader: { ".jsx": "jsx" },
    jsx: "transform",
    format: "iife",
    target: "es2020",
  });

  const context: Record<string, unknown> = {
    React: createReactStub(),
    console,
    fetch: async () => {
      throw new Error("fetch is not available in the render harness");
    },
    ...globals,
  };
  context.window = context.window ?? context;
  context.globalThis = context;
  vm.createContext(context);
  // esbuild emits `"use strict";\n(() => { … })();` — unwrap by locating the
  // wrapper itself, so the module's top-level declarations land on the context
  // (a line-anchored regex misses the leading directive and cuts only the tail).
  vm.runInContext(unwrapIife(built.outputFiles[0].text), context);
  return context;
}

// Expands function components depth-first into a plain tree. A component that
// throws is surfaced as a node, never swallowed.
export function renderScreen(node: unknown, depth = 0): RenderedNode | string | null {
  if (node === null || node === undefined || node === false || node === true) {
    return null;
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (depth > MAX_DEPTH) {
    throw new Error(`render depth exceeded ${MAX_DEPTH} — component cycle?`);
  }
  if (!isElement(node)) {
    return null;
  }

  const { type, props } = node;
  const rawChildren = Array.isArray(props.children)
    ? props.children
    : props.children === undefined
      ? []
      : [props.children];

  if (typeof type === "function") {
    const rendered = (type as (p: unknown) => unknown)(props);
    const child = renderScreen(rendered, depth + 1);
    const name = (type as { name?: string }).name || "Anonymous";
    return { type: name, props, children: child === null ? [] : [child] };
  }

  const children = flatten(rawChildren)
    .map((child) => renderScreen(child, depth + 1))
    .filter((child): child is RenderedNode | string => child !== null);

  return {
    type: type === FRAGMENT ? "Fragment" : String(type),
    props,
    children,
  };
}

export function findNodes(
  node: RenderedNode | string | null,
  predicate: (candidate: RenderedNode) => boolean,
): RenderedNode[] {
  if (node === null || typeof node === "string") {
    return [];
  }
  const self = predicate(node) ? [node] : [];
  return node.children.reduce<RenderedNode[]>(
    (acc, child) => acc.concat(findNodes(child, predicate)),
    self,
  );
}

export function collectText(node: RenderedNode | string | null): string {
  if (node === null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  return node.children.map(collectText).join(" ");
}

function unwrapIife(text: string): string {
  const open = text.indexOf(IIFE_OPEN);
  const close = text.lastIndexOf(IIFE_CLOSE);
  if (open === -1 || close === -1 || close <= open) {
    throw new Error("esbuild iife wrapper not found — cannot expose top-level bindings");
  }

  return text.slice(open + IIFE_OPEN.length, close);
}

function flatten(values: unknown[]): unknown[] {
  return values.reduce<unknown[]>(
    (acc, value) => acc.concat(Array.isArray(value) ? flatten(value) : [value]),
    [],
  );
}

function isElement(value: unknown): value is ElementNode {
  return value !== null && typeof value === "object" && "__element" in value;
}
