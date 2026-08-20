/**
 * Procedural training environments. Everything here is boxes/planes built at
 * scenario-load time (not per frame) — no textures, no external assets.
 * Scale contract: 1 three.js unit = 1 metre, matching `core`'s hitbox and
 * movement units, so a 1.86 m target (STANDING_HEIGHT_M) reads correctly
 * against a 3 m wall, a 1 m crate, etc.
 */
import * as THREE from 'three';

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
    description: 'Open practice range with a back wall and calibrated distance markings at 5/10/15/20/30m.',
    sizeM: { width: 24, depth: 40, height: 6 },
  },
  boxes: {
    id: 'boxes',
    name: 'Boxes',
    description: 'Scattered crates at varying heights for cover and elevation practice.',
    sizeM: { width: 30, depth: 30, height: 6 },
  },
  angles: {
    id: 'angles',
    name: 'Angles',
    description: 'An L-shaped corridor with one hard 90-degree corner for crosshair placement and peek training.',
    sizeM: { width: 22, depth: 22, height: 3.2 },
  },
  site: {
    id: 'site',
    name: 'Site',
    description: 'A small bomb-site-like arena with a plant area, cover boxes, and two entry angles.',
    sizeM: { width: 20, depth: 20, height: 3.5 },
  },
};

// ---------------------------------------------------------------- palette --

/** Flat, high-contrast, low-noise materials — targets must always read clearly against them. */
const COLOR = {
  floor: 0x2a2d33,
  grid: 0x454a52,
  wallLow: 0x3a3f47,
  wallHigh: 0x4a505a,
  crate: 0x5a4a3a,
  crateAccent: 0x6b5a46,
  marker: 0xd8dbe0,
  markerLabel: 0xffffff,
  plant: 0x35506b,
};

const ROOT_NAME = '__map_root__';

function flatMaterial(color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.95, metalness: 0 });
}

function box(
  root: THREE.Group,
  colliders: THREE.Box3[],
  size: THREE.Vector3,
  center: THREE.Vector3,
  material: THREE.MeshStandardMaterial,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), material);
  mesh.position.copy(center);
  root.add(mesh);
  mesh.updateWorldMatrix(true, false);
  colliders.push(new THREE.Box3().setFromObject(mesh));
  return mesh;
}

/** Renders a short string onto a canvas sprite. Procedural — no image assets, no network fetch. */
function makeLabel(text: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = 'rgba(0,0,0,0)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = 'bold 40px monospace';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.1, 0.55, 1);
  return sprite;
}

function addFloor(root: THREE.Group, width: number, depth: number): void {
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), flatMaterial(COLOR.floor));
  floor.rotation.x = -Math.PI / 2;
  root.add(floor);
  // Subtle 1m grid so scale reads at a glance without competing with targets.
  const grid = new THREE.GridHelper(Math.max(width, depth), Math.max(width, depth), COLOR.grid, COLOR.grid);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.18;
  root.add(grid);
}

function addLighting(root: THREE.Group): void {
  // Shadows deliberately stay off (renderer.shadowMap is never enabled) —
  // they cost frames and add nothing to reading a silhouette correctly.
  // Intensities are tuned for three's physically-based lighting (r155+).
  const hemi = new THREE.HemisphereLight(0xdfe6ee, 0x14161a, 1.1);
  const sun = new THREE.DirectionalLight(0xffffff, 3.0);
  sun.position.set(6, 10, 4);
  sun.castShadow = false;
  root.add(hemi, sun);
}

// ------------------------------------------------------------------ range --

function buildRange(root: THREE.Group, colliders: THREE.Box3[]): BuiltMap {
  const { width, depth, height } = MAPS.range.sizeM;
  addFloor(root, width, depth);
  addLighting(root);

  const wallMat = flatMaterial(COLOR.wallLow);
  // Back wall (targets are shot against it) and side walls for containment.
  box(root, colliders, new THREE.Vector3(width, height, 0.3), new THREE.Vector3(0, height / 2, -depth / 2), wallMat);
  box(root, colliders, new THREE.Vector3(0.3, height, depth), new THREE.Vector3(-width / 2, height / 2, 0), wallMat);
  box(root, colliders, new THREE.Vector3(0.3, height, depth), new THREE.Vector3(width / 2, height / 2, 0), wallMat);

  // Calibrated distance markings: a low strip across the range floor plus a
  // text sprite at 5/10/15/20/30 m so distance is visually readable, not
  // just a number in a config file.
  const markerMat = flatMaterial(COLOR.marker);
  const distances = [5, 10, 15, 20, 30];
  const spawnPoints: THREE.Vector3[] = [];
  for (const d of distances) {
    const z = -d;
    box(root, colliders, new THREE.Vector3(width - 2, 0.02, 0.08), new THREE.Vector3(0, 0.01, z), markerMat);
    const label = makeLabel(`${d}m`);
    label.position.set(-width / 2 + 1.1, 0.9, z);
    root.add(label);
    for (const x of [-8, -4, 0, 4, 8]) {
      spawnPoints.push(new THREE.Vector3(x, 0, z));
    }
  }

  return { colliders, spawnPoints, playerSpawn: new THREE.Vector3(0, 0, depth / 2 - 3) };
}

