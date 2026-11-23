import * as THREE from 'three';
import { HUMANOID, type PartName } from '../rigs/humanoid';
import { box, PAL } from './voxel';

export interface RigLook {
  skin: number; hair: number; shirt: number; vest: number; pants: number; boots: number;
}

export const SURVIVOR_LOOK: RigLook = {
  skin: PAL.skin, hair: PAL.hair, shirt: PAL.shirt, vest: PAL.vest, pants: PAL.pants, boots: PAL.boots,
};

/** Visual voxel rig: a group per part placed at its joint so rotations bend at the joint. */
export class HumanoidRig {
  readonly root = new THREE.Group();
  readonly parts = {} as Record<PartName, THREE.Group>;
  readonly muzzle = new THREE.Object3D();

  constructor(look: RigLook) {
    for (const def of HUMANOID) {
      const g = new THREE.Group();
      g.name = def.name;
      g.position.set(...def.joint);
      g.rotation.order = 'YXZ';
      const color = partColor(def.name, look);
      g.add(box(def.size[0], def.size[1], def.size[2], color, ...def.center));
      (def.parent ? this.parts[def.parent] : this.root).add(g);
      this.parts[def.name] = g;
    }
    this.decorate(look);
  }

  private decorate(look: RigLook): void {
    const p = this.parts;
    // Head: hair cap, fringe, eyes.
    p.head.add(box(0.32, 0.08, 0.32, look.hair, 0, 0.32, 0));
    p.head.add(box(0.32, 0.12, 0.06, look.hair, 0, 0.24, -0.14));
    p.head.add(box(0.05, 0.05, 0.02, 0x1a1a1a, 0.07, 0.18, 0.155));
    p.head.add(box(0.05, 0.05, 0.02, 0x1a1a1a, -0.07, 0.18, 0.155));
    // Torso: tactical vest + backpack.
    p.torso.add(box(0.44, 0.3, 0.26, look.vest, 0, 0.26, 0));
    p.torso.add(box(0.3, 0.34, 0.14, 0x5a4632, 0, 0.24, -0.19));
    // Hands (skin) and boots.
    for (const s of ['L', 'R'] as const) {
      p[`forearm${s}`].add(box(0.1, 0.08, 0.1, look.skin, 0, -0.3, 0));
      p[`shin${s}`].add(box(0.16, 0.1, 0.24, look.boots, 0, -0.33, 0.04));
    }
    // Guns in the right hand: barrels run along the forearm's -Y (forward when aiming).
    const gun = (parts: [number, number, number, number, number, number, number][], muzzleY: number) => {
      const g = new THREE.Group();
      g.position.set(0, -0.32, 0);
      for (const [w, h, d, c, x, y, z] of parts) g.add(box(w, h, d, c, x, y, z));
      p.forearmR.add(g);
      return { g, muzzleY };
    };
    this.guns = {
      pistol: gun([[0.07, 0.26, 0.1, PAL.gun, 0, -0.1, 0.02], [0.06, 0.08, 0.14, PAL.gunAccent, 0, 0.0, -0.06]], -0.24),
      smg: gun([[0.07, 0.4, 0.11, PAL.gun, 0, -0.16, 0.02], [0.06, 0.1, 0.16, PAL.gunAccent, 0, 0.0, -0.07], [0.05, 0.08, 0.2, PAL.gun, 0, -0.12, -0.1]], -0.37),
      shotgun: gun([[0.08, 0.62, 0.09, PAL.gun, 0, -0.26, 0.03], [0.07, 0.2, 0.08, 0x6e4a27, 0, 0.05, -0.02], [0.09, 0.14, 0.11, 0x5a3c22, 0, -0.32, -0.05]], -0.58),
    };
    this.pumpGrip = this.guns.shotgun.g.children[2];
    this.setWeapon('pistol');
  }

  private guns!: Record<string, { g: THREE.Group; muzzleY: number }>;
  private pumpGrip!: THREE.Object3D;
  private weaponId = '';

  /** Show the right gun model and move the muzzle point to its barrel end. */
  setWeapon(id: string): void {
    if (id === this.weaponId || !this.guns[id]) return;
    this.weaponId = id;
    for (const [k, v] of Object.entries(this.guns)) v.g.visible = k === id;
    const gun = this.guns[id];
    gun.g.add(this.muzzle);
    this.muzzle.position.set(0, gun.muzzleY, 0.02);
  }

  /**
   * Procedural animation. `phase` advances with distance walked; `move` is 0..1 speed;
   * `strafe` is the movement direction relative to facing (radians); `recoil` 0..1 kick.
   */
  pose(phase: number, move: number, strafe: number, recoil: number, time: number, reload = 0, pump = 0): void {
    const p = this.parts;
    const swing = Math.sin(phase) * 0.75 * move;
    // Legs swing along the movement direction relative to the body.
    const fwd = Math.cos(strafe), side = Math.sin(strafe);
    p.thighL.rotation.set(-swing * fwd, 0, swing * side * 0.5);
    p.thighR.rotation.set(swing * fwd, 0, -swing * side * 0.5);
    p.shinL.rotation.x = Math.max(0, Math.sin(phase + 1.2)) * 0.9 * move;
    p.shinR.rotation.x = Math.max(0, Math.sin(phase + Math.PI + 1.2)) * 0.9 * move;
    // Bob + breathe.
    const bob = Math.abs(Math.cos(phase)) * 0.05 * move;
    p.pelvis.position.y = 0.82 - 0.03 * move + bob;
    // Recoil rocks the whole upper body back, not just the arms.
    p.torso.rotation.set(0.08 * move + Math.sin(time * 2) * 0.015 - recoil * 0.12, 0, recoil * 0.03);
    p.head.rotation.set(-0.08 * move, 0, 0);
    // Two-handed aim: arms forward, converging on the gun.
    const kick = recoil * 0.5;
    // Reload: gun tilts in toward the chest, support hand drops to the belt and comes back with a mag.
    const r = Math.sin(Math.min(1, reload) * Math.PI); // 0 → 1 → 0 over the reload
    const dip = reload > 0 ? Math.sin(Math.min(1, reload) * Math.PI * 2) : 0;
    p.upperArmR.rotation.set(-Math.PI / 2 + 0.22 - kick + r * 0.55, 0.42 + r * 0.35, 0);
    p.forearmR.rotation.set(-kick * 0.6 - r * 0.5, 0, r * 0.5);
    p.upperArmL.rotation.set(-Math.PI / 2 + 0.37 - kick * 0.6 + r * (1.0 + dip * 0.6), -0.75 + r * 0.5, 0);
    p.forearmL.rotation.set(-0.35 - r * 0.8 + pump * 0.45, 0, 0); // pump: support hand racks back
    if (this.pumpGrip) this.pumpGrip.position.y = -0.32 + pump * 0.12;
    p.torso.position.z = -kick * 0.09;
    p.head.rotation.x += r * 0.35; // glance down at the gun
  }
}

function partColor(name: PartName, l: RigLook): number {
  if (name === 'head') return l.skin;
  if (name.startsWith('upperArm')) return l.shirt;
  if (name.startsWith('forearm')) return l.shirt;
  if (name === 'torso') return l.shirt;
  return l.pants;
}
