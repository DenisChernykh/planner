CREATE TABLE notification_attempts (
  id UUID PRIMARY KEY,
  intent_id UUID NOT NULL,
  occurrence_id UUID NOT NULL,
  space_id UUID NOT NULL,
  recipient_member_id UUID NOT NULL,
  attempt_number INTEGER NOT NULL,
  state VARCHAR(16) NOT NULL,
  fencing_token BIGINT NOT NULL DEFAULT 0,
  outcome VARCHAR(16),
  outcome_reason VARCHAR(32),
  provider_retry_after_sec INTEGER,
  started_at TIMESTAMPTZ(3),
  completed_at TIMESTAMPTZ(3),
  created_at TIMESTAMPTZ(3) NOT NULL,
  updated_at TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT notification_attempts_state_check
    CHECK (state IN ('prepared', 'dispatching', 'terminal')),
  CONSTRAINT notification_attempts_number_check
    CHECK (attempt_number > 0),
  CONSTRAINT notification_attempts_fence_check
    CHECK (fencing_token >= 0),
  CONSTRAINT notification_attempts_outcome_check
    CHECK (outcome IS NULL OR outcome IN ('accepted', 'retryable', 'terminal', 'ambiguous')),
  CONSTRAINT notification_attempts_reason_check
    CHECK (outcome_reason IS NULL OR outcome_reason IN (
      'rate_limited', 'provider_error', 'blocked', 'chat_not_found',
      'provider_rejected', 'expired', 'superseded', 'timeout', 'aborted',
      'transport_error', 'malformed_response', 'oversized_response'
    )),
  CONSTRAINT notification_attempts_retry_after_check
    CHECK (provider_retry_after_sec IS NULL OR provider_retry_after_sec > 0),
  CONSTRAINT notification_attempts_state_effect_check
    CHECK (
      (state = 'prepared' AND outcome IS NULL AND started_at IS NULL AND completed_at IS NULL)
      OR (state = 'dispatching' AND outcome IS NULL AND started_at IS NOT NULL AND completed_at IS NULL)
      OR (state = 'terminal' AND outcome IS NOT NULL AND started_at IS NOT NULL AND completed_at IS NOT NULL)
    ),
  CONSTRAINT notification_attempts_outcome_reason_consistency_check
    CHECK (
      (outcome = 'accepted' AND outcome_reason IS NULL AND provider_retry_after_sec IS NULL)
      OR (outcome = 'retryable' AND outcome_reason IN ('rate_limited', 'provider_error'))
      OR (outcome = 'terminal' AND outcome_reason IN ('blocked', 'chat_not_found', 'provider_rejected', 'expired', 'superseded') AND provider_retry_after_sec IS NULL)
      OR (outcome = 'ambiguous' AND outcome_reason IN ('timeout', 'aborted', 'transport_error', 'malformed_response', 'oversized_response') AND provider_retry_after_sec IS NULL)
      OR (outcome IS NULL AND outcome_reason IS NULL AND provider_retry_after_sec IS NULL)
    ),
  CONSTRAINT notification_attempts_intent_fkey
    FOREIGN KEY (intent_id)
    REFERENCES notification_intents(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT notification_attempts_occurrence_fkey
    FOREIGN KEY (occurrence_id)
    REFERENCES reminder_occurrences(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT notification_attempts_recipient_fkey
    FOREIGN KEY (space_id, recipient_member_id)
    REFERENCES memberships(space_id, id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT notification_attempts_identity_key
  UNIQUE (intent_id, attempt_number)
);

ALTER TABLE notification_intents
  ADD CONSTRAINT notification_intents_identity_key
  UNIQUE (id, occurrence_id, space_id, recipient_member_id);

ALTER TABLE notification_attempts
  ADD CONSTRAINT notification_attempts_intent_identity_fkey
  FOREIGN KEY (intent_id, occurrence_id, space_id, recipient_member_id)
  REFERENCES notification_intents(id, occurrence_id, space_id, recipient_member_id)
  ON UPDATE RESTRICT ON DELETE RESTRICT;

INSERT INTO notification_attempts
  (id, intent_id, occurrence_id, space_id, recipient_member_id,
   attempt_number, state, fencing_token, created_at, updated_at)
SELECT gen_random_uuid(), id, occurrence_id, space_id, recipient_member_id,
       1, 'prepared', 0, created_at, created_at
  FROM notification_intents;

CREATE INDEX notification_attempts_state_created_idx
  ON notification_attempts (state, created_at, id);

CREATE INDEX notification_attempts_occurrence_number_idx
  ON notification_attempts (occurrence_id, attempt_number);

CREATE INDEX notification_attempts_recipient_outcome_idx
  ON notification_attempts (space_id, recipient_member_id, outcome, completed_at);

CREATE OR REPLACE FUNCTION guard_notification_attempt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.intent_id <> OLD.intent_id
     OR NEW.occurrence_id <> OLD.occurrence_id
     OR NEW.space_id <> OLD.space_id
     OR NEW.recipient_member_id <> OLD.recipient_member_id
     OR NEW.attempt_number <> OLD.attempt_number
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Notification attempt identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'terminal' THEN
    RAISE EXCEPTION 'Terminal notification attempt is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'dispatching' AND NEW.state NOT IN ('dispatching', 'terminal') THEN
    RAISE EXCEPTION 'Dispatching notification attempt has an invalid transition'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'prepared' AND NEW.state NOT IN ('prepared', 'dispatching', 'terminal') THEN
    RAISE EXCEPTION 'Prepared notification attempt has an invalid transition'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notification_attempts_identity_immutable
BEFORE UPDATE ON notification_attempts
FOR EACH ROW EXECUTE FUNCTION guard_notification_attempt_mutation();

CREATE OR REPLACE FUNCTION reject_notification_attempt_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Notification attempts are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER notification_attempts_no_delete
BEFORE DELETE ON notification_attempts
FOR EACH ROW EXECUTE FUNCTION reject_notification_attempt_delete();
