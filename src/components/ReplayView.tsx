import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { GameBoard } from './GameBoard';
import { replayKyoku, splitKyoku, type MjaiEvent, type Snapshot } from '../lib/replay';
import type { Seat } from '../types/puzzle';

export interface ReplayMeta {
  id: string;
  title: string;
  provenance: string;
  file: string;
}

export interface ReplayIndex {
  replays: ReplayMeta[];
}

const PLAY_INTERVAL_MS = 700;

function useKeyboardControls(handlers: {
  prev: () => void;
  next: () => void;
  first: () => void;
  last: () => void;
  toggle: () => void;
}) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Don't hijack keys while a control has focus for its own use.
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;

      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault();
          ref.current.prev();
          break;
        case 'ArrowRight':
          event.preventDefault();
          ref.current.next();
          break;
        case 'Home':
          event.preventDefault();
          ref.current.first();
          break;
        case 'End':
          event.preventDefault();
          ref.current.last();
          break;
        case ' ':
          event.preventDefault();
          ref.current.toggle();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

export function ReplayView({
  basePath,
  upright,
  onToggleUpright,
}: {
  basePath: string;
  upright: boolean;
  onToggleUpright: () => void;
}) {
  const [index, setIndex] = useState<ReplayIndex>();
  const [events, setEvents] = useState<MjaiEvent[]>();
  const [selectedReplay, setSelectedReplay] = useState<string>();
  const [error, setError] = useState<string>();

  const [kyokuIndex, setKyokuIndex] = useState(0);
  const [frame, setFrame] = useState(0);
  const [viewer, setViewer] = useState<Seat>(0);
  // Concealed by default: seeing every hand is a deliberate choice, not the
  // starting point, or the replay gives away information a player never had.
  const [revealAll, setRevealAll] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    fetch(`${basePath}replays/index.json`, { cache: 'no-cache' })
      .then((response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return response.json() as Promise<ReplayIndex>;
      })
      .then((loaded) => {
        setIndex(loaded);
        setSelectedReplay(loaded.replays[0]?.id);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [basePath]);

  const meta = useMemo(
    () => index?.replays.find((candidate) => candidate.id === selectedReplay),
    [index, selectedReplay],
  );

  useEffect(() => {
    if (!meta) return;
    setEvents(undefined);
    fetch(`${basePath}replays/${meta.file}`, { cache: 'no-cache' })
      .then((response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return response.json() as Promise<MjaiEvent[]>;
      })
      .then((loaded) => {
        setEvents(loaded);
        setKyokuIndex(0);
        setFrame(0);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [basePath, meta]);

  const hands = useMemo(() => (events ? splitKyoku(events) : []), [events]);
  const frames = useMemo<Snapshot[]>(
    () => (hands[kyokuIndex] ? replayKyoku(hands[kyokuIndex]) : []),
    [hands, kyokuIndex],
  );

  const clamp = useCallback(
    (next: number) => Math.max(0, Math.min(frames.length - 1, next)),
    [frames.length],
  );

  const next = useCallback(() => setFrame((current) => clamp(current + 1)), [clamp]);
  const prev = useCallback(() => setFrame((current) => clamp(current - 1)), [clamp]);
  const first = useCallback(() => setFrame(0), []);
  const last = useCallback(() => setFrame(clamp(frames.length - 1)), [clamp, frames.length]);
  const toggle = useCallback(() => setPlaying((current) => !current), []);

  useKeyboardControls({ prev, next, first, last, toggle });

  // Autoplay, stopping at the end of the hand rather than looping.
  useEffect(() => {
    if (!playing) return;
    if (frame >= frames.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setFrame((current) => clamp(current + 1)), PLAY_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [playing, frame, frames.length, clamp]);

  const moveListRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const list = moveListRef.current;
    const active = list?.querySelector('[aria-current="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [frame]);

  if (error) {
    return (
      <section className="panel panel--error">
        <h2>Could not load replays</h2>
        <p>{error}</p>
        <p className="muted">
          If you are running locally, generate them first with <code>npm run build:replays</code>.
        </p>
      </section>
    );
  }

  if (!index || !events) return <section className="panel">Loading replay…</section>;

  const snapshot = frames[frame];
  if (!snapshot) {
    return (
      <section className="panel">
        <h2>Nothing to replay</h2>
        <p className="muted">This log contains no hands.</p>
      </section>
    );
  }

  return (
    <section className="replay">
      <div className="replay__bar">
        <label className="field">
          <span>Game</span>
          <select
            value={selectedReplay}
            onChange={(event) => setSelectedReplay(event.target.value)}
          >
            {index.replays.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.title}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Hand</span>
          <select
            value={kyokuIndex}
            onChange={(event) => {
              setKyokuIndex(Number(event.target.value));
              setFrame(0);
              setPlaying(false);
            }}
          >
            {hands.map((hand, i) => {
              const start = hand[0];
              const name =
                start && start.type === 'start_kyoku'
                  ? `${start.bakaze}${start.kyoku}${start.honba ? `-${start.honba}` : ''}`
                  : `hand ${i + 1}`;
              return (
                <option key={i} value={i}>
                  {name}
                </option>
              );
            })}
          </select>
        </label>

        <label className="field">
          <span>View from</span>
          <select value={viewer} onChange={(event) => setViewer(Number(event.target.value) as Seat)}>
            <option value={0}>Seat 1</option>
            <option value={1}>Seat 2</option>
            <option value={2}>Seat 3</option>
            <option value={3}>Seat 4</option>
          </select>
        </label>

        <label className="field field--check">
          <input
            type="checkbox"
            checked={revealAll}
            onChange={(event) => setRevealAll(event.target.checked)}
          />
          <span>Reveal all hands</span>
        </label>

        <label className="field field--check">
          <input type="checkbox" checked={upright} onChange={onToggleUpright} />
          <span>Upright tiles</span>
        </label>
      </div>

      <GameBoard snapshot={snapshot} viewer={viewer} revealAll={revealAll} upright={upright} />

      <div className="replay__controls">
        <button type="button" className="button" onClick={first} disabled={frame === 0}>
          ⏮
        </button>
        <button type="button" className="button" onClick={prev} disabled={frame === 0}>
          ◀
        </button>
        <button type="button" className="button button--primary" onClick={toggle}>
          {playing ? '⏸ Pause' : '▶ Play'}
        </button>
        <button
          type="button"
          className="button"
          onClick={next}
          disabled={frame >= frames.length - 1}
        >
          ▶
        </button>
        <button
          type="button"
          className="button"
          onClick={last}
          disabled={frame >= frames.length - 1}
        >
          ⏭
        </button>

        <input
          className="replay__scrub"
          type="range"
          min={0}
          max={Math.max(0, frames.length - 1)}
          value={frame}
          onChange={(event) => {
            setPlaying(false);
            setFrame(Number(event.target.value));
          }}
          aria-label="Move"
        />
        <span className="replay__count">
          {frame + 1} / {frames.length}
        </span>
      </div>

      <p className="replay__hint muted">
        Arrow keys step, Space plays, Home and End jump to the ends.
      </p>

      <div className="replay__lower">
        <ol className="movelist" ref={moveListRef}>
          {frames.map((candidate, i) => (
            <li key={i}>
              <button
                type="button"
                className={`movelist__item ${i === frame ? 'movelist__item--on' : ''}`}
                aria-current={i === frame}
                onClick={() => {
                  setPlaying(false);
                  setFrame(i);
                }}
              >
                <span className="movelist__n">{i + 1}</span>
                <span>{candidate.description}</span>
              </button>
            </li>
          ))}
        </ol>

        {meta && (
          <aside className="replay__provenance">
            <h3>About this log</h3>
            <p className="muted">{meta.provenance}</p>
          </aside>
        )}
      </div>
    </section>
  );
}
