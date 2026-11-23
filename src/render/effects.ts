import * as THREE from 'three';
import { UNIT_BOX } from './voxel';

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();
const tmpC = new THREE.Color();
const tmpE = new THREE.Euler();

/**
 * Pooled voxel particles in a single InstancedMesh (1 draw call). Simple ballistic motion
 * with ground bounce — purely cosmetic, never touches the physics engine.
 */
export class ParticleSystem {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;
  private readonly pos: Float32Array; private readonly vel: Float32Array;
  private readonly rot: Float32Array; private readonly spin: Float32Array;
  private readonly life: Float32Array; private readonly maxLife: Float32Array;
  private readonly size: Float32Array; private readonly bounce: Float32Array;
  private readonly drag: Float32Array; private readonly grav: Float32Array;
  private next = 0;

  constructor(readonly capacity: number, opts: { emissive?: boolean; shadows?: boolean } = {}) {
    const mat = opts.emissive
      ? new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })
      : new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(UNIT_BOX, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = !!opts.shadows;
    this.mesh.count = 0;
    this.pos = new Float32Array(capacity * 3); this.vel = new Float32Array(capacity * 3);
    this.rot = new Float32Array(capacity * 3); this.spin = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity); this.maxLife = new Float32Array(capacity);
    this.size = new Float32Array(capacity); this.bounce = new Float32Array(capacity);
    this.drag = new Float32Array(capacity); this.grav = new Float32Array(capacity);
  }

  get active(): number { return this.n; }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number,
    color: number, bounce = 0.35, gravity = 14, drag = 1.5, spin = 12): void {
    let i: number;
    if (this.n < this.capacity) i = this.n++;
    else { i = this.next; this.next = (this.next + 1) % this.capacity; } // recycle oldest-ish
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.rot[i3] = Math.random() * 6; this.rot[i3 + 1] = Math.random() * 6; this.rot[i3 + 2] = 0;
    this.spin[i3] = (Math.random() - 0.5) * spin; this.spin[i3 + 1] = (Math.random() - 0.5) * spin; this.spin[i3 + 2] = (Math.random() - 0.5) * spin;
    this.life[i] = this.maxLife[i] = life;
    this.size[i] = size; this.bounce[i] = bounce; this.grav[i] = gravity; this.drag[i] = drag;
    this.mesh.setColorAt(i, tmpC.setHex(color));
    this.mesh.instanceColor!.needsUpdate = true;
  }

  update(dt: number): void {
    let i = 0;
    while (i < this.n) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.swapRemove(i); continue; }
      const i3 = i * 3;
      const dr = Math.exp(-this.drag[i] * dt);
      this.vel[i3] *= dr; this.vel[i3 + 2] *= dr;
      this.vel[i3 + 1] -= this.grav[i] * dt;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      const half = this.size[i] * 0.5;
      if (this.pos[i3 + 1] < half) {
        this.pos[i3 + 1] = half;
        if (this.vel[i3 + 1] < 0) {
          this.vel[i3 + 1] *= -this.bounce[i];
          this.vel[i3] *= 0.6; this.vel[i3 + 2] *= 0.6;
          for (let k = 0; k < 3; k++) this.spin[i3 + k] *= 0.5;
        }
      }
      for (let k = 0; k < 3; k++) this.rot[i3 + k] += this.spin[i3 + k] * dt;
      // Shrink out over the last 30% of life.
      const t = this.life[i] / this.maxLife[i];
      const s = this.size[i] * Math.min(1, t / 0.3);
      tmpQ.setFromEuler(tmpE.set(this.rot[i3], this.rot[i3 + 1], this.rot[i3 + 2]));
      tmpM.compose(tmpP.set(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2]), tmpQ, tmpS.set(s, s, s));
      this.mesh.setMatrixAt(i, tmpM);
      i++;
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  private swapRemove(i: number): void {
    const last = --this.n;
    if (i === last) return;
    const i3 = i * 3, l3 = last * 3;
    for (const arr of [this.pos, this.vel, this.rot, this.spin]) { arr[i3] = arr[l3]; arr[i3 + 1] = arr[l3 + 1]; arr[i3 + 2] = arr[l3 + 2]; }
    for (const arr of [this.life, this.maxLife, this.size, this.bounce, this.drag, this.grav]) arr[i] = arr[last];
    this.mesh.getColorAt(last, tmpC);
    this.mesh.setColorAt(i, tmpC);
  }
}

/** Short-lived bright bullet streaks. */
export class Tracers {
  private readonly pool: { mesh: THREE.Mesh; life: number }[] = [];
  private readonly mat = new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, toneMapped: false, depthWrite: false, blending: THREE.AdditiveBlending });

  constructor(scene: THREE.Scene, count = 12) {
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(UNIT_BOX, this.mat.clone());
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.pool.push({ mesh, life: 0 });
    }
  }

  spawn(a: THREE.Vector3, b: THREE.Vector3): void {
    const t = this.pool.reduce((m, p) => (p.life < m.life ? p : m));
    const len = a.distanceTo(b);
    t.mesh.position.copy(a).add(b).multiplyScalar(0.5);
    t.mesh.lookAt(b);
    t.mesh.scale.set(0.035, 0.035, len);
    t.mesh.visible = true;
    t.life = 0.07;
  }

  update(dt: number): void {
    for (const t of this.pool) {
      if (t.life <= 0) continue;
      t.life -= dt;
      (t.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, t.life / 0.07);
      if (t.life <= 0) t.mesh.visible = false;
    }
  }
}

/** A single reusable point light + voxel flash at the muzzle (always in scene: no shader recompiles). */
export class MuzzleFlash {
  readonly light = new THREE.PointLight(0xffb45a, 0, 9, 1.6);
  private readonly flash: THREE.Mesh;
  private life = 0;
  private peak = 30;

  constructor(scene: THREE.Scene) {
    this.flash = new THREE.Mesh(UNIT_BOX, new THREE.MeshBasicMaterial({ color: 0xffd27a, toneMapped: false }));
    this.flash.visible = false;
    scene.add(this.light, this.flash);
  }

  fire(p: THREE.Vector3, yaw: number, power = 1): void {
    this.light.position.copy(p);
    this.flash.position.copy(p);
    this.flash.rotation.set(Math.random() * 0.5, yaw, Math.random() * Math.PI);
    const s = (0.16 + Math.random() * 0.08) * power;
    this.flash.scale.set(s, s, s * 2.2);
    this.flash.visible = true;
    this.life = 0.05;
    this.light.intensity = 30 * power;
    this.peak = 30 * power;
  }

  update(dt: number): void {
    if (this.life <= 0) return;
    this.life -= dt;
    this.light.intensity = Math.max(0, (this.life / 0.05) * this.peak);
    if (this.life <= 0) { this.flash.visible = false; this.light.intensity = 0; }
  }
}
