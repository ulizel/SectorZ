import { NavGrid } from './navGrid';
import { EXPLODER, type Zombie } from '../entities/zombie';
import { PART_INDEX } from '../rigs/humanoid';
import { angleDelta } from '../core/math';
import { Group, groups, type PhysicsWorld } from '../physics/physicsWorld';

/** Tunables for zombie behaviour. */
export const AI = {
  sightRange: 15,
  hearShotRange: 22,
  loseInterestAfter: 12, // s without sight/noise before giving up the chase
  turnRate: 4, // rad/s
  crawlSpeed: 0.55,
  wanderSpeed: 0.45,
  attackRange: 1.05, // start an attack when this close (m, centre to centre)
  crawlAttackRange: 0.95,
  strikeReach: 1.35, // hit lands if the player is still within this at the strike
  windup: 0.6, // s (dodge window; generous because at night you see them late)
  recover: 0.7,
  damage: 12,
  separation: 0.85, // personal space between zombies (m)
};

interface Brain {
  mode: 'idle' | 'chase' | 'attack';
  alert: number; // s of interest left
  wanderX: number; wanderZ: number; wanderT: number;
  attackT: number; struck: boolean;
  sightT: number; // next line-of-sight check
  canSee: boolean;
  /** Straight line to the player is walkable (not just visible over a car bonnet). */
  walkClear: boolean;
  stuckT: number; // s of barely moving while trying to
  detourT: number; detourX: number; detourZ: number;
  homeX: number; homeZ: number;
}

export interface AITarget { x: number; z: number; alive: boolean }
/** A movable obstacle (crate, barrel) zombies avoid and can only shove with limited force. */
export interface AIProp { body: { translation(): { x: number; y: number; z: number }; applyImpulse(i: { x: number; y: number; z: number }, wake: boolean): void; mass(): number }; radius: number }

/** Force (N) a zombie can push a prop with: a 20 kg crate on rough ground barely slides. */
export const PUSH_FORCE = 130;
export interface AttackResult { zombie: Zombie; damage: number }

const tmp = { x: 0, z: 0 };

/**
 * Zombie behaviour: senses (sight + gunshot noise), flow-field chasing around obstacles,
 * crowd separation, wall sliding, wind-up/strike attacks, crawlers. Operates on any
 * Zombie in the 'alive' state (knocked/ragdoll states are handled by physics).
 */
export class ZombieAI {
  readonly nav: NavGrid;
  private flowT = 0;
  /** Spatial hash for neighbour queries. */
  private readonly hash = new Map<number, Zombie[]>();
  enabled = true;
  /** Movable props (set by the game). */
  props: AIProp[] = [];
  private readonly propPos: { x: number; z: number; r: number }[] = [];
  private dt = 1 / 60;

  constructor(private readonly physics: PhysicsWorld, arenaSize: number) {
    this.nav = new NavGrid(physics, arenaSize);
  }

  private brain(z: Zombie): Brain {
    if (!z.brain) {
      z.brain = {
        mode: 'idle', alert: 0, wanderX: z.x, wanderZ: z.z, wanderT: 0, attackT: 0, struck: false,
        sightT: Math.random() * 0.5, canSee: false, walkClear: false, stuckT: 0, detourT: 0, detourX: 0, detourZ: 0, homeX: z.x, homeZ: z.z,
      } satisfies Brain;
    }
    return z.brain as Brain;
  }

  /** Make every zombie within `radius` aware of the player (gunshots, explosions). */
  noise(x: number, z: number, radius: number, zombies: Zombie[]): void {
    for (const zb of zombies) {
      if (!zb.alive) continue;
      if (Math.hypot(zb.x - x, zb.z - z) < radius) {
        const b = this.brain(zb);
        b.alert = AI.loseInterestAfter;
        if (b.mode === 'idle') b.mode = 'chase';
      }
    }
  }

  /** Alert every zombie (e.g. survival spawns come straight for you). */
  alertAll(zombies: Zombie[]): void { for (const z of zombies) { const b = this.brain(z); b.alert = 1e9; b.mode = 'chase'; } }

