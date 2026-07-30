import { doraFromIndicator, sortTiles, type Tile } from '../lib/tiles';
import { seatLayout, type Snapshot, type SeatState } from '../lib/replay';
import type { Seat } from '../types/puzzle';
import { TileView, type Rotation, type TileSize } from './TileView';

const SEAT_WINDS = ['E', 'S', 'W', 'N'] as const;

type Position = 'bottom' | 'right' | 'top' | 'left';

/**
 * Every seat's tiles are drawn upright, in horizontal rows.
 *
 * A real table turns each player's tiles to face them, and this used to. It
 * reads worse: rotated faces are harder to identify at a glance, and a river
 * that grows away from its owner scrambles the discard order for three of the
 * four seats. Legibility wins for a study tool.
 *
 * The one rotation kept is the riichi declaration tile, laid sideways in the
 * river. That is not an orientation preference — it is how a table records
 * *when* riichi was called, so it carries information the board would otherwise
 * lose.
 */
const RIICHI_ROTATION: Rotation = 90;

function windFor(seat: Seat, oya: Seat): string {
  return SEAT_WINDS[(seat - oya + 4) % 4];
}

function River({ seat, position, size }: { seat: SeatState; position: Position; size: TileSize }) {
  return (
    <div className={`board__river board__river--${position}`}>
      {seat.river.map((entry, i) => (
        <TileView
          key={`${entry.tile}-${i}`}
          tile={entry.tile}
          size={size}
          rotation={entry.riichi ? RIICHI_ROTATION : 0}
          spent={entry.called}
          describedAs={entry.called ? 'claimed' : entry.riichi ? 'riichi tile' : undefined}
          muted
        />
      ))}
    </div>
  );
}

function Melds({ seat, position, size }: { seat: SeatState; position: Position; size: TileSize }) {
  // Rendered even when empty. Returning null here made a seat's whole column
  // shorter until it called something, so any call mid-hand shifted every
  // control below the board — the row's height is reserved in CSS instead.
  return (
    <div className={`board__melds board__melds--${position}`}>
      {seat.melds.map((meld, i) => (
        <span className="board__meld" key={i}>
          {meld.tiles.map((tile, j) => (
            <TileView
              key={`${tile}-${j}`}
              // A closed kan shows its outer tiles face-down.
              tile={meld.kind === 'ankan' && (j === 0 || j === 3) ? undefined : tile}
              size={size}
            />
          ))}
        </span>
      ))}
    </div>
  );
}

function Hand({
  seat,
  position,
  reveal,
  size,
  interactive,
  onSelect,
  accentFor,
}: {
  seat: SeatState;
  position: Position;
  reveal: boolean;
  size: TileSize;
  interactive?: boolean;
  onSelect?: (tile: Tile) => void;
  accentFor?: (tile: Tile) => 'best' | 'good' | 'bad' | undefined;
}) {
  // Contents genuinely unrecorded: draw the right number of backs and never
  // reveal them, whatever the reveal toggle says.
  if (seat.unknownCount !== undefined) {
    return (
      <div className={`board__hand board__hand--${position}`}>
        {Array.from({ length: Math.max(0, seat.unknownCount) }, (_, i) => (
          <TileView key={i} size={size} />
        ))}
      </div>
    );
  }

  const resting = [...seat.hand];
  let drawn: Tile | undefined;
  if (seat.drawn) {
    const index = resting.indexOf(seat.drawn);
    if (index >= 0) {
      resting.splice(index, 1);
      drawn = seat.drawn;
    }
  }
  const ordered = sortTiles(resting);

  return (
    <div className={`board__hand board__hand--${position}`}>
      {ordered.map((tile, i) => (
        <TileView
          key={`${tile}-${i}`}
          tile={reveal ? tile : undefined}
          size={size}
          accent={reveal ? accentFor?.(tile) : undefined}
          onSelect={interactive && reveal ? onSelect : undefined}
        />
      ))}
      {drawn && (
        <span className="board__drawn">
          <TileView
            tile={reveal ? drawn : undefined}
            size={size}
            drawn
            accent={reveal ? accentFor?.(drawn) : undefined}
            onSelect={interactive && reveal ? onSelect : undefined}
            describedAs="just drawn"
          />
        </span>
      )}
    </div>
  );
}

function SeatPlate({
  seat,
  state,
  oya,
  isViewer,
  active,
}: {
  seat: Seat;
  state: SeatState;
  oya: Seat;
  isViewer: boolean;
  active: boolean;
}) {
  return (
    <div
      className={['plate', active ? 'plate--active' : '', isViewer ? 'plate--viewer' : '']
        .filter(Boolean)
        .join(' ')}
    >
      <span className="plate__wind">{windFor(seat, oya)}</span>
      {isViewer && <span className="plate__label">you</span>}
      <span className="plate__score">{state.score.toLocaleString()}</span>
      {state.riichi && <span className="plate__riichi">R</span>}
    </div>
  );
}

export interface GameBoardProps {
  snapshot: Snapshot;
  /** Seat shown at the bottom of the table. */
  viewer: Seat;
  /** Show every seat's tiles rather than only the viewer's. */
  revealAll?: boolean;
  /** Make the viewer's hand clickable. */
  interactive?: boolean;
  onSelect?: (tile: Tile) => void;
  accentFor?: (tile: Tile) => 'best' | 'good' | 'bad' | undefined;
}

/**
 * The table. Seats keep their positions around the felt — the viewer at the
 * bottom, the next to act on the right — but every hand and river is laid out in
 * horizontal rows, so the whole board reads in one direction.
 */
export function GameBoard({
  snapshot,
  viewer,
  revealAll = false,
  interactive = false,
  onSelect,
  accentFor,
}: GameBoardProps) {
  const layout = seatLayout(viewer);
  const positions: Array<[Position, Seat]> = [
    ['top', layout.top],
    ['left', layout.left],
    ['right', layout.right],
    ['bottom', layout.bottom],
  ];

  return (
    <div className="board">
      <div className="board__felt">
        {positions.map(([position, seat]) => {
          const state = snapshot.seats[seat];
          const reveal = revealAll || seat === viewer;
          const handSize: TileSize = position === 'bottom' ? 'lg' : 'sm';
          const riverSize: TileSize = position === 'bottom' ? 'sm' : 'xs';

          return (
            <div className={`board__side board__side--${position}`} key={position}>
              <SeatPlate
                seat={seat}
                state={state}
                oya={snapshot.oya}
                isViewer={seat === viewer}
                active={snapshot.actor === seat}
              />
              <Hand
                seat={state}
                position={position}
                reveal={reveal}
                size={handSize}
                interactive={interactive && seat === viewer}
                onSelect={onSelect}
                accentFor={seat === viewer ? accentFor : undefined}
              />
              <Melds seat={state} position={position} size={riverSize} />
              <River seat={state} position={position} size={riverSize} />
            </div>
          );
        })}

        <div className="board__centre">
          <div className="board__round">
            {snapshot.round.wind}
            {snapshot.round.kyoku}
          </div>
          <div className="board__wall">{snapshot.tilesLeft} left</div>
          {snapshot.round.honba > 0 && (
            <div className="board__counter">{snapshot.round.honba} honba</div>
          )}
          {snapshot.round.riichiSticks > 0 && (
            <div className="board__counter">{snapshot.round.riichiSticks} stick</div>
          )}
          <div className="board__dora">
            {snapshot.doraIndicators.map((indicator, i) => (
              <TileView
                key={`${indicator}-${i}`}
                tile={doraFromIndicator(indicator)}
                size="xs"
                describedAs={`dora, from indicator ${indicator}`}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
