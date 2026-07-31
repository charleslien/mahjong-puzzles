import type { Puzzle } from '../types/puzzle';
import { TileView } from './TileView';

/**
 * An action described without naming a tile in words.
 *
 * Reading "3 circles" and then finding that tile on the board is a translation
 * step between two notations for the same thing, and it is the kind of thing
 * that stops being invisible only once you have played a lot of hands. The tile
 * itself is unambiguous and needs no reading.
 *
 * The pipeline still writes prose labels — "Discard 3 circles", "Call chi, then
 * discard 2 circles" — because they are the right thing for a database row, a
 * log line or a permalink's description. The trailing tile phrase is stripped
 * here and replaced with the tile.
 */
const TILE_PHRASE = /^(.*?)(?:,\s*)?(?:discarding|then discard|Discard)\s+.+$/i;

export function stripTileName(label: string): string {
  const match = TILE_PHRASE.exec(label);
  if (!match) return label;
  // "Discard 5 circles" leaves nothing before the verb; keep the verb itself.
  return match[1].trim() || 'Discard';
}

export function ActionLabel({
  action,
  showTile = true,
  size = 'sm',
}: {
  action: Pick<Puzzle['actions'][number], 'label' | 'tile'>;
  /** Off where the tile already has its own column. */
  showTile?: boolean;
  size?: 'xs' | 'sm' | 'md';
}) {
  const text = stripTileName(action.label);
  return (
    <span className="actionlabel">
      <span>{text}</span>
      {showTile && action.tile && <TileView tile={action.tile} size={size} />}
    </span>
  );
}
