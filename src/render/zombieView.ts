import * as THREE from 'three';
import { HUMANOID, type PartName } from '../rigs/humanoid';
import type { Zombie } from '../entities/zombie';
import { box, UNIT_BOX } from './voxel';

const SKIN = 0x7d9a6a, SHIRT = 0x5b4a3c, PANTS = 0x3b4250, GORE = 0x7a0f12, GORE_DARK = 0x4a0608, BONE = 0xe8e0c8;
const BRUISE = new THREE.Color(0x3a1410);
const POOL_GEO = new THREE.CircleGeometry(0.5, 10).rotateX(-Math.PI / 2);

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
  /** Per-part body material, darkened as the part takes damage. */
  private readonly mats: THREE.MeshLambertMaterial[] = [];
  private readonly baseColors: THREE.Color[] = [];
  private woundsShown = 0;
  private pool: THREE.Mesh | null = null;
  private poolSize = 0;

  constructor(private readonly scene: THREE.Scene, readonly zombie: Zombie) {
    for (const def of HUMANOID) {
      const g = new THREE.Group();
      const mat = new THREE.MeshLambertMaterial({ color: partColor(def.name) });
      const main = new THREE.Mesh(UNIT_BOX, mat);
      main.scale.set(...def.size);
      main.castShadow = main.receiveShadow = true;
      g.add(main);
      this.mats.push(mat);
      this.baseColors.push(mat.color.clone());
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
      const cx = -d.center[0], cy = -d.center[1], cz = -d.center[2];
      const px = d.joint[0] - parent.center[0], py = d.joint[1] - parent.center[1], pz = d.joint[2] - parent.center[2];
      // Red flesh cap with a white bone poking out, on both sides of the wound.
      this.groups[p.index].add(box(w, 0.05, w, GORE, cx, cy, cz));
      this.groups[p.index].add(box(w * 0.35, 0.09, w * 0.35, BONE, cx, cy + 0.02, cz));
      this.groups[p.parent].add(box(w, 0.05, w, GORE, px, py, pz));
      this.groups[p.parent].add(box(w * 0.35, 0.09, w * 0.35, BONE, px, py - 0.02, pz));
    }
  }

  /** Dark wound marks where bullets went in. */
  private addWounds(): void {
    const ws = this.zombie.wounds;
    for (; this.woundsShown < ws.length; this.woundsShown++) {
      const w = ws[this.woundsShown];
      const s = 0.05 + Math.random() * 0.03;
      this.groups[w.part].add(box(s, s, s, Math.random() < 0.5 ? GORE : GORE_DARK, w.local.x, w.local.y, w.local.z));
    }
  }

  /** Limbs darken toward a bruised red as they lose health (a hint they're about to come off). */
  private updateDamageTint(): void {
    const z = this.zombie;
    z.parts.forEach((p, i) => {
      const frac = p.maxHp === Infinity ? 1 - Math.max(0, z.hp) / 100 : 1 - Math.max(0, p.hp) / p.maxHp;
      this.mats[i].color.copy(this.baseColors[i]).lerp(BRUISE, Math.min(0.75, frac * 0.75));
    });
  }

  /** A blood pool spreads under a corpse once it has settled. */
  private updatePool(scene: THREE.Scene, dt: number): void {
    const z = this.zombie;
    if (z.alive || (!z.frozen && z.restTime < 0.3)) return;
    if (!this.pool) {
      const t = z.parts[1].body.translation();
      this.pool = new THREE.Mesh(POOL_GEO, new THREE.MeshBasicMaterial({ color: 0x4a0608, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
      this.pool.position.set(t.x, 0.008, t.z);
      this.pool.scale.setScalar(0.01);
      scene.add(this.pool);
    }
    this.poolSize = Math.min(1.6, this.poolSize + dt * 0.25);
    this.pool.scale.set(this.poolSize, 1, this.poolSize * 0.8);
  }

  update(dt = 1 / 60): void {
    this.addStumps();
    this.addWounds();
    this.updateDamageTint();
    this.updatePool(this.scene, dt);
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
    if (this.pool) (this.pool.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.85 - this.sink);
    if (this.sink > 1.2) { this.dispose(); return true; }
    return false;
  }

  dispose(): void {
    for (const g of this.groups) this.scene.remove(g);
    if (this.pool) this.scene.remove(this.pool);
    for (const m of this.mats) m.dispose();
  }
}
