import type * as THREE from 'three';

export interface DebugStats {
  physicsMs: number; bodies: number; colliders: number; particles: number; quality: string; ragdolls: number; zombies: number;
}

/** Performance overlay: toggled with the FPS button, the ` key, or ?debug=1. */
export class DebugOverlay {
  private readonly el = document.getElementById('debug')!;
  private frames = 0;
  private acc = 0;
  private worst = 0;
  private physAcc = 0;
  private physN = 0;
  visible: boolean;
  /** Last measured values (also exposed to automated tests). */
  fps = 0;
  avgPhysicsMs = 0;

  constructor() {
    this.visible = new URLSearchParams(location.search).has('debug');
    document.getElementById('fps-toggle')!.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.toggle(); });
    addEventListener('keydown', (e) => { if (e.code === 'Backquote') this.toggle(); });
    this.el.style.display = this.visible ? 'block' : 'none';
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? 'block' : 'none';
  }

  update(frameDt: number, renderer: THREE.WebGLRenderer, s: DebugStats): void {
    this.frames++;
    this.acc += frameDt;
    this.worst = Math.max(this.worst, frameDt);
    this.physAcc += s.physicsMs;
    this.physN++;
    if (this.acc < 0.5) return;
    this.fps = this.frames / this.acc;
    this.avgPhysicsMs = this.physAcc / this.physN;
    if (this.visible) {
      const info = renderer.info;
      this.el.textContent =
        `FPS ${this.fps.toFixed(0)}  worst ${(this.worst * 1000).toFixed(1)}ms\n` +
        `physics ${this.avgPhysicsMs.toFixed(2)}ms  bodies ${s.bodies}  colliders ${s.colliders}\n` +
        `draws ${info.render.calls}  tris ${info.render.triangles}  particles ${s.particles}\n` +
        `zombies ${s.zombies}  ragdolls ${s.ragdolls}\n` +
        `quality ${s.quality}  dpr ${renderer.getPixelRatio().toFixed(2)}  ${innerWidth}x${innerHeight}`;
    }
    this.frames = 0; this.acc = 0; this.worst = 0; this.physAcc = 0; this.physN = 0;
  }
}
