# Sokoban solver for sokoban-solver-01

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/yanxiaoxv/sokoban-solver-01/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/yanxiaoxv/sokoban-solver-01/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)


A push-optimal Sokoban solver, written for make.fun's sokoban-solver-01 bounty
(Node 22, standard library only, single file: `main.ts`).

It answers every instance of a set in one run: for each `/input/<id>/` it writes
`/output/<id>/solution.txt` with the player's moves in LURD
(`MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` override the directories locally).

## Approach

The levels this contest's generator draws are a one-square-wide hallway with one to
four independent rooms off it (each room 3–4 boxes and as many goals). A box pushed
through a door into the hallway can never be pushed back, so no solution ever moves a
box between rooms, and a level's push-optimal count P* is the sum of its rooms'
push-optima. The solver exploits exactly that:

1. **Room decomposition.** Squares of the player's row from which no box could ever
   reach a goal (the hallway) are cut out of the floor; each remaining connected
   component that holds boxes is one room. (If a level ever failed to split this
   way, the same push search runs over the whole level instead.)
2. **Push-optimal A\* per room.** A state is the set of box squares plus the
   player's reachable region (named by its lowest square), so walking between
   pushes is never searched, only replayed when the move string is built. The
   heuristic is a minimum-cost matching between boxes and goals over true one-box
   push distances (reverse pull searches from each goal), which is admissible, so
   the first solution found is push-optimal for the room — and the rooms' optima
   sum to the level's P*.
3. **Deadlock pruning.** A push is refused when the box lands on a dead square
   (no goal reachable from it even ignoring the other boxes), when it freezes a
   2×2 block of walls and boxes with a box off its goal, or when the state's
   matching cost is infinite.
4. **Fallbacks, budgeted in work, never in time.** If a room's A* ever exceeded
   its expansion budget it retries best-first, then breadth-first; a move-level
   A* over the whole level is the last resort. All budgets count expanded
   states, so two runs on the same set write byte-identical answers.

The other rooms' boxes stand as walls while one room is solved (solved rooms:
their boxes on their goals), exactly as the level's structure dictates; the
player walks on from where the previous room's solution left it.

## Results

Scored with the kit's own checker against the reference keys:

**Practice set — 1,000,000 (perfect):**

| instance | rooms (P\* per room) | P\* | pushes | points |
|---|---|---|---|---|
| i001 | [13] | 13 | 13 | 1000 |
| i002 | [16] | 16 | 16 | 1000 |
| i003 | [15, 14] | 29 | 29 | 1000 |
| i004 | [15, 17, 15] | 47 | 47 | 1000 |
| i005 | [16, 14, 14, 16] | 60 | 60 | 1000 |

The house baseline (plain-astar 1.0.0) scores 200,000 on the same set: it solves
only i001 and gives up on the other four.

**Generalisation:** 52 further sets (260 instances) drawn with the kit's own
generator from fresh seeds were all solved at exactly P\* — every instance at
1,000 points. Runtime per 5-instance set stayed under ~0.5 s locally (the
contest wall is 60 s), and repeated runs produce byte-identical outputs.

## Layout

- `main.ts` — the whole solver (parsing, decomposition, search, fallbacks, I/O).
- `LICENSE` — MIT.
