# Sector Z — Architecture & Roadmap

Top-down voxel zombie survival shooter. Three.js + Rapier 3D (WASM) + TypeScript + Vite,
deployed to GitHub Pages. Primary targets: **iPhone and Android mobile browsers**, desktop second.

## Feasibility findings (validated with headless Rapier 0.21 spike)

| Ragdolls (11 bodies, 10 joints) | Bodies | Avg step | Worst step |
|---|---|---|---|
| 10 | 110 | 1.2 ms | (warm-up) |
| 20 | 220 | 1.3 ms | 3.1 ms |
| 40 | 440 | 2.7 ms | 7.2 ms |
| 60 | 660 | 4.0 ms | 18 ms |

Server CPU; expect phones to be 2–3× slower → mobile caps below.

* Removing joints mid-simulation is stable (no NaNs, no tunnelling) → **real physical dismemberment works**:
  a detached limb is an independent rigid body that keeps its momentum, collides and bounces.
* **Rapier has no breakable joints and does not expose joint reaction forces in JS.** Joints are solved
  rigidly (0.00 cm anchor drift even at 80 N·s). Breaking is therefore a **game-side model**: per-limb HP +
  impulse thresholds (bullet impulse, explosion impulse, contact-force events) + joint angular-velocity limits.
  Once the threshold is crossed the joint is removed and physics takes over.

## Key design decisions

1. **Hybrid zombies.** Alive = kinematic capsule + animated voxel rig (cheap, controllable AI).
   Hit reactions are procedural; limbs can be lost while alive (crawlers). Death / knockdown / explosion
   → full dynamic ragdoll initialised with the current pose and velocities. Powered ragdolls (motors) are a stretch goal.
2. **Hitscan bullets** (Rapier ray casts), never physics bodies. CCD only for grenades and flying limbs.
3. **Boxes are the truth.** Every visible voxel limb box is also its collider (`src/rigs/humanoid.ts`),
   so what you see is exactly what collides and detaches.
4. **Procedural assets** — meshes built in code, sounds synthesised with WebAudio → no licence issues, tiny download.
5. **Fixed 60 Hz simulation**, render interpolation, input as `InputCommand` structs.
6. **Co-op ready:** simulation code (`entities/`, `weapons/`, future `ai/`) never touches the DOM or renderer;
   presentation reacts to `EventBus` events. A host can run the sim for two players' commands and replicate
   gameplay state + events. Ragdolls/gibs are cosmetic and simulated locally per client (Rapier is not
   cross-device deterministic). Pages is static → co-op needs WebRTC P2P + a small external signalling broker.
7. Physics runs on the main thread (Pages cannot send COOP/COEP headers needed for SharedArrayBuffer workers).

## Budgets (desktop / mobile)

| | Desktop | Mobile |
|---|---|---|
| Active ragdolls | 12 | 6 (oldest freeze → fade) |
| Loose limbs / gibs | 40 | 20 (pooled, despawn by age/distance) |
| Living zombies | ~60 | ~35 |
| Physics step | ≤ 4 ms | ≤ 4 ms |
| Draw calls | < 150 | < 100 |
| Pixel ratio | ≤ 2 | ≤ 1.5 |

## Source layout

```
src/
  config.ts        all tunables (player feel, camera, props)
  core/            fixed-step loop, event bus, math/seeded RNG, quality presets
  input/           keyboard+mouse, floating twin touch sticks → RawInput → InputCommand
  physics/         Rapier init, world wrapper, collision groups, ray casts
  rigs/            shared humanoid skeleton (render rig now, ragdoll in Phase 2)
  entities/        simulation entities (Player)
  weapons/         weapon data + deterministic state machine
  render/          renderer/camera/lighting, voxel helpers, rig visuals, pooled effects
  world/           arena builder (static instanced blocks + dynamic props)
  audio/           procedural WebAudio SFX
  ui/              HUD, performance overlay
  game.ts          wires sim ↔ presentation
tests/             Vitest: logic + headless Rapier physics
scripts/smoke.mjs  Playwright: real browser, desktop + phone touch, screenshots
```

## Testing & debugging

* `npm test` — unit + headless physics tests (runs Rapier in Node).
* `npm run build && npm run smoke` — drives the built game in Chromium: desktop (keyboard/mouse) and emulated
  iPhone 13 / Pixel 7 with genuine touch events; asserts on `window.__SECTORZ__.state()`; saves screenshots.
