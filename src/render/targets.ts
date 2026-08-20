/**
 * Renders live `TargetState`s as pooled three.js objects.
 *
 * The visual mesh for every zone is built directly from `STANDING_HITBOX`'s
 * capsules, so the player is always shooting exactly the shape they see —
 * there is no separate "art" hitbox and "gameplay" hitbox to drift apart.
 */
import * as THREE from 'three';
import type { AgentHitbox, Capsule, HitZone, TargetState, Vec3 } from '../core/types';
import { CROUCH_SCALE, SIM_STEP_MS, STANDING_HITBOX } from '../core/constants';
import { add, distance, scale as scaleVec } from '../core/math';
import { buildHumanoidGeometries, type HumanoidZoneGeometries } from './botMesh';

export type VisualMode = 'humanoid' | 'capsule' | 'wireframe';

/** Fixed capacity: scenarios never run more simultaneous live targets than this. */
export const TARGET_POOL_SIZE = 32;
/** Fixed capacity for pooled world-space hit markers. */
const MARKER_POOL_SIZE = 24;

const FLASH_DURATION_MS = 160;
const FLASH_INTENSITY = 1.4;
const MARKER_DURATION_MS = 260;
const MARKER_START_SCALE = 1.5;
const MARKER_END_SCALE = 0.5;

const SIM_STEP_S = SIM_STEP_MS / 1000;

/**
 * Per-mode, per-zone base colour.
 *
 * `humanoid` values are light enough to read clearly against the dark maps,
 * but the three zones are deliberately close together: if the head were a
 * distinct colour the player would acquire it by hue instead of by reading the
 * silhouette, which is not the skill Valorant asks for. Zone contrast belongs
 * in `wireframe`, which exists precisely for that.
 */
const MODE_COLOR: Record<VisualMode, Record<HitZone, number>> = {
  humanoid: { head: 0x9aa4ae, body: 0x8b949e, leg: 0x6b737c },
  capsule: { head: 0x9aa0a8, body: 0x9aa0a8, leg: 0x9aa0a8 },
  // Classic debug palette: head/body/leg unmistakably distinct at a glance.
  wireframe: { head: 0xff4655, body: 0x53e6a8, leg: 0x4fa8ff },
};

const MARKER_COLOR: Record<HitZone, number> = { head: 0xff4655, body: 0xffffff, leg: 0xc9cfd6 };

function findCapsule(zone: HitZone, hitbox: AgentHitbox): Capsule {
  const cap = hitbox.capsules.find((c) => c.zone === zone);
  if (!cap) throw new Error(`STANDING_HITBOX is missing a '${zone}' capsule`);
  return cap;
}

function zoneMidY(cap: Capsule): number {
  return scaleVec(add(cap.a, cap.b), 0.5).y;
}

/**
 * Builds a CapsuleGeometry whose radius/length are derived from the hitbox
 * capsule, not eyeballed, and bakes its zone-mid-Y offset directly into the
 * geometry (rather than leaving that to the mesh's `.position`). That way
 * every zone mesh can sit at `position.y = 0` permanently and this geometry
 * is a drop-in swap for the humanoid geometry built in `botMesh.ts`, which
 * is authored in the same absolute (feet-at-0) space — see `applyMode`.
 *
 * Also carries a uniform WHITE per-vertex colour. `makeZoneMaterial` below
 * turns on `vertexColors` (required so the humanoid geometry's baked-in
 * per-part colours render at all), and a MeshStandardMaterial multiplies
 * vertex colour into its base colour. White is the multiplicative identity,
 * so with this geometry `material.color` alone still determines the final
 * colour, exactly as before vertex colours existed — 'capsule' and
 * 'wireframe' modes are visually unchanged.
 */
function buildZoneGeometry(cap: Capsule): THREE.CapsuleGeometry {
  const length = distance(cap.a, cap.b);
  // Low radial segment count reads as clean/faceted (flat-shaded) rather than smooth-rounded plastic.
  const geom = new THREE.CapsuleGeometry(cap.radius, length, 3, 8);
  geom.translate(0, zoneMidY(cap), 0);
  const count = geom.attributes.position.count;
  geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3).fill(1), 3));
  return geom;
}

function makeZoneMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    flatShading: true,
    vertexColors: true,
    roughness: 0.85,
    metalness: 0,
    emissive: 0xffffff,
    emissiveIntensity: 0,
  });
}

interface Slot {
  targetId: string | null;
  group: THREE.Group;
  headMesh: THREE.Mesh;
  bodyMesh: THREE.Mesh;
  legMesh: THREE.Mesh;
  headMat: THREE.MeshStandardMaterial;
  bodyMat: THREE.MeshStandardMaterial;
  legMat: THREE.MeshStandardMaterial;
  /** performance.now() timestamp each zone's flash ends; 0 = no active flash. */
  flashUntil: Record<HitZone, number>;
}

interface MarkerSlot {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  expiresAt: number;
}

export class TargetPool {
  private readonly scene: THREE.Scene;
  private readonly targetsRoot = new THREE.Group();
  private readonly markersRoot = new THREE.Group();
  private readonly slots: Slot[] = [];
  private readonly markers: MarkerSlot[] = [];
  private nextMarker = 0;
  private mode: VisualMode = 'humanoid';

