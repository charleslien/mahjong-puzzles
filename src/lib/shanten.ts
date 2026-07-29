/**
 * Shanten (distance to tenpai) calculation.
 *
 * Convention used throughout: -1 means the hand is complete, 0 means tenpai
 * (one tile from winning), n means n tiles away from tenpai.
 *
 * The standard-form search enumerates every way to carve the count vector into
 * melds (3-tile sets) and partials (pairs or 2-tile proto-runs), then scores
 * each decomposition with the usual
 *
 *     shanten = 8 - 2 * melds - partials
 *
 * capped at five blocks, with a +1 correction when all five blocks are formed
 * but none of them is a pair — such a hand has no head and needs an extra tile
 * to grow one.
 */

import { NUM_TILE_TYPES } from './tiles';

/** Number of melds already called, if any. Concealed hands pass 0. */
export type MeldCount = 0 | 1 | 2 | 3 | 4;

export function standardShanten(counts: number[], melds: MeldCount = 0): number {
  const work = [...counts];
  let best = 8;

  const evaluate = (formed: number, partials: number, hasPair: boolean): void => {
    const totalMelds = formed + melds;
    let value = 8 - 2 * totalMelds - partials;
    if (totalMelds + partials === 5 && !hasPair) value += 1;
    if (value < best) best = value;
  };

  const dfs = (start: number, formed: number, partials: number, hasPair: boolean): void => {
    let i = start;
    while (i < NUM_TILE_TYPES && work[i] === 0) i++;
    if (i === NUM_TILE_TYPES) {
      evaluate(formed, partials, hasPair);
      return;
    }

    // A hand needs at most four sets plus one head; beyond that extra blocks
    // cannot contribute, so treat everything remaining as floaters.
    if (formed + melds + partials >= 5) {
      evaluate(formed, partials, hasPair);
      return;
    }

    const rank = i % 9;
    const isSuited = i < 27;

    if (work[i] >= 3) {
      work[i] -= 3;
      dfs(i, formed + 1, partials, hasPair);
      work[i] += 3;
    }

    if (isSuited && rank <= 6 && work[i + 1] > 0 && work[i + 2] > 0) {
      work[i] -= 1;
      work[i + 1] -= 1;
      work[i + 2] -= 1;
      dfs(i, formed + 1, partials, hasPair);
      work[i] += 1;
      work[i + 1] += 1;
      work[i + 2] += 1;
    }

    if (work[i] >= 2) {
      work[i] -= 2;
      dfs(i, formed, partials + 1, true);
      work[i] += 2;
    }

    if (isSuited && rank <= 7 && work[i + 1] > 0) {
      work[i] -= 1;
      work[i + 1] -= 1;
      dfs(i, formed, partials + 1, hasPair);
      work[i] += 1;
      work[i + 1] += 1;
    }

    if (isSuited && rank <= 6 && work[i + 2] > 0) {
      work[i] -= 1;
      work[i + 2] -= 1;
      dfs(i, formed, partials + 1, hasPair);
      work[i] += 1;
      work[i + 2] += 1;
    }

    // Leave this tile unused.
    work[i] -= 1;
    dfs(i, formed, partials, hasPair);
    work[i] += 1;
  };

  dfs(0, 0, 0, false);
  return best;
}

/** Seven pairs. Only reachable with a fully concealed hand. */
export function chiitoitsuShanten(counts: number[]): number {
  let pairs = 0;
  let kinds = 0;
  for (let i = 0; i < NUM_TILE_TYPES; i++) {
    if (counts[i] > 0) kinds += 1;
    if (counts[i] >= 2) pairs += 1;
  }
  // With fewer than seven distinct tiles some pairs can never be formed, so
  // each missing kind costs an extra draw.
  return 6 - pairs + Math.max(0, 7 - kinds);
}

/** Thirteen orphans. Only reachable with a fully concealed hand. */
export function kokushiShanten(counts: number[]): number {
  let kinds = 0;
  let hasPair = false;
  for (let i = 0; i < NUM_TILE_TYPES; i++) {
    const isTerminalOrHonor = i >= 27 || i % 9 === 0 || i % 9 === 8;
    if (!isTerminalOrHonor) continue;
    if (counts[i] > 0) kinds += 1;
    if (counts[i] >= 2) hasPair = true;
  }
  return 13 - kinds - (hasPair ? 1 : 0);
}

/**
 * Overall shanten, taking the best of the three hand forms. The two exotic
 * forms are unavailable once a meld has been called.
 */
export function shanten(counts: number[], melds: MeldCount = 0): number {
  let best = standardShanten(counts, melds);
  if (melds === 0) {
    best = Math.min(best, chiitoitsuShanten(counts), kokushiShanten(counts));
  }
  return best;
}
