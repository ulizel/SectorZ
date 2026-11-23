import * as THREE from 'three';

/** What the renderer needs from a flying bullet (sim data, interpolated per frame). */
export interface BulletVisual {
  x: number; y: number; z: number; px: number; py: number; pz: number;
  dx: number; dy: number; dz: number;
  travelled: number;
  heavy: boolean; // pistol = thicker/warmer, SMG = thinner
}

const TRAIL = 0.9; // m of glowing trail behind the head
const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
const fwd = new THREE.Vector3(0, 0, 1), dir = new THREE.Vector3();

/**
 * Bullet visuals: a bright core streak plus a soft wider glow, two InstancedMeshes for every
 * bullet in flight (2 draw calls total). Purely cosmetic: positions come from the simulation,
 * which does all hit detection on its own.
 */
export class BulletViews {
  private readonly core: THREE.InstancedMesh;
  private readonly glow: THREE.InstancedMesh;

  constructor(scene: THREE.Scene, capacity = 64) {
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, -0.5); // extends backwards from the head
    const mk = (color: number, opacity: number) => {
      const m = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({
        color, transparent: true, opacity, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending }), capacity);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
      scene.add(m);
      return m;
    };
    this.glow = mk(0xff9a3c, 0.35);
    this.core = mk(0xfff4c2, 1);
  }

  update(list: readonly BulletVisual[], alpha: number): void {
    let n = 0;
    for (const b of list) {
      if (n >= this.core.instanceMatrix.count) break;
      p.set(b.px + (b.x - b.px) * alpha, b.py + (b.y - b.py) * alpha, b.pz + (b.z - b.pz) * alpha);
      q.setFromUnitVectors(fwd, dir.set(b.dx, b.dy, b.dz));
      const len = Math.min(TRAIL * (b.heavy ? 1 : 0.8), b.travelled + 0.05);
      const w = b.heavy ? 0.045 : 0.032;
      this.core.setMatrixAt(n, m4.compose(p, q, s.set(w, w, len)));
      this.glow.setMatrixAt(n, m4.compose(p, q, s.set(w * 3.2, w * 3.2, len * 1.15)));
      n++;
    }
    for (const m of [this.core, this.glow]) { m.count = n; m.instanceMatrix.needsUpdate = true; }
  }
}
