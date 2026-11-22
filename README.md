# Sokoban solver — make.fun sokoban-solver-01

A push-optimal Sokoban solver, written from scratch for the
`sokoban-solver-01-run-20261121` bounty. It answers all five instances of a
set in one run: `node main.ts` reads `/input/<id>/level.txt` and writes
`/output/<id>/solution.txt` (the player's moves in LURD letters).

## Why it works

Every level in this competition is a hallway with 1–4 rooms off it, each room
an independent puzzle: boxes never leave their room, and a level's
push-optimal count P\* is the sum of its rooms' optima. So the solver:

1. **Decomposes the level into rooms.** It computes the squares a box can
   ever be pushed from onto a goal (pulled back from the goals), cuts the
   dead squares of the player's row — the hallway — out of the floor, and
   each remaining part holding a box is a room, with its own boxes and goals.
2. **Solves each room push-optimally on its own.** An A\* over pushes:
   a state is the boxes plus the player's reachable region (named by its
   lowest square); the estimate is the cheapest matching of boxes to goals
   by walking distance, which never overestimates; dead squares and frozen
   2×2 blocks of walls and boxes are pruned. Each room is searched with a
   node budget, never a clock cut-off, so two runs answer byte for byte
   alike. If a room's A\* ever gave up, a plain breadth-first search over
   pushes retries it.
3. **Stitches the rooms together.** Between rooms the player walks along
   the hallway (plain BFS, boxes as obstacles); the room solutions are
   concatenated in order. The final move string is replayed on the whole
   level before it is written out, so an illegal or unsolved answer is never
   emitted.

If a level does not split into rooms, the solver falls back to a push-A\*
over the whole level and then to a greedy beam search over pushes.

## Results

- Practice set: **1,000,000** — all five instances solved in exactly P\*
  pushes (13, 16, 29, 47, 60), in about 0.4 s for the whole set.
- Eight further sets drawn from the kit's own generator with fresh seeds:
  **1,000,000** each, 0.36–0.52 s per set. The hardest single room needed
  about 1,100 search expansions against a 300,000 budget.
- Determinism: two runs on the practice set produce byte-for-byte
  identical outputs.

## Notes

- Node 22 standard library only: no installs, no network, no clock, no
  randomness, no files read outside `/bot`, `/input`, `/output`, `/tmp`.
- `main.ts` is the whole program (one file, ~25 KB). `package.json` only
  marks the package as an ES module so Node does not reparse the file.
- License: MIT.
