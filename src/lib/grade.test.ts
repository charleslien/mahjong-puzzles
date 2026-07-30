/**
 * Grading tests.
 *
 * The thresholds are a judgement call, but two properties are not: the buckets
 * must be ordered, and they must actually discriminate on the loss distribution
 * the evaluator produces. The placement-point scale was originally guessed and
 * put 62% of all wrong answers in "blunder", so the calibration is pinned here.
 */

import { describe, expect, it } from 'vitest';

import { GRADE_LABELS, UNIT_LABELS, formatLoss, gradeForLoss } from './grade';
import type { EvalUnit } from '../types/puzzle';

const UNITS: EvalUnit[] = ['placement_pt', 'ukeire_tiles'];

describe('gradeForLoss', () => {
  it('calls any accepted action optimal, whatever it lost', () => {
    for (const unit of UNITS) {
      // An action inside the accept band is correct by construction; the residual
      // loss is noise between near-identical options.
      expect(gradeForLoss(0, true, unit)).toBe('optimal');
      expect(gradeForLoss(0.14, true, unit)).toBe('optimal');
    }
  });

  it('degrades monotonically with loss', () => {
    const order = ['optimal', 'good', 'inaccuracy', 'mistake', 'blunder'];
    for (const unit of UNITS) {
      let previous = 0;
      for (const loss of [0, 1, 2, 4, 6, 11, 13, 40, 200]) {
        const rank = order.indexOf(gradeForLoss(loss, false, unit));
        expect(rank, `${unit} at loss ${loss}`).toBeGreaterThanOrEqual(previous);
        previous = rank;
      }
    }
  });

  it('spreads real placement-point losses across every bucket', () => {
    // Deciles of the measured distribution over the mined bank (median 4.2,
    // p75 8.1, p90 13.2). A scale that lumps these into one grade is useless
    // even if every individual verdict looks defensible.
    const measured = [1.0, 1.5, 2.0, 3.1, 4.2, 5.4, 6.9, 8.1, 10.4, 13.2, 20.0];
    const grades = new Set(measured.map((loss) => gradeForLoss(loss, false, 'placement_pt')));
    expect(grades.size).toBeGreaterThanOrEqual(4);
    // And no single bucket may swallow most of it.
    for (const grade of grades) {
      const share =
        measured.filter((loss) => gradeForLoss(loss, false, 'placement_pt') === grade).length /
        measured.length;
      expect(share, `${grade} holds ${Math.round(share * 100)}% of the distribution`).toBeLessThan(
        0.6,
      );
    }
  });

  it('treats a large loss as a blunder in both units', () => {
    for (const unit of UNITS) {
      expect(gradeForLoss(1000, false, unit)).toBe('blunder');
    }
  });
});

describe('formatLoss', () => {
  it('shows a dash when nothing was lost', () => {
    for (const unit of UNITS) expect(formatLoss(0, unit)).toBe('—');
  });

  it('rounds tiles to whole tiles and keeps placement points precise', () => {
    // Half a tile of acceptance does not exist.
    expect(formatLoss(4.4, 'ukeire_tiles')).toBe('−4 tiles');
    expect(formatLoss(4.4, 'placement_pt')).toBe('−4.40 placement pt');
  });

  it('labels every unit and grade', () => {
    for (const unit of UNITS) expect(UNIT_LABELS[unit]).toBeTruthy();
    for (const label of Object.values(GRADE_LABELS)) expect(label).toBeTruthy();
  });
});
