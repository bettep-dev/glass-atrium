// The mermaid package's `exports` map ships types for the root entry only
// ("." → dist/mermaid.d.ts); the deep full-bundle path it also exposes via "./*"
// carries no declaration file, so importing it lands on TS7016.
//
// clauded-docs.diagram-types.test.ts imports the full bundle deliberately: the root
// entry (mermaid.core.mjs) registers no built-in diagrams, so detectType throws on
// every type (measured — see that file's comment). The two entries expose the same
// API surface, so the honest declaration is "this specifier has the root entry's type".
declare module "mermaid/dist/mermaid.esm.mjs" {
  const mermaid: typeof import("mermaid").default;
  export default mermaid;
}