  update(dt: number, target: AITarget, zombies: Zombie[], attacks: AttackResult[]): void {
    attacks.length = 0;
    this.dt = dt;
    // Current prop footprints (they move, so refresh every tick; cheap).
    this.propPos.length = 0;
    for (const p of this.props) { const t = p.body.translation(); if (t.y > -1) this.propPos.push({ x: t.x, z: t.z, r: p.radius }); }
    this.flowT -= dt;
    if (this.flowT <= 0) {
      // Props are soft obstacles in the flow field: paths go around them when there's room.
      this.nav.setSoftObstacles(this.propPos);
      this.nav.setTarget(target.x, target.z, true);
      this.flowT = 0.25;
    }
    // Spatial hash (2 m cells) of active zombies.
    this.hash.clear();
    for (const z of zombies) {
      if (z.state !== 'alive') continue;
      const k = this.key(z.x, z.z);
      const list = this.hash.get(k);
      if (list) list.push(z); else this.hash.set(k, [z]);
    }
    for (const z of zombies) {
      if (z.state !== 'alive') { if (z.alive) z.speed = 0; continue; }
      if (!this.enabled) { z.speed = 0; z.attackPose = 0; continue; }
      this.think(z, dt, target, attacks);
    }
  }

  private key(x: number, z: number): number { return (Math.floor(x / 2) + 512) * 4096 + (Math.floor(z / 2) + 512); }

