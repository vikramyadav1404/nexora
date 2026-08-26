-- ============================================================
-- NEXORA 016 — votes stop minting points, and stop losing them
-- Run after 015_quota.sql. Safe to re-run.
-- ============================================================
--
-- Two defects in the answer-vote handler, both about `users.points`.
--
-- ------------------------------------------------------------
-- 1. Undoing a clamped downvote created points from nothing
-- ------------------------------------------------------------
-- The downvote path deducts with a floor:
--
--     points = Math.max(0, points - 1);
--
-- and the undo path restores unconditionally:
--
--     points = Math.max(0, points + 1);
--
-- Nothing recorded whether the deduction actually happened. An author sitting
-- at 0 points is at that floor permanently, so every downvote against them
-- deducted nothing -- and every subsequent undo credited a point that was never
-- taken. Two voters downvoting and then removing their downvotes left the
-- author with 2 points they never earned; N voters left N.
--
-- New accounts start at 0, so this fires on exactly the users least able to
-- absorb it.
--
-- The fix needs a fact the schema did not hold: was a point actually deducted
-- for THIS vote. That is what points_applied records.
--
-- Existing rows default to TRUE rather than FALSE. Both are guesses about votes
-- cast before this column existed; TRUE preserves the current behaviour for
-- them, and clamping only bites at 0 points, which is the uncommon case. FALSE
-- would silently refuse to restore points that really were deducted.

ALTER TABLE answer_votes
  ADD COLUMN IF NOT EXISTS points_applied BOOLEAN NOT NULL DEFAULT TRUE;

-- ------------------------------------------------------------
-- 2. Every vote wrote the author's points back from a stale read
-- ------------------------------------------------------------
-- The handler read the author row once, mutated `points` in JavaScript across
-- several awaits, then wrote the absolute value back -- unconditionally, even
-- on the upvote path where points had not changed at all.
--
-- So any concurrent change to that author's points was silently reverted. Post
-- an answer (+5) while somebody upvotes an older answer, and the upvote handler
-- writes back the balance it read before the +5. The award is gone.
--
-- Same class as the daily quota in 015 and point transfers in 005: a read and a
-- write with no lock between them. Same remedy -- do the arithmetic inside one
-- statement, against the current row rather than a remembered copy.
--
-- Deltas, not absolutes. The caller says "one less point, one more upvote"; the
-- database decides what that means relative to whatever the row holds now.

CREATE OR REPLACE FUNCTION apply_vote_points(
  p_user_id       UUID,
  p_points_delta  INT,
  p_upvotes_delta INT
)
RETURNS TABLE (points INT, total_upvotes_received INT, badges TEXT[])
LANGUAGE plpgsql
AS $$
DECLARE
  v_points   INT;
  v_upvotes  INT;
  v_answers  INT;
  v_badges   TEXT[] := ARRAY[]::TEXT[];
BEGIN
  -- Serialises concurrent voters on the same author.
  PERFORM 1 FROM users WHERE id = p_user_id FOR UPDATE;

  -- Every read is qualified with `users.`. Two of the OUT columns this function
  -- RETURNS -- `points` and `total_upvotes_received` -- share their names with
  -- the columns being read, so a bare `points` here is ambiguous between the
  -- OUT variable and the table column, and Postgres raises 42702 at call time.
  -- The function was never callable as written; it was only ever exercised by
  -- the JS reimplementation in the test fake, which is why the suite stayed
  -- green while every real vote 500'd. Qualifying the reads resolves it without
  -- changing the RETURNS contract the caller reads.
  SELECT COALESCE(users.points, 0), COALESCE(users.total_upvotes_received, 0), COALESCE(users.total_answers, 0)
    INTO v_points, v_upvotes, v_answers
    FROM users WHERE users.id = p_user_id;

  IF v_points IS NULL THEN
    RAISE EXCEPTION 'user not found' USING ERRCODE = 'no_data_found';
  END IF;

  -- Neither counter may go negative.
  v_points  := GREATEST(0, v_points + p_points_delta);
  v_upvotes := GREATEST(0, v_upvotes + p_upvotes_delta);

  /*
   * Mirrors computeBadges in db/helpers.js.
   *
   * Duplicated deliberately, and the duplication is the cost of doing the
   * arithmetic atomically -- the same trade transfer_points made in 005. If the
   * thresholds change, both have to change. There is a test asserting the two
   * agree.
   */
  IF v_points >= 50  THEN v_badges := array_append(v_badges, 'bronze'); END IF;
  IF v_points >= 200 THEN v_badges := array_append(v_badges, 'silver'); END IF;
  IF v_points >= 500 THEN v_badges := array_append(v_badges, 'gold');   END IF;
  IF v_answers >= 10 THEN v_badges := array_append(v_badges, 'contributor'); END IF;
  IF v_answers >= 50 THEN v_badges := array_append(v_badges, 'expert'); END IF;

  UPDATE users
     SET points = v_points,
         total_upvotes_received = v_upvotes,
         badges = v_badges
   WHERE id = p_user_id;

  RETURN QUERY SELECT v_points, v_upvotes, v_badges;
END;
$$;

-- ============================================================
-- Reversibility
-- ============================================================
-- Adds one column and one function. No row is rewritten -- a NOT NULL column
-- with a constant default is a catalogue-only change in Postgres 11+, so this
-- is safe on a live table. To undo:
--
--   DROP FUNCTION IF EXISTS apply_vote_points(UUID, INT, INT);
--   ALTER TABLE answer_votes DROP COLUMN IF EXISTS points_applied;
--
-- The route falls back to the old read-modify-write when the function is
-- absent (PGRST202) and treats a missing points_applied as TRUE, so the
-- application keeps working either way -- it simply goes back to being wrong
-- under concurrency and at the zero-point floor.
