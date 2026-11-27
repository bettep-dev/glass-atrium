# Critically Damped Spring (Halflife-based)

## Purpose

- Use for camera smoothing, object follow, and any value that must converge to a target without overshoot.

## API

- `halflife`: time to halve the distance (seconds) — larger = slower, softer follow
- `dt`: delta time (seconds, clamped to `1/30`)
- Returns `[newPos, newVel]` — feed back into next frame

## Reference Implementation (TypeScript)

```typescript
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

- `4 * ln2 / halflife` is the damping coefficient that yields the requested halflife
- Call once per frame per tracked axis
- For phase transitions: capture current `pos` and `vel` in `enter`, then continue spring update toward new target

## Source

- Daniel Holden — "Spring-It-On: The Game Developer's Spring-Roll-Call" (https://theorangeduck.com/page/spring-roll-call)
