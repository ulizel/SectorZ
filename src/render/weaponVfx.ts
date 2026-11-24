import * as THREE from 'three';
import { UNIT_BOX } from './voxel';
import type { ParticleSystem } from './effects';

/**
 * Weapon VFX, all instanced and pooled (fixed draw calls, zero per-shot allocations):
 *  - Rounds: a small glowing orb (nested additive shells → soft falloff) with a short, thin streak
 *    behind it that fades to nothing. When a round stops, its streak collapses into the stop point.
 *  - Glows: the same orb used as a short-lived light bloom at the muzzle and at impacts.
 *  - Spikes: chunky additive voxel boxes for the flash star shapes.
 * Purely cosmetic: bullets are simulated (and collide) in game.ts; this only draws them.
 */

/** Per-weapon look. Sizes in metres, lives in seconds. */
export interface TracerStyle {
  /** Streak length behind the head and its width (outer glow; the hot core is ~35% of it). */
  streakLength: number; streakWidth: number;
  /** Head orb radius (outer glow shell). */
  headSize: number;
  /** Multiplies the built-in white-hot → orange colours (hue shift / brightness). */
  tint: number;
  /** Chance per frame that a flying round sheds a tiny cubic ember. */
  emberChance: number;
  /** Muzzle: glow orb radius, star size multiplier, forward spike length, side spikes, sparks. */
  flashGlow: number; flashScale: number; spikeLength: number; sideSpikes: number; flashSparks: number;
  /** Directional blast: flame spikes fanned across ±fanAngle (rad) in front of the muzzle (0 = none). */
  fanSpikes: number; fanAngle: number;
  /** Impact: size multiplier, spike count, cubic sparks. */
  impactScale: number; impactSpikes: number; impactSparks: number;
  /** Warm smoke puffs left around the muzzle per shot. */
  smokePuffs: number;
  /** Random per-round streak length/brightness variation 0..1. */
  variation: number;
}

