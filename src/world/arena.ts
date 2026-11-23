import * as THREE from 'three';
import { ARENA, PROPS } from '../config';
import { rng } from '../core/math';
import { Group, groups, ALL, RAPIER, type PhysicsWorld } from '../physics/physicsWorld';
import { box, jitterColor, PAL, UNIT_BOX } from '../render/voxel';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface DynamicProp {
  body: RAPIER.RigidBody;
  mesh: THREE.Object3D;
  kind: 'crate' | 'barrel';
  /** Footprint radius (m) for AI avoidance. */
  radius: number;
  /** Explodes when shot / caught in a blast. */
  explosive?: boolean;
  /** Seconds until it goes off (set once ignited). */
  fuse?: number;
  /** Fuse length when lit (s), for the danger-zone warning. */
  fuseTotal?: number;
}

/** A barrel prop (plain or explosive). Exported so the game can drop fresh ones between waves. */
export function spawnBarrel(scene: THREE.Scene, physics: PhysicsWorld, x: number, z: number, explosive: boolean): DynamicProp {
  const w = physics.world;
  const body = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, 0.6, z).setLinearDamping(0.2).setAngularDamping(0.5));
  const col = w.createCollider(RAPIER.ColliderDesc.cylinder(0.6, 0.36).setDensity(PROPS.barrelDensity).setFriction(0.6).setRestitution(0.2)
    .setCollisionGroups(groups(Group.PROP, ALL)), body);
  physics.materials.set(col.handle, 'metal');
  // One merged 8-sided mesh (barrel + raised bands), one draw call.
  const g = new THREE.Mesh(barrelGeo(explosive), barrelMaterial());
  g.castShadow = g.receiveShadow = true;
  scene.add(g);
  return { body, mesh: g, kind: 'barrel', radius: 0.4, explosive };
}

interface Block { x: number; y: number; z: number; w: number; h: number; d: number; color: number }

/**
 * Builds the test arena: a walled courtyard with concrete cover, a wrecked car,
 * lamp posts and physics crates/barrels to shoot. Deterministic (seeded) layout.
 */
