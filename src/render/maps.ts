/**
 * Procedural training environments. Everything here is boxes/planes built at
 * scenario-load time (not per frame) — no textures, no external assets.
 * Scale contract: 1 three.js unit = 1 metre, matching `core`'s hitbox and
 * movement units, so a 1.86 m target (STANDING_HEIGHT_M) reads correctly
 * against a 3+ m wall, a 1 m crate, etc.
 *
 * Construction primitives (box+collider, merge, instancing, wall-with-gap,
 * lighting, labels) live in `mapKit.ts`. This file is purely level layout:
 * where things go and what color they are.
 */
import * as THREE from 'three';
import {
  type Placement, place, flatMaterial, aabb, pushColliders,
  solidBox, mergedBoxes, mergedSolidBoxes, instancedSolidBoxes,
  addFloor, addCeiling, addLighting, makeLabel,
  wallRunX, wallRunZ, baseboardFor,
  ROOT_NAME, disposeSubtree,
} from './mapKit';

export interface MapDef {
  id: string;
  name: string;
  description: string;
  /** Footprint/height for UI display and spawn-bounds sanity checks, metres. */
  sizeM: { width: number; depth: number; height: number };
}

export interface BuiltMap {
  colliders: THREE.Box3[];
  spawnPoints: THREE.Vector3[];
  playerSpawn: THREE.Vector3;
}

export const MAPS: Record<string, MapDef> = {
  range: {
    id: 'range',
    name: 'Range',
    description: 'Indoor practice range with a firing line and calibrated distance markings at 5/10/15/20/30m.',
    sizeM: { width: 20, depth: 39, height: 6 },
  },
  boxes: {
    id: 'boxes',
    name: 'Boxes',
    description: 'Open arena with a deliberately arranged set of crates from waist-high to full cover.',
    sizeM: { width: 34, depth: 34, height: 6 },
  },
  angles: {
    id: 'angles',
    name: 'Angles',
    description: 'A hub of connected corridors with a hard 90-degree corner, an off-angle alcove, and pillars.',
    sizeM: { width: 26, depth: 21, height: 3.2 },
  },
  site: {
    id: 'site',
    name: 'Site',
    description: 'A compressed bomb-site arena: two separate entries, a plant zone, cover boxes, and a back area.',
    sizeM: { width: 22, depth: 25, height: 3.6 },
  },
};

// ---------------------------------------------------------------- palette --

/**
 * Warm sand/off-white base with a dark trim and a per-map accent — the
 * Valorant "flat, bright, colour-blocked" look. Floor/wall/trim/accent are
 * genuinely different values (not shades of one grey) so architecture reads
 * at a glance and targets always sit against a clean, legible background.
 */
const PALETTE = {
  floor: 0xd9c8a4,
  floorBand: 0xb99b6f,
  /**
   * Low-contrast floor marking, only a shade off `floor`. Used for the two
   * stripes that run along the player's default view axis from spawn — a
   * high-contrast line there reads as a crosshair-alignment reference, which
   * is an aiming aid the real game does not give you. Everything the player
   * is meant to read at a glance uses the full-contrast colours instead.
   */
  floorBandFaint: 0xcdba95,
  wall: 0xece1c5,
  wallPanel: 0xd6c39a,
  trim: 0x76573a,
  ceiling: 0xf3ecd9,
  pillar: 0xcab88c,
  crate: 0xb98a5a,
  crateDark: 0x8a6238,
  accentRed: 0xbf4e37,
  accentBlue: 0x35688f,
  accentTeal: 0x3c7d6e,
  accentGold: 0xc79a3c,
  plant: 0x2f6b57,
};

const SKY = 0xece0c0;

// --------------------------------------------------------------- helpers --

/** Merges structural wall placements into one draw call and derives a
 * matching baseboard trim run in the same call. Every map uses this exact
 * pattern, so it's factored out once rather than repeated four times. */
function buildWalls(root: THREE.Group, colliders: THREE.Box3[], walls: Placement[]): void {
  mergedSolidBoxes(root, colliders, flatMaterial(PALETTE.wall), walls);
  mergedBoxes(root, flatMaterial(PALETTE.trim, 0.75), baseboardFor(walls));
}