export const TRACER_STYLES: Partial<Record<string, TracerStyle>> = {
  // Pistol: one clean, powerful round with a sharp flash.
  pistol: {
    streakLength: 2.6, streakWidth: 0.09, headSize: 0.15, tint: 0xffffff, emberChance: 0.3,
    flashGlow: 0.38, flashScale: 1.55, spikeLength: 0.8, sideSpikes: 6, flashSparks: 7, fanSpikes: 0, fanAngle: 0,
    impactScale: 1.3, impactSpikes: 8, impactSparks: 7, smokePuffs: 4, variation: 0,
  },
  // SMG: rapid, shorter and thinner, slightly yellower; varies round to round.
  smg: {
    streakLength: 1.6, streakWidth: 0.07, headSize: 0.11, tint: 0xfff2c8, emberChance: 0.12,
    flashGlow: 0.28, flashScale: 1.15, spikeLength: 0.6, sideSpikes: 5, flashSparks: 3, fanSpikes: 0, fanAngle: 0,
    impactScale: 1, impactSpikes: 5, impactSparks: 3, smokePuffs: 1, variation: 0.35,
  },
  // Shotgun: twelve individual pellets (small and dimmer, so overlapping additive pellets stay
  // separate instead of saturating into one blob) and a wide, directional muzzle blast.
  shotgun: {
    streakLength: 1.0, streakWidth: 0.035, headSize: 0.065, tint: 0xb0b0b0, emberChance: 0.08,
    flashGlow: 0.5, flashScale: 1.7, spikeLength: 0.85, sideSpikes: 6, flashSparks: 14, fanSpikes: 7, fanAngle: 0.3,
    impactScale: 0.85, impactSpikes: 4, impactSparks: 2, smokePuffs: 6, variation: 0.4,
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
/** A stopped round's streak collapses into the stop point over this long. */
const DIE_TIME = 0.08;
const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
const p = new THREE.Vector3(), s = new THREE.Vector3(), d = new THREE.Vector3(), col = new THREE.Color();
const FWD = new THREE.Vector3(0, 0, 1), e = new THREE.Euler();

/** Merge geometries into one non-indexed geometry, each part tinted (times its own vertex colours). */
function merge(parts: { g: THREE.BufferGeometry; c: [number, number, number] }[]): THREE.BufferGeometry {
  const pos: number[] = [], colr: number[] = [];
  for (const { g, c } of parts) {
    const ng = g.index ? g.toNonIndexed() : g;
    const a = ng.attributes.position, vc = ng.attributes.color;
    for (let i = 0; i < a.count; i++) {
      pos.push(a.getX(i), a.getY(i), a.getZ(i));
      const k = vc ? vc.getX(i) : 1; // per-vertex brightness (streak gradient)
      colr.push(c[0] * k, c[1] * k, c[2] * k);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
  return out;
}

/** Glow orb: three nested low-poly shells; additive overlap makes a bright centre that falls off. */
function orbGeo(): THREE.BufferGeometry {
  return merge([
    { g: new THREE.IcosahedronGeometry(1, 1), c: [0.32, 0.12, 0.02] },
    { g: new THREE.IcosahedronGeometry(0.55, 1), c: [0.6, 0.32, 0.08] },
    { g: new THREE.IcosahedronGeometry(0.26, 1), c: [1, 0.92, 0.75] },
  ]);
}

/** Streak part: head at z=0, tail at z=-1 tapering to a point, brightness 1 → 0 along its length. */
function taper(width: number): THREE.BufferGeometry {
  const g = UNIT_BOX.clone().translate(0, 0, -0.5);
  const a = g.attributes.position, c: number[] = [];
  for (let i = 0; i < a.count; i++) {
    const tail = a.getZ(i) < -0.5;
    a.setX(i, a.getX(i) * width * (tail ? 0.1 : 1));
    a.setY(i, a.getY(i) * width * (tail ? 0.1 : 1));
    const b = tail ? 0 : 1;
    c.push(b, b, b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
  return g;
}
/** Orange outer glow + white-hot thin core, merged (one draw call for all streaks). */
function streakGeo(): THREE.BufferGeometry {
  return merge([{ g: taper(1), c: [0.5, 0.2, 0.03] }, { g: taper(0.35), c: [1, 0.85, 0.55] }]);
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

/** A round's last drawn state; when it stops, its streak collapses into that point and fades. */
interface Dying { live: boolean; x: number; y: number; z: number; dx: number; dy: number; dz: number; len: number; age: number; style: TracerStyle }

/** Rounds in flight + collapsing streaks: 2 instanced meshes (streaks, head orbs) = 2 draw calls. */
export class Tracers {
  private readonly streaks: THREE.InstancedMesh;
  private readonly heads: THREE.InstancedMesh;
  private readonly dying: Dying[] = [];
  private readonly last = new Map<TracerBullet, Dying>();
  private readonly seen = new Set<TracerBullet>();
  private readonly cap: number;

  constructor(scene: THREE.Scene, orb: THREE.BufferGeometry, private readonly embers: ParticleSystem, capacity = 96) {
    this.cap = capacity;
    this.streaks = instanced(streakGeo(), additive(true), capacity, scene);
    this.heads = instanced(orb, additive(true), capacity, scene);
    for (let i = 0; i < capacity; i++) this.dying.push({ live: false, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 1, len: 0, age: 0, style: TRACER_STYLES.pistol! });
  }

  update(list: readonly TracerBullet[], alpha: number, dt: number): void {
    let n = 0;
    this.seen.clear();
    for (const b of list) {
      const st = b.style;
      if (!st || n >= this.cap) continue;
      this.seen.add(b);
      p.set(b.px + (b.x - b.px) * alpha, b.py + (b.y - b.py) * alpha, b.pz + (b.z - b.pz) * alpha);
      const v = st.variation * ((b.seed ?? 0.5) - 0.5) * 2; // -variation..+variation
      // The streak never reaches back past the muzzle (short right after the shot, then full length).
      const fromMuzzle = Math.hypot(p.x - b.ox, p.y - b.oy, p.z - b.oz) - MUZZLE_DIST;
      const len = Math.min(st.streakLength * (1 + v * 0.4), fromMuzzle);
      if (len <= 0.02) continue;
      const hx = p.x, hy = p.y, hz = p.z;
      this.draw(n++, hx, hy, hz, b.dx, b.dy, b.dz, len, st, 1 + v * 0.25);
      let r = this.last.get(b);
      if (!r) { r = { live: false, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 0, len: 0, age: 0, style: st }; this.last.set(b, r); }
      r.x = hx; r.y = hy; r.z = hz; r.dx = b.dx; r.dy = b.dy; r.dz = b.dz; r.len = len;
      // Tiny cubic embers shed along the streak.
      if (Math.random() < st.emberChance) {
        const k = Math.random() * len;
        this.embers.emit(hx - b.dx * k, hy - b.dy * k, hz - b.dz * k, (Math.random() - 0.5) * 1.2, Math.random() * 1.2, (Math.random() - 0.5) * 1.2,
          0.022 + Math.random() * 0.018, 0.12 + Math.random() * 0.15, Math.random() < 0.5 ? 0xffa030 : 0xffe08a, 0.3, 6, 3);
      }
    }
    // Rounds that stopped since last frame: start their collapse.
    for (const [b, r] of this.last) {
      if (this.seen.has(b)) continue;
      this.last.delete(b);
      const slot = this.dying.find((x) => !x.live);
      if (slot) { Object.assign(slot, r); slot.live = true; slot.age = 0; }
    }
    for (const r of this.dying) {
      if (!r.live) continue;
      r.age += dt;
      if (r.age >= DIE_TIME) { r.live = false; continue; }
      if (n >= this.cap) continue;
      const k = 1 - r.age / DIE_TIME;
      this.draw(n++, r.x, r.y, r.z, r.dx, r.dy, r.dz, r.len * k, r.style, k);
    }
    for (const m of [this.streaks, this.heads]) {
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor!.needsUpdate = true;
    }
  }

  private draw(i: number, x: number, y: number, z: number, dx: number, dy: number, dz: number, len: number, st: TracerStyle, bright: number): void {
    q.setFromUnitVectors(FWD, d.set(dx, dy, dz));
    p.set(x, y, z);
    const w = st.streakWidth;
    this.streaks.setMatrixAt(i, m4.compose(p, q, s.set(w, w, Math.max(0.01, len))));
    this.streaks.setColorAt(i, col.setHex(st.tint).multiplyScalar(bright));
    const h = st.headSize * (0.9 + Math.random() * 0.2) * (0.5 + 0.5 * Math.min(1, bright));
    this.heads.setMatrixAt(i, m4.compose(p, q, s.set(h, h, h * 1.3)));
    this.heads.setColorAt(i, col.setHex(st.tint).multiplyScalar(bright));
  }
}

/**
 * Short-lived additive pieces in one InstancedMesh (ring-buffer pool): each pops to full size,
 * then shrinks and fades over its life. Used for voxel flash spikes (box) and glow orbs (orb).
 */
export class Bursts {
  private readonly mesh: THREE.InstancedMesh;
  private readonly cap: number;
  private readonly pos: Float32Array; private readonly rot: Float32Array; private readonly scl: Float32Array;
  private readonly life: Float32Array; private readonly max: Float32Array; private readonly rgb: Float32Array;
  private next = 0;

  constructor(scene: THREE.Scene, geo: THREE.BufferGeometry, vertexColors: boolean, capacity: number) {
    this.cap = capacity;
    this.mesh = instanced(geo, additive(vertexColors), capacity, scene);
    this.mesh.count = capacity;
    this.pos = new Float32Array(capacity * 3); this.rot = new Float32Array(capacity * 4); this.scl = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity); this.max = new Float32Array(capacity).fill(1); this.rgb = new Float32Array(capacity * 3);
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, m4.makeScale(0, 0, 0));
  }

  spawn(x: number, y: number, z: number, quat: THREE.Quaternion, sx: number, sy: number, sz: number, color: number, life: number, bright = 1): void {
    const i = this.next;
    this.next = (this.next + 1) % this.cap;
    const i3 = i * 3, i4 = i * 4;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.rot[i4] = quat.x; this.rot[i4 + 1] = quat.y; this.rot[i4 + 2] = quat.z; this.rot[i4 + 3] = quat.w;
    this.scl[i3] = sx; this.scl[i3 + 1] = sy; this.scl[i3 + 2] = sz;
    this.life[i] = this.max[i] = life;
    col.setHex(color).multiplyScalar(bright);
    this.rgb[i3] = col.r; this.rgb[i3 + 1] = col.g; this.rgb[i3 + 2] = col.b;
  }

  update(dt: number): void {
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const t = Math.max(0, this.life[i] / this.max[i]); // 1 → 0
      const k = t <= 0 ? 0 : 0.4 + 0.6 * t;
      const i3 = i * 3, i4 = i * 4;
      q.set(this.rot[i4], this.rot[i4 + 1], this.rot[i4 + 2], this.rot[i4 + 3]);
      this.mesh.setMatrixAt(i, m4.compose(p.set(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2]), q,
        s.set(this.scl[i3] * k, this.scl[i3 + 1] * k, this.scl[i3 + 2] * k)));
      const f = t; // linear fade: the flash lingers a few frames
      this.mesh.setColorAt(i, col.setRGB(this.rgb[i3] * f, this.rgb[i3 + 1] * f, this.rgb[i3 + 2] * f));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }
}

/**
 * Soft smoke: semi-transparent faceted puffs that swell, drift and shrink away. One InstancedMesh
 * (ring-buffer pool); lit like the scene so it picks up the muzzle light.
 */
export class Smoke {
  private readonly mesh: THREE.InstancedMesh;
  private readonly cap: number;
  private readonly pos: Float32Array; private readonly vel: Float32Array;
  private readonly size: Float32Array; private readonly life: Float32Array; private readonly max: Float32Array;
  private next = 0;

  constructor(scene: THREE.Scene, capacity = 48) {
    this.cap = capacity;
    this.mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0),
      new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, depthWrite: false }), capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.mesh.frustumCulled = false;
    this.mesh.count = capacity;
    scene.add(this.mesh);
    this.pos = new Float32Array(capacity * 3); this.vel = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity); this.life = new Float32Array(capacity); this.max = new Float32Array(capacity).fill(1);
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, m4.makeScale(0, 0, 0));
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number, color: number): void {
    const i = this.next;
    this.next = (this.next + 1) % this.cap;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.size[i] = size; this.life[i] = this.max[i] = life;
    this.mesh.setColorAt(i, col.setHex(color));
  }

  update(dt: number): void {
    const drag = Math.exp(-3 * dt);
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const i3 = i * 3, t = Math.max(0, this.life[i] / this.max[i]); // 1 → 0
      this.vel[i3] *= drag; this.vel[i3 + 2] *= drag; this.vel[i3 + 1] *= drag;
      this.pos[i3] += this.vel[i3] * dt; this.pos[i3 + 1] += (this.vel[i3 + 1] + 0.25) * dt; this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      // Swell quickly, then shrink away at the end of life.
      const sz = this.size[i] * (0.5 + 0.9 * (1 - t)) * Math.min(1, t / 0.35);
      q.setFromEuler(e.set(i, i * 1.7, 0));
      this.mesh.setMatrixAt(i, m4.compose(p.set(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2]), q, s.set(sz, sz * 0.8, sz)));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }
}

