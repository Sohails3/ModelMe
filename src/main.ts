import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const CONFIG = {
  bg: 0x0a0a0a,
  mannequinMat: { color: 0x888888, roughness: 0.8 },
  clothMat:    { color: 0x4488cc, roughness: 0.8, metalness: 0.0 },
};

// ---------------------------------------------------------------------------
// PHYSICS CONSTANTS
// ---------------------------------------------------------------------------
const GRAVITY = -9.8;          // m/s²
const DRAG    = 0.92;          // 1 – damping; damping = 0.08
const DT      = 1 / 60;
const DT2     = DT * DT;
const ITER    = 15;             // Increased for rock-solid collision
// Invisible air gap added to every collision radius so fabric never touches skin.
const COLLISION_MARGIN = 0.018; // Increased buffer to prevent clipping
// Chest-region rest-length inflation: lets the pectoral area bloom outward
// rather than clinging to the cylinder.
const CHEST_BLOOM = 1.15;

// Shape spring: pulls each free vertex toward its fitted rest position.
const SHAPE_K_UPPER      = 220;  // Slightly softened to allow collision to push out
const SHAPE_K_LOWER_TIGHT = 95;  
const SHAPE_K_LOWER_LOOSE = 38;  

// Collar pinning threshold (local Y).  Vertices above this are hard-pinned.
const PIN_Y = 0.25;

// Shirt GLB measurements (local space, from accessor):
const COLLAR_LOCAL_Y  = 0.261;
// Target: shirt sleeve local-Y (≈0.10) maps to Xbot arm bone Y (1.4378).
// SHOULDER_BASE_Y = arm_Y - sleeve_local_Y + COLLAR_LOCAL_Y = 1.4378 - 0.10 + 0.261 ≈ 1.60
const SHOULDER_BASE_Y = 1.60;

// Xbot collision primitives – measured from Xbot.glb bones (cm × scale 0.01 = metres).
// LeftArm bone:     ( 0.1516, 1.4378, -0.0503)
// LeftForeArm:      ( 0.4300, 1.4378, -0.0503)
// RightArm bone:    (-0.1516, 1.4378, -0.0503)
// RightForeArm:     (-0.4300, 1.4378, -0.0503)
// Neck bone:        ( 0.0000, 1.5003, -0.0268)
// Hips bone:        ( 0.0000, 1.0399,  0.0208)
// Base geometry radii (body surface) + COLLISION_MARGIN applied at runtime.
const TORSO_R     = 0.145;      // Slightly wider torso
const TORSO_HIP_Y = 0.85;       // Lower hip boundary
const TORSO_TOP_Y = 1.52;       // Higher torso boundary
const ARM_R       = 0.108;      
const SHOULDERS = [
  [-0.152, 1.438, -0.050, -0.430, 1.438, -0.050],  // actual bone-to-bone coordinates
  [ 0.152, 1.438, -0.050,  0.430, 1.438, -0.050],
] as const;
const SHOULDER_SPHERES = [
  [-0.175, 1.435, -0.030],
  [ 0.175, 1.435, -0.030],
  [ 0.000, 1.520, -0.020],      // Added NECK collision sphere
] as const;
const SHOULDER_SPHERE_R = 0.115; // Increased to fill shoulder cap

// Welding tolerance – catches UV-split seam duplicates (increased for robustness).
const WELD_TOL = 0.005;

// ---------------------------------------------------------------------------
// RENDERER + SCENE
// ---------------------------------------------------------------------------
const canvas  = document.querySelector('#main-canvas') as HTMLCanvasElement;
const wrapper = document.querySelector('#canvas-wrapper') as HTMLDivElement;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);

const scene = new THREE.Scene();
scene.background = new THREE.Color(CONFIG.bg);

const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
camera.position.set(0, 1.2, 3.5);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.1, 0);

