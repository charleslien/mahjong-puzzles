/**
 * Grading. Answers are scored by loss against the best action rather than by
 * exact-match, because mahjong positions routinely have several defensible
 * answers.
 *
 * Cross-entropy against the policy is a good aggregate diagnostic and a good
 * mining signal, but it is a poor per-puzzle grade: it is unbounded and it
 * punishes picking the second of two near-identical options. Bucketed loss is
 * bounded, interpretable, and matches how mahjong reviewers already talk.
 *
 * Thresholds are per-unit. A placement-point loss and a tiles-of-acceptance
 * loss are not comparable quantities, so each gets its own scale.
 */

import type { EvalUnit, Puzzle, PuzzleAction } from '../types/puzzle';

export type Grade = 'optimal' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';

/**
 * Upper bound of loss for each grade, keyed by unit.
 *
 * The placement-point bounds are calibrated against the distribution akochan
 * actually produces, measured over 2,889 non-accepted actions in the mined bank:
 * median loss 4.2 points, p75 8.1, p90 13.2. They were originally guessed at
 * 0.5/1.2/3.0, which put 62% of every wrong answer in "blunder" and made the
 * scale useless — the guess assumed placement-point losses would be small, and
 * they are not. These bounds spread the same population roughly evenly.
 *
 * Note the two units are on genuinely different scales and neither is a rescaling
 * of the other: a shanten regression is worth a fixed penalty in tiles, while
 * akochan prices folding correctly as a *gain*.
 */
const THRESHOLDS: Record<EvalUnit, Array<{ grade: Grade; maxLoss: number }>> = {
  placement_pt: [
    { grade: 'good', maxLoss: 2.0 },
    { grade: 'inaccuracy', maxLoss: 5.0 },
    { grade: 'mistake', maxLoss: 12.0 },
  ],
  ukeire_tiles: [
    { grade: 'good', maxLoss: 2 },
    { grade: 'inaccuracy', maxLoss: 5 },
    { grade: 'mistake', maxLoss: 10 },
  ],
};

export const GRADE_LABELS: Record<Grade, string> = {
  optimal: 'Optimal',
  good: 'Good',
  inaccuracy: 'Inaccuracy',
  mistake: 'Mistake',
  blunder: 'Blunder',
};

export const UNIT_LABELS: Record<EvalUnit, string> = {
  placement_pt: 'placement pt',
  ukeire_tiles: 'tiles',
};

/**
 * What the unit means, for a solver who has not read the About page.
 *
 * The panel prints "−6.84 placement pt" and nothing on the page said what a
 * placement point was — which is the one number the whole site is denominated
 * in, and the reason folding is sometimes right.
 */
export const UNIT_EXPLANATIONS: Record<EvalUnit, string> = {
  placement_pt:
    'Expected final placement points: what a choice is worth in the standings ' +
    'at the end of the game, not just in this hand. Tenhou houou uma, +90 / +45 / 0 / −135.',
  ukeire_tiles: 'Tiles of acceptance: how many unseen tiles improve the hand.',
};

export interface GradedAnswer {
  action: PuzzleAction;
  grade: Grade;
  /** Whether this counts as a correct solve for streak purposes. */
  correct: boolean;
  /** 0..100, for progress display. */
  score: number;
  /** The best action, for showing what was missed. */
  best: PuzzleAction;
}

export function bestAction(puzzle: Puzzle): PuzzleAction {
  let best = puzzle.actions[0];
  for (const action of puzzle.actions) {
    if (action.ev > best.ev) best = action;
  }
  return best;
}

export function gradeForLoss(loss: number, accepted: boolean, unit: EvalUnit): Grade {
  if (accepted) return 'optimal';
  for (const { grade, maxLoss } of THRESHOLDS[unit]) {
    if (loss <= maxLoss) return grade;
  }
  return 'blunder';
}

/**
 * Partial credit decays with loss and bottoms out at zero once the loss reaches
 * the blunder threshold, so a near-miss still registers as progress.
 */
function scoreForLoss(loss: number, accepted: boolean, unit: EvalUnit): number {
  if (accepted) return 100;
  const scale = THRESHOLDS[unit];
  const blunderThreshold = scale[scale.length - 1].maxLoss;
  const remaining = Math.max(0, 1 - loss / blunderThreshold);
  return Math.round(remaining * 90);
}

export function gradeAnswer(puzzle: Puzzle, actionId: string): GradedAnswer {
  const action = puzzle.actions.find((candidate) => candidate.id === actionId);
  if (!action) throw new Error(`unknown action for puzzle ${puzzle.id}: ${actionId}`);

  const unit = puzzle.evaluation.unit;
  const accepted = puzzle.acceptedActionIds.includes(actionId);
  return {
    action,
    grade: gradeForLoss(action.loss, accepted, unit),
    correct: accepted,
    score: scoreForLoss(action.loss, accepted, unit),
    best: bestAction(puzzle),
  };
}

/** Format a placement-point loss for display, e.g. "−1.20 placement pt". */
export function formatLoss(loss: number, unit: EvalUnit): string {
  if (loss <= 0) return '—';
  const magnitude = unit === 'ukeire_tiles' ? String(Math.round(loss)) : loss.toFixed(2);
  return `−${magnitude} ${UNIT_LABELS[unit]}`;
}

/**
 * Describe what an action actually costs, in terms that are true.
 *
 * For efficiency puzzles the grading scalar is a composite that prices a shanten
 * regression at a large fixed penalty, so printing it as a tile count would be a
 * lie. When an action worsens shanten, say so; only report an acceptance gap
 * between actions that reach the same shanten.
 *
 * Placement points have no such problem — akochan really does price a regression
 * at the figure it reports — so the number is shown, with the regression noted
 * alongside it. That the hand went backwards is the more useful fact, and unlike
 * the efficiency case it is not the *whole* story: folding into a threat costs
 * shanten and can still be the best action available.
 */
export function describeLoss(
  action: Pick<PuzzleAction, 'loss' | 'shantenAfter'>,
  unit: EvalUnit,
  bestShanten?: number,
): string {
  if (action.loss <= 0) return 'best';

  const regression =
    bestShanten !== undefined && action.shantenAfter !== undefined
      ? action.shantenAfter - bestShanten
      : 0;

  if (unit === 'ukeire_tiles') {
    if (regression > 0) {
      return regression === 1 ? '−1 shanten' : `−${regression} shanten`;
    }
    return `−${Math.round(action.loss)} tiles`;
  }

  if (regression > 0) {
    return `${formatLoss(action.loss, unit)}, −${regression} shanten`;
  }
  return formatLoss(action.loss, unit);
}

/**
 * Cross-entropy of the solver's choices against the imitation policy, in nats.
 * Reported as a session-level diagnostic — lower means play closer to the
 * houou-level distribution the policy was trained on. Actions without a policy
 * probability are skipped.
 */
export function policyCrossEntropy(choices: Array<{ policy?: number }>): number | undefined {
  const scored = choices.filter((choice) => typeof choice.policy === 'number');
  if (scored.length === 0) return undefined;

  const floor = 1e-4;
  const total = scored.reduce(
    (sum, choice) => sum - Math.log(Math.max(choice.policy as number, floor)),
    0,
  );
  return total / scored.length;
}
