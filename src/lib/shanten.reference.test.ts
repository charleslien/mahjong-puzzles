/**
 * Validates the fast shanten routine against a brute-force reference.
 *
 * The reference defines shanten from first principles: a hand is n-shanten if
 * n+1 draw/discard cycles are needed before some draw completes it. It only
 * needs an exact "is this hand complete" predicate, so it shares no logic with
 * the block-decomposition search it is checking.
 *
 * Search cost explodes past depth 2, so random hands whose fast shanten exceeds
 * 2 are skipped rather than verified.
 */

import { describe, expect, it } from 'vitest';
import { shanten } from './shanten';
import { NUM_TILE_TYPES } from './tiles';

/** Exact completion check for the standard four-sets-and-a-pair form. */
function isStandardComplete(counts: number[]): boolean {
  const work = [...counts];

  const removeSets = (start: number, sets: number): boolean => {
    let i = start;
    while (i < NUM_TILE_TYPES && work[i] === 0) i++;
    if (i === NUM_TILE_TYPES) return sets === 4;
    if (sets === 4) return false;

    if (work[i] >= 3) {
      work[i] -= 3;
      const ok = removeSets(i, sets + 1);
      work[i] += 3;
      if (ok) return true;
    }
    if (i < 27 && i % 9 <= 6 && work[i + 1] > 0 && work[i + 2] > 0) {
      work[i] -= 1;
      work[i + 1] -= 1;
      work[i + 2] -= 1;
      const ok = removeSets(i, sets + 1);
      work[i] += 1;
      work[i + 1] += 1;
      work[i + 2] += 1;
      if (ok) return true;
    }
    return false;
  };

  for (let head = 0; head < NUM_TILE_TYPES; head++) {
    if (work[head] < 2) continue;
    work[head] -= 2;
    const ok = removeSets(0, 0);
    work[head] += 2;
    if (ok) return true;
  }
  return false;
}

function isChiitoiComplete(counts: number[]): boolean {
  let pairs = 0;
  for (let i = 0; i < NUM_TILE_TYPES; i++) {
    if (counts[i] === 2) pairs += 1;
    else if (counts[i] !== 0) return false;
  }
  return pairs === 7;
}

function isKokushiComplete(counts: number[]): boolean {
  let kinds = 0;
  let pairs = 0;
  for (let i = 0; i < NUM_TILE_TYPES; i++) {
    if (counts[i] === 0) continue;
    const isTerminalOrHonor = i >= 27 || i % 9 === 0 || i % 9 === 8;
    if (!isTerminalOrHonor) return false;
    kinds += 1;
    if (counts[i] === 2) pairs += 1;
    else if (counts[i] !== 1) return false;
  }
  return kinds === 13 && pairs === 1;
}

function isComplete(counts: number[]): boolean {
  return isStandardComplete(counts) || isChiitoiComplete(counts) || isKokushiComplete(counts);
}

/** True if the 13-tile hand can reach a win within `depth` discard cycles. */
function winnableWithin(counts: number[], depth: number): boolean {
  const work = [...counts];

  for (let draw = 0; draw < NUM_TILE_TYPES; draw++) {
    if (work[draw] >= 4) continue;
    work[draw] += 1;
    if (isComplete(work)) {
      work[draw] -= 1;
      return true;
    }
    if (depth > 0) {
      for (let discard = 0; discard < NUM_TILE_TYPES; discard++) {
        if (work[discard] === 0) continue;
        work[discard] -= 1;
        const ok = winnableWithin(work, depth - 1);
        work[discard] += 1;
        if (ok) {
          work[draw] -= 1;
          return true;
        }
      }
    }
    work[draw] -= 1;
  }
  return false;
}

/** Deterministic PRNG so a failure is always reproducible. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomHand(random: () => number): number[] {
  const wall: number[] = [];
  for (let i = 0; i < NUM_TILE_TYPES; i++) {
    for (let n = 0; n < 4; n++) wall.push(i);
  }
  for (let i = wall.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [wall[i], wall[j]] = [wall[j], wall[i]];
  }
  const counts = new Array<number>(NUM_TILE_TYPES).fill(0);
  for (let i = 0; i < 13; i++) counts[wall[i]] += 1;
  return counts;
}

describe('shanten agrees with the brute-force reference', () => {
  // Uniformly random hands are scattered across the whole tile range, which
  // makes the depth-2 search prohibitive, so these are only verified to depth 1.
  it('matches on uniformly random hands up to 1-shanten', () => {
    const random = makeRandom(20260729);
    let checked = 0;

    for (let trial = 0; trial < 1500; trial++) {
      const hand = randomHand(random);
      const fast = shanten(hand);
      if (fast > 1) continue;

      expect(winnableWithin(hand, fast)).toBe(true);
      if (fast > 0) {
        expect(winnableWithin(hand, fast - 1)).toBe(false);
      }
      checked += 1;
    }

    // Random 13-tile hands are usually 3-4 shanten, so only a thin slice
    // qualifies; guard against the loop silently verifying nothing.
    expect(checked).toBeGreaterThan(5);
  });

  it('matches on hands seeded toward tenpai', () => {
    const random = makeRandom(777);
    let checked = 0;

    for (let trial = 0; trial < 200; trial++) {
      // Bias toward structured hands by drawing from a narrowed tile range.
      const counts = new Array<number>(NUM_TILE_TYPES).fill(0);
      let placed = 0;
      while (placed < 13) {
        const tile = Math.floor(random() * 14);
        if (counts[tile] >= 4) continue;
        counts[tile] += 1;
        placed += 1;
      }

      const fast = shanten(counts);
      if (fast > 2) continue;

      expect(winnableWithin(counts, fast)).toBe(true);
      if (fast > 0) {
        expect(winnableWithin(counts, fast - 1)).toBe(false);
      }
      checked += 1;
    }

    expect(checked).toBeGreaterThan(50);
  });
});
