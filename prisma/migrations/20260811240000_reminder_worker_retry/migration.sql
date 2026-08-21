ALTER TABLE reminder_occurrences
  DROP CONSTRAINT reminder_occurrences_state_check;

ALTER TABLE reminder_occurrences
  ADD CONSTRAINT reminder_occurrences_state_check
  CHECK (state IN ('pending', 'claimed', 'cancelled', 'expired', 'suppressed', 'terminal'));

ALTER TABLE notification_attempts
  ADD COLUMN next_attempt_at TIMESTAMPTZ(3);

ALTER TABLE notification_attempts
  ADD CONSTRAINT notification_attempts_next_attempt_check
  CHECK (next_attempt_at IS NULL OR (state = 'terminal' AND outcome = 'retryable'));

CREATE INDEX notification_attempts_occurrence_next_attempt_idx
  ON notification_attempts (occurrence_id, next_attempt_at, id);
