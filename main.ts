// A Sokoban solver for make.fun's sokoban-solver-01: levels are a hallway with
// 1-4 rooms off it, each room an independent puzzle whose boxes never leave it,
// so a level's push-optimum is the sum of its rooms' optima. The solver
// decomposes a level into rooms, solves each room push-optimally on its own
// (A* over pushes with a minimum-assignment heuristic and deadlock pruning),
// and stitches the room solutions together with plain walks along the hallway.
// Written from scratch for this entry: Node 22 standard library only, no
// network, no clock, no randomness, so two runs answer byte for byte alike.
// Budgeting is by node counts, never by time.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The four steps: [dx, dy, walk letter, push letter]. Order is fixed (u, d, l, r)
// everywhere so every choice the search makes is deterministic.
const DIRS: ReadonlyArray<readonly [number, number, string, string]> = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

// Search budgets, in states expanded: work, never the clock.
const MAX_ROOM_ASTAR = 300_000;
const MAX_ROOM_BFS = 250_000;
const MAX_WHOLE_ASTAR = 30_000;
const BEAM_WIDTH = 400;
const BEAM_MAX_DEPTH = 120;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array; // 1 is a wall (the outer frame is wall too)
  goals: number[];
  boxes: number[];
  player: number;
}

/** A level in XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal). */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
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
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * The squares a box can ever be pushed from onto some goal, found by pulling
 * back from the goals: a box on y can be pushed to x when the player can stand
 * at y - d (both y and y - d open floor). A box off a live square reaches no
 * goal, so a state holding one is dead. Ignores the other boxes, so it never
 * prunes a solvable state.
 */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * The squares the player reaches from `from` with `occupied` in the way,
 * marked in `seen` with `stamp`; returns the lowest such square, which names
 * the whole region: two states with the same boxes and the same reachable
 * region are the same state whatever square the player stands on.
 */
function reachLow(level: Level, occupied: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    const up = p - w;
    if (wall[up] === 0 && occupied[up] === 0 && seen[up] !== stamp) { seen[up] = stamp; stack[n++] = up; }
    const down = p + w;
    if (wall[down] === 0 && occupied[down] === 0 && seen[down] !== stamp) { seen[down] = stamp; stack[n++] = down; }
    const left = p - 1;
    if (wall[left] === 0 && occupied[left] === 0 && seen[left] !== stamp) { seen[left] = stamp; stack[n++] = left; }
    const right = p + 1;
    if (wall[right] === 0 && occupied[right] === 0 && seen[right] !== stamp) { seen[right] = stamp; stack[n++] = right; }
  }
  return low;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2 x 2 block of walls and
 * boxes with a box off its goal: no box in such a block can ever move again.
 * The outer frame is wall, so a block read across a row edge is all wall and
 * holds no box, and can never fire by mistake.
 */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** Walking distances from `from` over open floor (walls only), -1 unreachable. */
function bfsDistances(level: Level, from: number): Int32Array {
  const { w, wall } = level;
  const dist = new Int32Array(wall.length).fill(-1);
  const queue = [from];
  dist[from] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    const nd = dist[p]! + 1;
    for (const [dx, dy] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || dist[q] !== -1) continue;
      dist[q] = nd;
      queue.push(q);
    }
  }
  return dist;
}

/** All orders of 0..n-1, for the minimum-cost box-to-goal assignment. */
function allPermutations(n: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const used = new Array<boolean>(n).fill(false);
  const rec = (): void => {
    if (cur.length === n) { out.push([...cur]); return; }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      rec();
      cur.pop();
      used[i] = false;
    }
  };
  rec();
  return out;
}

interface SearchCtx {
  goal: Uint8Array;
  live: Uint8Array;
  distToGoal: Int32Array[];
  perms: number[][] | null;
  occupied: Uint8Array;
  seen: Int32Array;
  mark: Int32Array;
  stack: Int32Array;
  seenStamp: number;
  markStamp: number;
}

