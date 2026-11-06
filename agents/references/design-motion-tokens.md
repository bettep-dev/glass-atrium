# Motion Tokens — ζ→Behavior Table, --ease-* Anchors, Spring→linear() Bridge

> Reference for `glass-atrium-design-designer` ("the agent" below).

## ζ (Damping Ratio) → Perceived Behavior

- `dampingRatio (ζ) = damping / (2 · √(stiffness · mass))` decides the regime.
- `bounce = 1 − ζ`.

| ζ | `bounce` | regime | perceived behavior | use for |
|---|---|---|---|---|
| ζ < 1 (e.g. 0.5–0.8) | 0.2–0.5 | underdamped | overshoots target, 1+ settle oscillation, "lively / natural" | **Spatial** (position / size / shape) |
| ζ = 1 | 0 | critically damped | fastest settle with no overshoot | **Effects** (opacity / color) — flicker-free |
| ζ > 1 | (n/a — use stiffness/damping) | overdamped | slow approach, no overshoot, "heavy" | avoid for UI — sluggish |

- **Independent levers**:
  - stiffness ↑ → faster / snappier (shorter settle);
  - mass ↑ → slower / heavier (longer settle, more momentum);
  - damping ↑ → less bounce (toward ζ=1).
- **Designer-facing input surface**: `visualDuration` + `bounce`; stiffness and damping derive from these.
  - Defaults anchor, independent sets:
    - physics set: stiffness 100 / damping 10 / mass 1;
    - duration/bounce set: bounce 0.3.

## M3 Family → open-props `--ease-*` Reference Anchors

- These open-props token names are reference anchors, not a mandated project toolchain.
  - A project without open-props: glass-atrium-dev-front maps the names to its own tokens.
- The agent's M3 Spatial/Effects model is the SoT.

| M3 family | semantic intent | open-props reference anchor(s) |
|-----------|-----------------|--------------------------------|
| `spatial-fast` | quick move, slight overshoot | `--ease-spring-1` / `-2` |
| `spatial-default` | natural move, 1 gentle overshoot | `--ease-spring-2` / `-3` |
| `spatial-slow` | deliberate, soft overshoot | `--ease-spring-3` |
| `effects-*` | opacity / color, no overshoot | `--ease-out-3` / `-4` (cubic-bezier; never a `-spring-`/`-bounce-` token) |
| reduced-motion fallback | opacity-only | `--ease-out-3` |

## Spring → CSS `linear()` Bridge (agent-side knowledge — glass-atrium-dev-front samples)

- The agent knows this procedure to specify the inputs glass-atrium-dev-front needs (settle-duration band + overshoot intent) and reference the method by name.

1. **Settle window** — step the physics until velocity + remaining distance fall under rest thresholds.
   - The natural duration is an output of the physics, not a guess.
2. **Normalize** — origin = 0, target = 1.
3. **Sample** — read the normalized position at N evenly spaced progress points (N ≈ duration / 30ms resolution).
4. **Round** — each sample to 4 decimals.
5. **Emit** — `<ms> linear(p0, p1, …, 1)`.
   - Values > 1.0 encode overshoot; values dipping then recovering encode bounce.

- Worked spec the agent writes: "spatial-default = visualDuration 0.5s, bounce 0.2; glass-atrium-dev-front samples this into a `<ms> linear(...)` token".

### Orthogonal fallback gates

- The agent declares the fallback token names; glass-atrium-dev-front implements detection.

| Gate | Fires on | Fallback |
|---|---|---|
| Capability gate | a `linear()`-based Spatial family on a no-`linear()` runtime | its own no-overshoot cubic-bezier token |
| Reduced-motion gate | `prefers-reduced-motion: reduce` | Spatial → Effects family (drop overshoot) or opacity-only, on its own no-overshoot cubic-bezier token |

- Capability example: `spatial-default → --ease-spring-2`, fallback `--ease-out-3` — drops overshoot, keeps the move.
