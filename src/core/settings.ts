/** Player settings, remembered per device (storage can be unavailable: always fall back to defaults). */
const KEY = 'sectorz.settings';

interface Settings {
  /** Touch aim "pull" mode: drag back to aim forward (slingshot). Default off (push: stick points where you aim). */
  aimReverse: boolean;
}

function load(): Settings {
  const s: Settings = { aimReverse: false };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) Object.assign(s, JSON.parse(raw));
  } catch { /* private mode etc. */ }
  const q = new URLSearchParams(location.search).get('aim');
  if (q === 'push') s.aimReverse = false;
  if (q === 'pull') s.aimReverse = true;
  return s;
}

export const settings = load();

export function saveSettings(): void {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}
