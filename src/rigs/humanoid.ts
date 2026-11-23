/**
 * Humanoid skeleton shared by the player, zombies and (Phase 2) ragdolls.
 * Each part pivots at its joint; the box is offset from that pivot. Ragdoll colliders will
 * be built from exactly these boxes, so what you see is what collides and what detaches.
 * Units: metres. Character faces +Z, its left is +X.
 */
export type PartName =
  | 'pelvis' | 'torso' | 'head'
  | 'upperArmL' | 'forearmL' | 'upperArmR' | 'forearmR'
  | 'thighL' | 'shinL' | 'thighR' | 'shinR';

export interface PartDef {
  name: PartName;
  parent: PartName | null;
  /** Joint position relative to the parent joint, in rest pose. */
  joint: [number, number, number];
  /** Box full size. */
  size: [number, number, number];
  /** Box centre relative to this part's joint. */
  center: [number, number, number];
  /** Approximate mass (kg) for the ragdoll phase. */
  mass: number;
}

export const HUMANOID: readonly PartDef[] = [
  { name: 'pelvis', parent: null, joint: [0, 0.82, 0], size: [0.36, 0.18, 0.2], center: [0, 0.02, 0], mass: 11 },
  { name: 'torso', parent: 'pelvis', joint: [0, 0.1, 0], size: [0.42, 0.46, 0.24], center: [0, 0.23, 0], mass: 22 },
  { name: 'head', parent: 'torso', joint: [0, 0.48, 0], size: [0.3, 0.3, 0.3], center: [0, 0.16, 0], mass: 5 },
  { name: 'upperArmL', parent: 'torso', joint: [0.27, 0.42, 0], size: [0.12, 0.3, 0.12], center: [0, -0.13, 0], mass: 2.5 },
  { name: 'forearmL', parent: 'upperArmL', joint: [0, -0.28, 0], size: [0.11, 0.28, 0.11], center: [0, -0.13, 0], mass: 2 },
  { name: 'upperArmR', parent: 'torso', joint: [-0.27, 0.42, 0], size: [0.12, 0.3, 0.12], center: [0, -0.13, 0], mass: 2.5 },
  { name: 'forearmR', parent: 'upperArmR', joint: [0, -0.28, 0], size: [0.11, 0.28, 0.11], center: [0, -0.13, 0], mass: 2 },
  { name: 'thighL', parent: 'pelvis', joint: [0.1, -0.07, 0], size: [0.15, 0.38, 0.16], center: [0, -0.18, 0], mass: 8 },
  { name: 'shinL', parent: 'thighL', joint: [0, -0.37, 0], size: [0.14, 0.38, 0.15], center: [0, -0.18, 0], mass: 4.5 },
  { name: 'thighR', parent: 'pelvis', joint: [-0.1, -0.07, 0], size: [0.15, 0.38, 0.16], center: [0, -0.18, 0], mass: 8 },
  { name: 'shinR', parent: 'thighR', joint: [0, -0.37, 0], size: [0.14, 0.38, 0.15], center: [0, -0.18, 0], mass: 4.5 },
];

export const PART_INDEX: Record<PartName, number> = Object.fromEntries(
  HUMANOID.map((p, i) => [p.name, i]),
) as Record<PartName, number>;

/** Rest-pose world-space joint positions (character at origin). */
export function restJointPositions(): Record<PartName, [number, number, number]> {
  const out = {} as Record<PartName, [number, number, number]>;
  for (const p of HUMANOID) {
    const base = p.parent ? out[p.parent] : [0, 0, 0];
    out[p.name] = [base[0] + p.joint[0], base[1] + p.joint[1], base[2] + p.joint[2]];
  }
  return out;
}
