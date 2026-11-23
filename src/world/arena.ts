import * as THREE from 'three';
import { ARENA, PROPS } from '../config';
import { rng } from '../core/math';
import { Group, groups, ALL, RAPIER, type PhysicsWorld } from '../physics/physicsWorld';
import { box, jitterColor, PAL, UNIT_BOX } from '../render/voxel';

export interface DynamicProp {
  body: RAPIER.RigidBody;
  mesh: THREE.Object3D;
  kind: 'crate' | 'barrel';
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
      blocks.push({ x, y: h / 2, z, w: 1.02, h, d: 1.02, color: r() < 0.5 ? PAL.concrete : PAL.concreteDark });
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
  buildCar(blocks, -14, -14, 0.4, addStatic);
  buildCar(blocks, 13, 12, -0.9, addStatic);

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
    const g = new THREE.Group();
    g.add(box(sz, sz, sz, PAL.crate));
    // Plank edges for voxel detail.
    for (const yy of [-1, 1]) g.add(box(sz * 1.02, sz * 0.12, sz * 1.02, PAL.crateEdge, 0, yy * sz * 0.44, 0));
    g.add(box(sz * 1.02, sz * 0.12, sz * 0.2, PAL.crateEdge, 0, 0, 0));
    scene.add(g);
    props.push({ body, mesh: g, kind: 'crate' });
  };
  const barrel = (x: number, z: number) => {
    const body = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, 0.6, z).setLinearDamping(0.2).setAngularDamping(0.5));
    const barrelCol = w.createCollider(RAPIER.ColliderDesc.cylinder(0.6, 0.36).setDensity(PROPS.barrelDensity).setFriction(0.6).setRestitution(0.2)
      .setCollisionGroups(groups(Group.PROP, ALL)), body);
    physics.materials.set(barrelCol.handle, 'metal');
    const g = new THREE.Group();
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 1.2, 8), new THREE.MeshLambertMaterial({ color: PAL.barrel, flatShading: true }));
    cyl.castShadow = cyl.receiveShadow = true;
    g.add(cyl);
    for (const yy of [-0.35, 0.35]) {
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.375, 0.375, 0.08, 8), new THREE.MeshLambertMaterial({ color: PAL.barrelBand, flatShading: true }));
      band.position.y = yy;
      g.add(band);
    }
    scene.add(g);
    props.push({ body, mesh: g, kind: 'barrel' });
  };

  for (const [x, z] of [[4, -4], [-4, 4], [5, 9], [-6, -10], [12, -3], [-12, 3]] as const) {
    crate(x, 0.6, z, 1.2);
    if (r() < 0.6) crate(x + 0.1, 1.8, z - 0.05, 1.2);
  }
  crate(-3, 0.45, -3, 0.9); crate(-2.2, 0.45, -3.3, 0.9); crate(-2.6, 1.35, -3.15, 0.9);
  for (const [x, z] of [[6, -1], [6.8, -1.6], [-5, 1], [2, 14], [-15, -6], [15, 6]] as const) barrel(x, z);

  return props;
}

function quatY(a: number) { return { x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) }; }

function buildCar(blocks: Block[], cx: number, cz: number, yaw: number,
  addStatic: (x: number, y: number, z: number, w: number, h: number, d: number, c: number, v?: boolean, mat?: 'concrete' | 'metal') => void): void {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const put = (lx: number, y: number, lz: number, w: number, h: number, d: number, color: number) => {
    // Axis-aligned approximation: rotate the centre only (blocks stay boxy — reads as wreckage).
    blocks.push({ x: cx + lx * c + lz * s, y, z: cz - lx * s + lz * c, w, h, d, color });
  };
  put(0, 0.55, 0, 1.9, 0.7, 4, PAL.rust);
  put(0, 1.15, -0.3, 1.7, 0.55, 2, 0x6f7f8a);
  for (const [lx, lz] of [[-0.95, 1.3], [0.95, 1.3], [-0.95, -1.3], [0.95, -1.3]]) put(lx, 0.3, lz, 0.3, 0.6, 0.6, 0x1d1d1f);
  addStatic(cx, 0.75, cz, Math.abs(1.9 * c) + Math.abs(4 * s), 1.5, Math.abs(1.9 * s) + Math.abs(4 * c), 0, false, 'metal');
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
