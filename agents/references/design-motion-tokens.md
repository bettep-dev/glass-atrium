# Motion Tokens — ζ→Behavior Table, --ease-* Anchors, Spring→linear() Bridge

> Reference for `design-designer` agent. By-hand motion knowledge: the damping-ratio → perceived-behavior table, the M3-family → `--ease-*` reference-anchor table, and the spring→`linear()` sampling procedure (as AGENT-SIDE knowledge). The agent authors WHAT (family selection, perceived-second + bounce intent); **dev-front owns HOW** (the actual `linear()` sampling). The agent NEVER emits a `linear()` body.

## ζ (Damping Ratio) → Perceived Behavior

`dampingRatio (ζ) = damping / (2 · √(stiffness · mass))` — the single number that decides the regime. `bounce = 1 − ζ` (so `bounce 0` = critical damping, `bounce 0.3` = ζ 0.7).

| ζ (damping ratio) | `bounce` (=1−ζ) | regime | perceived behavior | use for |
|-------------------|-----------------|--------|--------------------|---------|
| ζ < 1 (e.g. 0.5–0.8) | 0.2–0.5 | underdamped | overshoots target, 1+ settle oscillation, "lively / natural" | **Spatial** (position / size / shape) |
| ζ = 1 | 0 | critically damped | fastest settle with NO overshoot | **Effects** (opacity / color) — flicker-free |
| ζ > 1 | (n/a — use stiffness/damping) | overdamped | slow approach, no overshoot, "heavy" | rarely — sluggish, avoid for UI |

**Independent levers**: stiffness ↑ → faster / snappier (shorter settle) · mass ↑ → slower / heavier (longer settle, more momentum) · damping ↑ → less bounce (toward ζ=1).

**Designer-facing input surface**: declare `visualDuration` (perceived seconds) + `bounce` (0 = no overshoot … 0.5 = lively) — the physics (stiffness / damping) is derived from these, so the agent reasons in perceived terms, not raw spring constants. Defaults anchor: stiffness 100 / damping 10 / mass 1 / bounce 0.3 (ζ ≈ 0.5).

---

## M3 Family → open-props `--ease-*` Reference Anchors

These open-props token names are **REFERENCE ANCHORS dev-front can translate, NOT a mandated project toolchain**. If the project does not use open-props, the names still serve as a semantic anchor dev-front maps to its own tokens. The agent's M3 Spatial/Effects model is the SoT; these are implementation vocabulary.

| M3 family | semantic intent | open-props reference anchor(s) |
|-----------|-----------------|--------------------------------|
| `spatial-fast` | quick move, slight overshoot | `--ease-spring-1` / `-2` |
| `spatial-default` | natural move, 1 gentle overshoot | `--ease-spring-2` / `-3` |
| `spatial-slow` | deliberate, soft overshoot | `--ease-spring-3` |
| `effects-*` | opacity / color, NO overshoot | `--ease-out-3` / `-4` (cubic-bezier; never a `-spring-`/`-bounce-` token) |
| reduced-motion fallback | opacity-only | `--ease-out-3` |

**Hard rule**: an **Effects family MUST map to a no-overshoot cubic-bezier token, NEVER a spring / bounce `linear()` token** (matches the "Effects = no overshoot, avoids flicker" intent).

---

## Spring → CSS `linear()` Bridge (agent-side knowledge — dev-front samples)

The procedure that turns a named spring family into a deployable `linear()` token. The agent knows this procedure so it can specify the inputs dev-front needs (settle-duration band + overshoot intent) and reference the method by name — **the agent NEVER authors the `linear()` body; dev-front does the sampling**.

1. **Settle window** — step the physics until velocity + remaining distance fall under rest thresholds; the natural duration is an OUTPUT of the physics, not a guess.
2. **Normalize** — origin = 0, target = 1.
3. **Sample** — read the normalized position at N evenly spaced progress points (N ≈ duration / resolution, resolution ~30ms → ≈ 33 samples/sec).
4. **Round** — each sample to 4 decimals.
5. **Emit** — `<ms> linear(p0, p1, …, 1)`. Values **> 1.0 encode overshoot**; values dipping then recovering encode bounce.

So the agent writes the SPEC ("spatial-default = visualDuration 0.5s, bounce 0.2; dev-front samples this into a `<ms> linear(...)` token"); dev-front samples it.

**Two orthogonal fallback gates** (the agent declares the fallback token NAMES; dev-front implements detection):

- **Capability gate** — a `linear()`-based Spatial family also names a cubic-bezier fallback for no-`linear()` runtimes (e.g. `spatial-default → --ease-spring-2`, fallback `--ease-out-3` — drops overshoot, keeps the move).
- **Reduced-motion gate** — under `prefers-reduced-motion: reduce`, switch Spatial → Effects family (drop overshoot) or opacity-only, using a no-overshoot cubic-bezier token.

Each gate needs its own no-overshoot fallback token (a `linear()`-unsupported browser ≠ a reduced-motion user).
