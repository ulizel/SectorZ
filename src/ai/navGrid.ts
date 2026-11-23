import { Group, groups, RAPIER, type PhysicsWorld } from '../physics/physicsWorld';

/**
 * Walkability grid + flow field. Static colliders are rasterised once (inflated by a zombie's
 * radius). A Dijkstra pass from the player's cell gives every cell its walking distance to the
 * player; each zombie just walks downhill. One field serves any number of zombies.
 */
export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  readonly blocked: Uint8Array;
  /** Walking distance to the target (cm-ish integer units); 0xffffffff = unreachable. */
  readonly dist: Uint32Array;
  private readonly heap: Int32Array;
  private readonly heapKey: Uint32Array;
  private targetCell = -1;
  /** Extra walking cost per cell (props): paths prefer to go around, but can still pass. */
  readonly extra: Uint8Array;

  constructor(physics: PhysicsWorld, readonly size: number, readonly cell = 0.5, inflate = 0.28) {
    this.cols = this.rows = Math.ceil(size / cell);
    const n = this.cols * this.rows;
    this.blocked = new Uint8Array(n);
    this.dist = new Uint32Array(n).fill(0xffffffff);
    this.extra = new Uint8Array(n);
    this.heap = new Int32Array(n * 8);
    this.heapKey = new Uint32Array(n * 8);
    // Rapier's scene queries only see colliders after a step: take a negligible one first.
    const w = physics.world, dt0 = w.timestep;
    w.timestep = 1e-5;
    w.step();
    w.timestep = dt0;
    const half = cell / 2 + inflate;
    const shape = new RAPIER.Cuboid(half, 0.45, half);
    const rot = { x: 0, y: 0, z: 0, w: 1 };
    const filter = groups(Group.ZOMBIE, Group.STATIC);
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const x = this.cx(c), z = this.cz(r);
        let hit = false;
        physics.world.intersectionsWithShape({ x, y: 0.6, z }, rot, shape, () => { hit = true; return false; }, undefined, filter);
        this.blocked[r * this.cols + c] = hit ? 1 : 0;
      }
    }
  }

  cx(c: number): number { return -this.size / 2 + (c + 0.5) * this.cell; }
  cz(r: number): number { return -this.size / 2 + (r + 0.5) * this.cell; }
  cellOf(x: number, z: number): number {
    const c = Math.floor((x + this.size / 2) / this.cell), r = Math.floor((z + this.size / 2) / this.cell);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return -1;
    return r * this.cols + c;
  }
  isBlocked(x: number, z: number): boolean {
    const i = this.cellOf(x, z);
    return i < 0 || this.blocked[i] === 1;
  }

  /** Rebuild the flow field toward (x, z). Cheap enough to run several times a second. */
  setTarget(x: number, z: number, force = false): void {
    let start = this.cellOf(x, z);
    if (start < 0) return;
    if (this.blocked[start]) start = this.nearestOpen(start);
    if (start === this.targetCell && !force) return;
    this.targetCell = start;
    const { cols, rows, blocked, dist, heap, heapKey } = this;
    dist.fill(0xffffffff);
    dist[start] = 0;
    let size = 0;
    const push = (i: number, k: number) => {
      let p = size++;
      heap[p] = i; heapKey[p] = k;
      while (p > 0) {
        const parent = (p - 1) >> 1;
        if (heapKey[parent] <= heapKey[p]) break;
        [heap[p], heap[parent]] = [heap[parent], heap[p]];
        [heapKey[p], heapKey[parent]] = [heapKey[parent], heapKey[p]];
        p = parent;
      }
    };
    const pop = () => {
      const top = heap[0], key = heapKey[0];
      size--;
      heap[0] = heap[size]; heapKey[0] = heapKey[size];
      let p = 0;
      for (;;) {
        const l = p * 2 + 1, r = l + 1;
        let m = p;
        if (l < size && heapKey[l] < heapKey[m]) m = l;
        if (r < size && heapKey[r] < heapKey[m]) m = r;
        if (m === p) break;
        [heap[p], heap[m]] = [heap[m], heap[p]];
        [heapKey[p], heapKey[m]] = [heapKey[m], heapKey[p]];
        p = m;
      }
      return { i: top, k: key };
    };
    push(start, 0);
    while (size > 0) {
      const { i, k } = pop();
      if (k > dist[i]) continue;
      const c = i % cols, r = (i / cols) | 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const ni = nr * cols + nc;
        if (blocked[ni]) continue;
        // No corner cutting past walls on diagonals.
        if (dr && dc && (blocked[r * cols + nc] || blocked[nr * cols + c])) continue;
        const nk = k + (dr && dc ? 14 : 10) + this.extra[ni];
        if (nk < dist[ni]) { dist[ni] = nk; push(ni, nk); }
      }
    }
  }

  /** Mark soft obstacles (movable props): cells within `r` of each get a detour cost. */
  setSoftObstacles(list: { x: number; z: number; r: number }[], cost = 60): void {
    this.extra.fill(0);
    for (const o of list) {
      const rr = o.r + 0.3;
      const c0 = Math.floor((o.x - rr + this.size / 2) / this.cell), c1 = Math.floor((o.x + rr + this.size / 2) / this.cell);
      const r0 = Math.floor((o.z - rr + this.size / 2) / this.cell), r1 = Math.floor((o.z + rr + this.size / 2) / this.cell);
      for (let r = Math.max(0, r0); r <= Math.min(this.rows - 1, r1); r++) for (let c = Math.max(0, c0); c <= Math.min(this.cols - 1, c1); c++) {
        if (Math.hypot(this.cx(c) - o.x, this.cz(r) - o.z) <= rr) this.extra[r * this.cols + c] = cost;
      }
    }
  }

  private nearestOpen(i: number): number {
    const c0 = i % this.cols, r0 = (i / this.cols) | 0;
    for (let rad = 1; rad < 8; rad++) {
      for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
        const c = c0 + dc, r = r0 + dr;
        if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) continue;
        const j = r * this.cols + c;
        if (!this.blocked[j]) return j;
      }
    }
    return i;
  }

  /**
   * Downhill direction at (x, z): unit vector toward the lowest-distance neighbour.
   * Returns false if the cell is unreachable (caller falls back to steering straight).
   */
  flow(x: number, z: number, out: { x: number; z: number }): boolean {
    const i = this.cellOf(x, z);
    if (i < 0) return false;
    const { cols, rows, blocked, dist } = this;
    const c = i % cols, r = (i / cols) | 0;
    let best = dist[i], bi = -1;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const ni = nr * cols + nc;
      if (blocked[ni] || (dr && dc && (blocked[r * cols + nc] || blocked[nr * cols + c]))) continue;
      if (dist[ni] < best) { best = dist[ni]; bi = ni; }
    }
    if (bi < 0) return false;
    const tx = this.cx(bi % cols) - x, tz = this.cz((bi / cols) | 0) - z;
    const l = Math.hypot(tx, tz) || 1;
    out.x = tx / l; out.z = tz / l;
    return true;
  }

  /** Walking distance in metres (Infinity if unreachable). */
  distanceAt(x: number, z: number): number {
    const i = this.cellOf(x, z);
    if (i < 0 || this.dist[i] === 0xffffffff) return Infinity;
    return (this.dist[i] / 10) * this.cell;
  }
}
