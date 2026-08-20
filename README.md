# Valorant Aim Trainer

A browser-based aim trainer built to match Valorant's actual mechanics, with
session telemetry and a sensitivity analyser.

## Running it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production bundle in dist/
npm test         # 146 tests
```

**Use Chrome or Edge.** They support Pointer Lock's `unadjustedMovement`, which
delivers true unaccelerated mouse counts. Firefox and Safari do not: there the
OS acceleration curve is still applied and your cm/360 will not match Valorant.
The app detects this and warns you rather than silently reporting wrong numbers.

## How sensitivity works

Valorant turns a fixed number of degrees per mouse count:

```
degrees = counts * 0.07 * sensitivity
cm/360  = 360 / (0.07 * sensitivity * dpi) * 2.54
eDPI    = dpi * sensitivity
```

The `0.07` is exact: Source engines use 0.022 deg/count at sens 1.0, and the
Source-to-Valorant conversion is 3.18, giving 0.022 * 3.18 = 0.07.

### RawAccel

RawAccel is a **driver-level** filter — it rewrites mouse packets before any
application sees them. So when you run it, the counts arriving here are
*already accelerated*, and the app must not apply the curve a second time.

The toggle therefore **declares** that a curve is active rather than switching
one on:

- **External** (default): your driver already accelerated the input. The app
  scales 1:1 and uses your declared curve only to *measure* what happened —
  `observedGain()` reports the true degrees-per-count at each instant, and
  `invertCurve()` recovers your real hand speed by inverting
  `outputSpeed = handSpeed * gain(handSpeed)`.
- **Simulated**: you don't run RawAccel, and want to trial a curve in-app.

All nine RawAccel curve families are supported (linear, classic, natural,
synchronous, power, motivity, jump, lookup, off).

## The analyser

Every shot records the crosshair path that led to it: overshoot, micro-
corrections, path efficiency, time-to-target, error angle, and the acceleration
gain in effect. Six independent estimators each propose an optimal sensitivity
and are combined by fit quality:

| Estimator | What it measures |
|---|---|
| Composite peak | Best overall score across sampled sensitivities |
| Overshoot zero-crossing | Where you stop flicking past and start falling short |
| Consistency minimum | Where your error varies least |
| Micro-correction minimum | Where you need fewest adjustments |
| Path efficiency | Where your flicks are straightest |
| Speed/accuracy frontier | The best trade-off point |

Confidence is gated honestly: a lot of data at one sensitivity is still low
confidence, and below 35% the dashboard leads with "not enough data" and a
guided sweep instead of a number.

With RawAccel declared, `analyseAcceleration()` separates two causes that look
identical in a pooled average but need opposite fixes — a base sensitivity
that's too high overshoots at *every* flick speed, while an over-aggressive
curve overshoots only *fast* ones.

## Data accuracy

Every constant is tagged `verified` or `approx` and is editable.

**Verified:** damage tiers and falloff ranges, fire rates, magazine sizes,
reload times, the 0.07 sensitivity constant, the 103-degree horizontal FOV,
pinpoint first-shot accuracy while stationary, 1:1 shield absorption.

**Approx (modelled, not extracted):** spray patterns and spread cones — Riot
has never published these as numbers, so they reproduce the real spray *shape*.
Also movement speeds, hitbox dimensions, equip times, and scope FOVs.

## Layout

```
src/core/     engine-agnostic simulation — no three.js, no DOM
src/render/   three.js renderer, maps, targets, HUD, crosshair
src/input/    raw mouse capture
src/storage/  IndexedDB persistence and export
src/ui/       screens (vanilla TS, no framework)
src/game/     fixed-step loop and per-run orchestration
```

`src/core` is forbidden from importing `three` or touching the DOM. That rule
is what keeps a native desktop port a renderer swap rather than a rewrite.
