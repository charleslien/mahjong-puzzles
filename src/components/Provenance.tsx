import { useState } from 'react';

import type { Puzzle } from '../types/puzzle';

/**
 * Where this position came from, exactly.
 *
 * Shown only after answering — the game id identifies a real hanchan, and before
 * the answer it would be a route to looking the hand up rather than solving it.
 *
 * **Why there is no replay link.** The obvious thing would be
 * `tenhou.net/0/?log=<id>&tw=<seat>`, and that URL still loads a viewer, but
 * Tenhou no longer serves the log data for games this old: `/0/log/?log=<id>`
 * returns 404 and `find.cgi` answers `ERROR`, so the viewer opens on an empty
 * table. A link that looks live and resolves to nothing is worse than no link.
 * The same reason rules out handing the id to mjai.ekyu.moe, which fetches the
 * replay from Tenhou and has no query parameter to pre-fill in any case.
 *
 * What does still exist is Tenhou's yearly bulk archive, which is where this
 * bank was mined from. So the id is presented as a citation — copyable, and
 * enough to find the hand in the archive — rather than as a link that would only
 * disappoint.
 */
const ARCHIVE = 'https://tenhou.net/sc/raw/';

export function Provenance({ puzzle }: { puzzle: Puzzle }) {
  const [copied, setCopied] = useState(false);
  const gameId = puzzle.source.gameId;
  if (!gameId) return null;

  const { round, seat } = puzzle.position;
  const hand = `${round.wind}${round.kyoku}${round.honba ? `-${round.honba}` : ''}`;

  const copy = () => {
    void navigator.clipboard?.writeText(gameId).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );
  };

  return (
    <p className="provenance">
      <span className="provenance__label">From</span>
      <code className="provenance__id">{gameId}</code>
      {/* The hand and the seat index, which together pick the exact decision out
          of the game — the same two coordinates a replay viewer would need. */}
      <span className="provenance__where">
        {hand}, seat {seat}
      </span>
      <button
        type="button"
        className="linkbutton"
        onClick={copy}
        aria-label={`Copy the game id ${gameId}`}
      >
        {copied ? 'copied' : 'copy'}
      </button>
      <a
        className="provenance__archive"
        href={ARCHIVE}
        target="_blank"
        rel="noreferrer"
        title="Tenhou no longer serves individual replays this old; the yearly archives still hold them"
      >
        Tenhou archive
      </a>
    </p>
  );
}
