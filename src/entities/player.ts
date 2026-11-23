import { PLAYER } from '../config';
import { angleDelta, damp } from '../core/math';
import type { InputCommand } from '../input/commands';
import { Group, groups, ALL, RAPIER, type PhysicsWorld } from '../physics/physicsWorld';
import { WEAPONS, WeaponState } from '../weapons/weapon';

/**
 * Player simulation state. No rendering here: the same class would run on a co-op host
 * for each connected player, driven only by InputCommands.
 */
export class Player {
  readonly id: number;
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  private readonly controller: RAPIER.KinematicCharacterController;

  x: number; z: number;
  prevX: number; prevZ: number;
  vx = 0; vz = 0;
  yaw = 0; prevYaw = 0;
  health = PLAYER.maxHealth;
  walkPhase = 0;
  readonly weapons = [new WeaponState(WEAPONS.pistol), new WeaponState(WEAPONS.smg)];
  weaponIndex = 0;
  get weapon(): WeaponState { return this.weapons[this.weaponIndex]; }

  /** Switch to a slot (or -1 = next). Returns true if the weapon changed. */
  switchWeapon(slot: number): boolean {
    const next = slot < 0 ? (this.weaponIndex + 1) % this.weapons.length : slot;
    if (next === this.weaponIndex || next >= this.weapons.length) return false;
    this.weapon.cancelReload();
    this.weaponIndex = next;
    return true;
  }

  constructor(id: number, physics: PhysicsWorld, x: number, z: number) {
    this.id = id;
    this.x = this.prevX = x;
    this.z = this.prevZ = z;
    const w = physics.world;
    // Float the capsule a few cm above the floor: we move on a flat plane and never want
    // the controller to treat the ground as an obstacle.
    const cy = PLAYER.halfHeight + PLAYER.radius + 0.06;
    this.body = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, cy, z));
    this.collider = w.createCollider(
      RAPIER.ColliderDesc.capsule(PLAYER.halfHeight, PLAYER.radius)
        .setCollisionGroups(groups(Group.PLAYER, ALL & ~Group.DEBRIS)),
      this.body,
    );
    this.controller = w.createCharacterController(0.02);
    this.controller.setApplyImpulsesToDynamicBodies(true);
    this.controller.setCharacterMass(80);
    this.controller.setSlideEnabled(true);
  }

  /** Movement + facing for one tick. Must be called before PhysicsWorld.step(). */
  update(cmd: InputCommand, dt: number): void {
    this.prevX = this.x; this.prevZ = this.z; this.prevYaw = this.yaw;

    // Accelerate toward the target velocity (snappy but not instant).
    const tx = cmd.moveX * PLAYER.moveSpeed, tz = cmd.moveZ * PLAYER.moveSpeed;
    const hasInput = cmd.moveX !== 0 || cmd.moveZ !== 0;
    const rate = hasInput ? PLAYER.accel : PLAYER.decel;
    const dvx = tx - this.vx, dvz = tz - this.vz;
    const dl = Math.hypot(dvx, dvz), maxDv = rate * dt;
    if (dl > maxDv) { this.vx += (dvx / dl) * maxDv; this.vz += (dvz / dl) * maxDv; }
    else { this.vx = tx; this.vz = tz; }

    // Collide-and-slide against the world via Rapier's character controller.
    this.controller.computeColliderMovement(this.collider, { x: this.vx * dt, y: 0, z: this.vz * dt },
      undefined, groups(Group.PLAYER, ALL & ~Group.DEBRIS & ~Group.PLAYER & ~Group.RAGDOLL)); // corpses/limbs don't block
    const m = this.controller.computedMovement();
    const t = this.body.translation();
    this.body.setNextKinematicTranslation({ x: t.x + m.x, y: t.y, z: t.z + m.z });
    this.x = t.x + m.x;
    this.z = t.z + m.z;
    // Actual velocity after collisions (so we don't "push" into walls forever).
    this.vx = m.x / dt; this.vz = m.z / dt;

    // Facing follows the aim only; movement never changes where the player aims.
    let targetYaw = this.yaw;
    if (cmd.aimX !== 0 || cmd.aimZ !== 0) targetYaw = Math.atan2(cmd.aimX, cmd.aimZ);
    this.yaw += angleDelta(this.yaw, targetYaw) * damp(PLAYER.turnSpeed, dt);

    const speed = Math.hypot(this.vx, this.vz);
    this.walkPhase += speed * dt * 2.6;
  }

  get speed(): number { return Math.hypot(this.vx, this.vz); }
  /** Unit forward vector from yaw. */
  get forwardX(): number { return Math.sin(this.yaw); }
  get forwardZ(): number { return Math.cos(this.yaw); }
}
