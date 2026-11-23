import * as THREE from 'three';
import { PLAYER } from './config';
import { EventBus } from './core/events';
import { FixedLoop } from './core/loop';
import { lerp, angleDelta } from './core/math';
import type { QualityPreset } from './core/quality';
import { Sfx } from './audio/sfx';
import { emptyCommand, type InputCommand, type RawInput } from './input/commands';
import { InputManager } from './input/inputManager';
import { Player } from './entities/player';
import { Group, groups, ALL, PhysicsWorld } from './physics/physicsWorld';
import { Renderer } from './render/renderer';
import { HumanoidRig, SURVIVOR_LOOK } from './render/humanoidRig';
import { MuzzleFlash, ParticleSystem, Tracers } from './render/effects';
import { buildArena, type DynamicProp } from './world/arena';
import { Hud } from './ui/hud';
import { DebugOverlay } from './ui/debugOverlay';
import type { WeaponEvent } from './weapons/weapon';

/** Bullets travel horizontally at this height (zombie chest, crate/barrel tops are 1.2 m). */
const BULLET_HEIGHT = 1.15;
const v3 = new THREE.Vector3();
const v3b = new THREE.Vector3();

export class Game {
  readonly events = new EventBus();
  readonly physics = new PhysicsWorld();
  readonly renderer: Renderer;
  readonly input: InputManager;
  readonly sfx = new Sfx();
  readonly player: Player;
  readonly rig = new HumanoidRig(SURVIVOR_LOOK);
  readonly props: DynamicProp[];
  private readonly propStart: THREE.Vector3[];
  private readonly sparks: ParticleSystem;
  private readonly debris: ParticleSystem;
  private readonly tracers: Tracers;
  private readonly flash: MuzzleFlash;
  private readonly hud = new Hud();
  private readonly laser: THREE.Mesh;
  private readonly marker: THREE.Mesh;
  readonly debug = new DebugOverlay();
  readonly loop: FixedLoop;

  private cmd: InputCommand = emptyCommand();
  private aimX = 0; private aimZ = 1;
  private recoil = 0;
  private visYaw = 0;
  private time = 0;
  private readonly weaponEvents: WeaponEvent[] = [];
  readonly stats = { shots: 0, hits: 0, ticks: 0 };

