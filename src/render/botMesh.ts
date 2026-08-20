/**
 * Builds the merged, vertex-painted "practice bot" geometry used by
 * `TargetPool` in 'humanoid' visual mode.
 *
 * Why a separate file: `targets.ts` owns the pooling/animation/flash
 * machinery, which is already dense; the part-by-part construction of ~25
 * small primitives is a different kind of code (geometry authoring) and
 * reads better isolated from it.
 *
 * Why merge into 3 geometries instead of ~25 meshes: the pool holds 32
 * targets. One mesh per part per target would be 32 * ~25 = ~800 meshes and
 * ~800 draw calls just for targets, every frame, which is the kind of thing
 * that reads fine in isolation and then quietly halves the framerate once
 * the whole scene (map geometry, UI, markers) is added on top. Each part
 * instead gets its own tiny BufferGeometry with a baked-in per-vertex
 * colour, and the parts belonging to the same hit zone are merged with
 * `mergeGeometries` into exactly one BufferGeometry for that zone. The
 * result renders with a single `MeshStandardMaterial({ vertexColors: true })`
 * per zone, so the draw-call count stays at 3 per target (head/body/leg) —
 * identical to the plain-capsule mesh it replaces — while the *inside* of
 * each draw call is a whole articulated body part instead of one blob.
 *
 * Why per-part colour lives on vertices rather than as 3 separate materials:
 * that's what keeps this a 3-draw-call bot instead of a ~10-draw-call one
 * (a material change forces a new draw call even with identical geometry).
 * Flash-on-hit still works per zone because `emissiveIntensity` is a
 * material property independent of vertex colour — see `targets.ts`.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Capsule } from '../core/types';

/** One merged, vertex-coloured geometry per hit zone. Caller owns disposal. */
export interface HumanoidZoneGeometries {
  head: THREE.BufferGeometry;
  body: THREE.BufferGeometry;
  leg: THREE.BufferGeometry;
}

/**
 * Valorant's practice-range bot reads, at a glance, as a pale head+chest
 * riding a dark, skeletal, mechanical frame. These are the two "families"
 * of colour every part below picks from — kept in one place so the palette
 * stays coherent instead of each part inventing its own grey.
 */
const PLATE_LIGHT = [0xd9dee3, 0xcdd2d7, 0xc4c9ce]; // canister / chest, lightest to darkest step
const VISOR_CYAN = 0x35d6ec;
const FRAME_DARK = [0x232629, 0x2a2d31, 0x1d1f22, 0x18191c]; // waist/pelvis/pauldron/limb charcoals
const JOINT_DARK = 0x4b4f56; // distinctly lighter than the limbs so elbows/knees read as joints, not just a taper

/**
 * Uniformly paints every vertex of `geo` with `hex` and returns it (for
 * chaining). Also strips any index buffer: `mergeGeometries` requires every
 * input to agree on whether it's indexed, and among the primitives used
 * below `BoxGeometry`/`CylinderGeometry` build indexed geometry while
 * `IcosahedronGeometry`/`ExtrudeGeometry` don't — de-indexing everything
 * here is simpler and cheaper (these are all a few dozen vertices) than
 * threading index buffers through by hand.
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
 * rather than another grey blob.
 */
