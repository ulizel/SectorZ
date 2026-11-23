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
import { ZombieRenderer } from './render/zombieRenderer';
import { ZombieAI, AI as AI_CFG, type AttackResult } from './ai/zombieAI';
import { ARENA } from './config';
import { WaveDirector, type WaveEvent } from './systems/waves';
import { Pickups, LOOT, type PickupKind } from './systems/pickups';
import { Group, groups, ALL, PhysicsWorld, MATERIAL_COST, type RayHit } from './physics/physicsWorld';
import { BulletViews, type BulletVisual } from './render/bulletViews';
import type { WeaponDef } from './weapons/weapon';
import { Renderer } from './render/renderer';
import { HumanoidRig, SURVIVOR_LOOK } from './render/humanoidRig';
import { BulletHoles, MuzzleFlash, ParticleSystem } from './render/effects';
import { buildArena, spawnBarrel, type DynamicProp } from './world/arena';
import { Hud } from './ui/hud';
import { DebugOverlay } from './ui/debugOverlay';
import type { WeaponEvent } from './weapons/weapon';
import { AimModel } from './weapons/aimModel';
import { GRENADE, throwVelocity, spawnGrenade, stepGrenade, hitZombie, flightTime, type Grenade } from './weapons/grenade';
import { settings } from './core/settings';

/** Bullets travel horizontally at this height (zombie chest, crate/barrel tops are 1.2 m). */
const BULLET_HEIGHT = 1.15;
/** Aim line length (m): short enough to stay on screen in portrait. */
const AIM_LINE_LENGTH = 6;
const v3 = new THREE.Vector3();
const v3b = new THREE.Vector3();
const m4 = new THREE.Matrix4();
/** Dots in the grenade arc preview. */
const ARC_DOTS = 22;

/** A bullet in flight (simulation). */
interface Bullet extends BulletVisual { def: WeaponDef; power: number; skip: Set<number> }

/** Player damage at the centre of a barrel blast (falls off to 0 at the edge). */
const EXPLOSION_PLAYER_DAMAGE = 70;

const BEST_KEY = 'sectorz.best';
function loadBest(): { wave: number; kills: number } {
  try { return { wave: 0, kills: 0, ...JSON.parse(localStorage.getItem(BEST_KEY) ?? '{}') }; } catch { return { wave: 0, kills: 0 }; }
}
function saveBest(b: { wave: number; kills: number }): void { try { localStorage.setItem(BEST_KEY, JSON.stringify(b)); } catch { /* ignore */ } }

export class Game {
  readonly events = new EventBus();
  readonly physics = new PhysicsWorld();
  readonly renderer: Renderer;
  readonly input: InputManager;
  readonly sfx = new Sfx();
  readonly player: Player;
  readonly rig = new HumanoidRig(SURVIVOR_LOOK);
  readonly props: DynamicProp[];
  private readonly propStart = new Map<DynamicProp, THREE.Vector3>();
  private readonly sparks: ParticleSystem;
  private readonly debris: ParticleSystem;
  private readonly flash: MuzzleFlash;
  private readonly hud = new Hud();
  private readonly aimLine: THREE.Mesh;
  private readonly reticle: THREE.Group;
  private readonly ghostLine: THREE.Mesh;
  private readonly cone: THREE.Mesh;
  private readonly marker: THREE.Mesh;
  /** Grenade throw preview: dotted arc + blast-radius ring at the landing point. */
  private readonly arcDots: THREE.InstancedMesh;
  private readonly blastRing: THREE.Mesh;
  private readonly grenadeMeshes: THREE.Mesh[] = [];
  private readonly grenadeGeo = new THREE.BoxGeometry(GRENADE.half * 2, GRENADE.half * 2.6, GRENADE.half * 2);
  private readonly grenadeMat = new THREE.MeshLambertMaterial({ color: 0x4a5a32 });
  private readonly grenadeLightGeo = new THREE.BoxGeometry(0.06, 0.04, 0.06).translate(0, GRENADE.half * 1.3 + 0.02, 0);
  private readonly grenadeLightMat = new THREE.MeshBasicMaterial({ color: 0xff2a1a, toneMapped: false });
  /** Whether the aim line is currently shown (exposed to tests). */
  aimLineVisible = false;
  readonly debug = new DebugOverlay();
  readonly loop: FixedLoop;

  private cmd: InputCommand = emptyCommand();
  private aimX = 0; private aimZ = 1;
  private aiming = false;
  private stickAim = false;
  private stickMag = 1;
  private stickHeld = 0; // s the aim stick has been dragging (ease-in)
  private stickTarget = 0; // where the thumb points (radians)
  private readonly aim = new AimModel();
  private stickFiring = false;
  private recoil = 0;
  private visYaw = 0;
  private time = 0;
  private readonly weaponEvents: WeaponEvent[] = [];
  /** Live grenades (simulation). */
  readonly grenades: Grenade[] = [];
  private grenadeMode = false;
  private throwX = 0; private throwZ = 0;
  private grenadeWanted = false; // armed last tick (for the "no grenades" toast edge)
  readonly stats = { grenadesThrown: 0, grenadeBlasts: 0, shots: 0, hits: 0, ticks: 0, maxImpactSpeed: 0, penetrations: 0, activeReloads: 0, zombieHits: 0, kills: 0, dismembers: 0, damageTaken: 0, wave: 0, barrels: 0 };
  private readonly bullets: Bullet[] = [];
  private readonly bulletViews: BulletViews;
  private readonly holes: BulletHoles;
  private readonly blood: BulletHoles;
  private readonly impacts: import('./entities/zombieManager').ImpactResult[] = [];
  private thudCooldown = 0;
  private readonly hitMarker = document.getElementById('hitmarker')!;
  private hitMarkerT = 0;
  private readonly retMat: THREE.MeshBasicMaterial;

