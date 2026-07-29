import { useMemo } from 'react';
import type { GradedAnswer } from '../lib/grade';
import { sortTiles, type Tile } from '../lib/tiles';
import type { Puzzle } from '../types/puzzle';
import { Feedback } from './Feedback';
import { TableView } from './TableView';
import { TileView } from './TileView';

const PROMPTS: Record<Puzzle['kind'], string> = {
  discard: 'Which tile do you discard?',
  riichi: 'Declare riichi, or stay concealed?',
  call: 'Do you call, or let it pass?',
  push_fold: 'Push, or fold?',
  kan: 'Do you call kan?',
  placement: 'What does the placement situation demand?',
};

/**
 * Splits the hand for display: the drawn tile is shown apart from the rest,
 * which is how it appears at the table and matters for reading the decision.
 */
function useHandLayout(puzzle: Puzzle): { resting: Tile[]; drawn?: Tile } {
  return useMemo(() => {
    const { hand, drawnTile } = puzzle.position;
    if (!drawnTile) return { resting: sortTiles(hand) };

    const resting = [...hand];
    const index = resting.indexOf(drawnTile);
    if (index >= 0) resting.splice(index, 1);
    return { resting: sortTiles(resting), drawn: drawnTile };
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
  const { resting, drawn } = useHandLayout(puzzle);
  const answered = answer !== undefined;

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

  const handTile = (tile: Tile, key: string, isDrawn: boolean) => {
    const action = puzzle.actions.find((candidate) => candidate.tile === tile);
    const selectable = puzzle.kind === 'discard' && !answered && action !== undefined;
    return (
      <TileView
        key={key}
        tile={tile}
        size="lg"
        drawn={isDrawn}
        accent={accentFor(tile)}
        selected={answered && action?.id === answer.action.id}
        onSelect={selectable ? () => onAnswer(action.id) : undefined}
        describedAs={isDrawn ? 'just drawn' : undefined}
      />
    );
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

      <TableView position={puzzle.position} />

      <section className="puzzle__decision">
        <h2 className="puzzle__prompt">{PROMPTS[puzzle.kind]}</h2>

        <div className="hand" role="group" aria-label="Your hand">
          {puzzle.position.melds.length > 0 && (
            <div className="hand__melds">
              {puzzle.position.melds.map((meld, i) => (
                <span className="meld" key={i}>
                  {meld.tiles.map((tile, j) => (
                    <TileView key={`${tile}-${j}`} tile={tile} size="lg" muted />
                  ))}
                </span>
              ))}
            </div>
          )}

          <div className="hand__tiles">
            {resting.map((tile, i) => handTile(tile, `${tile}-${i}`, false))}
          </div>

          {drawn && <div className="hand__drawn">{handTile(drawn, `drawn-${drawn}`, true)}</div>}
        </div>

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
          <p className="puzzle__hint">Pick a tile from your hand.</p>
        )}
      </section>

      {answer && <Feedback puzzle={puzzle} answer={answer} onNext={onNext} />}
    </article>
  );
}
