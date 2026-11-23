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

/** Hinges (elbows, knees): native Rapier limits + motors. Radians about local X. */
const HINGE: Partial<Record<PartName, { lim: [number, number]; crumple: number }>> = {
  forearmL: { lim: [-2.4, 0.05], crumple: -0.6 }, forearmR: { lim: [-2.4, 0.05], crumple: -0.6 },
  shinL: { lim: [-0.05, 2.4], crumple: 1.3 }, shinR: { lim: [-0.05, 2.4], crumple: 1.3 },
};

/**
 * Ball joints (spine, neck, shoulders, hips) with a custom swing-twist limiter, since Rapier's
 * JS API has no cone limits. Swing about X (+ = child tips forward... see rig) and Z (+ = toward +X),
 * twist about the bone (Y). `crumple` is the relative pose "muscles" pull toward as the zombie dies.
 */
interface BallSpec { x: [number, number]; z: [number, number]; twist: [number, number]; crumple: [number, number] }
const BALL: Partial<Record<PartName, BallSpec>> = {
  torso: { x: [-0.5, 0.9], z: [-0.4, 0.4], twist: [-0.6, 0.6], crumple: [0.55, 0] },
  head: { x: [-0.7, 0.8], z: [-0.5, 0.5], twist: [-1.0, 1.0], crumple: [0.4, 0] },
  upperArmL: { x: [-3.0, 1.0], z: [-0.25, 2.6], twist: [-1.2, 1.2], crumple: [-0.3, 0.2] },
  upperArmR: { x: [-3.0, 1.0], z: [-2.6, 0.25], twist: [-1.2, 1.2], crumple: [-0.3, -0.2] },
  thighL: { x: [-1.9, 0.5], z: [-0.3, 0.9], twist: [-0.5, 0.5], crumple: [-0.9, 0.1] },
  thighR: { x: [-1.9, 0.5], z: [-0.9, 0.3], twist: [-0.5, 0.5], crumple: [-0.9, -0.1] },
};

/** Death "muscle tone" fades out over this many seconds (knees buckle, body crumples, then limp). */
export const MUSCLE_FADE = 1.0;
/** Limit violations smaller than this (rad, ~3°) are ignored. */
const LIMIT_DEADBAND = 0.05;
/** Collider shrink on limbs (visual box unchanged) so neighbouring parts don't snag and jitter. */
const LIMB_COLLIDER_SCALE = 0.85;
/** Parts that get continuous collision detection (small and fast when thrown). */
const CCD_PARTS = new Set<PartName>(['head', 'forearmL', 'forearmR', 'upperArmL', 'upperArmR']);

export const ZOMBIE_MAX_HP = 100;
const PART_IDX = Object.fromEntries(HUMANOID.map((d, i) => [d.name, i])) as Record<PartName, number>;
/**
 * Animated (kinematic) zombie parts don't physically touch props: a kinematic body has infinite
 * strength and would drag crates along. The AI pushes props with a limited force instead.
 */
const ALIVE_GROUPS = groups(Group.ZOMBIE, ALL & ~Group.PROP);
export type ZombieState = 'alive' | 'knocked' | 'gettingUp' | 'dead';

export interface ZombiePart {
  def: PartDef;
  index: number;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  joint: RAPIER.ImpulseJoint | null; // to parent
  parent: number; // index, -1 for root
  hp: number;
  maxHp: number;
  /** Torn off the body (it, and its children, now fly free). */
  severed: boolean;
  /** Simulated (dynamic) rather than animated. */
  dynamic: boolean;
  /** Limp but still attached while alive (e.g. shattered shoulder). */
  dangling: boolean;
  prev: THREE.Vector3;
  /** Visible flinch (spring-driven toward flinchTarget) and its velocity. */
  flinch: number;
  flinchVel: number;
  flinchTarget: number;
}

export interface Wound { part: number; local: THREE.Vector3 }

