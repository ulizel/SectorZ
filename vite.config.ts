import { defineConfig } from 'vite';

// Relative base so the build works under the GitHub Pages sub-path (/SectorZ/).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 5000,
    rollupOptions: {
      output: { manualChunks: { three: ['three'], rapier: ['@dimforge/rapier3d-compat'] } },
    },
  },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
} as any);
