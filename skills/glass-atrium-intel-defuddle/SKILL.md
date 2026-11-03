---
name: glass-atrium-intel-defuddle
description: Extract clean markdown content from web pages using Defuddle CLI, removing clutter and navigation to save tokens. Use instead of WebFetch when the user provides a URL to read or analyze, for online documentation, articles, blog posts, or any standard web page. Do NOT use for API endpoints, POST requests, authenticated pages, or non-HTML resources.
---

# Defuddle

## When to Use

- **Exclusions**: the description's list, plus pages requiring JavaScript rendering

## Core Process

If not installed: `npm install -g defuddle`

| Need | Command |
|------|---------|
| Page text (default choice) | `defuddle parse <url> --md` |
| Page text you will read again: save it once, never re-fetch the URL | `defuddle parse <url> --md -o <file>` |
| One metadata property, e.g. `title`, `description`, `domain` | `defuddle parse <url> -p <name>` |
| JSON with metadata, plus content as both HTML and markdown | `defuddle parse <url> --json` |

Page text always takes `--md`: with no format flag the output is HTML, which wastes tokens.

## Common Rationalizations

| Excuse | Rebuttal |
|--------|----------|
| "WebFetch works fine for this URL" | WebFetch returns a small model's answer, not the page — need the article text (quoting, close reading) → Defuddle. |
| "The page might need JavaScript rendering" | Most documentation and article pages serve content in initial HTML. Try Defuddle first. |

## Verification

- [ ] Output contains the article's main content (title, body paragraphs, code blocks if any)
- Output empty or only navigation text → the page may require JS: fall back to WebFetch
