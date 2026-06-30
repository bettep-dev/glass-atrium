# Critically Damped Spring (Halflife-based)

> Reference for `dev-animator` agent. Halflife-based critically damped spring damper — Daniel Holden formulation.

## Purpose

Smooth pos + vel tracking with auto-continuity on phase transitions. Frame-rate independent. Use for camera smoothing, object follow, and any value that must converge to a target without overshoot.

## API

`criticalSpringDamperExact(pos, vel, target, halflife, dt) -> [newPos, newVel]`

- `pos`: current position (number)
- `vel`: current velocity (number)
- `target`: target position (number)
- `halflife`: time to halve the distance (seconds) — larger = slower, softer follow
- `dt`: delta time (seconds, clamped to `1/30`)
- Returns `[newPos, newVel]` — feed back into next frame

## Reference Implementation (TypeScript)

```typescript
// Critically Damped Spring — halflife-based (Daniel Holden)
function criticalSpringDamperExact(
  pos: number, vel: number, target: number,
  halflife: number, dt: number
): [number, number] {
  const eps = 1e-5;
  const d = (4 * Math.LN2) / (halflife + eps);
  const y = d * 0.5;
  const j0 = pos - target;
  const j1 = vel + j0 * y;
  const eydt = Math.exp(-y * dt);
  return [eydt * (j0 + j1 * dt) + target, eydt * (vel - j1 * y * dt)];
}
```

## Notes

- `eps` (1e-5) prevents division by zero when `halflife` approaches 0
- `4 * ln2 / halflife` is the damping coefficient that yields the requested halflife
- Pure function — call once per frame per tracked axis (separate calls for x and y)
- For phase transitions: capture current `pos` and `vel` in `enter`, then continue spring update toward new target

## Source

Daniel Holden — "Spring-It-On: The Game Developer's Spring-Roll-Call" (https://theorangeduck.com/page/spring-roll-call)
