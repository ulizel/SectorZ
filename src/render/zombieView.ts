import * as THREE from 'three';
import { HUMANOID, type PartName } from '../rigs/humanoid';
import type { Zombie } from '../entities/zombie';
import { box } from './voxel';

const SKIN = 0x7d9a6a, SHIRT = 0x5b4a3c, PANTS = 0x3b4250, GORE = 0x7a0f12, GORE_DARK = 0x4a0608;

function partColor(n: PartName): number {
  if (n === 'head' || n.startsWith('forearm')) return SKIN;
  if (n === 'torso' || n.startsWith('upperArm')) return SHIRT;
  return PANTS;
}

/**
 * Voxel visuals for one zombie: one mesh group per part, each copying its physics body
 * (so living animation, ragdoll and flying limbs all render the same way).
 */
export class ZombieView {
  readonly groups: THREE.Group[] = [];
  private sink = 0; // >0 while sinking into the ground after removal
  private stumped = new Set<number>();

  constructor(private readonly scene: THREE.Scene, readonly zombie: Zombie) {
    for (const def of HUMANOID) {
      const g = new THREE.Group();
      g.add(box(def.size[0], def.size[1], def.size[2], partColor(def.name)));
      const c = def.center;
      const at = (x: number, y: number, z: number) => [x - c[0], y - c[1], z - c[2]] as const;
      if (def.name === 'head') {
        g.add(box(0.06, 0.05, 0.02, 0xffe066, ...at(0.07, 0.18, 0.155), 0xffcc33)); // glowing eyes
        g.add(box(0.06, 0.05, 0.02, 0xffe066, ...at(-0.07, 0.18, 0.155), 0xffcc33));
        g.add(box(0.14, 0.04, 0.02, 0x2a1414, ...at(0, 0.07, 0.155))); // mouth
        g.add(box(0.31, 0.06, 0.31, 0x3a3a2a, ...at(0, 0.31, -0.02))); // patchy hair
        g.add(box(0.08, 0.08, 0.02, GORE, ...at(0.09, 0.26, 0.152))); // wound
      }
      if (def.name === 'torso') {
        g.add(box(0.2, 0.12, 0.02, GORE_DARK, ...at(0.06, 0.18, 0.125))); // torn shirt stain
        g.add(box(0.12, 0.1, 0.02, SKIN, ...at(-0.1, 0.32, 0.125))); // exposed skin
      }
      if (def.name.startsWith('forearm')) g.add(box(0.1, 0.08, 0.1, SKIN, ...at(0, -0.3, 0)));
      if (def.name.startsWith('shin')) g.add(box(0.15, 0.08, 0.2, 0x2a2320, ...at(0, -0.34, 0.02)));
      scene.add(g);
      this.groups.push(g);
    }
  }

  /** Red voxel caps on both sides of every torn joint. */
  private addStumps(): void {
    for (const p of this.zombie.parts) {
      if (!p.severed || this.stumped.has(p.index)) continue;
      this.stumped.add(p.index);
      const d = p.def, parent = this.zombie.parts[p.parent].def;
      const w = Math.min(d.size[0], d.size[2]) * 0.9;
      this.groups[p.index].add(box(w, 0.05, w, GORE, -d.center[0], -d.center[1], -d.center[2]));
      this.groups[p.parent].add(box(w, 0.05, w, GORE, d.joint[0] - parent.center[0], d.joint[1] - parent.center[1], d.joint[2] - parent.center[2]));
    }
  }

  update(): void {
    this.addStumps();
    this.zombie.parts.forEach((p, i) => {
      const t = p.body.translation(), r = p.body.rotation();
      this.groups[i].position.set(t.x, t.y, t.z);
      this.groups[i].quaternion.set(r.x, r.y, r.z, r.w);
    });
  }

  /** Begin sinking (the physics bodies are already gone). Returns true when fully gone. */
  sinkStep(dt: number): boolean {
    this.sink += dt;
    for (const g of this.groups) g.position.y -= dt * 0.6;
    if (this.sink > 1.2) { this.dispose(); return true; }
    return false;
  }

  dispose(): void { for (const g of this.groups) this.scene.remove(g); }
}
