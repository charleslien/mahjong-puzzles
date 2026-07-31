import type { ReactNode } from 'react';

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

/**
 * Order a meld's tiles so the called one sits where it came from.
 *
 * A real table rotates the claimed tile sideways and places it on the side
 * facing the player it was taken from: left edge for the seat on your left,
 * middle for the one across, right edge for the one on your right. That is how
 * everyone at the table reads, at a glance, who fed the call — information the
 * board was simply not showing.
 *
 * Returns the tiles paired with whether each is the claimed one.
 */
/** Where a claimed tile came from, in words, for screen readers. */
function claimedFrom(from: Seat | undefined, owner: Seat): string {
  if (from === undefined) return 'claimed tile';
  const offset = (from - owner + 4) % 4;
  if (offset === 1) return 'claimed from the player on the right';
  if (offset === 2) return 'claimed from the player across';
  if (offset === 3) return 'claimed from the player on the left';
  return 'claimed tile';
}

function arrangeMeld(
  meld: SeatState['melds'][number],
  owner: Seat,
): Array<{ tile: Tile | undefined; claimed: boolean }> {
  const concealed = meld.kind === 'ankan';
  if (concealed || meld.from === undefined || meld.from === owner) {
    return meld.tiles.map((tile, index) => ({
      // A closed kan shows its outer tiles face-down.
      tile: concealed && (index === 0 || index === 3) ? undefined : tile,
      claimed: false,
    }));
  }

  // Which side of the caller the tile came from, in seating order.
  const offset = (meld.from - owner + 4) % 4;
  const rest = [...meld.tiles];
  // The claimed tile is the last one appended when the meld was built.
  const claimedTile = rest.pop() as Tile;

  const claimed = { tile: claimedTile, claimed: true };
  const others = rest.map((tile) => ({ tile: tile as Tile | undefined, claimed: false }));

  if (offset === 3) return [claimed, ...others]; // taken from the seat on the left
  if (offset === 1) return [...others, claimed]; // taken from the seat on the right
  // Across the table: conventionally the middle tile.
  return [others[0], claimed, ...others.slice(1)].filter(Boolean);
}

function Melds({
  seat,
  owner,
  position,
  size,
}: {
  seat: SeatState;
  owner: Seat;
  position: Position;
  size: TileSize;
}) {
  // Rendered even when empty. Returning null here made a seat's whole column
  // shorter until it called something, so any call mid-hand shifted every
  // control below the board — the row's height is reserved in CSS instead.
  return (
    <div className={`board__melds board__melds--${position}`}>
      {seat.melds.map((meld, i) => (
        <span className="board__meld" key={i}>
          {arrangeMeld(meld, owner).map((entry, j) => (
            <TileView
              key={`${entry.tile ?? 'back'}-${j}`}
              tile={entry.tile}
              size={size}
              // Sideways, the way a claimed tile is laid on a real table.
              rotation={entry.claimed ? 90 : 0}
              describedAs={entry.claimed ? claimedFrom(meld.from, owner) : undefined}
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
  /**
   * Rendered on the felt, immediately above the viewer's hand.
   *
   * Riichi and call puzzles are answered with buttons rather than by clicking a
   * tile, and those buttons used to sit in a panel below the board — so the
   * question was on the table and the answer was somewhere else entirely.
   *
   * Placed in the bottom seat's stack rather than absolutely positioned over the
   * felt: floating it at the bottom edge covered the viewer's own hand, which is
   * the one thing you need to see to decide whether to call.
   */
  overlay?: ReactNode;
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
  overlay,
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

          const plate = (
            <SeatPlate
              seat={seat}
              state={state}
              oya={snapshot.oya}
              isViewer={seat === viewer}
              active={snapshot.actor === seat}
            />
          );
          const hand = (
            <Hand
              seat={state}
              position={position}
              reveal={reveal}
              size={handSize}
              interactive={interactive && seat === viewer}
              onSelect={onSelect}
              accentFor={seat === viewer ? accentFor : undefined}
            />
          );
          const melds = <Melds seat={state} owner={seat} position={position} size={riverSize} />;
          const river = <River seat={state} position={position} size={riverSize} />;

          // Every seat reads the same way: what they have shown — discards, then
          // called melds — above the hand they are still holding, with the seat
          // label on the outer edge.
          //
          // For the seats drawn above the centre this puts their discards further
          // from the middle of the table than a real table would, where a discard
          // pile always sits between its owner and the centre. Consistency won:
          // one rule for four seats is easier to read than a mirrored one, and
          // the concealed hand is a row of identical backs, so having it nearer
          // the centre costs nothing.
          return (
            <div className={`board__side board__side--${position}`} key={position}>
              {position !== 'bottom' && plate}
              {river}
              {melds}
              {position === 'bottom' && overlay && (
                <div className="board__choices">{overlay}</div>
              )}
              {hand}
              {position === 'bottom' && plate}
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
