/**
 * Reusable procedural construction primitives shared by every map builder in
 * `maps.ts`. Nothing in here knows what a "range" or a "site" is — it only
 * knows how to place boxes cheaply, wire up colliders correctly, and light
 * a Valorant-flat scene. Keeping this separate from `maps.ts` is what lets
 * four visually distinct maps stay under the draw-call budget without each
 * one re-deriving its own merge/instance bookkeeping.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** A single axis-aligned box: half-extents via `size`, world-space `center`. */
export interface Placement {
  size: THREE.Vector3;
  center: THREE.Vector3;
}

export function place(sx: number, sy: number, sz: number, cx: number, cy: number, cz: number): Placement {
  return { size: new THREE.Vector3(sx, sy, sz), center: new THREE.Vector3(cx, cy, cz) };
}

/** Flat, low-roughness, non-metal — the whole visual-quality brief in one material. */
export function flatMaterial(color: number, roughness = 0.82): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0, flatShading: true });
}

/**
 * Every collider in this file is derived straight from a `Placement`'s
 * numbers, never from `Object3D.updateWorldMatrix` + `Box3.setFromObject`.
 * That decouples collision entirely from *how* a box is drawn (single mesh,
 * merged batch, or GPU instance all produce the exact same AABB), which is
 * what lets us merge/instance aggressively for draw calls while every piece
 * of real architecture still blocks movement and line-of-sight correctly.
 */
export function aabb(p: Placement): THREE.Box3 {
  const half = p.size.clone().multiplyScalar(0.5);
  return new THREE.Box3(p.center.clone().sub(half), p.center.clone().add(half));
}

export function pushColliders(colliders: THREE.Box3[], placements: readonly Placement[]): void {
  for (const p of placements) colliders.push(aabb(p));
}

/** One solid, reachable piece of architecture: a mesh AND its collider. */
export function solidBox(root: THREE.Group, colliders: THREE.Box3[], p: Placement, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(p.size.x, p.size.y, p.size.z), material);
  mesh.position.copy(p.center);
  root.add(mesh);
  colliders.push(aabb(p));
  return mesh;
}

/**
 * Purely visual box: trim strips, wall-panel insets, ceiling beams, floor
 * decals/inlays. Deliberately NO collider — the map contract requires this,
 * because a collider on a decorative sliver the player can never actually
 * touch would silently eat line-of-sight checks and make targets behind it
 * unspawnable/unshootable for no gameplay reason. The structural geometry
 * (wall, floor, crate) these are mounted on already has its own collider.
 */
export function decoBox(root: THREE.Group, p: Placement, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(p.size.x, p.size.y, p.size.z), material);
  mesh.position.copy(p.center);
  root.add(mesh);
  return mesh;
}

/**
 * Bakes many static box placements sharing one material into a single
 * merged geometry / single draw call. For decorative clutter (trim runs,
 * panel insets, floor bands, ceiling beams) where per-object identity never
 * matters and there can be dozens of them per map.
 */
export function mergedBoxes(root: THREE.Group, material: THREE.Material, placements: readonly Placement[]): THREE.Mesh | null {
  if (placements.length === 0) return null;
  const geoms = placements.map((p) => {
    const g = new THREE.BoxGeometry(p.size.x, p.size.y, p.size.z);
    g.translate(p.center.x, p.center.y, p.center.z);
    return g;
  });
  const merged = mergeGeometries(geoms, false);
  geoms.forEach((g) => g.dispose());
  const mesh = new THREE.Mesh(merged, material);
  root.add(mesh);
  return mesh;
}

/** Same merge as {@link mergedBoxes}, but for clutter that must still block
 * movement/LOS (crates, low walls) — registers one collider per placement. */
export function mergedSolidBoxes(root: THREE.Group, colliders: THREE.Box3[], material: THREE.Material, placements: readonly Placement[]): THREE.Mesh | null {
  const mesh = mergedBoxes(root, material, placements);
  pushColliders(colliders, placements);
  return mesh;
}

/** GPU-instanced identical-topology boxes (pillars, repeated crates): one
 * draw call regardless of instance count, real per-instance colliders. */
export function instancedSolidBoxes(root: THREE.Group, colliders: THREE.Box3[], material: THREE.Material, placements: readonly Placement[]): THREE.InstancedMesh | null {
  if (placements.length === 0) return null;
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, placements.length);
  const m = new THREE.Matrix4();
  placements.forEach((p, i) => {
    m.makeScale(p.size.x, p.size.y, p.size.z);
    m.setPosition(p.center.x, p.center.y, p.center.z);
    mesh.setMatrixAt(i, m);
  });
  mesh.instanceMatrix.needsUpdate = true;
  root.add(mesh);
  pushColliders(colliders, placements);
  return mesh;
}

/** A doorway/entry opening: a gap `width` metres wide centred on `center`. */
export interface Gap { center: number; width: number; }

/**
 * A straight wall running along X at fixed `z` between `x0` and `x1`, with
 * an optional doorway gap. Splits into two placements when the gap sits
 * strictly inside the span (the common case — a corridor mouth partway down
 * a room's wall); returns one unbroken wall when there's no gap. Used by
 * `angles` and `site` to author connected floor plans by rectangle + gap
 * instead of hand-placing every wall segment's coordinates.
 */
