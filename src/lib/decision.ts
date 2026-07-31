import type { ActionBranch, PuzzleAction } from '../types/puzzle';
import type { Tile } from './tiles';

/**
 * Walking a decision that has more than one step.
 *
 * A riichi or call puzzle is a *line*: declare or not and then which tile, or
 * call or not and then with which tiles and then what to throw. The bank stores
 * every line as its own action, and this module turns that flat list back into
 * the sequence a player meets at the table.
 *
 * Presentation order here is fixed and never derived from value. The options are
 * shown before the puzzle is answered, so ordering them by expected value would
 * put the answer first every time.
 */

const BRANCH_ORDER: ActionBranch[] = ['riichi', 'dama', 'chi', 'pon', 'daiminkan', 'pass'];

/**
 * The verb, without a tile in it.
 *
 * "Chi" rather than "Call chi with 2 bamboo and 3 bamboo": the tiles are shown
 * as tiles, next to the word, wherever this label appears.
 */
export const BRANCH_LABELS: Record<ActionBranch, string> = {
  riichi: 'Riichi',
  dama: 'No riichi',
  chi: 'Chi',
  pon: 'Pon',
  daiminkan: 'Kan',
  pass: 'Let it pass',
};

/** Identity of a call's consumed set, stable across orderings. */
export function consumedKey(consumed: Tile[] | undefined): string {
  return [...(consumed ?? [])].sort().join('+');
}

/** True when this puzzle is asked as a sequence rather than as a single discard. */
export function isMultiStep(actions: PuzzleAction[]): boolean {
  return actions.some((action) => action.branch !== undefined);
}

/** The forks available, in fixed presentation order. */
export function branchesOf(actions: PuzzleAction[]): ActionBranch[] {
  const present = new Set(actions.map((action) => action.branch).filter(Boolean));
  return BRANCH_ORDER.filter((branch) => present.has(branch));
}

/** The lines that take `branch`, optionally narrowed to one consumed set. */
export function linesIn(
  actions: PuzzleAction[],
  branch: ActionBranch,
  consumed?: Tile[],
): PuzzleAction[] {
  const key = consumed ? consumedKey(consumed) : undefined;
  return actions.filter(
    (action) =>
      action.branch === branch &&
      (key === undefined || consumedKey(action.consumed) === key),
  );
}

/**
 * The distinct sets a call could eat, sorted by their tiles.
 *
 * Two sets can differ only in which copy of a five they use, and that is a real
 * choice rather than a duplicate: eating the red one hands over a dora.
 */
export function consumedSets(actions: PuzzleAction[], branch: ActionBranch): Tile[][] {
  const sets = new Map<string, Tile[]>();
  for (const action of actions) {
    if (action.branch !== branch || !action.consumed?.length) continue;
    sets.set(consumedKey(action.consumed), action.consumed);
  }
  return [...sets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, tiles]) => tiles);
}

/** Tiles a line in this branch is allowed to discard. */
export function legalTiles(
  actions: PuzzleAction[],
  branch: ActionBranch,
  consumed?: Tile[],
): Set<Tile> {
  return new Set(
    linesIn(actions, branch, consumed)
      .map((action) => action.tile)
      .filter((tile): tile is Tile => tile !== undefined),
  );
}
