/**
 * Builds the seed puzzle bank.
 *
 * These are pure tile-efficiency drills. Every answer is *computed* from the
 * shanten/ukeire library in src/lib, not authored by hand — the point is that
 * nothing in the shipped bank claims an evaluation it did not actually compute.
 * Their unit is `ukeire_tiles` and their evaluator id is `ukeire-baseline`, so
 * they are distinguishable at a glance from the AI-evaluated puzzles the offline
 * pipeline produces.
 *
 * Efficiency drills are a real exercise, but they are also the naive baseline
 * the AI pipeline exists to disagree with. Treat this bank as scaffolding that
 * proves the site works end to end.
 *
 * Run with: npm run build:seed
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { shanten } from '../src/lib/shanten';
import { analyzeDiscards } from '../src/lib/ukeire';
import {
  ALL_TILES,
  NUM_TILE_TYPES,
  countsToTiles,
  indexToTile,
  isTerminalOrHonor,
  sortTiles,
  tileToIndex,
  type Tile,
} from '../src/lib/tiles';
import { SCHEMA_VERSION, type Puzzle, type PuzzleIndex, type PuzzleShard } from '../src/types/puzzle';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'public', 'puzzles');

/** A shanten regression is never acceptable, so it is priced beyond blunder. */
const SHANTEN_REGRESSION_PENALTY = 100;

/** Discards within this many tiles of the best acceptance count are accepted. */
const EPSILON_TILES = 0;

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

interface DealtHand {
  hand: Tile[];
  drawnTile: Tile;
  wallRemainder: number[];
}

/**
 * Deal a 14-tile hand. Hands are dealt from a real wall so tile counts are
 * always legal, then filtered by shape so the drill is worth solving.
 */
function dealHand(random: () => number): DealtHand {
  const wall: number[] = [];
  for (let i = 0; i < NUM_TILE_TYPES; i++) {
    for (let n = 0; n < 4; n++) wall.push(i);
  }
  for (let i = wall.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [wall[i], wall[j]] = [wall[j], wall[i]];
  }

  const dealt = wall.slice(0, 14);
  const counts = new Array<number>(NUM_TILE_TYPES).fill(0);
  for (const tile of dealt) counts[tile] += 1;

  const remainder = new Array<number>(NUM_TILE_TYPES).fill(0);
  for (const tile of wall.slice(14)) remainder[tile] += 1;

  return {
    hand: sortTiles(countsToTiles(counts)),
    drawnTile: indexToTile(dealt[13]),
    wallRemainder: remainder,
  };
}

/**
 * Build a plausible discard river for one opponent from tiles that are still
 * available, so the displayed board never shows a fifth copy of anything.
 */
function buildRiver(available: number[], length: number, random: () => number): Tile[] {
  const river: Tile[] = [];
  let guard = 0;
  while (river.length < length && guard < 200) {
    guard += 1;
    const index = Math.floor(random() * NUM_TILE_TYPES);
    if (available[index] <= 0) continue;
    // Early discards skew toward terminals and honors, which reads as realistic.
    if (river.length < 3 && !isTerminalOrHonor(index) && random() < 0.6) continue;
    available[index] -= 1;
    river.push(indexToTile(index));
  }
  return river;
}

interface Candidate {
  puzzle: Puzzle;
  spread: number;
}

