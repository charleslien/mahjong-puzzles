import type { Tile } from '../lib/tiles';
import { TileView } from './TileView';

/**
 * A multi-step decision, shown as a chain rather than a sequence of dialogs.
 *
 * Every step the puzzle can reach is on screen from the start, with its answer
 * marked once given and every option still clickable, so the shape of what has
 * been committed to is readable and any part of it can be changed by picking
 * something else. Choosing an earlier step again resets whatever depended on it
 * — picking a different call clears the set chosen for the old one, because it
 * is not a set of the new one.
 *
 * **Nothing here moves.** A step that has not been reached yet is an empty row
 * of the same height rather than an absent one, so the buttons sit where they
 * will still be three clicks later. The first version grew as you walked it,
 * which moved the fork buttons and the hand under the cursor between clicks.
 *
 * There are no prompts. "Do you call, or let it pass?" above two buttons
 * reading Chi and Pass, and "And which tile do you discard?" above a hand with
 * the illegal tiles greyed out, both restated what the controls underneath
 * already showed — and each was a line of text that appeared and disappeared as
 * the decision was walked. The prompt survives as the group's accessible name.
 *
 * Options never name a tile in words; where a choice is about tiles, the tiles
 * are the choice.
 */
export interface StepOption {
  /** Stable within its step, and what `selected` is compared against. */
  id: string;
  label?: string;
  tiles?: Tile[];
  /**
   * Whether taking this option leads to another choice rather than answering.
   *
   * Marked on the button, because a solver walking a call has no other way to
   * tell which click submits.
   */
  continues?: boolean;
}

export interface Step {
  key: string;
  /** The group's accessible name. Not rendered. */
  prompt: string;
  /** Empty while the step is out of reach; the row stays, so nothing moves. */
  options: StepOption[];
  /** Id of the option already taken, if any. */
  selected?: string;
  onPick: (id: string) => void;
}

export function DecisionSteps({
  steps,
  disabled,
}: {
  steps: Step[];
  disabled?: boolean;
}) {
  return (
    <div className="choices">
      {steps.map((step) => (
        <div
          className="choices__step"
          key={step.key}
          role="group"
          aria-label={step.prompt}
        >
          {step.options.map((option) => {
            const on = step.selected === option.id;
            return (
              <button
                key={option.id}
                type="button"
                className={`button button--choice${on ? ' button--choice-on' : ''}`}
                aria-pressed={on}
                onClick={() => step.onPick(option.id)}
                disabled={disabled}
                title={option.continues ? 'There is more to choose after this' : 'Answers the puzzle'}
              >
                {option.label && <span>{option.label}</span>}
                {option.tiles && (
                  <span className="choice__tiles">
                    {option.tiles.map((tile, i) => (
                      <TileView key={`${tile}-${i}`} tile={tile} size="sm" />
                    ))}
                  </span>
                )}
                {option.continues && (
                  <span className="choice__more" aria-hidden="true">
                    ›
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