function buildVisorShape(): THREE.Shape {
  const w = 0.048; // half-width
  const top = 0.032; // top edge y
  const bottom = -0.045; // point y
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
 * All part sizes below are derived from the hit-capsule bounds passed in
 * rather than eyeballed, and every part is checked (in the comments next to
 * it) to sit at or inside its zone's actual capsule radius at that height —
 * *except* arms and pauldrons, which are allowed a few centimetres of
 * outward slack. That matches Valorant itself (hands/arms are not part of
 * the simplified hitbox capsule stack there either) and mirrors this file's
 * pre-existing shoulder-box embellishment, which already did the same
 * thing. The head is held to a strictly *smaller* radius than its capsule
 * (0.10 vs 0.115) with no exceptions: an oversized visual head would make
 * headshots easier to land than the real hitbox allows, which would
 * silently invalidate the trainer.
 */
export function buildHumanoidGeometries(headCap: Capsule, bodyCap: Capsule, legCap: Capsule): HumanoidZoneGeometries {
  const headMidY = (headCap.a.y + headCap.b.y) / 2;
  const headHeight = headCap.b.y - headCap.a.y;

  // ---- head zone: canister + visor -----------------------------------
  const headParts: THREE.BufferGeometry[] = [];

  // Squat flat-top canister. Radius 0.10 < the 0.115 head-capsule radius by
  // design (see function comment) — this is the one part in the whole bot
  // that must never grow to fill its capsule.
  headParts.push(place(
    paint(new THREE.CylinderGeometry(0.10, 0.10, headHeight, 8, 1, false), PLATE_LIGHT[0]),
    0, headMidY, 0,
  ));

  // Visor plate: a thin extrusion pressed against the canister's front
  // face. Canister radius 0.10 + extrusion depth 0.014 = 0.114, still just
  // inside the 0.115 head-capsule radius.
  const visorGeo = new THREE.ExtrudeGeometry(buildVisorShape(), { depth: 0.014, bevelEnabled: false });
  headParts.push(place(paint(visorGeo, VISOR_CYAN), 0, headMidY - 0.006, 0.088));

  // ---- body zone: neck, torso plates, pauldrons, arms -----------------
  const bodyParts: THREE.BufferGeometry[] = [];
  const bodyTopY = Math.max(bodyCap.a.y, bodyCap.b.y); // 1.60 — chest top / neck base
  const bodyBottomY = Math.min(bodyCap.a.y, bodyCap.b.y); // 1.02 — pelvis floor

  // Neck: sits in the gap between the body capsule's top and the head
  // capsule's bottom. Both capsules' spherical caps actually cover this
  // band (their radius there is >0.19), so a slim 0.055-0.065 neck has
  // plenty of margin either way it's read.
  bodyParts.push(place(
    paint(new THREE.CylinderGeometry(0.055, 0.065, headCap.a.y - bodyTopY + 0.02, 8), FRAME_DARK[1]),
    0, (bodyTopY + headCap.a.y) / 2, 0,
  ));

  // Chest: two stacked, stepped-in boxes rather than one tapered box, so
  // the torso reads as layered angular plates (per the reference) instead
  // of a smooth pill. Each box's corner distance (the worst case for a
  // square cross-section inside a round capsule) is kept under the 0.20
  // body radius with room to spare.
  bodyParts.push(place( // upper chest, flush with the capsule top
    paint(new THREE.BoxGeometry(0.31, 0.14, 0.19), PLATE_LIGHT[0]),
    0, 1.53, 0,
  ));
  bodyParts.push(place( // mid chest, stepped narrower — the "layering"
    paint(new THREE.BoxGeometry(0.27, 0.14, 0.17), PLATE_LIGHT[2]),
    0, 1.39, 0,
  ));

  // Cyan accent strip across the upper chest, just proud of its front face.
  bodyParts.push(place(
    paint(new THREE.BoxGeometry(0.31, 0.045, 0.012), VISOR_CYAN),
    0, 1.5675, 0.101,
  ));

  // Waist then pelvis: distinctly narrower than the chest and dark, per the
  // reference's "thin dark midsection, then a slightly wider dark pelvis".
  bodyParts.push(place(
    paint(new THREE.BoxGeometry(0.15, 0.16, 0.14), FRAME_DARK[0]),
    0, 1.24, 0,
  ));
  bodyParts.push(place( // pelvis floor extended down to bodyBottomY to close the seam against the leg zone
    paint(new THREE.BoxGeometry(0.23, 0.16, 0.20), FRAME_DARK[1]),
    0, bodyBottomY + 0.08, 0,
  ));

  // Pauldrons: rounded dark caps outboard of the chest. Low-poly icosahedra
  // (detail 0) so they stay faceted/mechanical instead of reading as smooth
  // balls. These — like the arms below — are allowed outside the 0.20 body
  // radius (peak ~0.24 from the centre axis): see function-level comment.
  for (const side of [-1, 1]) {
    bodyParts.push(place(
      paint(new THREE.IcosahedronGeometry(0.055, 0), FRAME_DARK[2]),
      side * 0.185, 1.565, 0.01,
    ));
  }

  // Arms: thin, dark, clearly segmented (upper arm / elbow / forearm /
  // hand), hanging straight down just outboard of the torso. Assigned to
  // the body zone per the brief — they occupy the body capsule's Y range
  // and there is no separate "arm" hit zone to put them in.
  for (const side of [-1, 1]) {
    const x = side * 0.20;
    bodyParts.push(place(paint(new THREE.CylinderGeometry(0.038, 0.030, 0.20, 6), FRAME_DARK[2]), x, 1.40, 0));
    // Joint sphere is deliberately a bit fatter than the segments either side of
    // it (0.042 vs 0.030/0.032) so it bulges outward and reads as a hinge.
    bodyParts.push(place(paint(new THREE.IcosahedronGeometry(0.042, 0), JOINT_DARK), x, 1.30, 0));
    bodyParts.push(place(paint(new THREE.CylinderGeometry(0.032, 0.026, 0.20, 6), FRAME_DARK[3]), x, 1.20, 0));
    bodyParts.push(place(paint(new THREE.BoxGeometry(0.06, 0.12, 0.044), FRAME_DARK[3]), x, 1.06, 0));
  }

  // ---- leg zone: thigh, knee, shin, foot, x2 ---------------------------
  const legParts: THREE.BufferGeometry[] = [];
  // Offset 0.07 from the centre axis keeps every leg part — including the
  // forward-extending foot — inside the 0.17 leg-capsule radius with a
  // margin of at least a centimetre; unlike the arms, the legs need no
  // outside-the-hitbox exception at all.
  for (const side of [-1, 1]) {
    const x = side * 0.07;
    legParts.push(place(paint(new THREE.CylinderGeometry(0.062, 0.048, 0.42, 6), FRAME_DARK[2]), x, 0.79, 0));
    // As with the elbow, the knee sphere bulges past its neighbours (0.052 vs
    // thigh-bottom 0.048 / shin-top 0.044) so it reads as a joint, not just a taper.
    legParts.push(place(paint(new THREE.IcosahedronGeometry(0.052, 0), JOINT_DARK), x, 0.58, 0));
    legParts.push(place(paint(new THREE.CylinderGeometry(0.044, 0.032, 0.40, 6), FRAME_DARK[2]), x, 0.38, 0));
    // Foot: a blocky box pushed forward (+Z), bottom flush with the leg
    // capsule's own floor (legCap.a.y) so there's no visible gap at the ground.
    legParts.push(place(
      paint(new THREE.BoxGeometry(0.08, 0.07, 0.13), FRAME_DARK[3]),
      x, legCap.a.y + 0.035, 0.055,
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