/** Muzzle flash + impact flash recipes (voxel spikes, glow orbs, cubic sparks). 4 draw calls total. */
export class WeaponVfx {
  private readonly spikes: Bursts;
  private readonly glows: Bursts;
  private readonly smoke: Smoke;
  readonly tracers: Tracers;

  constructor(scene: THREE.Scene, private readonly sparks: ParticleSystem) {
    this.smoke = new Smoke(scene);
    const orb = orbGeo();
    // Spikes grow forward from where they're placed (origin at the back face).
    this.spikes = new Bursts(scene, UNIT_BOX.clone().translate(0, 0, 0.5), false, 160);
    this.glows = new Bursts(scene, orb, true, 48);
    this.tracers = new Tracers(scene, orb, sparks);
  }

  /** Bright glow + chunky voxel star at the muzzle along (dx, dz), plus a forward cone of cubic sparks. */
  muzzleFlash(st: TracerStyle, x: number, y: number, z: number, dx: number, dz: number, power = 1): void {
    const yaw = Math.atan2(dx, dz), f = st.flashScale * power, b = this.spikes;
    // Light bloom: a big soft orb just ahead of the barrel.
    q.identity();
    const g = st.flashGlow * power;
    this.glows.spawn(x + dx * g * 0.3, y, z + dz * g * 0.3, q, g, g, g, 0xffffff, 0.09);
    // White-hot voxel core.
    for (let i = 0; i < 2; i++) {
      q.setFromEuler(e.set(Math.random() * 3, Math.random() * 3, Math.random() * 3));
      const c = (0.1 + Math.random() * 0.05) * f;
      b.spawn(x - dx * c * 0.5, y, z - dz * c * 0.5, q, c, c, c, i === 0 ? 0xfff6d8 : 0xffb040, 0.07, 1.2);
    }
    // Forward tongue of flame + hot inner spike.
    const roll = Math.random() * Math.PI;
    q.setFromEuler(e.set(0, yaw, roll, 'YXZ'));
    b.spawn(x, y, z, q, 0.07 * f, 0.07 * f, st.spikeLength * f * (0.85 + Math.random() * 0.3), 0xffa030, 0.07, 1.1);
    b.spawn(x, y, z, q, 0.03 * f, 0.03 * f, st.spikeLength * f * 0.75, 0xfffbe8, 0.06, 1.4);
    // Star points around the barrel (rolled around the aim axis, so it's a 3D star).
    for (let i = 0; i < st.sideSpikes; i++) {
      const a = roll + (i / st.sideSpikes) * Math.PI * 2;
      const off = 0.6 + Math.random() * 0.7; // angle off the barrel axis
      q.setFromEuler(e.set(Math.sin(a) * off, yaw + Math.cos(a) * off, 0, 'YXZ'));
      b.spawn(x, y, z, q, 0.045 * f, 0.045 * f, st.spikeLength * 0.5 * f * (0.6 + Math.random() * 0.7), i % 2 ? 0xffc060 : 0xff8a20, 0.06, 1);
    }
    // Directional blast (shotgun): flame tongues fanned across the spread, longest in the middle.
    for (let i = 0; i < st.fanSpikes; i++) {
      const u = st.fanSpikes > 1 ? (i / (st.fanSpikes - 1)) * 2 - 1 : 0;
      q.setFromEuler(e.set((Math.random() - 0.5) * 0.2, yaw + u * st.fanAngle, Math.random() * Math.PI, 'YXZ'));
      const len = st.spikeLength * f * (1 - 0.45 * Math.abs(u)) * (0.8 + Math.random() * 0.4);
      b.spawn(x, y, z, q, 0.05 * f, 0.05 * f, len, i % 2 ? 0xffb040 : 0xff8a20, 0.06, 0.9);
    }
    // Cubic sparks spraying forward.
    const sprayW = 0.8 + st.fanAngle * 2;
    for (let i = 0; i < st.flashSparks; i++) {
      const a = yaw + (Math.random() - 0.5) * sprayW, sp = 4 + Math.random() * 6;
      this.sparks.emit(x, y, z, Math.sin(a) * sp, (Math.random() - 0.3) * 2.5, Math.cos(a) * sp,
        0.025 + Math.random() * 0.02, 0.1 + Math.random() * 0.15, Math.random() < 0.5 ? 0xffd070 : 0xff8a2a, 0.3, 8, 4);
    }
    // Warm smoke puffs billowing around the muzzle, drifting forward and up.
    for (let i = 0; i < st.smokePuffs; i++) {
      const a = yaw + (Math.random() - 0.5) * 2.2, sp = 0.6 + Math.random() * 1.2;
      this.smoke.emit(x + dx * 0.25, y, z + dz * 0.25, Math.sin(a) * sp, 0.2 + Math.random() * 0.3, Math.cos(a) * sp,
        0.14 + Math.random() * 0.1, 0.6 + Math.random() * 0.4, Math.random() < 0.5 ? 0xb8ab98 : 0xcfc2ae);
    }
  }

