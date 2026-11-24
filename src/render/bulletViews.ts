import * as THREE from 'three';
import type { TracerStyle } from './weaponVfx';

/** What the renderer needs from a flying bullet (sim data, interpolated per frame). */
export interface BulletVisual {
  x: number; y: number; z: number; px: number; py: number; pz: number;
  /** Where it was fired from (the shooter's centre; the visual starts at the muzzle, ahead of it). */
  ox: number; oy: number; oz: number;
  dx: number; dy: number; dz: number;
  travelled: number;
  width: number; // trace thickness (m)
  length: number; // trail length (m)
  /** Premium VFX style (drawn by weaponVfx.Tracers instead of here). */
  style?: TracerStyle;
  /** 0..1 per-bullet random seed for visual variation. */
  seed?: number;
}

/** Distance from the shooter's centre to the gun muzzle: nothing is drawn behind it. */
const MUZZLE_DIST = 0.6;
const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
const fwd = new THREE.Vector3(0, 0, 1), dir = new THREE.Vector3();

/**
 * Fallback bullet visuals for weapons without a TracerStyle (styled bullets are skipped here):
 * one solid bright streak per bullet, a single InstancedMesh (1 draw call).
 * Purely cosmetic: positions come from the simulation, which does all hit detection itself.
 */
export class BulletViews {
  private readonly core: THREE.InstancedMesh;

  constructor(scene: THREE.Scene, capacity = 160) {
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, -0.5); // extends backwards from the head
    this.core = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0xffe27a, toneMapped: false }), capacity);
    this.core.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.core.frustumCulled = false;
    this.core.count = 0;
    scene.add(this.core);
  }

  update(list: readonly BulletVisual[], alpha: number): void {
    let n = 0;
    for (const b of list) {
      if (b.style) continue; // drawn by weaponVfx
      if (n >= this.core.instanceMatrix.count) break;
      p.set(b.px + (b.x - b.px) * alpha, b.py + (b.y - b.py) * alpha, b.pz + (b.z - b.pz) * alpha);
      // Trail is clipped at the muzzle so the bullet never appears behind/inside the shooter.
      const fromOrigin = Math.hypot(p.x - b.ox, p.y - b.oy, p.z - b.oz);
      const len = Math.min(b.length, fromOrigin - MUZZLE_DIST);
      if (len <= 0.02) continue;
      q.setFromUnitVectors(fwd, dir.set(b.dx, b.dy, b.dz));
      const w = b.width;
      this.core.setMatrixAt(n, m4.compose(p, q, s.set(w, w, len)));
      n++;
    }
    this.core.count = n;
    this.core.instanceMatrix.needsUpdate = true;
  }
}
