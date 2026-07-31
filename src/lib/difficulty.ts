/**
 * The difficulty bands, in one place.
 *
 * `difficulty` is a 0–100 proxy computed offline from the EV margin, the policy
 * entropy and whether a naive efficiency baseline fails. It is not a percentile
 * and it does not use the whole range: measured over the shipped bank it runs
 * from 20 to 75, clustered around the low 40s, because the publication rules
 * already throw out the positions that would score at either extreme — anything
 * too close to call is rejected by the margin test, and anything obvious has a
 * wide margin.
 *
 * So the band edges are calibrated against that measured distribution rather
 * than spaced evenly across 0–100. Spaced evenly (0–40 / 41–65 / 66–100) they
 * put 48% of the bank in Easy, 50% in Medium and **2% in Hard** — a filter
 * whose most interesting setting returned a pool small enough to repeat within
 * one session. `puzzleBank.test.ts` checks the split against the bank on disk,
 * so a regeneration that skews the proxy fails rather than quietly emptying a
 * band again.
 */
export interface DifficultyBand {
  id: 'all' | 'easy' | 'medium' | 'hard';
  label: string;
  min: number;
  max: number;
}

export const DIFFICULTY_BANDS: DifficultyBand[] = [
  { id: 'all', label: 'All', min: 0, max: 100 },
  { id: 'easy', label: 'Easy', min: 0, max: 33 },
  { id: 'medium', label: 'Medium', min: 34, max: 46 },
  { id: 'hard', label: 'Hard', min: 47, max: 100 },
];

/** The band a puzzle falls in, for the label shown beside it. */
export function difficultyWord(difficulty: number): string {
  const band = DIFFICULTY_BANDS.find(
    (candidate) =>
      candidate.id !== 'all' && difficulty >= candidate.min && difficulty <= candidate.max,
  );
  return band?.label ?? 'Medium';
}
