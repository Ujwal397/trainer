/**
 * Builds the merged, vertex-painted "practice bot" geometry used by
 * `TargetPool` in 'humanoid' visual mode.
 *
 * ============================================================================
 * THE FILL CONTRACT — read this before touching any number below.
 *
 * `STANDING_HITBOX` (src/core/constants.ts, authoritative, never edited here)
 * defines six capsules. A capsule is a SWEPT SPHERE: its true extent is the
 * segment plus `radius` in every direction, not just the segment. Every part
 * drawn below must sit INSIDE the true extent of the capsule for its zone and
 * come CLOSE to filling it (roughly 85-100% of that extent), never exceeding
 * it. The previous version of this file computed a head "height" as just the
 * capsule's segment length (0.05 m) and ignored the radius entirely, drawing
 * a flat 5 cm puck inside a capsule whose true vertical extent is 0.25 m — a
 * head you could shoot 10 cm above and still score a "headshot". That bug is
 * why this file was rewritten; every section below derives its size from the
 * capsule's TRUE span (`trueSpan()`), not its segment, specifically so that
 * mistake cannot recur silently. If you resize a part, keep it a fraction of
 * `trueSpan(cap).height` / `cap.radius`, not an eyeballed constant.
 * ============================================================================
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Capsule } from '../core/types';
import { STANDING_HITBOX } from '../core/constants';

/** One merged, vertex-coloured geometry per hit zone. Caller owns disposal. */
export interface HumanoidZoneGeometries {
  head: THREE.BufferGeometry;
  body: THREE.BufferGeometry;
  leg: THREE.BufferGeometry;
}

/**
 * Valorant's practice-range bot reads, at a glance, as a pale head+chest
 * riding a dark, heavy mechanical frame. These are the two "families" of
 * colour every part below picks from — kept in one place so the palette
 * stays coherent instead of each part inventing its own grey.
 */
const PLATE_LIGHT = [0xd9dee3, 0xcdd2d7, 0xc4c9ce]; // canister / chest, lightest to darkest step
const VISOR_CYAN = 0x35d6ec;
const FRAME_DARK = [0x232629, 0x2a2d31, 0x1d1f22, 0x18191c]; // neck/waist/pelvis/limb charcoals
const JOINT_DARK = 0x4b4f56; // distinctly lighter than the limbs so elbows/knees read as joints, not just a taper

/**
 * A capsule's true drawable extent: the segment plus `radius` at both ends.
 * Every size below is a fraction of `.height` or of `cap.radius`, so this
 * file tracks `STANDING_HITBOX` automatically if those numbers ever change —
 * see the file-header contract for why that matters.
 */
function trueSpan(cap: Capsule): { lo: number; hi: number; height: number } {
  const lo = Math.min(cap.a.y, cap.b.y) - cap.radius;
  const hi = Math.max(cap.a.y, cap.b.y) + cap.radius;
  return { lo, hi, height: hi - lo };
}

/**
 * Uniformly paints every vertex of `geo` with `hex` and returns it (for
 * chaining). Also strips any index buffer: `mergeGeometries` requires every
 * input to agree on whether it's indexed, and among the primitives used
 * below `BoxGeometry`/`CylinderGeometry`/`CapsuleGeometry` build indexed
 * geometry while `IcosahedronGeometry`/`ExtrudeGeometry` don't — de-indexing
 * everything here is simpler and cheaper (these are all a few dozen
 * vertices) than threading index buffers through by hand.
 */
