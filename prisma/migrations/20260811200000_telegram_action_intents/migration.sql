CREATE TABLE telegram_action_intents (
  id UUID PRIMARY KEY,
  semantic_key CHAR(64) NOT NULL,
  command_id UUID NOT NULL UNIQUE,
  space_id UUID NOT NULL,
  member_id UUID NOT NULL,
  publication_id UUID NOT NULL,
  plan_goal_snapshot_id UUID NOT NULL,
  local_date DATE NOT NULL,
  source_facts_revision BIGINT NOT NULL,
  intent_kind VARCHAR(16) NOT NULL,
  state VARCHAR(24) NOT NULL,
  boolean_result VARCHAR(16),
  quantity_value TEXT,
  command_fingerprint CHAR(64),
  result_kind VARCHAR(128),
  result_aggregate_id UUID,
  result_aggregate_revision BIGINT,
  expires_at TIMESTAMPTZ(3) NOT NULL,
  completed_at TIMESTAMPTZ(3),
  created_at TIMESTAMPTZ(3) NOT NULL,
  updated_at TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT telegram_action_intents_command_identity_check
    CHECK (command_id = id),
  CONSTRAINT telegram_action_intents_source_revision_check
    CHECK (source_facts_revision >= 0),
  CONSTRAINT telegram_action_intents_kind_check
    CHECK (intent_kind IN ('boolean', 'quantity')),
  CONSTRAINT telegram_action_intents_state_check
    CHECK (state IN ('offered', 'awaiting_value', 'ready', 'completed', 'expired')),
  CONSTRAINT telegram_action_intents_value_check CHECK (
    (
      intent_kind = 'boolean'
      AND boolean_result IN ('done', 'not_done')
      AND quantity_value IS NULL
      AND state <> 'offered'
      AND command_fingerprint IS NOT NULL
    ) OR (
      intent_kind = 'quantity'
      AND boolean_result IS NULL
      AND (
        (state IN ('offered', 'awaiting_value', 'expired')
         AND quantity_value IS NULL AND command_fingerprint IS NULL)
        OR
        (state IN ('ready', 'completed', 'expired')
         AND quantity_value ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
         AND command_fingerprint IS NOT NULL)
      )
    )
  ),
  CONSTRAINT telegram_action_intents_fingerprint_check
    CHECK (command_fingerprint IS NULL OR command_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT telegram_action_intents_result_check CHECK (
    (
      state = 'completed'
      AND result_kind = 'tracking.fact-record.v1'
      AND result_aggregate_id IS NOT NULL
      AND result_aggregate_revision >= 1
      AND completed_at IS NOT NULL
    ) OR (
      state <> 'completed'
      AND result_kind IS NULL
      AND result_aggregate_id IS NULL
      AND result_aggregate_revision IS NULL
      AND completed_at IS NULL
    )
  ),
  CONSTRAINT telegram_action_intents_time_check
    CHECK (expires_at > created_at AND updated_at >= created_at),
  CONSTRAINT telegram_action_intents_member_fkey
    FOREIGN KEY (space_id, member_id)
    REFERENCES memberships(space_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT telegram_action_intents_publication_fkey
    FOREIGN KEY (space_id, publication_id)
    REFERENCES plan_publications(space_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT telegram_action_intents_snapshot_fkey
    FOREIGN KEY (publication_id, plan_goal_snapshot_id)
    REFERENCES plan_goal_snapshots(publication_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX telegram_action_intents_active_semantic_key
  ON telegram_action_intents(semantic_key)
  WHERE state IN ('offered', 'awaiting_value', 'ready');

CREATE UNIQUE INDEX telegram_action_intents_member_awaiting_key
  ON telegram_action_intents(space_id, member_id)
  WHERE state = 'awaiting_value';

CREATE INDEX telegram_action_intents_member_state_idx
  ON telegram_action_intents(space_id, member_id, state);

CREATE INDEX telegram_action_intents_expiry_idx
  ON telegram_action_intents(expires_at)
  WHERE state IN ('offered', 'awaiting_value', 'ready');

CREATE FUNCTION guard_telegram_action_intent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'telegram action intents cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id
       OR NEW.semantic_key <> OLD.semantic_key
       OR NEW.command_id <> OLD.command_id
       OR NEW.space_id <> OLD.space_id
       OR NEW.member_id <> OLD.member_id
       OR NEW.publication_id <> OLD.publication_id
       OR NEW.plan_goal_snapshot_id <> OLD.plan_goal_snapshot_id
       OR NEW.local_date <> OLD.local_date
       OR NEW.source_facts_revision <> OLD.source_facts_revision
       OR NEW.intent_kind <> OLD.intent_kind
       OR NEW.boolean_result IS DISTINCT FROM OLD.boolean_result
       OR NEW.expires_at <> OLD.expires_at
       OR NEW.created_at <> OLD.created_at
       OR NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION 'telegram action intent identity is immutable'
        USING ERRCODE = '55000';
    END IF;

    IF NEW.state <> 'ready' OR OLD.state <> 'awaiting_value' THEN
      IF NEW.quantity_value IS DISTINCT FROM OLD.quantity_value
         OR NEW.command_fingerprint IS DISTINCT FROM OLD.command_fingerprint
      THEN
        RAISE EXCEPTION 'telegram action intent payload transition is invalid'
          USING ERRCODE = '55000';
      END IF;
    END IF;

    IF NEW.state <> 'completed' OR OLD.state <> 'ready' THEN
      IF NEW.result_kind IS DISTINCT FROM OLD.result_kind
         OR NEW.result_aggregate_id IS DISTINCT FROM OLD.result_aggregate_id
         OR NEW.result_aggregate_revision IS DISTINCT FROM OLD.result_aggregate_revision
         OR NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
        RAISE EXCEPTION 'telegram action intent result transition is invalid'
          USING ERRCODE = '55000';
      END IF;
    END IF;

    IF NOT (
      (OLD.state = 'offered' AND NEW.state IN ('awaiting_value', 'expired'))
      OR (OLD.state = 'awaiting_value' AND NEW.state IN ('ready', 'expired'))
      OR (OLD.state = 'ready' AND NEW.state IN ('completed', 'expired'))
    ) THEN
      RAISE EXCEPTION 'telegram action intent transition is invalid'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER telegram_action_intents_guard
BEFORE UPDATE OR DELETE ON telegram_action_intents
FOR EACH ROW EXECUTE FUNCTION guard_telegram_action_intent();