// ------------------------------------------------------------------ range --

function buildRange(root: THREE.Group, colliders: THREE.Box3[]): BuiltMap {
  const W = 20; // hall width, x: -10..10
  const FIRE_Z = 2; // firing line the player stands just behind
  const FRONT_WALL_Z = 6.5; // wall behind the player
  const BACK_WALL_Z = -32; // wall past the 30m line
  const H = 6;
  const WT = 0.3;

  const floorCz = (FRONT_WALL_Z + BACK_WALL_Z) / 2;
  const floorD = FRONT_WALL_Z - BACK_WALL_Z;
  addFloor(root, W, floorD, 0, floorCz, flatMaterial(PALETTE.floor));
  addCeiling(root, W, floorD, 0, H, floorCz, flatMaterial(PALETTE.ceiling));
  addLighting(root);

  const walls: Placement[] = [
    ...wallRunZ(BACK_WALL_Z, FRONT_WALL_Z, -W / 2, WT, H),
    ...wallRunZ(BACK_WALL_Z, FRONT_WALL_Z, W / 2, WT, H),
    ...wallRunX(-W / 2, W / 2, BACK_WALL_Z, WT, H),
    ...wallRunX(-W / 2, W / 2, FRONT_WALL_Z, WT, H),
  ];
  buildWalls(root, colliders, walls);

  // Pilasters along both side walls, evenly spaced from the firing line to
  // the back wall — real, reachable geometry (they poke 0.4m into the
  // room), so they get colliders like any other structural piece.
  const pillarZs: number[] = [];
  for (let z = FRONT_WALL_Z - 3; z >= BACK_WALL_Z + 3; z -= 7) pillarZs.push(z);
  const pillars: Placement[] = [];
  for (const z of pillarZs) {
    pillars.push(place(0.4, H, 0.6, -W / 2 + 0.35, H / 2, z));
    pillars.push(place(0.4, H, 0.6, W / 2 - 0.35, H / 2, z));
  }
  instancedSolidBoxes(root, colliders, flatMaterial(PALETTE.pillar), pillars);

  // Recessed-look wall panels between each pair of pilasters — decorative
  // only (a 6cm-proud sliver mounted flush on an already-collidered wall
  // adds nothing to line-of-sight, so it stays out of `colliders`).
  const panelMat = flatMaterial(PALETTE.wallPanel, 0.7);
  const panels: Placement[] = [];
  for (let i = 0; i + 1 < pillarZs.length; i++) {
    const midZ = (pillarZs[i]! + pillarZs[i + 1]!) / 2;
    panels.push(place(0.06, 3.2, 3.4, -W / 2 + 0.18, 1.9, midZ));
    panels.push(place(0.06, 3.2, 3.4, W / 2 - 0.18, 1.9, midZ));
  }
  mergedBoxes(root, panelMat, panels);

  // Ceiling cross-beams, aligned with the pilaster grid below them —
  // ceiling detail the player can never reach, so no collider either.
  const beams: Placement[] = pillarZs.map((z) => place(W, 0.3, 0.35, 0, H - 0.2, z));
  mergedBoxes(root, flatMaterial(PALETTE.trim, 0.75), beams);

  // Lane dividers running the length of the range.
  const laneXs = [-6, -2, 2, 6];
  const laneD = FIRE_Z - (BACK_WALL_Z + 2);
  const laneCz = (FIRE_Z + BACK_WALL_Z + 2) / 2;
  const lanes: Placement[] = laneXs.map((x) => place(0.05, 0.02, laneD, x, 0.011, laneCz));
  mergedBoxes(root, flatMaterial(PALETTE.floorBand, 0.9), lanes);

  // Calibrated distance markings: a floor stripe + a firing-line lip, both
  // sharing the accent colour/material for one extra draw call, plus a
  // wall-mounted number plaque on both sides at each distance so the value
  // reads regardless of which lane the player is standing in.
  const distances = [5, 10, 15, 20, 30];
  const accentMat = flatMaterial(PALETTE.accentRed, 0.7);
  const accentPlacements: Placement[] = [place(W - 1, 0.15, 0.3, 0, 0.075, FIRE_Z)]; // firing-line lip
  const spawnPoints: THREE.Vector3[] = [];
  for (const d of distances) {
    const z = FIRE_Z - d;
    accentPlacements.push(place(W - 2, 0.02, 0.15, 0, 0.02, z));
    const left = makeLabel(`${d}M`);
    left.position.set(-W / 2 + 0.7, 2.3, z);
    const right = makeLabel(`${d}M`);
    right.position.set(W / 2 - 0.7, 2.3, z);
    root.add(left, right);
    for (const x of [-8, -4, 0, 4, 8]) spawnPoints.push(new THREE.Vector3(x, 0, z));
  }
  mergedBoxes(root, accentMat, accentPlacements);

  return { colliders, spawnPoints, playerSpawn: new THREE.Vector3(0, 0, FIRE_Z + 1.5) };
}

