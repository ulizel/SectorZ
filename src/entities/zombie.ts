import * as THREE from 'three';
import { HUMANOID, type PartDef, type PartName } from '../rigs/humanoid';
import { PoseRig } from '../rigs/poseRig';
import { ALL, Group, groups, RAPIER, type PhysicsWorld } from '../physics/physicsWorld';

/**
 * Per-part damage model. `hp` = limb health before it tears off (Infinity = never),
 * `mult` = share of damage dealt to the zombie's life, `breakImpulse` = a single impulse
 * (N·s) above this rips the limb off regardless of hp (explosions).
 */
export const PART_DAMAGE: Record<PartName, { hp: number; mult: number; breakImpulse: number }> = {
  head: { hp: 45, mult: 3, breakImpulse: 34 },
  torso: { hp: Infinity, mult: 1, breakImpulse: Infinity },
  pelvis: { hp: Infinity, mult: 1, breakImpulse: Infinity },
  upperArmL: { hp: 40, mult: 0.5, breakImpulse: 26 },
  upperArmR: { hp: 40, mult: 0.5, breakImpulse: 26 },
  forearmL: { hp: 30, mult: 0.4, breakImpulse: 20 },
  forearmR: { hp: 30, mult: 0.4, breakImpulse: 20 },
  thighL: { hp: 55, mult: 0.6, breakImpulse: 40 },
  thighR: { hp: 55, mult: 0.6, breakImpulse: 40 },
  shinL: { hp: 40, mult: 0.5, breakImpulse: 30 },
  shinR: { hp: 40, mult: 0.5, breakImpulse: 30 },
};

/**
 * Joint limits (radians about the part's local X; + bends the child backwards).
 * Shoulders are free ball joints (Rapier's JS API has no cone limits); everything else is a
 * limited hinge so corpses don't fold into impossible shapes.
 */
const HINGE_LIMITS: Partial<Record<PartName, [number, number]>> = {
  torso: [-0.5, 0.9], head: [-0.7, 0.8],
  forearmL: [-2.4, 0.05], forearmR: [-2.4, 0.05],
  thighL: [-1.9, 0.6], thighR: [-1.9, 0.6],
  shinL: [-0.05, 2.4], shinR: [-0.05, 2.4],
};

export const ZOMBIE_MAX_HP = 100;

export interface ZombiePart {
  def: PartDef;
  index: number;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  joint: RAPIER.ImpulseJoint | null; // to parent
  parent: number; // index, -1 for root
  hp: number;
  /** Torn off the body (it, and its children, now fly free). */
  severed: boolean;
  /** Simulated (dynamic) rather than animated. */
  dynamic: boolean;
  prev: THREE.Vector3;
  flinch: number;
}

const v = new THREE.Vector3();
const q = new THREE.Quaternion();

let nextId = 1;

/**
 * A zombie made of 11 physical voxel parts. Alive: parts are kinematic bodies that follow a
 * procedural animation (so bullets hit exact limbs). Dead: parts switch to dynamic and the
 * joints take over → genuine ragdoll. Limbs tear off by removing their joint.
 */
export class Zombie {
  readonly id = nextId++;
  readonly parts: ZombiePart[] = [];
  readonly pose = new PoseRig();
  alive = true;
  hp = ZOMBIE_MAX_HP;
  /** Seconds since death (drives cleanup). */
  deadTime = 0;
  private t = Math.random() * 10;
  private readonly w: RAPIER.World;
  /** Stagger offset (m) applied to the animated root when hit. */
  private stagger = new THREE.Vector3();

