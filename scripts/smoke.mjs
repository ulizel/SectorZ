/**
 * Browser smoke test: serves dist/ with `vite preview`, drives the real game in headless
 * Chromium (desktop + emulated phone with genuine touch events) and asserts on game state
 * exposed via window.__SECTORZ__. Screenshots land in test-results/.
 *
 *   npm run build && npm run smoke
 */
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const PORT = 4173;
const BASE = `http://localhost:${PORT}/`;
const OUT = 'test-results';
mkdirSync(OUT, { recursive: true });

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '  ✔' : '  ✘'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
};

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE)).ok) return; } catch {}
    await sleep(250);
  }
  throw new Error('preview server did not start');
}

const state = (page) => page.evaluate(() => window.__SECTORZ__.state());
/**
 * Wait for N *simulation* ticks (60 per game-second). Wall-clock sleeps are flaky because slow
 * CI GPUs drop below 15 FPS, where the loop's catch-up cap makes game time run slower than real time.
 */
async function ticks(page, n) {
  const start = (await state(page)).ticks;
  await page.waitForFunction((t) => window.__SECTORZ__.state().ticks >= t, start + n, { timeout: 60000, polling: 50 });
}
async function waitReady(page) {
  await page.waitForFunction(() => window.__SECTORZ__?.ready === true, null, { timeout: 30000 });
}
/** Project a world point to screen pixels using the game's own camera. */
const worldToScreen = (page, x, y, z) => page.evaluate(([x, y, z]) => {
  const cam = window.__SECTORZ__.game.renderer.camera;
  const v = cam.position.clone().set(x, y, z).project(cam);
  return { x: (v.x + 1) / 2 * innerWidth, y: (1 - v.y) / 2 * innerHeight };
}, [x, y, z]);

/** SMOKE_CPU_THROTTLE=4 simulates a slow device/CI runner (proves tests are frame-rate independent). */
const THROTTLE = Number(process.env.SMOKE_CPU_THROTTLE || 1);
async function throttle(page, ctx) {
  if (THROTTLE <= 1) return;
  const cdp = await (ctx ?? page.context()).newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
}

const launchArgs = { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] };