// ------------------------------------------------------------------ boxes --

function buildBoxes(root: THREE.Group, colliders: THREE.Box3[]): BuiltMap {
  const W = 34; // x/z: -17..17
  const H = 6;
  const WT = 0.3;
  const half = W / 2;

  addFloor(root, W, W, 0, 0, flatMaterial(PALETTE.floor));
  addCeiling(root, W, W, 0, H, 0, flatMaterial(PALETTE.ceiling));
  addLighting(root);

  const walls: Placement[] = [
    ...wallRunX(-half, half, -half, WT, H),
    ...wallRunX(-half, half, half, WT, H),
    ...wallRunZ(-half, half, -half, WT, H),
    ...wallRunZ(-half, half, half, WT, H),
  ];
  buildWalls(root, colliders, walls);

  // Corner pillars framing the arena — real, reachable, so collidable.
  const cornerOffset = half - 0.9;
  const corners: Placement[] = [
    place(1.0, H, 1.0, -cornerOffset, H / 2, -cornerOffset),
    place(1.0, H, 1.0, cornerOffset, H / 2, -cornerOffset),
    place(1.0, H, 1.0, -cornerOffset, H / 2, cornerOffset),
    place(1.0, H, 1.0, cornerOffset, H / 2, cornerOffset),
  ];
  instancedSolidBoxes(root, colliders, flatMaterial(PALETTE.pillar), corners);

  // A large floor cross reads as deliberate arena design (lanes/quadrants)
  // rather than random clutter — decorative, players walk straight over it.
  //
  // Kept deliberately low-contrast: the z-arm of this cross runs straight
  // down the player's default view axis from spawn, and a bright line there
  // would act as a free crosshair-alignment reference. The trainer must not
  // hand the player an aiming aid the real game does not have.
  mergedBoxes(root, flatMaterial(PALETTE.floorBandFaint), [
    place(W - 2, 0.02, 0.4, 0, 0.011, 0),
    place(0.4, 0.02, W - 2, 0, 0.011, 0),
  ]);

  // Deliberately arranged cover: a stacked full-cover centrepiece, a chest-
  // high inner cross, four stacked corner bunkers stepping from waist to
  // full height, and small waist-high crates filling the mid lanes. Heights
  // span 1.0m (waist) to 2.0m (full cover, stacked) per the design brief.
  const corner = 10;
  const wood: Placement[] = [
    place(2.4, 1.0, 2.4, 0, 0.5, 0), // centrepiece base
    place(1.6, 1.4, 1.6, 5, 0.7, 0), place(1.6, 1.4, 1.6, -5, 0.7, 0),
    place(1.6, 1.4, 1.6, 0, 0.7, 5), place(1.6, 1.4, 1.6, 0, 0.7, -5),
  ];
  const bunkerCenters = [[corner, corner], [-corner, corner], [corner, -corner], [-corner, -corner]] as const;
  for (const [x, z] of bunkerCenters) wood.push(place(2.0, 1.0, 2.0, x, 0.5, z));
  const smallSpots = [[3, 8], [-3, 8], [3, -8], [-3, -8], [8, 3], [8, -3], [-8, 3], [-8, -3]] as const;
  for (const [x, z] of smallSpots) wood.push(place(1.0, 1.0, 1.0, x, 0.5, z));

  const woodDark: Placement[] = [place(1.2, 1.0, 1.2, 0, 1.5, 0)]; // centrepiece cap -> 2.0m total
  for (const [x, z] of bunkerCenters) {
    const sx = Math.sign(x) * -0.6;
    const sz = Math.sign(z) * -0.6;
    woodDark.push(place(1.1, 1.0, 1.1, x + sx, 1.5, z + sz)); // stacked cap, stepped inward -> 2.0m
  }

  mergedSolidBoxes(root, colliders, flatMaterial(PALETTE.crate), wood);
  mergedSolidBoxes(root, colliders, flatMaterial(PALETTE.crateDark), woodDark);

  // Banding trim near the top of the larger structures only — cheap detail
  // that keeps the small filler crates visually simple. Decorative: the
  // crate underneath already owns the collider.
  const banded = wood.slice(0, 9);
  const bands: Placement[] = banded.map((p) => place(
    p.size.x + 0.05, 0.14, p.size.z + 0.05,
    p.center.x, p.center.y + p.size.y / 2 - 0.1, p.center.z,
  ));
  mergedBoxes(root, flatMaterial(PALETTE.accentTeal, 0.7), bands);

  const spawnPoints = [
    [0, -3.5], [0, 3.5], [5, 3.5], [5, -3.5], [-5, 3.5], [-5, -3.5],
    [3.5, 5], [-3.5, 5], [3.5, -5], [-3.5, -5],
    [13, 13], [13, -13], [-13, 13], [-13, -13],
    [13, 0], [-13, 0], [0, 13], [0, -13],
  ].map(([x, z]) => new THREE.Vector3(x, 0, z));

  return { colliders, spawnPoints, playerSpawn: new THREE.Vector3(0, 0, 15) };
}

