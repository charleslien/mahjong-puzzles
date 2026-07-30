/**
 * Build the puzzle bank from real Tenhou houou logs.
 *
 * This replaces the synthetic random-deal bank, and fixes two things that bank
 * could not:
 *
 *   - Coherence. A synthetic position showed a random round number against flat
 *     25000 scores, which is impossible — by E3 the scores have moved. Real
 *     positions carry the real board.
 *   - History. Each puzzle ships the mjai events for its hand up to the decision,
 *     so the trainer can step back through how the position arose.
 *
 * The *evaluation* is still the ukeire baseline, not an AI eval: it scores tiles
 * of acceptance and nothing else. Real positions with a naive evaluator, clearly
 * labelled as such. The model replaces the evaluator, not the positions.
 *
 * Usage:
 *   node --experimental-strip-types scripts/build-puzzles.ts <log dir> [count]
 *   npm run build:puzzles -- pipeline/data/2010 200
 */

import { gunzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzePosition } from '../src/lib/analyzePosition';
import { tileLabel } from '../src/lib/tiles';
import { replayKyoku, splitKyoku, type MjaiEvent, type Snapshot } from '../src/lib/replay';
import {
  SCHEMA_VERSION,
  type Meld,
  type Position,
  type Puzzle,
  type PuzzleIndex,
  type PuzzleShard,
  type Seat,
} from '../src/types/puzzle';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'puzzles');

const SHANTEN_REGRESSION_PENALTY = 100;
const EPSILON_TILES = 0;
/** Minimum acceptance gap, in tiles, between the best discard and the next. */
const MIN_MARGIN = 2;
/** At least this many discards must hold the best shanten, or it is a trivial drill. */
const MIN_TIER = 3;
/** Cap per game so one long hanchan cannot dominate the bank. */
const MAX_PER_GAME = 2;

function readEvents(path: string): MjaiEvent[] {
  const raw = readFileSync(path);
  const text =
    raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  const events: MjaiEvent[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) events.push(JSON.parse(trimmed) as MjaiEvent);
  }
  return events;
}

/** Snapshot -> the schema's Position, recording only the acting seat's tiles. */
function positionFromSnapshot(snapshot: Snapshot, seat: Seat): Position {
  const seats = snapshot.seats;
  return {
    seat,
    round: { ...snapshot.round },
    scores: [seats[0].score, seats[1].score, seats[2].score, seats[3].score],
    doraIndicators: [...snapshot.doraIndicators],
    hand: [...seats[seat].hand],
    drawnTile: seats[seat].drawn,
    melds: seats[seat].melds.map((meld): Meld => ({ ...meld, tiles: [...meld.tiles] })),
    // Claimed discards are excluded: the replay keeps them in the river list so
    // it can draw a gap, but physically the tile has moved into the caller's
    // meld. Counting both would show five copies of a tile.
    rivers: ([0, 1, 2, 3] as Seat[]).map((other) =>
      seats[other].river.filter((entry) => !entry.called).map((entry) => entry.tile),
    ),
    // The acting seat's own melds live in `melds`; its slot here stays empty so
    // the same physical tiles are never represented twice.
    opponentMelds: ([0, 1, 2, 3] as Seat[]).map((other) =>
      other === seat ? [] : seats[other].melds.map((m): Meld => ({ ...m, tiles: [...m.tiles] })),
    ) as [Meld[], Meld[], Meld[], Meld[]],
    riichi: [seats[0].riichi, seats[1].riichi, seats[2].riichi, seats[3].riichi],
    tilesLeft: snapshot.tilesLeft,
  };
}

interface Candidate {
  puzzle: Puzzle;
  margin: number;
}

function evaluateDecision(
  position: Position,
  history: MjaiEvent[],
  gameId: string,
  decisionIndex: number,
): Candidate | undefined {
  const analysis = analyzePosition(position);
  if (!analysis) return undefined;
  const { options, bestShanten, bestUkeire, tier, resolveHandTile } = analysis;
  if (tier.length < MIN_TIER) return undefined;

  const actions = options.map((option) => {
    const regression = Math.max(0, option.shantenAfter - bestShanten);
    const loss = regression * SHANTEN_REGRESSION_PENALTY + (bestUkeire - option.ukeire);
    const tile = resolveHandTile(option.tile);
    return {
      id: `discard:${tile}`,
      label: `Discard ${tileLabel(tile)}`,
      tile,
      ev: -loss,
      loss,
      shantenAfter: option.shantenAfter,
      ukeire: option.ukeire,
      accepted: loss <= EPSILON_TILES,
    };
  });

  const accepted = actions.filter((action) => action.accepted);
  if (accepted.length === 0 || accepted.length > 2) return undefined;

  const tierLosses = actions
    .filter((action) => action.shantenAfter === bestShanten && !action.accepted)
    .map((action) => action.loss);
  if (tierLosses.length === 0) return undefined;
  const margin = Math.min(...tierLosses);
  if (margin < MIN_MARGIN) return undefined;

  const tags = ['efficiency'];
  if (bestShanten === 0) tags.push('tenpai-choice');
  if (analysis.currentShanten === 2) tags.push('two-shanten');
  if (tier.length >= 5) tags.push('wide-choice');
  if (position.riichi.some((flag, seat) => flag && seat !== position.seat)) {
    tags.push('opponent-riichi');
  }
  if (position.melds.length > 0) tags.push('open-hand');

  const difficulty = Math.max(
    5,
    Math.min(
      95,
      Math.round(
        46 -
          margin * 2.5 +
          tier.length * 4 +
          (analysis.currentShanten - 1) * 6 +
          accepted.length * 4,
      ),
    ),
  );

  const puzzle: Puzzle = {
    id: 'pending',
    schemaVersion: SCHEMA_VERSION,
    kind: 'discard',
    position,
    actions,
    acceptedActionIds: accepted.map((action) => action.id),
    bestShanten,
    tags,
    difficulty,
    evaluation: {
      evaluators: ['ukeire-baseline'],
      margin,
      agreement: false,
      epsilon: EPSILON_TILES,
      unit: 'ukeire_tiles',
    },
    source: { dataset: 'tenhou-houou-2010', gameId, decisionIndex, authored: false },
    history,
    explanation:
      `${accepted.length > 1 ? `${accepted.length} discards tie for best. ` : ''}` +
      `The best discard ${
        bestShanten === 0 ? 'reaches tenpai' : `keeps the hand at ${bestShanten}-shanten`
      } with ${bestUkeire} tiles of acceptance. ` +
      `${tier.length} discards hold that shanten, so the choice is which accepts the most. ` +
      'This drill scores tile efficiency only — it ignores yaku, score and safety, which is ' +
      'exactly where a real player would sometimes disagree.',
  };

  return { puzzle, margin };
}

