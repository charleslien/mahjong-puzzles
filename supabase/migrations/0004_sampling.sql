-- Serve a session's worth of puzzles instead of the whole bank.
--
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/0004_sampling.sql
--
-- The client currently downloads every puzzle to filter and shuffle in memory.
-- That caps the bank at what is reasonable to send — the reason it holds ~900
-- and not the 50,000 the pipeline could produce — and it makes every visit pay
-- for 900 puzzles to answer twenty.
--
-- Sampling on an indexed random key rather than `order by random()`, which sorts
-- the whole table per request and degrades exactly as the bank grows.

drop function if exists public.sample_puzzles(integer, integer, integer, text[], text[]);

create or replace function public.sample_puzzles(
  sample_size    integer default 40,
  min_difficulty integer default 0,
  max_difficulty integer default 100,
  kinds          text[]  default null,
  any_tags       text[]  default null,
  exclude_ids    text[]  default null
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
      and (kinds       is null or p.kind = any(kinds))
      and (any_tags    is null or p.tags && any_tags)
      and (exclude_ids is null or not (p.id = any(exclude_ids)))
    order by p.shuffle_key
    limit sample_size
  )
  union all
  (
    -- Wrap-around, so a cut near 1.0 still returns a full page.
    select p.* from public.puzzles p, bounds b
    where p.shuffle_key < b.cut
      and p.difficulty between min_difficulty and max_difficulty
      and (kinds       is null or p.kind = any(kinds))
      and (any_tags    is null or p.tags && any_tags)
      and (exclude_ids is null or not (p.id = any(exclude_ids)))
    order by p.shuffle_key
    limit sample_size
  )
  limit sample_size;
$$;

grant execute on function public.sample_puzzles(integer, integer, integer, text[], text[], text[])
  to anon, authenticated;

/**
 * How many puzzles match a filter.
 *
 * The site shows "1 of N". With the whole bank in memory N was just the array
 * length; sampling a page means asking.
 */
create or replace function public.count_puzzles(
  min_difficulty integer default 0,
  max_difficulty integer default 100,
  kinds          text[]  default null,
  any_tags       text[]  default null
)
returns integer
language sql
stable
as $$
  select count(*)::integer from public.puzzles p
  where p.difficulty between min_difficulty and max_difficulty
    and (kinds    is null or p.kind = any(kinds))
    and (any_tags is null or p.tags && any_tags);
$$;

grant execute on function public.count_puzzles(integer, integer, text[], text[])
  to anon, authenticated;

-- Sampling filters on difficulty before it filters on the shuffle key, so the
-- index has to lead with difficulty to be useful for a narrowed band.
create index if not exists puzzles_band_idx on public.puzzles (difficulty, shuffle_key);
