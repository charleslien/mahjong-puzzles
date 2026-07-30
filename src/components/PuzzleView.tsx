import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { GradedAnswer } from '../lib/grade';
import { replayKyoku, snapshotFromPosition, type Snapshot } from '../lib/replay';
import type { Tile } from '../lib/tiles';
import type { Puzzle } from '../types/puzzle';
import { Feedback } from './Feedback';
import { GameBoard } from './GameBoard';

const PROMPTS: Record<Puzzle['kind'], string> = {
  discard: 'Which tile do you discard?',
  // Not "or stay concealed?": the alternative is sometimes backing off the hand
  // entirely, and each option says for itself what it does.
  riichi: 'Do you declare riichi?',
  call: 'Do you call, or let it pass?',
  push_fold: 'Push, or fold?',
  kan: 'Do you call kan?',
  placement: 'What does the placement situation demand?',
};

/**
 * Frames for the hand this puzzle came from, ending at the decision.
 *
 * Puzzles without history fall back to a single frame built from the stored
 * position — which also has to assume the dealer, since a bare position does not
 * record it. Replayed history knows the real dealer, so seat winds are right.
 */
function useFrames(puzzle: Puzzle): Snapshot[] {
  return useMemo(() => {
    if (puzzle.history?.length) {
      const frames = replayKyoku(puzzle.history);
      if (frames.length > 0) return frames;
    }
    return [snapshotFromPosition(puzzle.position)];
  }, [puzzle]);
}

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
  const frames = useFrames(puzzle);
  const decisionFrame = frames.length - 1;
  const [cursor, setCursor] = useState(decisionFrame);
  const [revealAll, setRevealAll] = useState(false);

  // A new puzzle starts at its decision, with opponents concealed again.
  useEffect(() => {
    setCursor(frames.length - 1);
    setRevealAll(false);
  }, [frames]);

  const answered = answer !== undefined;
  const atDecision = cursor === decisionFrame;
  const hasHistory = frames.length > 1;

  const accentFor = (tile: Tile): 'best' | 'good' | 'bad' | undefined => {
    if (!answered || !atDecision) return undefined;
    const action = puzzle.actions.find((candidate) => candidate.tile === tile);
    if (!action) return undefined;
    if (action.id === answer.best.id) return 'best';
    if (action.accepted) return 'good';
    if (action.id === answer.action.id) return 'bad';
    return undefined;
  };

  const onTile = (tile: Tile): void => {
    if (answered || !atDecision || puzzle.kind !== 'discard') return;
    const action = puzzle.actions.find((candidate) => candidate.tile === tile);
    if (action) onAnswer(action.id);
  };

  const frame = frames[Math.min(cursor, frames.length - 1)];

  const stepBack = useCallback(() => setCursor((current) => Math.max(0, current - 1)), []);
  const stepForward = useCallback(
    () => setCursor((current) => Math.min(decisionFrame, current + 1)),
    [decisionFrame],
  );
  const toStart = useCallback(() => setCursor(0), []);
  const toDecision = useCallback(() => setCursor(decisionFrame), [decisionFrame]);

  // Held in a ref so the listener can stay mounted once rather than rebinding on
  // every cursor change.
  const handlers = useRef({ stepBack, stepForward, toStart, toDecision, onNext, answered });
  handlers.current = { stepBack, stepForward, toStart, toDecision, onNext, answered };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      // Leave form controls alone; the scrubber uses arrows itself.
      if (target && ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(target.tagName)) return;

      const current = handlers.current;
      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault();
          current.stepBack();
          break;
        case 'ArrowRight':
          event.preventDefault();
          current.stepForward();
          break;
        case 'Home':
          event.preventDefault();
          current.toStart();
          break;
        case 'End':
        case 'Escape':
          event.preventDefault();
          current.toDecision();
          break;
        case 'Enter':
        case ' ':
          // Only advances once the puzzle is answered, so a stray press cannot
          // skip a puzzle unsolved.
          if (current.answered) {
            event.preventDefault();
            current.onNext();
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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
        snapshot={frame}
        viewer={puzzle.position.seat}
        // Opponents stay concealed until the puzzle is answered; revealing them
        // beforehand would hand over the information the puzzle is about.
        revealAll={answered && revealAll}
        interactive={!answered && atDecision && puzzle.kind === 'discard'}
        onSelect={onTile}
        accentFor={accentFor}
      />

      {hasHistory && (
        <div className="history">
          <div className="history__head">
            <h2 className="history__title">Review this hand</h2>
            <span className="history__count">
              move {cursor + 1} of {frames.length}
            </span>
          </div>

          <div className="history__controls">
            <button
              type="button"
              className="button"
              onClick={toStart}
              disabled={cursor === 0}
              title="Home"
            >
              ⏮ Start
            </button>
            <button
              type="button"
              className="button"
              onClick={stepBack}
              disabled={cursor === 0}
              title="Left arrow"
            >
              ◀ Back
            </button>
            <button
              type="button"
              className="button"
              onClick={stepForward}
              disabled={atDecision}
              title="Right arrow"
            >
              Forward ▶
            </button>
            <button
              type="button"
              className={`button ${atDecision ? '' : 'button--primary'}`}
              onClick={toDecision}
              disabled={atDecision}
              title="End or Escape"
            >
              ⏭ Back to the decision
            </button>
          </div>

          <input
            className="history__scrub"
            type="range"
            min={0}
            max={decisionFrame}
            value={cursor}
            onChange={(event) => setCursor(Number(event.target.value))}
            aria-label="Position in the hand"
          />

          <p className="history__keys">
            <kbd>←</kbd> <kbd>→</kbd> step · <kbd>Home</kbd> start ·{' '}
            <kbd>Esc</kbd> decision{answered ? ' · ' : ''}
            {answered && (
              <>
                <kbd>Enter</kbd> next puzzle
              </>
            )}
          </p>

          <p className="history__line">
            {atDecision ? (
              <>
                <strong>You are at the decision.</strong> Step back to see how the hand got here —
                opponents' hands stay hidden until you answer.
              </>
            ) : (
              <>
                <strong>{frame.description}</strong> — reviewing history. Return to the decision to
                answer.
              </>
            )}
          </p>

          {answered && (
            <label className="field field--check">
              <input
                type="checkbox"
                checked={revealAll}
                onChange={(event) => setRevealAll(event.target.checked)}
              />
              <span>Reveal all hands</span>
            </label>
          )}
        </div>
      )}

      <section className="puzzle__decision">
        <h2 className="puzzle__prompt">{PROMPTS[puzzle.kind]}</h2>

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
          <p className="puzzle__hint">
            {atDecision
              ? 'Click a tile in your hand, at the bottom of the table.'
              : 'Return to the decision to answer.'}
          </p>
        )}
      </section>

      {answer && <Feedback puzzle={puzzle} answer={answer} onNext={onNext} />}
    </article>
  );
}
