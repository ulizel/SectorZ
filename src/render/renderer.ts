import * as THREE from 'three';
import { CAMERA } from '../config';
import { damp } from '../core/math';
import type { QualityPreset } from '../core/quality';

/** Moonlit night: deep blue sky/fog; the scene stays readable in blue tones, the flashlight is the highlight. */
const SKY = 0x14202f;

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  private shake = 0;
  private camTarget = new THREE.Vector3();
  private shakeOffset = new THREE.Vector3();
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  /** Sun orientation (fixed direction) for texel-snapping the shadow camera in light space. */
  private readonly lightRot = new THREE.Matrix4().lookAt(new THREE.Vector3(-12, 22, 8), new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0));
  private readonly lightInv = this.lightRot.clone().invert();
  private readonly lightSpace = new THREE.Vector3();

  constructor(container: HTMLElement, readonly quality: QualityPreset) {
    this.renderer = new THREE.WebGLRenderer({ antialias: quality.antialias, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(quality.pixelRatio);
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.enabled = quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, 16, 42);

    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, innerWidth / innerHeight, 0.5, 120);

    // Moonlight: cool blue sky fill + a soft moon, bright enough to read the arena; no moon shadows
    // (the flashlight casts them).
    this.scene.add(new THREE.HemisphereLight(0x7f9cc8, 0x1c2433, 1.25));
    this.sun = new THREE.DirectionalLight(0x9db6e2, 0.9);
    this.sun.position.set(-12, 22, 8);
    this.sun.castShadow = false;
    const s = this.sun.shadow;
    s.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    s.camera.left = -18; s.camera.right = 18; s.camera.top = 18; s.camera.bottom = -18;
    s.camera.near = 1; s.camera.far = 60;
    s.bias = -0.0006;
    s.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);

    addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize(): void {
    this.renderer.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  addShake(amount: number): void { this.shake = Math.min(1, this.shake + amount); }

  /** Follow a world point with look-ahead in the aim direction. */
  updateCamera(x: number, z: number, aimX: number, aimZ: number, dt: number): void {
    const portrait = this.camera.aspect < 1;
    const zoom = portrait ? CAMERA.portraitZoom : 1;
    this.camTarget.x += (x + aimX * CAMERA.lookAhead - this.camTarget.x) * damp(CAMERA.follow, dt);
    this.camTarget.z += (z + aimZ * CAMERA.lookAhead - this.camTarget.z) * damp(CAMERA.follow, dt);
    this.shake *= Math.exp(-CAMERA.shakeDecay * dt);
    const sh = this.shake * this.shake * 0.6;
    this.shakeOffset.set((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh);
    this.camera.position.set(
      this.camTarget.x + this.shakeOffset.x,
      CAMERA.height * zoom + this.shakeOffset.y,
      this.camTarget.z + CAMERA.back * zoom + this.shakeOffset.z,
    );
    this.camera.lookAt(this.camTarget.x, 0, this.camTarget.z);
    // Keep the shadow frustum tight around the action, snapped to whole shadow-map texels so
    // shadow edges don't shimmer ("flicker") as the camera glides.
    const texel = 36 / this.quality.shadowMapSize;
    const lp = this.lightSpace.copy(this.camTarget).applyMatrix4(this.lightInv);
    lp.x = Math.round(lp.x / texel) * texel;
    lp.y = Math.round(lp.y / texel) * texel;
    lp.applyMatrix4(this.lightRot);
    this.sun.position.set(lp.x - 12, lp.y + 22, lp.z + 8);
    this.sun.target.position.copy(lp);
  }

  snapCamera(x: number, z: number): void { this.camTarget.set(x, 0, z); }

  /** Screen pixel → point on the horizontal plane at height y. */
  screenToGround(sx: number, sy: number, y: number, out: THREE.Vector3): boolean {
    this.ndc.set((sx / innerWidth) * 2 - 1, -(sy / innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    this.plane.constant = -y;
    return this.raycaster.ray.intersectPlane(this.plane, out) !== null;
  }

  render(): void { this.renderer.render(this.scene, this.camera); }
}