  constructor(container: HTMLElement, touchLayer: HTMLElement, reloadBtn: HTMLElement, readonly quality: QualityPreset) {
    this.renderer = new Renderer(container, quality);
    this.input = new InputManager(touchLayer, touchLayer, reloadBtn);
    const scene = this.renderer.scene;

    this.props = buildArena(scene, this.physics);
    this.propStart = this.props.map((p) => { const t = p.body.translation(); return new THREE.Vector3(t.x, t.y, t.z); });
    this.player = new Player(1, this.physics, 0, 2);
    scene.add(this.rig.root);

    this.sparks = new ParticleSystem(quality.maxSparks, { emissive: true });
    this.debris = new ParticleSystem(quality.maxSparks + quality.maxCasings, { shadows: false });
    this.tracers = new Tracers(scene);
    this.flash = new MuzzleFlash(scene);
    scene.add(this.sparks.mesh, this.debris.mesh);

    // Faint laser sight (helps aiming with a thumb) and a ground ring so the player pops.
    this.laser = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0.5),
      new THREE.MeshBasicMaterial({ color: 0xff4630, transparent: true, opacity: 0.35, depthWrite: false, toneMapped: false }));
    this.laser.scale.set(0.02, 0.02, 1);
    this.marker = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.52, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x8fe0ff, transparent: true, opacity: 0.45, depthWrite: false }));
    this.marker.position.y = 0.02;
    scene.add(this.laser, this.marker);

    this.wireEffects();
    this.renderer.snapCamera(this.player.x, this.player.z);
    this.loop = new FixedLoop((dt) => this.step(dt), (a, dt) => this.render(a, dt));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.loop.stop(); else this.loop.start();
    });
  }

  start(): void {
    this.sfx.unlock();
    this.loop.start();
  }

  // ───────────────────────────── simulation ─────────────────────────────

  private resolveCommand(raw: RawInput, out: InputCommand): void {
    // Camera is axis-aligned: screen right = +X, screen down = +Z.
    out.moveX = raw.moveX;
    out.moveZ = raw.moveY;
    out.aimX = out.aimZ = 0;
    if (raw.aimStick) {
      out.aimX = raw.aimStick.x; out.aimZ = raw.aimStick.y;
    } else if (raw.aimScreen && this.renderer.screenToGround(raw.aimScreen.x, raw.aimScreen.y, BULLET_HEIGHT, v3)) {
      const dx = v3.x - this.player.x, dz = v3.z - this.player.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.4) { out.aimX = dx / d; out.aimZ = dz / d; }
      else { out.aimX = this.aimX; out.aimZ = this.aimZ; }
    }
    out.fire = raw.fire;
    out.reload = raw.reload;
  }

  private step(dt: number): void {
    this.stats.ticks++;
    this.resolveCommand(this.input.sample(), this.cmd);
    const cmd = this.cmd;
    if (cmd.aimX !== 0 || cmd.aimZ !== 0) { this.aimX = cmd.aimX; this.aimZ = cmd.aimZ; }
    else if (cmd.moveX !== 0 || cmd.moveZ !== 0) {
      const l = Math.hypot(cmd.moveX, cmd.moveZ);
      this.aimX = cmd.moveX / l; this.aimZ = cmd.moveZ / l;
    }

    this.player.update(cmd, dt);
    this.player.weapon.update(dt, cmd.fire, cmd.reload, this.weaponEvents);
    for (const e of this.weaponEvents) {
      const w = this.player.weapon.def.id;
      if (e === 'fired') this.fire();
      else if (e === 'reloadStart') this.events.emit('reloadStart', { weapon: w, time: this.player.weapon.def.reloadTime });
      else if (e === 'reloadEnd') this.events.emit('reloadEnd', { weapon: w });
      else if (e === 'dry') this.events.emit('dryFire', { weapon: w });
    }
    this.physics.step();
  }

  private fire(): void {
    const p = this.player, def = p.weapon.def;
    for (let i = 0; i < def.pellets; i++) {
      const a = Math.atan2(this.aimX, this.aimZ) + (Math.random() * 2 - 1) * def.spread;
      const dx = Math.sin(a), dz = Math.cos(a);
      this.stats.shots++;
      const hit = this.physics.raycast(p.x, BULLET_HEIGHT, p.z, dx, 0, dz, def.range,
        groups(Group.PLAYER, ALL & ~Group.PLAYER & ~Group.DEBRIS), p.collider);
      let ex = p.x + dx * def.range, ez = p.z + dz * def.range, ey = BULLET_HEIGHT;
      if (hit) {
        ex = hit.point.x; ey = hit.point.y; ez = hit.point.z;
        const body = hit.collider.parent();
        const dynamic = !!body && body.isDynamic();
        if (dynamic) {
          this.stats.hits++;
          body!.applyImpulseAtPoint({ x: dx * def.impulse, y: def.impulse * 0.15, z: dz * def.impulse }, hit.point, true);
        }
        this.events.emit('hit', { x: ex, y: ey, z: ez, nx: hit.normal.x, ny: hit.normal.y, nz: hit.normal.z, dynamic });
      }
      this.events.emit('shot', { x: ex, y: ey, z: ez, dx, dz, weapon: def.id });
    }
  }

  // ───────────────────────────── presentation ─────────────────────────────

  private updateLaser(): void {
    this.rig.root.updateMatrixWorld(true);
    this.rig.muzzle.getWorldPosition(v3);
    v3.y = BULLET_HEIGHT; // laser shows the true bullet path
    const dx = Math.sin(this.visYaw), dz = Math.cos(this.visYaw);
    const hit = this.physics.raycast(v3.x, v3.y, v3.z, dx, 0, dz, 25,
      groups(Group.PLAYER, ALL & ~Group.PLAYER & ~Group.DEBRIS), this.player.collider);
    const len = hit ? hit.toi : 25;
    this.laser.position.copy(v3);
    this.laser.rotation.set(0, this.visYaw, 0);
    this.laser.scale.z = len;
  }

  private wireEffects(): void {
    const ev = this.events;
    ev.on('shot', (e) => {
      const def = this.player.weapon.def;
      this.rig.muzzle.getWorldPosition(v3);
      this.flash.fire(v3, this.visYaw);
      this.tracers.spawn(v3, v3b.set(e.x, e.y, e.z));
      this.recoil = Math.min(1, this.recoil + def.recoil);
      this.renderer.addShake(def.shake);
      this.sfx.gunshot();
      this.sfx.casing();
      // Ejected brass casing flies out to the right.
      const rx = -Math.cos(this.visYaw), rz = Math.sin(this.visYaw);
      this.debris.emit(v3.x - e.dx * 0.25, v3.y + 0.05, v3.z - e.dz * 0.25,
        rx * (2 + Math.random()) - e.dx, 2.5 + Math.random() * 1.5, rz * (2 + Math.random()) - e.dz,
        0.05, 2.5, 0xd9a441, 0.45, 14, 0.8, 30);
    });
    ev.on('hit', (e) => {
      // Sparks spray along the surface normal, plus chunky dust/splinters.
      for (let i = 0; i < 7; i++) {
        this.sparks.emit(e.x, e.y, e.z,
          e.nx * 4 + (Math.random() - 0.5) * 5, e.ny * 4 + Math.random() * 3, e.nz * 4 + (Math.random() - 0.5) * 5,
          0.035, 0.18 + Math.random() * 0.15, 0xffc060, 0.3, 18, 2);
      }
      const color = e.dynamic ? 0x8a5a2e : 0x9a968e;
      for (let i = 0; i < 5; i++) {
        this.debris.emit(e.x, e.y, e.z,
          e.nx * 2.5 + (Math.random() - 0.5) * 2.5, 1 + Math.random() * 2.5, e.nz * 2.5 + (Math.random() - 0.5) * 2.5,
          0.05 + Math.random() * 0.06, 0.8 + Math.random() * 0.6, color, 0.3, 12, 1.2);
      }
      this.sfx.impact(!e.dynamic);
    });
    ev.on('reloadStart', () => this.sfx.reloadStart());
    ev.on('reloadEnd', () => this.sfx.reloadEnd());
    ev.on('dryFire', () => this.sfx.dry());
  }

  private render(alpha: number, frameDt: number): void {
    this.time += frameDt;
    const p = this.player;
    const x = lerp(p.prevX, p.x, alpha), z = lerp(p.prevZ, p.z, alpha);
    this.visYaw = p.prevYaw + angleDelta(p.prevYaw, p.yaw) * alpha;

    this.rig.root.position.set(x, 0, z);
    this.rig.root.rotation.y = this.visYaw;
    const speed = p.speed;
    const moveAmt = Math.min(1, speed / PLAYER.moveSpeed);
    const strafe = speed > 0.1 ? angleDelta(this.visYaw, Math.atan2(p.vx, p.vz)) : 0;
    this.recoil *= Math.exp(-14 * frameDt);
    this.rig.pose(p.walkPhase, moveAmt, strafe, this.recoil, this.time);

    this.marker.position.x = x; this.marker.position.z = z;
    this.updateLaser();

    for (const prop of this.props) {
      const t = prop.body.translation(), r = prop.body.rotation();
      prop.mesh.position.set(t.x, t.y, t.z);
      prop.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }

    this.flash.update(frameDt);
    this.tracers.update(frameDt);
    this.sparks.update(frameDt);
    this.debris.update(frameDt);
    this.renderer.updateCamera(x, z, this.aimX, this.aimZ, frameDt);
    this.renderer.render();

    this.hud.update(p.weapon, p.health, PLAYER.maxHealth);
    this.debug.update(frameDt, this.renderer.renderer, {
      physicsMs: this.physics.lastStepMs,
      bodies: this.physics.bodyCount,
      colliders: this.physics.colliderCount,
      particles: this.sparks.active + this.debris.active,
      quality: this.quality.name,
    });
  }

  /** Snapshot for automated tests and the debug console. */
  snapshot() {
    const p = this.player;
    let maxPropMove = 0;
    this.props.forEach((pr, i) => {
      const t = pr.body.translation();
      maxPropMove = Math.max(maxPropMove, Math.hypot(t.x - this.propStart[i].x, t.y - this.propStart[i].y, t.z - this.propStart[i].z));
    });
    return {
      x: p.x, z: p.z, yaw: p.yaw, health: p.health,
      ammo: p.weapon.ammo, reloading: p.weapon.reloading,
      shots: this.stats.shots, propHits: this.stats.hits, ticks: this.stats.ticks,
      maxPropMove,
      fps: this.debug.fps, physicsMs: this.debug.avgPhysicsMs,
      bodies: this.physics.bodyCount,
    };
  }
}
