import * as THREE from 'three';
import { HUMANOID, type PartName } from './humanoid';

/** Transform-only humanoid hierarchy (no meshes): used to compute animated part poses for physics. */
export class PoseRig {
  readonly root = new THREE.Group();
  readonly parts = {} as Record<PartName, THREE.Group>;

  constructor() {
    for (const def of HUMANOID) {
      const g = new THREE.Group();
      g.position.set(...def.joint);
      g.rotation.order = 'YXZ';
      (def.parent ? this.parts[def.parent] : this.root).add(g);
      this.parts[def.name] = g;
    }
  }
}