  private think(z: Zombie, dt: number, t: AITarget, attacks: AttackResult[]): void {
    const b = this.brain(z);
    const dx = t.x - z.x, dz = t.z - z.z;
    const dist = Math.hypot(dx, dz);

    // Senses: line of sight checked a few times per second (staggered across zombies).
    b.sightT -= dt;
    if (b.sightT <= 0) {
      b.sightT = 0.4;
      b.canSee = t.alive && dist < AI.sightRange && !this.physics.raycast(z.x, 1.4, z.z, dx / (dist || 1), 0, dz / (dist || 1),
        Math.max(0.01, dist - 0.4), groups(Group.ZOMBIE, Group.STATIC));
      if (b.canSee) { b.alert = AI.loseInterestAfter; if (b.mode === 'idle') b.mode = 'chase'; }
      b.walkClear = b.canSee && dist < 6 && this.lineWalkable(z.x, z.z, t.x, t.z);
    }
    b.alert -= dt;
    if (b.mode === 'chase' && (b.alert <= 0 || !t.alive)) b.mode = 'idle';

    // Knockback from hits: driven back by the push velocity (walls respected).
    const pv = Math.hypot(z.pushV.x, z.pushV.z);
    if (pv > 0.02) this.move(z, z.pushV.x / pv, z.pushV.z / pv, pv * dt, dt);
    // The player can wade through: zombies get shoved aside instead of overlapping.
    if (dist < 0.55 && dist > 1e-4) this.move(z, -dx / dist, -dz / dist, (0.55 - dist) * 0.4, dt);

    let speed = 0, dirX = 0, dirZ = 0;
    const crawler = z.crawler;
    const arms = (z.parts[PART_INDEX.upperArmL].severed ? 0 : 1) + (z.parts[PART_INDEX.upperArmR].severed ? 0 : 1);

    if (b.mode === 'attack') {
      b.attackT += dt;
      const wind = AI.windup * (crawler ? 0.8 : 1);
      z.attackPose = b.attackT < wind ? b.attackT / wind : 1 + (b.attackT - wind) / (AI.recover + 0.15);
      // Track the target a little during the wind-up (committed during the strike).
      if (b.attackT < wind * 0.7) this.turnToward(z, Math.atan2(dx, dz), dt * 0.6);
      if (!b.struck && b.attackT >= wind) {
        b.struck = true;
        const facing = Math.abs(angleDelta(z.yaw, Math.atan2(dx, dz))) < 0.9;
        if (t.alive && facing && dist < AI.strikeReach * z.scale) {
          // Fewer arms = weaker attack (armless zombies can only bite).
          const dmg = AI.damage * z.damageMul * (arms === 2 ? 1 : arms === 1 ? 0.65 : 0.4) * (crawler ? 0.7 : 1);
          attacks.push({ zombie: z, damage: dmg });
        }
        // Lunge forward on the strike.
        this.move(z, Math.sin(z.yaw), Math.cos(z.yaw), crawler ? 0.15 : 0.35, 1);
      }
      if (b.attackT >= wind + AI.recover) { b.mode = 'chase'; z.attackPose = 0; }
      // Still keep personal space while attacking (others shove in beside, not inside).
      this.separation(z, tmp);
      if (tmp.x || tmp.z) this.move(z, tmp.x, tmp.z, Math.min(0.03, Math.hypot(tmp.x, tmp.z) * 0.08), dt);
      z.speed = 0;
      return;
    }
    z.attackPose = 0;

    if (b.mode === 'chase') {
      if (z.kind === 'exploder' && (z.fuse !== undefined || dist < AI.attackRange * 1.3) && t.alive) {
        // Exploders don't swing: they stop and light themselves (the game blows them up).
        if (z.fuse === undefined) { z.fuse = z.fuseTotal = EXPLODER.fuse; }
        z.speed = 0;
        return;
      }
      if (dist < (crawler ? AI.crawlAttackRange : AI.attackRange) * z.scale && t.alive) {
        b.mode = 'attack'; b.attackT = 0; b.struck = false;
        z.speed = 0;
        return;
      }
      speed = (crawler ? AI.crawlSpeed : z.baseSpeed) * z.speedMul * (1 - 0.35 * z.underFire); // pushing through fire is slow
      if (b.detourT > 0) { b.detourT -= dt; dirX = b.detourX; dirZ = b.detourZ; } // side-stepping an obstacle
      else if (b.walkClear) { dirX = dx / dist; dirZ = dz / dist; } // clear ground between us: straight at you
      else if (this.nav.flow(z.x, z.z, tmp)) { dirX = tmp.x; dirZ = tmp.z; }
      else { dirX = dx / (dist || 1); dirZ = dz / (dist || 1); }
    } else {
      // Idle: shuffle between nearby points.
      b.wanderT -= dt;
      if (b.wanderT <= 0 || Math.hypot(b.wanderX - z.x, b.wanderZ - z.z) < 0.4) {
        b.wanderT = 3 + Math.random() * 4;
        b.wanderX = b.homeX + (Math.random() - 0.5) * 6;
        b.wanderZ = b.homeZ + (Math.random() - 0.5) * 6;
      }
      const wx = b.wanderX - z.x, wz = b.wanderZ - z.z, wl = Math.hypot(wx, wz) || 1;
      dirX = wx / wl; dirZ = wz / wl;
      speed = crawler ? AI.crawlSpeed * 0.5 : AI.wanderSpeed;
    }

    // Separation: don't stack into a blob.
    this.separation(z, tmp);
    const sx = tmp.x, sz = tmp.z;
    dirX += sx * 3; dirZ += sz * 3;
    // Steer around nearby props (local avoidance on top of the flow field).
    for (const pp of this.propPos) {
      const ax = z.x - pp.x, az = z.z - pp.z, d = Math.hypot(ax, az), reach = pp.r + 0.9;
      if (d < reach && d > 1e-4) { const f = (reach - d) / reach; dirX += (ax / d) * f * 1.5; dirZ += (az / d) * f * 1.5; }
    }
    const dl = Math.hypot(dirX, dirZ);
    if (dl > 1e-4) { dirX /= dl; dirZ /= dl; }
    // Turn toward the travel direction, and walk where we face (no moonwalking).
    if (dl > 1e-4) this.turnToward(z, Math.atan2(dirX, dirZ), dt);
    const facing = Math.max(0, Math.cos(angleDelta(z.yaw, Math.atan2(dirX, dirZ))));
    const want = speed * dt * (0.35 + 0.65 * facing);
    const actual = this.move(z, dirX, dirZ, want, dt);
    z.speed = actual / dt;
    // Stuck (barely moving for 3 s while chasing): side-step around the obstacle for a moment.
    if (b.mode === 'chase' && want > 1e-4) {
      b.stuckT = actual < want * 0.3 ? b.stuckT + dt : Math.max(0, b.stuckT - dt);
      if (b.stuckT > 3) {
        b.stuckT = 0;
        const side = this.nav.isBlocked(z.x - dirZ * 1.5, z.z + dirX * 1.5) ? -1 : Math.random() < 0.5 ? 1 : -1;
        b.detourX = -dirZ * side; b.detourZ = dirX * side; b.detourT = 1.2;
      }
    }
  }

