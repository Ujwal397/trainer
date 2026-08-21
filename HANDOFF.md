# Handoff — Valorant Aim Trainer

Context dump for starting a fresh session. Read this first; it is written to be
the only thing you need.

Repo: `ujwal397/trainer`, branch **`main`** (all work is merged there).
Run: `npm install && npm run dev` → http://localhost:5173/ (Chrome/Edge only, see below).

---

## 1. Working rules (from the project owner)

These govern how the work is done, not just what:

- **Write efficient, bug-free code.** Correctness over cleverness. Every numeric
  claim must be verifiable, not asserted.
- **Be token efficient.** Don't re-read files you already know. Don't narrate
  options you won't pursue. Don't re-derive settled facts. Batch independent
  tool calls into one message.
- **Model split: Sonnet builds, Opus plans / reviews / supervises.** Delegate
  implementation to Sonnet subagents with precise specs and disjoint file
  ownership so they can run in parallel without collision; the supervising
  session reviews the output, fixes integration, and owns all git operations.
  Subagents are told explicitly: **never** run `git add/commit/push`.
- **Verify visually when the change is visual.** Screenshot it and actually look
  at the image before claiming it works. Several defects here got through
  because a build passing was mistaken for a thing working.
- **Report honestly.** Say what is estimated vs. exact, what failed, what was
  skipped. Never present a guess with a confident number attached.

---

## 2. What this is

A browser aim trainer that reproduces Valorant's mechanics accurately, records
per-shot telemetry, and analyses it to recommend a sensitivity.

Stack: TypeScript + Vite + three.js, vanilla-TS UI (no framework), IndexedDB.
Decision made early: **web first, desktop exe later**, with an engine-agnostic
core so the port is a renderer swap, not a rewrite.

### Architecture

```
src/core/     engine-agnostic simulation — MUST NOT import three.js or touch the DOM
src/render/   three.js renderer, maps, bot mesh, HUD, crosshair
src/input/    raw mouse capture (pointer lock)
src/storage/  IndexedDB + export
src/ui/       screens (menu, settings, results, analyzer, pause)
src/game/     fixed-step loop + per-run orchestration
src/data/     weapon tables
```

**The `src/core` purity rule is load-bearing** — it is what keeps the desktop
port cheap. Do not break it.

---

## 3. Invariants that must not regress

