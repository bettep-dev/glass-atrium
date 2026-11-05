# Design Directions — Five Named Directions, OKLch Palettes, Posture, Selection, Binding

> Reference for `glass-atrium-design-designer`: the named-direction library, read before selecting or binding a direction.
> - Each direction carries a concrete spec — mood, references, fonts, OKLch palette, posture — ready to bind into `DESIGN.md` `:root` tokens.
> - Select per project; brand-spec overrides follow the binding flow below.

## Directions

| id | label | mood (1-line) |
|---|---|---|
| `editorial-monocle` | Editorial — Monocle / FT magazine | Print-magazine feel · whitespace · serif headlines · neutral paper+ink + single accent |
| `modern-minimal` | Modern minimal — Linear / Vercel | Quiet · precise · software-native · system fonts · small visible product palette |
| `human-approachable` | Human / approachable — Airbnb / Duolingo | Friendly tactile · clean neutral bg · product-led color · generous radii |
| `tech-utility` | Tech / utility — Datadog / GitHub | Data-dense · monospace-friendly · grid · info-per-sq-inch |
| `brutalist-experimental` | Brutalist / experimental — Are.na / Yale | Loud type · visible grid · system sans + oversized serif · deliberate ugliness |

## Font stacks

| id | displayFont | bodyFont | monoFont |
|---|---|---|---|
| `editorial-monocle` | `'Iowan Old Style', 'Charter', Georgia, serif` | `-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif` | — |
| `modern-minimal` | `-apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif` | `-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif` | — |
| `human-approachable` | `'Söhne', 'Avenir Next', system-ui, sans-serif` | `-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif` | — |
| `tech-utility` | `-apple-system, 'Inter', system-ui, sans-serif` | `-apple-system, 'Inter', system-ui, sans-serif` | `'JetBrains Mono', 'IBM Plex Mono', ui-monospace, Menlo, monospace` |
| `brutalist-experimental` | `'Times New Roman', 'Iowan Old Style', Georgia, serif` | `ui-monospace, 'IBM Plex Mono', 'JetBrains Mono', Menlo, monospace` | — |

## OKLch palettes (verbatim — bind into `DESIGN.md` `:root`)

```css
/* editorial-monocle */
:root {
  --bg: oklch(98% 0.004 95); /* neutral paper, not beige wash */
  --surface: oklch(100% 0.002 95);
  --fg: oklch(20% 0.018 70); /* ink */
  --muted: oklch(48% 0.012 70);
  --border: oklch(90% 0.006 95);
  --accent: oklch(
    52% 0.1 28
  ); /* restrained editorial red — override from brand when available */
}

/* modern-minimal */
:root {
  --bg: oklch(99% 0.002 240);
  --surface: oklch(100% 0 0);
  --fg: oklch(18% 0.012 250);
  --muted: oklch(54% 0.012 250);
  --border: oklch(92% 0.005 250);
  --accent: oklch(58% 0.18 255); /* cobalt */
}

/* human-approachable */
:root {
  --bg: oklch(98% 0.004 240);
  --surface: oklch(100% 0 0);
  --fg: oklch(20% 0.02 240);
  --muted: oklch(50% 0.018 240);
  --border: oklch(90% 0.006 240);
  --accent: oklch(56% 0.12 170); /* brand-safe teal */
}

/* tech-utility */
:root {
  --bg: oklch(98% 0.005 250);
  --surface: oklch(100% 0 0);
  --fg: oklch(22% 0.02 240);
  --muted: oklch(50% 0.018 240);
  --border: oklch(90% 0.008 240);
  --accent: oklch(58% 0.16 145); /* signal green */
}

/* brutalist-experimental */
:root {
  --bg: oklch(98% 0.004 240); /* neutral printer paper */
  --surface: oklch(100% 0 0);
  --fg: oklch(15% 0.02 100);
  --muted: oklch(40% 0.02 100);
  --border: oklch(15% 0.02 100); /* borders are full-strength fg */
  --accent: oklch(60% 0.22 25); /* hot red */
}
```

