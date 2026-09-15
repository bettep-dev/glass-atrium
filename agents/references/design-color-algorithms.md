# Color Algorithms — Seed→Ramp Derivation, 12-Step Role Contract, Contrast Guarantee

> Reference for `glass-atrium-design-designer`: by-hand OKLch color algorithms.
> - Covers seed→tonal-ramp derivation, the 12-step UI-role contract, multi-role seed offsets and contrast-guaranteed foreground derivation.
> - The agent emits palettes by hand and runs no build tool — every table and procedure here is instruction-resident knowledge, not a code import.

## Applicability (opt-in escalation, not a default mandate)

- The 12-step ramp and the multi-role derivation below are an **opt-in escalation for full design-system deliverables** (DESIGN.md / MASTER.md), never a universal mandate.
- A single-page philosophy doc, a canvas or a one-off palette keeps the 6-token shape (`--bg/--surface/--fg/--muted/--border/--accent`).
- "A brand palette MAY upgrade to the 12-step ramp" — never "every palette MUST be 12-step".

---

## 12-Step UI-Role Contract

- A fixed, named 12-step scale in which each step carries an explicit UI role.
- The step count and per-step intent are invariant across every hue — that invariance is the contract.
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

- **Role→step lookup rule**: text always comes from **step 11 (AA)** or **step 12 (AAA)**; borders from **steps 6-8**; solid fills from **steps 9-10** — never improvised.
- **6-token aliases into the ramp** (when upgrading a 6-token palette to 12-step): `--bg`=step 1, `--surface`=step 2-3, `--border`=step 6-7, `--accent`=step 9, `--fg`=step 12, `--muted`=step 11.

### Solid vs alpha pairing

- Every solid step has a parallel alpha step: the same visual result over the matching background, but it composites over arbitrary backgrounds.
- Alpha magnitude rises monotonically with step (≈ step 1 1-2%, step 6 ~15%, step 8 ~25-44%, step 12 ~87%).
- Use the alpha form over **non-flat content** (cards on images, hover/active state layers, borders over content); use the solid form otherwise.
- The alpha SoT is the Dark Theme alpha hierarchy in `agents/glass-atrium-design-designer.md` → `### Dark Theme Rules` — do not duplicate its magnitude table.
  - Related per-state reference, not a second SoT: the per-state alpha values in `agents/glass-atrium-dev-front.md` → `### State Layers`.

---

## Seed → Full Ramp Procedure (fixed-hue lightness sweep)

Derive an entire perceptually-even ramp from one seed by fixing hue and sweeping the lightness axis — not by hand-picking each OKLch lightness.

1. **Seed → OKLch**: read the seed's hue `H` and chroma `C`.
2. **Hold `H` constant** across all 12 steps.
3. **Place 12 steps at the role anchors** (`## 12-Step UI-Role Contract`) by setting OKLch `L` at perceptually-even lightness targets.
4. **Taper `C` at the extremes** (near `L`=0 and `L`=1) to stay inside the sRGB gamut.

---

## Seed → Multi-Role Offsets

From one seed, derive secondary / tertiary / neutral / error palettes by fixed hue + chroma transforms — never by guessing additional brand colors.

| Role | Hue | Chroma (OKLch-analogue) |
|------|-----|-------------------------|
| Primary | seed hue | seed chroma (floor ≈ vivid) |
| Secondary | seed hue | low (≈ seed C / 3, muted) |
| Tertiary | seed hue **+ 60°** | medium (≈ seed C / 2) |
| Neutral | seed hue | near-zero (hue-tinted gray, never pure #888) |
| Neutral-variant | seed hue | slightly above neutral |
| Error | fixed red hue (≈ 25°) | high |

---

## Contrast-Guaranteed Foreground Derivation

> [!WARNING]
> **HCT/CIE-L* tone deltas are NOT OKLch L deltas — never reuse them.**
>
> - The shortcut "ΔL 40 → 3:1, ΔL 50 → 4.5:1" holds for **HCT tone (= CIE L\*) ONLY**, never for OKLch **L** (a different lightness estimator from a different model).
> - HCT chroma magnitudes also differ (HCT chroma can exceed 100; OKLch C is typically < 0.4) — never copy a raw chroma or lightness-delta number across spaces.
> - **Always route contrast through relative luminance `Y`, which is space-independent** — never by copying HCT tone deltas into OKLch.

- Given a background and a target ratio, compute the foreground luminance that meets it (guarantee-by-construction), instead of choosing then verifying.
- Contrast depends only on relative luminance `Y`:

```
ratio = (Lighter_Y + 0.05) / (Darker_Y + 0.05)
```

To guarantee 4.5:1 text on a known background, solve for the foreground luminance directly:

```
target lighter Y = 4.5 * (bg_Y + 0.05) - 0.05          # sRGB-normalized luminance, Y in 0-1
```

- **Dark background → use the lighter foreground** (solve for the lighter `Y` above).
- **Light background → use the darker foreground** (`darker_Y = (bg_Y + 0.05) / ratio - 0.05`).
- Then pick the OKLch `L` whose relative luminance matches the solved `Y`, and **verify**.
- **Fallback**: text from step 11 (AA) or step 12 (AAA) on a step-1/2 background needs no derivation (see `## 12-Step UI-Role Contract`).

---

## Dark-Mode Anchors

Neutral solid-hex anchors for dark mode:

- **App background ≈ #111** — NO pure-black #000 (pure black causes halation/smearing).
- **High-contrast text ≈ #eee** — NO pure-white #fff (pure white is harsh).
- **Low-contrast text ≈ #b4b4b4**.
- These are solid-hex companions to the Dark Theme alpha hierarchy (Primary 0.87 ≈ #ddd-#eee).

---

## Disliked-Color Guard

- A swatch in hue ≈ **90-111°** with non-trivial chroma and low lightness reads as bile / sickly yellow-green.
- If a seed or derived color lands there, **raise its lightness** (toward an L70-equivalent, keep hue + chroma) before emitting.