const v = new THREE.Vector3();
const v2 = new THREE.Vector3();
const q = new THREE.Quaternion();
const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), qr = new THREE.Quaternion();
const qt = new THREE.Quaternion(), qs = new THREE.Quaternion(), qd = new THREE.Quaternion();
const AX_Y = new THREE.Vector3(0, 1, 0);

let nextId = 1;

/**
 * A zombie made of 11 physical voxel parts. Alive: parts are kinematic bodies following a
 * procedural animation (bullets hit exact limbs). Knocked/dead: parts are dynamic and the joints
 * (plus a swing-twist limiter and fading muscles) take over → genuine ragdoll. Limbs tear off by
 * removing their joint. Corpses at rest are frozen (fixed bodies: ~free) and wake when disturbed.
 */
export class Zombie {
  readonly id = nextId++;
  readonly parts: ZombiePart[] = [];
  readonly pose = new PoseRig();
  readonly wounds: Wound[] = [];
  state: ZombieState = 'alive';
  hp = ZOMBIE_MAX_HP;
  /** Seconds since death (drives cleanup). */
  deadTime = 0;
  /** Seconds the ragdoll has been at rest. */
  restTime = 0;
  frozen = false;
  private ragTime = 0; // seconds since going ragdoll (muscle fade)
  private knockTime = 0;
  private getUpT = 0;
  private readonly getUpFrom: { p: THREE.Vector3; q: THREE.Quaternion }[] = [];
  private t = Math.random() * 10;
  private readonly w: RAPIER.World;
  // ── Hit reactions (all spring-smoothed, see react()) ──
  /** Whole-body sway: x = lean back(-)/forward(+), z = sideways; target, value, velocity. */
  private readonly sway = { tx: 0, tz: 0, x: 0, z: 0, vx: 0, vz: 0 };
  /** Knockback velocity (m/s, world); the AI moves the zombie by it (walls respected). */
  readonly pushV = new THREE.Vector3();
  /** Recent-hit heat: high under sustained fire → leans into the fire and slows. */
  private heat = 0;
  /** 0..1: being hosed by sustained fire. */
  underFire = 0;
  // ── Locomotion / AI-facing state (set by the AI system each tick) ──
  /** Current ground speed (m/s); drives the walk cycle. */
  speed = 0;
  private walkPhase = Math.random() * 6;
  /** Lost a leg: drags itself along on its arms. */
  crawler = false;
  /** Attack pose: 0 = none, 0..1 wind-up, 1..2 strike/recover. */
  attackPose = 0;
  /** Base walking speed (m/s) for this individual. */
  baseSpeed = 1.15 + Math.random() * 0.45;
  /**
   * Wound slowdown: each hit multiplies speed down by `slowPerHit`, never below `minSpeedMul`.
   * Per-zombie so future types can ignore it (0), or even speed up when hurt (negative).
   */
  speedMul = 1;
  slowPerHit = 0.07;
  minSpeedMul = 0.55;
  /** Death already counted (kills, loot). */
  counted = false;
  /** Last transforms of each part (kept after physics removal so the renderer can sink it away). */
  finalTransforms: { p: THREE.Vector3; q: THREE.Quaternion }[] | null = null;
  /** AI blackboard (owned by the AI system). */
  brain: unknown = null;

