import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { HUMANOID, type PartName } from '../rigs/humanoid';
import type { Zombie } from '../entities/zombie';

const SKIN = 0x7d9a6a, SHIRT = 0x5b4a3c, PANTS = 0x3b4250, GORE = 0x7a0f12, GORE_DARK = 0x4a0608, BONE = 0xe8e0c8;
const BRUISE = new THREE.Color(0x8a3a30); // multiplied with the vertex colours
const WHITE = new THREE.Color(1, 1, 1);
const POOL_GEO = new THREE.CircleGeometry(0.5, 10).rotateX(-Math.PI / 2);

type Box = [w: number, h: number, d: number, color: number, x: number, y: number, z: number];

/** Voxel boxes making up each part, relative to the part's box centre. */
function partBoxes(name: PartName): Box[] {
  const def = HUMANOID.find((d) => d.name === name)!;
  const c = def.center;
  const at = (w: number, h: number, d: number, col: number, x: number, y: number, z: number): Box => [w, h, d, col, x - c[0], y - c[1], z - c[2]];
  const main = name === 'head' || name.startsWith('forearm') ? SKIN : name === 'torso' || name.startsWith('upperArm') ? SHIRT : PANTS;
  const out: Box[] = [[def.size[0], def.size[1], def.size[2], main, 0, 0, 0]];
  if (name === 'head') {
    out.push(at(0.06, 0.05, 0.02, 0xfff27a, 0.07, 0.18, 0.155), at(0.06, 0.05, 0.02, 0xfff27a, -0.07, 0.18, 0.155));
    out.push(at(0.14, 0.04, 0.02, 0x2a1414, 0, 0.07, 0.155), at(0.31, 0.06, 0.31, 0x3a3a2a, 0, 0.31, -0.02), at(0.08, 0.08, 0.02, GORE, 0.09, 0.26, 0.152));
  }
  if (name === 'torso') out.push(at(0.2, 0.12, 0.02, GORE_DARK, 0.06, 0.18, 0.125), at(0.12, 0.1, 0.02, SKIN, -0.1, 0.32, 0.125));
  if (name.startsWith('forearm')) out.push(at(0.1, 0.08, 0.1, SKIN, 0, -0.3, 0));
  if (name.startsWith('shin')) out.push(at(0.15, 0.08, 0.2, 0x2a2320, 0, -0.34, 0.02));
  return out;
}

function mergeBoxes(boxes: Box[]): THREE.BufferGeometry {
  const col = new THREE.Color();
  const geos = boxes.map(([w, h, d, color, x, y, z]) => {
    const g = new THREE.BoxGeometry(w, h, d).translate(x, y, z);
    g.deleteAttribute('uv');
    col.setHex(color); // setHex already converts sRGB → linear (colour management)
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return g;
  });
  return mergeGeometries(geos)!;
}

interface GoreCube { part: number; m: THREE.Matrix4; color: number }
interface Rec {
  z: Zombie;
  gore: GoreCube[];
  stumped: Set<number>;
  woundsShown: number;
  pool: THREE.Mesh | null;
  poolSize: number;
  sink: number; // > 0 while sinking away after removal
}

const m4 = new THREE.Matrix4(), m4b = new THREE.Matrix4();
const pv = new THREE.Vector3(), sv = new THREE.Vector3(1, 1, 1);
const qv = new THREE.Quaternion();
const tint = new THREE.Color();

/**
 * Draws every zombie with one InstancedMesh per body part (11 draw calls total for any crowd)
 * plus one for all gore cubes (stumps, bone, wounds). Living, ragdolled and flying parts all
 * read their transform straight from the physics bodies.
 */
export class ZombieRenderer {
  private readonly parts: THREE.InstancedMesh[] = [];
  private readonly goreMesh: THREE.InstancedMesh;
  private readonly recs = new Map<Zombie, Rec>();
  private readonly sinking: Rec[] = [];

