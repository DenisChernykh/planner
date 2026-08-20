ALTER TABLE telegram_action_intents
  ADD COLUMN text_result VARCHAR(16),
  ADD COLUMN checklist_item_id UUID,
  ADD COLUMN checklist_item_state VARCHAR(16),
  ADD COLUMN or_variant_id UUID,
  ADD COLUMN text_value TEXT,
  ADD COLUMN or_variant_value TEXT;

DROP TRIGGER telegram_action_intents_guard ON telegram_action_intents;
DROP FUNCTION guard_telegram_action_intent();

ALTER TABLE telegram_action_intents
  DROP CONSTRAINT telegram_action_intents_kind_check,
  DROP CONSTRAINT telegram_action_intents_value_check,
  DROP CONSTRAINT telegram_action_intents_checkpoint_check;

ALTER TABLE telegram_action_intents
  ADD CONSTRAINT telegram_action_intents_kind_check CHECK (
    intent_kind IN (
      'boolean', 'quantity', 'actual_time', 'rating',
      'checkpoint_boolean', 'checkpoint_actual_time', 'checkpoint_rating',
      'text', 'checkpoint_text', 'checklist_item',
      'checkpoint_checklist_item', 'or_variant',
      'checkpoint_or_variant', 'composite_checklist_item',
      'composite_or_variant'
    )
  ),
  ADD CONSTRAINT telegram_action_intents_value_check CHECK ((
    (
      intent_kind IN ('boolean', 'checkpoint_boolean')
      AND boolean_result IN ('done', 'not_done')
      AND text_result IS NULL
      AND checklist_item_id IS NULL
      AND checklist_item_state IS NULL
      AND or_variant_id IS NULL
      AND quantity_value IS NULL
      AND actual_time_value IS NULL
      AND rating_value IS NULL
      AND text_value IS NULL
      AND or_variant_value IS NULL
      AND state <> 'offered'
      AND command_fingerprint IS NOT NULL
    ) OR (
      intent_kind IN (
        'checklist_item', 'checkpoint_checklist_item',
        'composite_checklist_item'
      )
      AND boolean_result IS NULL
      AND text_result IS NULL
      AND checklist_item_id IS NOT NULL
      AND checklist_item_state IN ('done', 'not_done')
      AND or_variant_id IS NULL
      AND quantity_value IS NULL
      AND actual_time_value IS NULL
      AND rating_value IS NULL
      AND text_value IS NULL
      AND or_variant_value IS NULL
      AND state IN ('ready', 'completed', 'expired')
      AND command_fingerprint IS NOT NULL
    ) OR (
      intent_kind IN (
        'quantity', 'actual_time', 'rating',
        'checkpoint_actual_time', 'checkpoint_rating',
        'text', 'checkpoint_text', 'or_variant',
        'checkpoint_or_variant', 'composite_or_variant'
      )
      AND boolean_result IS NULL
      AND (
        (
          intent_kind IN ('text', 'checkpoint_text')
          AND text_result IN ('done', 'not_done')
        ) OR (
          intent_kind NOT IN ('text', 'checkpoint_text')
          AND text_result IS NULL
        )
      )
      AND (
        (
          state IN ('offered', 'awaiting_value', 'expired')
          AND command_fingerprint IS NULL
          AND quantity_value IS NULL
          AND actual_time_value IS NULL
          AND rating_value IS NULL
          AND text_value IS NULL
          AND or_variant_value IS NULL
        ) OR (
          state IN ('ready', 'completed', 'expired')
          AND command_fingerprint IS NOT NULL
          AND (
            (
              intent_kind = 'quantity'
              AND quantity_value ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
              AND actual_time_value IS NULL
              AND rating_value IS NULL
              AND text_value IS NULL
              AND or_variant_value IS NULL
            ) OR (
              intent_kind IN ('actual_time', 'checkpoint_actual_time')
              AND quantity_value IS NULL
              AND actual_time_value IS NOT NULL
              AND rating_value IS NULL
              AND text_value IS NULL
              AND or_variant_value IS NULL
            ) OR (
              intent_kind IN ('rating', 'checkpoint_rating')
              AND quantity_value IS NULL
              AND actual_time_value IS NULL
              AND rating_value BETWEEN -9007199254740991 AND 9007199254740991
              AND text_value IS NULL
              AND or_variant_value IS NULL
            ) OR (
              intent_kind IN ('text', 'checkpoint_text')
              AND quantity_value IS NULL
              AND actual_time_value IS NULL
              AND rating_value IS NULL
              AND text_result IN ('done', 'not_done')
              AND text_value IS NOT NULL
              AND btrim(text_value) <> ''
              AND or_variant_value IS NULL
            ) OR (
              intent_kind IN (
                'or_variant', 'checkpoint_or_variant',
                'composite_or_variant'
              )
              AND quantity_value IS NULL
              AND actual_time_value IS NULL
              AND rating_value IS NULL
              AND text_value IS NULL
              AND or_variant_id IS NOT NULL
              AND or_variant_value ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
            )
          )
        )
      )
    )
  ) IS TRUE),
  ADD CONSTRAINT telegram_action_intents_checkpoint_check CHECK (
    (
      intent_kind LIKE 'checkpoint\_%' ESCAPE '\'
      AND checkpoint_id IS NOT NULL
    ) OR (
      intent_kind NOT LIKE 'checkpoint\_%' ESCAPE '\'
      AND checkpoint_id IS NULL
    )
  ),
  ADD CONSTRAINT telegram_action_intents_component_check CHECK (
    (
      intent_kind IN (
        'checklist_item', 'checkpoint_checklist_item',
        'composite_checklist_item'
      )
      AND checklist_item_id IS NOT NULL
    ) OR (
      intent_kind NOT IN (
        'checklist_item', 'checkpoint_checklist_item',
        'composite_checklist_item'
      )
      AND checklist_item_id IS NULL
    )
  ),
  ADD CONSTRAINT telegram_action_intents_variant_check CHECK (
    (
      intent_kind IN (
        'or_variant', 'checkpoint_or_variant', 'composite_or_variant'
      )
      AND or_variant_id IS NOT NULL
    ) OR (
      intent_kind NOT IN (
        'or_variant', 'checkpoint_or_variant', 'composite_or_variant'
      )
      AND or_variant_id IS NULL
    )
  ),
  ADD CONSTRAINT telegram_action_intents_checklist_state_check CHECK ((
    (
      intent_kind IN (
        'checklist_item', 'checkpoint_checklist_item',
        'composite_checklist_item'
      )
      AND checklist_item_state IN ('done', 'not_done')
    ) OR (
      intent_kind NOT IN (
        'checklist_item', 'checkpoint_checklist_item',
        'composite_checklist_item'
      )
      AND checklist_item_state IS NULL
    )
  ) IS TRUE);

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
       OR NEW.checkpoint_id IS DISTINCT FROM OLD.checkpoint_id
       OR NEW.boolean_result IS DISTINCT FROM OLD.boolean_result
       OR NEW.text_result IS DISTINCT FROM OLD.text_result
       OR NEW.checklist_item_id IS DISTINCT FROM OLD.checklist_item_id
       OR NEW.checklist_item_state IS DISTINCT FROM OLD.checklist_item_state
       OR NEW.or_variant_id IS DISTINCT FROM OLD.or_variant_id
       OR NEW.expires_at <> OLD.expires_at
       OR NEW.created_at <> OLD.created_at
       OR NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION 'telegram action intent identity is immutable'
        USING ERRCODE = '55000';
    END IF;

    IF NOT (
      (
        OLD.state = 'awaiting_value' AND NEW.state = 'ready'
        AND (
          NEW.quantity_value IS DISTINCT FROM OLD.quantity_value
          OR NEW.actual_time_value IS DISTINCT FROM OLD.actual_time_value
          OR NEW.rating_value IS DISTINCT FROM OLD.rating_value
          OR NEW.text_value IS DISTINCT FROM OLD.text_value
          OR NEW.or_variant_value IS DISTINCT FROM OLD.or_variant_value
        )
        AND NEW.command_fingerprint IS NOT NULL
      ) OR (
        OLD.state = 'ready' AND NEW.state = 'awaiting_value'
        AND NEW.quantity_value IS NULL
        AND NEW.actual_time_value IS NULL
        AND NEW.rating_value IS NULL
        AND NEW.text_value IS NULL
        AND NEW.or_variant_value IS NULL
        AND NEW.command_fingerprint IS NULL
      ) OR (
        NEW.quantity_value IS NOT DISTINCT FROM OLD.quantity_value
        AND NEW.actual_time_value IS NOT DISTINCT FROM OLD.actual_time_value
        AND NEW.rating_value IS NOT DISTINCT FROM OLD.rating_value
        AND NEW.text_value IS NOT DISTINCT FROM OLD.text_value
        AND NEW.or_variant_value IS NOT DISTINCT FROM OLD.or_variant_value
        AND NEW.command_fingerprint IS NOT DISTINCT FROM OLD.command_fingerprint
      )
    ) THEN
      RAISE EXCEPTION 'telegram action intent payload transition is invalid'
        USING ERRCODE = '55000';
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
      OR (OLD.state = 'ready' AND NEW.state IN ('awaiting_value', 'completed', 'expired'))
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
