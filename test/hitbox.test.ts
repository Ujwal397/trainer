import { describe, it, expect } from 'vitest';
import type { AgentHitbox, Capsule } from '../src/core/types';
import { STANDING_HITBOX, CROUCH_SCALE } from '../src/core/constants';
import { rayCapsule, transformHitbox, raycastTarget, headCentre, angularRadius } from '../src/core/hitbox';

const VERTICAL_CAPSULE: Capsule = {
  a: { x: 0, y: 0, z: 0 },
  b: { x: 0, y: 2, z: 0 },
  radius: 0.5,
  zone: 'body',
};

describe('rayCapsule', () => {
  it('hits a capsule fired straight at its shaft', () => {
    const t = rayCapsule({ x: 0, y: 1, z: -10 }, { x: 0, y: 0, z: 1 }, VERTICAL_CAPSULE);
    expect(t).not.toBeNull();
    expect(t!).toBeCloseTo(9.5, 6); // 10 - radius
  });

  it('misses a capsule fired well off to the side', () => {
    const t = rayCapsule({ x: 5, y: 1, z: -10 }, { x: 0, y: 0, z: 1 }, VERTICAL_CAPSULE);
    expect(t).toBeNull();
  });

  it('hits the top end sphere when aimed above the shaft', () => {
    // Fired at the very top cap of the capsule (y=2), well above the shaft's flat region.
    const t = rayCapsule({ x: 0, y: 2, z: -10 }, { x: 0, y: 0, z: 1 }, VERTICAL_CAPSULE);
    expect(t).not.toBeNull();
    expect(t!).toBeCloseTo(9.5, 6);
  });

  it('grazes the end sphere tangentially (near-zero discriminant)', () => {
    // Ray parallel to Z, offset horizontally by exactly the radius at the cap's height -
    // a tangent hit, the discriminant-== 0 edge case.
    const origin = { x: 0.5, y: 2, z: -10 };
    const t = rayCapsule(origin, { x: 0, y: 0, z: 1 }, VERTICAL_CAPSULE);
    expect(t).not.toBeNull();
    expect(t!).toBeCloseTo(10, 3);
  });

  it('handles a ray parallel to the capsule axis (degenerate cylinder quadratic)', () => {
    // Ray travels along +y, offset from the axis by less than the radius: it must
    // still register a hit via the end-sphere fallback, not NaN/undefined behaviour.
    const originInside = { x: 0.2, y: -5, z: 0 };
    const t = rayCapsule(originInside, { x: 0, y: 1, z: 0 }, VERTICAL_CAPSULE);
    expect(t).not.toBeNull();
    expect(Number.isFinite(t!)).toBe(true);

    // Offset beyond the radius: parallel ray must miss cleanly (no false positive).
    const originOutside = { x: 5, y: -5, z: 0 };
    const miss = rayCapsule(originOutside, { x: 0, y: 1, z: 0 }, VERTICAL_CAPSULE);
    expect(miss).toBeNull();
  });

  it('returns the closest of multiple valid roots (ray starts outside, both cylinder roots positive)', () => {
    const t = rayCapsule({ x: 0, y: 1, z: -10 }, { x: 0, y: 0, z: 1 }, VERTICAL_CAPSULE);
    // The far side of the cylinder (z ~ 10.5) must not be selected over the near side.
    expect(t!).toBeLessThan(10);
  });

  it('degenerates to a sphere test for a zero-length capsule', () => {
    const pointCapsule: Capsule = { a: { x: 0, y: 0, z: 0 }, b: { x: 0, y: 0, z: 0 }, radius: 1, zone: 'head' };
    const t = rayCapsule({ x: 0, y: 0, z: -5 }, { x: 0, y: 0, z: 1 }, pointCapsule);
    expect(t).not.toBeNull();
    expect(t!).toBeCloseTo(4, 6);
  });
});