function makeCtx(level: Level): SearchCtx {
  const { goals } = level;
  const goal = new Uint8Array(level.wall.length);
  for (const g of goals) goal[g] = 1;
  return {
    goal,
    live: liveSquares(level),
    distToGoal: goals.map((g) => bfsDistances(level, g)),
    perms: level.boxes.length <= 5 ? allPermutations(level.boxes.length) : null,
    occupied: new Uint8Array(level.wall.length),
    seen: new Int32Array(level.wall.length),
    mark: new Int32Array(level.wall.length),
    stack: new Int32Array(level.wall.length),
    seenStamp: 0,
    markStamp: 0,
  };
}

/**
 * A lower bound on the pushes still needed: the cheapest way to match every
 * box to a distinct goal, each box charged its walking distance there (one
 * push moves a box one square, so the true cost is never less). Admissible,
 * and consistent: one push moves one box one square, so the bound shifts by
 * at most one. With more than five boxes the exact match is replaced by each
 * box's nearest goal, still a lower bound.
 */
function heuristic(ctx: SearchCtx, boxes: number[]): number {
  const n = boxes.length;
  if (ctx.perms !== null) {
    let best = Infinity;
    for (const p of ctx.perms) {
      let s = 0;
      for (let i = 0; i < n; i++) {
        const d = ctx.distToGoal[p[i]!]![boxes[i]!]!;
        if (d < 0) { s = Infinity; break; }
        s += d;
      }
      if (s < best) best = s;
    }
    return best;
  }
  let s = 0;
  for (const b of boxes) {
    let m = Infinity;
    for (let gi = 0; gi < n; gi++) {
      const d = ctx.distToGoal[gi]![b]!;
      if (d >= 0 && d < m) m = d;
    }
    if (m === Infinity) return Infinity;
    s += m;
  }
  return s;
}

interface Push {
  next: number[]; // boxes after the push, sorted
  from: number; // the box's square before the push (the player stands here after)
  to: number; // the box's square after the push
  low: number; // lowest square of the player's region after the push
}

/**
 * Every push the player can make from this state: for each box and direction,
 * the player must reach the square behind the box, the landing square must be
 * open floor, live, and not frozen. The boxes are restored as found.
 */
function genPushes(level: Level, ctx: SearchCtx, boxes: number[], playerPos: number): Push[] {
  const { w, wall } = level;
  const { occupied, seen, mark, stack } = ctx;
  const out: Push[] = [];
  for (const b of boxes) occupied[b] = 1;
  const stamp = ++ctx.seenStamp;
  reachLow(level, occupied, playerPos, seen, stamp, stack);
  for (let bi = 0; bi < boxes.length; bi++) {
    const b = boxes[bi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const behind = b - d;
      const t = b + d;
      if (seen[behind] !== stamp) continue;
      if (wall[t] || occupied[t] || !ctx.live[t]) continue;
      occupied[b] = 0;
      occupied[t] = 1;
      if (!frozenBlock(level, occupied, ctx.goal, t)) {
        const next = boxes.slice();
        next[bi] = t;
        next.sort((x, y) => x - y);
        const low = reachLow(level, occupied, b, mark, ++ctx.markStamp, stack);
        out.push({ next, from: b, to: t, low });
      }
      occupied[t] = 0;
      occupied[b] = 1;
    }
  }
  for (const b of boxes) occupied[b] = 0;
  return out;
}

/** A state's key: its region's lowest square and its boxes, exact while it fits in 53 bits, else text. */
function makeKeyOf(level: Level): (boxes: number[], low: number) => number | string {
  const size = level.wall.length;
  const n = level.boxes.length;
  if ((n + 1) * Math.log2(size) < 52) {
    return (boxes: number[], low: number): number => {
      let k = low;
      for (const b of boxes) k = k * size + b;
      return k;
    };
  }
  return (boxes: number[], low: number): string => `${low}:${boxes.join(',')}`;
}

