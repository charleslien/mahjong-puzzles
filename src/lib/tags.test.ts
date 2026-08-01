/**
 * Tests for the split between position themes and answer themes.
 *
 * The rule this enforces has been broken once already, in a way nobody noticed
 * for months: `declared` / `called` chips sat above the board and predicted the
 * branch in 713 of 713 puzzles. `efficiency-trap` was the same shape.
 */

import { describe, expect, it } from 'vitest';

import { ANSWER_DERIVED_TAGS, answerTags, positionTags } from './tags';

const ALL = [
  'discard',
  'tenpai-choice',
  'two-shanten',
  'wide-choice',
  'open-hand',
  'opponent-riichi',
  'all-last',
  'endgame',
  'close-call',
  'big-swing',
  'efficiency-trap',
];

describe('positionTags', () => {
  it('withholds every theme derived from the answer', () => {
    const shown = positionTags(ALL);
    for (const tag of ANSWER_DERIVED_TAGS) {
      expect(shown, `${tag} must wait for an answer`).not.toContain(tag);
    }
  });

  it('keeps everything a solver can read off the board', () => {
    expect(positionTags(ALL)).toEqual([
      'discard',
      'tenpai-choice',
      'two-shanten',
      'wide-choice',
      'open-hand',
      'opponent-riichi',
      'all-last',
      'endgame',
    ]);
  });

  it('leaves order alone, since the header shows the first three', () => {
    expect(positionTags(['close-call', 'endgame', 'open-hand'])).toEqual([
      'endgame',
      'open-hand',
    ]);
  });
});

describe('answerTags', () => {
  it('is exactly what positionTags withheld', () => {
    expect([...positionTags(ALL), ...answerTags(ALL)].sort()).toEqual([...ALL].sort());
    expect(answerTags(ALL)).toEqual(['close-call', 'big-swing', 'efficiency-trap']);
  });

  it('is empty for a position with nothing to reveal', () => {
    expect(answerTags(['discard', 'endgame'])).toEqual([]);
  });
});