// ----------------------------------------------------------------- angles --

function buildAngles(root: THREE.Group, colliders: THREE.Box3[]): BuiltMap {
  const CW = 4; // corridor width
  const WT = 0.3;
  const H = 3.2;

  // A central hub with three branches (a straight corridor back to spawn,
  // a hard-90 dogleg, and a jog corridor with an off-angle alcove) so the
  // player can hold several genuinely distinct angles from one hub position.
  const walls: Placement[] = [
    ...wallRunX(-3.5, 3.5, -3.5, WT, H), // hub south, solid (dead end)
    ...wallRunX(-3.5, 3.5, 3.5, WT, H, { center: 0, width: CW }), // -> corridor A
    ...wallRunZ(-3.5, 3.5, 3.5, WT, H, { center: 0, width: CW }), // -> corridor B
    ...wallRunZ(-3.5, 3.5, -3.5, WT, H, { center: 0, width: CW }), // -> corridor C

    // Corridor A: straight run north to the player's spawn.
    ...wallRunZ(3.5, 17, -2, WT, H),
    ...wallRunZ(3.5, 17, 2, WT, H),
    ...wallRunX(-2, 2, 17, WT, H),

    // Corridor B: east, then a hard 90-degree corner turning north.
    ...wallRunX(3.5, 13, -2, WT, H),
    ...wallRunX(3.5, 13, 2, WT, H, { center: 11, width: CW }),
    ...wallRunZ(-2, 2, 13, WT, H),
    ...wallRunZ(2, 9, 13, WT, H),
    ...wallRunZ(2, 9, 9, WT, H),
    ...wallRunX(9, 13, 9, WT, H),

    // Corridor C: west, with an off-angle alcove branching off partway down.
    ...wallRunX(-13, -3.5, -2, WT, H),
    ...wallRunX(-13, -3.5, 2, WT, H, { center: -8, width: 2 }),
    ...wallRunZ(-2, 2, -13, WT, H),
    ...wallRunZ(2, 4.5, -9, WT, H),
    ...wallRunZ(2, 4.5, -7, WT, H),
    ...wallRunX(-9, -7, 4.5, WT, H),
  ];
  buildWalls(root, colliders, walls);

  addFloor(root, 28, 22, 0, 6.75, flatMaterial(PALETTE.floor));
  addCeiling(root, 28, 22, 0, H, 6.75, flatMaterial(PALETTE.ceiling));
  addLighting(root);

  // Two standalone pillars: one mid-hub (off-centre, so it breaks the hub's
  // sightlines into a real off-angle rather than a symmetric block) and one
  // at the alcove mouth for a second holdable corner.
  instancedSolidBoxes(root, colliders, flatMaterial(PALETTE.pillar), [
    place(1.0, H, 1.0, 1.0, H / 2, -1.2),
    place(0.5, H, 0.5, -7.6, H / 2, 1.6),
  ]);

  // Doorway lintels over each hub/alcove opening — mounted well above head
  // height (2.9m, ceiling is 3.2m) so they never intersect a standing
  // player's line of sight; purely decorative, no collider.
  const headers: Placement[] = [
    place(CW + 0.3, 0.4, 0.4, 0, 2.9, 3.5),
    place(0.4, 0.4, CW + 0.3, 3.5, 2.9, 0),
    place(0.4, 0.4, CW + 0.3, -3.5, 2.9, 0),
    place(2.3, 0.4, 0.4, -8, 2.9, 2),
  ];
  mergedBoxes(root, flatMaterial(PALETTE.accentBlue, 0.7), headers);

  // A painted floor stripe down each corridor's centreline for identity and
  // depth cueing — purely cosmetic, never collidable.
  const stripes: Placement[] = [
    place(0.3, 0.02, 13.5, 0, 0.011, 10.25),
    place(9.5, 0.02, 0.3, 8.25, 0.011, 0),
    place(9.5, 0.02, 0.3, -8.25, 0.011, 0),
  ];
  // Same reasoning as the arena floor cross: a corridor centreline sits
  // exactly where the player looks, so it stays a faint floor detail rather
  // than a bright alignment guide.
  mergedBoxes(root, flatMaterial(PALETTE.floorBandFaint), stripes);

  const spawnPoints = [
    [0, 4.5], [0, 8], [5, 0], [11, 5], [11, 7.5], [-6, 0], [-8, 3.2], [-11, 0], [-1, -1.5],
  ].map(([x, z]) => new THREE.Vector3(x, 0, z));

  return { colliders, spawnPoints, playerSpawn: new THREE.Vector3(0, 0, 15) };
}