// ------------------------------------------------------------------ boxes --

function buildBoxes(root: THREE.Group, colliders: THREE.Box3[]): BuiltMap {
  const { width, depth, height } = MAPS.boxes.sizeM;
  addFloor(root, width, depth);
  addLighting(root);

  const wallMat = flatMaterial(COLOR.wallLow);
  box(root, colliders, new THREE.Vector3(width, height, 0.3), new THREE.Vector3(0, height / 2, -depth / 2), wallMat);
  box(root, colliders, new THREE.Vector3(width, height, 0.3), new THREE.Vector3(0, height / 2, depth / 2), wallMat);
  box(root, colliders, new THREE.Vector3(0.3, height, depth), new THREE.Vector3(-width / 2, height / 2, 0), wallMat);
  box(root, colliders, new THREE.Vector3(0.3, height, depth), new THREE.Vector3(width / 2, height / 2, 0), wallMat);

  // Crates at varying heights/footprints for cover + elevation practice.
  // Repeated geometry -> one InstancedMesh instead of N separate meshes.
  const crateLayout: Array<{ x: number; z: number; size: number }> = [
    { x: -9, z: -6, size: 1.0 }, { x: -6, z: -2, size: 1.5 }, { x: -9, z: 4, size: 1.0 },
    { x: -3, z: 8, size: 0.6 }, { x: 0, z: -8, size: 1.5 }, { x: 3, z: -3, size: 1.0 },
    { x: 6, z: 2, size: 0.6 }, { x: 9, z: -6, size: 1.5 }, { x: 9, z: 6, size: 1.0 },
    { x: -3, z: -10, size: 0.6 }, { x: 4, z: 9, size: 1.0 }, { x: -6, z: 10, size: 1.5 },
    { x: 0, z: 4, size: 1.0 }, { x: -12, z: 0, size: 0.6 },
  ];
  const crateGeom = new THREE.BoxGeometry(1, 1, 1);
  const crateMat = flatMaterial(COLOR.crate);
  const crates = new THREE.InstancedMesh(crateGeom, crateMat, crateLayout.length);
  const m = new THREE.Matrix4();
  const spawnPoints: THREE.Vector3[] = [];
  crateLayout.forEach((c, i) => {
    m.makeScale(c.size, c.size, c.size);
    m.setPosition(c.x, c.size / 2, c.z);
    crates.setMatrixAt(i, m);
    colliders.push(new THREE.Box3(
      new THREE.Vector3(c.x - c.size / 2, 0, c.z - c.size / 2),
      new THREE.Vector3(c.x + c.size / 2, c.size, c.z + c.size / 2),
    ));
    spawnPoints.push(new THREE.Vector3(c.x, c.size, c.z - 1.5));
  });
  crates.instanceMatrix.needsUpdate = true;
  root.add(crates);

  return { colliders, spawnPoints, playerSpawn: new THREE.Vector3(0, 0, depth / 2 - 3) };
}

// ----------------------------------------------------------------- angles --

function buildAngles(root: THREE.Group, colliders: THREE.Box3[]): BuiltMap {
  const { width, depth, height } = MAPS.angles.sizeM;
  addFloor(root, width, depth);
  addLighting(root);

  const wallMat = flatMaterial(COLOR.wallHigh);
  const corridorWidth = 4;
  const wallThickness = 0.3;
  const wallH = height;

  // An L: one corridor running along -z from the spawn, meeting a second
  // corridor running along +x, with one hard 90-degree corner to pre-aim.
  const legLength = 16;

  // Outer walls of the z-leg (player runs from spawn toward the corner).
  box(root, colliders, new THREE.Vector3(wallThickness, wallH, legLength), new THREE.Vector3(-corridorWidth / 2, wallH / 2, -legLength / 2 + 2), wallMat);
  box(root, colliders, new THREE.Vector3(wallThickness, wallH, legLength), new THREE.Vector3(corridorWidth / 2 + corridorWidth, wallH / 2, -legLength / 2 + 2), wallMat);

  // Outer walls of the x-leg (after the corner, corridor turns toward +x).
  box(root, colliders, new THREE.Vector3(legLength, wallH, wallThickness), new THREE.Vector3(corridorWidth / 2 + legLength / 2, wallH / 2, -legLength + 2 - corridorWidth / 2), wallMat);
  box(root, colliders, new THREE.Vector3(legLength, wallH, wallThickness), new THREE.Vector3(corridorWidth / 2 + legLength / 2, wallH / 2, -legLength + 2 + corridorWidth / 2), wallMat);

  // The hard corner wall itself — the thing a player pre-aims around.
  box(root, colliders, new THREE.Vector3(corridorWidth, wallH, wallThickness), new THREE.Vector3(corridorWidth, wallH / 2, -legLength + 2 + corridorWidth / 2), wallMat);

  // End cap so the x-leg doesn't run open-ended off the map.
  box(root, colliders, new THREE.Vector3(wallThickness, wallH, corridorWidth), new THREE.Vector3(corridorWidth + legLength, wallH / 2, -legLength + 2), wallMat);

  const spawnPoints = [
    new THREE.Vector3(0, 0, -legLength + 4),
    new THREE.Vector3(corridorWidth, 0, -legLength + 2 - corridorWidth * 1.5),
    new THREE.Vector3(corridorWidth + 6, 0, -legLength + 2),
    new THREE.Vector3(corridorWidth + 12, 0, -legLength + 2),
  ];

  return { colliders, spawnPoints, playerSpawn: new THREE.Vector3(0, 0, 2) };
}