## Posture cues

- **editorial-monocle**:
  - serif display, sans body, mono for metadata only
  - no shadows, no rounded cards — borders + whitespace
  - one decisive image, cropped only at bottom · kicker/eyebrow in mono uppercase
  - accent used ≤ 2× · never create peach/pink/orange-beige page washes unless brand requires
- **modern-minimal**:
  - tight letter-spacing on display sizes (-0.02em)
  - hairline borders only, no shadows except dropdowns/modals
  - mono numerics with `font-variant-numeric: tabular-nums` · sticky frosted nav
  - content-led layouts with one product illustration
  - primary action color + one secondary signal + status colors; never flood every card with gradients
- **human-approachable**:
  - sans display with strong weight contrast, system body
  - comfortable radii (12–18px) paired with crisp grid alignment
  - primary action color + secondary/domain accent + status colors · subtle elevation only on interactive cards
  - tasteful gradients/glows for hero/product moments, never full-page beige/pastel wash
  - real product screenshots or labelled placeholders
- **tech-utility**:
  - sans display + sans body (one family) OK — utility trumps editorial
  - tabular numerics everywhere, mono for code/IDs/hashes
  - dense tables with hairline borders, no row striping · inline status pills (success/warn/danger) with restrained tinted backgrounds
  - avoid hero images / oversized headlines / marketing copy — show the product
- **brutalist-experimental**:
  - display = serif at extreme sizes (`clamp(80px, 12vw, 200px)`) · body = monospace deliberately
  - borders full-strength fg (1.5–2px), not muted greys
  - asymmetric layouts (70/30 columns) · almost no border-radius (0–2px)
  - no shadows, no gradients · underline links, no hover decoration

## Selection guide

| Direction | Pick when | Typical industries | Avoid when |
|---|---|---|---|
| `editorial-monocle` | publishing · long-form journalism · luxury · magazine / newsletter / essay | media · publishing · luxury fashion · cultural institutions | commerce · SaaS · dashboards (default beige-wash trap) |
| `modern-minimal` | software-native · SaaS landing · dev tool · doc site | dev tools · B2B SaaS · fintech · infra | consumer-emotional brands · marketplaces needing warmth (quiet degrades into shadcn-ification) |
| `human-approachable` | consumer tools · marketplaces · wellness · education · AI assistant · indie SaaS without supplied palette | edtech · healthtech · creator tools | enterprise dashboards · data-dense ops · brutalist briefs (warmth flattens data into pastel wash) |
| `tech-utility` | engineer/operator surfaces · data-dense dashboards · DevOps / observability / admin | monitoring · cloud consoles · IDE-adjacent | marketing site · consumer onboarding · narrative content (density becomes data-slop, story starves) |
| `brutalist-experimental` | art · indie · agency · manifesto · explicitly anti-conventional | galleries · indie magazines · agency portfolios | enterprise · accessibility-sensitive (extreme type breaks scanability) |

- **No direction fits**: bind the nearest direction and carry a documented deviation inline (which token, why) — never a silent sixth direction; an unnamed hybrid is unreproducible by whoever consumes the DESIGN.md next.
- **Posture interpretation**: apply the direction's layout/typography posture alongside its OKLch palette — palette-only is color-correct slop.

## Binding flow (OKLch → `DESIGN.md` `:root`)

- Pick direction → copy the OKLch palette verbatim into `DESIGN.md` § Color Palette & Roles (`:root {}` block per the `~/.claude/agents/templates/DESIGN.md` schema).
- Copy displayFont / bodyFont / (monoFont) into § Typography Rules.
- Transcribe posture into § Visual Theme & Atmosphere + § Do's/Don'ts, anchored with the direction id.
- A brand-spec palette or font overrides the direction; posture stays as the direction states it unless the brand explicitly overrides it.
- A full design-system deliverable may upgrade the palette to the 12-step role ramp (opt-in escalation), with `--bg/--surface/--border/--accent/--fg/--muted` as named step aliases per `~/.claude/agents/references/design-color-algorithms.md`.
