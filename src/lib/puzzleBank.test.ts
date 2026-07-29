/**
 * Audits the generated puzzle bank on disk.
 *
 * The bank is data, and data ships without review, so it gets checked in CI: a
 * position showing a fifth copy of a tile, or a loss figure that contradicts its
 * own EV, would otherwise reach users silently.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { shanten } from './shanten';
import { analyzeDiscards } from './ukeire';
import { NUM_TILE_TYPES, tileToIndex } from './tiles';
import { bestAction, describeLoss, gradeAnswer } from './grade';
import { SCHEMA_VERSION, type PuzzleIndex, type PuzzleShard } from '../types/puzzle';

const BANK_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'puzzles');

const index = JSON.parse(readFileSync(join(BANK_DIR, 'index.json'), 'utf8')) as PuzzleIndex;
const shards = index.shards.map(
  (shard) => JSON.parse(readFileSync(join(BANK_DIR, shard.file), 'utf8')) as PuzzleShard,
);
const puzzles = shards.flatMap((shard) => shard.puzzles);

describe('puzzle bank index', () => {
  it('declares the schema version the app expects', () => {
    expect(index.schemaVersion).toBe(SCHEMA_VERSION);
    for (const shard of shards) expect(shard.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('has counts matching the shards it points at', () => {
    expect(index.count).toBe(puzzles.length);
    index.shards.forEach((declared, i) => {
      expect(shards[i].puzzles.length).toBe(declared.count);
    });
  });

  it('is not empty', () => {
    expect(puzzles.length).toBeGreaterThan(20);
  });

  it('documents its provenance', () => {
    expect(index.provenance.length).toBeGreaterThan(40);
  });
});

describe('puzzle bank contents', () => {
  it('uses unique ids', () => {
    const ids = new Set(puzzles.map((puzzle) => puzzle.id));
    expect(ids.size).toBe(puzzles.length);
  });

  it('never shows a fifth copy of any tile', () => {
    for (const puzzle of puzzles) {
      const seen = new Array<number>(NUM_TILE_TYPES).fill(0);
      const { position } = puzzle;

      for (const tile of position.hand) seen[tileToIndex(tile)] += 1;
      for (const meld of position.melds) {
        for (const tile of meld.tiles) seen[tileToIndex(tile)] += 1;
      }
      for (const melds of position.opponentMelds) {
        for (const meld of melds) {
          for (const tile of meld.tiles) seen[tileToIndex(tile)] += 1;
        }
      }
      for (const river of position.rivers) {
        for (const tile of river) seen[tileToIndex(tile)] += 1;
      }
      for (const tile of position.doraIndicators) seen[tileToIndex(tile)] += 1;

      for (let i = 0; i < NUM_TILE_TYPES; i++) {
        expect(seen[i], `${puzzle.id} shows ${seen[i]} copies of tile index ${i}`).toBeLessThanOrEqual(4);
      }
    }
  });

  it('holds a legal number of concealed tiles', () => {
    for (const puzzle of puzzles) {
      const { hand, melds } = puzzle.position;
      const total = hand.length + melds.length * 3;

      // A discard decision is always taken holding 14 tiles' worth — but not
      // always with a drawn tile. After a pon the player holds 11 concealed
      // plus a 3-tile meld and discards without having drawn, so keying this
      // off drawnTile would reject legitimate post-call positions.
      const expected = puzzle.kind === 'call' ? 13 : 14;
      expect(total, `${puzzle.id} has ${total} tiles`).toBe(expected);
    }
  });

  it('includes the drawn tile in the hand', () => {
    for (const puzzle of puzzles) {
      const { hand, drawnTile } = puzzle.position;
      if (!drawnTile) continue;
      expect(hand, `${puzzle.id} omits its drawn tile`).toContain(drawnTile);
    }
  });

  it('always has a non-empty accept set drawn from its own actions', () => {
    for (const puzzle of puzzles) {
      expect(puzzle.acceptedActionIds.length).toBeGreaterThan(0);
      const actionIds = new Set(puzzle.actions.map((action) => action.id));
      for (const id of puzzle.acceptedActionIds) {
        expect(actionIds.has(id), `${puzzle.id} accepts unknown action ${id}`).toBe(true);
      }
    }
  });

  it('keeps loss consistent with EV', () => {
    for (const puzzle of puzzles) {
      const best = bestAction(puzzle);
      for (const action of puzzle.actions) {
        expect(action.loss).toBeGreaterThanOrEqual(0);
        expect(action.loss).toBeCloseTo(best.ev - action.ev, 6);
      }
    }
  });

  it('marks exactly the zero-loss actions as accepted', () => {
    for (const puzzle of puzzles) {
      for (const action of puzzle.actions) {
        const shouldAccept = action.loss <= puzzle.evaluation.epsilon;
        expect(action.accepted, `${puzzle.id} action ${action.id}`).toBe(shouldAccept);
        expect(puzzle.acceptedActionIds.includes(action.id)).toBe(shouldAccept);
      }
    }
  });

  it('binds every discard action to a tile actually in the hand', () => {
    for (const puzzle of puzzles) {
      if (puzzle.kind !== 'discard') continue;
      for (const action of puzzle.actions) {
        expect(action.tile, `${puzzle.id} action ${action.id} has no tile`).toBeDefined();
        expect(
          puzzle.position.hand,
          `${puzzle.id} offers ${action.tile} which is not in hand`,
        ).toContain(action.tile);
      }
    }
  });

  it('offers one action per distinct tile in hand', () => {
    for (const puzzle of puzzles) {
      if (puzzle.kind !== 'discard') continue;
      const distinct = new Set(puzzle.position.hand).size;
      expect(puzzle.actions.length, `${puzzle.id}`).toBe(distinct);
    }
  });

  it('reports a difficulty inside the documented range', () => {
    for (const puzzle of puzzles) {
      expect(puzzle.difficulty).toBeGreaterThanOrEqual(0);
      expect(puzzle.difficulty).toBeLessThanOrEqual(100);
    }
  });

  it('never reports an acceptance loss larger than the tile supply', () => {
    // A tiles-of-acceptance figure above 136 would be nonsense. This is the
    // guard for the composite grading scalar leaking into a tile count: a
    // shanten regression must be described as such, never priced in tiles.
    for (const puzzle of puzzles) {
      if (puzzle.evaluation.unit !== 'ukeire_tiles') continue;
      for (const action of puzzle.actions) {
        const described = describeLoss(action, puzzle.evaluation.unit, puzzle.bestShanten);
        if (!described.endsWith('tiles')) continue;
        const magnitude = Number(described.replace(/[^0-9]/g, ''));
        expect(magnitude, `${puzzle.id} ${action.id} reports ${described}`).toBeLessThanOrEqual(136);
      }
    }
  });

  it('describes shanten-regressing discards in shanten, not tiles', () => {
    for (const puzzle of puzzles) {
      if (puzzle.bestShanten === undefined) continue;
      for (const action of puzzle.actions) {
        if (action.shantenAfter === undefined) continue;
        if (action.shantenAfter <= puzzle.bestShanten) continue;
        const described = describeLoss(action, puzzle.evaluation.unit, puzzle.bestShanten);
        expect(described, `${puzzle.id} ${action.id}`).toContain('shanten');
      }
    }
  });

  it('offers a real choice among discards that hold the best shanten', () => {
    for (const puzzle of puzzles) {
      if (puzzle.bestShanten === undefined) continue;
      const tier = puzzle.actions.filter((action) => action.shantenAfter === puzzle.bestShanten);
      // Fewer than three and the drill degenerates into "do not break your hand".
      expect(tier.length, `${puzzle.id} has only ${tier.length} non-regressing discards`).toBeGreaterThanOrEqual(3);
    }
  });

  it('measures its margin within the best-shanten tier', () => {
    for (const puzzle of puzzles) {
      if (puzzle.bestShanten === undefined) continue;
      if (puzzle.evaluation.unit !== 'ukeire_tiles') continue;
      const tierLosses = puzzle.actions
        .filter((action) => action.shantenAfter === puzzle.bestShanten && !action.accepted)
        .map((action) => action.loss);
      expect(tierLosses.length, `${puzzle.id}`).toBeGreaterThan(0);
      expect(puzzle.evaluation.margin).toBeCloseTo(Math.min(...tierLosses), 6);
      // A within-tier margin is a true tile count.
      expect(puzzle.evaluation.margin).toBeLessThan(136);
    }
  });

  it('declares at least one evaluator and a real margin', () => {
    for (const puzzle of puzzles) {
      expect(puzzle.evaluation.evaluators.length).toBeGreaterThan(0);
      expect(puzzle.evaluation.margin).toBeGreaterThan(0);
    }
  });

  it('does not claim multi-evaluator agreement with a single evaluator', () => {
    for (const puzzle of puzzles) {
      if (puzzle.evaluation.evaluators.length < 2) {
        expect(puzzle.evaluation.agreement, `${puzzle.id}`).toBe(false);
      }
    }
  });
});

describe('seed bank answers match a fresh ukeire computation', () => {
  it('recomputes the same best discards', () => {
    const seeds = puzzles.filter((puzzle) => puzzle.evaluation.unit === 'ukeire_tiles');
    expect(seeds.length).toBeGreaterThan(0);

    for (const puzzle of seeds) {
      const { position } = puzzle;
      const counts = new Array<number>(NUM_TILE_TYPES).fill(0);
      for (const tile of position.hand) counts[tileToIndex(tile)] += 1;

      const visible = new Array<number>(NUM_TILE_TYPES).fill(0);
      for (const tile of position.hand) visible[tileToIndex(tile)] += 1;
      for (const river of position.rivers) {
        for (const tile of river) visible[tileToIndex(tile)] += 1;
      }
      for (const tile of position.doraIndicators) visible[tileToIndex(tile)] += 1;

      const options = analyzeDiscards(counts, 0, visible);
      const bestShanten = options[0].shantenAfter;
      const bestUkeire = options[0].ukeire;

      const recomputedBest = new Set(
        options
          .filter((option) => option.shantenAfter === bestShanten && option.ukeire === bestUkeire)
          .map((option) => `discard:${option.tile}`),
      );

      expect(new Set(puzzle.acceptedActionIds), `${puzzle.id}`).toEqual(recomputedBest);
      // Hands are filtered to a solvable range at generation time.
      expect(shanten(counts)).toBeLessThanOrEqual(2);
    }
  });
});

describe('grading the bank', () => {
  it('grades every accepted action as optimal and correct', () => {
    for (const puzzle of puzzles) {
      for (const id of puzzle.acceptedActionIds) {
        const graded = gradeAnswer(puzzle, id);
        expect(graded.grade, `${puzzle.id} ${id}`).toBe('optimal');
        expect(graded.correct).toBe(true);
        expect(graded.score).toBe(100);
      }
    }
  });

  it('never grades a rejected action as optimal', () => {
    for (const puzzle of puzzles) {
      for (const action of puzzle.actions) {
        if (action.accepted) continue;
        const graded = gradeAnswer(puzzle, action.id);
        expect(graded.grade, `${puzzle.id} ${action.id}`).not.toBe('optimal');
        expect(graded.correct).toBe(false);
      }
    }
  });

  it('throws on an unknown action', () => {
    expect(() => gradeAnswer(puzzles[0], 'discard:nonsense')).toThrow();
  });
});