export function buildArena(scene: THREE.Scene, physics: PhysicsWorld, seed = 7): DynamicProp[] {
  const r = rng(seed);
  const w = physics.world;
  const half = ARENA.size / 2;

  // Ground: one plane with a pixel-noise texture for a voxel look.
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(ARENA.size + 40, ARENA.size + 40), new THREE.MeshLambertMaterial({ map: groundTexture(r) }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  w.createCollider(RAPIER.ColliderDesc.cuboid(half + 20, 0.5, half + 20).setTranslation(0, -0.5, 0)
    .setCollisionGroups(groups(Group.STATIC, ALL)).setFriction(0.9));

  const blocks: Block[] = [];
  const addStatic = (x: number, y: number, z: number, wd: number, h: number, d: number, color: number, visual = true, mat: 'concrete' | 'metal' = 'concrete') => {
    if (visual) blocks.push({ x, y, z, w: wd, h, d, color });
    const col = w.createCollider(RAPIER.ColliderDesc.cuboid(wd / 2, h / 2, d / 2).setTranslation(x, y, z)
      .setCollisionGroups(groups(Group.STATIC, ALL)).setFriction(0.8));
    if (mat !== 'concrete') physics.materials.set(col.handle, mat);
  };

  // Perimeter wall built from 1m concrete blocks with a few gaps of rubble.
  const H = ARENA.wallHeight;
  for (let i = -half; i < half; i += 1) {
    for (const [x, z] of [[i + 0.5, -half], [i + 0.5, half], [-half, i + 0.5], [half, i + 0.5]] as const) {
      const h = H * (0.75 + r() * 0.5);
      // Exactly 1 m wide: overlapping neighbours made coplanar faces z-fight (flicker).
      blocks.push({ x, y: h / 2, z, w: 1, h, d: 1, color: r() < 0.5 ? PAL.concrete : PAL.concreteDark });
    }
  }
  for (const [x, z, wd, d] of [[0, -half, ARENA.size + 1, 1], [0, half, ARENA.size + 1, 1], [-half, 0, 1, ARENA.size + 1], [half, 0, 1, ARENA.size + 1]] as const) {
    addStatic(x, H, z, wd, H * 2, d, 0, false); // tall invisible collider so nothing escapes
  }

  // Concrete cover: L-shapes and jersey barriers.
  const cover: [number, number, number, number][] = [
    [-8, -6, 4, 1], [-8, -4.5, 1, 2], [8, 6, 4, 1], [9.5, 4.5, 1, 2],
    [-10, 8, 1, 4], [10, -8, 1, 4], [0, -12, 5, 1], [0, 12, 5, 1],
  ];
  for (const [x, z, wd, d] of cover) addStatic(x, 0.6, z, wd, 1.2, d, r() < 0.5 ? PAL.concrete : PAL.concreteDark);

  // Wrecked car (static, built from blocks).
  buildCar(scene, physics, -14, -14, 0.4);
  buildCar(scene, physics, 13, 12, -0.9);

  // Instanced static blocks: one draw call for all the concrete.
  const inst = new THREE.InstancedMesh(UNIT_BOX, new THREE.MeshLambertMaterial({ color: 0xffffff }), blocks.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  blocks.forEach((b, i) => {
    inst.setMatrixAt(i, m.compose(p.set(b.x, b.y, b.z), q, s.set(b.w, b.h, b.d)));
    inst.setColorAt(i, jitterColor(b.color, 0.08, r));
  });
  inst.castShadow = inst.receiveShadow = true;
  scene.add(inst);

  // Lamp posts with warm emissive heads (cheap "light", no real point lights).
  for (const [x, z] of [[-15, 0], [15, 0], [0, -17], [0, 17]] as const) {
    scene.add(box(0.18, 3.2, 0.18, PAL.metal, x, 1.6, z));
    scene.add(box(0.5, 0.18, 0.5, PAL.metal, x, 3.25, z));
    scene.add(box(0.36, 0.08, 0.36, PAL.lamp, x, 3.14, z, PAL.lamp));
    addStatic(x, 1.6, z, 0.2, 3.2, 0.2, 0, false, 'metal');
  }

  // Scatter decor: grass tufts and rubble (visual only, instanced).
  // Grass grows in clumps (near walls/cover), rubble is flat — keeps the floor readable.
  const DECOR = 160;
  const decor = new THREE.InstancedMesh(UNIT_BOX, new THREE.MeshLambertMaterial({ color: 0xffffff }), DECOR);
  const clumps = Array.from({ length: 14 }, () => [(r() - 0.5) * (ARENA.size - 4), (r() - 0.5) * (ARENA.size - 4)]);
  for (let i = 0; i < DECOR; i++) {
    const grass = i < 110;
    let x: number, z: number;
    if (grass) { const c = clumps[i % clumps.length]; x = c[0] + (r() - 0.5) * 2.2; z = c[1] + (r() - 0.5) * 2.2; }
    else { x = (r() - 0.5) * (ARENA.size - 3); z = (r() - 0.5) * (ARENA.size - 3); }
    const sz = grass ? 0.07 + r() * 0.07 : 0.08 + r() * 0.16;
    const h = grass ? sz * (1.5 + r() * 2) : sz * 0.35;
    q.setFromEuler(new THREE.Euler(0, r() * 3, 0));
    decor.setMatrixAt(i, m.compose(p.set(x, h / 2, z), q, s.set(sz, h, sz)));
    decor.setColorAt(i, jitterColor(grass ? 0x4a6330 : PAL.concreteDark, 0.18, r));
  }
  decor.receiveShadow = true;
  scene.add(decor);

  // Dynamic props: crates (some stacked) and barrels.
  const props: DynamicProp[] = [];
  const crate = (x: number, y: number, z: number, sz: number) => {
    const body = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z)
      .setRotation(quatY(r() * 0.4 - 0.2)).setLinearDamping(0.2).setAngularDamping(0.4).setCcdEnabled(false));
    const crateCol = w.createCollider(RAPIER.ColliderDesc.cuboid(sz / 2, sz / 2, sz / 2).setDensity(PROPS.crateDensity)
      .setFriction(0.7).setRestitution(0.15).setCollisionGroups(groups(Group.PROP, ALL)), body);
    physics.materials.set(crateCol.handle, 'wood');
    // One box (12 triangles) with a pixel plank texture: no overlapping faces, no z-fighting.
    const g = new THREE.Mesh(crateGeo(sz), crateMaterial());
    g.castShadow = g.receiveShadow = true;
    scene.add(g);
    props.push({ body, mesh: g, kind: 'crate', radius: sz * 0.62 });
  };
  for (const [x, z] of [[4, -4], [-4, 4], [5, 9], [-6, -10], [12, -3], [-12, 3]] as const) {
    crate(x, 0.6, z, 1.2);
    if (r() < 0.6) crate(x + 0.1, 1.8, z - 0.05, 1.2);
  }
  crate(-3, 0.45, -3, 0.9); crate(-2.2, 0.45, -3.3, 0.9); crate(-2.6, 1.35, -3.15, 0.9);
  // Every other barrel is explosive (hazard stripe).
  [[6, -1], [6.8, -1.6], [-5, 1], [2, 14], [-15, -6], [15, 6]].forEach(([x, z], i) => props.push(spawnBarrel(scene, physics, x, z, i % 2 === 0)));

  return props;
}

