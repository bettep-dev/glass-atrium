# Third-party notices — `mermaid-layout-elk-0.2.3.min.js`

The vendored bundle beside this file is a minified IIFE re-package built with
`esbuild --legal-comments=none`, which strips every license header the upstream
sources carried. This file restores those notices. Its entries are the `embedded`
list of `mermaid-layout-elk.provenance.json`; that sidecar is the source of truth
and `test/mermaid-elk.vendor-pin.unit.test.ts` fails when an entry there has no
notice here.

The bundle is a derivative work: it contains the packages below in minified,
inlined form. No upstream source was modified — obtain unmodified source from the
repository URL or from the registry tarball the sidecar pins by `tarball_sha512`.

| Package | Version | License | Upstream |
|---------|---------|---------|----------|
| `@mermaid-js/layout-elk` | 0.2.3 | MIT | https://github.com/mermaid-js/mermaid |
| `elkjs` | 0.9.3 | EPL-2.0 | https://github.com/kieler/elkjs |
| `d3` | 7.9.0 | ISC | https://github.com/d3/d3 |
| `mermaid` | 11.17.0 | MIT | https://github.com/mermaid-js/mermaid |

## EPL-2.0 — `elkjs`

`elkjs` is licensed under the Eclipse Public License 2.0. The full license text is
at https://www.eclipse.org/legal/epl-2.0/ and in the `LICENSE` file of the upstream
repository. EPL-2.0 §3.1 requires that the source of the covered code be made
available to recipients of a binary distribution: the unmodified source is the
published `elkjs@0.9.3` package at https://registry.npmjs.org/elkjs/-/elkjs-0.9.3.tgz
and its repository above. This project distributes `elkjs` only as part of the
minified bundle; it applies no patch to it.

## MIT — `@mermaid-js/layout-elk`, `mermaid`

Copyright (c) 2014 - 2024 Knut Sveidqvist

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in the
Software without restriction, including without limitation the rights to use, copy,
modify, merge, publish, distribute, sublicense, and/or sell copies of the Software,
and to permit persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## ISC — `d3`

Copyright 2010-2023 Mike Bostock

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT,
OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE,
DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS
ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS
SOFTWARE.