  constructor(private readonly scene: THREE.Scene, private readonly capacity = 96, goreCapacity = 2500) {
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    for (const def of HUMANOID) {
      const im = new THREE.InstancedMesh(mergeBoxes(partBoxes(def.name)), mat, capacity);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
      im.castShadow = im.receiveShadow = true;
      im.frustumCulled = false;
      im.count = 0;
      scene.add(im);
      this.parts.push(im);
    }
    this.goreMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), goreCapacity);
    this.goreMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.goreMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(goreCapacity * 3), 3);
    this.goreMesh.castShadow = true;
    this.goreMesh.frustumCulled = false;
    this.goreMesh.count = 0;
    scene.add(this.goreMesh);
  }

  private addGore(r: Rec, part: number, w: number, h: number, d: number, x: number, y: number, z: number, color: number): void {
    r.gore.push({ part, m: new THREE.Matrix4().compose(pv.set(x, y, z), qv.identity(), sv.set(w, h, d)), color });
  }

  private updateRec(r: Rec, dt: number): void {
    const z = r.z;
    // Stumps (flesh + bone) on both sides of each torn joint.
    for (const p of z.parts) {
      if (!p.severed || r.stumped.has(p.index)) continue;
      r.stumped.add(p.index);
      const d = p.def, parent = z.parts[p.parent].def;
      const w = Math.min(d.size[0], d.size[2]) * 0.9;
      const cx = -d.center[0], cy = -d.center[1], cz = -d.center[2];
      const px = d.joint[0] - parent.center[0], py = d.joint[1] - parent.center[1], pz = d.joint[2] - parent.center[2];
      this.addGore(r, p.index, w, 0.05, w, cx, cy, cz, GORE);
      this.addGore(r, p.index, w * 0.35, 0.09, w * 0.35, cx, cy + 0.02, cz, BONE);
      this.addGore(r, p.parent, w, 0.05, w, px, py, pz, GORE);
      this.addGore(r, p.parent, w * 0.35, 0.09, w * 0.35, px, py - 0.02, pz, BONE);
    }
    for (; r.woundsShown < z.wounds.length; r.woundsShown++) {
      const wd = z.wounds[r.woundsShown];
      const s = 0.05 + Math.random() * 0.03;
      this.addGore(r, wd.part, s, s, s, wd.local.x, wd.local.y, wd.local.z, Math.random() < 0.5 ? GORE : GORE_DARK);
    }
    // Blood pool under a settled corpse.
    if (!z.alive && (z.frozen || z.restTime > 0.3) && !z.finalTransforms) {
      if (!r.pool) {
        const t = z.parts[1].body.translation();
        r.pool = new THREE.Mesh(POOL_GEO, new THREE.MeshBasicMaterial({ color: 0x4a0608, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
        r.pool.position.set(t.x, 0.008, t.z);
        r.pool.scale.setScalar(0.01);
        this.scene.add(r.pool);
      }
      r.poolSize = Math.min(1.6, r.poolSize + dt * 0.25);
      r.pool.scale.set(r.poolSize, 1, r.poolSize * 0.8);
    }
  }

  /** Call once per rendered frame. */
  sync(dt: number, zombies: readonly Zombie[], removed: Zombie[]): void {
    for (const z of zombies) if (!this.recs.has(z)) this.recs.set(z, { z, gore: [], stumped: new Set(), woundsShown: 0, pool: null, poolSize: 0, sink: 0 });
    for (const z of removed) {
      const r = this.recs.get(z);
      if (r) { this.recs.delete(z); this.sinking.push(r); }
    }
    removed.length = 0;
    let i = 0, g = 0;
    const goreCap = this.goreMesh.instanceMatrix.count;
    const write = (r: Rec, sinkY: number) => {
      if (i >= this.capacity) return;
      const z = r.z;
      for (let k = 0; k < z.parts.length; k++) {
        if (z.finalTransforms) {
          const f = z.finalTransforms[k];
          pv.copy(f.p); pv.y -= sinkY; qv.copy(f.q);
        } else {
          const t = z.parts[k].body.translation(), q = z.parts[k].body.rotation();
          pv.set(t.x, t.y, t.z); qv.set(q.x, q.y, q.z, q.w);
        }
        m4.compose(pv, qv, sv.set(1, 1, 1));
        this.parts[k].setMatrixAt(i, m4);
        // Bruising: parts darken as they lose health (a hint they're about to come off).
        const p = z.parts[k];
        const frac = p.maxHp === Infinity ? 1 - Math.max(0, z.hp) / 100 : 1 - Math.max(0, p.hp) / p.maxHp;
        tint.copy(WHITE).lerp(BRUISE, Math.min(0.8, frac * 0.8));
        this.parts[k].setColorAt(i, tint);
        for (const c of r.gore) {
          if (c.part !== k || g >= goreCap) continue;
          m4b.multiplyMatrices(m4, c.m);
          this.goreMesh.setMatrixAt(g, m4b);
          this.goreMesh.setColorAt(g, tint.setHex(c.color));
          g++;
        }
      }
      i++;
    };
    for (const r of this.recs.values()) { this.updateRec(r, dt); write(r, 0); }
    for (let s = this.sinking.length - 1; s >= 0; s--) {
      const r = this.sinking[s];
      r.sink += dt;
      if (r.pool) (r.pool.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.85 - r.sink);
      if (r.sink > 1.2) {
        if (r.pool) { this.scene.remove(r.pool); (r.pool.material as THREE.Material).dispose(); }
        this.sinking.splice(s, 1);
        continue;
      }
      write(r, r.sink * 0.6);
    }
    for (const im of this.parts) {
      im.count = i;
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
    this.goreMesh.count = g;
    this.goreMesh.instanceMatrix.needsUpdate = true;
    if (this.goreMesh.instanceColor) this.goreMesh.instanceColor.needsUpdate = true;
  }
}
