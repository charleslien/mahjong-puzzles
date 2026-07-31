import type { ReactNode } from 'react';

import { doraFromIndicator, sortTiles, type Tile } from '../lib/tiles';
import { seatLayout, type Snapshot, type SeatState } from '../lib/replay';
import type { MeldKind, Seat } from '../types/puzzle';
import { TileView, type Rotation, type TileSize } from './TileView';

const SEAT_WINDS = ['E', 'S', 'W', 'N'] as const;

type Position = 'bottom' | 'right' | 'top' | 'left';

/**
 * Every seat's tiles face the player they belong to — but the turn is applied to
 * the seat's whole block in CSS (`.board__seat`), not to each tile.
 *
 * Rotating tiles individually was the first attempt and it reads wrongly: the
 * faces point the right way while the rows still run across the screen, so a
 * side seat's hand looks like a row of tiles knocked over rather than a hand
 * seen from the side. Turning the block turns the rows with it, which also puts
 * each seat's discards between them and the centre the way a table does.
 *
 * So inside a seat's own frame every tile is upright, and the only rotations
 * left here are the two that mean something at a table: the riichi declaration
 * tile laid sideways in a river, and the claimed tile in a meld. Both are a
 * quarter turn *relative to their owner*, which is exactly what a plain 90 is
 * once the block carries the seat's orientation.
 */
const TURNED: Rotation = 90;

function windFor(seat: Seat, oya: Seat): string {
  return SEAT_WINDS[(seat - oya + 4) % 4];
}

