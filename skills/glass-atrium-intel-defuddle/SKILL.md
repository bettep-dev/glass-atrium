---
name: glass-atrium-intel-defuddle
description: Extract clean markdown content from web pages using Defuddle CLI, removing clutter and navigation to save tokens. Use instead of WebFetch when the user provides a URL to read or analyze, for online documentation, articles, blog posts, or any standard web page. Do NOT use for API endpoints, POST requests, authenticated pages, or non-HTML resources.
---

# Defuddle

## Overview

Extracts clean, readable markdown from web pages using the Defuddle CLI. Removes navigation, ads, sidebars, and boilerplate to produce minimal-token content — typically 60-80% smaller than raw HTML fetch results. Preferred over WebFetch for any standard web page.

## When to Use

- Reading or analyzing any standard web page URL provided by the user
- Fetching online documentation, articles, blog posts, or tutorials
- Collecting source material for wiki raw/ ingestion
- **Exclusions**: API endpoints returning JSON/XML, authenticated pages requiring login, POST requests, non-HTML resources (PDFs, images), pages requiring JavaScript rendering

## Core Process

If not installed: `npm install -g defuddle`

Always use `--md` for markdown output:

```bash
defuddle parse <url> --md
```

Save to file:

```bash
defuddle parse <url> --md -o content.md
```

Extract specific metadata:

```bash
defuddle parse <url> -p title
defuddle parse <url> -p description
defuddle parse <url> -p domain
```

## Output formats

| Flag | Format |
|------|--------|
| `--md` | Markdown (default choice) |
| `--json` | JSON with both HTML and markdown |
| (none) | HTML |
| `-p <name>` | Specific metadata property |

## Common Rationalizations

| Excuse | Rebuttal |
|--------|----------|
| "WebFetch works fine for this URL" | WebFetch returns full HTML including nav, footer, ads — consuming 3-5x more tokens. Defuddle extracts article content only. |
| "I'll just read the raw HTML and extract what I need" | Manual extraction wastes tool calls and tokens. Defuddle handles boilerplate removal in a single CLI invocation. |
| "The page might need JavaScript rendering" | Most documentation and article pages serve content in initial HTML. Try Defuddle first; fall back to WebFetch only on empty results. |

## Red Flags

- Using WebFetch for a standard article or documentation URL when Defuddle is available
- Defuddle output is empty or contains only navigation text (page may require JS — fall back to WebFetch)
- Fetching the same URL multiple times without saving to a file first
- Missing `--md` flag (getting HTML instead of markdown, wasting tokens)
- Using Defuddle for API endpoints or authenticated resources

## Verification

- [ ] Output contains the article's main content (title, body paragraphs, code blocks if any)
- [ ] Output does NOT contain navigation menus, sidebars, cookie banners, or ad text
- [ ] Markdown formatting is preserved (headings, lists, code blocks, links)
- [ ] Token count of Defuddle output is significantly less than equivalent WebFetch result
