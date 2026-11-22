// sokoban-solver-01: a push-optimal Sokoban solver for make.fun's generated levels.
//
// How it works
// ------------
// The levels this contest draws are a one-wide hallway with small independent rooms off it
// (3-4 boxes each). A box pushed out of its room into the hallway can never come back, so no
// solution ever moves a box between rooms: the level falls apart into one push-optimal
// sub-problem per room, and the level's optimum is the sum of the rooms' optima. This program
// finds the rooms structurally (see splitRooms), then solves each room exactly with an A*
// search over pushes:
//
//   * a state is the set of box squares plus the player's reachable region (named by its
//     lowest square), so walking between pushes is never searched, only replayed;
//   * the heuristic is a minimum-cost matching between boxes and goals over true one-box
//     push distances (computed by reverse pull searches), which is admissible, so the first
//     solution A* settles on is push-optimal for the room;
//   * pushes that strand a box are pruned: a box landing on a square from which no goal is
//     reachable at all (dead square), a box frozen in a 2x2 block of walls and boxes with a
//     box off its goal, and any state whose matching cost is infinite.
//
// If a room's A* ever ran past its work budget it retries greedily (best-first, still exact
// about legality) and then breadth-first; if the level does not split into rooms at all, the
// same push search runs over the whole level, with a move-level A* as the last resort. Every
// budget is counted in expanded states, never in time, so two runs on the same set write
// byte-identical answers.
//
// Input:  /input/<id>/level.txt   (MAKEFUN_INPUT_DIR overrides /input)
// Output: /output/<id>/solution.txt, the player's moves in LURD (MAKEFUN_OUTPUT_DIR ditto)

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Directions in one fixed order everywhere: up, down, left, right.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const STEP_CH = ['u', 'd', 'l', 'r'];
const PUSH_CH = ['U', 'D', 'L', 'R'];

// Work budgets, in expanded states (never the clock, so runs are reproducible).
const ROOM_ASTAR_BUDGET = 350_000;
const ROOM_GREEDY_BUDGET = 600_000;
const ROOM_BFS_BUDGET = 1_200_000;
const WHOLE_BUDGET = 1_500_000;
const MOVE_BUDGET = 1_500_000;
const GLOBAL_BUDGET = 9_000_000;
let workLeft = GLOBAL_BUDGET;

/** A parsed level: walls, goals and boxes as flat cell indices (y * w + x), sorted. */
interface Level {
  w: number;
  h: number;
  size: number;
  wall: Uint8Array;
  goals: number[];
  goalAt: Uint8Array;
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const size = w * h;
  const wall = new Uint8Array(size).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever the text shows: nothing steps off the board.
  for (let x = 0; x < w; x++) {
    wall[x] = 1;
    wall[(h - 1) * w + x] = 1;
  }
  for (let y = 0; y < h; y++) {
    wall[y * w] = 1;
    wall[y * w + w - 1] = 1;
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  const goalAt = new Uint8Array(size);
  for (const g of goals) goalAt[g] = 1;
  return { w, h, size, wall, goals, goalAt, boxes, player };
}

/**
 * For one goal, the fewest pushes that bring a lone box from each square onto it, ignoring
 * the other boxes (a reverse search: a box now on x could have been pushed here from x - d
 * with the player standing at x - 2d). -1 where no push sequence reaches the goal.
 */
function pushDistances(lv: Level, goal: number): Int32Array {
  const { w, size, wall } = lv;
  const dist = new Int32Array(size).fill(-1);
  dist[goal] = 0;
  const queue = [goal];
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (let k = 0; k < 4; k++) {
      const d = DY[k] * w + DX[k];
      const from = x - d;
      if (dist[from] !== -1 || wall[from] || wall[from - d]) continue;
      dist[from] = dist[x] + 1;
      queue.push(from);
    }
  }
  return dist;
}

