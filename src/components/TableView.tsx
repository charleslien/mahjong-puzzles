import { doraFromIndicator, type Tile } from '../lib/tiles';
import type { Position, Seat } from '../types/puzzle';
import { TileView } from './TileView';

const SEAT_NAMES = ['East', 'South', 'West', 'North'] as const;

function seatLabel(seat: Seat, actingSeat: Seat): string {
  const name = SEAT_NAMES[seat];
  return seat === actingSeat ? `${name} (you)` : name;
}

function River({ tiles }: { tiles: Tile[] }) {
  if (tiles.length === 0) return <span className="river__empty">no discards</span>;
  return (
    <div className="river">
      {tiles.map((tile, i) => (
        <TileView key={`${tile}-${i}`} tile={tile} size="sm" muted />
      ))}
    </div>
  );
}

/**
 * The board context a solver needs before choosing: who is threatening, what is
 * already gone, and what the score situation demands.
 */
export function TableView({ position }: { position: Position }) {
  const { round, scores, doraIndicators, rivers, riichi, opponentMelds, tilesLeft, seat } = position;

  return (
    <section className="table" aria-label="Table state">
      <header className="table__header">
        <div className="table__round">
          <span className="table__round-main">
            {round.wind}
            {round.kyoku}
          </span>
          {round.honba > 0 && <span className="table__chip">{round.honba} honba</span>}
          {round.riichiSticks > 0 && (
            <span className="table__chip">{round.riichiSticks} riichi stick{round.riichiSticks > 1 ? 's' : ''}</span>
          )}
          <span className="table__chip">{tilesLeft} left</span>
        </div>

        <div className="table__dora">
          <span className="table__dora-label">Dora</span>
          {doraIndicators.map((indicator, i) => (
            <TileView
              key={`${indicator}-${i}`}
              tile={doraFromIndicator(indicator)}
              size="sm"
              describedAs={`dora, indicated by ${indicator}`}
            />
          ))}
        </div>
      </header>

      <div className="table__seats">
        {([0, 1, 2, 3] as Seat[]).map((s) => (
          <div key={s} className={`seat ${s === seat ? 'seat--self' : ''}`}>
            <div className="seat__head">
              <span className="seat__name">{seatLabel(s, seat)}</span>
              <span className="seat__score">{scores[s].toLocaleString()}</span>
              {riichi[s] && <span className="seat__riichi">RIICHI</span>}
            </div>

            {opponentMelds[s].length > 0 && (
              <div className="seat__melds">
                {opponentMelds[s].map((meld, i) => (
                  <span className="meld" key={i}>
                    {meld.tiles.map((tile, j) => (
                      <TileView key={`${tile}-${j}`} tile={tile} size="sm" />
                    ))}
                  </span>
                ))}
              </div>
            )}

            <River tiles={rivers[s]} />
          </div>
        ))}
      </div>
    </section>
  );
}