function quatY(a: number) { return { x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) }; }

/**
 * Wrecked car: one merged, properly rotated voxel mesh, with colliders that match the body
 * and cabin exactly (bullets fly over the bonnet and hit the cabin, no invisible walls).
 */
function buildCar(scene: THREE.Scene, physics: PhysicsWorld, cx: number, cz: number, yaw: number): void {
  const parts: [number, number, number, number, number, number, number][] = [
    // x, y, z (local), w, h, d, colour
    [0, 0.55, 0, 1.9, 0.7, 4, PAL.rust],
    [0, 1.15, -0.3, 1.7, 0.5, 2, 0x6f7f8a],
    [-0.9, 0.3, 1.3, 0.3, 0.6, 0.6, 0x1d1d1f], [0.9, 0.3, 1.3, 0.3, 0.6, 0.6, 0x1d1d1f],
    [-0.9, 0.3, -1.3, 0.3, 0.6, 0.6, 0x1d1d1f], [0.9, 0.3, -1.3, 0.3, 0.6, 0.6, 0x1d1d1f],
  ];
  const mesh = new THREE.Mesh(mergeColoredBoxes(parts), new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.position.set(cx, 0, cz);
  mesh.rotation.y = yaw;
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
  const rot = quatY(yaw);
  for (const [lx, ly, lz, w, h, d] of parts.slice(0, 2)) {
    const x = cx + lx * Math.cos(yaw) + lz * Math.sin(yaw), z = cz - lx * Math.sin(yaw) + lz * Math.cos(yaw);
    const col = physics.world.createCollider(RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2).setTranslation(x, ly, z)
      .setRotation(rot).setCollisionGroups(groups(Group.STATIC, ALL)).setFriction(0.8));
    physics.materials.set(col.handle, 'metal');
  }
}

