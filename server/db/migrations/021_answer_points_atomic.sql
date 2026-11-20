-- ============================================================
-- NEXORA 021 — an answer's points move in the same transaction as the answer
-- Run after 016_vote_points.sql (needs apply_vote_points) and
-- 005_hardening.sql (needs compute_badges). Safe to re-run.
-- ============================================================
--
-- Three routes changed an author's points in a separate statement from the row
-- that earned them, and two of them wrote the balance back from a stale copy.
--
-- 1. POST /api/answers/:id/vote wrote (or deleted) the vote row, then called
--    apply_vote_points. Anything failing in between -- a timeout, a function
--    missing at runtime -- left the vote recorded and the points not moved.
--    Decision 0006 recorded this as the residual it did not fix.
--
-- 2. POST /api/answers/:questionId inserted the answer, then wrote
--    `points = req.userRow.points + 5` -- the balance read when the request
--    started. A vote that landed on any of the author's answers in between was
--    silently reverted. The exact lost update 016 fixed for votes.
--
-- 3. DELETE /api/answers/:id did the same in reverse: `points - 5` from the
--    stale copy, then deleted the answer in a separate statement.
--
-- Each is now one function, one transaction: the row and the points commit
-- together or not at all, and the balance is read under a row lock.
--
-- Behaviour is otherwise unchanged and deliberately so: the same deltas, the
-- same floors at zero, the same points_applied bookkeeping from 016, the same
-- one-shot 5-upvote bonus. Only the atomicity changes.
--
-- Lock order is answer, then author, everywhere here, so these cannot deadlock
-- against each other. transfer_points (005) locks only users.
--
-- What this does NOT touch: no table, column or row. Three functions are added.