1. **Sensitivity:** `degrees = counts × 0.07 × sensitivity`. The 0.07 is exact
   (Source's 0.022 deg/count × the 3.18 Source→Valorant conversion).
   `cm/360 = 360 / (0.07 × sens × dpi) × 2.54`, `eDPI = dpi × sens`.
2. **RawAccel is an UPSTREAM DRIVER FILTER.** Counts arriving at the app are
   *already accelerated*. The app must **never re-apply the curve** —
   `rawAccelMode: 'external'` (default) scales input 1:1 and uses the declared
   curve only to *measure* (`observedGain`, `invertCurve` recover true hand
   speed). `'simulated'` mode applies it, for trialling a curve you don't run.
   Re-applying would double-accelerate and invalidate every measurement.
3. **Aim error is measured from the CROSSHAIR, pre-spread and pre-recoil.** The
   analyser scores the human's aim, not the gun's dispersion. There is a test
   that fires a 5°-cone weapon at a perfectly-aimed target and asserts the
   recorded error stays ~0.
4. **FOV:** Valorant is a fixed **103° HORIZONTAL** FOV. three.js's
   `camera.fov` is VERTICAL — `vfov = 2·atan(tan(hfov/2)/aspect)`, recomputed on
   every resize. Getting this wrong invalidates every on-screen angle.
5. **The drawn bot must fill its hitbox.** See §5 — this has already broken once.
6. **Fixed-step simulation** (4ms) with interpolated rendering. The trainer is a
   measurement instrument; per-frame simulation would make recorded angles
   depend on frame rate and make sessions incomparable across machines.

---

## 4. What's done

- Sensitivity pipeline + all 9 RawAccel curve families, with curve inversion.
- 7 weapons (Vandal, Phantom, Sheriff, Guardian, Classic, Ghost, Operator):
  damage tiers, fire rates, mags, reloads **verified**; spray patterns and
  spread cones **modelled** (`approx`, tagged in each `sourceNote`).
- 16 scenarios across clicking / tracking / peek.
- Telemetry: per-shot overshoot, micro-corrections, path efficiency,
  time-to-target, error angle, and the acceleration gain in effect.
- Analyzer: 6 independent estimators combined by fit quality. Validated against
  a synthetic player with a known optimum of 0.31 → recovered **0.3031**.
  Confidence gating is honest: 4000 shots at ONE sensitivity still caps < 0.4,
  and below 35% the dashboard refuses to show a number.
- `analyseAcceleration()` separates "base sens too high" (overshoots at every
  flick speed) from "curve too aggressive" (overshoots only fast flicks).
- Four rebuilt maps: range / boxes / angles / site.
- QoL: infinite ammo (toggle, default on), Esc pause menu (Resume / Restart /
  Settings / Quit). **Quitting discards the run on purpose** — partial sessions
  would bias the analyser, which weights by shot count.
- 177 tests passing.

---

## 5. Open work — in priority order

### A. Bot movement is still superhuman (IN PROGRESS, 2 failing tests)
The owner's words: *"idt ANYONE in val can strafe/peak this fast"*.

Uncommitted changes exist in `src/core/scenarios/runtime.ts` and
`src/core/scenarios/definitions.ts`, plus a new `test/bot-realism.test.ts`
which measures peak speed, stationary fraction and reversals/sec over a 20s run.

**2 tests currently FAIL** — they are correct; the bots don't yet meet the bar:
- counter-strafe: needs `stationaryFraction > 0.2` and `reversalsPerSec < 1.2`
- jiggle: needs `stationaryFraction > 0.12` and `reversalsPerSec < 2.6`

Already done: `RIFLE_SPEED_FACTOR` 0.9 → **0.8** (≈5.4 m/s, the cited Valorant
rifle move speed), and counter-strafe now gets a real dwell
(`STOP_TIME_MS + 240–520ms`) instead of only the 50ms deceleration.
Still needed: tune dwell/interval until the measured numbers pass. Don't just
relax the thresholds — they encode "a human could do this".

### B. Bot mesh does not match the Valorant bot (NOT STARTED — agent died to a usage limit)
Current mesh reads as a thin stick figure. Target look: upright rounded canister
head (taller than wide) with a large cyan shield visor; bulky layered chest
plates with a cyan strip; substantial dark pauldrons; **thick** dark limbs with
visible elbow/knee bulges; dark waist + wider pelvis; feet extending forward.
Pale head+chest over a dark heavy frame is the signature.

**Hard requirement:** the drawn body must fill **85–100%** of each hitbox
capsule and never exceed it. Verify by screenshotting `humanoid` mode and
`hitbox-wireframe` mode from the same camera and confirming the silhouettes
agree. Neither of us checked that last time, which is how the mismatch shipped.

File: `src/render/botMesh.ts`. Keep the 3-draw-calls-per-target design (parts →
per-vertex colours → `mergeGeometries` into one geometry per hit zone).

### C. Smaller items
- Red bot variant (2nd reference image) — needs a `variant` field on
  `TargetState`; deliberately not invented unasked.
- `angles` map dogleg/alcove never visually confirmed from inside the corridor.
- Weapon `moveSpeed` is `RUN_SPEED_MS × 0.9`; §A suggests 0.8 is righter.
  Reconcile `src/data/weapons.ts` with `RIFLE_SPEED_FACTOR`.

---

## 6. The hitbox (recently rewritten — read before touching)

`STANDING_HITBOX` in `src/core/constants.ts` is **six capsules**: head, torso,
2 arms, 2 legs. A capsule is a **swept sphere** — its true extent is the segment
plus `radius` in every direction, which is easy to under-estimate.

What was wrong before (all fixed, all now covered by `test/hitbox-sanity.test.ts`):
- head segment 1.66→1.75 r 0.115 = a **32cm tall** hittable head on a 1.86m
  body, against a drawn 9cm head puck. You could shoot 8cm above the skull and
  be given a headshot.
- torso cap bulged to y=1.80, above the jaw — a ray aimed at the head centre
  resolved as a *body* hit.
- **arms weren't in the hitbox at all**, so a clean shot on a visible arm was a
  miss. This was the reported "hitboxes are sooo bad".

Arms now count as body damage (matches Valorant). Legs meet at the centreline so
there's no gap to shoot through.

---

## 7. Gotchas that already cost time

- `flatMaterial(color, roughness)` in `mapKit.ts` — the 2nd arg is **roughness,
  not opacity**. Setting it low makes things shinier, not fainter.
- `mergeGeometries` needs consistent indexing — `Box`/`Cylinder` are indexed,
  `Icosahedron`/`Extrude` are not. Call `.toNonIndexed()` on everything.
- Firing-rate tests: adding `interval` to a float and subtracting it back can
  land a hair under the threshold. Step by `interval + 0.5` in tests.
- Headless screenshots: Chromium at
  `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, args
  `--use-gl=swiftshader --enable-unsafe-swiftshader --no-sandbox`. Install
  playwright, and **uninstall it before committing** so it stays out of
  `package.json`.
- Two parallel agents must use **different preview ports**.
- Browser support: Chrome/Edge give true unaccelerated counts via
  `unadjustedMovement`. Firefox/Safari do not — the app warns loudly rather than
  silently reporting wrong numbers.

---

## 8. Data honesty

Every constant is tagged `verified` or `approx` and is editable.
- **Verified:** damage tiers and falloff, fire rates, mag sizes, reload times,
  the 0.07 constant, 103° hFOV, pinpoint stationary first shot, 1:1 shields.
- **Approx:** spray patterns and spread cones (Riot never published these as
  numbers — these reproduce the real spray *shape*), movement speeds, hitbox
  dimensions, equip times, scope FOVs.

Keep this discipline. An honest `approx` is what lets the owner correct a value
later; a confident wrong number is worse than an admitted estimate.