async function desktop(browser) {
  console.log('\n[desktop 1280x720, keyboard + mouse]');
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await throttle(page);
  await page.goto(`${BASE}?quality=desktop&nozombies`);
  await page.waitForSelector('#start:not([disabled])', { timeout: 30000 });
  await page.screenshot({ path: `${OUT}/desktop-title.png` });
  await page.click('#start');
  await waitReady(page);
  await ticks(page, 20);
  const s0 = await state(page);
  check('game running (sim ticks advancing)', s0.ticks > 10, `ticks=${s0.ticks}`);
  console.log(`    (fps in headless software GL: ${s0.fps.toFixed(1)})`);

  // Aim at the barrel at (6,-1). It's an explosive one in the arena: defuse it here, or it blows up
  // after the first hit and the later shots have nothing to hit (this test is about pushing props).
  await page.evaluate(() => { for (const q of window.__SECTORZ__.game.props) { const t = q.body.translation(); if (Math.hypot(t.x - 6, t.z + 1) < 0.5) q.explosive = false; } });
  // Aim at the barrel at (6,-1). The camera leans toward the aim, so re-project until it settles.
  const aimAt = async () => { const t = await worldToScreen(page, 6, 1.15, -1); await page.mouse.move(t.x, t.y); };
  for (let i = 0; i < 5; i++) { await aimAt(); await sleep(400); }
  const a = await state(page);
  const yawTarget = Math.atan2(6 - a.x, -1 - a.z);
  check('player faces the mouse target', Math.abs(Math.atan2(Math.sin(a.yaw - yawTarget), Math.cos(a.yaw - yawTarget))) < 0.12, `yaw=${a.yaw.toFixed(2)} want≈${yawTarget.toFixed(2)}`);
  check('aim line shown with mouse', a.aimLineVisible);

  // Pistol is single-shot: holding the button fires exactly one shot.
  await page.mouse.down();
  await ticks(page, 60);
  await page.mouse.up();
  const b = await state(page);
  check('pistol: click-and-hold fires exactly one shot', b.shots - a.shots === 1, `shots=${b.shots - a.shots}`);
  for (let i = 0; i < 3; i++) { await aimAt(); await page.mouse.down(); await ticks(page, 2); await page.mouse.up(); await ticks(page, 16); }
  await ticks(page, 40);
  const c = await state(page);
  check('pistol: each click fires one shot', c.shots - b.shots === 3, `shots=${c.shots - b.shots}`);
  check('bullets hit dynamic props', c.propHits >= 3, `propHits=${c.propHits}`);
  // Momentum transfer is deterministic; the final resting position depends on bullet spread
  // (exact toppling is covered by the headless physics test), so it's reported, not asserted.
  check('bullet impulses push props', c.maxImpactSpeed > 0.3, `peak prop speed=${c.maxImpactSpeed.toFixed(2)}m/s, moved ${c.maxPropMove.toFixed(2)}m`);
  await page.screenshot({ path: `${OUT}/desktop-shooting.png` });

  // SMG (key 2) is automatic: holding fires continuously.
  await page.keyboard.press('Digit2');
  await ticks(page, 3);
  check('key 2 switches to SMG', (await state(page)).weapon === 'smg');
  const d = await state(page);
  await page.mouse.down();
  await ticks(page, 60);
  await page.mouse.up();
  await ticks(page, 10);
  const e = await state(page);
  check('SMG: holding fires continuously', e.shots - d.shots >= 9, `shots=${e.shots - d.shots}`);
  await ticks(page, 30);
  check('SMG: releasing stops fire', (await state(page)).shots === e.shots);
  await page.keyboard.press('Digit1');

  // WASD movement: hold W for 60 ticks → ~5 m toward -Z.
  await page.keyboard.down('KeyW');
  await ticks(page, 60);
  await page.keyboard.up('KeyW');
  await ticks(page, 12);
  const s2 = await state(page);
  check('W moves the player up-screen (-Z)', e.z - s2.z > 3, `dz=${(e.z - s2.z).toFixed(2)}`);
  await page.keyboard.down('KeyD');
  await ticks(page, 36);
  await page.keyboard.up('KeyD');
  await ticks(page, 12);
  const s3 = await state(page);
  check('D moves the player right (+X)', s3.x - s2.x > 1.5, `dx=${(s3.x - s2.x).toFixed(2)}`);
  await page.keyboard.press('KeyR');
  await ticks(page, 3);
  const s4 = await state(page);
  check('R reloads (or mag already full)', s4.reloading || s4.ammo === 12, `ammo=${s4.ammo} reloading=${s4.reloading}`);
  check('no JS errors (desktop)', errors.length === 0 && (await page.evaluate(() => window.__SECTORZ__.errors.length)) === 0, errors.join(' | '));
  await page.close();
}