// ------------------------------------------------------------------- site --

function buildSite(root: THREE.Group, colliders: THREE.Box3[]): BuiltMap {
  const { width, depth, height } = MAPS.site.sizeM;
  addFloor(root, width, depth);
  addLighting(root);

  const wallMat = flatMaterial(COLOR.wallHigh);
  const gap = 3.2; // entry-lane opening width

  // Back and side walls enclosing the site, with two gaps left open in the
  // front wall as the two entry angles.
  box(root, colliders, new THREE.Vector3(width, height, 0.3), new THREE.Vector3(0, height / 2, -depth / 2), wallMat);
  box(root, colliders, new THREE.Vector3(0.3, height, depth), new THREE.Vector3(-width / 2, height / 2, 0), wallMat);
  box(root, colliders, new THREE.Vector3(0.3, height, depth), new THREE.Vector3(width / 2, height / 2, 0), wallMat);
  // Front wall in three segments, leaving two entry gaps.
  const frontSegW = (width - 2 * gap) / 3;
  box(root, colliders, new THREE.Vector3(frontSegW, height, 0.3), new THREE.Vector3(-width / 2 + frontSegW / 2, height / 2, depth / 2), wallMat);
  box(root, colliders, new THREE.Vector3(frontSegW, height, 0.3), new THREE.Vector3(0, height / 2, depth / 2), wallMat);
  box(root, colliders, new THREE.Vector3(frontSegW, height, 0.3), new THREE.Vector3(width / 2 - frontSegW / 2, height / 2, depth / 2), wallMat);

  // Plant-area floor patch (visual only, not a collider) and cover boxes.
  const plant = new THREE.Mesh(new THREE.PlaneGeometry(5, 5), flatMaterial(COLOR.plant));
  plant.rotation.x = -Math.PI / 2;
  plant.position.set(0, 0.015, -depth / 2 + 4);
  root.add(plant);

  const crateMat = flatMaterial(COLOR.crateAccent);
  box(root, colliders, new THREE.Vector3(1.2, 1.2, 1.2), new THREE.Vector3(-3, 0.6, -depth / 2 + 5.5), crateMat);
  box(root, colliders, new THREE.Vector3(1.2, 1.2, 1.2), new THREE.Vector3(3, 0.6, -depth / 2 + 5.5), crateMat);
  box(root, colliders, new THREE.Vector3(2, 0.9, 1), new THREE.Vector3(0, 0.45, -1), crateMat);
  box(root, colliders, new THREE.Vector3(1, 1.6, 1), new THREE.Vector3(-6, 0.8, 2), crateMat);
  box(root, colliders, new THREE.Vector3(1, 1.6, 1), new THREE.Vector3(6, 0.8, 2), crateMat);

  const spawnPoints = [
    new THREE.Vector3(-2, 0, -depth / 2 + 4),
    new THREE.Vector3(2, 0, -depth / 2 + 4),
    new THREE.Vector3(0, 0, -2),
    new THREE.Vector3(-5, 0, 3),
    new THREE.Vector3(5, 0, 3),
  ];

  return { colliders, spawnPoints, playerSpawn: new THREE.Vector3(0, 0, depth / 2 - 2) };
}

// ------------------------------------------------------------------- API ---

/** Structural (not `instanceof`-based) so it disposes meshes, sprites, and lines alike without an `any` cast. */
function disposeSubtree(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const withGeom = obj as unknown as { geometry?: THREE.BufferGeometry };
    withGeom.geometry?.dispose();

    const withMat = obj as unknown as { material?: THREE.Material | THREE.Material[] };
    if (!withMat.material) return;
    const mats = Array.isArray(withMat.material) ? withMat.material : [withMat.material];
    for (const m of mats) {
      const sprMat = m as THREE.SpriteMaterial;
      sprMat.map?.dispose();
      m.dispose();
    }
  });
}

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