-- ------------------------------------------------------------
-- 1. cast_answer_vote
-- ------------------------------------------------------------
-- Votes on one answer serialise on the answer row. That lock also makes the
-- 5-upvote bonus exact: the old route used a conditional UPDATE to award it
-- once, which this keeps, but the count it compared against is now read under
-- the same lock as the vote it counts.
CREATE OR REPLACE FUNCTION cast_answer_vote(
  p_answer_id UUID,
  p_voter_id  UUID,
  p_type      TEXT
)
RETURNS TABLE (up_count INT, down_count INT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_author           UUID;
  v_bonus_done       BOOLEAN;
  v_author_points    INT;
  v_existing_type    TEXT;
  v_existing_applied BOOLEAN;
  v_points_delta     INT := 0;
  v_upvotes_delta    INT := 0;
  v_applied          BOOLEAN := FALSE;
  v_ups              INT;
BEGIN
  IF p_type IS NULL OR p_type NOT IN ('up', 'down') THEN
    RAISE EXCEPTION 'vote type must be up or down' USING ERRCODE = 'check_violation';
  END IF;

  SELECT a.author_id, COALESCE(a.bonus_points_awarded, FALSE)
    INTO v_author, v_bonus_done
    FROM answers a
   WHERE a.id = p_answer_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'answer not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_author = p_voter_id THEN
    RAISE EXCEPTION 'cannot vote on own answer' USING ERRCODE = 'check_violation';
  END IF;

  -- The downvote floor depends on the author's balance, so read it locked.
  SELECT COALESCE(u.points, 0) INTO v_author_points
    FROM users u WHERE u.id = v_author FOR UPDATE;

  SELECT v.vote_type, v.points_applied
    INTO v_existing_type, v_existing_applied
    FROM answer_votes v
   WHERE v.answer_id = p_answer_id AND v.user_id = p_voter_id;

  IF p_type = 'up' THEN
    IF v_existing_type = 'up' THEN
      -- Tapping up again removes the upvote.
      DELETE FROM answer_votes v WHERE v.answer_id = p_answer_id AND v.user_id = p_voter_id;
      v_upvotes_delta := -1;
    ELSE
      -- Switching from down returns a point only if one was taken (016).
      IF v_existing_type = 'down' AND v_existing_applied IS DISTINCT FROM FALSE THEN
        v_points_delta := v_points_delta + 1;
      END IF;
      v_upvotes_delta := 1;
      INSERT INTO answer_votes (answer_id, user_id, vote_type, points_applied)
      VALUES (p_answer_id, p_voter_id, 'up', FALSE)
      ON CONFLICT (answer_id, user_id)
      DO UPDATE SET vote_type = 'up', points_applied = FALSE;
    END IF;
  ELSIF v_existing_type = 'down' THEN
    -- Tapping down again removes the downvote, restoring only what was taken.
    DELETE FROM answer_votes v WHERE v.answer_id = p_answer_id AND v.user_id = p_voter_id;
    IF v_existing_applied IS DISTINCT FROM FALSE THEN
      v_points_delta := 1;
    END IF;
  ELSE
    IF v_existing_type = 'up' THEN
      v_upvotes_delta := -1;
    END IF;
    -- At zero the floor means nothing is deducted; record that on the vote.
    v_applied := v_author_points > 0;
    IF v_applied THEN
      v_points_delta := -1;
    END IF;
    INSERT INTO answer_votes (answer_id, user_id, vote_type, points_applied)
    VALUES (p_answer_id, p_voter_id, 'down', v_applied)
    ON CONFLICT (answer_id, user_id)
    DO UPDATE SET vote_type = 'down', points_applied = EXCLUDED.points_applied;
  END IF;

  -- The one-shot bonus at five upvotes.
  IF p_type = 'up' AND v_existing_type IS DISTINCT FROM 'up' AND NOT v_bonus_done THEN
    SELECT count(*) INTO v_ups
      FROM answer_votes v
     WHERE v.answer_id = p_answer_id AND v.vote_type = 'up';
    IF v_ups >= 5 THEN
      UPDATE answers a SET bonus_points_awarded = TRUE WHERE a.id = p_answer_id;
      v_points_delta := v_points_delta + 5;
    END IF;
  END IF;

  -- Same transaction as the vote row. Also recomputes badges, as before.
  PERFORM apply_vote_points(v_author, v_points_delta, v_upvotes_delta);

  RETURN QUERY
    SELECT (count(*) FILTER (WHERE v.vote_type = 'up'))::INT,
           (count(*) FILTER (WHERE v.vote_type = 'down'))::INT
      FROM answer_votes v
     WHERE v.answer_id = p_answer_id;
END;
$$;

-- ------------------------------------------------------------
-- 2. create_answer
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_answer(
  p_question_id UUID,
  p_author_id   UUID,
  p_body        TEXT
)
RETURNS TABLE (new_answer_id UUID, author_points INT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_id      UUID;
  v_points  INT;
  v_answers INT;
BEGIN
  IF p_body IS NULL OR btrim(p_body) = '' THEN
    RAISE EXCEPTION 'answer body is required' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM 1 FROM questions q WHERE q.id = p_question_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'question not found' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT COALESCE(u.points, 0), COALESCE(u.total_answers, 0)
    INTO v_points, v_answers
    FROM users u WHERE u.id = p_author_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user not found' USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO answers (question_id, author_id, body, points_awarded)
  VALUES (p_question_id, p_author_id, p_body, TRUE)
  RETURNING answers.id INTO v_id;

  v_points  := v_points + 5;
  v_answers := v_answers + 1;

  UPDATE users u
     SET points = v_points,
         total_answers = v_answers,
         badges = compute_badges(v_points, v_answers)
   WHERE u.id = p_author_id;

  RETURN QUERY SELECT v_id, v_points;
END;
$$;

-- ------------------------------------------------------------
-- 3. delete_answer
-- ------------------------------------------------------------
-- Takes back the +5 and the bonus, each floored at zero as before, clears the
-- accepted-answer pointer, and deletes the answer (its votes cascade).
CREATE OR REPLACE FUNCTION delete_answer(
  p_answer_id UUID,
  p_author_id UUID
)
RETURNS TABLE (author_points INT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_author  UUID;
  v_awarded BOOLEAN;
  v_bonus   BOOLEAN;
  v_points  INT;
  v_answers INT;
BEGIN
  SELECT a.author_id, a.points_awarded IS TRUE, a.bonus_points_awarded IS TRUE
    INTO v_author, v_awarded, v_bonus
    FROM answers a WHERE a.id = p_answer_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'answer not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_author <> p_author_id THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT COALESCE(u.points, 0), COALESCE(u.total_answers, 0)
    INTO v_points, v_answers
    FROM users u WHERE u.id = v_author FOR UPDATE;

  IF v_awarded THEN v_points := GREATEST(0, v_points - 5); END IF;
  IF v_bonus   THEN v_points := GREATEST(0, v_points - 5); END IF;
  v_answers := GREATEST(0, v_answers - 1);

  UPDATE users u
     SET points = v_points,
         total_answers = v_answers,
         badges = compute_badges(v_points, v_answers)
   WHERE u.id = v_author;

  UPDATE questions q
     SET accepted_answer_id = NULL, is_resolved = FALSE
   WHERE q.accepted_answer_id = p_answer_id;

  DELETE FROM answers a WHERE a.id = p_answer_id;

  RETURN QUERY SELECT v_points;
END;
$$;

-- ============================================================
-- Reversibility
-- ============================================================
-- Adds three functions; no data changes. To undo:
--
--   DROP FUNCTION IF EXISTS cast_answer_vote(UUID, UUID, TEXT);
--   DROP FUNCTION IF EXISTS create_answer(UUID, UUID, TEXT);
--   DROP FUNCTION IF EXISTS delete_answer(UUID, UUID);
--
-- and redeploy the routes from before this change. With the functions absent,
-- the new routes answer 503 naming this file rather than falling back.
