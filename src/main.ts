import './style.css';
import { initPhysics } from './physics/physicsWorld';
import { pickQuality } from './core/quality';
import type { Game } from './game';
import { settings, saveSettings } from './core/settings';

declare global {
  interface Window {
    __SECTORZ__: {
      ready: boolean;
      errors: string[];
      game?: Game;
      state?: () => ReturnType<Game['snapshot']>;
    };
  }
}

const api: Window['__SECTORZ__'] = (window.__SECTORZ__ = { ready: false, errors: [] });
addEventListener('error', (e) => api.errors.push(String(e.message)));
addEventListener('unhandledrejection', (e) => api.errors.push(String(e.reason)));

lockMobileBrowser();

/**
 * Mobile browser lock: no scrolling, pinch/double-tap zoom, text selection, long-press
 * callouts or pull-to-refresh, so multi-touch twin-stick input stays smooth.
 * CSS (touch-action / overscroll-behavior / user-select) handles Chrome/Android;
 * the listeners cover iOS Safari, which ignores parts of the CSS.
 */
function lockMobileBrowser(): void {
  const block = (e: Event) => { if (e.cancelable) e.preventDefault(); };
  const opts = { passive: false } as const;
  // All touches belong to the game. Buttons use Pointer Events, which still fire.
  document.addEventListener('touchstart', block, opts);
  document.addEventListener('touchmove', block, opts);
  document.addEventListener('touchend', block, opts); // kills double-tap-to-zoom + synthetic clicks
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend', 'dblclick', 'contextmenu', 'selectstart', 'dragstart']) {
    document.addEventListener(ev, block, opts);
  }
  // Ctrl+wheel / trackpad pinch zoom on desktop browsers.
  document.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, opts);
  // If anything ever scrolls the document (iOS address-bar quirks), snap it back.
  addEventListener('scroll', () => { if (scrollX || scrollY) scrollTo(0, 0); }, { passive: true });
}

const status = document.getElementById('status')!;
const startBtn = document.getElementById('start') as HTMLButtonElement;
const labBtn = document.getElementById('start-lab') as HTMLButtonElement;

async function boot(): Promise<void> {
  const quality = pickQuality();
  document.body.classList.toggle('touch', quality.name === 'mobile');
  status.textContent = 'Loading physics…';
  await initPhysics();
  status.textContent = 'Building sector…';
  const { Game } = await import('./game');
  const game = new Game(
    document.getElementById('app')!,
    document.getElementById('touch')!,
    document.getElementById('reload-btn')!,
    document.getElementById('switch-btn')!,
    quality,
  );
  api.game = game;
  // Aim direction toggle: PULL (slingshot, default) or PUSH (stick points where you aim).
  const aimBtn = document.getElementById('aim-toggle')!;
  const label = () => { aimBtn.textContent = settings.aimReverse ? 'AIM: PULL' : 'AIM: PUSH'; };
  label();
  aimBtn.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); e.preventDefault();
    settings.aimReverse = !settings.aimReverse;
    saveSettings();
    label();
  });
  api.state = () => game.snapshot();
  // Render one frame behind the title card so the scene is visible immediately.
  game.loop.advance(0);
  game.renderer.updateCamera(game.player.x, game.player.z, 0, 1, 1);
  game.renderer.render();

  status.textContent = quality.name === 'mobile'
    ? 'Left thumb: move · Right thumb: drag to aim, release to shoot (SMG: hold) · ⇄ weapon'
    : 'WASD move · Mouse aim · Click fire · R reload · 1/2/Q switch weapon';
  startBtn.disabled = false;
  labBtn.disabled = false;
  startBtn.textContent = quality.name === 'mobile' ? 'TAP TO PLAY' : 'CLICK TO PLAY';
  let started = false;
  const begin = (lab: boolean) => {
    if (started) return;
    started = true;
    document.getElementById('title')!.classList.add('hidden');
    if (lab) enterLab(game);
    game.start();
    api.ready = true;
  };
  // pointer, not click: touch defaults are blocked
  startBtn.addEventListener('pointerup', () => begin(false));
  labBtn.addEventListener('pointerup', () => begin(true));
  const q = new URLSearchParams(location.search);
  if (q.has('autostart') || q.has('lab')) begin(q.has('lab'));
}

boot().catch((err) => {
  console.error(err);
  api.errors.push(String(err));
  status.textContent = `Failed to start: ${err instanceof Error ? err.message : err}`;
});

/** Ragdoll Lab: spawn test zombies, blow them up, slow motion. Keys: Z spawn, B boom, T slow-mo, C clear. */
function enterLab(game: Game): void {
  game.lab = true;
  document.body.classList.add('lab');
  game.spawnZombies(5);
  const actions: Record<string, (btn?: HTMLElement) => void> = {
    spawn: () => game.spawnZombies(5),
    boom: () => game.explodeAtAim(),
    slow: (btn) => {
      game.loop.timeScale = game.loop.timeScale === 1 ? 0.25 : 1;
      (btn ?? document.querySelector('[data-lab="slow"]'))?.classList.toggle('on', game.loop.timeScale !== 1);
    },
    clear: () => game.zombies.clear(),
  };
  document.querySelectorAll<HTMLElement>('#lab-panel button').forEach((b) => {
    b.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); actions[b.dataset.lab!](b); });
  });
  const keys: Record<string, string> = { KeyZ: 'spawn', KeyB: 'boom', KeyT: 'slow', KeyC: 'clear' };
  addEventListener('keydown', (e) => { const a = keys[e.code]; if (a && !e.repeat) actions[a](); });
}