async function phone(browser, deviceName, landscape) {
  console.log(`\n[${deviceName}${landscape ? ' landscape' : ''}, real multi-touch events]`);
  const d = devices[deviceName];
  const ctx = await browser.newContext({
    ...d,
    deviceScaleFactor: 1, // software GL in CI is slow at 3x; touch + mobile UA are unchanged
    viewport: landscape ? { width: d.viewport.height, height: d.viewport.width } : d.viewport,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await throttle(page, ctx);
  await page.goto(`${BASE}?nozombies`);
  await page.waitForSelector('#start:not([disabled])', { timeout: 30000 });
  check('touch device detected → mobile quality + touch UI', await page.evaluate(() => document.body.classList.contains('touch')));
  await page.tap('#start');
  await waitReady(page);
  await ticks(page, 20);
  const cdp = await ctx.newCDPSession(page);
  const vw = page.viewportSize().width, vh = page.viewportSize().height;
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  const L = { x: vw * 0.22, y: vh * 0.7, id: 1 };
  const R = { x: vw * 0.78, y: vh * 0.55, id: 2 };
  const LU = { ...L, y: L.y - 70 }; // left stick pushed up
  /** Drag the right thumb (optionally while the left thumb is held) in 5 steps to dx,dy. */
  async function dragRight(dx, dy, left = null) {
    // A real swipe starts moving within a few ms: send the moves back-to-back so slow CI event
    // delivery doesn't turn the touch into a touch-and-hold (which fires after 0.2 s still).
    for (let i = 1; i <= 5; i++) {
      const pts = [{ ...R, x: R.x + (dx * i) / 5, y: R.y + (dy * i) / 5 }];
      await touch('touchMove', left ? [left, ...pts] : pts);
    }
  }

  // 1. Movement: left thumb up, 360° stick; release stops.
  const s0 = await state(page);
  await touch('touchStart', [L]);
  for (let i = 1; i <= 5; i++) { await touch('touchMove', [{ ...L, y: L.y - i * 14 }]); await sleep(16); }
  await ticks(page, 54);
  await touch('touchEnd', []);
  await ticks(page, 12);
  const s1 = await state(page);
  check('left stick moves player up (-Z)', s0.z - s1.z > 2.5, `dz=${(s0.z - s1.z).toFixed(2)}`);
  await ticks(page, 12);
  check('releasing the left stick stops movement', Math.hypot((await state(page)).z - s1.z) < 0.05);
  check('no shots from movement', s1.shots === 0);

  // 2. Quick tap on the right half fires one shot along the current aim.
  await touch('touchStart', [R]);
  await ticks(page, 2);
  await touch('touchEnd', []);
  await ticks(page, 10);
  const s2 = await state(page);
  check('quick tap on right half fires one shot along the current aim', s2.shots - s1.shots === 1, `shots=${s2.shots - s1.shots}`);

  // 3. Dragging only aims: aim line, no shot while dragging or on release.
  // The swipe's touch-down and first moves are dispatched in one go (as a real swipe arrives):
  // slow CI event delivery would otherwise look like a 0.2 s touch-and-hold, which fires.
  await ticks(page, 15);
  const swipe = (type, pts) => page.evaluate(([type, pts]) => {
    const el = document.getElementById('touch');
    for (const [t, x, y] of pts) el.dispatchEvent(new PointerEvent(t ?? type, { pointerId: 77, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true }));
  }, [type, pts]);
  await swipe(null, [['pointerdown', R.x, R.y], ...[1, 2, 3, 4, 5].map((i) => ['pointermove', R.x + i * 14, R.y])]);
  await ticks(page, 50);
  const s3 = await state(page);
  check('dragging right stick shows aim line', s3.aimLineVisible === true);
  check('dragging never fires', s3.shots === s2.shots, `shots=${s3.shots - s2.shots}`);
  check('aim settles on the dragged direction (+X)', Math.abs(s3.aimX - 1) < 0.01 && Math.abs(s3.aimZ) < 0.01, `aim=(${s3.aimX.toFixed(2)},${s3.aimZ.toFixed(2)})`);
  await page.screenshot({ path: `${OUT}/${deviceName.replace(/\W+/g, '-')}${landscape ? '-landscape' : ''}-aiming.png` });
  await swipe(null, [['pointerup', R.x + 70, R.y]]);
  await ticks(page, 6);
  const s4 = await state(page);
  check('releasing a drag does not fire', s4.shots === s3.shots, `shots=${s4.shots - s3.shots}`);
  check('aim line hidden after release', s4.aimLineVisible === false);

  // 4. Pistol touch-and-hold (still) fires exactly one shot; tap again at the same spot fires again.
  await ticks(page, 15);
  await touch('touchStart', [R]);
  await ticks(page, 30); // > 0.2 s hold
  await touch('touchEnd', []);
  await ticks(page, 15);
  const s5 = await state(page);
  check('pistol: touch-and-hold fires once', s5.shots - s4.shots === 1, `shots=${s5.shots - s4.shots}`);
  check('aim unchanged by tapping/holding (same spot)', Math.abs(s5.aimX - 1) < 0.01);

  // 5. Multi-touch: moving with the left thumb while tapping to fire.
  const m0 = await state(page);
  await touch('touchStart', [L]);
  for (let i = 1; i <= 5; i++) { await touch('touchMove', [{ ...L, y: L.y - i * 14 }]); await sleep(16); }
  await ticks(page, 20);
  await touch('touchStart', [LU, R]);
  await ticks(page, 2);
  await touch('touchEnd', [R]); // CDP: touchEnd lists the finger(s) being lifted
  await ticks(page, 20);
  const m2 = await state(page);
  check('multi-touch: tap-fire while moving', m2.shots - m0.shots === 1 && m0.z - m2.z > 1, `shots=${m2.shots - m0.shots} dz=${(m0.z - m2.z).toFixed(2)}`);
  await touch('touchEnd', []);
  await ticks(page, 6);

  // 6. Automatic weapon: touch-and-hold fires continuously; dragging while holding aims slowly.
  await page.tap('#switch-btn');
  await ticks(page, 3);
  check('⇄ button switches to SMG', (await state(page)).weapon === 'smg');
  const f0 = await state(page);
  await touch('touchStart', [R]);
  await ticks(page, 60);
  const f1 = await state(page);
  check('SMG: touch-and-hold fires continuously', f1.shots - f0.shots >= 7, `shots=${f1.shots - f0.shots}`);
  await dragRight(0, 70); // drag down while firing → aim swings toward +Z, slowly
  await ticks(page, 12);
  const fa = await state(page);
  const swung = Math.atan2(fa.aimX, fa.aimZ);
  check('SMG: aiming while firing is slowed (still swinging after 0.2 s)', Math.abs(swung) > 0.3, `angle from target=${Math.abs(swung).toFixed(2)} rad`);
  await page.screenshot({ path: `${OUT}/${deviceName.replace(/\W+/g, '-')}${landscape ? '-landscape' : ''}-smg.png` });
  await touch('touchEnd', []);
  await ticks(page, 6);
  const f2 = await state(page);
  await ticks(page, 30);
  check('SMG: releasing stops firing', (await state(page)).shots === f2.shots);

  // 7. Reload button.
  await page.tap('#reload-btn');
  await ticks(page, 3);
  const s6 = await state(page);
  check('reload button works', s6.reloading || s6.ammo === 30, `ammo=${s6.ammo}`);

  // 7b. Grenade: 💣 arms (no shooting), drag aims the arc, lifting the thumb throws; 💣 again cancels.
  await ticks(page, 60);
  await page.tap('#grenade-btn');
  await page.tap('#grenade-btn');
  await ticks(page, 3);
  check('💣 tapped twice cancels the grenade', !(await state(page)).grenadeMode && !(await page.evaluate(() => document.getElementById('grenade-btn').classList.contains('armed'))));
  await page.tap('#grenade-btn');
  await ticks(page, 3);
  const g0 = await state(page);
  check('💣 arms a grenade', g0.grenadeMode && g0.grenades === 3);
  await touch('touchStart', [R]);
  await dragRight(70, 0);
  await ticks(page, 20);
  const g1 = await state(page);
  check('armed: dragging the right stick shows the throw arc (no aim line, no shots)', g1.arcVisible && !g1.aimLineVisible && g1.shots === g0.shots,
    `arc=${g1.arcVisible} line=${g1.aimLineVisible} shots=${g1.shots - g0.shots}`);
  await page.screenshot({ path: `${OUT}/${deviceName.replace(/\W+/g, '-')}${landscape ? '-landscape' : ''}-grenade-aim.png` });
  await touch('touchEnd', []);
  await ticks(page, 4);
  const g2 = await state(page);
  check('lifting the thumb throws (one grenade used, disarmed)', g2.grenadesThrown === 1 && g2.grenades === 2 && !g2.grenadeMode && g2.shots === g0.shots,
    `thrown=${g2.grenadesThrown} left=${g2.grenades} shots=${g2.shots - g0.shots}`);
  await ticks(page, 140);
  check('grenade explodes after its fuse', (await state(page)).grenadeBlasts === 1);

  // 8. Browser lock: pinch and pull-down gestures must not zoom, scroll, or select.
  await touch('touchStart', [{ x: vw * 0.45, y: vh * 0.5, id: 7 }, { x: vw * 0.55, y: vh * 0.5, id: 8 }]);
  for (let i = 1; i <= 6; i++) {
    await touch('touchMove', [{ x: vw * 0.45 - i * 20, y: vh * 0.5, id: 7 }, { x: vw * 0.55 + i * 20, y: vh * 0.5, id: 8 }]);
    await sleep(16);
  }
  await touch('touchEnd', []);
  await touch('touchStart', [{ x: vw * 0.3, y: 20, id: 9 }]);
  for (let i = 1; i <= 8; i++) { await touch('touchMove', [{ x: vw * 0.3, y: 20 + i * 40, id: 9 }]); await sleep(16); }
  await touch('touchEnd', []);
  await page.touchscreen.tap(vw * 0.5, 30); // long-press/double-tap targets
  await page.touchscreen.tap(vw * 0.5, 30);
  await ticks(page, 5);
  const lock = await page.evaluate(() => ({
    scale: visualViewport ? visualViewport.scale : 1,
    scrollY: scrollY, scrollX: scrollX,
    selection: String(getSelection()),
    touchAction: getComputedStyle(document.body).touchAction,
    overscroll: getComputedStyle(document.documentElement).overscrollBehaviorY,
    userSelect: getComputedStyle(document.body).userSelect || getComputedStyle(document.body).webkitUserSelect,
  }));
  check('pinch / double-tap do not zoom', lock.scale === 1, `scale=${lock.scale}`);
  check('swipes do not scroll / pull-to-refresh', lock.scrollX === 0 && lock.scrollY === 0 && lock.overscroll === 'none', JSON.stringify(lock));
  check('no text selection possible', lock.selection === '' && lock.userSelect === 'none' && lock.touchAction === 'none');
  check('no JS errors (phone)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

async function ragdollLab(browser) {
  console.log('\n[Ragdoll Lab, desktop]');
  const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await throttle(page);
  await page.goto(`${BASE}?lab&quality=desktop`);
  await waitReady(page);
  await ticks(page, 20);
  check('lab spawns 5 zombies', (await state(page)).zombiesAlive === 5);
  await page.evaluate(() => { window.__SECTORZ__.game.ai.enabled = false; }); // stationary targets for the shooting checks
  // Two zombies in a line straight ahead: a pistol round must stop at the first one.
  await page.evaluate(() => {
    const g = window.__SECTORZ__.game;
    g.zombies.clear();
    g.zombies.spawn(g.player.x, g.player.z + 4, Math.PI);
    g.zombies.spawn(g.player.x, g.player.z + 5.2, Math.PI);
  });
  await ticks(page, 10);
  const aim = await worldToScreen(page, (await state(page)).x, 1.15, (await state(page)).z + 4);
  for (let i = 0; i < 3; i++) { await page.mouse.move(aim.x, aim.y); await sleep(300); }
  const a = await state(page);
  await page.mouse.down(); await ticks(page, 2); await page.mouse.up();
  await ticks(page, 10);
  const b = await state(page);
  check('bullets hit zombie body parts', b.zombieHits > a.zombieHits, `hits=${b.zombieHits - a.zombieHits}`);
  check('pistol bullet stops at the first zombie (no piercing)', b.zombieHits - a.zombieHits === 1, `hits=${b.zombieHits - a.zombieHits}`);
  for (let i = 0; i < 6; i++) { await page.mouse.down(); await ticks(page, 2); await page.mouse.up(); await ticks(page, 16); }
  await ticks(page, 30);
  const c = await state(page);
  check('shooting kills a zombie (ragdoll)', c.kills >= 1, `kills=${c.kills}`);
  await page.evaluate(() => { const g = window.__SECTORZ__.game; g.spawnZombies(5); });
  await ticks(page, 10);
  await page.keyboard.press('KeyB');
  await ticks(page, 30);
  await page.screenshot({ path: `${OUT}/lab-explosion.png` });
  await ticks(page, 150);
  const d = await state(page);
  check('explosion kills/knocks zombies and tears limbs', d.kills > c.kills && d.severed > 0, `kills=${d.kills} severed=${d.severed}`);
  const parts = await page.evaluate(() => window.__SECTORZ__.game.zombies.zombies.flatMap((z) => z.parts.map((p) => p.body.translation().y)));
  check('no ragdoll part through the floor or NaN', parts.every((y) => Number.isFinite(y) && y > 0), `min y=${Math.min(...parts).toFixed(3)}`);
  check('physics step within budget', d.physicsMs < 8, `avg ${d.physicsMs.toFixed(2)} ms`);
  // AI: hunting zombies reach the player and attack.
  await page.evaluate(() => { const g = window.__SECTORZ__.game; g.zombies.clear(); g.ai.enabled = true; g.spawnZombies(4); });
  await ticks(page, 60);
  await page.screenshot({ path: `${OUT}/ai-chase.png` });
  await ticks(page, 360);
  const e = await state(page);
  check('zombies chase and attack the player', e.damageTaken > 0, `damage taken=${e.damageTaken.toFixed(0)}`);
  check('no JS errors (lab)', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function survival(browser) {
  console.log('\n[Survival waves, desktop]');
  const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await throttle(page);
  await page.goto(`${BASE}?quality=desktop&autostart`);
  await waitReady(page);
  await page.waitForFunction(() => window.__SECTORZ__.state().waveState === 'active', null, { timeout: 60000 });
  check('wave 1 starts with a banner', (await state(page)).wave === 1 && await page.evaluate(() => document.getElementById('banner').classList.contains('on')));
  await ticks(page, 240);
  check('wave zombies spawn', (await state(page)).zombiesAlive > 0, `alive=${(await state(page)).zombiesAlive}`);
  // Kill everything as it spawns until the wave is cleared.
  for (let i = 0; i < 40 && (await state(page)).waveState === 'active'; i++) {
    await page.evaluate(() => { for (const z of window.__SECTORZ__.game.zombies.zombies) if (z.alive) z.kill(1 / 60); });
    await ticks(page, 60);
  }
  const a = await state(page);
  check('killing the whole wave clears it (break before wave 2)', a.waveState === 'break' && a.wave === 1 && a.kills >= 6, `state=${a.waveState} kills=${a.kills}`);
  // Loot: drop an ammo box at the player's feet → collected into SMG reserve.
  const before = a.smgReserve;
  await page.evaluate(() => { const g = window.__SECTORZ__.game; g.pickups.spawn('ammo', g.player.x + 0.3, g.player.z); });
  await ticks(page, 10);
  check('walking over ammo adds SMG reserve', (await state(page)).smgReserve > before, `${before} → ${(await state(page)).smgReserve}`);
  await page.evaluate(() => { window.__SECTORZ__.game.player.health = 0; });
  await ticks(page, 10);
  const deadText = await page.evaluate(() => document.querySelector('#dead .kills').textContent);
  check('death screen shows the run summary', /WAVE 1/.test(deadText) && /kills/.test(deadText), deadText);
  check('no JS errors (survival)', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function arsenal(browser) {
  console.log('\n[Shotgun + explosive barrels + grenades, desktop]');
  const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await throttle(page);
  await page.goto(`${BASE}?lab&quality=desktop`);
  await waitReady(page);
  await page.evaluate(() => { const g = window.__SECTORZ__.game; g.ai.enabled = false; g.zombies.clear(); g.zombies.spawn(g.player.x, g.player.z + 3, Math.PI); });
  await page.keyboard.press('Digit3');
  await ticks(page, 5);
  check('key 3 switches to shotgun', (await state(page)).weapon === 'shotgun');
  const s = await state(page);
  const aim = await worldToScreen(page, s.x, 1.15, s.z + 3);
  for (let i = 0; i < 3; i++) { await page.mouse.move(aim.x, aim.y); await sleep(300); }
  const a = await state(page);
  await page.mouse.down(); await ticks(page, 2); await page.mouse.up();
  await ticks(page, 20);
  const b = await state(page);
  check('one shotgun blast fires 12 pellets', b.shots - a.shots === 12, `pellets=${b.shots - a.shots}`);
  const zs = await page.evaluate(() => window.__SECTORZ__.game.zombies.zombies.map((z) => z.state));
  check('close blast knocks the zombie down (or kills it)', zs.length > 0 && zs.every((st) => st !== 'alive'), `states=${zs.join(',')} hits=${b.zombieHits - a.zombieHits}`);
  await page.screenshot({ path: `${OUT}/shotgun.png` });
  // Barrels: two explosives 2 m apart, a zombie beside them, player 3.5 m away; shoot-ignite one.
  const c = await state(page);
  await page.evaluate(() => {
    const g = window.__SECTORZ__.game, p = g.player;
    g.zombies.clear();
    const b1 = g.addBarrel(p.x + 3.5, p.z, true);
    g.addBarrel(p.x + 5.5, p.z, true);
    g.zombies.spawn(p.x + 4.5, p.z + 1, 0);
    g.ignite(b1);
  });
  await ticks(page, 120);
  const d = await state(page);
  check('shot barrel explodes and chains to the next one', d.barrels - c.barrels >= 2, `exploded=${d.barrels - c.barrels}`);
  check('zombie next to the barrels is killed', d.kills > c.kills, `kills ${c.kills}→${d.kills}`);
  check('player standing close takes splash damage', d.damageTaken > c.damageTaken, `damage=${(d.damageTaken - c.damageTaken).toFixed(0)}`);
  // Grenade (desktop): hold G to aim at the cursor (arc, no gunfire), release to throw; it blows up the zombie there.
  await page.evaluate(() => { const g = window.__SECTORZ__.game, p = g.player; g.zombies.clear(); p.health = 100; g.zombies.spawn(p.x + 7, p.z, -Math.PI / 2); });
  const e = await state(page);
  await page.keyboard.down('KeyG');
  // The camera leans toward the aim, so re-aim at the target until it settles.
  for (let i = 0; i < 3; i++) { const tgt = await worldToScreen(page, e.x + 7, 0, e.z); await page.mouse.move(tgt.x, tgt.y); await ticks(page, 20); }
  await page.mouse.down(); await ticks(page, 2); await page.mouse.up();
  await ticks(page, 5);
  const f = await state(page);
  check('holding G shows the throw arc instead of the aim line, and the gun stays silent', f.arcVisible && f.grenadeMode && !f.aimLineVisible && f.shots === e.shots,
    `arc=${f.arcVisible} line=${f.aimLineVisible} shots=${f.shots - e.shots}`);
  await page.screenshot({ path: `${OUT}/grenade-aim.png` });
  await page.keyboard.up('KeyG');
  await ticks(page, 5);
  const g = await state(page);
  check('releasing G throws a grenade', g.grenadesThrown - e.grenadesThrown === 1 && g.grenades === e.grenades - 1 && g.grenadesLive === 1);
  await ticks(page, 140);
  const h = await state(page);
  const zs2 = await page.evaluate(() => window.__SECTORZ__.game.zombies.zombies.map((z) => z.state));
  check('grenade explodes and takes out the zombie at the target', h.grenadeBlasts - e.grenadeBlasts === 1 && h.grenadesLive === 0 && zs2.every((st) => st !== 'alive'),
    `blasts=${h.grenadeBlasts - e.grenadeBlasts} states=${zs2.join(',')}`);
  check('player 7 m away is outside the blast', h.damageTaken === e.damageTaken, `damage=${(h.damageTaken - e.damageTaken).toFixed(0)}`);
  await page.screenshot({ path: `${OUT}/grenade-boom.png` });
  check('no JS errors (arsenal)', errors.length === 0, errors.join(' | '));
  await page.close();
}

try {
  await waitForServer();
  const browser = await chromium.launch(launchArgs);
  // SMOKE_ONLY=lab|desktop|phone runs one scenario (for quick local checks).
  const only = process.env.SMOKE_ONLY;
  if (!only || only === 'desktop') await desktop(browser);
  if (!only || only === 'lab') await ragdollLab(browser);
  if (!only || only === 'survival') await survival(browser);
  if (!only || only === 'arsenal') await arsenal(browser);
  if (!only || only === 'phone') { await phone(browser, 'iPhone 13', false); await phone(browser, 'Pixel 7', true); }
  await browser.close();
} catch (e) {
  console.error(e);
  failures++;
} finally {
  server.kill();
}
console.log(failures ? `\nSMOKE FAILED (${failures})` : '\nSMOKE PASSED');
process.exit(failures ? 1 : 0);
