import * as THREE from 'three';
import { UNIT_BOX } from './voxel';
import type { ParticleSystem } from './effects';

/**
 * Premium weapon VFX, all instanced and pooled (fixed draw calls, zero per-shot allocations):
 *  - Tracers: tapered hot core + wide additive glow sheath + bright voxel head + fading trail.
 *  - VoxelBursts: chunky additive cubes/spikes for muzzle flashes and impact flashes.
 * Purely cosmetic: bullets are simulated (and collide) in game.ts; this only draws them.
 */

/** Per-weapon look. Colours are hex; widths/lengths in metres; lives in seconds. */
export interface TracerStyle {
  coreColor: number; glowColor: number; trailColor: number;
  coreWidth: number; glowWidth: number; length: number;
  headSize: number;
  trailWidth: number; trailLife: number; trailBright: number;
  /** Chance per frame that a flying bullet sheds a tiny cubic ember. */
  emberChance: number;
  /** Muzzle flash size multiplier, forward spike length (m), side spikes, sparks per shot. */
  flashScale: number; spikeLength: number; sideSpikes: number; flashSparks: number;
  /** Directional blast: flame spikes fanned across ±fanAngle (rad) in front of the muzzle (0 = none). */
  fanSpikes: number; fanAngle: number;
  /** Impact flash size multiplier and spike count. */
  impactScale: number; impactSpikes: number;
  /** Random per-bullet length/brightness variation 0..1. */
  variation: number;
}

export const TRACER_STYLES: Partial<Record<string, TracerStyle>> = {
  // Pistol: one powerful, clean round. Long bright tracer, sharp star-shaped flash.
  pistol: {
    coreColor: 0xfff1c4, glowColor: 0xff8a1c, trailColor: 0xff9a3a,
    coreWidth: 0.08, glowWidth: 0.34, length: 1.8, headSize: 0.13,
    trailWidth: 0.05, trailLife: 0.25, trailBright: 0.6,
    emberChance: 0.35,
    flashScale: 1.8, spikeLength: 0.75, sideSpikes: 4, flashSparks: 7, fanSpikes: 0, fanAngle: 0,
    impactScale: 1.7, impactSpikes: 5, variation: 0,
  },
  // SMG: rapid, shorter and thinner tracers that vary round to round; a smaller flash every shot
  // (every 3rd round blooms bigger, driven by the caller's power).
  smg: {
    coreColor: 0xffe7a0, glowColor: 0xff9a2a, trailColor: 0xffa040,
    coreWidth: 0.06, glowWidth: 0.24, length: 1.15, headSize: 0.095,
    trailWidth: 0.035, trailLife: 0.14, trailBright: 0.45,
    emberChance: 0.12,
    flashScale: 1.35, spikeLength: 0.6, sideSpikes: 3, flashSparks: 3, fanSpikes: 0, fanAngle: 0,
    impactScale: 1.25, impactSpikes: 4, variation: 0.35,
  },
  // Shotgun: twelve individual glowing pellets and a wide, directional muzzle blast.
  shotgun: {
    coreColor: 0xfff0c0, glowColor: 0xff7a18, trailColor: 0xff8a30,
    coreWidth: 0.055, glowWidth: 0.22, length: 0.95, headSize: 0.1,
    trailWidth: 0.03, trailLife: 0.28, trailBright: 0.4,
    emberChance: 0.15,
    flashScale: 2.3, spikeLength: 0.95, sideSpikes: 4, flashSparks: 16, fanSpikes: 7, fanAngle: 0.32,
    impactScale: 1.1, impactSpikes: 3, variation: 0.4,
  },
};

/** Bullet fields the tracers read (BulletVisual in bulletViews.ts carries these). */
export interface TracerBullet {
  x: number; y: number; z: number; px: number; py: number; pz: number;
  ox: number; oy: number; oz: number;
  dx: number; dy: number; dz: number;
  style?: TracerStyle;
  /** 0..1 random seed for per-bullet variation (set at fire time). */
  seed?: number;
}

const MUZZLE_DIST = 0.6;
const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), q2 = new THREE.Quaternion();
const p = new THREE.Vector3(), s = new THREE.Vector3(), d = new THREE.Vector3(), col = new THREE.Color();
const FWD = new THREE.Vector3(0, 0, 1), e = new THREE.Euler();

/**
 * Unit box extending backwards from the origin (head at z=0, tail at z=-1), tapered toward the tail,
 * with a vertex-colour gradient (bright head → dark tail; additive blending turns dark into transparent).
 */
