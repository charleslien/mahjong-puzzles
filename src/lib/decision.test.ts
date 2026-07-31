import { describe, expect, it } from 'vitest';

import {
  BRANCH_LABELS,
  branchesOf,
  consumedKey,
  consumedSets,
  isMultiStep,
  legalTiles,
  linesIn,
} from './decision';
import type { PuzzleAction } from '../types/puzzle';

function line(partial: Partial<PuzzleAction> & { id: string }): PuzzleAction {
  return {
    label: partial.id,
    ev: 0,
    loss: 0,
    accepted: false,
    ...partial,
  };
}

/** A riichi position: three ways to declare, four ways to play on. */
const RIICHI: PuzzleAction[] = [
  line({ id: 'riichi:3p', branch: 'riichi', tile: '3p' }),
  line({ id: 'riichi:9p', branch: 'riichi', tile: '9p' }),
  line({ id: 'riichi:6p', branch: 'riichi', tile: '6p' }),
  line({ id: 'discard:3p', branch: 'dama', tile: '3p' }),
  line({ id: 'discard:9p', branch: 'dama', tile: '9p' }),
  line({ id: 'discard:5s', branch: 'dama', tile: '5s' }),
  line({ id: 'discard:6s', branch: 'dama', tile: '6s' }),
];

/** A call position: pass, or chi with either of two sets. */
const CALL: PuzzleAction[] = [
  line({ id: 'pass', branch: 'pass' }),
  line({ id: 'chi:2s+3s:5m', branch: 'chi', consumed: ['2s', '3s'], tile: '5m' }),
  line({ id: 'chi:2s+3s:9s', branch: 'chi', consumed: ['2s', '3s'], tile: '9s' }),
  line({ id: 'chi:3s+5s:5m', branch: 'chi', consumed: ['3s', '5s'], tile: '5m' }),
];

describe('walking a multi-step decision', () => {
  it('treats a plain discard puzzle as a single step', () => {
    expect(isMultiStep([line({ id: 'discard:1m', tile: '1m' })])).toBe(false);
    expect(isMultiStep(RIICHI)).toBe(true);
  });

  it('orders the forks by convention, never by value', () => {
    // The buttons are shown before the puzzle is answered, so ordering them by
    // expected value would put the answer first every time.
    const valueSorted = [...RIICHI].reverse().map((action, i) => ({ ...action, ev: i }));
    expect(branchesOf(valueSorted)).toEqual(['riichi', 'dama']);
    expect(branchesOf(CALL)).toEqual(['chi', 'pass']);
  });

  it('narrows the legal tiles to the branch taken', () => {
    // The whole point of asking the fork first: declaring restricts you to the
    // tiles that keep tenpai.
    expect(legalTiles(RIICHI, 'riichi')).toEqual(new Set(['3p', '9p', '6p']));
    expect(legalTiles(RIICHI, 'dama')).toEqual(new Set(['3p', '9p', '5s', '6s']));
  });

  it('separates two ways to eat the same tile', () => {
    expect(consumedSets(CALL, 'chi')).toEqual([
      ['2s', '3s'],
      ['3s', '5s'],
    ]);
    // 5 characters is a legal throw after either chi, but they are not the same
    // play and do not have the same value.
    expect(linesIn(CALL, 'chi', ['2s', '3s']).map((a) => a.id)).toEqual([
      'chi:2s+3s:5m',
      'chi:2s+3s:9s',
    ]);
    expect(legalTiles(CALL, 'chi', ['3s', '5s'])).toEqual(new Set(['5m']));
  });

  it('identifies a consumed set regardless of the order it is written in', () => {
    expect(consumedKey(['3s', '2s'])).toBe(consumedKey(['2s', '3s']));
    expect(consumedKey(undefined)).toBe('');
    // A red five is a different set from its plain twin: eating it gives away
    // a dora.
    expect(consumedKey(['3s', '5sr'])).not.toBe(consumedKey(['3s', '5s']));
  });

  it('leaves passing with nothing to pick', () => {
    expect(linesIn(CALL, 'pass')).toHaveLength(1);
    // One line and no tile, so the interface answers rather than asking again.
    expect(legalTiles(CALL, 'pass').size).toBe(0);
  });

  it('names every branch without naming a tile', () => {
    for (const label of Object.values(BRANCH_LABELS)) {
      expect(label).not.toMatch(/circles|bamboo|characters/i);
    }
  });
});
