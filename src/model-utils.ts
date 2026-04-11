import * as THREE from 'three';

/**
 * Updates a mesh's morph target influences based on waist, height, and weight parameters.
 * @param mesh The Three.js Mesh to update.
 * @param waist A value (typically 0 to 1) to scale the midsection.
 * @param height A value (typically 0 to 1) to scale the vertical height.
 * @param weight A value (typically 0 to 1) to scale the overall body mass.
 */
export function updateModelShape(mesh: THREE.Mesh, waist: number, height: number, weight: number): void {
  if (!mesh.morphTargetInfluences || !mesh.morphTargetDictionary) {
    console.warn('Mesh does not have morph targets.');
    return;
  }

  // Map parameter names to morph target indices
  const waistIndex = mesh.morphTargetDictionary['waist'];
  const heightIndex = mesh.morphTargetDictionary['height'];
  const weightIndex = mesh.morphTargetDictionary['weight'];

  // Apply morphs if they exist
  if (waistIndex !== undefined) {
    mesh.morphTargetInfluences[waistIndex] = THREE.MathUtils.clamp(waist, 0, 1);
  }
  if (heightIndex !== undefined) {
    mesh.morphTargetInfluences[heightIndex] = THREE.MathUtils.clamp(height, 0, 1);
  }
  if (weightIndex !== undefined) {
    mesh.morphTargetInfluences[weightIndex] = THREE.MathUtils.clamp(weight, 0, 1);
  }
}