function resize() {
  const w = wrapper.clientWidth;
  const h = wrapper.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

scene.add(new THREE.AmbientLight(0xffffff, 0.8));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
dirLight.position.set(5, 10, 7);
scene.add(dirLight);
scene.add(new THREE.GridHelper(10, 10, 0x333333, 0x222222));

const loader = new GLTFLoader();
let mannequin: THREE.Group | null = null;
let modelOffset = 0;

loader.load(
  'Xbot.glb',
  (gltf) => {
    mannequin = gltf.scene;
    const mat = new THREE.MeshStandardMaterial(CONFIG.mannequinMat);
    mannequin.traverse(c => { if ((c as THREE.Mesh).isMesh) (c as THREE.Mesh).material = mat; });
    const box = new THREE.Box3().setFromObject(mannequin);
    modelOffset = -box.min.y;
    mannequin.position.y = modelOffset;
    scene.add(mannequin);
    update();
  },
);

// ---------------------------------------------------------------------------
// T-SHIRT CLOTH SIMULATION
//
// Design decisions:
//  • All particle state in flat Float32Arrays for cache efficiency (~10 k verts).
//  • Edge constraints come from the index buffer.  Seam welds are added by
//    finding spatially coincident vertices (UV splits), giving the fabric a
//    single continuous topology so sleeves and panels move as one piece.
//  • A per-vertex shape spring keeps the shirt on the body with strength that
//    varies by region: strong on chest/shoulders, weaker toward the hem so
//    gravity produces a visible drape.
//  • Waist slider → lower-half shape-spring stiffness (loose↔tight).
//  • Weight slider → mannequin scale + torso collision radius.
//  • Height slider → vertical scale.
// ---------------------------------------------------------------------------
class TShirt {
  mesh: THREE.Mesh | null = null;
  isLoaded = false;

  // Particle state (world space)
  private n   = 0;
  private px!: Float32Array;  private py!: Float32Array;  private pz!: Float32Array;
  private ppx!: Float32Array; private ppy!: Float32Array; private ppz!: Float32Array;
  // Shape-spring rest position (world space, recomputed on fitTo)
  private tx!: Float32Array;  private ty!: Float32Array;  private tz!: Float32Array;
  // Per-vertex shape-spring stiffness × DT² (updated by sliders)
  private shapeKdt2!: Float32Array;
  private pinned!: Uint8Array;  // 1 = hard-pinned (collar)

  // Constraints
  private ca!: Int32Array;
  private cb!: Int32Array;
  private cRest!: Float32Array;     // current rest length (may be modified by waist)
  private cBaseRest!: Float32Array; // rest length at init (no waist effect)
  private cIsLower!: Uint8Array;    // 1 = lower-half constraint (waist-sensitive)
  private cIsChest!: Uint8Array;    // 1 = chest-region constraint (bloom)
  private nc = 0;

  // GLB local-space positions (immutable after load)
  private localX!: Float32Array;
  private localY!: Float32Array;
  private localZ!: Float32Array;
  // Is each vertex in the lower half? (used for shape-spring assignment)
  private isLowerVert!: Uint8Array;

  // Current scale
  private wS   = 1;
  private hS   = 1;
  private mannY = 0;

  // ── Load ──────────────────────────────────────────────────────────────────
  constructor() {
    loader.load('shirt.glb', (gltf) => {
      const meshes: THREE.Mesh[] = [];
      gltf.scene.traverse(c => { if ((c as THREE.Mesh).isMesh) meshes.push(c as THREE.Mesh); });
      if (meshes.length === 0) return;

      // Merge all meshes from the GLB into a single simulation geometry
      // We'll use the first mesh's matrix as our world reference
      const rootMesh = meshes[0];
      rootMesh.updateMatrixWorld();
      const rootInv = rootMesh.matrixWorld.clone().invert();

      const combinedPos: number[] = [];
      const combinedIdx: number[] = [];
      let vertOffset = 0;

      for (const m of meshes) {
        m.updateMatrixWorld();
        // Transform geometry to rootMesh space
        const mGeo = m.geometry.clone();
        const mMat = m.matrixWorld.clone().premultiply(rootInv);
        mGeo.applyMatrix4(mMat);

        const posAttr = mGeo.attributes.position;
        for (let i = 0; i < posAttr.count; i++) {
          combinedPos.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
        }

        const idxAttr = mGeo.index;
        if (idxAttr) {
          for (let i = 0; i < idxAttr.count; i++) {
            combinedIdx.push(idxAttr.getX(i) + vertOffset);
          }
        }
        vertOffset += posAttr.count;
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(combinedPos, 3));
      geo.setIndex(combinedIdx);
      geo.applyMatrix4(rootMesh.matrixWorld); // Move to world space
      geo.computeVertexNormals();

      this.mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ ...CONFIG.clothMat, side: THREE.DoubleSide }),
      );
      scene.add(this.mesh);

      // Cache particle count and local positions
      this.n = geo.attributes.position.count;
      this.localX = new Float32Array(this.n);
      this.localY = new Float32Array(this.n);
      this.localZ = new Float32Array(this.n);
      const pa = geo.attributes.position;
      for (let i = 0; i < this.n; i++) {
        this.localX[i] = pa.getX(i);
        this.localY[i] = pa.getY(i);
        this.localZ[i] = pa.getZ(i);
      }

      // Identify lower-half vertices (below the shirt's mid-point)
      this.isLowerVert = new Uint8Array(this.n);
      for (let i = 0; i < this.n; i++) {
        this.isLowerVert[i] = this.localY[i] < 0 ? 1 : 0;
      }

      // Allocate particle arrays
      this.px  = new Float32Array(this.n); this.py  = new Float32Array(this.n); this.pz  = new Float32Array(this.n);
      this.ppx = new Float32Array(this.n); this.ppy = new Float32Array(this.n); this.ppz = new Float32Array(this.n);
      this.tx  = new Float32Array(this.n); this.ty  = new Float32Array(this.n); this.tz  = new Float32Array(this.n);
      this.shapeKdt2 = new Float32Array(this.n);
      this.pinned    = new Uint8Array(this.n);

      this.buildConstraints(geo);
      this.isLoaded = true;
      update();
    });
  }

  // ── Build constraints ──────────────────────────────────────────────────────
  // Two types:
  //  1. Structural – one per unique mesh edge (maintains fabric stretch resistance)
  //  2. Welding    – DISABLE AGGRESSIVE WELDING TO PREVENT CLOSING HOLES
  private buildConstraints(geo: THREE.BufferGeometry) {
    const seen = new Set<string>();
    const edgesA: number[] = [];
    const edgesB: number[] = [];

    const addEdge = (a: number, b: number) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (!seen.has(key)) { seen.add(key); edgesA.push(a); edgesB.push(b); }
    };

    // 1. Structural edges from index buffer
    const idx = geo.index;
    if (idx) {
      for (let i = 0; i < idx.count; i += 3) {
        addEdge(idx.getX(i), idx.getX(i + 1));
        addEdge(idx.getX(i + 1), idx.getX(i + 2));
        addEdge(idx.getX(i), idx.getX(i + 2));
      }
    }

    // 2. Disabled welding to prevent closing the neck hole
    /*
    const inv  = 1 / WELD_TOL;
    ...
    */

    this.nc        = edgesA.length;
    this.ca        = new Int32Array(edgesA);
    this.cb        = new Int32Array(edgesB);
    this.cRest     = new Float32Array(this.nc);
    this.cBaseRest = new Float32Array(this.nc);
    this.cIsLower  = new Uint8Array(this.nc);
    this.cIsChest  = new Uint8Array(this.nc);

    for (let c = 0; c < this.nc; c++) {
      const a = this.ca[c], b = this.cb[c];
      this.cIsLower[c] = (this.isLowerVert[a] && this.isLowerVert[b]) ? 1 : 0;
      // Chest region: local Y in [0, 0.15] on both endpoints → bloom outward
      const lyA = this.localY[a], lyB = this.localY[b];
      this.cIsChest[c] = (lyA >= 0 && lyA <= 0.15 && lyB >= 0 && lyB <= 0.15) ? 1 : 0;
    }
    // Rest lengths are set in initParticles() once we know the scale.
  }

  // ── Project a world-space point outside all body collision shapes ──────────
  // This ensures shape-spring targets never sit inside the mannequin, which
  // would cause the spring to constantly fight the collision response.
  private projectOutside(
    wx: number, wy: number, wz: number,
    wS: number, hS: number, mannY: number,
  ): [number, number, number] {
    const torsoR    = TORSO_R * wS;
    const torsoHipY = TORSO_HIP_Y * hS + mannY;
    const torsoTopY = TORSO_TOP_Y * hS + mannY;

    // Torso cylinder
    if (wy > torsoHipY && wy < torsoTopY) {
      const d2 = wx * wx + wz * wz;
      if (d2 > 0 && d2 < torsoR * torsoR) {
        const s = torsoR / Math.sqrt(d2);
        wx *= s; wz *= s;
      }
    }

    // Shoulder spheres
    const ssr = SHOULDER_SPHERE_R * wS;
    for (const [sx, sy, sz] of SHOULDER_SPHERES) {
      const wssx = sx * wS, wssy = sy * hS + mannY, wssz = sz * wS;
      const dx = wx - wssx, dy = wy - wssy, dz = wz - wssz;
      const d2 = dx*dx + dy*dy + dz*dz;
      if (d2 > 0 && d2 < ssr * ssr) {
        const s = ssr / Math.sqrt(d2);
        wx = wssx + dx * s; wy = wssy + dy * s; wz = wssz + dz * s;
      }
    }

    // Arm capsules
    const armR = ARM_R * wS;
    for (const [ax, ay, az, bx, by, bz] of SHOULDERS) {
      const wax = ax * wS, way = ay * hS + mannY, waz = az * wS;
      const wbx = bx * wS, wby = by * hS + mannY, wbz = bz * wS;
      const abx = wbx-wax, aby = wby-way, abz = wbz-waz;
      const apx = wx-wax,  apy = wy-way,  apz = wz-waz;
      const ab2 = abx*abx + aby*aby + abz*abz;
      const t   = ab2 > 0 ? Math.max(0, Math.min(1, (apx*abx + apy*aby + apz*abz) / ab2)) : 0;
      const cx  = wax + abx*t, cy = way + aby*t, cz = waz + abz*t;
      const dx  = wx-cx, dy = wy-cy, dz = wz-cz;
      const d2  = dx*dx + dy*dy + dz*dz;
      if (d2 > 0 && d2 < armR * armR) {
        const s = armR / Math.sqrt(d2);
        wx = cx + dx*s; wy = cy + dy*s; wz = cz + dz*s;
      }
    }

    return [wx, wy, wz];
  }

  // ── Init / reset particles ─────────────────────────────────────────────────
  private initParticles() {
    const { n, wS, hS, mannY } = this;
    const originY = (SHOULDER_BASE_Y - COLLAR_LOCAL_Y) * hS + mannY;

    for (let i = 0; i < n; i++) {
      const lx = this.localX[i], ly = this.localY[i], lz = this.localZ[i];
      const wx = lx * wS;
      const wy = ly * hS + originY;
      const wz = lz * wS;

      // Project the fitted position outside the body so the shape spring
      // never pulls vertices back through the mannequin.
      const [tx, ty, tz] = this.pinned[i]
        ? [wx, wy, wz]
        : this.projectOutside(wx, wy, wz, wS, hS, mannY);

      this.px[i] = tx; this.py[i] = ty; this.pz[i] = tz;
      this.ppx[i] = tx; this.ppy[i] = ty; this.ppz[i] = tz;
      this.tx[i] = tx; this.ty[i] = ty; this.tz[i] = tz;
      this.pinned[i] = ly > PIN_Y ? 1 : 0;

      const k = this.isLowerVert[i]
        ? lerp(SHAPE_K_LOWER_TIGHT, SHAPE_K_LOWER_LOOSE, 0.5)
        : SHAPE_K_UPPER;
      this.shapeKdt2[i] = k * DT2;
    }

    // Constraint rest lengths in world space
    for (let c = 0; c < this.nc; c++) {
      const a = this.ca[c], b = this.cb[c];
      const dx = this.px[b] - this.px[a];
      const dy = this.py[b] - this.py[a];
      const dz = this.pz[b] - this.pz[a];
      const base = Math.sqrt(dx * dx + dy * dy + dz * dz);
      this.cBaseRest[c] = base;
      // Inflate chest constraints so the pectoral area blooms outward
      // rather than clinging against the torso cylinder.
      this.cRest[c] = this.cIsChest[c] ? base * CHEST_BLOOM : base;
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Called when height/weight sliders change. Resets the simulation. */
  fitTo(wS: number, hS: number) {
    if (!this.mesh) return;
    this.wS    = wS;
    this.hS    = hS;
    this.mannY = mannequin?.position.y ?? 0;
    this.initParticles();
  }

  /** Called when waist slider changes (0–1). Adjusts lower-half springs without full reset. */
  setWaist(t: number) {
    if (!this.mesh) return;
    const k = lerp(SHAPE_K_LOWER_TIGHT, SHAPE_K_LOWER_LOOSE, t);
    const kdt2 = k * DT2;
    for (let i = 0; i < this.n; i++) {
      if (this.isLowerVert[i]) this.shapeKdt2[i] = kdt2;
    }
  }

  // ── Collision helpers ──────────────────────────────────────────────────────
  // Each helper pushes vertex i outside the shape AND zeroes the inward
  // velocity component (by syncing pp to p) so Verlet doesn't rebound inward.

  private collideSphere(i: number, cx: number, cy: number, cz: number, r: number) {
    if (this.pinned[i]) return;
    const dx = this.px[i] - cx, dy = this.py[i] - cy, dz = this.pz[i] - cz;
    const d2 = dx*dx + dy*dy + dz*dz;
    if (d2 > 0 && d2 < r * r) {
      const s = r / Math.sqrt(d2);
      this.px[i] = cx + dx * s;
      this.py[i] = cy + dy * s;
      this.pz[i] = cz + dz * s;
      // Zero penetrating velocity so Verlet doesn't pull back inward.
      this.ppx[i] = this.px[i];
      this.ppy[i] = this.py[i];
      this.ppz[i] = this.pz[i];
    }
  }

  private collideCapsule(
    i: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    r: number,
  ) {
    if (this.pinned[i]) return;
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const apx = this.px[i] - ax, apy = this.py[i] - ay, apz = this.pz[i] - az;
    const ab2 = abx * abx + aby * aby + abz * abz;
    const t   = ab2 > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / ab2)) : 0;
    const cx  = ax + abx * t, cy = ay + aby * t, cz = az + abz * t;
    const dx  = this.px[i] - cx, dy = this.py[i] - cy, dz = this.pz[i] - cz;
    const d2  = dx * dx + dy * dy + dz * dz;
    if (d2 > 0 && d2 < r * r) {
      const s  = r / Math.sqrt(d2);
      this.px[i] = cx + dx * s;
      this.py[i] = cy + dy * s;
      this.pz[i] = cz + dz * s;
      this.ppx[i] = this.px[i];
      this.ppy[i] = this.py[i];
      this.ppz[i] = this.pz[i];
    }
  }

  // ── Simulation step ────────────────────────────────────────────────────────
  step() {
    if (!this.mesh || this.n === 0) return;

    const { n, wS, hS, mannY } = this;
    const px = this.px, py = this.py, pz = this.pz;
    const ppx = this.ppx, ppy = this.ppy, ppz = this.ppz;
    const tx = this.tx, ty = this.ty, tz = this.tz;
    const shapeKdt2 = this.shapeKdt2;
    const pinned = this.pinned;
    const gravDT2 = GRAVITY * DT2;   // ≈ –0.00272

    // ── 1. Verlet integration ──────────────────────────────────────────────
    for (let i = 0; i < n; i++) {
      if (pinned[i]) continue;

      const vx = (px[i] - ppx[i]) * DRAG;
      const vy = (py[i] - ppy[i]) * DRAG;
      const vz = (pz[i] - ppz[i]) * DRAG;

      const kdt2 = shapeKdt2[i];
      const sx = (tx[i] - px[i]) * kdt2;
      const sy = (ty[i] - py[i]) * kdt2;
      const sz = (tz[i] - pz[i]) * kdt2;

      ppx[i] = px[i]; ppy[i] = py[i]; ppz[i] = pz[i];
      px[i] += vx + sx;
      py[i] += vy + sy + gravDT2;
      pz[i] += vz + sz;
    }

    // ── 2 + 3. Constraints interleaved with collision ─────────────────────
    // Running collision after EVERY constraint iteration (not just once at
    // the end) is the PBD-correct approach: constraint corrections can push
    // vertices into the body, so we immediately push them back out.  This
    // eliminates the frame-by-frame oscillation that causes visible clipping.
    const ca = this.ca, cb = this.cb, cRest = this.cRest;
    const nc = this.nc;

    // Pre-scale collision radii once (body radius + air-gap margin).
    const torsoR    = (TORSO_R    + COLLISION_MARGIN) * wS;
    const torsoR2   = torsoR * torsoR;
    const torsoHipY = TORSO_HIP_Y * hS + mannY;
    const torsoTopY = TORSO_TOP_Y * hS + mannY;
    const armR      = (ARM_R             + COLLISION_MARGIN) * wS;
    const ssR       = (SHOULDER_SPHERE_R + COLLISION_MARGIN) * wS;

    for (let iter = 0; iter < ITER; iter++) {

      // — 2a. Solve constraints —
      for (let c = 0; c < nc; c++) {
        const a = ca[c], b = cb[c];
        const pa = pinned[a], pb = pinned[b];
        if (pa && pb) continue;

        const dx = px[b] - px[a];
        const dy = py[b] - py[a];
        const dz = pz[b] - pz[a];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 1e-14) continue;

        const rest = cRest[c];
        const inv  = 1 - rest / Math.sqrt(d2);
        const cx   = dx * inv, cy = dy * inv, cz = dz * inv;

        if (pa) {
          px[b] -= cx; py[b] -= cy; pz[b] -= cz;
        } else if (pb) {
          px[a] += cx; py[a] += cy; pz[a] += cz;
        } else {
          const hx = cx * 0.5, hy = cy * 0.5, hz = cz * 0.5;
          px[a] += hx; py[a] += hy; pz[a] += hz;
          px[b] -= hx; py[b] -= hy; pz[b] -= hz;
        }
      }

      // — 2b. Collision pass (re-run after every constraint iteration) —
      for (let i = 0; i < n; i++) {
        if (pinned[i]) continue;

        // Torso vertical cylinder
        if (py[i] > torsoHipY && py[i] < torsoTopY) {
          const d2 = px[i] * px[i] + pz[i] * pz[i];
          if (d2 > 0 && d2 < torsoR2) {
            const s = torsoR / Math.sqrt(d2);
            px[i] *= s; pz[i] *= s;
            ppx[i] = px[i]; ppz[i] = pz[i];
          }
        }

        // Shoulder spheres
        for (const [sx, sy, sz] of SHOULDER_SPHERES) {
          this.collideSphere(i, sx * wS, sy * hS + mannY, sz * wS, ssR);
        }

        // Upper-arm capsules
        for (const [ax, ay, az, bx, by, bz] of SHOULDERS) {
          this.collideCapsule(
            i,
            ax * wS, ay * hS + mannY, az * wS,
            bx * wS, by * hS + mannY, bz * wS,
            armR,
          );
        }
      }
    }

    // ── 4. Write positions to geometry buffer ──────────────────────────────
    const attr    = this.mesh.geometry.attributes.position;
    const posArr  = attr.array as Float32Array;
    for (let i = 0; i < n; i++) {
      posArr[i * 3]     = px[i];
      posArr[i * 3 + 1] = py[i];
      posArr[i * 3 + 2] = pz[i];
    }
    attr.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
  }
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }

