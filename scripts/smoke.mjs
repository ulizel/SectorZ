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
  await page.goto(`${BASE}?quality=desktop`);
  await page.waitForSelector('#start:not([disabled])', { timeout: 30000 });
  await page.screenshot({ path: `${OUT}/desktop-title.png` });
  await page.click('#start');
  await waitReady(page);
  await ticks(page, 20);
  const s0 = await state(page);
  check('game running (sim ticks advancing)', s0.ticks > 10, `ticks=${s0.ticks}`);
  console.log(`    (fps in headless software GL: ${s0.fps.toFixed(1)})`);

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
  await page.goto(BASE);
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
    for (let i = 1; i <= 5; i++) {
      const pts = [{ ...R, x: R.x + (dx * i) / 5, y: R.y + (dy * i) / 5 }];
      await touch('touchMove', left ? [left, ...pts] : pts);
      await sleep(16);
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

  // 2. Quick tap on the right half is ignored.
  await touch('touchStart', [R]);
  await ticks(page, 2);
  await touch('touchEnd', []);
  await ticks(page, 10);
  const s2 = await state(page);
  check('quick tap on right half does not fire', s2.shots === s1.shots, `shots=${s2.shots}`);

  // 3. Pistol lift-to-fire: dragging shows only the aim line; lifting fires one shot.
  await touch('touchStart', [R]);
  await dragRight(70, 0); // PUSH mode (default): drag right → aim right
  await ticks(page, 40);
  const s3 = await state(page);
  check('dragging right stick shows aim line', s3.aimLineVisible === true);
  check('pistol: no shot while dragging', s3.shots === s2.shots, `shots=${s3.shots - s2.shots}`);
  check('aim settles on the pulled direction (+X)', Math.abs(s3.aimX - 1) < 0.01 && Math.abs(s3.aimZ) < 0.01, `aim=(${s3.aimX.toFixed(2)},${s3.aimZ.toFixed(2)})`);
  await page.screenshot({ path: `${OUT}/${deviceName.replace(/\W+/g, '-')}${landscape ? '-landscape' : ''}-aiming.png` });
  await touch('touchEnd', []);
  await ticks(page, 6);
  const s4 = await state(page);
  check('pistol: lifting the thumb fires exactly one shot', s4.shots - s3.shots === 1, `shots=${s4.shots - s3.shots}`);
  check('aim line hidden after release', s4.aimLineVisible === false);

  // 4. Shot cancel: drag out, back into the deadzone, release → nothing.
  await ticks(page, 15);
  await touch('touchStart', [R]);
  await dragRight(0, 70); // drag down → aim down
  await ticks(page, 10);
  check('aim line visible (down)', (await state(page)).aimLineVisible);
  for (let i = 4; i >= 0; i--) { await touch('touchMove', [{ ...R, y: R.y + i * 14 * 0.2 }]); await sleep(16); }
  await ticks(page, 10);
  const s5 = await state(page);
  check('dragging back into deadzone hides aim line', s5.aimLineVisible === false);
  await touch('touchEnd', []);
  await ticks(page, 10);
  check('cancelled shot does not fire', (await state(page)).shots === s4.shots);

  // 5. Multi-touch: move and aim at the same time, lift to fire while moving.
  const m0 = await state(page);
  await touch('touchStart', [L]);
  for (let i = 1; i <= 5; i++) { await touch('touchMove', [{ ...L, y: L.y - i * 14 }]); await sleep(16); }
  await touch('touchStart', [LU, R]);
  await dragRight(-70, 0, LU); // drag left → aim left
  await ticks(page, 30);
  const m1 = await state(page);
  check('multi-touch: moving while aiming left', m0.z - m1.z > 1 && m1.aimX < -0.99, `dz=${(m0.z - m1.z).toFixed(2)} aimX=${m1.aimX.toFixed(2)}`);
  await touch('touchEnd', [{ ...R, x: R.x - 70 }]); // CDP: touchEnd lists the finger(s) being lifted
  await ticks(page, 6);
  const m2 = await state(page);
  check('multi-touch: lifting right thumb fires while still moving', m2.shots - m1.shots === 1, `shots=${m2.shots - m1.shots}`);
  await touch('touchEnd', []);
  await ticks(page, 6);

  // 6. Automatic weapon: hold-to-fire, cancel stops firing.
  await page.tap('#switch-btn');
  await ticks(page, 3);
  check('⇄ button switches to SMG', (await state(page)).weapon === 'smg');
  const f0 = await state(page);
  await touch('touchStart', [R]);
  await dragRight(0, -30); // inner ring: aim only
  await ticks(page, 30);
  const fa = await state(page);
  check('SMG: light push aims without firing', fa.aimLineVisible && fa.shots === f0.shots, `shots=${fa.shots - f0.shots}`);
  for (let i = 1; i <= 4; i++) { await touch('touchMove', [{ ...R, y: R.y - 30 - i * 10 }]); await sleep(16); }
  await ticks(page, 60);
  const f1 = await state(page);
  check('SMG: fires continuously while aimed', f1.shots - f0.shots >= 9, `shots=${f1.shots - f0.shots}`);
  await page.screenshot({ path: `${OUT}/${deviceName.replace(/\W+/g, '-')}${landscape ? '-landscape' : ''}-smg.png` });
  for (let i = 4; i >= 0; i--) { await touch('touchMove', [{ ...R, y: R.y - i * 14 * 0.2 }]); await sleep(16); }
  await ticks(page, 6);
  const f2 = await state(page);
  await ticks(page, 30);
  const f3 = await state(page);
  check('SMG: back into deadzone stops firing', f3.shots === f2.shots && !f3.aimLineVisible, `extra=${f3.shots - f2.shots}`);
  await touch('touchEnd', []);
  await ticks(page, 10);
  check('SMG: release after cancel fires nothing', (await state(page)).shots === f3.shots);

  // 7. Reload button.
  await page.tap('#reload-btn');
  await ticks(page, 3);
  const s6 = await state(page);
  check('reload button works', s6.reloading || s6.ammo === 30, `ammo=${s6.ammo}`);

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
  // Two zombies in a line straight ahead: one pistol round should pass through the first into the second.
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
  check('pistol round passes through one zombie into the next', b.zombieHits - a.zombieHits >= 2 && b.penetrations > a.penetrations, `hits=${b.zombieHits - a.zombieHits}`);
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
  check('no JS errors (lab)', errors.length === 0, errors.join(' | '));
  await page.close();
}

try {
  await waitForServer();
  const browser = await chromium.launch(launchArgs);
  // SMOKE_ONLY=lab|desktop|phone runs one scenario (for quick local checks).
  const only = process.env.SMOKE_ONLY;
  if (!only || only === 'desktop') await desktop(browser);
  if (!only || only === 'lab') await ragdollLab(browser);
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
