/**
 * Ukeire (tile acceptance) — which draws improve the hand, and how many such
 * tiles remain unseen.
 *
 * This is the naive-efficiency baseline. It deliberately knows nothing about
 * yaku, score, safety or table position, which is exactly why it makes a useful
 * foil: positions where pure ukeire disagrees with the AI evaluation are the
 * instructive ones.
 */

import { shanten, type MeldCount } from './shanten';
import { indexToTile, NUM_TILE_TYPES, type Tile } from './tiles';

export interface UkeireResult {
  /** Shanten of the hand as given. */
  shanten: number;
  /** Tile types whose draw lowers shanten. */
  tiles: Tile[];
  /** How many of those tiles are still unseen. */
  count: number;
}

export interface DiscardOption {
  tile: Tile;
  shantenAfter: number;
  ukeire: number;
  acceptedTiles: Tile[];
}

/**
 * Acceptance for a hand that is one tile short of a full hand (13 tiles for a
 * concealed hand, fewer when melds have been called).
 *
 * `visible` is an optional 34-length vector of every tile already seen by the
 * player — their own hand and melds, all four discard piles, and the dora
 * indicators. Tiles are drawn from what remains, so accounting for visible
 * copies is what makes the count honest.
 */
export function ukeire(counts: number[], melds: MeldCount = 0, visible?: number[]): UkeireResult {
  const current = shanten(counts, melds);
  const tiles: Tile[] = [];
  let count = 0;

  const work = [...counts];
  for (let i = 0; i < NUM_TILE_TYPES; i++) {
    // A fifth copy cannot be drawn.
    if (work[i] >= 4) continue;
    const seen = visible ? visible[i] : work[i];
    const remaining = 4 - seen;
    if (remaining <= 0) continue;

    work[i] += 1;
    const after = shanten(work, melds);
    work[i] -= 1;

    if (after < current) {
      tiles.push(indexToTile(i));
      count += remaining;
    }
  }

  return { shanten: current, tiles, count };
}

/**
 * For a full hand, evaluate every distinct discard. Sorted best-first by
 * resulting shanten then acceptance, which is the ordering a pure efficiency
 * trainer would present.
 */
export function analyzeDiscards(
  counts: number[],
  melds: MeldCount = 0,
  visible?: number[],
): DiscardOption[] {
  const options: DiscardOption[] = [];
  const work = [...counts];

  for (let i = 0; i < NUM_TILE_TYPES; i++) {
    if (work[i] === 0) continue;
    work[i] -= 1;
    const result = ukeire(work, melds, visible);
    options.push({
      tile: indexToTile(i),
      shantenAfter: result.shanten,
      ukeire: result.count,
      acceptedTiles: result.tiles,
    });
    work[i] += 1;
  }

  options.sort((a, b) => a.shantenAfter - b.shantenAfter || b.ukeire - a.ukeire);
  return options;
}