/** Merge coloured boxes into one geometry (vertex colours, no UVs). */
function mergeColoredBoxes(parts: [number, number, number, number, number, number, number][]): THREE.BufferGeometry {
  const col = new THREE.Color();
  return mergeGeometries(parts.map(([x, y, z, w, h, d, c]) => {
    const g = new THREE.BoxGeometry(w, h, d).translate(x, y, z);
    g.deleteAttribute('uv');
    col.setHex(c);
    const n = g.attributes.position.count, arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) arr.set([col.r, col.g, col.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return g;
  }))!;
}

const crateGeos = new Map<number, THREE.BufferGeometry>();
function crateGeo(sz: number): THREE.BufferGeometry {
  let g = crateGeos.get(sz);
  if (!g) { g = new THREE.BoxGeometry(sz, sz, sz); crateGeos.set(sz, g); }
  return g;
}

let crateMat: THREE.MeshLambertMaterial | null = null;
/** 16×16 pixel crate face: frame, planks, diagonal brace. Nearest filtering keeps it voxel-crisp. */
function crateMaterial(): THREE.MeshLambertMaterial {
  if (crateMat) return crateMat;
  const N = 16, cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const ctx = cv.getContext('2d')!;
  const px = (x: number, y: number, c: string) => { ctx.fillStyle = c; ctx.fillRect(x, y, 1, 1); };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const plank = Math.floor(y / 4) % 2 === 0 ? '#a0703f' : '#9a6a3a';
    const seam = y % 4 === 0 ? '#7a5230' : plank;
    px(x, y, seam);
  }
  for (let i = 0; i < N; i++) {
    px(i, 0, '#6e4a27'); px(i, 1, '#6e4a27'); px(i, N - 1, '#6e4a27'); px(i, N - 2, '#6e4a27');
    px(0, i, '#6e4a27'); px(1, i, '#6e4a27'); px(N - 1, i, '#6e4a27'); px(N - 2, i, '#6e4a27');
    if (i > 1 && i < N - 2) { px(i, i, '#6e4a27'); px(i, Math.min(N - 3, i + 1), '#6e4a27'); }
  }
  const t = new THREE.CanvasTexture(cv);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestMipmapLinearFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  crateMat = new THREE.MeshLambertMaterial({ map: t });
  return crateMat;
}

const barrelGs: Partial<Record<'plain' | 'explosive', THREE.BufferGeometry>> = {};
function barrelGeo(explosive: boolean): THREE.BufferGeometry {
  const key = explosive ? 'explosive' : 'plain';
  const cached = barrelGs[key];
  if (cached) return cached;
  const col = new THREE.Color();
  const make = (r: number, h: number, y: number, c: number) => {
    const isBody = h > 1;
    // Open-ended bands (no caps hidden inside the barrel = fewer triangles).
    const g = new THREE.CylinderGeometry(r, r, h, 8, 1, !isBody).translate(0, y, 0).toNonIndexed();
    g.deleteAttribute('uv');
    col.setHex(c);
    const n = g.attributes.position.count, arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) arr.set([col.r, col.g, col.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return g;
  };
  // Explosive: bright red with a wide yellow hazard stripe; plain: rust red with dark bands.
  const parts = explosive
    ? [make(0.36, 1.2, 0, 0xd02a1c), make(0.375, 0.26, 0.05, 0xf2c230), make(0.375, 0.05, -0.42, 0x2a2320), make(0.375, 0.05, 0.42, 0x2a2320)]
    : [make(0.36, 1.2, 0, PAL.barrel), make(0.375, 0.08, -0.35, PAL.barrelBand), make(0.375, 0.08, 0.35, PAL.barrelBand)];
  const g = mergeGeometries(parts)!;
  g.computeVertexNormals(); // flat 8-sided look comes from the non-indexed faces
  barrelGs[key] = g;
  return g;
}

let barrelMat: THREE.MeshLambertMaterial | null = null;
function barrelMaterial(): THREE.MeshLambertMaterial {
  return (barrelMat ??= new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
}

function groundTexture(r: () => number): THREE.CanvasTexture {
  const N = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const ctx = cv.getContext('2d')!;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const v = 0.88 + r() * 0.12;
    const crack = (x % 16 === 0 || y % 16 === 0) ? 0.86 : 1;
    const g = Math.floor(78 * v * crack), b = Math.floor(80 * v * crack), rr = Math.floor(74 * v * crack);
    ctx.fillStyle = `rgb(${rr},${g},${b})`;
    ctx.fillRect(x, y, 1, 1);
  }
  const t = new THREE.CanvasTexture(cv);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestMipmapLinearFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(16, 16);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