function buildPuzzle(id: string, random: () => number): Candidate | undefined {
  const { hand, drawnTile, wallRemainder } = dealHand(random);

  const counts = new Array<number>(NUM_TILE_TYPES).fill(0);
  for (const tile of hand) counts[tileToIndex(tile)] += 1;

  const currentShanten = shanten(counts);
  // Very distant hands have no meaningful "right" discard, and complete hands
  // are not a discard problem at all.
  if (currentShanten < 0 || currentShanten > 2) return undefined;

  const available = [...wallRemainder];
  const rivers: Tile[][] = [[], [], [], []];
  const riverLengths = [0, 0, 0, 0];
  const turn = 4 + Math.floor(random() * 6);
  for (let seat = 0; seat < 4; seat++) {
    riverLengths[seat] = Math.max(0, turn - (seat === 0 ? 0 : 1));
    rivers[seat] = buildRiver(available, riverLengths[seat], random);
  }

  const doraIndicators: Tile[] = [];
  for (let i = 0; i < NUM_TILE_TYPES && doraIndicators.length < 1; i++) {
    const index = Math.floor(random() * NUM_TILE_TYPES);
    if (available[index] > 0) {
      available[index] -= 1;
      doraIndicators.push(indexToTile(index));
    }
  }
  if (doraIndicators.length === 0) return undefined;

  // Everything the acting player can see, for an honest acceptance count.
  const visible = new Array<number>(NUM_TILE_TYPES).fill(0);
  for (const tile of hand) visible[tileToIndex(tile)] += 1;
  for (const river of rivers) {
    for (const tile of river) visible[tileToIndex(tile)] += 1;
  }
  for (const tile of doraIndicators) visible[tileToIndex(tile)] += 1;

  const options = analyzeDiscards(counts, 0, visible);
  if (options.length < 2) return undefined;

  const bestShanten = options[0].shantenAfter;
  const bestUkeire = options[0].ukeire;

  const actions = options.map((option) => {
    const shantenRegression = Math.max(0, option.shantenAfter - bestShanten);
    const loss = shantenRegression * SHANTEN_REGRESSION_PENALTY + (bestUkeire - option.ukeire);
    return {
      id: `discard:${option.tile}`,
      label: `Discard ${option.tile}`,
      tile: option.tile,
      // EV is expressed so that higher is better, matching the schema.
      ev: -loss,
      loss,
      accepted: loss <= EPSILON_TILES,
    };
  });

  const accepted = actions.filter((action) => action.accepted);
  if (accepted.length === 0) return undefined;
  // A drill where nearly everything is correct teaches nothing.
  if (accepted.length > 3) return undefined;

  const bestRejected = actions.find((action) => !action.accepted);
  if (!bestRejected) return undefined;
  const margin = bestRejected.loss;
  // Require a real gap so the drill has a defensible answer.
  if (margin < 2) return undefined;

  const spread = Math.max(...actions.map((action) => action.loss));

  const tags = ['efficiency'];
  if (bestShanten === 0) tags.push('tenpai-choice');
  if (currentShanten === 2) tags.push('two-shanten');
  if (actions.some((action) => action.loss >= SHANTEN_REGRESSION_PENALTY)) {
    tags.push('shanten-preserving');
  }

  // Tighter margins and more plausible-looking alternatives are harder. This is
  // a crude proxy; a server-backed build would learn difficulty from solvers.
  const difficulty = Math.max(
    5,
    Math.min(95, Math.round(70 - margin * 3 + (currentShanten - 1) * 10 + accepted.length * 5)),
  );

  const puzzle: Puzzle = {
    id,
    schemaVersion: SCHEMA_VERSION,
    kind: 'discard',
    position: {
      seat: 0,
      round: { wind: 'E', kyoku: 1 + Math.floor(random() * 4), honba: 0, riichiSticks: 0 },
      scores: [25000, 25000, 25000, 25000],
      doraIndicators,
      hand,
      drawnTile,
      melds: [],
      rivers: rivers as [Tile[], Tile[], Tile[], Tile[]],
      opponentMelds: [[], [], [], []],
      riichi: [false, false, false, false],
      tilesLeft: Math.max(4, 70 - riverLengths.reduce((sum, n) => sum + n, 0)),
    },
    actions,
    acceptedActionIds: accepted.map((action) => action.id),
    tags,
    difficulty,
    evaluation: {
      evaluators: ['ukeire-baseline'],
      margin,
      // A single evaluator cannot corroborate itself.
      agreement: false,
      epsilon: EPSILON_TILES,
      unit: 'ukeire_tiles',
    },
    source: { dataset: 'synthetic-seed', authored: false },
    explanation: buildExplanation(bestShanten, bestUkeire, accepted.length, options[0].acceptedTiles),
  };

  return { puzzle, spread };
}

function buildExplanation(
  bestShanten: number,
  bestUkeire: number,
  acceptedCount: number,
  acceptedTiles: Tile[],
): string {
  const shape =
    bestShanten === 0
      ? 'reaches tenpai'
      : bestShanten === 1
        ? 'keeps the hand at 1-shanten'
        : `keeps the hand at ${bestShanten}-shanten`;
  const waits = acceptedTiles.length > 0 ? ` Acceptance: ${acceptedTiles.join(' ')}.` : '';
  const plural = acceptedCount > 1 ? `${acceptedCount} discards tie for best. ` : '';
  return `${plural}The best discard ${shape} with ${bestUkeire} tiles of acceptance.${waits} This drill scores tile efficiency only — it ignores yaku, score and safety.`;
}

function main(): void {
  const random = makeRandom(20260729);
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  let attempts = 0;
  while (candidates.length < 120 && attempts < 60_000) {
    attempts += 1;
    const candidate = buildPuzzle(`seed-${candidates.length + 1}`, random);
    if (!candidate) continue;

    // Deduplicate on the hand itself; the same shape twice is not two puzzles.
    const key = sortTiles(candidate.puzzle.position.hand).join('');
    if (seen.has(key)) continue;
    seen.add(key);

    candidates.push(candidate);
  }

  // Present easier, wider-margin drills first.
  candidates.sort((a, b) => b.spread - a.spread);
  const puzzles = candidates.map((candidate, index) => ({
    ...candidate.puzzle,
    id: `seed-${String(index + 1).padStart(3, '0')}`,
  }));

  mkdirSync(OUT_DIR, { recursive: true });

  const shardFile = 'seed-000.json';
  const shard: PuzzleShard = { schemaVersion: SCHEMA_VERSION, puzzles };
  writeFileSync(join(OUT_DIR, shardFile), `${JSON.stringify(shard, null, 2)}\n`);

  const index: PuzzleIndex = {
    schemaVersion: SCHEMA_VERSION,
    // Fixed rather than wall-clock so rebuilds are reproducible.
    generatedAt: '2026-07-29',
    provenance:
      'Synthetic tile-efficiency drills. Hands dealt from a shuffled wall with a fixed seed; ' +
      'answers computed by the shanten/ukeire library in src/lib. Scored in tiles of acceptance, ' +
      'not AI placement points — no yaku, score or safety judgement is applied.',
    count: puzzles.length,
    shards: [{ file: shardFile, count: puzzles.length, kinds: ['discard'] }],
  };
  writeFileSync(join(OUT_DIR, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);

  const tileCoverage = new Set(puzzles.flatMap((puzzle) => puzzle.position.hand));
  process.stdout.write(
    `wrote ${puzzles.length} puzzles to ${OUT_DIR} ` +
      `(${attempts} deals attempted, ${tileCoverage.size}/${ALL_TILES.length} tile types seen)\n`,
  );
}

main();