/** Scratch flood fill: marks the region reachable from `from` around walls and `occupied`. */
class Region {
  seen: Int32Array;
  stack: Int32Array;
  stamp = 0;
  constructor(size: number) {
    this.seen = new Int32Array(size);
    this.stack = new Int32Array(size);
  }
  /** Floods from `from`; returns the region's lowest square and leaves the marks in place. */
  flood(wall: Uint8Array, occupied: Uint8Array, w: number, from: number): number {
    const seen = this.seen;
    const stack = this.stack;
    const stamp = ++this.stamp;
    let n = 0;
    let low = from;
    stack[n++] = from;
    seen[from] = stamp;
    while (n > 0) {
      const p = stack[--n];
      if (p < low) low = p;
      const up = p - w;
      const dn = p + w;
      const lf = p - 1;
      const rt = p + 1;
      if (!wall[up] && !occupied[up] && seen[up] !== stamp) { seen[up] = stamp; stack[n++] = up; }
      if (!wall[dn] && !occupied[dn] && seen[dn] !== stamp) { seen[dn] = stamp; stack[n++] = dn; }
      if (!wall[lf] && !occupied[lf] && seen[lf] !== stamp) { seen[lf] = stamp; stack[n++] = lf; }
      if (!wall[rt] && !occupied[rt] && seen[rt] !== stamp) { seen[rt] = stamp; stack[n++] = rt; }
    }
    return low;
  }
  has(cell: number): boolean {
    return this.seen[cell] === this.stamp;
  }
}

/** Whether the box just pushed onto `t` is frozen in a 2x2 block with some box off its goal. */
function frozenBlock(
  wall: Uint8Array,
  occupied: Uint8Array,
  goalAt: Uint8Array,
  w: number,
  h: number,
  t: number,
): boolean {
  const tx = t % w;
  const ty = Math.floor(t / w);
  for (let oy = ty - 1; oy <= ty; oy++) {
    if (oy < 0 || oy + 1 >= h) continue;
    for (let ox = tx - 1; ox <= tx; ox++) {
      if (ox < 0 || ox + 1 >= w) continue;
      const a = oy * w + ox;
      const b = a + 1;
      const c = a + w;
      const d = c + 1;
      const solid = (i: number): boolean => wall[i] === 1 || occupied[i] === 1;
      if (!solid(a) || !solid(b) || !solid(c) || !solid(d)) continue;
      const offGoal = (i: number): boolean => occupied[i] === 1 && goalAt[i] === 0;
      if (offGoal(a) || offGoal(b) || offGoal(c) || offGoal(d)) return true;
    }
  }
  return false;
}

/**
 * The heuristic: cheapest assignment of boxes to distinct goals, each leg priced by its
 * one-box push distance. Infinite when some box can reach no goal. For up to 7 boxes an
 * exact subset DP; beyond that the sum of per-box minima (still admissible).
 */
function matchHeuristic(distTables: Int32Array[], goals: number[], boxes: number[]): number {
  const n = boxes.length;
  const m = goals.length;
  if (n === 0) return 0;
  if (n > 7) {
    let sum = 0;
    for (const b of boxes) {
      let best = Infinity;
      for (let j = 0; j < m; j++) {
        const d = distTables[j][b];
        if (d >= 0 && d < best) best = d;
      }
      if (best === Infinity) return Infinity;
      sum += best;
    }
    return sum;
  }
  const cost: number[][] = boxes.map((b) => goals.map((_, j) => {
    const d = distTables[j][b];
    return d < 0 ? Infinity : d;
  }));
  const full = 1 << m;
  const dp = new Array<number>(full).fill(Infinity);
  dp[0] = 0;
  for (let mask = 0; mask < full; mask++) {
    let i = 0;
    for (let bits = mask; bits !== 0; bits &= bits - 1) i++;
    if (i >= n || dp[mask] === Infinity) continue;
    for (let j = 0; j < m; j++) {
      if (mask & (1 << j)) continue;
      const v = dp[mask] + cost[i][j];
      if (v < dp[mask | (1 << j)]) dp[mask | (1 << j)] = v;
    }
  }
  return dp[full - 1];
}

/** A binary heap of [f, negG, seq, state] entries: lowest f, then deepest, then oldest. */
class Heap {
  items: [number, number, number, number][] = [];
  private less(a: [number, number, number, number], b: [number, number, number, number]): boolean {
    return a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  }
  push(e: [number, number, number, number]): void {
    const items = this.items;
    let i = items.length;
    items.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(items[i], items[p])) break;
      [items[i], items[p]] = [items[p], items[i]];
      i = p;
    }
  }
  pop(): [number, number, number, number] | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= items.length) break;
        if (c + 1 < items.length && this.less(items[c + 1], items[c])) c++;
        if (!this.less(items[c], items[i])) break;
        [items[i], items[c]] = [items[c], items[i]];
        i = c;
      }
    }
    return top;
  }
  get size(): number {
    return this.items.length;
  }
}

