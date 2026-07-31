import type { ReactNode } from 'react';

import type { Tile } from '../lib/tiles';
import { TileView } from './TileView';

/**
 * A multi-step decision, shown as a chain rather than a sequence of dialogs.
 *
 * Every step the solver has reached stays on screen with its answer marked, so
 * the shape of what they have committed to is readable at a glance and any part
 * of it can be changed by clicking a different option. The first version
 * replaced each step with the next one and offered a Back button, which made a
 * three-step call feel like a wizard: you could not see what you had chosen, and
 * revising the first choice meant unwinding the others by hand.
 *
 * Choosing an earlier step again resets whatever depended on it — picking a
 * different call clears the set that was chosen for the old one, because it is
 * not a set of the new one.
 *
 * Options never name a tile in words; where a choice is about tiles, the tiles
 * are the choice.
 */
export interface StepOption {
  /** Stable within its step, and what `selected` is compared against. */
  id: string;
  label?: string;
  tiles?: Tile[];
}

export interface Step {
  key: string;
  prompt: string;
  options: StepOption[];
  /** Id of the option already taken, if any. */
  selected?: string;
  onPick: (id: string) => void;
}

export function DecisionSteps({
  steps,
  hint,
  disabled,
}: {
  steps: Step[];
  /** The closing instruction, once every button-answered step is settled. */
  hint?: ReactNode;
  disabled?: boolean;
}) {
  // The keyboard shortcut addresses the deepest step still open, which is the
  // one a solver is actually being asked. Numbering every visible step would
  // need modifiers to disambiguate.
  const active = steps.findIndex((step) => step.selected === undefined);

  return (
    <div className="choices">
      {steps.map((step, index) => (
        <div className="choices__step" key={step.key}>
          <p className="choices__prompt">{step.prompt}</p>
          <div className="choices__actions">
            {step.options.map((option, position) => {
              const on = step.selected === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  className={`button button--choice${on ? ' button--choice-on' : ''}`}
                  aria-pressed={on}
                  onClick={() => step.onPick(option.id)}
                  disabled={disabled}
                >
                  {index === active && <kbd className="choice__key">{position + 1}</kbd>}
                  {option.label && <span>{option.label}</span>}
                  {option.tiles && (
                    <span className="choice__tiles">
                      {option.tiles.map((tile, i) => (
                        <TileView key={`${tile}-${i}`} tile={tile} size="sm" />
                      ))}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {hint && (
        <p className="choices__prompt choices__prompt--hint" aria-live="polite">
          {hint}
        </p>
      )}
    </div>
  );
}
