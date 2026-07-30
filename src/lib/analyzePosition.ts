/**
 * Tile-efficiency analysis of a stored Position.
 *
 * Extracted so the two things that need it — the ukeire-baseline bank builder and
 * the annotator that feeds the akochan verification pipeline — share one
 * implementation. They previously would have carried separate copies of the
 * visibility accounting and the red-five resolution below, which are exactly the
 * details that are easy to get subtly and silently wrong.
 */

import { shanten } from './shanten';
import { analyzeDiscards, type DiscardOption } from './ukeire';
import { NUM_TILE_TYPES, isRedFive, tileToIndex, type Tile } from './tiles';
import type { Position } from '../types/puzzle';

export interface PositionAnalysis {
  /** Discard options, best first. */
  options: DiscardOption[];
  /** Shanten of the best option. */
  bestShanten: number;
  /** Acceptance count of the best option. */
  bestUkeire: number;
  /** Shanten before discarding. */
  currentShanten: number;
  /** Options sharing the best shanten. */
  tier: DiscardOption[];
  /**
   * Map an index-derived tile back to a tile the hand actually holds.
   *
   * Acceptance is computed over 34 tile indices, which collapses a red five onto
   * its plain twin, so an option can name `5m` when the hand only holds `5mr`.
   * When both copies are present the plain one is the discard — a player keeps
   * the red for its dora value.
   */
  resolveHandTile: (tile: Tile) => Tile;
}

/**
 * Count every tile this seat can actually see.
 *
 * Deliberately excludes opponents' concealed hands. They are present in the
 * source logs but not visible to the player, so letting them inform the
 * acceptance count would produce a puzzle whose stated answer depends on
 * information the solver does not have.
 */
export function visibleCounts(position: Position): number[] {
  const visible = new Array<number>(NUM_TILE_TYPES).fill(0);
  const add = (tile: Tile): void => {
    visible[tileToIndex(tile)] += 1;
  };

  for (const tile of position.hand) add(tile);
  for (const meld of position.melds) for (const tile of meld.tiles) add(tile);
  for (const melds of position.opponentMelds) {
    for (const meld of melds) for (const tile of meld.tiles) add(tile);
  }
  for (const river of position.rivers) for (const tile of river) add(tile);
  for (const tile of position.doraIndicators) add(tile);

  return visible;
}

/**
 * Analyse a position, or return undefined when it is not a discard problem.
 *
 * Rejects complete hands and hands further than `maxShanten` from a win, where
 * efficiency alone stops having a meaningful answer.
 */
export function analyzePosition(
  position: Position,
  maxShanten = 2,
): PositionAnalysis | undefined {
  const counts = new Array<number>(NUM_TILE_TYPES).fill(0);
  for (const tile of position.hand) counts[tileToIndex(tile)] += 1;

  const meldCount = Math.min(4, position.melds.length) as 0 | 1 | 2 | 3 | 4;
  const currentShanten = shanten(counts, meldCount);
  if (currentShanten < 0 || currentShanten > maxShanten) return undefined;

  const options = analyzeDiscards(counts, meldCount, visibleCounts(position));
  if (options.length < 2) return undefined;

  const byIndex = new Map<number, Tile[]>();
  for (const tile of position.hand) {
    const index = tileToIndex(tile);
    const list = byIndex.get(index);
    if (list) list.push(tile);
    else byIndex.set(index, [tile]);
  }

  const bestShanten = options[0].shantenAfter;

  return {
    options,
    bestShanten,
    bestUkeire: options[0].ukeire,
    currentShanten,
    tier: options.filter((option) => option.shantenAfter === bestShanten),
    resolveHandTile: (tile: Tile): Tile => {
      const held = byIndex.get(tileToIndex(tile));
      if (!held || held.length === 0) return tile;
      return held.find((candidate) => !isRedFive(candidate)) ?? held[0];
    },
  };
}