  constructor(private readonly physics: PhysicsWorld, public x: number, public z: number, public yaw: number) {
    this.w = physics.world;
    this.animate(0);
    HUMANOID.forEach((def, i) => {
      this.partWorld(i, v, q);
      const body = this.w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(v.x, v.y, v.z).setRotation(q).setLinearDamping(0.05).setAngularDamping(0.8)
        .setCcdEnabled(CCD_PARTS.has(def.name)));
      const limb = def.name !== 'torso' && def.name !== 'pelvis' && def.name !== 'head';
      const s = limb ? LIMB_COLLIDER_SCALE : 1;
      const collider = this.w.createCollider(
        RAPIER.ColliderDesc.cuboid(def.size[0] / 2 * s, def.size[1] / 2, def.size[2] / 2 * s)
          .setMass(def.mass).setFriction(0.8).setRestitution(0.15)
          .setCollisionGroups(ALIVE_GROUPS)
          .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(250), body);
      physics.materials.set(collider.handle, 'flesh');
      const hp = PART_DAMAGE[def.name].hp;
      this.parts.push({
        def, index: i, body, collider, joint: null, parent: def.parent ? HUMANOID.findIndex((p) => p.name === def.parent) : -1,
        hp, maxHp: hp, severed: false, dynamic: false, dangling: false, prev: v.clone(), flinch: 0, flinchVel: 0, flinchTarget: 0,
      });
    });
    for (const p of this.parts) if (p.parent >= 0) p.joint = this.makeJoint(p);
  }

  get alive(): boolean { return this.state !== 'dead'; }
  /** Physics-driven right now (knocked down or dead). */
  get ragdoll(): boolean { return this.state === 'knocked' || this.state === 'dead'; }

  private makeJoint(p: ZombiePart): RAPIER.ImpulseJoint {
    const parent = this.parts[p.parent];
    const d = p.def, pd = parent.def;
    // Pivot in each body's local frame (bodies sit at their box centres).
    const a1 = { x: d.joint[0] - pd.center[0], y: d.joint[1] - pd.center[1], z: d.joint[2] - pd.center[2] };
    const a2 = { x: -d.center[0], y: -d.center[1], z: -d.center[2] };
    const hinge = HINGE[d.name];
    let data: RAPIER.JointData;
    if (hinge) {
      data = RAPIER.JointData.revolute(a1, a2, { x: 1, y: 0, z: 0 });
      data.limitsEnabled = true;
      data.limits = hinge.lim;
    } else {
      data = RAPIER.JointData.spherical(a1, a2);
    }
    const j = this.w.createImpulseJoint(data, parent.body, p.body, true);
    // Upper arms keep colliding with the torso (the chest physically stops arms swinging through
    // it; colliders are shrunk so they don't touch at rest). Other jointed pairs overlap at rest.
    j.setContactsEnabled(d.name.startsWith('upperArm'));
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
    this.react(dt);
    this.pose.root.position.set(this.x, 0, this.z);
    this.pose.root.rotation.set(0, this.yaw, 0);
    const fl = (n: PartName) => this.parts.length ? this.parts[PART_IDX[n]].flinch : 0;
    if (this.crawler) { this.animateCrawl(dt); return; }
    // Body sway from hits (lean away from the shots), plus leaning into sustained fire.
    const reel = Math.max(0, -this.sway.x) * 0.6;
    const lean = this.sway.x + this.underFire * 0.3;
    // Shambling walk: stride scales with speed, slight limp, arms bob.
    const move = Math.min(1, this.speed / 1.4);
    this.walkPhase += this.speed * dt * 3.2;
    const ph = this.walkPhase, sw = Math.sin(ph) * 0.65 * move;
    // Attack: wind-up raises the arms back, strike throws them forward with a lunge.
    const ap = this.attackPose;
    const wind = ap > 0 && ap <= 1 ? ap : ap > 1 ? Math.max(0, 1 - (ap - 1) * 4) : 0;
    const strike = ap > 1 ? Math.sin(Math.min(1, (ap - 1) * 2.5) * Math.PI) : 0;
    p.pelvis.position.y = 0.8 + Math.sin(t * 1.3) * 0.015 - Math.abs(Math.cos(ph)) * 0.04 * move;
    p.pelvis.rotation.set(0, Math.sin(t * 0.7) * 0.1 + sw * 0.15, Math.sin(t * 0.9) * 0.04 + Math.sin(ph) * 0.06 * move);
    p.torso.rotation.set(0.35 + 0.1 * move + Math.sin(t * 1.1) * 0.05 - fl('torso') - fl('pelvis') * 0.5 + lean - wind * 0.3 + strike * 0.5,
      0, Math.sin(t * 0.8) * 0.06 - sw * 0.08 + this.sway.z);
    p.head.rotation.set(-0.25 + Math.sin(t * 1.7) * 0.08 - fl('head') * 1.5 + lean * 0.5 + this.underFire * 0.25, Math.sin(t * 0.6) * 0.3, Math.sin(t * 0.9) * 0.15 + this.sway.z * 0.6);
    const armBob = Math.sin(ph * 2) * 0.08 * move;
    p.upperArmL.rotation.set(-1.25 + Math.sin(t * 1.4) * 0.12 + fl('upperArmL') + reel + armBob - wind * 1.0 + strike * 0.6, -0.1, 0.05 + wind * 0.3);
    p.upperArmR.rotation.set(-1.15 + Math.sin(t * 1.2 + 1) * 0.12 + fl('upperArmR') + reel - armBob - wind * 1.0 + strike * 0.6, 0.1, -0.05 - wind * 0.3);
    p.forearmL.rotation.set(-0.25 + fl('forearmL') - wind * 0.8, 0, 0);
    p.forearmR.rotation.set(-0.4 + fl('forearmR') - wind * 0.8, 0, 0);
    p.thighL.rotation.set(-0.1 - sw + fl('thighL') * 0.5, 0, 0.04);
    p.thighR.rotation.set(0.05 + sw * 0.8 + fl('thighR') * 0.5, 0, -0.04); // shorter stride: a limp
    p.shinL.rotation.set(0.15 + Math.max(0, Math.sin(ph + 1.3)) * 0.8 * move + fl('shinL') * 0.5, 0, 0);
    p.shinR.rotation.set(0.1 + Math.max(0, Math.sin(ph + Math.PI + 1.3)) * 0.6 * move + fl('shinR') * 0.5, 0, 0);
    this.pose.root.updateMatrixWorld(true);
  }

  /** Prone crawl: face down, pulling itself forward with alternating arm reaches. */
  private animateCrawl(dt: number): void {
    const p = this.pose.parts;
    this.walkPhase += Math.max(0.6, this.speed) * dt * 3.5;
    const ph = this.walkPhase;
    const ap = this.attackPose;
    const grab = ap > 1 ? Math.sin(Math.min(1, (ap - 1) * 2.5) * Math.PI) : 0;
    p.pelvis.position.y = 0.13;
    p.pelvis.rotation.set(Math.PI / 2 - 0.08, 0, Math.sin(ph) * 0.08);
    p.torso.rotation.set(-0.15 + Math.sin(ph * 2) * 0.05, Math.sin(ph) * 0.12, 0);
    p.head.rotation.set(-0.9 + Math.sin(ph * 2) * 0.1, 0, 0); // looking up at you
    const reachL = Math.sin(ph), reachR = Math.sin(ph + Math.PI);
    p.upperArmL.rotation.set(-2.6 - reachL * 0.45 - grab * 0.3, 0, 0.35);
    p.upperArmR.rotation.set(-2.6 - reachR * 0.45 - grab * 0.3, 0, -0.35);
    p.forearmL.rotation.set(-0.6 + Math.max(0, reachL) * 0.5, 0, 0);
    p.forearmR.rotation.set(-0.6 + Math.max(0, reachR) * 0.5, 0, 0);
    p.thighL.rotation.set(0.1 + Math.sin(ph) * 0.1, 0, 0.12);
    p.thighR.rotation.set(0.1 - Math.sin(ph) * 0.1, 0, -0.12);
    p.shinL.rotation.set(0.2, 0, 0);
    p.shinR.rotation.set(0.2, 0, 0);
    this.pose.root.updateMatrixWorld(true);
  }

  /**
   * Hit-reaction springs. Accumulated targets saturate (1 - e^-x: rapid hits hold a pose instead
   * of stacking to extreme angles) and recover; visuals follow critically-damped springs (~0.1 s),
   * so a burst blends into one push rather than a twitch per bullet.
   */
  private react(dt: number): void {
    const SPRING = 420, DAMP = 2 * Math.sqrt(SPRING), RECOVER = Math.exp(-4 * dt);
    const sat = (x: number, max: number) => Math.sign(x) * max * (1 - Math.exp(-Math.abs(x) / max));
    for (const p of this.parts) {
      p.flinchTarget *= RECOVER;
      p.flinchVel += (SPRING * (sat(p.flinchTarget, 1.1) - p.flinch) - DAMP * p.flinchVel) * dt;
      p.flinch += p.flinchVel * dt;
    }
    const s = this.sway;
    s.tx *= RECOVER; s.tz *= RECOVER;
    s.vx += (SPRING * (sat(s.tx, 0.8) - s.x) - DAMP * s.vx) * dt;
    s.vz += (SPRING * (sat(s.tz, 0.55) - s.z) - DAMP * s.vz) * dt;
    s.x += s.vx * dt; s.z += s.vz * dt;
    this.pushV.multiplyScalar(Math.exp(-4 * dt));
    this.heat *= Math.exp(-2 * dt);
    // ≳5 hits/s counts as sustained fire; eased so the lean-in builds up instead of jumping per hit.
    const uf = Math.min(1, Math.max(0, (this.heat - 2.5) / 3));
    this.underFire += (uf - this.underFire) * (1 - Math.exp(-3 * dt));
  }

  /** Sim tick (before physics.step). */
  update(dt: number): void {
    if (this.state === 'dead') this.deadTime += dt;
    if (this.ragdoll) {
      if (this.frozen) return;
      this.ragTime += dt;
      this.applyJointControl(dt);
      this.trackRest(dt);
      if (this.state === 'knocked') {
        this.knockTime += dt;
        if ((this.knockTime > 2 && this.restTime > 0.3) || this.knockTime > 3.5) this.beginGetUp();
      }
      return;
    }
    this.animate(dt);
    if (this.state === 'gettingUp') this.getUpT = Math.min(1, this.getUpT + dt / 0.9);
    const k = this.state === 'gettingUp' ? easeInOut(this.getUpT) : 1;
    for (const p of this.parts) {
      if (p.dynamic) continue;
      p.prev.copy(p.body.translation() as THREE.Vector3Like);
      this.partWorld(p.index, v, q);
      if (k < 1) {
        const from = this.getUpFrom[p.index];
        v.lerpVectors(from.p, v, k);
        q.slerpQuaternions(from.q, q, k);
      }
      p.body.setNextKinematicTranslation(v);
      p.body.setNextKinematicRotation(q);
    }
    if (this.state === 'gettingUp' && this.getUpT >= 1) this.state = 'alive';
    // Dangling limbs still get the limiter so they hang naturally.
    if (this.parts.some((p) => p.dangling)) this.applyJointControl(dt);
  }

  /** Swing-twist limits for ball joints + fading death "muscles" (all joints). */
  private applyJointControl(dt: number): void {
    const muscle = this.state === 'dead' ? Math.max(0, 1 - this.ragTime / MUSCLE_FADE) : this.state === 'knocked' ? 0.25 : 0;
    for (const p of this.parts) {
      if (!p.joint || p.severed || !p.dynamic) continue;
      const parent = this.parts[p.parent];
      const hinge = HINGE[p.def.name];
      if (hinge) {
        const j = p.joint as RAPIER.RevoluteImpulseJoint;
        if (muscle > 0) j.configureMotorPosition(hinge.crumple, 40 * muscle * p.def.mass, 3 * p.def.mass);
        else j.configureMotorVelocity(0, 0.15 * p.def.mass); // joint friction: no endless wobble
        continue;
      }
      const spec = BALL[p.def.name];
      if (!spec) continue;
      if (p.body.isSleeping() && (!parent.dynamic || parent.body.isSleeping())) continue;
      const pr = parent.body.rotation(), cr = p.body.rotation();
      qa.set(pr.x, pr.y, pr.z, pr.w);
      qb.set(cr.x, cr.y, cr.z, cr.w);
      qr.copy(qa).invert().multiply(qb); // child relative to parent (rest = identity)
      // Twist about the bone (Y), swing = the rest.
      qt.set(0, qr.y, 0, qr.w);
      if (qt.lengthSq() < 1e-8) qt.identity(); else qt.normalize();
      qs.copy(qr).multiply(qd.copy(qt).invert());
      let twist = 2 * Math.atan2(qt.y, qt.w);
      if (twist > Math.PI) twist -= Math.PI * 2;
      const sAng = 2 * Math.acos(Math.min(1, Math.abs(qs.w)));
      const sgn = qs.w < 0 ? -1 : 1;
      const sl = Math.sqrt(qs.x * qs.x + qs.z * qs.z) || 1;
      let sx = (qs.x * sgn / sl) * sAng, sz = (qs.z * sgn / sl) * sAng;
      // Desired relative pose: muscles pull toward the crumple pose; limits clamp.
      if (muscle > 0) {
        const pull = Math.min(1, 6 * dt) * muscle;
        sx += (spec.crumple[0] - sx) * pull;
        sz += (spec.crumple[1] - sz) * pull;
        twist += (0 - twist) * pull;
      }
      const cx = clamp(sx, spec.x), cz = clamp(sz, spec.z), ct = clamp(twist, spec.twist);
      const sxOrig = (qs.x * sgn / sl) * sAng, szOrig = (qs.z * sgn / sl) * sAng;
      let twOrig = 2 * Math.atan2(qt.y, qt.w); if (twOrig > Math.PI) twOrig -= Math.PI * 2;
      // Deadband: tiny violations are left to settle, otherwise the limiter fights ground contacts
      // and keeps corpses twitching forever (and awake).
      const DEAD = muscle > 0 ? 1e-4 : LIMIT_DEADBAND;
      if (Math.abs(cx - sxOrig) < DEAD && Math.abs(cz - szOrig) < DEAD && Math.abs(ct - twOrig) < DEAD) continue;
      // Target relative rotation, then the world-space correction rotation that gets us there.
      const sw = Math.hypot(cx, cz);
      qs.setFromAxisAngle(sw > 1e-6 ? v2.set(cx / sw, 0, cz / sw) : v2.set(1, 0, 0), sw);
      qt.setFromAxisAngle(AX_Y, ct);
      qd.copy(qs).multiply(qt).multiply(qr.invert()); // desired * current⁻¹ (parent frame)
      if (qd.w < 0) qd.set(-qd.x, -qd.y, -qd.z, -qd.w);
      const ang = 2 * Math.acos(Math.min(1, qd.w));
      if (ang < 1e-4) continue;
      const s = Math.sin(ang / 2);
      v2.set(qd.x / s, qd.y / s, qd.z / s).applyQuaternion(qa); // axis → world
      // Velocity constraint: the relative spin along the correction axis must be at least what
      // closes the error over a few steps. Only the deficit is added (no accumulation → no jitter).
      const want = (ang / dt) * 0.8;
      const ca = p.body.angvel(), pa = parent.body.angvel();
      const relAlong = (ca.x - (parent.dynamic ? pa.x : 0)) * v2.x + (ca.y - (parent.dynamic ? pa.y : 0)) * v2.y + (ca.z - (parent.dynamic ? pa.z : 0)) * v2.z;
      const deficit = want - relAlong;
      if (deficit <= 0) continue;
      const mc = p.def.mass, mp = parent.dynamic ? parent.def.mass : Infinity;
      const kc = mp === Infinity ? 1 : mp / (mc + mp), kp = mp === Infinity ? 0 : mc / (mc + mp);
      p.body.setAngvel({ x: ca.x + v2.x * deficit * kc, y: ca.y + v2.y * deficit * kc, z: ca.z + v2.z * deficit * kc }, true);
      if (kp > 0) parent.body.setAngvel({ x: pa.x - v2.x * deficit * kp, y: pa.y - v2.y * deficit * kp, z: pa.z - v2.z * deficit * kp }, true);
    }
  }

  private trackRest(dt: number): void {
    let moving = false;
    for (const p of this.parts) {
      if (!p.dynamic) continue;
      const lv = p.body.linvel(), av = p.body.angvel();
      if (lv.x * lv.x + lv.y * lv.y + lv.z * lv.z > 0.03 || av.x * av.x + av.y * av.y + av.z * av.z > 1.0) { moving = true; break; }
    }
    this.restTime = moving ? 0 : this.restTime + dt;
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

  /** Go limp: every animated part becomes a dynamic ragdoll body; muscles fade over MUSCLE_FADE. */
  kill(dt: number): void {
    if (this.state === 'dead') return;
    const wasRagdoll = this.ragdoll;
    this.state = 'dead';
    this.hp = 0;
    if (!wasRagdoll) this.ragTime = 0;
    for (const p of this.parts) this.makeDynamic(p, dt);
  }

  /** Knocked off its feet but alive: ragdoll now, gets back up after ~2 s. */
  knockDown(dt: number): void {
    if (this.state !== 'alive' && this.state !== 'gettingUp') return;
    this.state = 'knocked';
    this.knockTime = 0;
    this.ragTime = 0;
    this.restTime = 0;
    for (const p of this.parts) this.makeDynamic(p, dt);
  }

  /** Switch back to animation, blending each part from where it lies to the standing pose. */
  private beginGetUp(): void {
    const pel = this.parts[0].body.translation();
    const head = this.parts[2].body.translation();
    this.x = pel.x; this.z = pel.z;
    // Stand up facing the way the head was pointing.
    if (Math.hypot(head.x - pel.x, head.z - pel.z) > 0.1) this.yaw = Math.atan2(head.x - pel.x, head.z - pel.z);
    this.getUpFrom.length = 0;
    for (const p of this.parts) {
      const t = p.body.translation(), r = p.body.rotation();
      this.getUpFrom.push({ p: new THREE.Vector3(t.x, t.y, t.z), q: new THREE.Quaternion(r.x, r.y, r.z, r.w) });
      if (p.severed || p.dangling) continue;
      p.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      p.collider.setCollisionGroups(ALIVE_GROUPS);
      p.dynamic = false;
    }
    this.state = 'gettingUp';
    this.getUpT = 0;
    this.pushV.set(0, 0, 0);
    this.sway.tx = this.sway.tz = this.sway.x = this.sway.z = this.sway.vx = this.sway.vz = 0;
  }

  /** Tear a limb off: remove its joint; it and its children become free bodies. Returns false if not detachable. */
  sever(i: number, dt: number): boolean {
    const p = this.parts[i];
    if (p.severed || !p.joint || p.maxHp === Infinity) return false;
    if (this.frozen) this.unfreeze();
    this.w.removeImpulseJoint(p.joint, true);
    p.joint = null;
    p.severed = true;
    for (const s of this.subtree(i)) this.makeDynamic(s, dt);
    const n = p.def.name;
    if (n === 'head') {
      // A severed head rolls.
      p.body.setAngularDamping(0.15);
      p.body.applyTorqueImpulse({ x: (Math.random() - 0.5) * 0.4, y: (Math.random() - 0.5) * 0.4, z: (Math.random() - 0.5) * 0.4 }, true);
    }
    if (n === 'head') this.kill(dt);
    else if ((n.startsWith('thigh') || n.startsWith('shin')) && this.alive) {
      // Lost a leg: falls, then drags itself on as a crawler.
      this.crawler = true;
      this.hp = Math.min(this.hp, ZOMBIE_MAX_HP * 0.6);
      if (this.state === 'alive' || this.state === 'gettingUp') this.knockDown(dt);
    }
    return true;
  }

  /**
   * Apply a hit to part i. Returns which part was severed (or -1).
   * `ix,iy,iz` impulse (N·s); `px,py,pz` hit point; `wound` records a visible wound there.
   */
  hit(i: number, damage: number, ix: number, iy: number, iz: number, px: number, py: number, pz: number, dt: number, wound = false, limbMult = 1, flinch = 1): number {
    const p = this.parts[i];
    if (this.frozen) this.unfreeze();
    const dmg = PART_DAMAGE[p.def.name];
    const impulse = Math.hypot(ix, iy, iz);
    if (wound && this.wounds.filter((w) => w.part === i).length < 6) {
      // Wound position in the part's local frame (so it moves with the limb).
      const t = p.body.translation(), r = p.body.rotation();
      const local = new THREE.Vector3(px - t.x, py - t.y, pz - t.z).applyQuaternion(q.set(r.x, r.y, r.z, r.w).invert());
      this.wounds.push({ part: i, local });
    }
    if (this.alive) {
      this.hp -= damage * dmg.mult;
      if (wound) this.speedMul = Math.min(1.5, Math.max(this.minSpeedMul, this.speedMul - this.slowPerHit));
      if (this.state === 'alive' || this.state === 'gettingUp') {
        // Spread the hit: ~40% into the struck limb, ~60% into a whole-body lean away from the
        // shot; plus a damped knockback push. Targets accumulate, visuals follow via springs.
        const k = impulse * 0.05 * flinch;
        p.flinchTarget += k * 0.4;
        const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
        const fwd = (ix * fx + iz * fz) / (impulse || 1); // + = pushed toward its front
        const left = (ix * fz - iz * fx) / (impulse || 1); // + = pushed toward its left (+X local)
        this.sway.tx += k * 0.6 * fwd;
        this.sway.tz -= k * 0.6 * left;
        this.pushV.x += ix * 0.06 * flinch; this.pushV.z += iz * 0.06 * flinch;
        this.heat += 1;
      }
      if (this.hp <= 0) this.kill(dt);
    }
    p.hp -= damage * limbMult;
    let severed = -1;
    if (p.hp <= 0 || impulse > dmg.breakImpulse) {
      if (this.sever(i, dt)) severed = i;
    } else if (this.alive && !p.dynamic && p.def.name.startsWith('upperArm') && p.hp <= p.maxHp * 0.5) {
      // Shattered shoulder: the arm goes limp and dangles, the zombie keeps coming.
      for (const s of this.subtree(i)) { this.makeDynamic(s, dt); s.dangling = true; }
    }
    if (p.dynamic) p.body.applyImpulseAtPoint({ x: ix, y: iy, z: iz }, { x: px, y: py, z: pz }, true);
    return severed;
  }

  /** Corpse at rest → fixed bodies (no solver cost, still shootable). */
  freeze(): void {
    if (this.frozen || this.state !== 'dead') return;
    for (const p of this.parts) p.body.setBodyType(RAPIER.RigidBodyType.Fixed, false);
    this.frozen = true;
  }

  unfreeze(): void {
    if (!this.frozen) return;
    for (const p of this.parts) p.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    this.frozen = false;
    this.restTime = 0;
  }

  /** Remove all physics objects (final pose is kept for the renderer). */
  destroy(): void {
    this.finalTransforms = this.parts.map((p) => {
      const t = p.body.translation(), r = p.body.rotation();
      return { p: new THREE.Vector3(t.x, t.y, t.z), q: new THREE.Quaternion(r.x, r.y, r.z, r.w) };
    });
    for (const p of this.parts) {
      this.physics.materials.delete(p.collider.handle);
      this.w.removeRigidBody(p.body); // also removes its colliders and joints
    }
  }
}

function clamp(v: number, r: [number, number]): number { return v < r[0] ? r[0] : v > r[1] ? r[1] : v; }
function easeInOut(t: number): number { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
