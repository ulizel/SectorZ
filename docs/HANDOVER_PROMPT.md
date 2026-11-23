# Starting prompt for a new Claude Code session

Copy everything below the line into the first message of a new session (with the SectorZ repo selected).

---

You are continuing development of **Sector Z**, my top-down voxel zombie survival shooter. It is already playable.
Before doing anything, read `docs/ARCHITECTURE.md` (especially "Current state (handover)", "Working agreements",
"Budgets", "Roadmap") and skim the files it lists. Do not change anything until I give you a task.

## Project vision
- 3D low-poly/voxel, top-down survival shooter. Priority: **simple graphics, exceptional physics, satisfying gameplay,
  reliable performance**.
- Genuine articulated ragdolls with breakable joints and physical dismemberment (limbs fly, collide, bounce).
- Wave-based single-player PvE now; architecture must keep supporting **2-player online co-op later**
  (sim separated from rendering, `InputCommand` structs, events, seeded RNG; ragdolls/gore are cosmetic per client).

## Tech & environment
- Three.js 0.187, Rapier 3D (`@dimforge/rapier3d-compat` 0.21, WASM), TypeScript, Vite 7, Vitest, Playwright.
- I develop through **Claude Code on iOS**; I play on **iPhone / Android mobile browsers in portrait** (desktop second).
- Hosted on **GitHub Pages**: pushing to `main` runs CI (typecheck, unit tests, build, browser smoke tests) and deploys
  if green (`.github/workflows/ci-deploy.yml`). Repo: `ulizel/SectorZ`.
- You cannot change repo settings via the API, and `github.io` is blocked from the sandbox (can't open the live site).

## Working agreements (important)
- Push directly to `main` (and also push your session branch). **Don't wait for deployment** after pushing — report and stop.
- Do **only what I ask**. Minimal, clean, optimised changes; no unrelated refactoring; preserve existing mechanics
  unless I say otherwise. Keep code modular and readable.
- **Never claim something works without testing.** Run `npm test` and the relevant smoke scenario before pushing:
  `npm run build && SMOKE_ONLY=<desktop|phone|lab|survival|arsenal> npm run smoke`. Report failures honestly.
- When a decision is genuinely needed, ask **multiple-choice questions with a recommended option**.
- Keep replies **concise**. Plan briefly for bigger features; for small tweaks just do them.
- Tunables live in `src/config.ts`, `src/weapons/weapon.ts`, `src/ai/zombieAI.ts`, `src/systems/*.ts` — mention the
  relevant knob when I may want to tweak something.

## Testing conventions (learned the hard way)
- Smoke tests wait on **simulation ticks**, not wall-clock (slow CI runs <15 FPS and the loop caps catch-up).
- Randomness-dependent unit tests use **seeded `rng`** (`src/core/math.ts`); performance tests use the **median**.
- Touch swipes in smoke tests are dispatched as **one gesture** (slow CI event delivery otherwise looks like a
  0.2 s touch-and-hold, which fires).
- Rapier scene queries only see new colliders after a step (the nav grid does a tiny step first).
- `THREE.Color.setHex` already converts sRGB→linear (don't convert twice).
- `SMOKE_CPU_THROTTLE=4` reproduces slow CI locally.

## Current gameplay (as implemented)
- **Controls (touch):** left half = floating move stick. Right half: **drag = aim only** (aim line + faint accuracy cone,
  turn speed eases in over 0.3 s, proportional/inertial aim); **tap = one shot** along the current aim (no aim line);
  **touch-and-hold still 0.2 s = fire** (pistol/shotgun once, SMG continuous); dragging while holding aims at ~35% speed.
  Buttons: ⇄ weapon cycle, R reload (+ active reload sweet spot), II pause (Resume/Restart/Main Menu), FPS overlay,
  AIM PUSH/PULL toggle. Desktop: WASD + mouse, 1/2/3, R, Esc/P. Mobile browser gestures are locked.
- **Weapons:** pistol (unlimited reserve, slight downward vertical scatter), SMG (recoil pattern, limb damage ×1.6),
  shotgun (12 pellets, falloff from 6 m, pump, shell-by-shell reload, can fire mid-reload, knockdown).
  Projectile bullets (70–80 m/s) with swept ray-casts per tick; bullets stop at zombies, can pass through wood crates.
  Accuracy: stance, turning, recoil bloom, steady-aim bonus. Solid bright traces starting at the muzzle.
- **Zombies:** 11 physical voxel parts; kinematic animated when alive → dynamic ragdoll on death/knockdown; breakable
  limbs (per-limb HP), stumps/bone/blood, crawlers after leg loss, dangling arms, fading death "muscles", swing-twist
  joint limiter, corpse freezing, caps (mobile 6 active ragdolls / 16 corpses / 24 limbs). Spring-based hit reactions +
  per-bullet micro-kicks, knockback push, lean-into-fire, wound slowdown (7%/hit, floor 55%).
  AI: flow-field pathfinding, sight/gunshot/explosion senses, separation, prop avoidance + weak pushing, stuck detour,
  wind-up/strike attacks. Player wades through crowds slowed (`player.slowMul`).
- **Loop:** waves (banner, counter, breaks, ramping count/speed/HP), reserve ammo + warnings, loot (ammo/health),
  explosive barrels (fuse, chain, player splash, restocked between waves), death screen with run stats + best run.
- **Modes:** PLAY (survival waves) and RAGDOLL LAB (SPAWN / BOOM / SLOW / AI toggle / CLEAR). `?nozombies`,
  `?debug=1`, `?quality=mobile|desktop`, `?autostart`, `?lab`.

## Roadmap (do these in order, one chunk at a time, each playable)
1. **P4 chunk 3 — Grenades:** touch-friendly throw (aim arc with the right stick, show the arc + landing marker),
   physical bounce/roll, ~2 s fuse, uses existing `game.explode`; limited grenades (start with 2), grenade pickups.
   Decide the input gesture with me (e.g. a grenade button that switches the right stick into throw mode).
2. **P4 chunk 4 — Progression & HUD:** weapon unlocks by wave (SMG wave 2, shotgun wave 4), grenade loot,
   compact portrait HUD (weapon/ammo/grenades/wave), small pickup/unlock notifications.
3. **P5 — Variety & upgrades:** upgrade choice between waves (damage, reload, mag size, move speed, health…);
   zombie types using existing hooks (`speedMul`, `slowPerHit`, `minSpeedMul`, `player.slowMul`): **runner**
   (fast, low HP), **brute** (big, slow, resists knockdown, needs shotgun/explosives), **exploder** (blows up on death —
   chain with barrels), later a **pinning grabber**; more arena props/cover; possibly a second arena layout.
4. **P6 — Polish & performance:** proper get-up animation (currently a 0.9 s blend), lighting/VFX pass, audio pass,
   mobile quality presets & auto-scaling, haptics on Android, settings menu (sensitivity, hold time, gore level).
5. **P7 — Co-op prep:** net transport interface, host-authoritative simulation for 2 players (WebRTC P2P + small
   external signalling, since Pages is static), replicate gameplay state/events only (ragdolls/gore stay local).

## Open questions I may answer later
- SMG quick tap: single round (current) or a 3-round burst?
- Hold-to-fire time 0.2 s vs 0.3 s (accidental holds?).
- Gore amount from point-blank explosions (currently heavy).
- Hit reaction strength (`flinch`, `KICK_LIMB`, `KICK_BODY`) — still being tuned by feel.

## First task
[Replace this with what you want, e.g.:]
Start **P4 chunk 3 (grenades)**. Give me a short plan and ask your multiple-choice questions before implementing.