function taperedGeo(tailScale: number, tailBright: number): THREE.BufferGeometry {
  const g = UNIT_BOX.clone().translate(0, 0, -0.5);
  const pos = g.attributes.position, c: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const tail = pos.getZ(i) < -0.5;
    if (tail) { pos.setX(i, pos.getX(i) * tailScale); pos.setY(i, pos.getY(i) * tailScale); }
    const b = tail ? tailBright : 1;
    c.push(b, b, b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
  return g;
}

const additive = (vertexColors: boolean) => new THREE.MeshBasicMaterial({
  color: 0xffffff, vertexColors, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
});

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, n: number, scene: THREE.Scene): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(geo, mat, n);
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
  m.frustumCulled = false;
  m.count = 0;
  scene.add(m);
  return m;
}

interface Trail { live: boolean; ref: TracerBullet | null; sx: number; sy: number; sz: number; ex: number; ey: number; ez: number; age: number; style: TracerStyle }

/** Tracers for styled bullets: 4 instanced meshes (core, glow, head, trail) = 4 draw calls total. */
export class Tracers {
  private readonly core: THREE.InstancedMesh;
  private readonly glow: THREE.InstancedMesh;
  private readonly head: THREE.InstancedMesh;
  private readonly trail: THREE.InstancedMesh;
  private readonly trails: Trail[] = [];
  private readonly byBullet = new Map<TracerBullet, Trail>();
  private readonly seen = new Set<TracerBullet>();

  constructor(scene: THREE.Scene, private readonly embers: ParticleSystem, capacity = 128) {
    this.core = instanced(taperedGeo(0.15, 0.25), additive(true), capacity, scene);
    this.glow = instanced(taperedGeo(0.3, 0), additive(true), capacity, scene);
    this.head = instanced(UNIT_BOX, additive(false), capacity, scene);
    this.trail = instanced(taperedGeo(0.5, 0), additive(true), capacity, scene);
    for (let i = 0; i < capacity; i++) this.trails.push({ live: false, ref: null, sx: 0, sy: 0, sz: 0, ex: 0, ey: 0, ez: 0, age: 0, style: TRACER_STYLES.pistol! });
  }

  update(list: readonly TracerBullet[], alpha: number, dt: number): void {
    let n = 0;
    const cap = this.core.instanceMatrix.count;
    this.seen.clear();
    for (const b of list) {
      const st = b.style;
      if (!st || n >= cap) continue;
      p.set(b.px + (b.x - b.px) * alpha, b.py + (b.y - b.py) * alpha, b.pz + (b.z - b.pz) * alpha);
      this.track(b, st);
      const fromMuzzle = Math.hypot(p.x - b.ox, p.y - b.oy, p.z - b.oz) - MUZZLE_DIST;
      const v = st.variation * ((b.seed ?? 0.5) - 0.5) * 2; // -variation..+variation
      const len = Math.min(st.length * (1 + v * 0.5), fromMuzzle);
      if (len <= 0.02) continue;
      q.setFromUnitVectors(FWD, d.set(b.dx, b.dy, b.dz));
      // Slight random roll each frame: the square-section voxel tracer shimmers.
      q.multiply(q2.setFromAxisAngle(FWD, Math.random() * Math.PI));
      const bright = 1 + v * 0.3;
      this.core.setMatrixAt(n, m4.compose(p, q, s.set(st.coreWidth, st.coreWidth, len)));
      this.core.setColorAt(n, col.setHex(st.coreColor).multiplyScalar(bright));
      this.glow.setMatrixAt(n, m4.compose(p, q, s.set(st.glowWidth, st.glowWidth, len * 1.15)));
      this.glow.setColorAt(n, col.setHex(st.glowColor).multiplyScalar(0.8 * bright));
      const hs = st.headSize * (0.85 + Math.random() * 0.3);
      this.head.setMatrixAt(n, m4.compose(p, q, s.set(hs, hs, hs * 1.6)));
      this.head.setColorAt(n, col.setHex(st.coreColor));
      n++;
      // Tiny cubic embers shed behind the round.
      if (Math.random() < st.emberChance) {
        const k = Math.random() * len;
        this.embers.emit(p.x - b.dx * k, p.y - b.dy * k, p.z - b.dz * k, (Math.random() - 0.5) * 1.2, Math.random() * 1.2, (Math.random() - 0.5) * 1.2,
          0.025 + Math.random() * 0.02, 0.12 + Math.random() * 0.12, Math.random() < 0.5 ? st.glowColor : st.coreColor, 0.3, 6, 3);
      }
    }
    for (const m of [this.core, this.glow, this.head]) {
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor!.needsUpdate = true;
    }
    this.updateTrails(dt);
  }

