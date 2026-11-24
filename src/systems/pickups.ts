import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type PickupKind = 'ammo' | 'health' | 'grenade';

/** Loot tunables. */
export const LOOT = {
  ammoChance: 0.3,
  healthChance: 0.15,
  grenadeChance: 0.05,
  ammoAmount: 30, // SMG rounds
  shellAmount: 6, // shotgun shells
  healthAmount: 25,
  life: 25, // s before it disappears (blinks the last 5 s)
  radius: 1.0, // walk within this to collect
  max: 14,
};

interface Pickup { kind: PickupKind; x: number; z: number; t: number; mesh: THREE.Mesh; halo: THREE.Mesh }

/** Loot glows in the dark so it can be found: a soft additive halo, coloured by kind. */
const HALO_GEO = new THREE.IcosahedronGeometry(0.36, 1);
const HALO_COLOR: Record<PickupKind, number> = { ammo: 0x3a300a, health: 0x3a0e0e, grenade: 0x1c300e };

function coloredBoxes(parts: [number, number, number, number, number, number, number][]): THREE.BufferGeometry {
  const col = new THREE.Color();
  return mergeGeometries(parts.map(([w, h, d, c, x, y, z]) => {
    const g = new THREE.BoxGeometry(w, h, d).translate(x, y, z);
    g.deleteAttribute('uv');
    col.setHex(c);
    const n = g.attributes.position.count, arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) arr.set([col.r, col.g, col.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return g;
  }))!;
}

/** Voxel loot that bobs and spins; walk over it to collect. Pure rendering + simple logic. */
export class Pickups {
  readonly list: Pickup[] = [];
  private readonly geo: Record<PickupKind, THREE.BufferGeometry>;
  private readonly mat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x3a3a3a });
  private readonly haloMat = Object.fromEntries((Object.keys(HALO_COLOR) as PickupKind[]).map((k) => [k,
    new THREE.MeshBasicMaterial({ color: HALO_COLOR[k], transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })])) as Record<PickupKind, THREE.MeshBasicMaterial>;
  private time = 0;

  constructor(private readonly scene: THREE.Scene) {
    this.geo = {
      // Olive ammo box with a brass stripe.
      ammo: coloredBoxes([[0.42, 0.24, 0.26, 0x55602f, 0, 0, 0], [0.43, 0.05, 0.27, 0xd9a441, 0, 0.05, 0], [0.12, 0.04, 0.06, 0x2b2d31, 0, 0.14, 0]]),
      // White med kit with a red cross.
      health: coloredBoxes([[0.38, 0.26, 0.26, 0xeeeeea, 0, 0, 0], [0.24, 0.07, 0.272, 0xd0202a, 0, 0, 0], [0.07, 0.2, 0.272, 0xd0202a, 0, 0, 0]]),
      // Olive frag grenade: body, darker bands, fuse cap and lever.
      grenade: coloredBoxes([[0.22, 0.28, 0.22, 0x4a5a32, 0, 0, 0], [0.235, 0.04, 0.235, 0x34401f, 0, 0.05, 0], [0.235, 0.04, 0.235, 0x34401f, 0, -0.06, 0],
        [0.1, 0.07, 0.1, 0x8c8f94, 0, 0.17, 0], [0.04, 0.2, 0.05, 0x8c8f94, 0.13, 0.08, 0], [0.06, 0.06, 0.02, 0xd9a441, -0.06, 0.2, 0]]),
    };
  }

  spawn(kind: PickupKind, x: number, z: number): void {
    if (this.list.length >= LOOT.max) this.remove(0);
    const mesh = new THREE.Mesh(this.geo[kind], this.mat);
    mesh.castShadow = true;
    mesh.position.set(x, 0.4, z);
    const halo = new THREE.Mesh(HALO_GEO, this.haloMat[kind]);
    halo.position.set(x, 0.4, z);
    this.scene.add(mesh, halo);
    this.list.push({ kind, x, z, t: LOOT.life, mesh, halo });
  }

  /** Roll loot for a dead zombie. */
  roll(x: number, z: number, rand = Math.random): void {
    const r = rand();
    if (r < LOOT.healthChance) this.spawn('health', x, z);
    else if (r < LOOT.healthChance + LOOT.ammoChance) this.spawn('ammo', x, z);
    else if (r < LOOT.healthChance + LOOT.ammoChance + LOOT.grenadeChance) this.spawn('grenade', x, z);
  }

  /**
   * Age pickups and collect those within reach. `take(kind)` returns true if the player could
   * use it (full health / full ammo leaves it on the ground).
   */
  update(dt: number, px: number, pz: number, alive: boolean, take: (k: PickupKind) => boolean): void {
    this.time += dt;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.t -= dt;
      if (p.t <= 0) { this.remove(i); continue; }
      if (alive && Math.hypot(p.x - px, p.z - pz) < LOOT.radius && take(p.kind)) { this.remove(i); continue; }
      p.mesh.position.y = 0.4 + Math.sin(this.time * 3 + i) * 0.08;
      p.mesh.rotation.y = this.time * 1.8 + i;
      p.mesh.visible = p.halo.visible = p.t > 5 || Math.floor(p.t * 6) % 2 === 0; // blink before vanishing
      p.halo.position.y = p.mesh.position.y;
      p.halo.scale.setScalar(0.85 + 0.15 * Math.sin(this.time * 4 + i));
    }
  }

  private remove(i: number): void {
    this.scene.remove(this.list[i].mesh, this.list[i].halo);
    this.list.splice(i, 1);
  }

  clear(): void { while (this.list.length) this.remove(0); }
}