// ------------------------------------------------------------------- site --

function buildSite(root: THREE.Group, colliders: THREE.Box3[]): BuiltMap {
  const WT = 0.3;
  const H = 3.6;

  // Perimeter with two clearly separate entry chokepoints cut into the
  // front wall (a wide mid-wall section stands between them, itself a
  // legitimate off-angle/default-hold piece), plus a narrow back exit.
  const walls: Placement[] = [
    place(3, H, WT, -9.5, H / 2, -11),
    place(8, H, WT, 0, H / 2, -11), // mid wall between the two entries
    place(3, H, WT, 9.5, H / 2, -11),
    ...wallRunZ(-11, 11, -11, WT, H),
    ...wallRunZ(-11, 11, 11, WT, H),
    ...wallRunX(-11, 11, 11, WT, H, { center: 0, width: 4 }), // -> back exit
    ...wallRunZ(11, 14, -2, WT, H),
    ...wallRunZ(11, 14, 2, WT, H),
    ...wallRunX(-2, 2, 14, WT, H),
  ];
  buildWalls(root, colliders, walls);

  addFloor(root, 23, 26, 0, 1.5, flatMaterial(PALETTE.floor));
  addCeiling(root, 23, 26, 0, H, 1.5, flatMaterial(PALETTE.ceiling));
  addLighting(root);

  // Entry/back-exit lintels, mounted above head height — decorative only.
  const headers: Placement[] = [
    place(4.3, 0.4, 0.4, -6, 3.2, -11),
    place(4.3, 0.4, 0.4, 6, 3.2, -11),
    place(4.3, 0.4, 0.4, 0, 3.2, 11),
  ];
  mergedBoxes(root, flatMaterial(PALETTE.accentRed, 0.7), headers);

  // Plant zone: a colour-blocked floor patch (not a raised platform — the
  // movement model has no step-up, so "raised" here is read entirely
  // through colour/inlay) with a small collidable planter prop at its
  // centre for cover flavour.
  const plantOuter = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), flatMaterial(PALETTE.plant, 0.9));
  plantOuter.rotation.x = -Math.PI / 2;
  plantOuter.position.set(0, 0.012, 1);
  const plantInner = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), flatMaterial(PALETTE.accentGold, 0.6));
  plantInner.rotation.x = -Math.PI / 2;
  plantInner.position.set(0, 0.014, 1);
  root.add(plantOuter, plantInner);
  solidBox(root, colliders, place(0.8, 0.6, 0.8, 0, 0.3, 1), flatMaterial(PALETTE.accentGold, 0.5));

  // Cover: chest-high boxes flanking the plant, a full-cover elbow before
  // the back area, waist-high back cubbies, and low off-angle walls framing
  // each entry mouth.
  const crates: Placement[] = [
    place(1.4, 1.4, 1.4, -3, 0.7, 2), place(1.4, 1.4, 1.4, 3, 0.7, 2),
    place(1.2, 1.0, 1.2, -7, 0.5, 8), place(1.2, 1.0, 1.2, 7, 0.5, 8),
    place(1.0, 1.0, 1.0, -6, 0.5, -8), place(1.0, 1.0, 1.0, 6, 0.5, -8),
  ];
  mergedSolidBoxes(root, colliders, flatMaterial(PALETTE.crate), crates);

  const walls2: Placement[] = [
    // Full-cover elbow before the back area — offset to one side rather
    // than centred, so it reads as a peekable corner instead of a wall
    // blocking the entire spawn-to-entries sightline.
    place(1.6, 2.0, 1.6, 4, 1.0, 5),
    place(3.0, 1.2, 0.4, -6, 0.6, -6), place(3.0, 1.2, 0.4, 6, 0.6, -6),
  ];
  mergedSolidBoxes(root, colliders, flatMaterial(PALETTE.crateDark), walls2);

  const spawnPoints = [
    [-6, -9.5], [6, -9.5], [-6, -4], [6, -4], [0, -2],
    [-3, 4.5], [3, 4.5], [0, 2.8],
    [-7, 10], [7, 10], [0, 7], [0, 12.5],
  ].map(([x, z]) => new THREE.Vector3(x, 0, z));

  return { colliders, spawnPoints, playerSpawn: new THREE.Vector3(0, 0, 9) };
}

