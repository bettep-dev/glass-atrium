// Diagram-node render contract — the ONE selector that decides what counts as a
// mermaid block, and the companion selector that decides when one has finished
// rendering.
//
// Why a module for two strings: the pair is a CONTRACT between four readers that
// have to agree or the system fails silently, not loudly —
//   · the viewer's post-render effect (public/src/screens/clauded-docs.jsx)
//   · the export driver + its zero-svg guard (html-export.ts)
//   · the stored-body validator (html-validator.ts)
//   · the export's source extractor (html-export.ts, reads the raw string)
// A writer that emits a container shape one reader recognises and another does
// not produces a document that validates, exports, and then shows a code block —
// which is exactly the defect this module was extracted for. Divergence here is
// undetectable at every layer that does not compare the two literals.
//
// CLIENT COPY: the viewer is a browser module (esbuild IIFE transpile, no module
// bundling — see the SYNC note above normalizeMermaidSource in clauded-docs.jsx)
// and CANNOT import this file. It carries one named constant instead, pinned to
// this literal by clauded-docs.md-mermaid.test.ts — the drift guard that makes
// the copy safe. Same constraint, same remedy as mermaid-normalize.ts.

/** Every node the render contract treats as a diagram block. */
export const MERMAID_NODE_SELECTOR = "pre.mermaid, .mermaid";

/** A diagram block that has finished rendering — its `<svg>` child is present. */
export const MERMAID_RENDERED_SVG_SELECTOR = "pre.mermaid svg, .mermaid svg";