  /** Sum of push-away vectors from neighbours inside personal space. */
  private separation(z: Zombie, out: { x: number; z: number }): void {
    let sx = 0, sz = 0;
    const kx = Math.floor(z.x / 2), kz = Math.floor(z.z / 2);
    for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
      const list = this.hash.get((kx + ox + 512) * 4096 + (kz + oz + 512));
      if (!list) continue;
      for (const o of list) {
        if (o === z) continue;
        const ax = z.x - o.x, az = z.z - o.z;
        const d = Math.hypot(ax, az);
        if (d < AI.separation) {
          // Exactly overlapping: push in a stable pseudo-random direction.
          const ux = d > 1e-4 ? ax / d : Math.cos(z.id), uz = d > 1e-4 ? az / d : Math.sin(z.id);
          const f = (AI.separation - d) / AI.separation;
          sx += ux * f; sz += uz * f;
        }
      }
    }
    out.x = sx; out.z = sz;
  }

  /** Is the straight line walkable on the nav grid? (sampled every 0.4 m) */
  private lineWalkable(x0: number, z0: number, x1: number, z1: number): boolean {
    const d = Math.hypot(x1 - x0, z1 - z0), n = Math.ceil(d / 0.4);
    for (let i = 1; i < n; i++) if (this.nav.isBlocked(x0 + (x1 - x0) * i / n, z0 + (z1 - z0) * i / n)) return false;
    return true;
  }

  private turnToward(z: Zombie, yaw: number, dt: number): void {
    const d = angleDelta(z.yaw, yaw);
    const step = AI.turnRate * dt;
    z.yaw += Math.max(-step, Math.min(step, d));
  }

  /** Move with wall sliding against the inflated nav grid. Returns distance moved. */
  private move(z: Zombie, dx: number, dz: number, dist: number, _dt: number): number {
    let nx = z.x + dx * dist, nz = z.z + dz * dist;
    // Props are solid to zombies: stop at their edge and shove them with limited force.
    for (const p of this.props) {
      const t = p.body.translation();
      if (t.y < -1) continue;
      const ax = nx - t.x, az = nz - t.z, d = Math.hypot(ax, az), min = p.radius + 0.3;
      if (d >= min || d < 1e-4) continue;
      // Shove along the push direction; heavy props barely move (friction does the rest).
      const into = Math.max(0, -(dx * ax + dz * az) / d);
      if (into > 0) {
        const j = PUSH_FORCE * this.dt * into;
        p.body.applyImpulse({ x: -(ax / d) * j, y: 0, z: -(az / d) * j }, true);
      }
      nx = t.x + (ax / d) * min; nz = t.z + (az / d) * min; // slide around the edge
    }
    dist = Math.hypot(nx - z.x, nz - z.z);
    if (dist < 1e-6) return 0;
    dx = (nx - z.x) / dist; dz = (nz - z.z) / dist;
    if (!this.nav.isBlocked(nx, nz)) { z.x = nx; z.z = nz; return dist; }
    if (!this.nav.isBlocked(nx, z.z)) { z.x = nx; return Math.abs(dx * dist); }
    if (!this.nav.isBlocked(z.x, nz)) { z.z = nz; return Math.abs(dz * dist); }
    return 0;
  }
}
