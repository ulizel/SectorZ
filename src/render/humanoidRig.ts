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
    // Pistol in the right hand: barrel runs along the forearm's -Y (forward when aiming).
    const gun = new THREE.Group();
    gun.position.set(0, -0.32, 0);
    gun.add(box(0.07, 0.26, 0.1, PAL.gun, 0, -0.1, 0.02));
    gun.add(box(0.06, 0.08, 0.14, PAL.gunAccent, 0, 0.0, -0.06));
    this.muzzle.position.set(0, -0.24, 0.02);
    gun.add(this.muzzle);
    p.forearmR.add(gun);
  }

  /**
   * Procedural animation. `phase` advances with distance walked; `move` is 0..1 speed;
   * `strafe` is the movement direction relative to facing (radians); `recoil` 0..1 kick.
   */
  pose(phase: number, move: number, strafe: number, recoil: number, time: number): void {
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
    p.torso.rotation.set(0.08 * move + Math.sin(time * 2) * 0.015, 0, 0);
    p.head.rotation.set(-0.08 * move, 0, 0);
    // Two-handed aim: arms forward, converging on the gun.
    const kick = recoil * 0.35;
    p.upperArmR.rotation.set(-Math.PI / 2 + 0.22 - kick, 0.42, 0);
    p.forearmR.rotation.set(0, 0, 0);
    p.upperArmL.rotation.set(-Math.PI / 2 + 0.37 - kick * 0.6, -0.75, 0);
    p.forearmL.rotation.set(-0.35, 0, 0);
    p.torso.position.z = -kick * 0.06;
  }
}

function partColor(name: PartName, l: RigLook): number {
  if (name === 'head') return l.skin;
  if (name.startsWith('upperArm')) return l.shirt;
  if (name.startsWith('forearm')) return l.shirt;
  if (name === 'torso') return l.shirt;
  return l.pants;
}
