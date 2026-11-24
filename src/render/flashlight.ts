import * as THREE from 'three';
import type { QualityPreset } from '../core/quality';
import { Group, groups, type PhysicsWorld } from '../physics/physicsWorld';

/** Flashlight tunables. */
export const FLASHLIGHT = {
  angle: 0.27, // rad, half-angle of the cone (~31° total)
  penumbra: 0.55,
  range: 16, // m
  intensity: 140,
  height: 1.3, // hand height
  /** Where the beam centre meets the ground (m ahead): tilted down so it lights the floor. */
  groundAt: 9,
  /** Visible light-shaft length (m) and brightness. */
  beamLength: 9,
  beamStrength: 0.3,
  /** Soft key light on the player (from the camera side, above) so the character always reads. */
  glowRange: 5,
  glowIntensity: 9,
};

const DUST = 48;
const FWD = new THREE.Vector3(0, 0, 1);
const v = new THREE.Vector3(), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), col = new THREE.Color();

/**
 * The player's flashlight: a shadow-casting spot light that follows the aim, a soft fake
 * volumetric light shaft (additive cone, clipped at the first obstacle) with drifting dust,
 * and a faint personal glow. Lights are always in the scene (no shader recompiles).
 */
export class Flashlight {
  readonly spot: THREE.SpotLight;
  readonly glow: THREE.PointLight;
  private readonly beam: THREE.Group;
  private readonly cone: THREE.Mesh;
  private readonly dust: THREE.InstancedMesh;
  private readonly dustP = new Float32Array(DUST * 3); // t (0..1 along), angle, radial 0..1
  private time = 0;

  constructor(scene: THREE.Scene, quality: QualityPreset, private readonly physics: PhysicsWorld) {
    const F = FLASHLIGHT;
    this.spot = new THREE.SpotLight(0xfff4e2, F.intensity, F.range, F.angle, F.penumbra, 1.6);
    this.spot.castShadow = quality.shadows;
    const sz = quality.name === 'mobile' ? 512 : 1024;
    this.spot.shadow.mapSize.set(sz, sz);
    this.spot.shadow.camera.near = 0.3;
    this.spot.shadow.camera.far = F.range;
    this.spot.shadow.bias = -0.0008;
    this.spot.shadow.normalBias = 0.02;
    this.glow = new THREE.PointLight(0xdfe6f5, F.glowIntensity, F.glowRange, 2);
    scene.add(this.spot, this.spot.target, this.glow);

    // Light shaft: open cone along +Z from the hand, apex at the origin. The shader fades it along
    // its length and toward its silhouette edges, so it reads as light in the air, not a solid.
    const geo = new THREE.ConeGeometry(1, 1, 20, 1, true).translate(0, -0.5, 0).rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uStrength: { value: F.beamStrength }, uColor: { value: new THREE.Color(0xfff0dc) } },
      vertexShader: /* glsl */`
        varying float vT; varying vec3 vN; varying vec3 vView;
        void main() {
          vT = position.z; // 0 at the hand → 1 at the far end (cone is unit length before scaling)
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vView = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uStrength; uniform vec3 uColor;
        varying float vT; varying vec3 vN; varying vec3 vView;
        void main() {
          float along = pow(1.0 - clamp(vT, 0.0, 1.0), 1.6) * smoothstep(0.0, 0.08, vT);
          float edge = pow(abs(dot(normalize(vN), normalize(vView))), 1.8);
          gl_FragColor = vec4(uColor * along * edge * uStrength, 1.0);
        }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this.cone = new THREE.Mesh(geo, mat);
    this.cone.frustumCulled = false;
    // Dust specks drifting in the beam (beam-local space, so they follow it).
    this.dust = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), DUST);
    this.dust.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(DUST * 3), 3);
    this.dust.frustumCulled = false;
    for (let i = 0; i < DUST; i++) {
      this.dustP[i * 3] = Math.random(); this.dustP[i * 3 + 1] = Math.random() * 6.28; this.dustP[i * 3 + 2] = Math.sqrt(Math.random());
    }
    this.beam = new THREE.Group();
    this.beam.add(this.cone, this.dust);
    scene.add(this.beam);
  }

  /** Follow the player (x, z) and facing yaw; `on` false hides it (dead). */
  update(x: number, z: number, yaw: number, dt: number, on = true): void {
    const F = FLASHLIGHT;
    this.time += dt;
    const dx = Math.sin(yaw), dz = Math.cos(yaw);
    const ox = x + dx * 0.45, oz = z + dz * 0.45;
    this.spot.visible = this.beam.visible = on;
    this.spot.position.set(ox, F.height, oz);
    this.spot.target.position.set(x + dx * F.groundAt, 0, z + dz * F.groundAt);
    this.spot.target.updateMatrixWorld();
    this.glow.position.set(x, 2.6, z + 1.4); // camera side: lights the front the camera sees
    if (!on) return;

    // The shaft stops at the first wall/prop in front (it's fake, so clip it ourselves).
    const dy = -F.height / F.groundAt, l = Math.hypot(dx, dy, dz);
    const hit = this.physics.raycast(ox, F.height, oz, dx / l, dy / l, dz / l, F.beamLength,
      groups(Group.PLAYER, Group.STATIC | Group.PROP));
    const len = hit ? Math.max(0.5, hit.toi) : F.beamLength;
    const r = Math.tan(F.angle) * len;
    this.beam.position.set(ox, F.height, oz);
    this.beam.quaternion.setFromUnitVectors(FWD, v.set(dx / l, dy / l, dz / l));
    this.cone.scale.set(r, r, len);

    // Dust: drift slowly along and around the beam; brightest near the hand.
    for (let i = 0; i < DUST; i++) {
      const i3 = i * 3;
      this.dustP[i3] = (this.dustP[i3] + dt * 0.04) % 1;
      this.dustP[i3 + 1] += dt * 0.3;
      const t = this.dustP[i3], a = this.dustP[i3 + 1], rr = this.dustP[i3 + 2] * 0.9;
      const zz = 0.6 + t * (len - 0.6), rad = Math.tan(F.angle) * zz * rr;
      const sz = 0.022 + 0.012 * Math.sin(i * 7.1);
      this.dust.setMatrixAt(i, m4.compose(v.set(Math.cos(a) * rad, Math.sin(a) * rad + Math.sin(this.time + i) * 0.05, zz), q, s.set(sz, sz, sz)));
      const b = 0.5 * (1 - t) * (0.6 + 0.4 * Math.sin(this.time * 2 + i * 3.7));
      this.dust.setColorAt(i, col.setRGB(b, b * 0.92, b * 0.8));
    }
    this.dust.instanceMatrix.needsUpdate = true;
    this.dust.instanceColor!.needsUpdate = true;
  }
}
