import * as THREE from 'three';
import { PLAYER, AIM } from './config';
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
import { AimModel } from './weapons/aimModel';
import { settings } from './core/settings';

/** Bullets travel horizontally at this height (zombie chest, crate/barrel tops are 1.2 m). */
const BULLET_HEIGHT = 1.15;
/** Aim line length (m): short enough to stay on screen in portrait. */
const AIM_LINE_LENGTH = 6;
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
  private readonly aimLine: THREE.Mesh;
  private readonly reticle: THREE.Group;
  private readonly ghostLine: THREE.Mesh;
  private readonly cone: THREE.Mesh;
  private readonly marker: THREE.Mesh;
  /** Whether the aim line is currently shown (exposed to tests). */
  aimLineVisible = false;
  readonly debug = new DebugOverlay();
  readonly loop: FixedLoop;

  private cmd: InputCommand = emptyCommand();
  private aimX = 0; private aimZ = 1;
  private aiming = false;
  private stickAim = false;
  private stickMag = 1;
  private stickTarget = 0; // where the thumb points (radians)
  private readonly aim = new AimModel();
  /** Lift-to-fire shot waiting for the aim to arrive at the thumb direction. */
  private pendingShot: { angle: number; t: number } | null = null;
  private recoil = 0;
  private visYaw = 0;
  private time = 0;
  private readonly weaponEvents: WeaponEvent[] = [];
  readonly stats = { shots: 0, hits: 0, ticks: 0, maxImpactSpeed: 0 };

  constructor(container: HTMLElement, touchLayer: HTMLElement, reloadBtn: HTMLElement, switchBtn: HTMLElement, readonly quality: QualityPreset) {
    this.renderer = new Renderer(container, quality);
    this.input = new InputManager(touchLayer, reloadBtn, switchBtn);
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

    // Aim line + reticle. Touch: shown only while the aim stick is past its deadzone.
    // Mouse: always shown (the cursor is always aiming).
    this.aimLine = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0.5),
      new THREE.MeshBasicMaterial({ color: 0xff5a3c, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false }));
    this.aimLine.scale.set(0.035, 0.012, 1);
    this.aimLine.visible = false;
    this.reticle = new THREE.Group();
    const retMat = new THREE.MeshBasicMaterial({ color: 0xff5a3c, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    this.reticle.add(new THREE.Mesh(new THREE.RingGeometry(0.07, 0.09, 16).rotateX(-Math.PI / 2), retMat));
    for (let i = 0; i < 4; i++) {
      const tick = new THREE.Mesh(new THREE.PlaneGeometry(0.02, 0.05).rotateX(-Math.PI / 2).translate(0, 0, 0.12), retMat);
      tick.rotation.y = (i * Math.PI) / 2;
      this.reticle.add(tick);
    }
    this.reticle.visible = false;
    scene.add(this.reticle);
    // Ghost line: where the thumb points (the real aim line swings toward it).
    const lineGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0.5);
    this.ghostLine = new THREE.Mesh(lineGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18, depthWrite: false, toneMapped: false }));
    this.ghostLine.scale.set(0.02, 0.01, 1);
    // Accuracy cone: a very faint filled wedge that widens when moving/turning/firing.
    const coneGeo = new THREE.BufferGeometry();
    coneGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 1, -1, 0, 1], 3));
    this.cone = new THREE.Mesh(coneGeo, new THREE.MeshBasicMaterial({
      color: 0xff7a5c, transparent: true, opacity: 0.08, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
    this.ghostLine.visible = this.cone.visible = false;
    scene.add(this.ghostLine, this.cone);
    this.marker = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.52, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x8fe0ff, transparent: true, opacity: 0.45, depthWrite: false }));
    this.marker.position.y = 0.02;
    scene.add(this.aimLine, this.marker);

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
    out.aiming = out.trigger = out.triggerTap = false;
    const automatic = this.player.weapon.def.automatic;
    this.stickAim = !!raw.aimStick;
    if (raw.aimStick) {
      // Touch: "pull" mode (default) aims opposite the drag, like a slingshot.
      const sgn = settings.aimReverse ? -1 : 1;
      this.stickTarget = Math.atan2(raw.aimStick.x * sgn, raw.aimStick.y * sgn);
      this.stickMag = raw.stickReleased ? 1 : raw.aimStickMag;
      out.aiming = raw.stickAiming;
      out.trigger = automatic && raw.stickFiring; // SMG: inner ring aims, outer ring fires
      // Single-shot: lifting queues a shot that fires once the aim arrives (or after a short wait).
      if (!automatic && raw.stickReleased) this.pendingShot = { angle: this.stickTarget, t: AIM.pendingShotMax };
    } else if (raw.aimScreen && this.renderer.screenToGround(raw.aimScreen.x, raw.aimScreen.y, BULLET_HEIGHT, v3)) {
      const dx = v3.x - this.player.x, dz = v3.z - this.player.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.4) { out.aimX = dx / d; out.aimZ = dz / d; }
      else { out.aimX = this.aimX; out.aimZ = this.aimZ; }
      out.aiming = true;
      out.trigger = raw.mouseHeld;
      out.triggerTap = raw.mousePressed;
    }
    out.reload = raw.reload;
    out.switchWeapon = raw.switchWeapon;
  }

  private step(dt: number): void {
    this.stats.ticks++;
    this.resolveCommand(this.input.sample(), this.cmd);
    const cmd = this.cmd;
    if (cmd.switchWeapon !== null) { this.player.switchWeapon(cmd.switchWeapon); this.pendingShot = null; }
    const def = this.player.weapon.def;

    // ── Aim with inertia (touch) or direct (mouse); remembered between drags.
    const turning = this.stickAim || this.pendingShot !== null;
    if (turning) {
      const target = this.pendingShot ? this.pendingShot.angle : this.stickTarget;
      this.aim.turnToward(target, this.pendingShot ? 1 : this.stickMag, def, dt);
    } else if (cmd.aimX !== 0 || cmd.aimZ !== 0) {
      this.aim.set(Math.atan2(cmd.aimX, cmd.aimZ), dt);
    } else {
      this.aim.hold(dt);
    }
    if (turning || cmd.aimX !== 0 || cmd.aimZ !== 0) { cmd.aimX = this.aim.x; cmd.aimZ = this.aim.z; }
    this.aimX = this.aim.x; this.aimZ = this.aim.z;
    if (this.pendingShot) {
      this.pendingShot.t -= dt;
      cmd.aiming = true; // keep the line up while the shot is pending
      if (this.aim.errorTo(this.pendingShot.angle) < AIM.arriveTolerance || this.pendingShot.t <= 0) {
        cmd.triggerTap = true;
        this.pendingShot = null;
      }
    }
    this.aiming = cmd.aiming;

    this.player.update(cmd, dt);
    this.aim.updateBloom(def, Math.min(1, this.player.speed / PLAYER.moveSpeed), dt);
    this.player.weapon.update(dt, cmd.trigger, cmd.triggerTap, cmd.reload, this.weaponEvents);
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
    const spread = this.aim.spread(def); // accuracy depends on movement, turning and recoil
    for (let i = 0; i < def.pellets; i++) {
      // Gaussian-ish spread (sum of two uniforms): most shots near the centre, few at the edge.
      const a = this.aim.angle + ((Math.random() + Math.random()) - 1) * spread;
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
          const v = body!.linvel();
          this.stats.maxImpactSpeed = Math.max(this.stats.maxImpactSpeed, Math.hypot(v.x, v.y, v.z));
        }
        this.events.emit('hit', { x: ex, y: ey, z: ez, nx: hit.normal.x, ny: hit.normal.y, nz: hit.normal.z, dynamic });
      }
      this.events.emit('shot', { x: ex, y: ey, z: ez, dx, dz, weapon: def.id });
    }
    this.aim.onShot(def);
  }

  // ───────────────────────────── presentation ─────────────────────────────

  /** Aim line from the player along the exact aim direction, ending in a reticle at the first obstacle. */
  private updateAimLine(px: number, pz: number): void {
    const show = this.aiming;
    this.aimLineVisible = show;
    this.aimLine.visible = this.reticle.visible = this.cone.visible = show;
    this.ghostLine.visible = show && this.stickAim && this.aim.errorTo(this.stickTarget) > 0.03;
    if (!show) return;
    const dx = this.aimX, dz = this.aimZ;
    const ox = px + dx * 0.45, oz = pz + dz * 0.45;
    const maxLen = Math.min(AIM_LINE_LENGTH, this.player.weapon.def.range);
    const hit = this.physics.raycast(ox, BULLET_HEIGHT, oz, dx, 0, dz, maxLen,
      groups(Group.PLAYER, ALL & ~Group.PLAYER & ~Group.DEBRIS), this.player.collider);
    const len = hit ? hit.toi : maxLen;
    this.aimLine.position.set(ox, BULLET_HEIGHT, oz);
    this.aimLine.rotation.set(0, Math.atan2(dx, dz), 0);
    this.aimLine.scale.z = len;
    const yaw = Math.atan2(dx, dz);
    const spread = this.aim.spread(this.player.weapon.def);
    this.cone.position.set(ox, BULLET_HEIGHT - 0.005, oz);
    this.cone.rotation.set(0, yaw, 0);
    this.cone.scale.set(Math.max(0.01, Math.tan(spread) * len), 1, len);
    if (this.ghostLine.visible) {
      this.ghostLine.position.set(ox, BULLET_HEIGHT - 0.01, oz);
      this.ghostLine.rotation.set(0, this.stickTarget, 0);
      this.ghostLine.scale.z = maxLen;
    }
    this.reticle.position.set(ox + dx * len, BULLET_HEIGHT + 0.02, oz + dz * len);
    this.reticle.rotation.y += 0.04;
    // Reticle size shows current accuracy at that distance.
    const s = Math.max(0.8, Math.min(1.6, (spread * len) / 0.1)) * (1 + 0.05 * Math.sin(this.time * 10));
    this.reticle.scale.set(s, s, s);
  }

  private wireEffects(): void {
    const ev = this.events;
    ev.on('shot', (e) => {
      const def = this.player.weapon.def;
      this.rig.muzzle.getWorldPosition(v3);
      // SMG: every 3rd round blooms a bigger flash so sustained fire flickers like a real muzzle.
      const big = def.automatic && this.stats.shots % 3 === 0;
      this.flash.fire(v3, this.visYaw, def.automatic ? (big ? 1.6 : 0.8) : 1);
      this.tracers.spawn(v3, v3b.set(e.x, e.y, e.z));
      this.recoil = Math.min(1, this.recoil + def.recoil);
      this.renderer.addShake(def.shake);
      if (def.id === 'smg') this.sfx.smgShot(); else this.sfx.gunshot();
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
    this.updateAimLine(x, z);

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
      ammo: p.weapon.ammo, reloading: p.weapon.reloading, weapon: p.weapon.def.id,
      aimLineVisible: this.aimLineVisible, aimX: this.aimX, aimZ: this.aimZ, bloom: this.aim.bloom,
      shots: this.stats.shots, propHits: this.stats.hits, ticks: this.stats.ticks,
      maxPropMove, maxImpactSpeed: this.stats.maxImpactSpeed,
      fps: this.debug.fps, physicsMs: this.debug.avgPhysicsMs,
      bodies: this.physics.bodyCount,
    };
  }
}
