-- Assertions for the Glicko-2 implementation.
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/glicko2.sql
--
-- Raises on failure and prints nothing on success. Not part of `npm test`,
-- which must run without a database.
--
-- The first case is the one that matters: Glickman's own worked example from the
-- Glicko-2 paper, which publishes the expected outputs. An implementation of
-- this algorithm can be subtly wrong in ways that still produce plausible
-- ratings — a sign error in the volatility solver, or the wrong convergence
-- test — and nothing about the resulting numbers would look suspicious.

do $$
declare
  r record;
begin
  -- Player 1500/200/0.06 versus 1400/30, 1550/100, 1700/300, scoring 1, 0, 0.
  -- Paper: r' = 1464.06, RD' = 151.52, sigma' = 0.05999.
  select * into r from public.glicko2_update(
    1500, 200, 0.06,
    array[1400.0, 1550.0, 1700.0],
    array[30.0, 100.0, 300.0],
    array[1.0, 0.0, 0.0]
  );

  if abs(r.new_rating - 1464.06) > 0.05 then
    raise exception 'rating: expected ~1464.06, got %', r.new_rating;
  end if;
  if abs(r.new_rd - 151.52) > 0.05 then
    raise exception 'rd: expected ~151.52, got %', r.new_rd;
  end if;
  if abs(r.new_volatility - 0.05999) > 0.00002 then
    raise exception 'volatility: expected ~0.05999, got %', r.new_volatility;
  end if;

  -- Winning against a stronger opponent must raise the rating, losing must lower
  -- it, and the deviation must shrink once there is evidence.
  select * into r from public.glicko2_update(1500, 200, 0.06, array[1800.0], array[50.0], array[1.0]);
  if r.new_rating <= 1500 then
    raise exception 'beating a stronger opponent lowered the rating: %', r.new_rating;
  end if;
  if r.new_rd >= 200 then
    raise exception 'a played game did not reduce the deviation: %', r.new_rd;
  end if;

  select * into r from public.glicko2_update(1500, 200, 0.06, array[1200.0], array[50.0], array[0.0]);
  if r.new_rating >= 1500 then
    raise exception 'losing to a weaker opponent raised the rating: %', r.new_rating;
  end if;

  -- A rating period with no games leaves the rating alone but widens the
  -- deviation: confidence decays with disuse.
  select * into r from public.glicko2_update(1600, 100, 0.06, array[]::double precision[], array[]::double precision[], array[]::double precision[]);
  if r.new_rating <> 1600 then
    raise exception 'an empty period moved the rating: %', r.new_rating;
  end if;
  if r.new_rd <= 100 then
    raise exception 'an empty period did not widen the deviation: %', r.new_rd;
  end if;

  -- The deviation is capped, or an unplayed puzzle drifts to nonsense.
  select * into r from public.glicko2_update(1500, 350, 0.06, array[]::double precision[], array[]::double precision[], array[]::double precision[]);
  if r.new_rd > 350 then
    raise exception 'deviation exceeded its cap: %', r.new_rd;
  end if;

  raise notice 'glicko2: all assertions passed';
end;
$$;