/** The shortest walk from `from` to `to` around walls and boxes, lower LURD letters, first direction first on ties. */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

const pushLetter = (w: number, from: number, to: number): string => {
  const d = to - from;
  return d === -w ? 'U' : d === w ? 'D' : d === -1 ? 'L' : 'R';
};

interface SolverState {
  boxes: number[][];
  player: number[];
  key: (number | string)[];
  g: number[];
  f: number[];
  h: number[];
  parent: number[];
  pushFrom: number[];
  pushTo: number[];
}

/**
 * The moves of a solved state: walk to each push's square, then push, from
 * the level's start. Upper letters are pushes, lower ones walks.
 */
function reconstructMoves(level: Level, st: SolverState, found: number): string {
  const path: number[] = [];
  for (let s = found; s > 0; s = st.parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes.slice();
  const occupied = new Uint8Array(level.wall.length);
  for (const s of path) {
    const from = st.pushFrom[s]!;
    const to = st.pushTo[s]!;
    const d = to - from;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += pushLetter(level.w, from, to);
    player = from;
    boxes = st.boxes[s]!.slice();
  }
  return moves;
}

/**
 * Push-optimal search: A* over pushes (useHeuristic true) or plain breadth
 * first (false, f = pushes). A state is its boxes plus its player's reachable
 * region, named by its lowest square. Returns {pushes, moves} or null when the
 * budget runs out or no solution exists. Deterministic: heap ties go to the
 * lower estimate, then to the earlier state.
 */
function solvePushOptimal(level: Level, maxExpansions: number, useHeuristic: boolean): { pushes: number; moves: string } | null {
  const { wall, goals, boxes: startBoxes, player: startPlayer } = level;
  const size = wall.length;
  const n = startBoxes.length;
  const ctx = makeCtx(level);
  if (startBoxes.some((b) => !ctx.live[b])) return null;
  if (startBoxes.every((b) => ctx.goal[b])) return { pushes: 0, moves: '' };
  const keyOf = makeKeyOf(level);

  const st: SolverState = {
    boxes: [startBoxes.slice()],
    player: [startPlayer],
    key: [],
    g: [0],
    f: [0],
    h: [0],
    parent: [-1],
    pushFrom: [-1],
    pushTo: [-1],
  };
  const initLow = reachLow(level, ctx.occupied, startPlayer, ctx.seen, ++ctx.seenStamp, ctx.stack);
  st.key = [keyOf(startBoxes, initLow)];
  const h0 = useHeuristic ? heuristic(ctx, startBoxes) : 0;
  if (h0 === Infinity) return null;
  st.h[0] = h0;
  st.f[0] = h0;

  const best = new Map<number | string, number>([[st.key[0]!, 0]]);
  // Binary heap of state indices on (f, h, index).
  const heap: number[] = [0];
  const less = (a: number, b: number): boolean =>
    st.f[a]! !== st.f[b]! ? st.f[a]! < st.f[b]! : st.h[a]! !== st.h[b]! ? st.h[a]! < st.h[b]! : a < b;
  const heapPush = (e: number): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l]!, heap[m]!)) m = l;
        if (r < heap.length && less(heap[r]!, heap[m]!)) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m]!, heap[i]!];
        i = m;
      }
    }
    return top;
  };

  let expansions = 0;
  while (heap.length > 0) {
    const s = heapPop();
    if (best.get(st.key[s]!) !== st.g[s]) continue; // a better way to this state was found
    if (st.boxes[s]!.every((b) => ctx.goal[b])) {
      return { pushes: st.g[s]!, moves: reconstructMoves(level, st, s) };
    }
    if (expansions >= maxExpansions) return null;
    expansions++;
    const boxes = st.boxes[s]!;
    const g = st.g[s]!;
    for (const p of genPushes(level, ctx, boxes, st.player[s]!)) {
      const ng = g + 1;
      const key = keyOf(p.next, p.low);
      const prev = best.get(key);
      if (prev !== undefined && ng >= prev) continue;
      const h = useHeuristic ? heuristic(ctx, p.next) : 0;
      if (h === Infinity) continue;
      best.set(key, ng);
      const idx = st.boxes.length;
      st.boxes.push(p.next);
      st.player.push(p.from);
      st.key.push(key);
      st.g.push(ng);
      st.h.push(h);
      st.f.push(ng + h);
      st.parent.push(s);
      st.pushFrom.push(p.from);
      st.pushTo.push(p.to);
      heapPush(idx);
    }
  }
  return null;
}

