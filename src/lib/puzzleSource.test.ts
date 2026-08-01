/**
 * Tests for the filter the two sources have to agree on.
 *
 * A deployment with a database filters in SQL and one without filters in
 * memory. If the two disagree, the same chip means different things depending
 * on which source a visitor happened to be served — and the fallback is
 * supposed to be invisible.
 */

import { describe, expect, it } from 'vitest';

import { matches, shuffled } from './puzzleSource';

const puzzle = { kind: 'discard', tags: ['discard', 'endgame', 'close-call'] };

describe('matches', () => {
  it('lets everything through when nothing is asked for', () => {
    expect(matches(puzzle)).toBe(true);
    expect(matches(puzzle, [], [])).toBe(true);
  });

  it('requires the kind to be one of those listed', () => {
    expect(matches(puzzle, ['discard'])).toBe(true);
    expect(matches(puzzle, ['discard', 'call'])).toBe(true);
    expect(matches(puzzle, ['call'])).toBe(false);
  });

  it('requires any one of the tags, not all of them', () => {
    // `p.tags && any_tags` is array overlap.
    expect(matches(puzzle, undefined, ['endgame'])).toBe(true);
    expect(matches(puzzle, undefined, ['all-last', 'endgame'])).toBe(true);
    expect(matches(puzzle, undefined, ['all-last'])).toBe(false);
  });

  it('applies kind and tag together', () => {
    expect(matches(puzzle, ['discard'], ['endgame'])).toBe(true);
    // Each holds hundreds of puzzles and they share none: this is the
    // combination that empties a session.
    expect(matches(puzzle, ['riichi'], ['endgame'])).toBe(false);
    expect(matches(puzzle, ['discard'], ['all-last'])).toBe(false);
  });

  it('never matches a puzzle with no tags against a tag filter', () => {
    expect(matches({ kind: 'discard', tags: [] }, undefined, ['endgame'])).toBe(false);
  });
});

describe('shuffled', () => {
  it('is a permutation, not a sample', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    expect([...shuffled(items, 7)].sort((a, b) => a - b)).toEqual(items);
  });

  it('depends on the seed', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(shuffled(items, 1)).not.toEqual(shuffled(items, 2));
    expect(shuffled(items, 1)).toEqual(shuffled(items, 1));
  });

  it('leaves its argument alone', () => {
    const items = [1, 2, 3];
    shuffled(items, 9);
    expect(items).toEqual([1, 2, 3]);
  });
});
