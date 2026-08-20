ALTER TABLE reminder_occurrences
  DROP CONSTRAINT reminder_occurrences_state_check;

ALTER TABLE reminder_occurrences
  ADD CONSTRAINT reminder_occurrences_state_check
  CHECK (state IN ('pending', 'claimed', 'cancelled', 'expired', 'suppressed'));

CREATE TABLE notification_intents (
  id UUID PRIMARY KEY,
  occurrence_id UUID NOT NULL,
  space_id UUID NOT NULL,
  recipient_member_id UUID NOT NULL,
  publication_id UUID NOT NULL,
  local_date DATE NOT NULL,
  slot_kind VARCHAR(16) NOT NULL,
  source_facts_revision BIGINT NOT NULL,
  intent_revision BIGINT NOT NULL,
  content_schema_version VARCHAR(100) NOT NULL,
  content JSONB NOT NULL,
  content_hash CHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ(3) NOT NULL,
  supersedes_intent_id UUID,
  created_at TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT notification_intents_kind_check
    CHECK (slot_kind IN ('morning', 'day', 'evening')),
  CONSTRAINT notification_intents_revision_check
    CHECK (source_facts_revision >= 0 AND intent_revision > 0),
  CONSTRAINT notification_intents_content_check
    CHECK (jsonb_typeof(content) = 'object'),
  CONSTRAINT notification_intents_hash_check
    CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT notification_intents_time_check
    CHECK (expires_at > created_at),
  CONSTRAINT notification_intents_not_self_superseded_check
    CHECK (supersedes_intent_id IS NULL OR supersedes_intent_id <> id),
  CONSTRAINT notification_intents_occurrence_fkey
    FOREIGN KEY (occurrence_id)
    REFERENCES reminder_occurrences(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT notification_intents_recipient_fkey
    FOREIGN KEY (space_id, recipient_member_id)
    REFERENCES memberships(space_id, id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT notification_intents_publication_fkey
    FOREIGN KEY (space_id, publication_id)
    REFERENCES plan_publications(space_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT notification_intents_supersedes_fkey
    FOREIGN KEY (supersedes_intent_id)
    REFERENCES notification_intents(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT notification_intents_occurrence_identity_key
    UNIQUE (occurrence_id, intent_revision),
  CONSTRAINT notification_intents_occurrence_content_key
    UNIQUE (occurrence_id, source_facts_revision, content_hash)
);

CREATE INDEX notification_intents_latest_idx
  ON notification_intents (occurrence_id, intent_revision DESC);

CREATE INDEX notification_intents_recipient_expiry_idx
  ON notification_intents (space_id, recipient_member_id, expires_at);

CREATE OR REPLACE FUNCTION reject_notification_intent_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Notification intents are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER notification_intents_immutable_update
BEFORE UPDATE ON notification_intents
FOR EACH ROW EXECUTE FUNCTION reject_notification_intent_mutation();

CREATE TRIGGER notification_intents_immutable_delete
BEFORE DELETE ON notification_intents
FOR EACH ROW EXECUTE FUNCTION reject_notification_intent_mutation();
