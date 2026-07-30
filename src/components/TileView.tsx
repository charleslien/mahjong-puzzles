import type { CSSProperties } from 'react';

import { canonicalize, isRedFive, tileLabel, type Tile } from '../lib/tiles';

/**
 * Degrees clockwise. Side seats show their tiles turned to face them, which is
 * how a real table reads: 90 for the seat on the right, 180 across, 270 left.
 */
export type Rotation = 0 | 90 | 180 | 270;

export type TileSize = 'xs' | 'sm' | 'md' | 'lg';

/** Face width in px; height follows the 3:4 tile aspect. */
const WIDTHS: Record<TileSize, number> = { xs: 18, sm: 24, md: 32, lg: 44 };

function tileUrl(name: string): string {
  return `${import.meta.env.BASE_URL}tiles/${name}.svg`;
}

export interface TileViewProps {
  /** Tile to show, or undefined for a face-down tile. */
  tile?: Tile;
  size?: TileSize;
  rotation?: Rotation;
  /** Renders as a button and fires on click. */
  onSelect?: (tile: Tile) => void;
  selected?: boolean;
  /** Visually recedes, for tiles that are not part of the decision. */
  muted?: boolean;
  /** Verdict stripe along the bottom edge. */
  accent?: 'best' | 'good' | 'bad';
  /** Marks the freshly drawn tile. */
  drawn?: boolean;
  /** Already claimed out of a river — drawn as an empty slot. */
  spent?: boolean;
  /** Extra text announced to screen readers. */
  describedAs?: string;
}

export function TileView({
  tile,
  size = 'md',
  rotation = 0,
  onSelect,
  selected = false,
  muted = false,
  accent,
  drawn = false,
  spent = false,
  describedAs,
}: TileViewProps) {
  const canonical = tile ? canonicalize(tile) : undefined;
  const faceWidth = WIDTHS[size];
  const faceHeight = Math.round((faceWidth * 4) / 3);
  // A quarter-turn swaps the footprint the tile occupies in its row.
  const turned = rotation === 90 || rotation === 270;

  const label = canonical
    ? `${tileLabel(canonical)}${describedAs ? `, ${describedAs}` : ''}`
    : 'face-down tile';

  const classes = [
    'tile',
    `tile--${size}`,
    turned ? 'tile--turned' : '',
    muted ? 'tile--muted' : '',
    selected ? 'tile--selected' : '',
    drawn ? 'tile--drawn' : '',
    spent ? 'tile--spent' : '',
    canonical && isRedFive(canonical) ? 'tile--red' : '',
    accent ? `tile--accent-${accent}` : '',
    onSelect ? 'tile--interactive' : '',
  ]
    .filter(Boolean)
    .join(' ');

  // Dimensions go out as custom properties rather than concrete width/height so
  // stylesheets can scale the whole board with one `--tile-scale` override —
  // inline pixel values would be unoverridable without `!important`.
  const boxStyle = {
    '--tile-fw': `${faceWidth}px`,
    '--tile-fh': `${faceHeight}px`,
  } as CSSProperties;

  const faceStyle = {
    transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
  };

  const face = spent ? null : (
    <img
      className="tile__img"
      src={tileUrl(canonical ?? 'back')}
      alt=""
      draggable={false}
      style={faceStyle}
    />
  );

  if (!onSelect || !canonical) {
    return (
      <span className={classes} style={boxStyle} role="img" aria-label={label}>
        {face}
      </span>
    );
  }

  return (
    <button
      type="button"
      className={classes}
      style={boxStyle}
      onClick={() => onSelect(canonical)}
      aria-label={label}
      aria-pressed={selected}
    >
      {face}
    </button>
  );
}
