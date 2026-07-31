import { BRANCH_LABELS } from '../lib/decision';
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
  action: Pick<Puzzle['actions'][number], 'label' | 'tile' | 'branch' | 'consumed'>;
  /** Off where the tile already has its own column. */
  showTile?: boolean;
  size?: 'xs' | 'sm' | 'md';
}) {
  // A line that names a branch describes itself from its own fields, which is
  // the only way to show the tiles a call eats as tiles. Stripping them out of
  // "Call chi with 2 bamboo and 3 bamboo, then discard 5 characters" would leave
  // two of the three tiles still spelled out in words.
  const text = action.branch ? BRANCH_LABELS[action.branch] : stripTileName(action.label);
  return (
    <span className="actionlabel">
      <span>{text}</span>
      {action.consumed?.map((tile, index) => (
        <TileView key={`${tile}-${index}`} tile={tile} size={size} />
      ))}
      {showTile && action.tile && (
        <>
          {action.consumed?.length ? <span className="actionlabel__then">then</span> : null}
          <TileView tile={action.tile} size={size} />
        </>
      )}
    </span>
  );
}