describe('transformHitbox', () => {
  it('translates capsules to the target position', () => {
    const pos = { x: 10, y: 0, z: -5 };
    const capsules = transformHitbox(STANDING_HITBOX, pos, 0, false);
    const head = capsules.find((c) => c.zone === 'head')!;
    expect(head.a.x).toBeCloseTo(pos.x + STANDING_HITBOX.capsules[0].a.x, 6);
    expect(head.a.z).toBeCloseTo(pos.z + STANDING_HITBOX.capsules[0].a.z, 6);
  });

  it('leaves radius untouched but compresses y-extent when crouching', () => {
    const pos = { x: 0, y: 0, z: 0 };
    const standing = transformHitbox(STANDING_HITBOX, pos, 0, false);
    const crouched = transformHitbox(STANDING_HITBOX, pos, 0, true);
    for (let i = 0; i < standing.length; i++) {
      expect(crouched[i].radius).toBeCloseTo(standing[i].radius, 10);
      expect(crouched[i].a.y).toBeCloseTo(standing[i].a.y * CROUCH_SCALE.value, 6);
      expect(crouched[i].b.y).toBeCloseTo(standing[i].b.y * CROUCH_SCALE.value, 6);
    }
  });

  it('rotates capsules about +y consistently with a 90-degree turn swapping x/z extents', () => {
    const localHitbox: AgentHitbox = {
      eyeHeightM: 1,
      standingHeightM: 1,
      crouchingHeightM: 1,
      capsules: [{ a: { x: 0, y: 0, z: 0 }, b: { x: 1, y: 0, z: 0 }, radius: 0.1, zone: 'body' }],
    };
    const rotated = transformHitbox(localHitbox, { x: 0, y: 0, z: 0 }, 90, false);
    const b = rotated[0].b;
    // A local +x endpoint rotated 90deg about +y should land on the z axis, not x.
    expect(Math.abs(b.x)).toBeLessThan(1e-6);
    expect(Math.abs(b.z)).toBeCloseTo(1, 6);
  });
});

describe('raycastTarget', () => {
  it('prefers the head on an exact tie between head and body capsules', () => {
    // Identical geometry for both capsules forces a genuine t tie; head is
    // listed first (AgentHitbox's contractual head-first ordering) and must win.
    const shared = { a: { x: 0, y: 0, z: 5 }, b: { x: 0, y: 1, z: 5 }, radius: 1 };
    const tiedCapsules: Capsule[] = [
      { ...shared, zone: 'head' },
      { ...shared, zone: 'body' },
    ];
    const hit = raycastTarget({ x: 0, y: 0.5, z: 0 }, { x: 0, y: 0, z: 1 }, 't1', tiedCapsules);
    expect(hit!.zone).toBe('head');
  });

  it('picks the nearer capsule when hits are not tied', () => {
    const capsules: Capsule[] = [
      { a: { x: 0, y: 0, z: 10 }, b: { x: 0, y: 1, z: 10 }, radius: 0.5, zone: 'head' },
      { a: { x: 0, y: 0, z: 3 }, b: { x: 0, y: 1, z: 3 }, radius: 0.5, zone: 'body' },
    ];
    const hit = raycastTarget({ x: 0, y: 0.5, z: 0 }, { x: 0, y: 0, z: 1 }, 't1', capsules);
    expect(hit!.zone).toBe('body');
    expect(hit!.distanceM).toBeCloseTo(2.5, 6);
  });

  it('returns null when every capsule is missed', () => {
    const capsules: Capsule[] = [{ a: { x: 100, y: 0, z: 0 }, b: { x: 100, y: 1, z: 0 }, radius: 0.2, zone: 'head' }];
    const hit = raycastTarget({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 't1', capsules);
    expect(hit).toBeNull();
  });
});

describe('headCentre', () => {
  it('returns the midpoint of the head capsule', () => {
    const capsules = transformHitbox(STANDING_HITBOX, { x: 0, y: 0, z: 0 }, 0, false);
    const centre = headCentre(capsules);
    const headLocal = STANDING_HITBOX.capsules[0];
    expect(centre.y).toBeCloseTo((headLocal.a.y + headLocal.b.y) / 2, 6);
  });
});

describe('angularRadius', () => {
  it('shrinks as the eye moves farther away', () => {
    const near = angularRadius(VERTICAL_CAPSULE, { x: 0, y: 1, z: -2 });
    const far = angularRadius(VERTICAL_CAPSULE, { x: 0, y: 1, z: -20 });
    expect(far).toBeLessThan(near);
  });

  it('returns 90 degrees when the eye is inside the capsule', () => {
    const r = angularRadius(VERTICAL_CAPSULE, { x: 0, y: 1, z: 0 });
    expect(r).toBe(90);
  });
});
