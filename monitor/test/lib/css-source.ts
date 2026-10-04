// CSS-source probes shared by the static stylesheet suites (base.css, the Tweaks panel, screen style blocks).

/** The rules inside every `@media (prefers-reduced-motion: reduce)` block, comments stripped. */
export function getReducedMotionCss(source: string): string {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks: string[] = [];
  for (const m of css.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g)) {
    const start = (m.index ?? 0) + m[0].length;
    let depth = 1;
    let end = start;
    for (; end < css.length && depth > 0; end++) depth += css[end] === "{" ? 1 : css[end] === "}" ? -1 : 0;
    blocks.push(css.slice(start, end - 1));
  }
  return blocks.join("\n");
}
