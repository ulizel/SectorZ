# Sector Z

Top-down voxel zombie survival shooter with real ragdoll physics and dismemberment (in development).
Three.js + Rapier 3D + TypeScript, deployed to GitHub Pages.

**Play:** https://ulizel.github.io/SectorZ/ · add `?debug=1` for the performance overlay.

| | Desktop | Phone |
|---|---|---|
| Move | WASD / arrows | left thumb (floating stick) |
| Aim | mouse | right thumb |
| Fire | click / hold, Space | push right stick past ~⅓ |
| Reload | R | R button |

```bash
npm install
npm run dev        # local dev server (also on LAN for phone testing)
npm test           # unit + headless physics tests
npm run build && npm run smoke   # browser smoke test with screenshots in test-results/
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for design, budgets and roadmap.