  /** Glow + small 3D starburst where a round lands, oriented along the surface normal. */
  impactFlash(st: TracerStyle, x: number, y: number, z: number, nx: number, ny: number, nz: number, flesh: boolean): void {
    const f = st.impactScale;
    q.identity();
    this.glows.spawn(x + nx * 0.05, y + ny * 0.05, z + nz * 0.05, q, 0.3 * f, 0.3 * f, 0.3 * f, flesh ? 0xffa080 : 0xffffff, 0.1);
    for (let i = 0; i < st.impactSpikes; i++) {
      // Random direction in the hemisphere around the normal.
      d.set(nx + (Math.random() - 0.5) * 1.8, ny + (Math.random() - 0.5) * 1.8, nz + (Math.random() - 0.5) * 1.8).normalize();
      q.setFromUnitVectors(FWD, d);
      this.spikes.spawn(x, y, z, q, 0.04 * f, 0.04 * f, (0.2 + Math.random() * 0.3) * f, flesh ? (i % 2 ? 0xff4020 : 0xffa040) : (i % 2 ? 0xffb347 : 0xfff0c0), 0.09, 1.1);
    }
    // Cubic sparks bursting out of the hit.
    for (let i = 0; i < st.impactSparks; i++) {
      const sp = 2 + Math.random() * 4;
      this.sparks.emit(x, y, z, (nx + (Math.random() - 0.5) * 1.6) * sp, Math.random() * 3, (nz + (Math.random() - 0.5) * 1.6) * sp,
        0.03 + Math.random() * 0.02, 0.15 + Math.random() * 0.2, Math.random() < 0.5 ? 0xffc050 : 0xff7a20, 0.3, 10, 2);
    }
  }

  update(list: readonly TracerBullet[], alpha: number, dt: number): void {
    this.tracers.update(list, alpha, dt);
    this.spikes.update(dt);
    this.glows.update(dt);
    this.smoke.update(dt);
  }
}
