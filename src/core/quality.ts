export interface QualityPreset {
  name: 'mobile' | 'desktop';
  pixelRatio: number;
  shadows: boolean;
  shadowMapSize: number;
  antialias: boolean;
  maxSparks: number;
  maxCasings: number;
}

export function isTouchDevice(): boolean {
  return typeof window !== 'undefined' &&
    (window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window);
}

export function pickQuality(): QualityPreset {
  const params = new URLSearchParams(location.search);
  const forced = params.get('quality');
  const mobile = forced ? forced === 'mobile' : isTouchDevice();
  const dpr = window.devicePixelRatio || 1;
  return mobile
    ? { name: 'mobile', pixelRatio: Math.min(dpr, 1.5), shadows: true, shadowMapSize: 1024, antialias: false, maxSparks: 160, maxCasings: 24 }
    : { name: 'desktop', pixelRatio: Math.min(dpr, 2), shadows: true, shadowMapSize: 2048, antialias: true, maxSparks: 400, maxCasings: 48 };
}