function River({
  seat,
  position,
  size,
  offering,
}: {
  seat: SeatState;
  position: Position;
  size: TileSize;
  /** This seat just made the discard a call puzzle is asking about. */
  offering?: boolean;
}) {
  const last = seat.river.length - 1;
  return (
    <div className={`board__river board__river--${position}`}>
      {seat.river.map((entry, i) => {
        // The tile a call is *on* is the newest one in this river, and it is the
        // whole subject of the question. Unmarked, a solver had to work out which
        // of twenty discards they were being asked about.
        const offered = Boolean(offering) && i === last;
        return (
          <TileView
            key={`${entry.tile}-${i}`}
            tile={entry.tile}
            size={size}
            rotation={entry.riichi ? TURNED : 0}
            spent={entry.called}
            offered={offered}
            describedAs={
              offered
                ? 'offered for a call'
                : entry.called
                  ? 'claimed'
                  : entry.riichi
                    ? 'riichi tile'
                    : undefined
            }
            muted={!offered}
          />
        );
      })}
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
              // Sideways relative to its owner, the way a claimed tile is laid on
              // a real table.
              rotation={entry.claimed ? TURNED : 0}
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
  selectable,
  withheld,
}: {
  seat: SeatState;
  position: Position;
  reveal: boolean;
  size: TileSize;
  interactive?: boolean;
  onSelect?: (tile: Tile) => void;
  accentFor?: (tile: Tile) => 'best' | 'good' | 'bad' | undefined;
  selectable?: (tile: Tile) => boolean;
  withheld?: Tile[];
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

  // Tiles promised to a call the solver has started but not finished. Matched by
  // count rather than by value, so a hand holding two 2 circles loses exactly the
  // one the call eats and keeps the other in play.
  const remaining = new Map<Tile, number>();
  for (const tile of withheld ?? []) remaining.set(tile, (remaining.get(tile) ?? 0) + 1);
  const takenByCall = (tile: Tile): boolean => {
    const left = remaining.get(tile) ?? 0;
    if (left <= 0) return false;
    remaining.set(tile, left - 1);
    return true;
  };

  return (
    <div className={`board__hand board__hand--${position}`}>
      {ordered.map((tile, i) => {
        const taken = takenByCall(tile);
        const allowed = !taken && (selectable === undefined || selectable(tile));
        return (
          <TileView
            key={`${tile}-${i}`}
            tile={reveal ? tile : undefined}
            size={size}
            accent={reveal ? accentFor?.(tile) : undefined}
            onSelect={interactive && reveal && allowed ? onSelect : undefined}
            // A tile the call has eaten is drawn as an empty slot, because it is
            // already shown in the meld above — left in place it read as a second
            // copy of a tile the seat holds once.
            spent={taken}
            // Illegal ones are only dimmed, not hidden: the point of restricting
            // the legal set is to show *which* tiles the branch rules out, and a
            // tile that has vanished teaches nothing.
            muted={reveal && !allowed && !taken}
            describedAs={
              taken ? 'moved into the call' : reveal && !allowed ? 'not legal here' : undefined
            }
          />
        );
      })}
      {drawn && (
        <span className="board__drawn">
          <TileView
            tile={reveal ? drawn : undefined}
            size={size}
            drawn
            accent={reveal ? accentFor?.(drawn) : undefined}
            onSelect={
              interactive && reveal && (selectable === undefined || selectable(drawn))
                ? onSelect
                : undefined
            }
            muted={reveal && selectable !== undefined && !selectable(drawn)}
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
   * Which of the viewer's tiles may be picked, when the branch restricts them.
   *
   * Declaring riichi allows only the tiles that keep the hand tenpai, which is
   * often five where playing on allows twelve. Showing the rest dimmed rather
   * than removing them is the point: the narrowing is the lesson.
   */
  selectable?: (tile: Tile) => boolean;
  /**
   * A call the solver has committed to but not yet finished.
   *
   * Drawn as a meld in front of the viewer, with the consumed tiles taken out of
   * the hand, so the eleven tiles left to choose a discard from are the eleven
   * shown rather than something the solver has to work out.
   */
  pendingMeld?: {
    kind: MeldKind;
    called: Tile;
    consumed: Tile[];
    from?: Seat;
    /** The call was actually played, rather than being part-way chosen. */
    settled?: boolean;
  };
  /** Seat whose newest discard is the one a call puzzle is asking about. */
  offerFrom?: Seat;
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
  selectable,
  pendingMeld,
  offerFrom,
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
          // One size for everything an opponent shows, one for everything the
          // viewer does. Opponents' hands used to be a size larger than their own
          // rivers, and once turned a quarter that row became wide enough that
          // the three-column table no longer fitted its own container — the
          // document overflowed on any window under 1000px, and even at 1400 the
          // felt was 11px over its own width.
          const handSize: TileSize = position === 'bottom' ? 'lg' : 'xs';
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
          const isViewer = seat === viewer;
          const hand = (
            <Hand
              seat={state}
              position={position}
              reveal={reveal}
              size={handSize}
              interactive={interactive && isViewer}
              onSelect={onSelect}
              accentFor={isViewer ? accentFor : undefined}
              selectable={isViewer ? selectable : undefined}
              withheld={isViewer ? pendingMeld?.consumed : undefined}
            />
          );
          const melds = (
            <>
              <Melds seat={state} owner={seat} position={position} size={riverSize} />
              {isViewer && pendingMeld && (
                <div
                  className={`board__melds board__melds--pending${
                    pendingMeld.settled ? ' board__melds--settled' : ''
                  }`}
                >
                  <span className="board__meld">
                    {arrangeMeld(
                      {
                        kind: pendingMeld.kind,
                        tiles: [...pendingMeld.consumed, pendingMeld.called],
                        from: pendingMeld.from,
                      },
                      seat,
                    ).map((entry, j) => (
                      <TileView
                        key={`${entry.tile ?? 'back'}-${j}`}
                        tile={entry.tile}
                        size={handSize}
                        rotation={entry.claimed ? 90 : 0}
                        describedAs={
                          entry.claimed ? claimedFrom(pendingMeld.from, seat) : 'called with'
                        }
                      />
                    ))}
                  </span>
                </div>
              )}
            </>
          );
          const river = (
            <River
              seat={state}
              position={position}
              size={riverSize}
              offering={seat === offerFrom}
            />
          );

          // Every seat is built identically — river, then melds, then the hand —
          // and the whole block is then turned to face its owner in CSS. Turning
          // the block rather than the tiles inside it is what makes a side seat
          // read as a hand seen from the side: rotating each tile on its own left
          // the rows running across the screen, so a hand looked like tiles
          // knocked over rather than someone's hand.
          //
          // It also puts each seat's discards between them and the centre, the
          // way a table does, which the upright version could not do without
          // mirroring the rule for half the seats.
          //
          // The score plate stays outside the turn. It is text about a player,
          // not something on the felt, and upside-down numbers are just harder to
          // read.
          return (
            <div className={`board__side board__side--${position}`} key={position}>
              {position !== 'bottom' && plate}
              <div className="board__seat">
                {river}
                {melds}
                {position === 'bottom' && overlay && (
                  <div className="board__choices">{overlay}</div>
                )}
                {hand}
              </div>
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