  // Shared geometry: identical dimensions for every target, so every slot's
  // meshes for a zone reuse the SAME BufferGeometry instance. Two variants
  // per zone — the plain capsule (used by 'capsule'/'wireframe' modes) and
  // the articulated humanoid mesh (used by 'humanoid' mode) — and
  // `applyMode` below just points each slot's mesh at whichever one is
  // current. Building ~800 per-part meshes (25 parts x 32 slots) instead of
  // merging them would multiply the pool's draw-call count by nearly 30x;
  // see the top of `botMesh.ts` for the full rationale.
  private readonly headGeom: THREE.CapsuleGeometry;
  private readonly bodyGeom: THREE.CapsuleGeometry;
  private readonly legGeom: THREE.CapsuleGeometry;
  private readonly humanoidGeom: HumanoidZoneGeometries;
  private readonly markerGeom: THREE.SphereGeometry;

  constructor(scene: THREE.Scene, poolSize: number = TARGET_POOL_SIZE) {
    this.scene = scene;

    const headCap = findCapsule('head', STANDING_HITBOX);
    const bodyCap = findCapsule('body', STANDING_HITBOX);
    const legCap = findCapsule('leg', STANDING_HITBOX);

    this.headGeom = buildZoneGeometry(headCap);
    this.bodyGeom = buildZoneGeometry(bodyCap);
    this.legGeom = buildZoneGeometry(legCap);
    this.humanoidGeom = buildHumanoidGeometries(headCap, bodyCap, legCap);

    this.markerGeom = new THREE.SphereGeometry(0.035, 6, 6);

    for (let i = 0; i < poolSize; i++) {
      this.slots.push(this.buildSlot());
    }
    for (let i = 0; i < MARKER_POOL_SIZE; i++) {
      this.markers.push(this.buildMarker());
    }

    this.targetsRoot.add(...this.slots.map((s) => s.group));
    this.markersRoot.add(...this.markers.map((m) => m.mesh));
    this.scene.add(this.targetsRoot, this.markersRoot);

    this.applyMode();
  }

  private buildSlot(): Slot {
    const headMat = makeZoneMaterial();
    const bodyMat = makeZoneMaterial();
    const legMat = makeZoneMaterial();

    // Both the plain-capsule and humanoid geometries are baked in absolute
    // (feet-at-y=0) space (see `buildZoneGeometry`/`botMesh.ts`), so the
    // mesh itself never needs repositioning — `applyMode` swaps `.geometry`
    // in place when the visual mode changes.
    const headMesh = new THREE.Mesh(this.headGeom, headMat);
    const bodyMesh = new THREE.Mesh(this.bodyGeom, bodyMat);
    const legMesh = new THREE.Mesh(this.legGeom, legMat);

    const group = new THREE.Group();
    group.add(headMesh, bodyMesh, legMesh);
    group.visible = false;

    return {
      targetId: null,
      group,
      headMesh,
      bodyMesh,
      legMesh,
      headMat,
      bodyMat,
      legMat,
      flashUntil: { head: 0, body: 0, leg: 0 },
    };
  }

  private buildMarker(): MarkerSlot {
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
    const mesh = new THREE.Mesh(this.markerGeom, material);
    mesh.visible = false;
    return { mesh, material, expiresAt: 0 };
  }

  /** Switches humanoid/capsule/wireframe. Mutates existing materials in place — never allocates new ones. */
  setVisualMode(mode: VisualMode): void {
    this.mode = mode;
    this.applyMode();
  }

  getVisualMode(): VisualMode {
    return this.mode;
  }

  private applyMode(): void {
    const humanoid = this.mode === 'humanoid';
    const palette = MODE_COLOR[this.mode];
    const wire = this.mode === 'wireframe';
    for (const slot of this.slots) {
      slot.headMesh.geometry = humanoid ? this.humanoidGeom.head : this.headGeom;
      slot.bodyMesh.geometry = humanoid ? this.humanoidGeom.body : this.bodyGeom;
      slot.legMesh.geometry = humanoid ? this.humanoidGeom.leg : this.legGeom;
      // In 'humanoid' mode the per-part colour is baked into the geometry's
      // vertex colours (see `botMesh.ts`); leaving material.color at white
      // means it multiplies as the identity and those colours show through
      // unmodified. In 'capsule'/'wireframe' the plain geometry's vertex
      // colours are uniformly white (see `buildZoneGeometry`), so the
      // palette tint below is once again the only thing that matters —
      // both modes are pixel-for-pixel unchanged from before vertex colours.
      slot.headMat.color.setHex(humanoid ? 0xffffff : palette.head);
      slot.bodyMat.color.setHex(humanoid ? 0xffffff : palette.body);
      slot.legMat.color.setHex(humanoid ? 0xffffff : palette.leg);
      slot.headMat.wireframe = wire;
      slot.bodyMat.wireframe = wire;
      slot.legMat.wireframe = wire;
    }
  }

