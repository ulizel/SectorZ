import * as THREE from 'three';

/** One unit cube shared by every voxel mesh: scale it per use. */
export const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

const matCache = new Map<string, THREE.MeshLambertMaterial>();
/** Shared flat Lambert material per colour (cheap on mobile, consistent look). */
export function voxelMat(color: number, emissive = 0): THREE.MeshLambertMaterial {
  const key = `${color}:${emissive}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color, emissive });
    matCache.set(key, m);
  }
  return m;
}

export function box(w: number, h: number, d: number, color: number, x = 0, y = 0, z = 0, emissive = 0): THREE.Mesh {
  const m = new THREE.Mesh(UNIT_BOX, voxelMat(color, emissive));
  m.scale.set(w, h, d);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Slightly vary a colour so repeated blocks don't look copy-pasted. */
export function jitterColor(hex: number, amount: number, r: () => number): THREE.Color {
  const c = new THREE.Color(hex);
  const f = 1 + (r() - 0.5) * 2 * amount;
  return c.multiplyScalar(f);
}

/** Palette: one place to keep the look consistent. */
export const PAL = {
  skin: 0xe0ac7e,
  hair: 0x3b2a1e,
  shirt: 0x2f6f8f,
  vest: 0x4a5a32,
  pants: 0x384152,
  boots: 0x2a2320,
  gun: 0x2b2d31,
  gunAccent: 0x6b6f76,
  concrete: 0x8d8a83,
  concreteDark: 0x6e6b66,
  crate: 0xa0703f,
  crateEdge: 0x6e4a27,
  barrel: 0xb8432f,
  barrelBand: 0x5a2219,
  asphalt: 0x4a4b4f,
  grass: 0x5b7a3a,
  lamp: 0xffd38a,
  metal: 0x5d6168,
  rust: 0x8a4b2c,
} as const;
