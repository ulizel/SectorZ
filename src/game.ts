import * as THREE from 'three';
import { PLAYER, AIM, SIM_DT } from './config';
import { EventBus } from './core/events';
import { FixedLoop } from './core/loop';
import { lerp, angleDelta } from './core/math';
import type { QualityPreset } from './core/quality';
import { Sfx } from './audio/sfx';
import { emptyCommand, type InputCommand, type RawInput } from './input/commands';
import { InputManager } from './input/inputManager';
import { Player } from './entities/player';
import { ZombieManager } from './entities/zombieManager';
import type { Zombie } from './entities/zombie';
import { ZombieView } from './render/zombieView';
import { Group, groups, ALL, PhysicsWorld, MATERIAL_COST } from './physics/physicsWorld';
import { Renderer } from './render/renderer';
import { HumanoidRig, SURVIVOR_LOOK } from './render/humanoidRig';
import { BulletHoles, MuzzleFlash, ParticleSystem, Tracers } from './render/effects';
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
  readonly stats = { shots: 0, hits: 0, ticks: 0, maxImpactSpeed: 0, penetrations: 0, activeReloads: 0, zombieHits: 0, kills: 0, dismembers: 0 };
  private readonly penSkip = new Set<number>();
  private readonly holes: BulletHoles;
  private readonly hitMarker = document.getElementById('hitmarker')!;
  private hitMarkerT = 0;
  private readonly retMat: THREE.MeshBasicMaterial;

  readonly zombies: ZombieManager;
  private readonly zombieViews = new Map<Zombie, ZombieView>();
  private readonly sinking: ZombieView[] = [];
  lab = false;

  constructor(container: HTMLElement, touchLayer: HTMLElement, reloadBtn: HTMLElement, switchBtn: HTMLElement, readonly quality: QualityPreset) {
    this.zombies = new ZombieManager(this.physics, quality.name === 'mobile'
      ? { maxRagdolls: 6, maxLooseLimbs: 20, corpseLife: 25 }
      : { maxRagdolls: 12, maxLooseLimbs: 40, corpseLife: 40 });
    this.renderer = new Renderer(container, quality);
    this.input = new InputManager(touchLayer, reloadBtn, switchBtn);
    const scene = this.renderer.scene;

    this.props = buildArena(scene, this.physics);
    this.propStart = this.props.map((p) => { const t = p.body.translation(); return new THREE.Vector3(t.x, t.y, t.z); });
    this.player = new Player(1, this.physics, 0, 2);
    scene.add(this.rig.root);

    this.sparks = new ParticleSystem(quality.maxSparks, { emissive: true });
    this.debris = new ParticleSystem(quality.maxSparks * 2 + quality.maxCasings, { shadows: false });
    this.tracers = new Tracers(scene);
    this.flash = new MuzzleFlash(scene);
    this.holes = new BulletHoles(scene);
    scene.add(this.sparks.mesh, this.debris.mesh);

    // Aim line + reticle. Touch: shown only while the aim stick is past its deadzone.
    // Mouse: always shown (the cursor is always aiming).
    this.aimLine = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0.5),
      new THREE.MeshBasicMaterial({ color: 0xff5a3c, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false }));
    this.aimLine.scale.set(0.035, 0.012, 1);
    this.aimLine.visible = false;
    this.reticle = new THREE.Group();
    const retMat = new THREE.MeshBasicMaterial({ color: 0xff5a3c, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    this.retMat = retMat;
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
    this.zombies.update(dt);
    this.aim.updateBloom(def, Math.min(1, this.player.speed / PLAYER.moveSpeed), dt);
    this.player.weapon.update(dt, cmd.trigger, cmd.triggerTap, cmd.reload, this.weaponEvents);
    for (const e of this.weaponEvents) {
      const w = this.player.weapon.def.id;
      if (e === 'fired') this.fire();
      else if (e === 'reloadStart') this.events.emit('reloadStart', { weapon: w, time: this.player.weapon.def.reloadTime });
      else if (e === 'reloadEnd') this.events.emit('reloadEnd', { weapon: w });
      else if (e === 'dry') this.events.emit('dryFire', { weapon: w });
      else if (e === 'activeReload') { this.stats.activeReloads++; this.events.emit('activeReload', { weapon: w, success: true }); }
      else if (e === 'reloadFumble') this.events.emit('activeReload', { weapon: w, success: false });
    }
    this.physics.step();
  }

  private fire(): void {
    const p = this.player, def = p.weapon.def;
    const spread = this.aim.spread(def); // accuracy depends on stance, turning, recoil, steadiness
    const filter = groups(Group.PLAYER, ALL & ~Group.PLAYER & ~Group.DEBRIS);
    for (let i = 0; i < def.pellets; i++) {
      // Gaussian-ish spread (sum of two uniforms): most shots near the centre, few at the edge.
      const a = this.aim.angle + ((Math.random() + Math.random()) - 1) * spread;
      const dx = Math.sin(a), dz = Math.cos(a);
      this.stats.shots++;
      // Penetration: the bullet keeps going through soft materials while it has power left.
      let power = def.penetration;
      let ox = p.x, oz = p.z, travelled = 0;
      let ex = p.x + dx * def.range, ez = p.z + dz * def.range, ey = BULLET_HEIGHT;
      this.penSkip.clear();
      for (let seg = 0; seg < 4; seg++) {
        const hit = this.physics.raycast(ox, BULLET_HEIGHT, oz, dx, 0, dz, def.range - travelled, filter, p.collider, this.penSkip);
        if (!hit) { ex = ox + dx * (def.range - travelled); ez = oz + dz * (def.range - travelled); break; }
        ex = hit.point.x; ey = hit.point.y; ez = hit.point.z;
        const material = this.physics.materialOf(hit.collider);
        const cost = MATERIAL_COST[material];
        const penetrated = power >= cost;
        const body = hit.collider.parent();
        // Force scales with the bullet's remaining power (a bullet that punches through transfers less).
        const force = def.impulse * (penetrated ? 0.55 : 1) * Math.min(1, power / def.penetration + 0.3);
        const zr = material === 'flesh'
          ? this.zombies.hit(hit.collider, def.damage * Math.min(1, power / def.penetration + 0.3),
            dx * force, force * 0.25, dz * force, ex, ey, ez, SIM_DT)
          : null;
        const dynamic = !!zr || (!!body && body.isDynamic());
        if (zr) {
          this.stats.zombieHits++;
          if (zr.severed >= 0) {
            const sp = zr.zombie.parts[zr.severed].body.translation();
            this.stats.dismembers++;
            this.events.emit('dismember', { x: sp.x, y: sp.y, z: sp.z, dx, dz });
          }
          if (zr.killed) { this.stats.kills++; this.events.emit('zombieKilled', { x: ex, y: ey, z: ez }); }
        } else if (dynamic) {
          this.stats.hits++;
          body!.applyImpulseAtPoint({ x: dx * force, y: force * 0.15, z: dz * force }, hit.point, true);
          const v = body!.linvel();
          this.stats.maxImpactSpeed = Math.max(this.stats.maxImpactSpeed, Math.hypot(v.x, v.y, v.z));
        }
        this.events.emit('hit', { x: ex, y: ey, z: ez, nx: hit.normal.x, ny: hit.normal.y, nz: hit.normal.z, dynamic, material, penetrated });
        if (!penetrated) break;
        this.stats.penetrations++;
        power -= cost;
        this.penSkip.add(hit.collider.handle);
        travelled += hit.toi;
        ox = ex; oz = ez;
      }
      this.events.emit('shot', { x: ex, y: ey, z: ez, dx, dz, weapon: def.id });
      // Recoil shoves the shooter back a little (decays through the movement controller).
      p.vx -= dx * def.pushback; p.vz -= dz * def.pushback;
    }
    this.aim.onShot(def, p.weapon.burst);
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
    if (this.hitMarkerT > 0) {
      v3.copy(this.reticle.position).project(this.renderer.camera);
      this.hitMarker.style.transform = `translate(${(v3.x + 1) / 2 * innerWidth}px, ${(1 - v3.y) / 2 * innerHeight}px)`;
    }
    // Steady-aim: reticle shifts from red to bright white as the shot settles.
    this.retMat.color.setRGB(1, 0.35 + 0.65 * this.aim.steady, 0.24 + 0.76 * this.aim.steady);
  }

  private wireEffects(): void {
    const ev = this.events;
    ev.on('shot', (e) => {
      const def = this.player.weapon.def;
      this.rig.muzzle.getWorldPosition(v3);
      // SMG: every 3rd round blooms a bigger flash so sustained fire flickers like a real muzzle.
      const big = def.automatic && this.stats.shots % 3 === 0;
      this.flash.fire(v3, this.visYaw, def.automatic ? (big ? 1.6 : 0.8) : 1);
      // Tracers: every pistol round, every 3rd SMG round (like real tracer ammo loading).
      if (!def.automatic || big) this.tracers.spawn(v3, v3b.set(e.x, e.y, e.z));
      this.recoil = Math.min(1, this.recoil + def.recoil);
      this.renderer.addShake(def.shake);
      if (def.id === 'smg') this.sfx.smgShot(); else this.sfx.gunshot();
      if (def.casingSound) this.sfx.casing();
      // Muzzle smoke: slow grey puffs drifting up.
      for (let i = 0; i < (def.automatic ? 1 : 3); i++) {
        this.debris.emit(v3.x + e.dx * 0.1, v3.y, v3.z + e.dz * 0.1,
          e.dx * 0.8 + (Math.random() - 0.5) * 0.4, 0.4 + Math.random() * 0.3, e.dz * 0.8 + (Math.random() - 0.5) * 0.4,
          0.1 + Math.random() * 0.08, 0.7 + Math.random() * 0.4, 0x8b8f94, 0, -0.6, 2.5, 2);
      }
      // Ejected brass casing flies out to the right and stays on the ground a while.
      const rx = -Math.cos(this.visYaw), rz = Math.sin(this.visYaw);
      this.debris.emit(v3.x - e.dx * 0.25, v3.y + 0.05, v3.z - e.dz * 0.25,
        rx * (2 + Math.random()) - e.dx, 2.5 + Math.random() * 1.5, rz * (2 + Math.random()) - e.dz,
        0.05, 6, 0xd9a441, 0.45, 14, 0.8, 30);
    });
    ev.on('hit', (e) => {
      const m = e.material;
      // Sparks: lots on metal, a few on concrete, none on wood (splinters instead).
      const sparks = m === 'metal' ? 12 : m === 'concrete' ? 5 : 0;
      for (let i = 0; i < sparks; i++) {
        this.sparks.emit(e.x, e.y, e.z,
          e.nx * 4 + (Math.random() - 0.5) * 5, e.ny * 4 + Math.random() * 3, e.nz * 4 + (Math.random() - 0.5) * 5,
          0.035, 0.18 + Math.random() * 0.15, m === 'metal' ? 0xffe08a : 0xffc060, 0.3, 18, 2);
      }
      if (m === 'flesh') {
        // Blood: a spray in the bullet's direction plus a fine mist; no bullet holes on bodies.
        for (let i = 0; i < 10; i++) {
          this.debris.emit(e.x, e.y, e.z, -e.nx * (1.5 + Math.random() * 2.5) + (Math.random() - 0.5) * 2, 0.5 + Math.random() * 2,
            -e.nz * (1.5 + Math.random() * 2.5) + (Math.random() - 0.5) * 2, 0.03 + Math.random() * 0.05, 0.9 + Math.random() * 0.6,
            Math.random() < 0.6 ? 0x8a0e12 : 0x5c070a, 0.05, 12, 1);
        }
        for (let i = 0; i < 3; i++) this.debris.emit(e.x, e.y, e.z, (Math.random() - 0.5) * 0.8, Math.random() * 0.5, (Math.random() - 0.5) * 0.8,
          0.1 + Math.random() * 0.06, 0.35, 0xa01418, 0, 1, 4, 2);
        this.sfx.impact(m);
        this.hitMarker.classList.remove('on');
        void this.hitMarker.offsetWidth;
        this.hitMarker.classList.add('on');
        this.hitMarkerT = 0.15;
        this.renderer.addShake(0.06);
        return;
      }
      const color = m === 'wood' ? 0x9a6a38 : m === 'metal' ? 0x5d6168 : 0x9a968e;
      const chunks = m === 'wood' ? 9 : 5;
      for (let i = 0; i < chunks; i++) {
        this.debris.emit(e.x, e.y, e.z,
          e.nx * 2.5 + (Math.random() - 0.5) * 2.5, 1 + Math.random() * 2.5, e.nz * 2.5 + (Math.random() - 0.5) * 2.5,
          (m === 'wood' ? 0.04 : 0.05) + Math.random() * 0.06, 0.8 + Math.random() * 0.6, color, 0.3, 12, 1.2);
      }
      // Dust puff on concrete.
      if (m === 'concrete') {
        for (let i = 0; i < 3; i++) this.debris.emit(e.x, e.y, e.z, e.nx * 0.8 + (Math.random() - 0.5) * 0.6, 0.3 + Math.random() * 0.4,
          e.nz * 0.8 + (Math.random() - 0.5) * 0.6, 0.12 + Math.random() * 0.08, 0.6, 0xb0aba2, 0, -0.3, 3, 2);
      }
      if (!e.dynamic) this.holes.add(e.x, e.y, e.z, e.nx, e.ny, e.nz);
      this.sfx.impact(m);
      if (e.dynamic) {
        // Hit confirmation: marker on the reticle + a small camera punch.
        this.hitMarker.classList.remove('on');
        void this.hitMarker.offsetWidth; // restart the CSS pop animation
        this.hitMarker.classList.add('on');
        this.hitMarkerT = 0.15;
        this.renderer.addShake(0.08);
      }
    });
    ev.on('reloadStart', () => {
      this.sfx.reloadStart();
      // Empty magazine drops out of the gun.
      this.rig.muzzle.getWorldPosition(v3);
      this.debris.emit(v3.x, v3.y - 0.1, v3.z, (Math.random() - 0.5) * 0.6, -0.5, (Math.random() - 0.5) * 0.6,
        0.09, 5, 0x2b2d31, 0.25, 14, 0.8, 6);
    });
    ev.on('reloadEnd', () => this.sfx.reloadEnd());
    ev.on('dismember', (e) => {
      // Big gore burst where the limb tore off.
      for (let i = 0; i < 26; i++) {
        this.debris.emit(e.x, e.y, e.z, e.dx * 2 + (Math.random() - 0.5) * 5, 1 + Math.random() * 4, e.dz * 2 + (Math.random() - 0.5) * 5,
          0.04 + Math.random() * 0.08, 1.2 + Math.random() * 1.2, Math.random() < 0.6 ? 0x8a0e12 : 0x4a0608, 0.15, 14, 0.8);
      }
      this.sfx.dismember();
      this.renderer.addShake(0.15);
    });
    ev.on('explosion', (e) => {
      this.flash.fire(v3.set(e.x, e.y + 0.6, e.z), 0, 6);
      this.renderer.addShake(0.9);
      this.sfx.explosion();
      for (let i = 0; i < 40; i++) {
        const a = Math.random() * Math.PI * 2, s = 3 + Math.random() * 9;
        this.sparks.emit(e.x, e.y + 0.2, e.z, Math.cos(a) * s, 2 + Math.random() * 7, Math.sin(a) * s, 0.06, 0.3 + Math.random() * 0.4, Math.random() < 0.5 ? 0xffb347 : 0xffe08a, 0.3, 14, 1);
      }
      for (let i = 0; i < 18; i++) {
        const a = Math.random() * Math.PI * 2, s = 0.5 + Math.random() * 1.5;
        this.debris.emit(e.x, e.y + 0.3, e.z, Math.cos(a) * s, 0.8 + Math.random() * 1.2, Math.sin(a) * s,
          0.35 + Math.random() * 0.35, 1.2 + Math.random() * 0.8, Math.random() < 0.5 ? 0x3a3a3c : 0x58585a, 0, -0.8, 1.5, 1);
      }
      for (let i = 0; i < 14; i++) {
        const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 5;
        this.debris.emit(e.x, e.y + 0.1, e.z, Math.cos(a) * s, 3 + Math.random() * 5, Math.sin(a) * s,
          0.06 + Math.random() * 0.1, 2, 0x6e6b66, 0.3, 14, 0.5);
      }
      this.holes.add(e.x, 0.005, e.z, 0, 1, 0); // scorch mark
    });
    ev.on('activeReload', (e) => this.sfx.activeReload(e.success));
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
    this.rig.pose(p.walkPhase, moveAmt, strafe, this.recoil, this.time, p.weapon.reloadProgress);

    this.marker.position.x = x; this.marker.position.z = z;
    this.updateAimLine(x, z);

    this.syncZombieViews(frameDt);

    for (const prop of this.props) {
      const t = prop.body.translation(), r = prop.body.rotation();
      prop.mesh.position.set(t.x, t.y, t.z);
      prop.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }

    this.flash.update(frameDt);
    this.tracers.update(frameDt);
    this.holes.update(frameDt);
    if (this.hitMarkerT > 0) { this.hitMarkerT -= frameDt; if (this.hitMarkerT <= 0) this.hitMarker.classList.remove('on'); }
    this.sparks.update(frameDt);
    this.debris.update(frameDt);
    this.renderer.updateCamera(x, z, this.aimX, this.aimZ, frameDt);
    this.renderer.render();

    this.hud.update(p.weapon, p.health, PLAYER.maxHealth);
    this.debug.update(frameDt, this.renderer.renderer, {
      physicsMs: this.physics.lastStepMs,
      ragdolls: this.zombies.ragdollCount,
      zombies: this.zombies.zombies.length,
      bodies: this.physics.bodyCount,
      colliders: this.physics.colliderCount,
      particles: this.sparks.active + this.debris.active,
      quality: this.quality.name,
    });
  }

  private syncZombieViews(dt: number): void {
    const zm = this.zombies;
    for (const z of zm.spawned) this.zombieViews.set(z, new ZombieView(this.renderer.scene, z));
    zm.spawned.length = 0;
    for (const z of zm.removed) {
      const view = this.zombieViews.get(z);
      if (view) { this.zombieViews.delete(z); this.sinking.push(view); }
    }
    zm.removed.length = 0;
    for (const view of this.zombieViews.values()) view.update();
    for (let i = this.sinking.length - 1; i >= 0; i--) if (this.sinking[i].sinkStep(dt)) this.sinking.splice(i, 1);
    // Severed stumps spurt blood for a moment.
    for (const b of zm.bleeders) {
      if (Math.random() > 0.55) continue;
      const t = b.body.translation(), r = b.body.rotation();
      v3.copy(b.local).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w)).add(v3b.set(t.x, t.y, t.z));
      const lv = b.body.linvel();
      this.debris.emit(v3.x, v3.y, v3.z, lv.x * 0.5 + (Math.random() - 0.5) * 1.5, lv.y * 0.5 + Math.random() * 1.5,
        lv.z * 0.5 + (Math.random() - 0.5) * 1.5, 0.04 + Math.random() * 0.04, 1.5, Math.random() < 0.5 ? 0x8a0e12 : 0x5c070a, 0.1, 12, 0.6);
    }
  }

  /** Spawn a ring of test zombies in front of the player (Ragdoll Lab). */
  spawnZombies(n = 5): void {
    const p = this.player;
    for (let i = 0; i < n; i++) {
      const a = Math.atan2(this.aimX, this.aimZ) + (i - (n - 1) / 2) * 0.32;
      const d = 5 + (i % 2) * 1.2;
      this.zombies.spawn(p.x + Math.sin(a) * d, p.z + Math.cos(a) * d, a + Math.PI);
    }
  }

  /** Explosion where the player is aiming (up to 6 m ahead, or at the first obstacle). */
  explodeAtAim(): void {
    const p = this.player;
    const hit = this.physics.raycast(p.x, 0.6, p.z, this.aimX, 0, this.aimZ, 6,
      groups(Group.PLAYER, Group.STATIC | Group.PROP), p.collider);
    const d = hit ? Math.max(1.5, hit.toi - 0.3) : 6;
    this.explode(p.x + this.aimX * d, 0.3, p.z + this.aimZ * d);
  }

  explode(x: number, y: number, z: number, radius = 5): void {
    const dt = SIM_DT;
    const before = this.zombies.ragdollCount;
    const torn = this.zombies.explode(x, y, z, radius, 160, 45, dt);
    this.stats.dismembers += torn;
    this.stats.kills += Math.max(0, this.zombies.ragdollCount - before);
    for (const prop of this.props) {
      const t = prop.body.translation();
      let dx = t.x - x, dz = t.z - z;
      const d = Math.max(0.5, Math.hypot(dx, dz));
      if (d > radius) continue;
      const f = (1 - d / radius) * 220;
      dx /= d; dz /= d;
      prop.body.applyImpulse({ x: dx * f, y: f * 0.8, z: dz * f }, true);
      prop.body.applyTorqueImpulse({ x: (Math.random() - 0.5) * f * 0.3, y: 0, z: (Math.random() - 0.5) * f * 0.3 }, true);
    }
    this.events.emit('explosion', { x, y, z, radius });
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
      maxPropMove, maxImpactSpeed: this.stats.maxImpactSpeed, penetrations: this.stats.penetrations,
      activeReloads: this.stats.activeReloads, steady: this.aim.steady,
      zombiesAlive: this.zombies.aliveCount, ragdolls: this.zombies.ragdollCount, severed: this.zombies.severedCount,
      zombieHits: this.stats.zombieHits, kills: this.stats.kills, dismembers: this.stats.dismembers,
      fps: this.debug.fps, physicsMs: this.debug.avgPhysicsMs,
      bodies: this.physics.bodyCount,
    };
  }
}
