import { doraFromIndicator, sortTiles, type Tile } from '../lib/tiles';
import { seatLayout, type Snapshot, type SeatState } from '../lib/replay';
import type { Seat } from '../types/puzzle';
import { TileView, type Rotation, type TileSize } from './TileView';

const SEAT_WINDS = ['E', 'S', 'W', 'N'] as const;

type Position = 'bottom' | 'right' | 'top' | 'left';

/** Rotation applied to a seat's tiles so they face that player. */
const ROTATION: Record<Position, Rotation> = {
  bottom: 0,
  right: 90,
  top: 180,
  left: 270,
};

/** Rivers are laid out in rows of six, growing away from the player. */
const RIVER_COLUMNS = 6;

function windFor(seat: Seat, oya: Seat): string {
  return SEAT_WINDS[(seat - oya + 4) % 4];
}

function River({
  seat,
  position,
  size,
}: {
  seat: SeatState;
  position: Position;
  size: TileSize;
}) {
  const rotation = ROTATION[position];
  const rows: Tile[][] = [];
  for (let i = 0; i < seat.river.length; i += RIVER_COLUMNS) {
    rows.push(seat.river.slice(i, i + RIVER_COLUMNS).map((entry) => entry.tile));
  }

  return (
    <div className={`board__river board__river--${position}`}>
      {seat.river.map((entry, i) => (
        <TileView
          key={`${entry.tile}-${i}`}
          tile={entry.tile}
          size={size}
          // A riichi declaration tile is turned sideways at a real table.
          rotation={
            entry.riichi ? (((rotation + 90) % 360) as Rotation) : rotation
          }
          spent={entry.called}
          describedAs={entry.called ? 'claimed' : entry.riichi ? 'riichi tile' : undefined}
          muted
        />
      ))}
      {rows.length === 0 && <span className="board__river-empty" />}
    </div>
  );
}

function Melds({
  seat,
  position,
  size,
}: {
  seat: SeatState;
  position: Position;
  size: TileSize;
}) {
  if (seat.melds.length === 0) return null;
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
              rotation={ROTATION[position]}
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
  const rotation = ROTATION[position];

  // Contents genuinely unrecorded: draw the right number of backs and never
  // reveal them, whatever the reveal toggle says.
  if (seat.unknownCount !== undefined) {
    return (
      <div className={`board__hand board__hand--${position}`}>
        {Array.from({ length: Math.max(0, seat.unknownCount) }, (_, i) => (
          <TileView key={i} size={size} rotation={rotation} />
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
          rotation={rotation}
          accent={reveal ? accentFor?.(tile) : undefined}
          onSelect={interactive && reveal ? onSelect : undefined}
        />
      ))}
      {drawn && (
        <span className="board__drawn">
          <TileView
            tile={reveal ? drawn : undefined}
            size={size}
            rotation={rotation}
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
  position,
}: {
  seat: Seat;
  state: SeatState;
  oya: Seat;
  isViewer: boolean;
  active: boolean;
  position: Position;
}) {
  return (
    <div
      className={[
        'plate',
        `plate--${position}`,
        active ? 'plate--active' : '',
        isViewer ? 'plate--viewer' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span className="plate__wind">{windFor(seat, oya)}</span>
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
 * A four-sided table. Each seat's tiles are rotated to face that seat, so the
 * board reads the way it would from the viewer's chair.
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
    ['bottom', layout.bottom],
    ['right', layout.right],
    ['top', layout.top],
    ['left', layout.left],
  ];

  return (
    <div className="board">
      <div className="board__felt">
        {positions.map(([position, seat]) => {
          const state = snapshot.seats[seat];
          const reveal = revealAll || seat === viewer;
          // Side seats get smaller tiles so four hands fit the felt.
          const handSize: TileSize = position === 'bottom' ? 'lg' : 'sm';
          const riverSize: TileSize = position === 'bottom' ? 'sm' : 'xs';

          return (
            <div className={`board__side board__side--${position}`} key={position}>
              <Melds seat={state} position={position} size={riverSize} />
              <River seat={state} position={position} size={riverSize} />
              <Hand
                seat={state}
                position={position}
                reveal={reveal}
                size={handSize}
                interactive={interactive && seat === viewer}
                onSelect={onSelect}
                accentFor={seat === viewer ? accentFor : undefined}
              />
              <SeatPlate
                seat={seat}
                state={state}
                oya={snapshot.oya}
                isViewer={seat === viewer}
                active={snapshot.actor === seat}
                position={position}
              />
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
