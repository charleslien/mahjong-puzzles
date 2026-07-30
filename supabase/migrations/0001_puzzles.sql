-- Puzzle bank in Postgres.
--
-- The site currently ships every puzzle as bundled JSON and loads all of it on
-- first paint, which caps the bank at what is reasonable to download — the
-- reason it holds 897 puzzles and not the 50,000 the mining pipeline could
-- produce. Serving from here removes that cap: the browser fetches a page of
-- puzzles instead of the whole bank.
--
-- Apply with:
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/0001_puzzles.sql
--
-- Written to be re-runnable.

create table if not exists public.puzzles (
  id                  text primary key,
  schema_version      integer     not null,
  kind                text        not null,
  difficulty          integer     not null check (difficulty between 0 and 100),
  tags                text[]      not null default '{}',
  best_shanten        integer,

  -- Mirrors src/types/puzzle.ts. Kept as jsonb rather than shredded into columns
  -- because the site's schema is the contract and it is versioned; splitting it
  -- would mean two definitions of a Position that have to be kept in step.
  position            jsonb       not null,
  actions             jsonb       not null,
  accepted_action_ids text[]      not null,
  evaluation          jsonb       not null,
  source              jsonb       not null,
  explanation         text,

  -- The hand's mjai events, for the replay controls. Around half the bytes in
  -- the bank. Postgres stores oversized jsonb out of line, so a query that does
  -- not name this column does not pay for it — which is the whole reason the
  -- list and detail paths can share one table. Never `select *` on a list query.
  history             jsonb,

  -- Stable random ordering. `order by random()` re-sorts the whole table on
  -- every request; sampling on an indexed key stays fast as the bank grows.
  shuffle_key         double precision not null default random(),

  created_at          timestamptz not null default now()
);

comment on column public.puzzles.history is
  'mjai events for the hand up to the decision. Contains every seat''s tiles, '
  'including opponents'' concealed hands — the board hides them until the puzzle '
  'is answered, but they are present in the payload.';

create index if not exists puzzles_shuffle_key_idx on public.puzzles (shuffle_key);
create index if not exists puzzles_difficulty_idx  on public.puzzles (difficulty);
create index if not exists puzzles_kind_idx        on public.puzzles (kind);
create index if not exists puzzles_tags_idx        on public.puzzles using gin (tags);

-- Bank-level metadata: provenance, generation date, schema version. One row.
create table if not exists public.bank_meta (
  id             boolean primary key default true check (id),
  schema_version integer     not null,
  generated_at   date        not null,
  provenance     text        not null,
  updated_at     timestamptz not null default now()
);

-- Row-level security. Without this the publishable key — which ships inside the
-- JavaScript bundle and is readable by any visitor — would allow anyone to
-- rewrite the bank. Enabling RLS with no policy denies everything; the policies
-- below then grant exactly read.
alter table public.puzzles  enable row level security;
alter table public.bank_meta enable row level security;

drop policy if exists "puzzles are publicly readable" on public.puzzles;
create policy "puzzles are publicly readable"
  on public.puzzles for select
  to anon, authenticated
  using (true);

drop policy if exists "bank metadata is publicly readable" on public.bank_meta;
create policy "bank metadata is publicly readable"
  on public.bank_meta for select
  to anon, authenticated
  using (true);

-- No insert/update/delete policies exist, so neither role can write. Uploads run
-- with the secret key, which bypasses RLS by design.

-- Sample n puzzles matching optional filters, without the history payload.
-- Wrapped in a function so the sampling trick lives in one place: pick a random
-- point on the shuffle key and walk forward from it, wrapping around if the
-- window near the top of the range is too small.
create or replace function public.sample_puzzles(
  sample_size    integer default 50,
  min_difficulty integer default 0,
  max_difficulty integer default 100,
  kinds          text[]  default null,
  any_tags       text[]  default null
)
returns setof public.puzzles
language sql
stable
as $$
  with bounds as (select random() as cut)
  (
    select p.* from public.puzzles p, bounds b
    where p.shuffle_key >= b.cut
      and p.difficulty between min_difficulty and max_difficulty
      and (kinds    is null or p.kind = any(kinds))
      and (any_tags is null or p.tags && any_tags)
    order by p.shuffle_key
    limit sample_size
  )
  union all
  (
    -- Wrap-around, so a cut near 1.0 still returns a full page.
    select p.* from public.puzzles p, bounds b
    where p.shuffle_key < b.cut
      and p.difficulty between min_difficulty and max_difficulty
      and (kinds    is null or p.kind = any(kinds))
      and (any_tags is null or p.tags && any_tags)
    order by p.shuffle_key
    limit sample_size
  )
  limit sample_size;
$$;

grant execute on function public.sample_puzzles(integer, integer, integer, text[], text[])
  to anon, authenticated;