  readonly zombies: ZombieManager;
  private readonly zombieRenderer: ZombieRenderer;
  readonly ai: ZombieAI;
  private readonly attacks: AttackResult[] = [];
  /** Survival mode (PLAY): keep a trickle of hunting zombies coming. Off in the Lab / tests. */
  survival = true;
  readonly waves = new WaveDirector();
  private readonly waveEvents: WaveEvent[] = [];
  pickups!: Pickups;
  private hurtT = 0;
  private readonly hurtEl = document.getElementById('hurt')!;
  private readonly deadEl = document.getElementById('dead')!;
  private deathShown = false;
  lab = false;

  constructor(container: HTMLElement, touchLayer: HTMLElement, reloadBtn: HTMLElement, switchBtn: HTMLElement, grenadeBtn: HTMLElement,
    readonly quality: QualityPreset) {
    this.zombies = new ZombieManager(this.physics, quality.name === 'mobile'
      ? { maxRagdolls: 6, maxLooseLimbs: 24, maxCorpses: 16, corpseLife: 60 }
      : { maxRagdolls: 12, maxLooseLimbs: 48, maxCorpses: 32, corpseLife: 90 });
    this.renderer = new Renderer(container, quality);
    this.input = new InputManager(touchLayer, reloadBtn, switchBtn, grenadeBtn);
    const scene = this.renderer.scene;

    this.props = buildArena(scene, this.physics);
    this.ai = new ZombieAI(this.physics, ARENA.size);
    this.ai.props = this.props;
    this.zombieRenderer = new ZombieRenderer(scene);
    this.pickups = new Pickups(scene);
    void ({} as Zombie);
    for (const p of this.props) { const t = p.body.translation(); this.propStart.set(p, new THREE.Vector3(t.x, t.y, t.z)); }
    this.player = new Player(1, this.physics, 0, 2);
    scene.add(this.rig.root);

    this.sparks = new ParticleSystem(quality.maxSparks, { emissive: true });
    this.debris = new ParticleSystem(quality.maxSparks * 2 + quality.maxCasings, { shadows: false });
    this.flash = new MuzzleFlash(scene);
    this.holes = new BulletHoles(scene);
    this.bulletViews = new BulletViews(scene);
    this.blood = new BulletHoles(scene, quality.name === 'mobile' ? 40 : 80, 0x5c070a, 0.32, 30, 0.8);
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
    this.arcDots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.05, 6, 4),
      new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false }), ARC_DOTS);
    this.arcDots.frustumCulled = false;
    this.blastRing = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false }));
    this.blastRing.add(new THREE.Mesh(new THREE.CircleGeometry(0.06, 16).rotateX(-Math.PI / 2), this.blastRing.material));
    this.arcDots.visible = this.blastRing.visible = false;
    scene.add(this.arcDots, this.blastRing);

    this.wireEffects();
    this.renderer.snapCamera(this.player.x, this.player.z);
    this.loop = new FixedLoop((dt) => this.step(dt), (a, dt) => this.render(a, dt));
    // Hidden tab: stop the loop. Resuming is left to the pause menu (it opens on hide).
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.loop.stop(); });
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
    this.stickFiring = raw.stickFiring;
    const grenade = raw.grenadeArmed || raw.grenadeThrow;
    if (raw.stickActive && !grenade) {
      // Touch: dragging aims; a tap (or the start of a hold) fires once; holding keeps
      // automatic weapons firing. The aim line shows while a thumb is down.
      if (raw.aimStick) {
        const sgn = settings.aimReverse ? -1 : 1;
        this.stickTarget = Math.atan2(raw.aimStick.x * sgn, raw.aimStick.y * sgn);
        this.stickMag = raw.aimStickMag;
      }
      out.aiming = !!raw.aimStick || raw.stickFiring; // no aim line for a quick tap
      out.trigger = automatic && raw.stickFiring;
    } else if (raw.aimScreen && this.renderer.screenToGround(raw.aimScreen.x, raw.aimScreen.y, BULLET_HEIGHT, v3)) {
      const dx = v3.x - this.player.x, dz = v3.z - this.player.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.4) { out.aimX = dx / d; out.aimZ = dz / d; }
      else { out.aimX = this.aimX; out.aimZ = this.aimZ; }
      out.aiming = true;
      out.trigger = raw.mouseHeld;
      out.triggerTap = raw.mousePressed;
    }
    // Quick tap / hold start on the aim side: one shot along the current (remembered) aim line.
    if (raw.stickTap) out.triggerTap = true;
    out.reload = raw.reload;
    out.switchWeapon = raw.switchWeapon;
    this.resolveGrenade(raw, out, grenade);
  }

  /** Grenade aiming: target from the touch stick (push further = throw further) or the mouse cursor. */
  private resolveGrenade(raw: RawInput, out: InputCommand, wanted: boolean): void {
    out.grenadeMode = out.throwGrenade = false;
    out.throwX = out.throwZ = 0;
    const edge = wanted && !this.grenadeWanted;
    this.grenadeWanted = wanted;
    if (!wanted) return;
    if (this.player.grenades <= 0) {
      this.input.touch.setArmed(false);
      if (edge) this.hud.toast('NO GRENADES');
      return;
    }
    out.grenadeMode = true;
    out.aiming = out.trigger = out.triggerTap = false;
    this.stickAim = this.stickFiring = false;
    const { minRange, maxRange } = GRENADE;
    if (raw.grenadeStick) {
      const sgn = settings.aimReverse ? -1 : 1, st = raw.grenadeStick;
      const d = minRange + (maxRange - minRange) * st.mag;
      out.throwX = st.x * sgn * d; out.throwZ = st.y * sgn * d;
    } else if (raw.aimScreen && this.renderer.screenToGround(raw.aimScreen.x, raw.aimScreen.y, 0, v3)) {
      const dx = v3.x - this.player.x, dz = v3.z - this.player.z, l = Math.hypot(dx, dz);
      if (l > 0.01) {
        const d = Math.min(maxRange, Math.max(minRange, l));
        out.throwX = (dx / l) * d; out.throwZ = (dz / l) * d;
      }
    }
    const has = out.throwX !== 0 || out.throwZ !== 0;
    if (has) { const l = Math.hypot(out.throwX, out.throwZ); out.aimX = out.throwX / l; out.aimZ = out.throwZ / l; }
    out.throwGrenade = raw.grenadeThrow && has;
  }

  private step(dt: number): void {
    this.stats.ticks++;
    this.resolveCommand(this.input.sample(), this.cmd);
    const cmd = this.cmd;
    if (cmd.switchWeapon !== null) this.player.switchWeapon(cmd.switchWeapon);
    const def = this.player.weapon.def;

    // ── Aim with inertia (touch) or direct (mouse); remembered between drags.
    const turning = this.stickAim;
    if (turning) {
      const target = this.stickTarget;
      // Ease-in: a fresh drag starts turning gently and reaches full speed over AIM.easeIn s,
      // so the first millimetres of thumb movement don't yank the aim off its last position.
      this.stickHeld = this.stickAim ? this.stickHeld + dt : 0;
      const k = Math.min(1, this.stickHeld / AIM.easeIn);
      // Aiming while holding fire is much slower: controlled sweeps, not wild spraying.
      const ramp = (0.12 + 0.88 * k * k * (3 - 2 * k)) * (this.stickFiring ? AIM.firingTurnMul : 1);
      this.aim.turnToward(target, this.stickMag, def, dt * ramp);
    } else if (cmd.aimX !== 0 || cmd.aimZ !== 0) {
      this.stickHeld = 0;
      this.aim.set(Math.atan2(cmd.aimX, cmd.aimZ), dt);
    } else {
      this.stickHeld = 0;
      this.aim.hold(dt);
    }
    if (turning || cmd.aimX !== 0 || cmd.aimZ !== 0) { cmd.aimX = this.aim.x; cmd.aimZ = this.aim.z; }
    this.aimX = this.aim.x; this.aimZ = this.aim.z;
    this.aiming = cmd.aiming;
    this.grenadeMode = cmd.grenadeMode;
    this.throwX = cmd.throwX; this.throwZ = cmd.throwZ;

    // Zombies around the player slow them down (wading through a crowd) instead of blocking.
    // Future special zombies can pin the player by forcing slowMul to 0.
    let near = 0;
    for (const z of this.zombies.zombies) if (z.state === 'alive' && Math.hypot(z.x - this.player.x, z.z - this.player.z) < 1.1) near++;
    this.player.slowMul = Math.max(0.35, 1 - 0.22 * near);
    this.player.update(cmd, dt);
    // Zombie AI: chase, attack. Hits land on the player.
    const p0 = this.player;
    this.ai.update(dt, { x: p0.x, z: p0.z, alive: p0.alive }, this.zombies.zombies, this.attacks);
    for (const a of this.attacks) this.damagePlayer(a.damage, a.zombie.x, a.zombie.z);
    if (this.survival && !this.lab) this.runWaves(dt);
    this.zombies.update(dt);
    // Every death (bullets, blasts, impacts) is counted once here: kills + loot.
    for (const z of this.zombies.newlyDead) {
      this.stats.kills++;
      const t = z.parts[0].body.translation();
      if (!this.lab) this.pickups.roll(t.x, t.z);
    }
    this.pickups.update(dt, this.player.x, this.player.z, this.player.alive, (k) => this.takePickup(k));
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
      else if (e === 'shellIn') this.sfx.shellIn();
    }
    if (cmd.throwGrenade) this.throwGrenade(cmd.throwX, cmd.throwZ);
    this.stepBullets(dt);
    this.updateFuses(dt);
    this.updateGrenades(dt);
    this.physics.step();
    // Environmental impacts: bodies slammed into the world take damage; thuds for sound.
    this.zombies.processImpacts(this.physics.contactForces, dt, this.impacts);
    this.thudCooldown -= dt;
    for (const im of this.impacts) {
      if (im.severed) {
        this.stats.dismembers++;
        this.events.emit('dismember', { x: im.x, y: im.y, z: im.z, dx: 0, dz: 0 });
      }
      if (this.thudCooldown <= 0 && im.force > 400) {
        this.thudCooldown = 0.05;
        this.sfx.thud(Math.min(1, im.force / 3000), im.mass < 4);
      }
    }
  }

  /** Spawn bullets (they fly and hit in stepBullets). */
  private fire(): void {
    const p = this.player, def = p.weapon.def;
    const spread = this.aim.spread(def); // accuracy depends on stance, turning, recoil, steadiness
    for (let i = 0; i < def.pellets; i++) {
      // Gaussian-ish spread (sum of two uniforms): most shots near the centre, few at the edge.
      const a = this.aim.angle + ((Math.random() + Math.random()) - 1) * spread;
      // Subtle vertical scatter, biased low (some shots catch legs instead of always the chest).
      const pitch = -Math.random() * def.vSpread + Math.random() * def.vSpread * 0.25;
      const c = Math.cos(pitch);
      const dx = Math.sin(a) * c, dy = Math.sin(pitch), dz = Math.cos(a) * c;
      this.stats.shots++;
      this.bullets.push({
        x: p.x, y: BULLET_HEIGHT, z: p.z, px: p.x, py: BULLET_HEIGHT, pz: p.z, ox: p.x, oy: BULLET_HEIGHT, oz: p.z, dx, dy, dz,
        travelled: 0, width: def.traceWidth, length: def.traceLength, def, power: def.penetration, skip: new Set<number>(),
      });
    }
    // Once per trigger pull (not per pellet): muzzle FX/sound, and recoil shoving the shooter back.
    const ax = Math.sin(this.aim.angle), az = Math.cos(this.aim.angle);
    this.events.emit('shot', { x: p.x + ax * 6, y: BULLET_HEIGHT, z: p.z + az * 6, dx: ax, dz: az, weapon: def.id });
    p.vx -= ax * def.pushback; p.vz -= az * def.pushback;
    this.aim.onShot(def, p.weapon.burst);
    this.ai.noise(p.x, p.z, AI_CFG.hearShotRange, this.zombies.zombies); // gunshots draw the horde
  }

  /**
   * Move bullets one tick. Each tick the whole path segment is ray-cast (excluding the shooter),
   * so a bullet can never skip past a thin object or a limb, however fast it is.
   */
  private stepBullets(dt: number): void {
    const filter = groups(Group.PLAYER, ALL & ~Group.PLAYER & ~Group.DEBRIS);
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i], def = b.def;
      b.px = b.x; b.py = b.y; b.pz = b.z;
      let step = Math.min(def.bulletSpeed * dt, def.range - b.travelled);
      let alive = step > 0;
      while (alive && step > 1e-4) {
        const hit = this.physics.raycast(b.x, b.y, b.z, b.dx, b.dy, b.dz, step, filter, this.player.collider, b.skip);
        if (!hit) { b.x += b.dx * step; b.y += b.dy * step; b.z += b.dz * step; b.travelled += step; break; }
        b.x = hit.point.x; b.y = hit.point.y; b.z = hit.point.z;
        b.travelled += hit.toi; step -= hit.toi;
        alive = this.bulletImpact(b, hit);
      }
      if (!alive || b.travelled >= def.range - 1e-3) this.bullets.splice(i, 1);
    }
  }

  /** Resolve one bullet impact. Returns true if the bullet carries on (penetrated). */
  private bulletImpact(b: Bullet, hit: RayHit): boolean {
    const def = b.def, ex = hit.point.x, ey = hit.point.y, ez = hit.point.z;
    const material = this.physics.materialOf(hit.collider);
    const cost = MATERIAL_COST[material];
    const penetrated = b.power >= cost;
    const body = hit.collider.parent();
    // Force scales with the bullet's remaining power (a bullet that punches through transfers less)
    // and falls off with distance past falloffStart (down to 25% at max range: shotgun pellets).
    const falloff = b.travelled <= def.falloffStart ? 1 : Math.max(0.25, 1 - 0.75 * (b.travelled - def.falloffStart) / Math.max(1, def.range - def.falloffStart));
    const power = Math.min(1, b.power / def.penetration + 0.3) * falloff;
    const force = def.impulse * (penetrated ? 0.55 : 1) * power;
    // Point-blank shotgun: pellets hit zombies much harder (limbs tear off, bodies are blown back).
    const cb = def.closeBoost;
    const close = cb && material === 'flesh'
      ? 1 + (cb.mul - 1) * Math.min(1, Math.max(0, (cb.fade - b.travelled) / (cb.fade - cb.range))) : 1;
    const zf = force * close;
    const zr = material === 'flesh'
      ? this.zombies.hit(hit.collider, def.damage * power, b.dx * zf, zf * 0.25, b.dz * zf, ex, ey, ez, SIM_DT, def.limbMult, def.flinch)
      : null;
    const dynamic = !!zr || (!!body && body.isDynamic());
    if (zr) {
      this.stats.zombieHits++;
      if (zr.severed >= 0) {
        const sp = zr.zombie.parts[zr.severed].body.translation();
        this.stats.dismembers++;
        this.events.emit('dismember', { x: sp.x, y: sp.y, z: sp.z, dx: b.dx, dz: b.dz });
      }
      if (zr.killed) this.events.emit('zombieKilled', { x: ex, y: ey, z: ez });
    } else if (dynamic) {
      this.stats.hits++;
      const prop = this.props.find((q) => q.body === body);
      if (prop?.explosive) this.ignite(prop); // shot barrel: hisses, then blows
      body!.applyImpulseAtPoint({ x: b.dx * force, y: force * 0.15, z: b.dz * force }, hit.point, true);
      const v = body!.linvel();
      this.stats.maxImpactSpeed = Math.max(this.stats.maxImpactSpeed, Math.hypot(v.x, v.y, v.z));
    }
    this.events.emit('hit', { x: ex, y: ey, z: ez, nx: hit.normal.x, ny: hit.normal.y, nz: hit.normal.z, dynamic, material, penetrated });
    if (!penetrated) return false;
    this.stats.penetrations++;
    b.power -= cost;
    b.skip.add(hit.collider.handle);
    return true;
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

  /** Grenade throw preview: the same ballistic path the throw will take, cut at the first obstacle. */
  private updateGrenadeArc(px: number, pz: number): void {
    const show = this.grenadeMode && (this.throwX !== 0 || this.throwZ !== 0) && this.player.alive;
    this.arcDots.visible = this.blastRing.visible = show;
    if (!show) return;
    const l = Math.hypot(this.throwX, this.throwZ), ux = this.throwX / l, uz = this.throwZ / l;
    const y0 = GRENADE.releaseHeight, x0 = px + ux * 0.5, z0 = pz + uz * 0.5;
    const v = throwVelocity(px + this.throwX - x0, pz + this.throwZ - z0, y0);
    const T = flightTime(l - 0.5), filter = groups(Group.PLAYER, Group.STATIC | Group.PROP);
    let lx = x0, ly = y0, lz = z0, end = { x: px + this.throwX, z: pz + this.throwZ }, n = 0;
    const steps = ARC_DOTS * 2;
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * T;
      const x = x0 + v.x * t, y = y0 + v.y * t - 4.905 * t * t, z = z0 + v.z * t;
      const dx = x - lx, dy = y - ly, dz = z - lz, sl = Math.hypot(dx, dy, dz);
      const hit = this.physics.raycast(lx, ly, lz, dx / sl, dy / sl, dz / sl, sl, filter, this.player.collider);
      if (hit) { end = { x: hit.point.x, z: hit.point.z }; break; }
      if (i % 2 === 0 && n < ARC_DOTS) this.arcDots.setMatrixAt(n++, m4.makeTranslation(x, y, z));
      lx = x; ly = y; lz = z;
    }
    this.arcDots.count = n;
    this.arcDots.instanceMatrix.needsUpdate = true;
    this.blastRing.position.set(end.x, 0.03, end.z);
    this.blastRing.scale.setScalar(GRENADE.radius * (1 + 0.02 * Math.sin(this.time * 8)));
  }

  private wireEffects(): void {
    const ev = this.events;
    ev.on('shot', (e) => {
      const def = this.player.weapon.def;
      this.rig.muzzle.getWorldPosition(v3);
      // SMG: every 3rd round blooms a bigger flash so sustained fire flickers like a real muzzle.
      const big = def.automatic && this.stats.shots % 3 === 0;
      this.flash.fire(v3, this.visYaw, def.automatic ? (big ? 1.6 : 0.8) : 1);
      this.recoil = Math.min(1, this.recoil + def.recoil);
      this.renderer.addShake(def.shake);
      if (def.id === 'smg') this.sfx.smgShot(); else if (def.id === 'shotgun') { this.sfx.shotgun(); this.sfx.pump(0.3); } else this.sfx.gunshot();
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
      // Brief bright flash where the bullet lands (cosmetic only).
      this.sparks.emit(e.x, e.y, e.z, 0, 0, 0, 0.16, 0.06, m === 'flesh' ? 0xff6a50 : 0xfff0b0, 0, 0, 0, 0);
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
        // Blood on the world: splatter on a wall behind the target, and drops on the floor.
        const bx = -e.nx, bz = -e.nz, bl = Math.hypot(bx, bz) || 1;
        const wall = this.physics.raycast(e.x + (bx / bl) * 0.3, e.y, e.z + (bz / bl) * 0.3, bx / bl, -0.15, bz / bl, 2.5,
          groups(Group.PLAYER, Group.STATIC));
        if (wall && wall.point.y > 0.05) this.blood.add(wall.point.x, wall.point.y, wall.point.z, wall.normal.x, wall.normal.y, wall.normal.z, 1.1);
        const fd = 0.4 + Math.random() * 1.2;
        this.blood.add(e.x + (bx / bl) * fd, 0.006, e.z + (bz / bl) * fd, 0, 1, 0, 0.6 + Math.random() * 0.6);
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
    this.rig.setWeapon(p.weapon.def.id);
    // Shotgun pump: rack back and forward early in the cooldown after each shot.
    const w = p.weapon;
    const pt = w.def.id === 'shotgun' && w.cooldown > 0 ? 1 - w.cooldown / w.def.fireInterval : 1;
    const pump = pt > 0.2 && pt < 0.65 ? Math.sin(((pt - 0.2) / 0.45) * Math.PI) : 0;
    this.rig.pose(p.walkPhase, moveAmt, strafe, this.recoil, this.time, w.reloadProgress, pump);

    this.marker.position.x = x; this.marker.position.z = z;
    this.updateAimLine(x, z);
    this.updateGrenadeArc(x, z);
    for (let i = 0; i < this.grenades.length; i++) {
      const g = this.grenades[i], m = this.grenadeMeshes[i];
      const t = g.body.translation(), r = g.body.rotation();
      m.position.set(t.x, t.y, t.z);
      m.quaternion.set(r.x, r.y, r.z, r.w);
      // Fuse light blinks faster as it runs down.
      m.children[0].visible = Math.sin(this.time * (g.fuse < 0.6 ? 50 : 16)) > 0;
    }

    this.syncZombieViews(frameDt);

    for (const prop of this.props) {
      const t = prop.body.translation(), r = prop.body.rotation();
      prop.mesh.position.set(t.x, t.y, t.z);
      prop.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }

    this.flash.update(frameDt);
    this.bulletViews.update(this.bullets, alpha);
    this.holes.update(frameDt);
    this.blood.update(frameDt);
    if (this.hitMarkerT > 0) { this.hitMarkerT -= frameDt; if (this.hitMarkerT <= 0) this.hitMarker.classList.remove('on'); }
    this.sparks.update(frameDt);
    this.debris.update(frameDt);
    this.renderer.updateCamera(x, z, this.aimX, this.aimZ, frameDt);
    this.renderer.render();

    this.hud.update(p.weapon, p.health, PLAYER.maxHealth, p.grenades);
    if (this.survival && !this.lab) this.hud.wave(this.waves.state, this.waves.wave, this.waves.remaining(this.zombies.aliveCount), this.waves.timer);
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
    zm.spawned.length = 0;
    this.zombieRenderer.sync(dt, zm.zombies, zm.removed);
    // Hurt vignette fades out; death screen after the fall.
    if (this.hurtT > 0) { this.hurtT -= dt; this.hurtEl.style.opacity = String(Math.max(0, this.hurtT * 2)); }
    if (!this.player.alive && !this.deathShown) { this.deathShown = true; this.showDeath(); }
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

  /** A zombie's strike landed. */
  private damagePlayer(dmg: number, fromX: number, fromZ: number): void {
    const p = this.player;
    if (!p.alive) return;
    p.health = Math.max(0, p.health - dmg);
    // Knock the player back a little away from the attacker.
    const dx = p.x - fromX, dz = p.z - fromZ, d = Math.hypot(dx, dz) || 1;
    p.vx += (dx / d) * 2.5; p.vz += (dz / d) * 2.5;
    this.hurtT = 0.45;
    this.renderer.addShake(0.35);
    this.sfx.playerHurt();
    this.stats.damageTaken += dmg;
  }

  private showDeath(): void {
    // Run summary + best run on this device.
    const wave = this.lab ? 0 : Math.max(this.waves.wave, 1);
    const best = loadBest();
    const isBest = !this.lab && (wave > best.wave || (wave === best.wave && this.stats.kills > best.kills));
    if (isBest) saveBest({ wave, kills: this.stats.kills });
    const b = isBest ? { wave, kills: this.stats.kills } : best;
    this.deadEl.querySelector('.kills')!.innerHTML = (this.lab ? '' : `WAVE ${wave}<br>`) +
      `${this.stats.kills} kills · ${this.stats.dismembers} limbs<br>` +
      (this.lab ? '' : isBest ? '<b class="best">NEW BEST!</b>' : `best: wave ${b.wave} · ${b.kills} kills`);
    this.deadEl.classList.add('on');
    this.sfx.playerDeath();
  }

  /** Reset the run: clear zombies, heal, refill. */
  restart(): void {
    this.zombies.clear();
    const p = this.player;
    p.health = PLAYER.maxHealth;
    p.body.setNextKinematicTranslation({ x: 0, y: p.body.translation().y, z: 2 });
    p.x = p.prevX = 0; p.z = p.prevZ = 2; p.vx = p.vz = 0;
    for (const w of p.weapons) { w.ammo = w.def.magSize; w.cancelReload(); }
    for (const w of p.weapons) w.reserve = w.def.reserveStart;
    p.grenades = GRENADE.start;
    for (let i = this.grenades.length - 1; i >= 0; i--) this.removeGrenade(i);
    this.stats.kills = 0; this.stats.dismembers = 0; this.stats.wave = 0;
    this.deathShown = false;
    this.deadEl.classList.remove('on');
    this.waves.reset();
    this.pickups.clear();
    if (this.lab) this.spawnZombies(5);
  }

  /** Survival (PLAY mode): waves of hunting zombies from out of sight, with breathers between. */
  private runWaves(dt: number): void {
    if (!this.player.alive) return;
    const max = this.quality.name === 'mobile' ? 8 : 12;
    const n = this.waves.update(dt, this.zombies.aliveCount, max, this.waveEvents);
    for (const e of this.waveEvents) {
      if (e.type === 'waveStart') { this.hud.banner(`WAVE ${e.wave}`, `${e.count} zombies`); this.sfx.waveStart(); }
      else { this.hud.banner(`WAVE ${e.wave} CLEARED`, 'catch your breath'); this.sfx.waveClear(); this.stats.wave = e.wave; this.restockBarrels(); this.giveGrenade(); }
    }
    for (let i = 0; i < n; i++) this.spawnWaveZombie();
  }

  /** Clearing a wave earns a grenade (up to the carry limit). */
  private giveGrenade(): void {
    const p = this.player;
    if (p.grenades >= GRENADE.max) return;
    p.grenades++;
    this.hud.toast('+1 GRENADE');
  }

  private spawnWaveZombie(): void {
    const p = this.player, tune = this.waves.tuning;
    for (let tries = 0; tries < 30; tries++) {
      const x = (Math.random() - 0.5) * (ARENA.size - 4), z = (Math.random() - 0.5) * (ARENA.size - 4);
      if (Math.hypot(x - p.x, z - p.z) < 12 || this.ai.nav.isBlocked(x, z)) continue;
      const zb = this.zombies.spawn(x, z, Math.atan2(p.x - x, p.z - z));
      zb.baseSpeed *= tune.speedMul;
      zb.hp *= tune.hpMul;
      this.ai.alertAll([zb]);
      return;
    }
  }

  /** Walked over loot. Returns false if it's of no use right now (stays on the ground). */
  private takePickup(k: PickupKind): boolean {
    const p = this.player;
    if (k === 'health') {
      if (p.health >= PLAYER.maxHealth) return false;
      p.health = Math.min(PLAYER.maxHealth, p.health + LOOT.healthAmount);
      this.hud.toast(`+${LOOT.healthAmount} HEALTH`);
    } else {
      // An ammo box tops up the SMG and gives a few shotgun shells.
      const got = p.weapons[1].addAmmo(LOOT.ammoAmount), shells = p.weapons[2].addAmmo(LOOT.shellAmount);
      if (got <= 0 && shells <= 0) return false;
      this.hud.toast([got > 0 ? `+${got} SMG` : '', shells > 0 ? `+${shells} SHELLS` : ''].filter(Boolean).join('  '));
    }
    this.sfx.pickup();
    return true;
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
    this.explode(p.x + this.aimX * d, 0.3, p.z + this.aimZ * d, 5, false);
  }

  /** `hurtPlayer`: real blasts (barrels) hurt the player; the Lab BOOM button doesn't. */
  explode(x: number, y: number, z: number, radius = 5, hurtPlayer = true): void {
    const dt = SIM_DT;
    const torn = this.zombies.explode(x, y, z, radius, 160, 45, dt);
    this.stats.dismembers += torn;
    for (const prop of this.props) {
      const t = prop.body.translation();
      let dx = t.x - x, dz = t.z - z;
      const d = Math.max(0.5, Math.hypot(dx, dz));
      if (d > radius) continue;
      // Explosive barrels in range catch the blast and go off moments later (chain reaction).
      if (prop.explosive) this.ignite(prop, 0.15 + Math.random() * 0.25);
      const f = (1 - d / radius) * 220;
      dx /= d; dz /= d;
      prop.body.applyImpulse({ x: dx * f, y: f * 0.8, z: dz * f }, true);
      prop.body.applyTorqueImpulse({ x: (Math.random() - 0.5) * f * 0.3, y: 0, z: (Math.random() - 0.5) * f * 0.3 }, true);
    }
    if (hurtPlayer) {
      const p = this.player, d = Math.hypot(p.x - x, p.z - z);
      if (d < radius) this.damagePlayer(EXPLOSION_PLAYER_DAMAGE * (1 - d / radius), x, z);
    }
    this.events.emit('explosion', { x, y, z, radius });
    this.ai.noise(x, z, 30, this.zombies.zombies);
  }

  /** Light an explosive barrel's fuse (no-op if already burning). */
  ignite(prop: DynamicProp, fuse = 1): void {
    if (!prop.explosive || prop.fuse !== undefined) return;
    prop.fuse = fuse;
    this.sfx.hiss();
  }

  /** Burning fuses: flames + smoke from the barrel, then boom. */
  private updateFuses(dt: number): void {
    for (let i = this.props.length - 1; i >= 0; i--) {
      const prop = this.props[i];
      if (prop.fuse === undefined) continue;
      prop.fuse -= dt;
      const t = prop.body.translation();
      if (Math.random() < 0.7) this.sparks.emit(t.x + (Math.random() - 0.5) * 0.3, t.y + 0.6, t.z + (Math.random() - 0.5) * 0.3,
        (Math.random() - 0.5) * 0.8, 1.5 + Math.random() * 2, (Math.random() - 0.5) * 0.8, 0.08, 0.3, Math.random() < 0.5 ? 0xff8a2a : 0xffd04a, 0, -2, 1, 2);
      if (prop.fuse > 0) continue;
      // Remove the barrel (body + mesh), then the blast.
      this.props.splice(i, 1);
      this.renderer.scene.remove(prop.mesh);
      this.physics.world.removeRigidBody(prop.body);
      this.stats.barrels++;
      this.explode(t.x, t.y, t.z, 5);
    }
  }

  /** Throw a grenade from the player's hand to land at offset (dx, dz) from the player. */
  throwGrenade(dx: number, dz: number): void {
    const p = this.player;
    if (!p.alive || p.grenades <= 0) return;
    p.grenades--;
    this.stats.grenadesThrown++;
    // Release a little in front of the player, but never inside a wall they're hugging.
    const l = Math.hypot(dx, dz) || 1, ux = dx / l, uz = dz / l, y0 = GRENADE.releaseHeight;
    const wall = this.physics.raycast(p.x, y0, p.z, ux, 0, uz, 0.5, groups(Group.PLAYER, Group.STATIC | Group.PROP), p.collider);
    const off = wall ? Math.max(0, wall.toi - 0.15) : 0.5;
    const x0 = p.x + ux * off, z0 = p.z + uz * off;
    const v = throwVelocity(p.x + dx - x0, p.z + dz - z0, y0);
    this.grenades.push(spawnGrenade(this.physics, x0, y0, z0, v));
    const mesh = new THREE.Mesh(this.grenadeGeo, this.grenadeMat);
    mesh.castShadow = true;
    mesh.add(new THREE.Mesh(this.grenadeLightGeo, this.grenadeLightMat));
    this.renderer.scene.add(mesh);
    this.grenadeMeshes.push(mesh);
    this.sfx.throwGrenade();
  }

  /** Live grenades: bounce clinks, fuse beeps, then the blast (same explosion as a barrel). */
  private updateGrenades(dt: number): void {
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      const before = g.fuse;
      const r = stepGrenade(g, dt);
      // Beeps speed up as the fuse runs down.
      const period = g.fuse < 0.6 ? 0.12 : 0.4;
      if (r !== 'boom' && Math.floor(before / period) !== Math.floor(g.fuse / period)) this.sfx.beep();
      if (r === 'bounce') this.sfx.clink();
      for (const z of this.zombies.zombies) if (z.state === 'alive' && hitZombie(g, z.x, z.z)) { this.sfx.thud(0.3, true); break; }
      if (r !== 'boom') continue;
      const t = g.body.translation();
      this.removeGrenade(i);
      this.stats.grenadeBlasts++;
      this.explode(t.x, Math.max(0.2, t.y), t.z, GRENADE.radius);
    }
  }

  private removeGrenade(i: number): void {
    this.physics.world.removeRigidBody(this.grenades[i].body);
    const mesh = this.grenadeMeshes[i];
    this.renderer.scene.remove(mesh);
    this.grenades.splice(i, 1);
    this.grenadeMeshes.splice(i, 1);
  }

  addBarrel(x: number, z: number, explosive: boolean): DynamicProp {
    const prop = spawnBarrel(this.renderer.scene, this.physics, x, z, explosive);
    this.props.push(prop);
    return prop;
  }

  /** Between waves: drop a couple of fresh explosive barrels on open ground (max 6 around). */
  private restockBarrels(): void {
    const p = this.player;
    for (let n = 0, tries = 0; n < 2 && tries < 40; tries++) {
      if (this.props.filter((q) => q.explosive).length >= 6) return;
      const x = (Math.random() - 0.5) * (ARENA.size - 8), z = (Math.random() - 0.5) * (ARENA.size - 8);
      if (Math.hypot(x - p.x, z - p.z) < 5 || this.ai.nav.isBlocked(x, z)) continue;
      this.addBarrel(x, z, true);
      n++;
    }
  }

  /** Snapshot for automated tests and the debug console. */
  snapshot() {
    const p = this.player;
    let maxPropMove = 0;
    this.props.forEach((pr) => {
      const t = pr.body.translation();
      const s0 = this.propStart.get(pr);
      if (s0) maxPropMove = Math.max(maxPropMove, Math.hypot(t.x - s0.x, t.y - s0.y, t.z - s0.z));
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
      damageTaken: this.stats.damageTaken, playerAlive: this.player.alive, wave: this.waves.wave, waveState: this.waves.state,
      grenades: p.grenades, grenadesLive: this.grenades.length, grenadesThrown: this.stats.grenadesThrown,
      grenadeBlasts: this.stats.grenadeBlasts, grenadeMode: this.grenadeMode, arcVisible: this.arcDots.visible,
      barrels: this.stats.barrels, explosiveBarrels: this.props.filter((q) => q.explosive).length,
      reserve: p.weapon.reserve, pickups: this.pickups.list.map((q) => q.kind), smgReserve: p.weapons[1].reserve, crawlers: this.zombies.zombies.filter((z) => z.crawler && z.alive).length,
      fps: this.debug.fps, physicsMs: this.debug.avgPhysicsMs,
      bodies: this.physics.bodyCount,
    };
  }
}
