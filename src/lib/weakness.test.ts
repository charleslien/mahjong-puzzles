/**
 * Tests for the theme breakdown.
 *
 * Two rules carry the weight and both are about not inventing a finding: a
 * theme needs enough positions behind it to mean anything, and a review drill
 * must not score the same miss twice.
 */

import { describe, expect, it } from 'vitest';

import type { AttemptRecord } from './progress';
import { MIN_ATTEMPTS, firstAttempts, themeBreakdown, themeLabel } from './weakness';
import type { Puzzle } from '../types/puzzle';

function puzzle(id: string, kind: Puzzle['kind'], tags: string[]): Puzzle {
  return {
    id,
    schemaVersion: 1,
    kind,
    tags,
    difficulty: 50,
    position: {} as Puzzle['position'],
    actions: [],
    acceptedActionIds: [],
    evaluation: {
      evaluators: ['akochan'],
      margin: 1,
      agreement: true,
      epsilon: 0.15,
      unit: 'placement_pt',
    },
    source: { dataset: 'test', authored: false },
  } as unknown as Puzzle;
}

function attempt(puzzleId: string, loss: number, at: number): AttemptRecord {
  return {
    puzzleId,
    actionId: 'discard:1m',
    grade: loss === 0 ? 'optimal' : 'mistake',
    score: 0,
    loss,
    at,
  };
}

/** `count` positions on one theme, each given up `loss` points. */
function run(kind: Puzzle['kind'], tags: string[], count: number, loss: number) {
  const puzzles = new Map<string, Puzzle>();
  const attempts: AttemptRecord[] = [];
  for (let index = 0; index < count; index++) {
    const id = `${kind}-${tags.join('.')}-${index}`;
    puzzles.set(id, puzzle(id, kind, tags));
    attempts.push(attempt(id, loss, 1000 + index));
  }
  return { puzzles, attempts };
}

describe('firstAttempts', () => {
  it('keeps the earliest attempt at each puzzle', () => {
    const kept = firstAttempts([attempt('a', 6, 200), attempt('a', 0, 100), attempt('b', 3, 300)]);
    expect(kept.map((a) => [a.puzzleId, a.at])).toEqual([
      ['a', 100],
      ['b', 300],
    ]);
  });
});

describe('themeBreakdown', () => {
  it('ranks themes by the points they cost, worst first', () => {
    const calls = run('call', ['call'], 6, 4);
    const discards = run('discard', ['discard'], 6, 1);
    const puzzles = new Map([...calls.puzzles, ...discards.puzzles]);
    const themes = themeBreakdown([...calls.attempts, ...discards.attempts], puzzles);

    expect(themes.map((theme) => theme.tag)).toEqual(['call', 'discard']);
    expect(themes[0].meanLoss).toBe(4);
    expect(themes[0].totalLoss).toBe(24);
    expect(themes[0].attempts).toBe(6);
  });

  it('withholds a theme with too few positions behind it', () => {
    // One blundered call is not a finding about a solver.
    const thin = run('call', ['call'], MIN_ATTEMPTS - 1, 12);
    expect(themeBreakdown(thin.attempts, thin.puzzles)).toEqual([]);
  });

  it('counts a position toward every theme it carries', () => {
    const { puzzles, attempts } = run('discard', ['discard', 'endgame', 'opponent-riichi'], 5, 2);
    const themes = themeBreakdown(attempts, puzzles);
    expect(themes.map((theme) => theme.tag).sort()).toEqual([
      'discard',
      'endgame',
      'opponent-riichi',
    ]);
    // Shares deliberately do not sum to one: one hand really is all three.
    expect(themes.every((theme) => theme.attempts === 5)).toBe(true);
  });

  it('does not score a reviewed miss twice', () => {
    const { puzzles, attempts } = run('call', ['call'], 5, 8);
    // The solver reviews all five and gets them right the second time.
    const reviewed = attempts.map((a) => ({ ...a, loss: 0, grade: 'optimal' as const, at: a.at + 9000 }));
    const themes = themeBreakdown([...attempts, ...reviewed], puzzles);
    expect(themes[0].attempts).toBe(5);
    expect(themes[0].meanLoss).toBe(8);
    expect(themes[0].optimal).toBe(0);
  });

  it('ignores attempts whose puzzle has left the bank', () => {
    const { puzzles, attempts } = run('discard', ['discard'], 5, 2);
    const orphan = attempt('gone', 30, 1);
    expect(themeBreakdown([...attempts, orphan], puzzles)[0].attempts).toBe(5);
  });

  it('treats a negative loss as nothing given up', () => {
    // Accepted actions can sit a hair above the best action's value.
    const { puzzles, attempts } = run('discard', ['discard'], 5, -0.2);
    expect(themeBreakdown(attempts, puzzles)[0].meanLoss).toBe(0);
  });
});

describe('themeLabel', () => {
  it('reads a kebab-case tag as prose', () => {
    expect(themeLabel('opponent-riichi')).toBe('opponent riichi');
  });
});
