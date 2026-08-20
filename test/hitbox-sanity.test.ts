import { describe, it, expect } from 'vitest';
import { STANDING_HITBOX, EYE_HEIGHT_M, STANDING_HEIGHT_M } from '../src/core/constants';
import { transformHitbox, raycastTarget, headCentre } from '../src/core/hitbox';
import { anglesToDir, normalize, sub, dirToAngles } from '../src/core/math';
import type { Capsule, HitZone } from '../src/core/types';

/** True vertical extent of a capsule: the segment PLUS the radius each end. */
function span(c: Capsule): { lo: number; hi: number } {
  return { lo: Math.min(c.a.y, c.b.y) - c.radius, hi: Math.max(c.a.y, c.b.y) + c.radius };
}

const caps = STANDING_HITBOX.capsules;
const head = caps.filter((c) => c.zone === 'head');
const body = caps.filter((c) => c.zone === 'body');
const legs = caps.filter((c) => c.zone === 'leg');

const EYE = { x: 0, y: EYE_HEIGHT_M.value, z: 0 };
const world = transformHitbox(STANDING_HITBOX, { x: 0, y: 0, z: -10 }, 0, false);

/** Fires at an exact world point and reports which zone, if any, was struck. */
function shootAt(x: number, y: number, z = -10): HitZone | null {
  const dir = normalize(sub({ x, y, z }, EYE));
  return raycastTarget(EYE, dir, 't', world)?.zone ?? null;
}

describe('hitbox proportions', () => {
  it('gives the head a human-sized hittable volume, not a 32cm balloon', () => {
    expect(head).toHaveLength(1);
    const s = span(head[0]);
    const height = s.hi - s.lo;
    // A helmeted human head is ~0.22-0.26m. Anything much taller means the
    // player is rewarded for shooting above the visible skull.
    expect(height).toBeGreaterThan(0.18);
    expect(height).toBeLessThan(0.28);
    expect(head[0].radius * 2).toBeLessThan(0.24);
  });

  it('keeps the eye inside the head, where a camera belongs', () => {
    const s = span(head[0]);
    expect(EYE_HEIGHT_M.value).toBeGreaterThan(s.lo);
    expect(EYE_HEIGHT_M.value).toBeLessThan(s.hi);
  });

  it('does not let the torso cap bulge up past the head', () => {
    const torso = body.reduce((a, b) => (span(a).hi > span(b).hi ? a : b));
    // The old torso reached y=1.80, well above the jaw, which is why a shot
    // aimed dead at the head centre resolved as a body hit.
    expect(span(torso).hi).toBeLessThanOrEqual(span(head[0]).lo + 0.02);
  });

  it('spans the full body height without overshooting the model', () => {
    const lo = Math.min(...caps.map((c) => span(c).lo));
    const hi = Math.max(...caps.map((c) => span(c).hi));
    expect(lo).toBeGreaterThanOrEqual(-0.02);
    expect(hi).toBeLessThanOrEqual(STANDING_HEIGHT_M.value + 0.01);
    // No dead band between the legs and the torso.
    expect(hi - lo).toBeGreaterThan(1.7);
  });
});

describe('hitbox coverage', () => {
  it('registers arms as body hits rather than holes in the model', () => {
    // Arms are visible on the bot; if they were not in the hitbox, a clean
    // shot on one would read as a miss.
    expect(body.length).toBeGreaterThanOrEqual(3);
    expect(shootAt(-0.25, 1.3)).toBe('body');
    expect(shootAt(0.25, 1.3)).toBe('body');
  });

  it('has no free gap to shoot through between the legs', () => {
    expect(legs).toHaveLength(2);
    expect(shootAt(0, 0.5)).toBe('leg');
  });

  it('scores a shot at the head centre as a headshot', () => {
    const hc = headCentre(world);
    const a = dirToAngles(normalize(sub(hc, EYE)));
    expect(raycastTarget(EYE, anglesToDir(a.x, a.y), 't', world)?.zone).toBe('head');
  });

  it('misses cleanly when the shot is genuinely wide of the model', () => {
    expect(shootAt(1.2, 1.3)).toBeNull();
    expect(shootAt(0, 2.6)).toBeNull();
  });

  it('keeps every capsule hittable from the front', () => {
    // Each declared capsule must be reachable — an unreachable one is dead
    // weight that silently never contributes to hit registration.
    for (const c of world) {
      const mid = { x: (c.a.x + c.b.x) / 2, y: (c.a.y + c.b.y) / 2, z: (c.a.z + c.b.z) / 2 };
      const dir = normalize(sub(mid, EYE));
      expect(raycastTarget(EYE, dir, 't', world)).not.toBeNull();
    }
  });
});
