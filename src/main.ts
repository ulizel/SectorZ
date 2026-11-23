import './style.css';
import { initPhysics } from './physics/physicsWorld';
import { pickQuality } from './core/quality';
import type { Game } from './game';

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

// iOS Safari: block pinch/double-tap zoom gestures that fight the twin sticks.
for (const ev of ['gesturestart', 'gesturechange', 'dblclick']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

const status = document.getElementById('status')!;
const startBtn = document.getElementById('start') as HTMLButtonElement;

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
    quality,
  );
  api.game = game;
  api.state = () => game.snapshot();
  // Render one frame behind the title card so the scene is visible immediately.
  game.loop.advance(0);
  game.renderer.updateCamera(game.player.x, game.player.z, 0, 1, 1);
  game.renderer.render();

  status.textContent = quality.name === 'mobile'
    ? 'Left thumb: move · Right thumb: aim & fire'
    : 'WASD: move · Mouse: aim · Click: fire · R: reload';
  startBtn.disabled = false;
  startBtn.textContent = quality.name === 'mobile' ? 'TAP TO PLAY' : 'CLICK TO PLAY';
  const begin = () => {
    document.getElementById('title')!.classList.add('hidden');
    game.start();
    api.ready = true;
  };
  startBtn.addEventListener('click', begin, { once: true });
  if (new URLSearchParams(location.search).has('autostart')) begin();
}

boot().catch((err) => {
  console.error(err);
  api.errors.push(String(err));
  status.textContent = `Failed to start: ${err instanceof Error ? err.message : err}`;
});
