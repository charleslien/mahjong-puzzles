import { BRANCH_LABELS } from '../lib/decision';
import type { Tile } from '../lib/tiles';
import type { ActionBranch } from '../types/puzzle';
import { TileView } from './TileView';

/**
 * The buttons for one step of a multi-step decision.
 *
 * Kept deliberately dumb — which step is showing and what happens next is
 * PuzzleView's business. This only draws a prompt, a row of choices and a way
 * back.
 *
 * Options never name a tile in words; where a choice is about tiles, the tiles
 * are the choice.
 */
export function DecisionSteps({
  prompt,
  branches,
  sets,
  onBranch,
  onSet,
  onBack,
  disabled,
}: {
  prompt: string;
  /** Fork buttons, in fixed order. Absent once a fork has been taken. */
  branches?: ActionBranch[];
  /** Which tiles to eat the call with, when there is more than one way. */
  sets?: Tile[][];
  onBranch?: (branch: ActionBranch) => void;
  onSet?: (consumed: Tile[]) => void;
  /** Undo the previous step. Absent on the first one. */
  onBack?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="choices">
      <p className="choices__prompt">{prompt}</p>
      <div className="choices__actions">
        {branches?.map((branch, index) => (
          <button
            key={branch}
            type="button"
            className="button button--choice"
            onClick={() => onBranch?.(branch)}
            disabled={disabled}
          >
            <kbd className="choice__key">{index + 1}</kbd>
            <span>{BRANCH_LABELS[branch]}</span>
          </button>
        ))}
        {sets?.map((consumed, index) => (
          <button
            key={consumed.join('+')}
            type="button"
            className="button button--choice"
            onClick={() => onSet?.(consumed)}
            disabled={disabled}
          >
            <kbd className="choice__key">{index + 1}</kbd>
            <span className="choice__tiles">
              {consumed.map((tile, i) => (
                <TileView key={`${tile}-${i}`} tile={tile} size="sm" />
              ))}
            </span>
          </button>
        ))}
      </div>
      {onBack && (
        <button type="button" className="button button--small choices__back" onClick={onBack}>
          Back
        </button>
      )}
    </div>
  );
}
