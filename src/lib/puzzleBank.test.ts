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

import { analyzePosition } from './analyzePosition';
import { DIFFICULTY_BANDS } from './difficulty';
import { ANSWER_DERIVED_TAGS, positionTags } from './tags';
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

  // The efficiency bank uses epsilon 0, so this was "exactly the zero-loss
  // actions". With placement points the accept band is a real epsilon.
  it('accepts exactly the actions within epsilon of the best', () => {
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
      // Distinct tile *strings*, so a red five and its plain twin are two plays.
      // This used to count indices, which merged them — and since acceptance is
      // computed per index that felt right, but discarding the red one gives
      // away a dora and akochan prices it differently. 145 puzzles were offering
      // only one of the two.
      const distinct = new Set(puzzle.position.hand).size;
      expect(puzzle.actions.length, `${puzzle.id}`).toBe(distinct);
    }
  });

  it('prices a red five separately from its plain twin', () => {
    let checked = 0;
    for (const puzzle of puzzles) {
      if (puzzle.kind !== 'discard') continue;
      for (const red of ['5mr', '5pr', '5sr'] as const) {
        const plain = red.slice(0, 2);
        if (!puzzle.position.hand.includes(red)) continue;
        if (!puzzle.position.hand.includes(plain)) continue;
        const ids = new Set(puzzle.actions.map((action) => action.id));
        expect(ids.has(`discard:${red}`), `${puzzle.id} omits the red five`).toBe(true);
        expect(ids.has(`discard:${plain}`), `${puzzle.id} omits the plain five`).toBe(true);
        checked += 1;
      }
    }
    // Not asserting a count: a regenerated bank may happen to contain none.
    expect(checked).toBeGreaterThanOrEqual(0);
  });

  it('gives every line of a multi-step decision a branch and a legal discard', () => {
    for (const puzzle of puzzles) {
      if (puzzle.kind !== 'riichi' && puzzle.kind !== 'call') continue;
      for (const action of puzzle.actions) {
        expect(action.branch, `${puzzle.id} action ${action.id} has no branch`).toBeDefined();
        // Two branches end without a discard, for different reasons: passing
        // does nothing at all, and an open kan is followed by a draw from the
        // dead wall, so the discard belongs to a later decision.
        if (action.branch === 'pass' || action.branch === 'daiminkan') {
          expect(action.tile, `${puzzle.id}: ${action.id} discards nothing`).toBeUndefined();
          continue;
        }
        // Every other line ends on a discard, and it has to be a tile the seat
        // actually holds — after the call has eaten what it eats.
        expect(action.tile, `${puzzle.id} action ${action.id} has no discard`).toBeDefined();
        const left = [...puzzle.position.hand];
        for (const eaten of action.consumed ?? []) {
          const at = left.indexOf(eaten);
          expect(at, `${puzzle.id}: ${action.id} eats ${eaten}, not in hand`).toBeGreaterThanOrEqual(
            0,
          );
          left.splice(at, 1);
        }
        expect(left, `${puzzle.id}: ${action.id} throws a tile it does not hold`).toContain(
          action.tile,
        );
      }
    }
  });

  it('offers a real fork on every multi-step decision', () => {
    for (const puzzle of puzzles) {
      if (puzzle.kind !== 'riichi' && puzzle.kind !== 'call') continue;
      const branches = new Set(puzzle.actions.map((action) => action.branch));
      // One branch is not a decision — it would present a question whose every
      // answer is the same first move.
      expect(branches.size, `${puzzle.id} has only ${[...branches]}`).toBeGreaterThan(1);
      if (puzzle.kind === 'riichi') expect(branches).toContain('riichi');
      if (puzzle.kind === 'call') expect(branches).toContain('pass');
    }
  });

  it('records the tile a call is asked about', () => {
    for (const puzzle of puzzles) {
      if (puzzle.kind !== 'call') continue;
      // Without these the board cannot mark which discard the question is about,
      // and the meld a call would make cannot be drawn at all.
      expect(puzzle.position.calledTile, `${puzzle.id} names no called tile`).toBeDefined();
      expect(puzzle.position.calledFrom, `${puzzle.id} names no discarder`).toBeDefined();
      expect(puzzle.position.calledFrom).not.toBe(puzzle.position.seat);
      for (const action of puzzle.actions) {
        if (!action.consumed?.length) continue;
        // A call takes the offered tile, so the set it eats comes wholly from
        // hand: three tiles for a kan, two for anything else.
        expect(action.consumed.length, `${puzzle.id} ${action.id}`).toBe(
          action.branch === 'daiminkan' ? 3 : 2,
        );
      }
    }
  });

  it('never carries a tag that reveals the answer', () => {
    // These recorded what the houou player did, and a position is only published
    // when akochan and that player agree on the branch — so the chip shown above
    // the board *was* the answer, on every riichi and call puzzle in the bank.
    const spoilers = ['declared', 'stayed-concealed', 'called', 'let-it-pass'];
    for (const puzzle of puzzles) {
      for (const spoiler of spoilers) {
        expect(puzzle.tags, `${puzzle.id} is tagged ${spoiler}`).not.toContain(spoiler);
      }
    }
  });

  it('shows nothing above the board that depends on the answer', () => {
    // The bank still stores these — they are how the theme drill finds
    // positions, and they are the right framing once an answer is in. What must
    // not happen is showing them while the question is open, which is how
    // `efficiency-trap` came to be an answer key: absent, the efficiency pick
    // was an accepted answer in 815 of 815 discard puzzles.
    for (const puzzle of puzzles) {
      for (const tag of positionTags(puzzle.tags)) {
        expect(ANSWER_DERIVED_TAGS.has(tag), `${puzzle.id} would show ${tag}`).toBe(false);
      }
    }
  });

  it('only claims an efficiency trap where efficiency had a view', () => {
    // A call is judged with thirteen tiles and no discard to analyse, so there is
    // no baseline to disagree with. Reading "no opinion" as disagreement put the
    // site's headline tag on all 713 call and riichi puzzles.
    for (const puzzle of puzzles) {
      if (puzzle.kind !== 'call') continue;
      expect(puzzle.tags, `${puzzle.id}`).not.toContain('efficiency-trap');
    }
  });

  it('spreads across the difficulty bands the filter offers', () => {
    // The bands are calibrated against this distribution, so a regeneration that
    // shifts the proxy has to be noticed here. Spaced evenly across 0-100 they
    // held 48% / 50% / 2%, and picking Hard returned a pool small enough to
    // repeat inside one session.
    const share = (band: (typeof DIFFICULTY_BANDS)[number]) =>
      puzzles.filter((p) => p.difficulty >= band.min && p.difficulty <= band.max).length /
      puzzles.length;
    for (const band of DIFFICULTY_BANDS) {
      if (band.id === 'all') continue;
      expect(share(band), `${band.label} holds ${(share(band) * 100).toFixed(1)}%`).toBeGreaterThan(
        0.15,
      );
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
        // A regressing action can be the *best* one: under an EV evaluator,
        // folding into a threat costs shanten and is sometimes correct. There is
        // no loss to describe in that case.
        if (action.loss <= 0) continue;
        const described = describeLoss(action, puzzle.evaluation.unit, puzzle.bestShanten);
        expect(described, `${puzzle.id} ${action.id}`).toContain('shanten');
      }
    }
  });

  it('offers a real choice among discards that hold the best shanten', () => {
    for (const puzzle of puzzles) {
      if (puzzle.bestShanten === undefined) continue;
      // Efficiency drills only. When the evaluator is placement points, breaking
      // the hand can be the *right* answer — folding into a threat is exactly the
      // kind of decision an EV search can express and tile counting cannot — so
      // requiring three non-regressing discards would throw away the puzzles the
      // stronger evaluator exists to find.
      if (puzzle.evaluation.unit !== 'ukeire_tiles') continue;
      const tier = puzzle.actions.filter((action) => action.shantenAfter === puzzle.bestShanten);
      // Fewer than three and the drill degenerates into "do not break your hand".
      expect(tier.length, `${puzzle.id} has only ${tier.length} non-regressing discards`).toBeGreaterThanOrEqual(3);
    }
  });

  it('offers a real choice, and not every answer is correct', () => {
    for (const puzzle of puzzles) {
      // The invariant that survives any evaluator: there is something to choose
      // between, and choosing wrong is possible.
      expect(puzzle.actions.length, `${puzzle.id}`).toBeGreaterThanOrEqual(2);
      expect(
        puzzle.acceptedActionIds.length,
        `${puzzle.id} accepts every action, so it teaches nothing`,
      ).toBeLessThan(puzzle.actions.length);
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

describe('bank answers match a fresh ukeire computation', () => {
  it('recomputes the same best discards for efficiency puzzles', () => {
    // Only meaningful where ukeire *is* the evaluator. An akochan-scored bank has
    // no such puzzles, and asserting a non-empty set here would fail for a
    // legitimate reason.
    const seeds = puzzles.filter((puzzle) => puzzle.evaluation.unit === 'ukeire_tiles');

    for (const puzzle of seeds) {
      const analysis = analyzePosition(puzzle.position);
      expect(analysis, `${puzzle.id} is not a discard problem`).toBeDefined();
      if (!analysis) continue;

      // Compare by tile index, since the stored action names whichever copy the
      // hand actually holds — plain or red.
      const recomputedBest = new Set(
        analysis.options
          .filter(
            (option) =>
              option.shantenAfter === analysis.bestShanten &&
              option.ukeire === analysis.bestUkeire,
          )
          .map((option) => tileToIndex(option.tile)),
      );
      const storedBest = new Set(
        puzzle.acceptedActionIds.map((id) => tileToIndex(id.replace('discard:', ''))),
      );

      expect(storedBest, `${puzzle.id}`).toEqual(recomputedBest);
      expect(analysis.currentShanten).toBeLessThanOrEqual(2);
    }
  });

  it('recomputes the same shanten and acceptance for every stored action', () => {
    // Applies whatever the evaluator is. The EV comes from akochan, but the
    // shanten and acceptance figures shown beside it are computed here, and this
    // checks they survived the pipeline unchanged — including the visibility
    // accounting, which is where a duplicated meld silently understated
    // acceptance in 230 of 897 positions.
    let checked = 0;
    for (const puzzle of puzzles) {
      if (puzzle.kind !== 'discard') continue;
      const analysis = analyzePosition(puzzle.position);
      if (!analysis) continue;

      const byIndex = new Map(
        analysis.options.map((option) => [tileToIndex(option.tile), option]),
      );
      for (const action of puzzle.actions) {
        if (action.shantenAfter === undefined || action.ukeire === undefined) continue;
        if (!action.tile) continue;
        const fresh = byIndex.get(tileToIndex(action.tile));
        expect(fresh, `${puzzle.id} ${action.id} has no fresh option`).toBeDefined();
        if (!fresh) continue;
        expect(action.shantenAfter, `${puzzle.id} ${action.id} shanten`).toBe(fresh.shantenAfter);
        expect(action.ukeire, `${puzzle.id} ${action.id} ukeire`).toBe(fresh.ukeire);
        checked += 1;
      }
    }
    expect(checked, 'no actions carried shanten/acceptance to check').toBeGreaterThan(0);
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