  constructor(private readonly physics: PhysicsWorld, public x: number, public z: number, public yaw: number) {
    this.w = physics.world;
    this.animate(0);
    HUMANOID.forEach((def, i) => {
      this.partWorld(i, v, q);
      const body = this.w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(v.x, v.y, v.z).setRotation(q).setLinearDamping(0.05).setAngularDamping(0.6)
        .setCcdEnabled(def.name === 'head'));
      const collider = this.w.createCollider(
        RAPIER.ColliderDesc.cuboid(def.size[0] / 2, def.size[1] / 2, def.size[2] / 2)
          .setMass(def.mass).setFriction(0.8).setRestitution(0.15)
          .setCollisionGroups(groups(Group.ZOMBIE, ALL)), body);
      physics.materials.set(collider.handle, 'flesh');
      this.parts.push({
        def, index: i, body, collider, joint: null, parent: def.parent ? HUMANOID.findIndex((p) => p.name === def.parent) : -1,
        hp: PART_DAMAGE[def.name].hp, severed: false, dynamic: false, prev: v.clone(), flinch: 0,
      });
    });
    for (const p of this.parts) if (p.parent >= 0) p.joint = this.makeJoint(p);
  }

  private makeJoint(p: ZombiePart): RAPIER.ImpulseJoint {
    const parent = this.parts[p.parent];
    const d = p.def, pd = parent.def;
    // Pivot in each body's local frame (bodies sit at their box centres).
    const a1 = { x: d.joint[0] - pd.center[0], y: d.joint[1] - pd.center[1], z: d.joint[2] - pd.center[2] };
    const a2 = { x: -d.center[0], y: -d.center[1], z: -d.center[2] };
    const lim = HINGE_LIMITS[d.name];
    let data: RAPIER.JointData;
    if (lim) {
      data = RAPIER.JointData.revolute(a1, a2, { x: 1, y: 0, z: 0 });
      data.limitsEnabled = true;
      data.limits = lim;
    } else {
      data = RAPIER.JointData.spherical(a1, a2);
    }
    const j = this.w.createImpulseJoint(data, parent.body, p.body, true);
    j.setContactsEnabled(false);
    return j;
  }

  /** World transform of part i's box centre from the animated pose. */
  private partWorld(i: number, outP: THREE.Vector3, outQ: THREE.Quaternion): void {
    const def = HUMANOID[i];
    const g = this.pose.parts[def.name];
    outP.set(...def.center);
    g.localToWorld(outP);
    g.getWorldQuaternion(outQ);
  }

  /** Procedural zombie idle: hunched, arms reaching forward, swaying; flinches add on top. */
  private animate(dt: number): void {
    this.t += dt;
    const t = this.t, p = this.pose.parts;
    this.stagger.multiplyScalar(Math.exp(-6 * dt));
    this.pose.root.position.set(this.x + this.stagger.x, 0, this.z + this.stagger.z);
    this.pose.root.rotation.set(0, this.yaw, 0);
    const fl = (n: PartName) => this.parts.length ? this.parts[HUMANOID.findIndex((d) => d.name === n)].flinch : 0;
    for (const part of this.parts) part.flinch *= Math.exp(-7 * dt);
    p.pelvis.position.y = 0.8 + Math.sin(t * 1.3) * 0.015;
    p.pelvis.rotation.set(0, Math.sin(t * 0.7) * 0.1, Math.sin(t * 0.9) * 0.04);
    p.torso.rotation.set(0.35 + Math.sin(t * 1.1) * 0.05 - fl('torso') - fl('pelvis') * 0.5, 0, Math.sin(t * 0.8) * 0.06);
    p.head.rotation.set(-0.25 + Math.sin(t * 1.7) * 0.08 - fl('head') * 1.5, Math.sin(t * 0.6) * 0.3, Math.sin(t * 0.9) * 0.15);
    p.upperArmL.rotation.set(-1.25 + Math.sin(t * 1.4) * 0.12 + fl('upperArmL'), -0.1, 0.05);
    p.upperArmR.rotation.set(-1.15 + Math.sin(t * 1.2 + 1) * 0.12 + fl('upperArmR'), 0.1, -0.05);
    p.forearmL.rotation.set(-0.25 + fl('forearmL'), 0, 0);
    p.forearmR.rotation.set(-0.4 + fl('forearmR'), 0, 0);
    p.thighL.rotation.set(-0.1 + fl('thighL') * 0.5, 0, 0.04);
    p.thighR.rotation.set(0.05 + fl('thighR') * 0.5, 0, -0.04);
    p.shinL.rotation.set(0.15 + fl('shinL') * 0.5, 0, 0);
    p.shinR.rotation.set(0.1 + fl('shinR') * 0.5, 0, 0);
    this.pose.root.updateMatrixWorld(true);
  }

  /** Sim tick (before physics.step): drive animated parts to the pose. */
  update(dt: number): void {
    if (!this.alive) { this.deadTime += dt; return; }
    this.animate(dt);
    for (const p of this.parts) {
      if (p.dynamic) continue;
      p.prev.copy(p.body.translation() as THREE.Vector3Like);
      this.partWorld(p.index, v, q);
      p.body.setNextKinematicTranslation(v);
      p.body.setNextKinematicRotation(q);
    }
  }

  private makeDynamic(p: ZombiePart, dt: number): void {
    if (p.dynamic) return;
    const t = p.body.translation();
    // Inherit the animation's velocity so the hand-off to physics is seamless.
    const vel = { x: (t.x - p.prev.x) / dt, y: (t.y - p.prev.y) / dt, z: (t.z - p.prev.z) / dt };
    p.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    p.body.setLinvel(vel, true);
    p.collider.setCollisionGroups(groups(Group.RAGDOLL, ALL));
    p.dynamic = true;
  }

  private subtree(i: number): ZombiePart[] {
    const out = [this.parts[i]];
    for (const p of this.parts) if (p.parent === i) out.push(...this.subtree(p.index));
    return out;
  }

  /** Go limp: every animated part becomes a dynamic ragdoll body. */
  kill(dt: number): void {
    if (!this.alive) return;
    this.alive = false;
    this.hp = 0;
    for (const p of this.parts) this.makeDynamic(p, dt);
  }

  /** Tear a limb off: remove its joint; it and its children become free bodies. Returns false if not detachable. */
  sever(i: number, dt: number): boolean {
    const p = this.parts[i];
    if (p.severed || !p.joint || PART_DAMAGE[p.def.name].hp === Infinity) return false;
    this.w.removeImpulseJoint(p.joint, true);
    p.joint = null;
    p.severed = true;
    for (const s of this.subtree(i)) this.makeDynamic(s, dt);
    // Losing the head or a leg drops the zombie (crawlers come in a later phase).
    const n = p.def.name;
    if (n === 'head' || n.startsWith('thigh') || n.startsWith('shin')) this.kill(dt);
    return true;
  }

  /**
   * Apply a bullet/explosion hit to part i. Returns which part was severed (or -1).
   * `ix,iy,iz` is the impulse (N·s); `px,py,pz` the hit point.
   */
  hit(i: number, damage: number, ix: number, iy: number, iz: number, px: number, py: number, pz: number, dt: number): number {
    const p = this.parts[i];
    const dmg = PART_DAMAGE[p.def.name];
    const impulse = Math.hypot(ix, iy, iz);
    if (this.alive) {
      this.hp -= damage * dmg.mult;
      p.flinch += Math.min(0.9, impulse * 0.05);
      this.stagger.x += ix * 0.006; this.stagger.z += iz * 0.006;
      if (this.hp <= 0) this.kill(dt);
    }
    p.hp -= damage;
    let severed = -1;
    if (p.hp <= 0 || impulse > dmg.breakImpulse) {
      // Damage to a limb tip can carry through to the next joint up if the tip is already gone.
      if (this.sever(i, dt)) severed = i;
    }
    if (p.dynamic) p.body.applyImpulseAtPoint({ x: ix, y: iy, z: iz }, { x: px, y: py, z: pz }, true);
    return severed;
  }

  /** Remove all physics objects. */
  destroy(): void {
    for (const p of this.parts) {
      this.physics.materials.delete(p.collider.handle);
      this.w.removeRigidBody(p.body); // also removes its colliders and joints
    }
  }

  /** Average speed of the ragdoll (to decide when it has come to rest). */
  get centre(): THREE.Vector3 {
    const t = this.parts[1].body.translation();
    return v.set(t.x, t.y, t.z);
  }
}