  /** A fading trail from the muzzle to the round's head; keeps up while it flies, then fades. */
  private track(b: TracerBullet, st: TracerStyle): void {
    this.seen.add(b);
    let t = this.byBullet.get(b);
    if (!t) {
      t = this.trails.find((x) => !x.live);
      if (!t) return;
      const l = Math.hypot(b.dx, b.dz) || 1;
      t.live = true; t.ref = b; t.age = 0; t.style = st;
      t.sx = b.ox + (b.dx / l) * MUZZLE_DIST; t.sy = b.oy; t.sz = b.oz + (b.dz / l) * MUZZLE_DIST;
      this.byBullet.set(b, t);
    }
    t.ex = p.x; t.ey = p.y; t.ez = p.z;
  }

  private updateTrails(dt: number): void {
    let n = 0;
    for (const t of this.trails) {
      if (!t.live) continue;
      if (t.ref && !this.seen.has(t.ref)) { this.byBullet.delete(t.ref); t.ref = null; }
      if (!t.ref) t.age += dt;
      const st = t.style;
      if (t.age >= st.trailLife) { t.live = false; continue; }
      const dx = t.ex - t.sx, dy = t.ey - t.sy, dz = t.ez - t.sz, len = Math.hypot(dx, dy, dz);
      if (len < 0.05) continue;
      const k = t.age / st.trailLife, w = st.trailWidth * (1 + k * 1.5);
      q.setFromUnitVectors(FWD, d.set(dx / len, dy / len, dz / len));
      this.trail.setMatrixAt(n, m4.compose(p.set(t.ex, t.ey, t.ez), q, s.set(w, w, len)));
      this.trail.setColorAt(n, col.setHex(st.trailColor).multiplyScalar(st.trailBright * (1 - k) * (1 - k)));
      n++;
    }
    this.trail.count = n;
    this.trail.instanceMatrix.needsUpdate = true;
    this.trail.instanceColor!.needsUpdate = true;
  }
}

/**
 * Short-lived additive voxels (flash cores and spikes). Each one pops to full size, then shrinks
 * and dims over its life. One InstancedMesh, ring-buffer pool.
 */
export class VoxelBursts {
  private readonly mesh: THREE.InstancedMesh;
  private readonly cap: number;
  private readonly pos: Float32Array; private readonly rot: Float32Array; private readonly scl: Float32Array;
  private readonly life: Float32Array; private readonly max: Float32Array; private readonly rgb: Float32Array;
  private next = 0;

  constructor(scene: THREE.Scene, capacity = 192) {
    this.cap = capacity;
    // Origin at the back face: spikes grow forward from where they're placed.
    this.mesh = instanced(UNIT_BOX.clone().translate(0, 0, 0.5), additive(false), capacity, scene);
    this.mesh.count = capacity;
    this.pos = new Float32Array(capacity * 3); this.rot = new Float32Array(capacity * 4); this.scl = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity); this.max = new Float32Array(capacity).fill(1); this.rgb = new Float32Array(capacity * 3);
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, m4.makeScale(0, 0, 0));
  }

  /** `quat` orients the voxel's +Z; sz is its length along +Z (starting at the given point). */
  spawn(x: number, y: number, z: number, quat: THREE.Quaternion, sx: number, sy: number, sz: number, color: number, life: number, bright = 1): void {
    const i = this.next;
    this.next = (this.next + 1) % this.cap;
    this.pos.set([x, y, z], i * 3);
    this.rot.set([quat.x, quat.y, quat.z, quat.w], i * 4);
    this.scl.set([sx, sy, sz], i * 3);
    this.life[i] = this.max[i] = life;
    col.setHex(color).multiplyScalar(bright);
    this.rgb.set([col.r, col.g, col.b], i * 3);
  }

  update(dt: number): void {
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const t = Math.max(0, this.life[i] / this.max[i]); // 1 → 0
      const k = t <= 0 ? 0 : 0.35 + 0.65 * t; // shrink
      const i3 = i * 3, i4 = i * 4;
      q.set(this.rot[i4], this.rot[i4 + 1], this.rot[i4 + 2], this.rot[i4 + 3]);
      this.mesh.setMatrixAt(i, m4.compose(p.set(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2]), q,
        s.set(this.scl[i3] * k, this.scl[i3 + 1] * k, this.scl[i3 + 2] * (0.6 + 0.4 * t))));
      this.mesh.setColorAt(i, col.setRGB(this.rgb[i3] * t, this.rgb[i3 + 1] * t, this.rgb[i3 + 2] * t));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }
}

/** Muzzle flash + impact flash recipes built from VoxelBursts and the cubic spark particles. */
export class WeaponVfx {
  readonly bursts: VoxelBursts;
  readonly tracers: Tracers;

  constructor(scene: THREE.Scene, private readonly sparks: ParticleSystem) {
    this.bursts = new VoxelBursts(scene);
    this.tracers = new Tracers(scene, sparks);
  }

