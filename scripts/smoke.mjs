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
async function waitReady(page) {
  await page.waitForFunction(() => window.__SECTORZ__?.ready === true, null, { timeout: 30000 });
}
/** Project a world point to screen pixels using the game's own camera. */
const worldToScreen = (page, x, y, z) => page.evaluate(([x, y, z]) => {
  const cam = window.__SECTORZ__.game.renderer.camera;
  const v = cam.position.clone().set(x, y, z).project(cam);
  return { x: (v.x + 1) / 2 * innerWidth, y: (1 - v.y) / 2 * innerHeight };
}, [x, y, z]);

const launchArgs = { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] };

async function desktop(browser) {
  console.log('\n[desktop 1280x720, keyboard + mouse]');
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${BASE}?quality=desktop`);
  await page.waitForSelector('#start:not([disabled])', { timeout: 30000 });
  await page.screenshot({ path: `${OUT}/desktop-title.png` });
  await page.click('#start');
  await waitReady(page);
  await sleep(500);
  const s0 = await state(page);
  check('game running (sim ticks advancing)', s0.ticks > 10, `ticks=${s0.ticks}`);
  console.log(`    (fps in headless software GL: ${(await state(page)).fps.toFixed(1)})`);

  // Shoot the barrel at (6,-1) from spawn: aim with the mouse, hold fire.
  // The camera leans toward the aim direction, so re-project until it settles.
  for (let i = 0; i < 5; i++) {
    const target = await worldToScreen(page, 6, 1.15, -1);
    await page.mouse.move(target.x, target.y);
    await sleep(400);
  }
  const aimYaw = (await state(page)).yaw;
  const yawTarget = Math.atan2(6 - s0.x, -1 - s0.z);
  check('player faces the mouse target', Math.abs(Math.atan2(Math.sin(aimYaw - yawTarget), Math.cos(aimYaw - yawTarget))) < 0.12, `yaw=${aimYaw.toFixed(2)} want≈${yawTarget.toFixed(2)}`);
  // Keep the cursor on target while firing.
  const keepAim = setInterval(async () => {
    try { const t = await worldToScreen(page, 6, 1.15, -1); await page.mouse.move(t.x, t.y); } catch {}
  }, 150);
  await page.mouse.down();
  await sleep(1500);
  await page.mouse.up();
  clearInterval(keepAim);
  await sleep(1200);
  const s1 = await state(page);
  check('mouse fire produces shots', s1.shots >= 5, `shots=${s1.shots}`);
  check('ammo consumed / reloading', s1.ammo < 12 || s1.reloading, `ammo=${s1.ammo}`);
  check('bullets hit dynamic props', s1.propHits >= 3, `propHits=${s1.propHits}`);
  check('props physically displaced by bullets', s1.maxPropMove > 0.15, `maxPropMove=${s1.maxPropMove.toFixed(2)}m`);
  await page.screenshot({ path: `${OUT}/desktop-shooting.png` });

  // WASD movement: hold W for 1 s → move toward -Z by ~5 m.
  await page.keyboard.down('KeyW');
  await sleep(1000);
  await page.keyboard.up('KeyW');
  await sleep(200);
  const s2 = await state(page);
  check('W moves the player up-screen (-Z)', s1.z - s2.z > 3, `dz=${(s1.z - s2.z).toFixed(2)}`);
  await page.keyboard.down('KeyD');
  await sleep(600);
  await page.keyboard.up('KeyD');
  const s3 = await state(page);
  check('D moves the player right (+X)', s3.x - s2.x > 1.5, `dx=${(s3.x - s2.x).toFixed(2)}`);

  // Manual reload.
  await page.keyboard.press('KeyR');
  await sleep(100);
  const s4 = await state(page);
  check('R reloads (or mag already full)', s4.reloading || s4.ammo === 12, `ammo=${s4.ammo} reloading=${s4.reloading}`);
  await sleep(1500);
  await page.screenshot({ path: `${OUT}/desktop-moved.png` });
  check('no JS errors (desktop)', errors.length === 0 && (await page.evaluate(() => window.__SECTORZ__.errors.length)) === 0, errors.join(' | '));
  await page.close();
}

async function phone(browser, deviceName, landscape) {
  console.log(`\n[${deviceName}${landscape ? ' landscape' : ''}, real touch events]`);
  const d = devices[deviceName];
  const ctx = await browser.newContext({
    ...d,
    deviceScaleFactor: 1, // software GL in CI is slow at 3x; touch + mobile UA are unchanged
    viewport: landscape ? { width: d.viewport.height, height: d.viewport.width } : d.viewport,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.waitForSelector('#start:not([disabled])', { timeout: 30000 });
  check('touch device detected → mobile quality + touch UI', await page.evaluate(() => document.body.classList.contains('touch')));
  await page.tap('#start');
  await waitReady(page);
  await sleep(400);
  const cdp = await ctx.newCDPSession(page);
  const vw = page.viewportSize().width, vh = page.viewportSize().height;
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  const L = { x: vw * 0.22, y: vh * 0.7, id: 1 };
  const R = { x: vw * 0.78, y: vh * 0.7, id: 2 };

  const s0 = await state(page);
  // Left thumb: push up to walk toward -Z.
  await touch('touchStart', [L]);
  for (let i = 1; i <= 5; i++) { await touch('touchMove', [{ ...L, y: L.y - i * 14 }]); await sleep(16); }
  await sleep(900);
  // Add right thumb: aim right and fire while still moving.
  await touch('touchStart', [{ ...L, y: L.y - 70 }, R]);
  for (let i = 1; i <= 5; i++) { await touch('touchMove', [{ ...L, y: L.y - 70 }, { ...R, x: R.x + i * 14 }]); await sleep(16); }
  await sleep(1200);
  await page.screenshot({ path: `${OUT}/${deviceName.replace(/\W+/g, '-')}${landscape ? '-landscape' : ''}.png` });
  await touch('touchEnd', []);
  await sleep(200);
  const s1 = await state(page);
  console.log(`    (fps in headless software GL: ${s1.fps.toFixed(1)})`);
  check('left stick moves player up (-Z)', s0.z - s1.z > 3, `dz=${(s0.z - s1.z).toFixed(2)}`);
  check('right stick fires', s1.shots >= 4, `shots=${s1.shots}`);
  check('right stick aims (+X → yaw≈+π/2)', Math.abs(s1.yaw - Math.PI / 2) < 0.3, `yaw=${s1.yaw.toFixed(2)}`);
  const s2 = await state(page);
  await sleep(300);
  const s3 = await state(page);
  check('player stops when thumbs lift', Math.hypot(s3.x - s2.x, s3.z - s2.z) < 0.05);
  await page.tap('#reload-btn');
  await sleep(100);
  const s4 = await state(page);
  check('reload button works', s4.reloading || s4.ammo === 12, `ammo=${s4.ammo}`);
  check('no JS errors (phone)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

try {
  await waitForServer();
  const browser = await chromium.launch(launchArgs);
  await desktop(browser);
  await phone(browser, 'iPhone 13', false);
  await phone(browser, 'Pixel 7', true);
  await browser.close();
} catch (e) {
  console.error(e);
  failures++;
} finally {
  server.kill();
}
console.log(failures ? `\nSMOKE FAILED (${failures})` : '\nSMOKE PASSED');
process.exit(failures ? 1 : 0);