  /**
   * Updates transforms for every visible target. Never creates or disposes
   * geometry/materials here — only show/hide, position, and colour writes.
   *
   * Interpolation: `TargetState.position` is the last fixed-step position;
   * we advect it forward by `velocity * alpha * SIM_STEP` rather than
   * lerping against a cached previous state, because that's exactly the
   * information this signature gives us (position + velocity), it is O(1)
   * and allocation-free, and it degenerates correctly to the exact
   * fixed-step position at alpha=0.
   */
  sync(targets: TargetState[], alpha: number): void {
    const now = performance.now();
    const dtS = alpha * SIM_STEP_S;

    // Below uses plain indexed loops rather than .find/.some/.map: those
    // array-method callbacks are closures, and this runs every render frame
    // for every pooled slot, so we hold the zero-allocation rule here too.

    // 1) Free slots whose target is no longer present.
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (slot.targetId === null) continue;
      let stillLive = false;
      for (let j = 0; j < targets.length; j++) {
        if (targets[j].id === slot.targetId) { stillLive = true; break; }
      }
      if (!stillLive) {
        slot.targetId = null;
        slot.group.visible = false;
      }
    }

    // 2) Bind/update every live target. Pool is small and fixed-size, so a
    // linear scan per target is cheap and allocation-free (no Map/Set).
    for (let ti = 0; ti < targets.length; ti++) {
      const t = targets[ti];
      if (!t.alive) continue;

      let slot: Slot | null = null;
      for (let i = 0; i < this.slots.length; i++) {
        if (this.slots[i].targetId === t.id) { slot = this.slots[i]; break; }
      }
      if (!slot) {
        for (let i = 0; i < this.slots.length; i++) {
          if (this.slots[i].targetId === null) { slot = this.slots[i]; break; }
        }
        if (!slot) continue; // Pool exhausted — silently drop, scenarios stay well under capacity.
        slot.targetId = t.id;
      }

      slot.group.visible = true;
      slot.group.position.set(
        t.position.x + t.velocity.x * dtS,
        t.position.y + t.velocity.y * dtS,
        t.position.z + t.velocity.z * dtS,
      );
      slot.group.rotation.y = t.yaw * (Math.PI / 180);
      const crouchScale = t.crouching ? CROUCH_SCALE.value : 1;
      slot.group.scale.set(1, crouchScale, 1);

      this.updateFlash(slot.headMat, slot.flashUntil.head, now);
      this.updateFlash(slot.bodyMat, slot.flashUntil.body, now);
      this.updateFlash(slot.legMat, slot.flashUntil.leg, now);
    }

    this.syncMarkers(now);
  }

  private updateFlash(mat: THREE.MeshStandardMaterial, until: number, now: number): void {
    if (until <= now) {
      if (mat.emissiveIntensity !== 0) mat.emissiveIntensity = 0;
      return;
    }
    const remaining = (until - now) / FLASH_DURATION_MS;
    mat.emissiveIntensity = remaining * FLASH_INTENSITY;
  }

  /** Brief emissive tint on the hit zone, e.g. on a confirmed shot. */
  flashHit(targetId: string, zone: HitZone): void {
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (slot.targetId === targetId) {
        slot.flashUntil[zone] = performance.now() + FLASH_DURATION_MS;
        return;
      }
    }
  }

  /** Small world-space impact marker at `point`, tinted by zone. Pooled, round-robin reuse. */
  spawnHitMarker(point: Vec3, zone: HitZone): void {
    const marker = this.markers[this.nextMarker];
    this.nextMarker = (this.nextMarker + 1) % this.markers.length;

    marker.mesh.position.set(point.x, point.y, point.z);
    marker.mesh.scale.setScalar(MARKER_START_SCALE);
    marker.mesh.visible = true;
    marker.material.color.setHex(MARKER_COLOR[zone]);
    marker.material.opacity = 1;
    marker.expiresAt = performance.now() + MARKER_DURATION_MS;
  }

  private syncMarkers(now: number): void {
    for (let i = 0; i < this.markers.length; i++) {
      const marker = this.markers[i];
      if (!marker.mesh.visible) continue;
      const remaining = marker.expiresAt - now;
      if (remaining <= 0) {
        marker.mesh.visible = false;
        continue;
      }
      const t = remaining / MARKER_DURATION_MS; // 1 -> 0 over its lifetime
      marker.material.opacity = t;
      marker.mesh.scale.setScalar(MARKER_END_SCALE + (MARKER_START_SCALE - MARKER_END_SCALE) * t);
    }
  }

  dispose(): void {
    this.scene.remove(this.targetsRoot, this.markersRoot);
    for (const slot of this.slots) {
      slot.headMat.dispose();
      slot.bodyMat.dispose();
      slot.legMat.dispose();
    }
    for (const marker of this.markers) {
      marker.material.dispose();
    }
    this.headGeom.dispose();
    this.bodyGeom.dispose();
    this.legGeom.dispose();
    this.humanoidGeom.head.dispose();
    this.humanoidGeom.body.dispose();
    this.humanoidGeom.leg.dispose();
    this.markerGeom.dispose();
    this.slots.length = 0;
    this.markers.length = 0;
  }
}