// ------------------------------------------------------------------- API ---

/**
 * Builds `id` into `scene` and returns its colliders/spawns. Safe to call
 * repeatedly (e.g. switching maps between scenarios) — any previously built
 * map root is torn down and disposed first.
 */
export function buildMap(scene: THREE.Scene, id: string): BuiltMap {
  const def = MAPS[id];
  if (!def) throw new Error(`Unknown map id: '${id}'`);

  const existing = scene.getObjectByName(ROOT_NAME);
  if (existing) {
    scene.remove(existing);
    disposeSubtree(existing);
  }

  // A flat sky colour behind the geometry — every map fully encloses its
  // playable volume, so this is only ever a safety net (never actually
  // visible from inside a finished map), kept in the same warm family as
  // the ceiling so a stray gap doesn't read as a jarring void.
  scene.background = new THREE.Color(SKY);

  const root = new THREE.Group();
  root.name = ROOT_NAME;
  scene.add(root);
  const colliders: THREE.Box3[] = [];

  switch (id) {
    case 'range': return buildRange(root, colliders);
    case 'boxes': return buildBoxes(root, colliders);
    case 'angles': return buildAngles(root, colliders);
    case 'site': return buildSite(root, colliders);
    default: throw new Error(`Unknown map id: '${id}'`);
  }
}

// Re-exported so callers/tests that only need geometry math (not scene
// construction) can build/inspect colliders without touching three.js.
export { aabb, pushColliders };
