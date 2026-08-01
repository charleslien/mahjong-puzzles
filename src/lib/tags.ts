/**
 * Which themes may be shown while the question is still open.
 *
 * Most tags describe the position: whose hand is open, who has declared, how
 * close the wall is to running out. A solver can read all of that off the board,
 * so naming it costs nothing.
 *
 * Three are computed from the *answer*, and one of them is very nearly an answer
 * key. `efficiency-trap` marks the positions where the tile pure efficiency picks
 * is not the tile akochan picks — so its absence says the obvious play is right.
 * Measured over the 942 discard puzzles in the shipped bank:
 *
 *   - without the chip: the efficiency pick is an accepted answer in 815 of 815
 *   - with the chip:    the efficiency pick is wrong in 106 of 127 (83.5%)
 *
 * Computing the efficiency pick is the baseline skill this site is for, so the
 * chip row turned "which tile is best" into "does the chip row say trap". That is
 * the same failure as the `declared` / `called` chips that used to sit above the
 * board and predicted the branch in 713 of 713 puzzles — a tag derived from the
 * answer, rendered before it.
 *
 * `close-call` and `big-swing` come from the margin. They do not say which action
 * wins, only by how much, so they leak far less — but they are still facts about
 * the answer, and there is no reason to treat them differently.
 *
 * None of this is a reason to stop *storing* them. They are how the theme drill
 * finds positions, and after an answer they are exactly the framing a solver
 * wants. Choosing to drill traps is the solver's own hint to take; a chip they
 * did not ask for is not.
 */
export const ANSWER_DERIVED_TAGS: ReadonlySet<string> = new Set([
  'efficiency-trap',
  'close-call',
  'big-swing',
]);

/** Themes safe to show beside an unanswered position. */
export function positionTags(tags: readonly string[]): string[] {
  return tags.filter((tag) => !ANSWER_DERIVED_TAGS.has(tag));
}

/** Themes that describe the answer, so they wait for one. */
export function answerTags(tags: readonly string[]): string[] {
  return tags.filter((tag) => ANSWER_DERIVED_TAGS.has(tag));
}