/**
 * Last-resort greedy: a beam over pushes, widest first by the same estimate,
 * for levels the room split and the optimal search both gave up on. Kept
 * small and deterministic; it only needs to find some solution.
 */
function beamSolve(level: Level, beamWidth: number, maxDepth: number): string | null {
  const { wall, goals, boxes: startBoxes, player: startPlayer } = level;
  const ctx = makeCtx(level);
  if (startBoxes.some((b) => !ctx.live[b])) return null;
  if (startBoxes.every((b) => ctx.goal[b])) return '';
  const keyOf = makeKeyOf(level);
  const st: SolverState = {
    boxes: [startBoxes.slice()],
    player: [startPlayer],
    key: [],
    g: [0],
    f: [0],
    h: [0],
    parent: [-1],
    pushFrom: [-1],
    pushTo: [-1],
  };
  const initLow = reachLow(level, ctx.occupied, startPlayer, ctx.seen, ++ctx.seenStamp, ctx.stack);
  st.key = [keyOf(startBoxes, initLow)];
  st.h[0] = heuristic(ctx, startBoxes);
  let beam: number[] = [0];
  for (let depth = 1; depth <= maxDepth && beam.length > 0; depth++) {
    const seenKeys = new Set<number | string>();
    const cands: { idx: number; h: number; key: number | string }[] = [];
    for (const s of beam) {
      for (const p of genPushes(level, ctx, st.boxes[s]!, st.player[s]!)) {
        const key = keyOf(p.next, p.low);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        const h = heuristic(ctx, p.next);
        if (h === Infinity) continue;
        const idx = st.boxes.length;
        st.boxes.push(p.next);
        st.player.push(p.from);
        st.key.push(key);
        st.g.push(depth);
        st.h.push(h);
        st.f.push(depth + h);
        st.parent.push(s);
        st.pushFrom.push(p.from);
        st.pushTo.push(p.to);
        if (p.next.every((b) => ctx.goal[b])) return reconstructMoves(level, st, idx);
        cands.push({ idx, h, key });
      }
    }
    cands.sort((a, b) => (a.h !== b.h ? a.h - b.h : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    beam = cands.slice(0, beamWidth).map((c) => c.idx);
  }
  return null;
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that
 * holds a box is a room. Null when some part holds more or fewer boxes than
 * goals, or a box starts in the hallway: then the level is no set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) {
    if (part[b]! < 0) return null;
    rooms[part[b]!]!.boxes.push(b);
  }
  for (const g of goals) {
    if (part[g]! < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** The hallway square outside a room's door: the one floor square of the player's row beside a room square. */
function roomEntry(level: Level, room: Room, playerRow: number): number {
  const { w, wall } = level;
  let entry = -1;
  for (const s of room.squares) {
    for (const [dx, dy] of DIRS) {
      const q = s + dy * w + dx;
      if (q < 0 || q >= wall.length) continue;
      if (!wall[q] && Math.floor(q / w) === playerRow) {
        if (entry !== -1 && entry !== q) return -1;
        entry = q;
      }
    }
  }
  return entry;
}

/** A room as a level of its own: its squares plus its entry, everything else wall, the player at the entry. */
function roomSubLevel(level: Level, room: Room, entry: number): Level {
  const { w, h, wall } = level;
  const subWall = new Uint8Array(wall);
  const inRoom = new Uint8Array(wall.length);
  for (const s of room.squares) inRoom[s] = 1;
  for (let i = 0; i < wall.length; i++) {
    if (!wall[i] && !inRoom[i] && i !== entry) subWall[i] = 1;
  }
  return {
    w,
    h,
    wall: subWall,
    goals: room.goals.slice().sort((a, b) => a - b),
    boxes: room.boxes.slice().sort((a, b) => a - b),
    player: entry,
  };
}

/** Replay `moves` on the level: true when every step is legal and every box ends on a goal. Counts pushes too. */
function replayOk(level: Level, moves: string): { ok: boolean; pushes: number } {
  const { w, wall, boxes: startBoxes, player: startPlayer } = level;
  const goal = new Uint8Array(wall.length);
  for (const g of level.goals) goal[g] = 1;
  const box = new Uint8Array(wall.length);
  for (const b of startBoxes) box[b] = 1;
  let player = startPlayer;
  let pushes = 0;
  for (const ch of moves.toLowerCase()) {
    const d = ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : ch === 'r' ? 1 : 0;
    if (d === 0) return { ok: false, pushes };
    const next = player + d;
    if (wall[next]) return { ok: false, pushes };
    if (box[next]) {
      const beyond = next + d;
      if (wall[beyond] || box[beyond]) return { ok: false, pushes };
      box[next] = 0;
      box[beyond] = 1;
      pushes++;
    }
    player = next;
  }
  for (let i = 0; i < box.length; i++) if (box[i] && !goal[i]) return { ok: false, pushes };
  return { ok: true, pushes };
}

/** The whole level at once, when the room split does not apply. */
function fallbackWholeLevel(level: Level): string {
  const solved = solvePushOptimal(level, MAX_WHOLE_ASTAR, true);
  if (solved !== null && replayOk(level, solved.moves).ok) return solved.moves;
  const beam = beamSolve(level, BEAM_WIDTH, BEAM_MAX_DEPTH);
  if (beam !== null && replayOk(level, beam).ok) return beam;
  return '';
}

/** The level's moves: room by room when it splits into rooms, else the fallback. */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  const { w, player } = level;
  if (player < 0 || level.boxes.length === 0) return '';
  if (level.boxes.every((b) => level.goals.includes(b))) return '';
  const playerRow = Math.floor(player / w);
  const rooms = roomsOf(level);
  if (rooms !== null) {
    const entries = rooms.map((r) => roomEntry(level, r, playerRow));
    if (entries.every((e) => e >= 0)) {
      let moves = '';
      let curPlayer = player;
      let curBoxes = level.boxes.slice();
      const occupied = new Uint8Array(level.wall.length);
      for (let ri = 0; ri < rooms.length; ri++) {
        const room = rooms[ri]!;
        const entry = entries[ri]!;
        for (const b of curBoxes) occupied[b] = 1;
        const walk = walkTo(level, occupied, curPlayer, entry);
        for (const b of curBoxes) occupied[b] = 0;
        curPlayer = endOf(w, curPlayer, walk);
        moves += walk;
        const sub = roomSubLevel(level, room, entry);
        const solved = solvePushOptimal(sub, MAX_ROOM_ASTAR, true) ?? solvePushOptimal(sub, MAX_ROOM_BFS, false);
        if (solved === null) return fallbackWholeLevel(level);
        moves += solved.moves;
        curPlayer = endOf(w, entry, solved.moves);
        const roomBoxSet = new Set(room.boxes);
        curBoxes = curBoxes.filter((b) => !roomBoxSet.has(b)).concat(room.goals);
        curBoxes.sort((a, b) => a - b);
      }
      if (replayOk(level, moves).ok) return moves;
      return '';
    }
  }
  return fallbackWholeLevel(level);
}

for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
