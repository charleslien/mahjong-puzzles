import { canonicalize, isRedFive, tileLabel, type Tile } from '../lib/tiles';

const HONOR_GLYPHS: Record<string, string> = {
  E: '東',
  S: '南',
  W: '西',
  N: '北',
  P: '白',
  F: '發',
  C: '中',
};

const SUIT_GLYPHS: Record<string, string> = { m: '萬', p: '筒', s: '索' };

export type TileSize = 'sm' | 'md' | 'lg';

export interface TileViewProps {
  tile: Tile;
  size?: TileSize;
  /** Renders as a button and fires on click. */
  onSelect?: (tile: Tile) => void;
  selected?: boolean;
  /** Visually recedes, used for tiles that are not part of the decision. */
  muted?: boolean;
  /** Accent stripe along the bottom, used to mark evaluation quality. */
  accent?: 'best' | 'good' | 'bad';
  /** Marks the freshly drawn tile. */
  drawn?: boolean;
  /** Extra text announced to screen readers. */
  describedAs?: string;
}

export function TileView({
  tile,
  size = 'md',
  onSelect,
  selected = false,
  muted = false,
  accent,
  drawn = false,
  describedAs,
}: TileViewProps) {
  const canonical = canonicalize(tile);
  const red = isRedFive(tile);
  const honor = HONOR_GLYPHS[canonical];

  let suit = '';
  let rank = '';
  if (!honor) {
    const match = /^([0-9])([mps])r?$/.exec(canonical);
    if (match) {
      rank = match[1];
      suit = match[2];
    }
  }

  const classes = [
    'tile',
    `tile--${size}`,
    honor ? 'tile--honor' : `tile--${suit}`,
    red ? 'tile--red' : '',
    selected ? 'tile--selected' : '',
    muted ? 'tile--muted' : '',
    drawn ? 'tile--drawn' : '',
    accent ? `tile--accent-${accent}` : '',
    onSelect ? 'tile--interactive' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const label = `${tileLabel(tile)}${describedAs ? `, ${describedAs}` : ''}`;

  const face = honor ? (
    <span className="tile__honor">{honor}</span>
  ) : (
    <>
      <span className="tile__rank">{rank}</span>
      <span className="tile__suit">{SUIT_GLYPHS[suit]}</span>
    </>
  );

  if (!onSelect) {
    return (
      <span className={classes} role="img" aria-label={label}>
        <span className="tile__face">{face}</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      className={classes}
      onClick={() => onSelect(tile)}
      aria-label={label}
      aria-pressed={selected}
    >
      <span className="tile__face">{face}</span>
    </button>
  );
}