* CI runs all of the above on every push; `main` deploys to Pages only if everything passes.
* In game: **FPS** button (or `` ` `` key, or `?debug=1`) shows FPS, physics ms, bodies, draw calls.
  `?quality=mobile|desktop` forces a preset. `?autostart` skips the title card.

## Current state (handover)

Playable on GitHub Pages (`main` auto-deploys via `.github/workflows/ci-deploy.yml` when CI passes).

**Done:** P0 pipeline · P1 player · P2 Ragdoll Lab · P3 zombie AI · P4 chunk 1 (waves, reserve ammo, loot, run stats)
· P4 chunk 2 (shotgun, explosive barrels).

Key systems and where they live:
| System | Files |
|---|---|
| Touch controls (left move stick; right: drag = aim, tap = shot, touch-and-hold = fire, slow aim while firing) | `src/input/aimStick.ts`, `touchSticks.ts` |
| Aim model (ease-in, inertia, bloom/stance, steady-aim, recoil patterns) | `src/weapons/aimModel.ts` |
| Weapons (pistol / SMG / shotgun data, shell reload, active reload, reserve ammo) | `src/weapons/weapon.ts` |
| Projectile bullets (swept ray per tick, penetration, falloff) + visuals | `src/game.ts` (`fire`, `stepBullets`, `bulletImpact`), `src/render/bulletViews.ts` |
| Zombies: kinematic animated → ragdoll; breakable joints; swing-twist limiter; muscles; knockdown/get-up; crawlers; spring hit reactions + micro-kicks; wound slowdown | `src/entities/zombie.ts`, `zombieManager.ts` |
| Zombie AI (flow-field nav grid, senses, separation, prop avoidance + limited push, stuck detour, attacks) | `src/ai/navGrid.ts`, `src/ai/zombieAI.ts` |
| Instanced zombie rendering (11 draw calls for any crowd) | `src/render/zombieRenderer.ts` |
| Waves, loot | `src/systems/waves.ts`, `src/systems/pickups.ts` |
| Arena, props, explosive barrels | `src/world/arena.ts` |
| HUD, pause menu, Lab panel | `src/ui/hud.ts`, `src/main.ts`, `index.html`, `src/style.css` |

Tests: `npm test` (Vitest, headless Rapier; ~63 tests) and `npm run build && npm run smoke`
(Playwright: desktop, iPhone 13, Pixel 7 touch, Lab, survival, arsenal). `SMOKE_ONLY=<scenario>` runs one;
`SMOKE_CPU_THROTTLE=4` simulates slow CI. Tests that depend on randomness use seeded `rng` (`src/core/math.ts`).

## Working agreements (from the project owner)

- Develop via Claude Code on iOS; the owner plays on iPhone/Android browsers (portrait).
- Push directly to `main` (also push the session branch). **Don't wait for deployment** after pushing; report and stop.
- Do only what is asked; minimal, clean changes; no unrelated refactors. Preserve existing mechanics unless asked.
- Never claim something works without testing (unit + smoke where relevant); report failures honestly.
- Ask questions as multiple-choice with a recommended option when a decision is genuinely needed.
- Keep replies concise; avoid long explanations.

## Next up

- **P4 chunk 3:** grenades (touch arc-aim with right stick, bounce, fuse, uses existing `game.explode`).
- **P4 chunk 4:** weapon unlocks by wave (SMG wave 2, shotgun wave 4), grenade pickups, compact portrait HUD.
- **P5:** upgrades between waves; runner / brute / exploder zombie types (use per-zombie `speedMul`, `slowPerHit`,
  `minSpeedMul`, `player.slowMul` for pinning); more props.

## Roadmap

| Phase | Content | Status |
|---|---|---|
| P0 Pipeline | Vite+TS, CI, Pages deploy, perf overlay | ✅ built |
| P1 Player | Voxel survivor, movement/aim (keys+mouse, twin-stick touch), pistol, effects, arena | ✅ |
| P2 Ragdoll Lab | Ragdoll builder, anim→ragdoll handoff, bullet/explosion reactions, breakable joints, limb pool + caps | ✅ |
| P3 Zombie AI | Walker, flow-field pathing, separation, attacks, hit reactions, crawlers | ✅ |
| P4 Combat loop | Shotgun/SMG/grenade, explosive barrels, loot, waves, HUD, audio | chunks 1–2 ✅, 3–4 next |
| P5 Progression | Upgrades, runner/brute/exploder types, more props | |
| P6 Polish & perf | Lighting/VFX, quality presets | |
| P7 Co-op prep | Net transport interface, host-authoritative sim prototype | |
