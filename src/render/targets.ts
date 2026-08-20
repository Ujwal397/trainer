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

/** Per-mode, per-zone base colour. Kept subtle in `humanoid` so the head zone reads without becoming a beacon. */
const MODE_COLOR: Record<VisualMode, Record<HitZone, number>> = {
  humanoid: { head: 0x3a4a52, body: 0x293a41, leg: 0x212e33 },
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

/** Builds a CapsuleGeometry whose radius/length are derived from the hitbox capsule, not eyeballed. */
function buildZoneGeometry(cap: Capsule): THREE.CapsuleGeometry {
  const length = distance(cap.a, cap.b);
  // Low radial segment count reads as clean/faceted (flat-shaded) rather than smooth-rounded plastic.
  return new THREE.CapsuleGeometry(cap.radius, length, 3, 8);
}

function zoneMidY(cap: Capsule): number {
  return scaleVec(add(cap.a, cap.b), 0.5).y;
}

function makeZoneMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    flatShading: true,
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
  shoulderMesh: THREE.Mesh;
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
  // meshes for a zone reuse the SAME BufferGeometry instance.
  private readonly headGeom: THREE.CapsuleGeometry;
  private readonly bodyGeom: THREE.CapsuleGeometry;
  private readonly legGeom: THREE.CapsuleGeometry;
  private readonly shoulderGeom: THREE.BoxGeometry;
  private readonly markerGeom: THREE.SphereGeometry;

  private readonly headMidY: number;
  private readonly bodyMidY: number;
  private readonly legMidY: number;

  constructor(scene: THREE.Scene, poolSize: number = TARGET_POOL_SIZE) {
    this.scene = scene;

    const headCap = findCapsule('head', STANDING_HITBOX);
    const bodyCap = findCapsule('body', STANDING_HITBOX);
    const legCap = findCapsule('leg', STANDING_HITBOX);

    this.headGeom = buildZoneGeometry(headCap);
    this.bodyGeom = buildZoneGeometry(bodyCap);
    this.legGeom = buildZoneGeometry(legCap);
    this.headMidY = zoneMidY(headCap);
    this.bodyMidY = zoneMidY(bodyCap);
    this.legMidY = zoneMidY(legCap);

    // Shoulders are a purely cosmetic 'humanoid' embellishment, sized off the
    // body capsule's own radius so they never contradict the real hitbox.
    const bodyTopY = Math.max(bodyCap.a.y, bodyCap.b.y);
    this.shoulderGeom = new THREE.BoxGeometry(bodyCap.radius * 2.3, bodyCap.radius * 0.55, bodyCap.radius * 1.1);

    this.markerGeom = new THREE.SphereGeometry(0.035, 6, 6);

    for (let i = 0; i < poolSize; i++) {
      this.slots.push(this.buildSlot(bodyTopY));
    }
    for (let i = 0; i < MARKER_POOL_SIZE; i++) {
      this.markers.push(this.buildMarker());
    }

    this.targetsRoot.add(...this.slots.map((s) => s.group));
    this.markersRoot.add(...this.markers.map((m) => m.mesh));
    this.scene.add(this.targetsRoot, this.markersRoot);

    this.applyMode();
  }

  private buildSlot(bodyTopY: number): Slot {
    const headMat = makeZoneMaterial();
    const bodyMat = makeZoneMaterial();
    const legMat = makeZoneMaterial();

    const headMesh = new THREE.Mesh(this.headGeom, headMat);
    headMesh.position.y = this.headMidY;
    const bodyMesh = new THREE.Mesh(this.bodyGeom, bodyMat);
    bodyMesh.position.y = this.bodyMidY;
    const legMesh = new THREE.Mesh(this.legGeom, legMat);
    legMesh.position.y = this.legMidY;

    // Shoulders share the body material so a body-zone hit flash reads across
    // the whole torso silhouette instead of looking split.
    const shoulderMesh = new THREE.Mesh(this.shoulderGeom, bodyMat);
    shoulderMesh.position.y = bodyTopY;

    const group = new THREE.Group();
    group.add(headMesh, bodyMesh, legMesh, shoulderMesh);
    group.visible = false;

    return {
      targetId: null,
      group,
      headMesh,
      bodyMesh,
      legMesh,
      shoulderMesh,
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
    const palette = MODE_COLOR[this.mode];
    const wire = this.mode === 'wireframe';
    for (const slot of this.slots) {
      slot.headMat.color.setHex(palette.head);
      slot.bodyMat.color.setHex(palette.body);
      slot.legMat.color.setHex(palette.leg);
      slot.headMat.wireframe = wire;
      slot.bodyMat.wireframe = wire;
      slot.legMat.wireframe = wire;
      // Shoulders only make sense as a stylised-agent embellishment.
      slot.shoulderMesh.visible = this.mode === 'humanoid';
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
    this.shoulderGeom.dispose();
    this.markerGeom.dispose();
    this.slots.length = 0;
    this.markers.length = 0;
  }
}
