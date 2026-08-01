import type { AttemptRecord } from './progress';
import type { PuzzleTheme } from './puzzleSource';

/**
 * What a solver's history says about which positions cost them points.
 *
 * The progress panel could already say how often you were right. It could not
 * say what you were wrong *about*, which is the only part of a history that
 * tells you what to practise next — and the puzzles carry the themes needed to
 * answer it, so the data was there and simply unused.
 *
 * The figure that ranks themes is the mean placement points given up per
 * position, not the share answered optimally. Accuracy treats a 0.5-point
 * inaccuracy and a 12-point blunder as the same event, and the whole bank is
 * built and graded in placement points, so this is the unit the site already
 * means everywhere else.
 */
export interface Theme {
  tag: string;
  attempts: number;
  optimal: number;
  /** Mean placement points given up per position. */
  meanLoss: number;
  /** What the theme has cost in total, which is mean × attempts. */
  totalLoss: number;
}

/**
 * Below this many positions a mean is noise dressed as a finding.
 *
 * One blundered call would otherwise put "call" at the top of a list headed
 * "where you lose points", which is a claim about a solver made from a single
 * hand.
 */
export const MIN_ATTEMPTS = 5;

/**
 * First attempts only, keyed by puzzle.
 *
 * A review drill replays exactly the positions you got wrong, so counting every
 * attempt would score those themes twice — once for the miss and again for the
 * corrected repeat, which is no longer a measurement of anything. It is also how
 * the server rates: only a solver's first attempt at a puzzle counts.
 */
export function firstAttempts(attempts: AttemptRecord[]): AttemptRecord[] {
  const first = new Map<string, AttemptRecord>();
  for (const attempt of attempts) {
    const held = first.get(attempt.puzzleId);
    if (!held || attempt.at < held.at) first.set(attempt.puzzleId, attempt);
  }
  return [...first.values()];
}

/**
 * Themes ranked by what they cost, worst first.
 *
 * A position counts toward every theme it carries, so the shares do not sum to
 * one — a hand can be an endgame discard against a riichi, and it is all three.
 */
export function themeBreakdown(
  attempts: AttemptRecord[],
  puzzles: Map<string, PuzzleTheme>,
  minAttempts: number = MIN_ATTEMPTS,
): Theme[] {
  const totals = new Map<string, { attempts: number; optimal: number; loss: number }>();

  for (const attempt of firstAttempts(attempts)) {
    const puzzle = puzzles.get(attempt.puzzleId);
    // A puzzle that has left the bank takes its themes with it. Its attempt
    // still counts in the overall figures above; it just cannot be attributed.
    if (!puzzle) continue;
    // `kind` is already the first tag, so a Set is what keeps it from being
    // counted twice if that ever stops being true.
    for (const tag of new Set([puzzle.kind, ...puzzle.tags])) {
      const row = totals.get(tag) ?? { attempts: 0, optimal: 0, loss: 0 };
      row.attempts += 1;
      if (attempt.grade === 'optimal') row.optimal += 1;
      row.loss += Math.max(0, attempt.loss);
      totals.set(tag, row);
    }
  }

  return [...totals.entries()]
    .filter(([, row]) => row.attempts >= minAttempts)
    .map(([tag, row]) => ({
      tag,
      attempts: row.attempts,
      optimal: row.optimal,
      meanLoss: row.loss / row.attempts,
      totalLoss: row.loss,
    }))
    .sort((a, b) => b.meanLoss - a.meanLoss || b.attempts - a.attempts);
}

/** A tag as it reads in prose. Themes are kebab-case in the bank. */
export function themeLabel(tag: string): string {
  return tag.replace(/-/g, ' ');
}
