import * as THREE from 'three';

/** What the renderer needs from a flying bullet (sim data, interpolated per frame). */
export interface BulletVisual {
  x: number; y: number; z: number; px: number; py: number; pz: number;
  /** Where it was fired from (the shooter's centre; the visual starts at the muzzle, ahead of it). */
  ox: number; oy: number; oz: number;
  dx: number; dy: number; dz: number;
  travelled: number;
  width: number; // trace thickness (m)
  length: number; // trail length (m)
  /** Bold trace (shotgun): hot glow around the streak + a lingering smoke trail. */
  bold?: boolean;
}

/** Distance from the shooter's centre to the gun muzzle: nothing is drawn behind it. */
const MUZZLE_DIST = 0.6;
/** How long a bold bullet's smoke trail lingers after the pellet stops (s). */
const TRAIL_LIFE = 0.32;
const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
const fwd = new THREE.Vector3(0, 0, 1), dir = new THREE.Vector3(), col = new THREE.Color();
const TRAIL_COLOR = new THREE.Color(0xb8ad98);

interface Trail {
  ref: BulletVisual | null; // the live bullet, or null once it has stopped (fading)
  sx: number; sy: number; sz: number; // start (muzzle)
  ex: number; ey: number; ez: number; // end (pellet head)
  w: number;
  age: number;
}

/**
 * Bullet visuals, all instanced (3 draw calls): a solid bright streak per bullet, a wide additive
 * glow around bold ones, and fading smoke trails (additive, faded via instance colour) behind them.
 * Purely cosmetic: positions come from the simulation, which does all hit detection itself.
 */
export class BulletViews {
  private readonly core: THREE.InstancedMesh;
  private readonly glow: THREE.InstancedMesh;
  private readonly trails: THREE.InstancedMesh;
  private readonly live: Trail[] = [];
  private readonly byBullet = new Map<BulletVisual, Trail>();
  private readonly seen = new Set<BulletVisual>();

  constructor(scene: THREE.Scene, capacity = 160) {
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, -0.5); // extends backwards from the head
    const make = (mat: THREE.Material, n: number) => {
      const m = new THREE.InstancedMesh(geo, mat, n);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
      scene.add(m);
      return m;
    };
    this.core = make(new THREE.MeshBasicMaterial({ color: 0xffe27a, toneMapped: false }), capacity);
    this.glow = make(new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), 48);
    this.trails = make(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), 64);
    this.trails.setColorAt(0, col.set(0)); // allocates the instance colour buffer
  }

  update(list: readonly BulletVisual[], alpha: number, dt: number): void {
    let n = 0, g = 0;
    this.seen.clear();
    for (const b of list) {
      if (n >= this.core.instanceMatrix.count) break;
      p.set(b.px + (b.x - b.px) * alpha, b.py + (b.y - b.py) * alpha, b.pz + (b.z - b.pz) * alpha);
      // Trail is clipped at the muzzle so the bullet never appears behind/inside the shooter.
      const fromOrigin = Math.hypot(p.x - b.ox, p.y - b.oy, p.z - b.oz);
      const len = Math.min(b.length, fromOrigin - MUZZLE_DIST);
      if (b.bold) this.trackTrail(b);
      if (len <= 0.02) continue;
      q.setFromUnitVectors(fwd, dir.set(b.dx, b.dy, b.dz));
      const w = b.width;
      this.core.setMatrixAt(n++, m4.compose(p, q, s.set(w, w, len)));
      if (b.bold && g < this.glow.instanceMatrix.count) this.glow.setMatrixAt(g++, m4.compose(p, q, s.set(w * 3.2, w * 3.2, len * 1.25)));
    }
    this.core.count = n;
    this.glow.count = g;
    this.core.instanceMatrix.needsUpdate = this.glow.instanceMatrix.needsUpdate = true;
    this.updateTrails(dt);
  }

  /** Smoke trail from the muzzle to the pellet; it keeps up with the pellet while it flies. */
  private trackTrail(b: BulletVisual): void {
    this.seen.add(b);
    let t = this.byBullet.get(b);
    if (!t) {
      if (this.live.length >= this.trails.instanceMatrix.count) return;
      const l = Math.hypot(b.dx, b.dz) || 1;
      t = { ref: b, sx: b.ox + (b.dx / l) * MUZZLE_DIST, sy: b.oy, sz: b.oz + (b.dz / l) * MUZZLE_DIST, ex: 0, ey: 0, ez: 0, w: b.width, age: 0 };
      this.live.push(t);
      this.byBullet.set(b, t);
    }
    t.ex = p.x; t.ey = p.y; t.ez = p.z;
  }

  private updateTrails(dt: number): void {
    let n = 0;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const t = this.live[i];
      if (t.ref && !this.seen.has(t.ref)) { this.byBullet.delete(t.ref); t.ref = null; } // pellet stopped: fade out
      if (!t.ref) t.age += dt;
      if (t.age >= TRAIL_LIFE) { this.live.splice(i, 1); continue; }
      const dx = t.ex - t.sx, dy = t.ey - t.sy, dz = t.ez - t.sz, len = Math.hypot(dx, dy, dz);
      if (len < 0.05) continue;
      const k = t.age / TRAIL_LIFE;
      // Smoke spreads out (wider) as it fades.
      const w = t.w * (0.9 + k * 2.2);
      q.setFromUnitVectors(fwd, dir.set(dx / len, dy / len, dz / len));
      this.trails.setMatrixAt(n, m4.compose(p.set(t.ex, t.ey, t.ez), q, s.set(w, w * 0.5, len)));
      this.trails.setColorAt(n, col.copy(TRAIL_COLOR).multiplyScalar(0.55 * (1 - k) * (1 - k)));
      n++;
    }
    this.trails.count = n;
    this.trails.instanceMatrix.needsUpdate = true;
    if (this.trails.instanceColor) this.trails.instanceColor.needsUpdate = true;
  }
}