export function wallRunX(x0: number, x1: number, z: number, thickness: number, height: number, gap?: Gap): Placement[] {
  const y = height / 2;
  if (!gap) return [place(x1 - x0, height, thickness, (x0 + x1) / 2, y, z)];
  const gStart = gap.center - gap.width / 2;
  const gEnd = gap.center + gap.width / 2;
  const segs: Placement[] = [];
  if (gStart > x0) segs.push(place(gStart - x0, height, thickness, (x0 + gStart) / 2, y, z));
  if (x1 > gEnd) segs.push(place(x1 - gEnd, height, thickness, (gEnd + x1) / 2, y, z));
  return segs;
}

/** Same as {@link wallRunX} but running along Z at fixed `x`. */
export function wallRunZ(z0: number, z1: number, x: number, thickness: number, height: number, gap?: Gap): Placement[] {
  const y = height / 2;
  if (!gap) return [place(thickness, height, z1 - z0, x, y, (z0 + z1) / 2)];
  const gStart = gap.center - gap.width / 2;
  const gEnd = gap.center + gap.width / 2;
  const segs: Placement[] = [];
  if (gStart > z0) segs.push(place(thickness, height, gStart - z0, x, y, (z0 + gStart) / 2));
  if (z1 > gEnd) segs.push(place(thickness, height, z1 - gEnd, x, y, (gEnd + z1) / 2));
  return segs;
}

/**
 * Derives a thin decorative baseboard strip for each wall placement — same
 * horizontal footprint, floor-height, protruding slightly past the wall
 * face. A cheap way to add a full trim run once the walls themselves are
 * authored, for any map. Purely visual (callers add it via `decoBox`/
 * `mergedBoxes`, never `solidBox`) — the wall behind each strip already owns
 * the real collider.
 */
export function baseboardFor(walls: readonly Placement[], protrude = 0.05, trimHeight = 0.18): Placement[] {
  return walls.map((w) => {
    const alongX = w.size.x >= w.size.z;
    return place(
      alongX ? w.size.x : w.size.x + protrude * 2,
      trimHeight,
      alongX ? w.size.z + protrude * 2 : w.size.z,
      w.center.x, trimHeight / 2, w.center.z,
    );
  });
}

export function addFloor(root: THREE.Group, w: number, d: number, cx: number, cz: number, material: THREE.Material): THREE.Mesh {
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), material);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(cx, 0, cz);
  root.add(floor);
  return floor;
}

export function addCeiling(root: THREE.Group, w: number, d: number, cx: number, y: number, cz: number, material: THREE.Material): THREE.Mesh {
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(w, d), material);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(cx, y, cz);
  root.add(ceil);
  return ceil;
}

/**
 * Bright, flat, shadow-free lighting: a hemisphere for even ambient fill
 * plus a directional key for form, tuned so nothing is muddy and target
 * silhouettes always read. Shadows are never enabled anywhere (the renderer
 * never sets `shadowMap.enabled`) — they cost frames and add nothing to
 * reading a silhouette correctly in an aim trainer.
 */
export function addLighting(root: THREE.Group): void {
  // A flat uniform ambient base first — with no shadow map and only two
  // directional lights, any face pointed away from both (a ceiling's
  // underside, the lee side of a wall/crate) would otherwise fall back to
  // just the hemisphere's ground term and read as near-black, which reads
  // as "gritty/muddy" rather than the bright, legible Valorant look this
  // needs. The ambient term puts a floor under every face's brightness.
  const ambient = new THREE.AmbientLight(0xfff6e4, 0.55);
  const hemi = new THREE.HemisphereLight(0xf5efdd, 0x9c8a68, 0.9);
  const key = new THREE.DirectionalLight(0xfff6e6, 2.1);
  key.position.set(10, 16, 8);
  const fill = new THREE.DirectionalLight(0xeaf0ff, 0.5);
  fill.position.set(-8, 10, -6);
  root.add(ambient, hemi, key, fill);
}

/**
 * Renders a short label onto a canvas sprite with a dark rounded backdrop so
 * it stays legible against any floor/wall tone — procedural text, no image
 * assets or network fetch.
 */
export function makeLabel(text: string, scaleX = 1.4, scaleY = 0.7): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = 'rgba(35, 28, 20, 0.88)';
    ctx.beginPath();
    ctx.roundRect(6, 6, canvas.width - 12, canvas.height - 12, 20);
    ctx.fill();
    ctx.font = 'bold 66px system-ui, sans-serif';
    ctx.fillStyle = '#f7f1e3';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(scaleX, scaleY, 1);
  return sprite;
}

export const ROOT_NAME = '__map_root__';

/** Structural (not `instanceof`-based) so it disposes meshes, sprites, and
 * instanced meshes alike without an `any` cast. */
export function disposeSubtree(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const withGeom = obj as unknown as { geometry?: THREE.BufferGeometry };
    withGeom.geometry?.dispose();

    const withMat = obj as unknown as { material?: THREE.Material | THREE.Material[] };
    if (!withMat.material) return;
    const mats = Array.isArray(withMat.material) ? withMat.material : [withMat.material];
    for (const mat of mats) {
      const sprMat = mat as THREE.SpriteMaterial;
      sprMat.map?.dispose();
      mat.dispose();
    }
  });
}
