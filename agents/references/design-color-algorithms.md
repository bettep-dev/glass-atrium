# Color Algorithms — Seed→Ramp Derivation, 12-Step Role Contract, Contrast Guarantee

> Reference for `glass-atrium-design-designer`: OKLch color algorithms applied by hand, with no build tool; the numeric conversions they name run as a one-off script via Bash, never a project dependency.

## Applicability (opt-in escalation, not a default mandate)

| Deliverable | Palette shape |
|---|---|
| full design-system deliverable (DESIGN.md / MASTER.md) | the 12-step ramp and the multi-role derivation below, as an **opt-in escalation** |
| a single-page philosophy doc, a canvas or a one-off palette | the 6-token shape (`--bg/--surface/--fg/--muted/--border/--accent`) |

- A brand palette may upgrade to the 12-step ramp.

## 12-Step UI-Role Contract

- The step count and per-step intent are invariant across every hue.
- Step 9 is the only step constant across light and dark (the brand anchor).
- Step 11 guarantees AA and step 12 guarantees AAA on step-1/2 backgrounds, so text contrast is never re-derived.

| Step | Role | light example (blue) | dark example (blue) |
|------|------|----------------------|---------------------|
| 1 | App background | #fbfdff | #0d1520 |
| 2 | Subtle background | #f4faff | #111927 |
| 3 | Component background | #e6f4fe | #0d2847 |
| 4 | Component bg hover | #d5efff | #003362 |
| 5 | Component bg active/selected | #c2e5ff | #004074 |
| 6 | Subtle border / separator | #acd8fc | #104d87 |
| 7 | Border (interactive) | #8ec8f6 | #205d9e |
| 8 | Strong border / focus ring | #5eb1ef | #2870bd |
| 9 | Solid fill (brand) — primary CTA bg | #0090ff | #0090ff |
| 10 | Solid fill hover | #0588f0 | #3b9eff |
| 11 | Low-contrast text (≥4.5:1 vs steps 1-2) | #0d74ce | #70b8ff |
| 12 | High-contrast text (≥7:1 vs steps 1-2) | #113264 | #c2e6ff |

- **Role→step lookup rule**: take text, borders and solid fills from their table rows — never improvised.
- **6-token aliases into the ramp** (when upgrading a 6-token palette to 12-step): `--bg`=step 1, `--surface`=step 2-3, `--border`=step 6-7, `--accent`=step 9, `--fg`=step 12, `--muted`=step 11.

### Solid vs alpha pairing

- Every solid step has a parallel alpha step: the same visual result over the matching background, but it composites over arbitrary backgrounds.
- Alpha magnitude rises monotonically with step (≈ step 1 1-2%, step 6 ~15%, step 8 ~25-44%, step 12 ~87%).
- The alpha SoT: `agents/glass-atrium-design-designer.md` → `### Dark Theme Rules` → **Hierarchy (rgba white)**.

| Over | Use |
|---|---|
| **non-flat content** (cards on images, hover/active state layers, borders over content) | the alpha form |
| otherwise | the solid form |

## Seed → Full Ramp Procedure (fixed-hue lightness sweep)

1. **Seed → OKLch**: read the seed's hue `H` and chroma `C`.
2. **Hold `H` constant** across all 12 steps.
3. **Place the 12 steps at the role anchors** by setting OKLch `L` at perceptually-even lightness targets, never hand-picking each step's `L`.
4. **Taper `C` at the extremes** (near `L`=0 and `L`=1) to stay inside the sRGB gamut.

## Seed → Multi-Role Offsets

| Role | Hue | Chroma (OKLch-analogue) |
|------|-----|-------------------------|
| Primary | seed hue | seed chroma (floor ≈ vivid) |
| Secondary | seed hue | low (≈ seed C / 3, muted) |
| Tertiary | seed hue **+ 60°** | medium (≈ seed C / 2) |
| Neutral | seed hue | near-zero (hue-tinted gray, never pure #888) |
| Neutral-variant | seed hue | slightly above neutral |
| Error | fixed red hue (≈ 25°) | high |

## Contrast-Guaranteed Foreground Derivation

> [!WARNING]
> **HCT/CIE-L* tone deltas are not OKLch L deltas — never reuse them.**
>
> - The shortcut "ΔL 40 → 3:1, ΔL 50 → 4.5:1" holds for **HCT tone (= CIE L\*) only**, never for OKLch **L** (a different lightness estimator from a different model).
> - HCT chroma can exceed 100 while OKLch C is typically < 0.4 — never copy a raw chroma or lightness-delta number across spaces.
> - **Always route contrast through relative luminance `Y`, which is space-independent.**

- Given a background and a target ratio, compute the foreground luminance that meets it, instead of choosing then verifying.
- Contrast depends only on `Y` (sRGB-normalized, 0-1): `ratio = (Lighter_Y + 0.05) / (Darker_Y + 0.05)`.
- Solve for the foreground (`ratio` = 4.5 for AA text):

| Background | Foreground | Solve |
|------------|------------|-------|
| dark | lighter | `lighter_Y = ratio * (bg_Y + 0.05) - 0.05` |
| light | darker | `darker_Y = (bg_Y + 0.05) / ratio - 0.05` |

- Then find the OKLch `L` whose relative luminance matches the solved `Y` with a `python3` or `node` one-off.
  - Why: OKLch → linear sRGB → `Y` is a matrix-and-cube chain hand arithmetic gets wrong.
- Verify the emitted pair with the `glass-atrium-design-contrast-check` skill.
- **Fallback**: text from step 11 (AA) or step 12 (AAA) on a step-1/2 background needs no derivation (see `## 12-Step UI-Role Contract`).

## Dark-Mode Anchors

- Neutral solid-hex anchors, the companions to the Dark Theme alpha hierarchy (Primary 0.87 ≈ #ddd-#eee):
  - App background ≈ #111.
  - High-contrast text ≈ #eee.
  - Low-contrast text ≈ #b4b4b4.

## Disliked-Color Guard

- Range: hue ≈ **90-111°** (yellow-green) with non-trivial chroma and low lightness.
- A seed or derived color in that range → **raise its lightness** (toward an L70-equivalent, keep hue + chroma) before emitting.
