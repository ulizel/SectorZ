import * as THREE from 'three';
import { CAMERA } from '../config';
import { damp } from '../core/math';
import type { QualityPreset } from '../core/quality';

const SKY = 0x2a3442;

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
    this.scene.fog = new THREE.Fog(SKY, 26, 52);

    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, innerWidth / innerHeight, 0.5, 120);

    // Dusk lighting: cool sky fill, warm low sun with soft shadows.
    this.scene.add(new THREE.HemisphereLight(0x9fb4d0, 0x3a2f26, 1.6));
    this.sun = new THREE.DirectionalLight(0xffd2a0, 2.6);
    this.sun.position.set(-12, 22, 8);
    this.sun.castShadow = quality.shadows;
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
    // Keep the shadow frustum tight around the action.
    this.sun.position.set(this.camTarget.x - 12, 22, this.camTarget.z + 8);
    this.sun.target.position.set(this.camTarget.x, 0, this.camTarget.z);
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