interface PushSolution {
  pushes: number;
  moves: string;
}

/**
 * Searches pushes on one board (walls already include any frozen boxes of other rooms).
 * mode 'astar' is push-optimal; 'greedy' takes the first solution best-first finds; 'bfs'
 * is uniform-cost. Returns null when the expansion budget runs out first.
 */
function searchPushes(
  lv: Level,
  boardWall: Uint8Array,
  startBoxes: number[],
  goals: number[],
  startPlayer: number,
  mode: 'astar' | 'greedy' | 'bfs',
  budget: number,
): PushSolution | null {
  const { w, h, size } = lv;
  const distTables = goals.map((g) => pushDistances(lv, g));
  // Squares from which some goal of this search is reachable by a lone box.
  const live = new Uint8Array(size);
  for (const dt of distTables) for (let i = 0; i < size; i++) if (dt[i] >= 0) live[i] = 1;
  for (const b of startBoxes) if (!live[b]) return null;

  const goalAt = new Uint8Array(size);
  for (const g of goals) goalAt[g] = 1;
  const allOnGoals = (bs: number[]): boolean => bs.every((b) => goalAt[b] === 1);
  const heuristic = (bs: number[]): number => (mode === 'bfs' ? 0 : matchHeuristic(distTables, goals, bs));

  const occupied = new Uint8Array(size);
  const region = new Region(size);
  // regionOf gets its own occupancy buffer: it runs while `occupied` holds the
  // boxes of the state being expanded, and must not disturb them.
  const keyOccupied = new Uint8Array(size);
  const regionOf = (bs: number[], player: number): number => {
    for (const b of bs) keyOccupied[b] = 1;
    const low = region.flood(boardWall, keyOccupied, w, player);
    for (const b of bs) keyOccupied[b] = 0;
    return low;
  };
  const keyOf = (bs: number[], low: number): string => String.fromCharCode(low, ...bs);

  // State store: parallel arrays; a state remembers the push that created it.
  const stBoxes: number[][] = [startBoxes.slice()];
  const stPlayer: number[] = [startPlayer];
  const stG: number[] = [0];
  const stParent: number[] = [-1];
  const stFrom: number[] = [-1]; // the pushed box's square before the push
  const stDir: number[] = [-1];
  const bestG = new Map<string, number>();
  const heap = new Heap();
  let seq = 0;
  const h0 = heuristic(startBoxes);
  if (h0 === Infinity) return null;
  bestG.set(keyOf(startBoxes, regionOf(startBoxes, startPlayer)), 0);
  heap.push([mode === 'greedy' ? h0 : h0, 0, seq++, 0]);

  let expansions = 0;
  let found = -1;
  while (heap.size > 0) {
    const entry = heap.pop()!;
    const s = entry[3];
    const g = stG[s];
    if (bestG.get(keyOf(stBoxes[s], regionOf(stBoxes[s], stPlayer[s]))) !== g) continue;
    if (allOnGoals(stBoxes[s])) {
      found = s;
      break;
    }
    if (expansions >= budget || workLeft <= 0) return null;
    expansions++;
    workLeft--;
    const boxes = stBoxes[s];
    for (const b of boxes) occupied[b] = 1;
    region.flood(boardWall, occupied, w, stPlayer[s]);
    // Snapshot the region: generating a successor floods again for its own key,
    // which would overwrite these marks mid-loop.
    const inRegion = new Uint8Array(size);
    for (let i = 0; i < size; i++) if (region.seen[i] === region.stamp) inRegion[i] = 1;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi];
      for (let k = 0; k < 4; k++) {
        const d = DY[k] * w + DX[k];
        const stand = b - d;
        const dest = b + d;
        if (!inRegion[stand]) continue;
        if (boardWall[dest] || occupied[dest] || !live[dest]) continue;
        occupied[b] = 0;
        occupied[dest] = 1;
        const frozen = frozenBlock(boardWall, occupied, goalAt, w, h, dest);
        occupied[dest] = 0;
        occupied[b] = 1;
        if (frozen) continue;
        const next = boxes.slice();
        next[bi] = dest;
        next.sort((a, b2) => a - b2);
        const hn = heuristic(next);
        if (hn === Infinity) continue;
        const ng = g + 1;
        const key = keyOf(next, regionOf(next, b));
        const seenG = bestG.get(key);
        if (seenG !== undefined && seenG <= ng) continue;
        bestG.set(key, ng);
        const idx = stBoxes.length;
        stBoxes.push(next);
        stPlayer.push(b); // after the push the player stands where the box was
        stG.push(ng);
        stParent.push(s);
        stFrom.push(b);
        stDir.push(k);
        const f = mode === 'astar' ? ng + hn : mode === 'greedy' ? hn : ng;
        heap.push([f, -ng, seq++, idx]);
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // Rebuild the moves: walk to each push's stand square on the then-current board, then push.
  const chain: number[] = [];
  for (let s = found; s > 0; s = stParent[s]) chain.push(s);
  chain.reverse();
  let moves = '';
  let player = startPlayer;
  let boxes = startBoxes.slice();
  for (const s of chain) {
    const from = stFrom[s];
    const k = stDir[s];
    const d = DY[k] * w + DX[k];
    for (const b of boxes) occupied[b] = 1;
    moves += walkPath(lv, boardWall, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += PUSH_CH[k];
    player = from;
    boxes = stBoxes[s];
  }
  return { pushes: chain.length, moves };
}

/** The shortest walk from `from` to `to` around walls and boxes, as lower-case LURD letters. */
function walkPath(lv: Level, wall: Uint8Array, occupied: Uint8Array, from: number, to: number): string {
  const { w, size } = lv;
  if (from === to) return '';
  const prev = new Int32Array(size).fill(-1);
  const how = new Array<string>(size);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + DY[k] * w + DX[k];
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = STEP_CH[k];
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkPath: push square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

interface Room {
  boxes: number[];
  goals: number[];
}

/**
 * Splits the level into its rooms: cut the squares of the player's row that no box could
 * ever be pushed off toward a goal (the hallway), then each remaining floor component that
 * holds boxes is one room. Null when the level is not such a set of rooms.
 */
function splitRooms(lv: Level): Room[] | null {
  const distAll = lv.goals.map((g) => pushDistances(lv, g));
  const liveAny = (cell: number): boolean => distAll.some((dt) => dt[cell] >= 0);
  const prow = Math.floor(lv.player / lv.w);
  const cut = new Uint8Array(lv.size);
  for (let x = 0; x < lv.w; x++) {
    const c = prow * lv.w + x;
    if (!lv.wall[c] && !liveAny(c)) cut[c] = 1;
  }
  if (lv.boxes.some((b) => cut[b] === 1)) return null;
  const comp = new Int32Array(lv.size).fill(-1);
  const comps: number[][] = [];
  for (let s = 0; s < lv.size; s++) {
    if (lv.wall[s] || cut[s] || comp[s] >= 0) continue;
    const cells = [s];
    comp[s] = comps.length;
    for (let i = 0; i < cells.length; i++) {
      const p = cells[i];
      for (let k = 0; k < 4; k++) {
        const q = p + DY[k] * lv.w + DX[k];
        if (q < 0 || q >= lv.size || lv.wall[q] || cut[q] || comp[q] >= 0) continue;
        comp[q] = comps.length;
        cells.push(q);
      }
    }
    comps.push(cells);
  }
  const rooms: Room[] = [];
  let goalsSeen = 0;
  for (const cells of comps) {
    const inComp = new Set(cells);
    const bs = lv.boxes.filter((b) => inComp.has(b));
    const gs = lv.goals.filter((g) => inComp.has(g));
    goalsSeen += gs.length;
    if (bs.length === 0) {
      if (gs.length > 0) return null;
      continue;
    }
    if (bs.length !== gs.length) return null;
    rooms.push({ boxes: bs, goals: gs });
  }
  if (goalsSeen !== lv.goals.length) return null;
  rooms.sort((a, b) => a.boxes[0] - b.boxes[0]);
  return rooms;
}

/** The square the player ends on after playing `moves` from `from` (pushes move it too). */
function endSquare(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) {
    const k = STEP_CH.indexOf(ch.toLowerCase());
    if (k >= 0) p += DY[k] * w + DX[k];
  }
  return p;
}

/** One room, tried exactly, then greedily, then breadth-first. */
function solveRoom(
  lv: Level,
  boardWall: Uint8Array,
  room: Room,
  player: number,
): PushSolution | null {
  return (
    searchPushes(lv, boardWall, room.boxes, room.goals, player, 'astar', ROOM_ASTAR_BUDGET) ??
    searchPushes(lv, boardWall, room.boxes, room.goals, player, 'greedy', ROOM_GREEDY_BUDGET) ??
    searchPushes(lv, boardWall, room.boxes, room.goals, player, 'bfs', ROOM_BFS_BUDGET)
  );
}

/** The last resort: a plain move-level A* over the whole level (fewest moves, not pushes). */
function solveByMoves(lv: Level, budget: number): string | null {
  const { w, size, wall, goalAt } = lv;
  const manhattan = (b: number): number => {
    let best = Infinity;
    for (const g of lv.goals) {
      const d = Math.abs((g % w) - (b % w)) + Math.abs(Math.floor(g / w) - Math.floor(b / w));
      if (d < best) best = d;
    }
    return best;
  };
  const est = (bs: number[]): number => bs.reduce((a, b) => a + manhattan(b), 0);
  const keyOf = (p: number, bs: number[]): string => String.fromCharCode(p, ...bs);
  const stPlayer: number[] = [lv.player];
  const stBoxes: number[][] = [lv.boxes.slice()];
  const stG: number[] = [0];
  const stParent: number[] = [-1];
  const stStep: string[] = [''];
  const best = new Map<string, number>([[keyOf(lv.player, lv.boxes), 0]]);
  const heap = new Heap();
  let seq = 0;
  heap.push([est(lv.boxes), 0, seq++, 0]);
  let expanded = 0;
  while (heap.size > 0) {
    const [, , , s] = heap.pop()!;
    const p = stPlayer[s];
    const bs = stBoxes[s];
    if (best.get(keyOf(p, bs)) !== stG[s]) continue;
    if (bs.every((b) => goalAt[b] === 1)) {
      let moves = '';
      for (let t = s; t > 0; t = stParent[t]) moves = stStep[t] + moves;
      return moves;
    }
    if (expanded >= budget || workLeft <= 0) return null;
    expanded++;
    workLeft--;
    for (let k = 0; k < 4; k++) {
      const d = DY[k] * w + DX[k];
      const q = p + d;
      if (wall[q]) continue;
      let nb = bs;
      let step = STEP_CH[k];
      const at = bs.indexOf(q);
      if (at >= 0) {
        if (wall[q + d] || bs.includes(q + d)) continue;
        nb = bs.slice();
        nb[at] = q + d;
        nb.sort((a, b) => a - b);
        step = PUSH_CH[k];
      }
      const ng = stG[s] + 1;
      const key = keyOf(q, nb);
      const seenG = best.get(key);
      if (seenG !== undefined && seenG <= ng) continue;
      best.set(key, ng);
      const idx = stPlayer.length;
      stPlayer.push(q);
      stBoxes.push(nb);
      stG.push(ng);
      stParent.push(s);
      stStep.push(step);
      heap.push([ng + est(nb), -ng, seq++, idx]);
    }
  }
  return null;
}

/** Solves one level text to its move string ('' when every search gives up). */
function solveLevel(text: string): string {
  const lv = parseLevel(text);
  if (lv.boxes.every((b) => lv.goalAt[b] === 1)) return '';
  const rooms = splitRooms(lv);
  if (rooms !== null && rooms.length > 0) {
    let player = lv.player;
    let moves = '';
    let solvedAll = true;
    const done: boolean[] = rooms.map(() => false);
    for (let ri = 0; ri < rooms.length; ri++) {
      const room = rooms[ri];
      const boardWall = lv.wall.slice();
      rooms.forEach((other, oi) => {
        if (oi === ri) return;
        for (const c of done[oi] ? other.goals : other.boxes) boardWall[c] = 1;
      });
      const res = solveRoom(lv, boardWall, room, player);
      if (res === null) {
        solvedAll = false;
        break;
      }
      moves += res.moves;
      player = endSquare(lv.w, player, res.moves);
      done[ri] = true;
    }
    if (solvedAll) return moves;
  }
  const whole = searchPushes(lv, lv.wall, lv.boxes, lv.goals, lv.player, 'astar', WHOLE_BUDGET);
  if (whole !== null) return whole.moves;
  return solveByMoves(lv, MOVE_BUDGET) ?? '';
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
