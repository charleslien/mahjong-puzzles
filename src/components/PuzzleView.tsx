import { useMemo } from 'react';
import type { GradedAnswer } from '../lib/grade';
import { snapshotFromPosition } from '../lib/replay';
import type { Tile } from '../lib/tiles';
import type { Puzzle } from '../types/puzzle';
import { Feedback } from './Feedback';
import { GameBoard } from './GameBoard';

const PROMPTS: Record<Puzzle['kind'], string> = {
  discard: 'Which tile do you discard?',
  riichi: 'Declare riichi, or stay concealed?',
  call: 'Do you call, or let it pass?',
  push_fold: 'Push, or fold?',
  kan: 'Do you call kan?',
  placement: 'What does the placement situation demand?',
};

export function PuzzleView({
  puzzle,
  answer,
  onAnswer,
  onNext,
  index,
  total,
}: {
  puzzle: Puzzle;
  answer?: GradedAnswer;
  onAnswer: (actionId: string) => void;
  onNext: () => void;
  index: number;
  total: number;
}) {
  const answered = answer !== undefined;
  const snapshot = useMemo(() => snapshotFromPosition(puzzle.position), [puzzle.position]);

  // After answering, every tile carries a verdict stripe.
  const accentFor = (tile: Tile): 'best' | 'good' | 'bad' | undefined => {
    if (!answered) return undefined;
    const action = puzzle.actions.find((candidate) => candidate.tile === tile);
    if (!action) return undefined;
    if (action.id === answer.best.id) return 'best';
    if (action.accepted) return 'good';
    if (action.id === answer.action.id) return 'bad';
    return undefined;
  };

  const onTile = (tile: Tile): void => {
    if (answered || puzzle.kind !== 'discard') return;
    const action = puzzle.actions.find((candidate) => candidate.tile === tile);
    if (action) onAnswer(action.id);
  };

  return (
    <article className="puzzle">
      <header className="puzzle__head">
        <div className="puzzle__meta">
          <span className="puzzle__counter">
            {index + 1} / {total}
          </span>
          <span className="puzzle__id">{puzzle.id}</span>
          {puzzle.tags.map((tag) => (
            <span key={tag} className="tag">
              {tag}
            </span>
          ))}
        </div>
        <span className="puzzle__difficulty" title="Model-derived difficulty proxy, 0–100">
          difficulty {puzzle.difficulty}
        </span>
      </header>

      <GameBoard
        snapshot={snapshot}
        viewer={puzzle.position.seat}
        interactive={!answered && puzzle.kind === 'discard'}
        onSelect={onTile}
        accentFor={accentFor}
      />

      <section className="puzzle__decision">
        <h2 className="puzzle__prompt">{PROMPTS[puzzle.kind]}</h2>

        {/* Non-discard decisions are answered with verbs rather than tiles. */}
        {puzzle.kind !== 'discard' && !answered && (
          <div className="actionbar">
            {puzzle.actions.map((action) => (
              <button
                key={action.id}
                type="button"
                className="button"
                onClick={() => onAnswer(action.id)}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}

        {!answered && puzzle.kind === 'discard' && (
          <p className="puzzle__hint">Click a tile in your hand, at the bottom of the table.</p>
        )}
      </section>

      {answer && <Feedback puzzle={puzzle} answer={answer} onNext={onNext} />}
    </article>
  );
}