const tShirt = new TShirt();

// ---------------------------------------------------------------------------
// SLIDERS
// ---------------------------------------------------------------------------
const sliderH     = document.querySelector('#height-slider') as HTMLInputElement;
const sliderW     = document.querySelector('#weight-slider') as HTMLInputElement;
const sliderWaist = document.querySelector('#waist-slider')  as HTMLInputElement;
const labelH      = document.querySelector('#h-val')  as HTMLSpanElement;
const labelW      = document.querySelector('#w-val')  as HTMLSpanElement;
const labelWaist  = document.querySelector('#wa-val') as HTMLSpanElement;

function update() {
  const h = parseFloat(sliderH.value);      // 0–1
  const w = parseFloat(sliderW.value);      // 0–1
  const waist = parseFloat(sliderWaist.value); // 0–1

  const hS = 0.9 + h * 0.2;   // 0.9–1.1
  const wS = 0.8 + w * 0.4;   // 0.8–1.2

  // Update label display values
  if (labelH)    labelH.textContent    = Math.round(155 + h * 40) + 'cm';
  if (labelW)    labelW.textContent    = Math.round(55  + w * 60) + 'kg';
  if (labelWaist) labelWaist.textContent = Math.round(26  + waist * 20) + 'in';

  if (mannequin) {
    mannequin.scale.set(wS, hS, wS);
    mannequin.position.y = modelOffset * hS;
  }

  tShirt.fitTo(wS, hS);
  tShirt.setWaist(waist);
}

sliderH.addEventListener('input', update);
sliderW.addEventListener('input', update);
// Waist slider: no full reset – just adjust spring stiffness so the sim
// continues smoothly while the user drags.
sliderWaist.addEventListener('input', () => {
  tShirt.setWaist(parseFloat(sliderWaist.value));
  if (labelWaist)
    labelWaist.textContent = Math.round(26 + parseFloat(sliderWaist.value) * 20) + 'in';
});

// ---------------------------------------------------------------------------
// RENDER LOOP
// ---------------------------------------------------------------------------
function animate() {
  requestAnimationFrame(animate);
  tShirt.step();
  renderer.render(scene, camera);
}
animate();