  /** Chunky 3D star flash at the muzzle along (dx, dz), plus a forward cone of cubic sparks. */
  muzzleFlash(st: TracerStyle, x: number, y: number, z: number, dx: number, dz: number, power = 1): void {
    const yaw = Math.atan2(dx, dz), f = st.flashScale * power, b = this.bursts;
    // Core: a few overlapping rotated cubes, white-hot centre with an orange shell.
    for (let i = 0; i < 3; i++) {
      q.setFromEuler(e.set(Math.random() * 3, Math.random() * 3, Math.random() * 3));
      const c = (0.13 + Math.random() * 0.06) * f;
      b.spawn(x - dx * c * 0.5, y, z - dz * c * 0.5, q, c, c, c, i === 0 ? 0xfff6d8 : 0xffb040, 0.055, i === 0 ? 1.4 : 1);
    }
    q.setFromEuler(e.set(0, yaw, Math.random() * Math.PI / 2, 'YXZ'));
    const big = 0.26 * f;
    b.spawn(x - dx * big * 0.3, y, z - dz * big * 0.3, q, big, big, big * 0.8, 0xff7a1a, 0.07, 0.8);
    // Forward spike (the sharp tongue of flame) + a thinner hot inner spike.
    const roll = Math.random() * Math.PI;
    q.setFromEuler(e.set(0, yaw, roll, 'YXZ'));
    b.spawn(x, y, z, q, 0.09 * f, 0.09 * f, st.spikeLength * f * (0.85 + Math.random() * 0.3), 0xffa030, 0.05, 1.1);
    b.spawn(x, y, z, q, 0.04 * f, 0.04 * f, st.spikeLength * f * 0.75, 0xfffbe8, 0.04, 1.5);
    // Side spikes fanning out around the barrel (3D: rolled around the aim axis).
    for (let i = 0; i < st.sideSpikes; i++) {
      const a = roll + (i / st.sideSpikes) * Math.PI * 2;
      q.setFromEuler(e.set(Math.sin(a) * 0.9, yaw + Math.cos(a) * 0.9, 0, 'YXZ'));
      b.spawn(x, y, z, q, 0.045 * f, 0.045 * f, st.spikeLength * 0.45 * f * (0.7 + Math.random() * 0.6), 0xffc060, 0.04, 1);
    }
    // Directional blast: a fan of flame tongues across the spread, longest in the middle.
    for (let i = 0; i < st.fanSpikes; i++) {
      const u = st.fanSpikes > 1 ? (i / (st.fanSpikes - 1)) * 2 - 1 : 0;
      q.setFromEuler(e.set((Math.random() - 0.5) * 0.25, yaw + u * st.fanAngle, Math.random() * Math.PI, 'YXZ'));
      const len = st.spikeLength * f * 0.6 * (1 - 0.45 * Math.abs(u)) * (0.8 + Math.random() * 0.4);
      b.spawn(x, y, z, q, 0.07 * f, 0.07 * f, len, i % 2 ? 0xffb040 : 0xff7a1a, 0.07, 1);
    }
    // Cubic sparks spraying forward.
    const sprayW = 0.9 + st.fanAngle * 2;
    for (let i = 0; i < st.flashSparks; i++) {
      const a = yaw + (Math.random() - 0.5) * sprayW, sp = 5 + Math.random() * 7;
      this.sparks.emit(x, y, z, Math.sin(a) * sp, (Math.random() - 0.3) * 2.5, Math.cos(a) * sp,
        0.03 + Math.random() * 0.025, 0.1 + Math.random() * 0.12, Math.random() < 0.5 ? 0xffd070 : 0xff8a2a, 0.3, 8, 4);
    }
  }

  /** Small 3D starburst where a round lands, oriented along the surface normal. */
  impactFlash(st: TracerStyle, x: number, y: number, z: number, nx: number, ny: number, nz: number, flesh: boolean): void {
    const f = st.impactScale, b = this.bursts;
    q.setFromEuler(e.set(Math.random() * 3, Math.random() * 3, Math.random() * 3));
    const c = 0.16 * f;
    b.spawn(x, y, z, q, c, c, c, flesh ? 0xff6040 : 0xfff0c0, 0.06, 1.2);
    for (let i = 0; i < st.impactSpikes; i++) {
      // Random direction in the hemisphere around the normal.
      d.set(nx + (Math.random() - 0.5) * 1.6, ny + (Math.random() - 0.5) * 1.6, nz + (Math.random() - 0.5) * 1.6).normalize();
      q.setFromUnitVectors(FWD, d);
      b.spawn(x, y, z, q, 0.035 * f, 0.035 * f, (0.15 + Math.random() * 0.2) * f, flesh ? 0xff5a30 : 0xffb347, 0.06, 1);
    }
  }

  update(list: readonly TracerBullet[], alpha: number, dt: number): void {
    this.tracers.update(list, alpha, dt);
    this.bursts.update(dt);
  }
}