function paint(geoIn: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const geo = geoIn.index ? geoIn.toNonIndexed() : geoIn;
  if (geo !== geoIn) geoIn.dispose();
  const c = new THREE.Color(hex);
  const count = geo.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

/** Moves a geometry (already painted) into its final target-local position and returns it. */
function place(geo: THREE.BufferGeometry, x: number, y: number, z: number): THREE.BufferGeometry {
  geo.translate(x, y, z);
  return geo;
}

/**
 * The visor is the one part that isn't a stock primitive: Valorant's bot has
 * a rounded-triangular "shield" plate, point down, on the head's front face.
 * Built as a thin extrusion of a 2D outline so it reads as a distinct plate
 * rather than another grey blob. Proportioned relative to `headDrawR` by the
 * caller (via the scale passed to `translate`/geometry build below).
 */
function buildVisorShape(halfWidth: number, top: number, bottom: number): THREE.Shape {
  const w = halfWidth;
  const shape = new THREE.Shape();
  shape.moveTo(-w, top * 0.35);
  shape.quadraticCurveTo(-w, top, -w * 0.4, top); // rounded top-left corner
  shape.lineTo(w * 0.4, top);
  shape.quadraticCurveTo(w, top, w, top * 0.35); // rounded top-right corner
  shape.quadraticCurveTo(w * 0.6, bottom * 0.55, 0, bottom); // taper to the point
  shape.quadraticCurveTo(-w * 0.6, bottom * 0.55, -w, top * 0.35);
  return shape;
}

/**
 * Builds the three per-zone merged geometries. Called exactly once, from
 * `TargetPool`'s constructor — every pooled slot's mesh then just points at
 * one of these three shared BufferGeometry instances.
 *
 * `headCap`/`bodyCap`/`legCap` are the capsules `TargetPool` already looked
 * up from `STANDING_HITBOX` for those three zones. The two arm capsules
 * aren't passed in individually (there's no separate "arm zone" — arms are
 * `body`-zone, per the hitbox), so they're read directly from
 * `STANDING_HITBOX` here, which also means this file never needs to be told
 * about them by hand.
 */
export function buildHumanoidGeometries(headCap: Capsule, bodyCap: Capsule, legCap: Capsule): HumanoidZoneGeometries {
  const armCaps = STANDING_HITBOX.capsules.filter((cap) => cap.zone === 'body' && cap.a.x !== 0);
  const armL = armCaps.find((cap) => cap.a.x < 0);
  const armR = armCaps.find((cap) => cap.a.x > 0);
  if (!armL || !armR) {
    // STANDING_HITBOX is expected to carry exactly two off-axis 'body'
    // capsules (the arms) alongside the on-axis torso one. If that ever
    // changes, fail loudly rather than silently drawing armless shoulders.
    throw new Error('buildHumanoidGeometries: STANDING_HITBOX is missing left/right arm capsules');
  }

  // ======================================================================
  // HEAD ZONE — upright rounded canister + visor
  // ======================================================================
  const headParts: THREE.BufferGeometry[] = [];
  const headSpan = trueSpan(headCap);
  const headMidY = (headCap.a.y + headCap.b.y) / 2;

  // CapsuleGeometry (a cylinder with hemispherical caps) is the shape that
  // literally matches the hitbox capsule's own silhouette, so sizing it as a
  // fraction of the capsule's own radius/height guarantees a close, safe
  // fill instead of an eyeballed one. radius 95% / total-height 96% of the
  // true capsule span: e.g. with the current hitbox (span 0.25 m tall, 0.20 m
  // wide) this draws a 0.24 m tall, 0.19 m wide canister — inside the spec's
  // 0.22-0.25 tall / 0.18-0.20 wide target band, never exceeding the capsule.
  const headDrawR = headCap.radius * 0.95;
  const headDrawHeight = headSpan.height * 0.96;
  const headDrawLen = Math.max(0.01, headDrawHeight - 2 * headDrawR);
  headParts.push(place(
    paint(new THREE.CapsuleGeometry(headDrawR, headDrawLen, 3, 8), PLATE_LIGHT[0]),
    0, headMidY, 0,
  ));

  // Visor plate: rounded-triangular shield, point down, pressed against the
  // canister's front hemisphere. Depth + placement kept comfortably inside
  // headDrawR (itself already inside the hitbox radius), so the plate never
  // pokes past the head capsule.
  const visorHalfW = headDrawR * 0.48;
  const visorTop = headDrawR * 0.34;
  const visorBottom = -headDrawR * 0.47;
  const visorDepth = headDrawR * 0.15;
  const visorZ = headDrawR - visorDepth - headDrawR * 0.05;
  headParts.push(place(
    paint(new THREE.ExtrudeGeometry(buildVisorShape(visorHalfW, visorTop, visorBottom), { depth: visorDepth, bevelEnabled: false }), VISOR_CYAN),
    0, headMidY - headDrawR * 0.1, visorZ,
  ));

  // Bottom of the drawn head (used to seat the neck flush against it).
  const headBottomY = headMidY - headDrawHeight / 2;

  // ======================================================================
  // BODY ZONE — neck, layered chest plates, waist, pelvis, pauldrons, arms
  // ======================================================================
  const bodyParts: THREE.BufferGeometry[] = [];
  const bodySpan = trueSpan(bodyCap); // true y-extent of the torso capsule, e.g. 0.87..1.59
  const bY = (frac: number) => bodySpan.lo + frac * bodySpan.height;

  // Vertical stack, bottom to top, expressed as fractions of the torso
  // capsule's true height so the whole silhouette re-derives itself if the
  // hitbox is ever retuned. Fractions chosen so the stack is CONTIGUOUS
  // (each boundary is shared by the part above and below it) and spans the
  // capsule's full true range (0.87..1.59 today) — a 100% vertical fill.
  const pelvisTopY = bY(0.35);
  const waistTopY = bY(0.53);
  const lowerChestTopY = bY(0.73);
  const upperChestTopY = bY(0.94);

  // Half-widths as fractions of the torso capsule's radius. The shoulder
  // shelf (widest point) sits at ~95% of the radius — reads as "reaching
  // ~0.36 m across" against the current 0.19 m radius — while still being
  // inboard of the arm capsules that cover the shoulder line above it.
  const shoulderHalfW = bodyCap.radius * 0.95;
  const lowerChestHalfW = bodyCap.radius * 0.80;
  const waistHalfW = bodyCap.radius * 0.42;
  const pelvisHalfW = bodyCap.radius * 0.71;

  // Pelvis: wide dark block, floor flush with the torso capsule's true
  // bottom so there's no gap against the leg zone below it.
  bodyParts.push(place(
    paint(new THREE.BoxGeometry(pelvisHalfW * 2, pelvisTopY - bodySpan.lo, 0.18), FRAME_DARK[1]),
    0, (bodySpan.lo + pelvisTopY) / 2, 0,
  ));
  // Waist: narrow dark segment, distinctly slimmer than pelvis and chest —
  // the "tapers to a narrow waist" read.
  bodyParts.push(place(
    paint(new THREE.BoxGeometry(waistHalfW * 2, waistTopY - pelvisTopY, 0.13), FRAME_DARK[0]),
    0, (pelvisTopY + waistTopY) / 2, 0,
  ));
  // Lower chest plate: pale, stepped narrower than the shoulder shelf above
  // it so the torso reads as layered angular plates rather than one smooth
  // pill (per the reference).
  bodyParts.push(place(
    paint(new THREE.BoxGeometry(lowerChestHalfW * 2, lowerChestTopY - waistTopY, 0.15), PLATE_LIGHT[2]),
    0, (waistTopY + lowerChestTopY) / 2, 0,
  ));
  // Upper chest / shoulder shelf: the widest, topmost plate — bulky raised
  // pectoral shelf.
  bodyParts.push(place(
    paint(new THREE.BoxGeometry(shoulderHalfW * 2, upperChestTopY - lowerChestTopY, 0.16), PLATE_LIGHT[0]),
    0, (lowerChestTopY + upperChestTopY) / 2, 0,
  ));

  // Cyan accent strip across the upper chest, just proud of its front face.
  bodyParts.push(place(
    paint(new THREE.BoxGeometry(shoulderHalfW * 1.7, 0.04, 0.02), VISOR_CYAN),
    0, upperChestTopY - 0.025, 0.085,
  ));

  // Neck: short and thick, bridging the chest's top plate to the head's
  // underside. Deliberately overlaps both by a couple of centimetres so
  // there is never a visible seam regardless of exact head/torso geometry.
  const neckTopY = headBottomY + 0.02;
  const neckBottomY = upperChestTopY - 0.03;
  bodyParts.push(place(
    paint(new THREE.CylinderGeometry(0.05, 0.065, neckTopY - neckBottomY, 8), FRAME_DARK[1]),
    0, (neckBottomY + neckTopY) / 2, 0,
  ));

  // Pauldrons: rounded dark caps outboard of the chest, at the shoulder
  // line, bridging visually into the arm capsules beside them. Low-poly
  // icosahedra (detail 0) so they stay faceted/mechanical rather than
  // reading as smooth balls.
  const armX = Math.abs(armL.a.x);
  for (const side of [-1, 1]) {
    bodyParts.push(place(
      paint(new THREE.IcosahedronGeometry(armL.radius * 1.0, 0), FRAME_DARK[2]),
      side * (armX - 0.04), upperChestTopY - 0.02, 0.01,
    ));
  }

  // Arms: thick and clearly segmented (upper arm / elbow / forearm / hand),
  // hanging straight down beside the torso. Assigned to the body zone per
  // the hitbox — there is no separate "arm" hit zone. Sized/placed directly
  // from the arm capsule (`armL`) so a future hitbox change is picked up
  // automatically; mirrored across x for the right arm.
  const armTopY = Math.max(armL.a.y, armL.b.y); // 1.50 — shoulder end of the arm capsule segment
  const armBotY = Math.min(armL.a.y, armL.b.y); // 1.13 — wrist end of the arm capsule segment
  const armR2 = armL.radius; // ~0.06; drawn parts stay at or under this so the limb never exceeds its capsule
  for (const side of [-1, 1]) {
    const x = side * armX;
    const upperLen = (armTopY - armBotY) * 0.40;
    const foreLen = (armTopY - armBotY) * 0.35;
    const upperY = armTopY - upperLen / 2;
    const elbowY = armTopY - upperLen;
    const foreY = elbowY - foreLen / 2;
    const handY = armBotY - 0.045;

    bodyParts.push(place(paint(new THREE.CylinderGeometry(armR2 * 0.83, armR2 * 0.73, upperLen, 6), FRAME_DARK[2]), x, upperY, 0));
    // Joint sphere is deliberately fatter than the segments either side of it
    // so it bulges outward and reads as a hinge, not just a taper — but still
    // at or under armR2 so it never exceeds the arm capsule's own radius.
    bodyParts.push(place(paint(new THREE.IcosahedronGeometry(armR2 * 0.95, 0), JOINT_DARK), x, elbowY, 0));
    bodyParts.push(place(paint(new THREE.CylinderGeometry(armR2 * 0.68, armR2 * 0.60, foreLen, 6), FRAME_DARK[3]), x, foreY, 0));
    bodyParts.push(place(paint(new THREE.BoxGeometry(armR2 * 1.5, 0.09, armR2 * 1.5), FRAME_DARK[3]), x, handY, 0));
  }

  // ======================================================================
  // LEG ZONE — thigh, knee, shin, foot, x2
  // ======================================================================
  const legParts: THREE.BufferGeometry[] = [];
  const legSpan = trueSpan(legCap); // true y-extent, e.g. 0.045..0.965
  const legX = Math.abs(legCap.a.x);
  const lY = (frac: number) => legSpan.lo + frac * legSpan.height;

  // Contiguous bottom-to-top stack spanning the leg capsule's full true
  // range — foot floor flush with legSpan.lo, thigh crown flush with
  // legSpan.hi, a 100% vertical fill.
  const footTopY = lY(0.20);
  const shinTopY = lY(0.58);

  for (const side of [-1, 1]) {
    const x = side * legX;
    // Foot: blocky box pushed forward (+Z) so it "extends forward" per the
    // reference; floor flush with the leg capsule's true bottom.
    legParts.push(place(
      paint(new THREE.BoxGeometry(legCap.radius * 1.15, footTopY - legSpan.lo, legCap.radius * 2.1), FRAME_DARK[3]),
      x, (legSpan.lo + footTopY) / 2, legCap.radius * 0.55,
    ));
    // Shin: tapers slightly from knee to ankle.
    legParts.push(place(
      paint(new THREE.CylinderGeometry(legCap.radius * 0.68, legCap.radius * 0.55, shinTopY - footTopY, 6), FRAME_DARK[2]),
      x, (footTopY + shinTopY) / 2, 0,
    ));
    // Knee joint: bulges past both the shin's top and the thigh's bottom
    // radius so it reads as a hinge, capped just under the leg capsule's own
    // radius so it never exceeds it.
    legParts.push(place(paint(new THREE.IcosahedronGeometry(legCap.radius * 0.95, 0), JOINT_DARK), x, shinTopY, 0));
    // Thigh: full and thick, crown flush with the leg capsule's true top.
    legParts.push(place(
      paint(new THREE.CylinderGeometry(legCap.radius * 0.93, legCap.radius * 0.72, legSpan.hi - shinTopY, 6), FRAME_DARK[2]),
      x, (shinTopY + legSpan.hi) / 2, 0,
    ));
  }

  const head = mergeGeometries(headParts, false);
  const body = mergeGeometries(bodyParts, false);
  const leg = mergeGeometries(legParts, false);
  if (!head || !body || !leg) {
    // Only possible if the parts above ever end up with mismatched vertex
    // attributes (e.g. one part missing 'uv'); every primitive used here
    // provides position/normal/uv/color, so this should be unreachable —
    // fail loudly rather than silently rendering a blank zone.
    throw new Error('buildHumanoidGeometries: mergeGeometries failed — mismatched vertex attributes');
  }

  // The merge copies vertex data into the new geometries; the small
  // per-part ones are never used again, so free them immediately.
  for (const g of [...headParts, ...bodyParts, ...legParts]) g.dispose();

  return { head, body, leg };
}