function mineGame(events: MjaiEvent[], gameId: string): Candidate[] {
  const found: Candidate[] = [];

  for (const kyoku of splitKyoku(events)) {
    const frames = replayKyoku(kyoku);
    if (frames.length === 0) continue;

    for (let i = 0; i < kyoku.length; i++) {
      const event = kyoku[i];
      if (event.type !== 'dahai') continue;
      const seat = event.actor;

      // The state to solve from is whatever the previous event produced.
      let frame: Snapshot | undefined;
      for (const candidate of frames) {
        if (candidate.eventIndex < i) frame = candidate;
        else break;
      }
      if (!frame) continue;

      const state = frame.seats[seat];
      // A riichi hand's discard is forced, so it is not a decision.
      if (state.riichi) continue;
      if (state.hand.length + state.melds.length * 3 !== 14) continue;

      const position = positionFromSnapshot(frame, seat);
      const candidate = evaluateDecision(position, kyoku.slice(0, i), gameId, i);
      if (candidate) found.push(candidate);
    }
  }

  // Pick evenly spaced candidates rather than the widest-margin ones. Taking the
  // widest margins concentrated the bank on East-1 (the earliest hands yield the
  // most clean-cut efficiency decisions) and on the easiest puzzles, since a wide
  // margin is exactly what makes an answer obvious. Even spacing keeps the round,
  // score situation and difficulty varied.
  if (found.length <= MAX_PER_GAME) return found;
  const picked: Candidate[] = [];
  const stride = found.length / MAX_PER_GAME;
  for (let k = 0; k < MAX_PER_GAME; k++) {
    picked.push(found[Math.floor(k * stride + stride / 2)]);
  }
  return picked;
}

function main(): void {
  const sourceDir = process.argv[2];
  const target = Number(process.argv[3] ?? 200);
  if (!sourceDir) {
    process.stderr.write('usage: build-puzzles.ts <mjai log dir> [count]\n');
    process.exit(1);
  }

  const names = readdirSync(sourceDir)
    .filter((name) => name.endsWith('.mjson'))
    .sort();

  const puzzles: Puzzle[] = [];
  let scanned = 0;

  for (const name of names) {
    if (puzzles.length >= target) break;
    scanned += 1;
    let events: MjaiEvent[];
    try {
      events = readEvents(join(sourceDir, name));
    } catch {
      continue;
    }
    for (const candidate of mineGame(events, name.replace('.mjson', ''))) {
      if (puzzles.length >= target) break;
      puzzles.push({
        ...candidate.puzzle,
        id: `h2010-${String(puzzles.length + 1).padStart(4, '0')}`,
      });
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const shardFile = 'houou-000.json';
  const shard: PuzzleShard = { schemaVersion: SCHEMA_VERSION, puzzles };
  writeFileSync(join(OUT_DIR, shardFile), `${JSON.stringify(shard)}\n`);

  const index: PuzzleIndex = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: '2026-07-30',
    provenance:
      'Positions are real decision points from Tenhou houou-room hanchan, redistributed ' +
      'by tenhou-to-mjai under CC BY 4.0, so the scores, round and hand history are ' +
      'genuine. Each puzzle carries the mjai events for its hand so the decision can be ' +
      'replayed in context. The evaluation is NOT an AI evaluation: answers are scored in ' +
      'tiles of acceptance by the shanten/ukeire library, ignoring yaku, score and safety. ' +
      'An offline-RL model plus akochan will replace the evaluator; the positions stay.',
    count: puzzles.length,
    shards: [{ file: shardFile, count: puzzles.length, kinds: ['discard'] }],
  };
  writeFileSync(join(OUT_DIR, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);

  const withHistory = puzzles.filter((puzzle) => puzzle.history?.length).length;
  process.stdout.write(
    `wrote ${puzzles.length} puzzles from ${scanned} games ` +
      `(${withHistory} with replayable history) to ${OUT_DIR}\n`,
  );
}

main();
