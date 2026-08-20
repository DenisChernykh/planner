DROP TRIGGER telegram_action_intents_guard ON telegram_action_intents;
DROP FUNCTION guard_telegram_action_intent();

DROP INDEX telegram_action_intents_active_semantic_key;
DROP INDEX telegram_action_intents_member_awaiting_key;

ALTER TABLE telegram_action_intents
  DROP CONSTRAINT telegram_action_intents_kind_check,
  DROP CONSTRAINT telegram_action_intents_state_check,
  DROP CONSTRAINT telegram_action_intents_value_check,
  DROP CONSTRAINT telegram_action_intents_checkpoint_check,
  DROP CONSTRAINT telegram_action_intents_component_check,
  DROP CONSTRAINT telegram_action_intents_variant_check,
  DROP CONSTRAINT telegram_action_intents_checklist_state_check,
  DROP CONSTRAINT telegram_action_intents_result_check,
  ALTER COLUMN plan_goal_snapshot_id DROP NOT NULL,
  ADD COLUMN fact_record_id UUID,
  ADD COLUMN expected_record_revision BIGINT,
  ADD COLUMN flexible_period_id UUID,
  ADD COLUMN reason TEXT,
  ADD COLUMN close_preview_schema_version VARCHAR(64),
  ADD COLUMN close_preview_hash_version VARCHAR(64),
  ADD COLUMN close_preview_hash CHAR(64),
  ADD COLUMN close_unresolved_count INTEGER;

ALTER TABLE telegram_action_intents
  ADD CONSTRAINT telegram_action_intents_kind_check CHECK (
    intent_kind IN (
      'boolean', 'quantity', 'actual_time', 'rating',
      'checkpoint_boolean', 'checkpoint_actual_time', 'checkpoint_rating',
      'text', 'checkpoint_text', 'checklist_item',
      'checkpoint_checklist_item', 'or_variant',
      'checkpoint_or_variant', 'composite_checklist_item',
      'composite_or_variant',
      'correct_boolean', 'correct_quantity', 'correct_actual_time',
      'correct_rating', 'correct_text', 'correct_checklist_item',
      'correct_or_variant', 'delete_record', 'undo_record', 'close_day',
      'weekly_task_result'
    )
  ),
  ADD CONSTRAINT telegram_action_intents_state_check CHECK (
    state IN (
      'offered', 'awaiting_value', 'awaiting_reason',
      'ready', 'completed', 'expired'
    )
  ),
  ADD CONSTRAINT telegram_action_intents_value_check CHECK ((
    intent_kind IN (
      'correct_boolean', 'correct_quantity', 'correct_actual_time',
      'correct_rating', 'correct_text', 'correct_checklist_item',
      'correct_or_variant', 'delete_record', 'undo_record', 'close_day',
      'weekly_task_result'
    ) OR (
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
          (intent_kind IN ('text', 'checkpoint_text')
           AND text_result IN ('done', 'not_done'))
          OR (intent_kind NOT IN ('text', 'checkpoint_text')
              AND text_result IS NULL)
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
              (intent_kind = 'quantity'
               AND quantity_value ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
               AND actual_time_value IS NULL AND rating_value IS NULL
               AND text_value IS NULL AND or_variant_value IS NULL)
              OR (intent_kind IN ('actual_time', 'checkpoint_actual_time')
                  AND quantity_value IS NULL AND actual_time_value IS NOT NULL
                  AND rating_value IS NULL AND text_value IS NULL
                  AND or_variant_value IS NULL)
              OR (intent_kind IN ('rating', 'checkpoint_rating')
                  AND quantity_value IS NULL AND actual_time_value IS NULL
                  AND rating_value BETWEEN -9007199254740991 AND 9007199254740991
                  AND text_value IS NULL AND or_variant_value IS NULL)
              OR (intent_kind IN ('text', 'checkpoint_text')
                  AND quantity_value IS NULL AND actual_time_value IS NULL
                  AND rating_value IS NULL AND btrim(text_value) <> ''
                  AND or_variant_value IS NULL)
              OR (intent_kind IN (
                    'or_variant', 'checkpoint_or_variant',
                    'composite_or_variant'
                  )
                  AND quantity_value IS NULL AND actual_time_value IS NULL
                  AND rating_value IS NULL AND text_value IS NULL
                  AND or_variant_id IS NOT NULL
                  AND or_variant_value ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$')
            )
          )
        )
      )
    )
  ) IS TRUE),
  ADD CONSTRAINT telegram_action_intents_checkpoint_check CHECK (
    (intent_kind LIKE 'checkpoint\_%' ESCAPE '\' AND checkpoint_id IS NOT NULL)
    OR (intent_kind NOT LIKE 'checkpoint\_%' ESCAPE '\' AND checkpoint_id IS NULL)
  ),
  ADD CONSTRAINT telegram_action_intents_component_check CHECK (
    (intent_kind IN (
       'checklist_item', 'checkpoint_checklist_item',
       'composite_checklist_item'
     ) AND checklist_item_id IS NOT NULL)
    OR (intent_kind NOT IN (
          'checklist_item', 'checkpoint_checklist_item',
          'composite_checklist_item'
        ) AND checklist_item_id IS NULL)
  ),
  ADD CONSTRAINT telegram_action_intents_variant_check CHECK (
    (intent_kind IN (
       'or_variant', 'checkpoint_or_variant', 'composite_or_variant'
     ) AND or_variant_id IS NOT NULL)
    OR (intent_kind NOT IN (
          'or_variant', 'checkpoint_or_variant', 'composite_or_variant'
        ) AND or_variant_id IS NULL)
  ),
  ADD CONSTRAINT telegram_action_intents_checklist_state_check CHECK ((
    (intent_kind IN (
       'checklist_item', 'checkpoint_checklist_item',
       'composite_checklist_item', 'correct_checklist_item'
     ) AND checklist_item_state IN ('done', 'not_done'))
    OR (intent_kind NOT IN (
          'checklist_item', 'checkpoint_checklist_item',
          'composite_checklist_item', 'correct_checklist_item'
        ) AND checklist_item_state IS NULL)
  ) IS TRUE),
  ADD CONSTRAINT telegram_action_intents_tracking_target_check CHECK ((
    (
      intent_kind LIKE 'correct\_%' ESCAPE '\'
      AND plan_goal_snapshot_id IS NOT NULL
      AND fact_record_id IS NOT NULL
      AND expected_record_revision >= 1
      AND flexible_period_id IS NULL
    ) OR (
      intent_kind IN ('delete_record', 'undo_record')
      AND plan_goal_snapshot_id IS NOT NULL
      AND fact_record_id IS NOT NULL
      AND expected_record_revision >= 1
      AND flexible_period_id IS NULL
    ) OR (
      intent_kind = 'weekly_task_result'
      AND plan_goal_snapshot_id IS NOT NULL
      AND fact_record_id IS NULL
      AND expected_record_revision IS NULL
      AND flexible_period_id IS NOT NULL
    ) OR (
      intent_kind = 'close_day'
      AND plan_goal_snapshot_id IS NULL
      AND fact_record_id IS NULL
      AND expected_record_revision IS NULL
      AND flexible_period_id IS NULL
    ) OR (
      intent_kind NOT IN (
        'correct_boolean', 'correct_quantity', 'correct_actual_time',
        'correct_rating', 'correct_text', 'correct_checklist_item',
        'correct_or_variant', 'delete_record', 'undo_record', 'close_day',
        'weekly_task_result'
      )
      AND plan_goal_snapshot_id IS NOT NULL
      AND fact_record_id IS NULL
      AND expected_record_revision IS NULL
      AND flexible_period_id IS NULL
    )
  ) IS TRUE),
  ADD CONSTRAINT telegram_action_intents_tracking_payload_check CHECK ((
    (
      intent_kind LIKE 'correct\_%' ESCAPE '\'
      AND (
        (intent_kind = 'correct_boolean'
         AND boolean_result IN ('done', 'not_done'))
        OR (intent_kind = 'correct_quantity'
            AND (quantity_value IS NULL OR quantity_value ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'))
        OR (intent_kind = 'correct_actual_time')
        OR (intent_kind = 'correct_rating'
            AND (rating_value IS NULL OR rating_value BETWEEN -9007199254740991 AND 9007199254740991))
        OR (intent_kind = 'correct_text'
            AND text_result IN ('done', 'not_done'))
        OR (intent_kind = 'correct_checklist_item'
            AND checklist_item_state IN ('done', 'not_done'))
        OR (intent_kind = 'correct_or_variant'
            AND (or_variant_value IS NULL OR or_variant_value ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'))
      )
      AND (
        (state IN ('offered', 'awaiting_value')
         AND reason IS NULL AND command_fingerprint IS NULL)
        OR (state = 'awaiting_reason'
            AND reason IS NULL AND command_fingerprint IS NULL)
        OR (state IN ('ready', 'completed')
            AND btrim(reason) <> '' AND length(reason) <= 2000
            AND command_fingerprint IS NOT NULL)
        OR state = 'expired'
      )
    ) OR (
      intent_kind = 'delete_record'
      AND (
        (state IN ('offered', 'awaiting_reason')
         AND reason IS NULL AND command_fingerprint IS NULL)
        OR (state IN ('ready', 'completed')
            AND btrim(reason) <> '' AND length(reason) <= 2000
            AND command_fingerprint IS NOT NULL)
        OR state = 'expired'
      )
    ) OR (
      intent_kind = 'undo_record'
      AND state IN ('ready', 'completed', 'expired')
      AND reason IS NULL AND command_fingerprint IS NOT NULL
    ) OR (
      intent_kind = 'weekly_task_result'
      AND boolean_result IN ('done', 'not_done')
      AND state IN ('ready', 'completed', 'expired')
      AND reason IS NULL AND command_fingerprint IS NOT NULL
    ) OR (
      intent_kind = 'close_day'
      AND (
        (state IN ('offered', 'expired')
         AND close_preview_schema_version IS NULL
         AND close_preview_hash_version IS NULL
         AND close_preview_hash IS NULL
         AND close_unresolved_count IS NULL
         AND command_fingerprint IS NULL)
        OR (state IN ('ready', 'completed', 'expired')
            AND close_preview_schema_version = 'tracking.close-day-preview.v1'
            AND close_preview_hash_version = 'tracking.close-day-preview-hash.v1'
            AND close_preview_hash ~ '^[0-9a-f]{64}$'
            AND close_unresolved_count >= 0
            AND command_fingerprint IS NOT NULL)
      )
    ) OR intent_kind NOT IN (
      'correct_boolean', 'correct_quantity', 'correct_actual_time',
      'correct_rating', 'correct_text', 'correct_checklist_item',
      'correct_or_variant', 'delete_record', 'undo_record', 'close_day',
      'weekly_task_result'
    )
  ) IS TRUE),
  ADD CONSTRAINT telegram_action_intents_tracking_exact_shape_check CHECK ((
    intent_kind NOT IN (
      'correct_boolean', 'correct_quantity', 'correct_actual_time',
      'correct_rating', 'correct_text', 'correct_checklist_item',
      'correct_or_variant', 'delete_record', 'undo_record', 'close_day',
      'weekly_task_result'
    ) OR (
      intent_kind LIKE 'correct\_%' ESCAPE '\'
      AND close_preview_schema_version IS NULL
      AND close_preview_hash_version IS NULL
      AND close_preview_hash IS NULL
      AND close_unresolved_count IS NULL
      AND (
        (state IN ('offered', 'awaiting_value', 'awaiting_reason')
         AND reason IS NULL AND command_fingerprint IS NULL)
        OR (state IN ('ready', 'completed')
            AND btrim(reason) <> '' AND length(reason) <= 2000
            AND command_fingerprint IS NOT NULL)
        OR (state = 'expired' AND (
          (reason IS NULL AND command_fingerprint IS NULL)
          OR (btrim(reason) <> '' AND length(reason) <= 2000
              AND command_fingerprint IS NOT NULL)
        ))
      )
      AND (
        (intent_kind = 'correct_boolean'
         AND state IN ('offered', 'awaiting_reason', 'ready', 'completed', 'expired')
         AND boolean_result IN ('done', 'not_done')
         AND text_result IS NULL AND checklist_item_state IS NULL
         AND quantity_value IS NULL AND actual_time_value IS NULL
         AND rating_value IS NULL AND text_value IS NULL
         AND or_variant_value IS NULL)
        OR (intent_kind = 'correct_quantity'
            AND boolean_result IS NULL AND text_result IS NULL
            AND checklist_item_state IS NULL AND actual_time_value IS NULL
            AND rating_value IS NULL AND text_value IS NULL
            AND or_variant_value IS NULL
            AND (
              (state IN ('offered', 'awaiting_value') AND quantity_value IS NULL)
              OR (state IN ('awaiting_reason', 'ready', 'completed')
                  AND quantity_value ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$')
              OR (state = 'expired' AND (
                    (quantity_value IS NULL
                     AND reason IS NULL AND command_fingerprint IS NULL)
                    OR quantity_value ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
                  ))
            ))
        OR (intent_kind = 'correct_actual_time'
            AND boolean_result IS NULL AND text_result IS NULL
            AND checklist_item_state IS NULL AND quantity_value IS NULL
            AND rating_value IS NULL AND text_value IS NULL
            AND or_variant_value IS NULL
            AND (
              (state IN ('offered', 'awaiting_value') AND actual_time_value IS NULL)
              OR (state IN ('awaiting_reason', 'ready', 'completed')
                  AND actual_time_value IS NOT NULL)
              OR (state = 'expired' AND (
                    (actual_time_value IS NULL
                     AND reason IS NULL AND command_fingerprint IS NULL)
                    OR actual_time_value IS NOT NULL
                  ))
            ))
        OR (intent_kind = 'correct_rating'
            AND boolean_result IS NULL AND text_result IS NULL
            AND checklist_item_state IS NULL AND quantity_value IS NULL
            AND actual_time_value IS NULL AND text_value IS NULL
            AND or_variant_value IS NULL
            AND (
              (state IN ('offered', 'awaiting_value') AND rating_value IS NULL)
              OR (state IN ('awaiting_reason', 'ready', 'completed')
                  AND rating_value BETWEEN -9007199254740991 AND 9007199254740991)
              OR (state = 'expired' AND (
                    (rating_value IS NULL
                     AND reason IS NULL AND command_fingerprint IS NULL)
                    OR rating_value BETWEEN -9007199254740991 AND 9007199254740991
                  ))
            ))
        OR (intent_kind = 'correct_text'
            AND boolean_result IS NULL
            AND text_result IN ('done', 'not_done')
            AND checklist_item_state IS NULL AND quantity_value IS NULL
            AND actual_time_value IS NULL AND rating_value IS NULL
            AND or_variant_value IS NULL
            AND (
              (state IN ('offered', 'awaiting_value') AND text_value IS NULL)
              OR (state IN ('awaiting_reason', 'ready', 'completed')
                  AND btrim(text_value) <> '')
              OR (state = 'expired' AND (
                    (text_value IS NULL
                     AND reason IS NULL AND command_fingerprint IS NULL)
                    OR btrim(text_value) <> ''
                  ))
            ))
        OR (intent_kind = 'correct_checklist_item'
            AND state IN ('offered', 'awaiting_reason', 'ready', 'completed', 'expired')
            AND boolean_result IS NULL AND text_result IS NULL
            AND checklist_item_state IN ('done', 'not_done')
            AND quantity_value IS NULL AND actual_time_value IS NULL
            AND rating_value IS NULL AND text_value IS NULL
            AND or_variant_value IS NULL)
        OR (intent_kind = 'correct_or_variant'
            AND boolean_result IS NULL AND text_result IS NULL
            AND checklist_item_state IS NULL AND quantity_value IS NULL
            AND actual_time_value IS NULL AND rating_value IS NULL
            AND text_value IS NULL
            AND (
              (state IN ('offered', 'awaiting_value') AND or_variant_value IS NULL)
              OR (state IN ('awaiting_reason', 'ready', 'completed')
                  AND or_variant_value ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$')
              OR (state = 'expired' AND (
                    (or_variant_value IS NULL
                     AND reason IS NULL AND command_fingerprint IS NULL)
                    OR or_variant_value ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
                  ))
            ))
      )
    ) OR (
      intent_kind = 'delete_record'
      AND state IN ('offered', 'awaiting_reason', 'ready', 'completed', 'expired')
      AND boolean_result IS NULL AND text_result IS NULL
      AND checklist_item_state IS NULL AND quantity_value IS NULL
      AND actual_time_value IS NULL AND rating_value IS NULL
      AND text_value IS NULL AND or_variant_value IS NULL
      AND close_preview_schema_version IS NULL
      AND close_preview_hash_version IS NULL AND close_preview_hash IS NULL
      AND close_unresolved_count IS NULL
      AND (
        (state IN ('offered', 'awaiting_reason')
         AND reason IS NULL AND command_fingerprint IS NULL)
        OR (state IN ('ready', 'completed')
            AND btrim(reason) <> '' AND length(reason) <= 2000
            AND command_fingerprint IS NOT NULL)
        OR (state = 'expired' AND (
          (reason IS NULL AND command_fingerprint IS NULL)
          OR (btrim(reason) <> '' AND length(reason) <= 2000
              AND command_fingerprint IS NOT NULL)
        ))
      )
    ) OR (
      intent_kind IN ('undo_record', 'weekly_task_result')
      AND state IN ('ready', 'completed', 'expired')
      AND ((intent_kind = 'undo_record' AND boolean_result IS NULL)
           OR (intent_kind = 'weekly_task_result'
               AND boolean_result IN ('done', 'not_done')))
      AND text_result IS NULL AND checklist_item_state IS NULL
      AND quantity_value IS NULL AND actual_time_value IS NULL
      AND rating_value IS NULL AND text_value IS NULL
      AND or_variant_value IS NULL AND reason IS NULL
      AND close_preview_schema_version IS NULL
      AND close_preview_hash_version IS NULL AND close_preview_hash IS NULL
      AND close_unresolved_count IS NULL AND command_fingerprint IS NOT NULL
    ) OR (
      intent_kind = 'close_day'
      AND boolean_result IS NULL AND text_result IS NULL
      AND checklist_item_state IS NULL AND quantity_value IS NULL
      AND actual_time_value IS NULL AND rating_value IS NULL
      AND text_value IS NULL AND or_variant_value IS NULL AND reason IS NULL
      AND (
        (state IN ('offered', 'expired')
         AND close_preview_schema_version IS NULL
         AND close_preview_hash_version IS NULL
         AND close_preview_hash IS NULL AND close_unresolved_count IS NULL
         AND command_fingerprint IS NULL)
        OR (state IN ('ready', 'completed', 'expired')
            AND close_preview_schema_version = 'tracking.close-day-preview.v1'
            AND close_preview_hash_version = 'tracking.close-day-preview-hash.v1'
            AND close_preview_hash ~ '^[0-9a-f]{64}$'
            AND close_unresolved_count >= 0
            AND command_fingerprint IS NOT NULL)
      )
    )
  ) IS TRUE),
  ADD CONSTRAINT telegram_action_intents_result_check CHECK ((
    (state = 'completed'
     AND result_kind = CASE
       WHEN intent_kind = 'close_day' THEN 'tracking.day-close.v1'
       ELSE 'tracking.fact-record.v1'
     END
     AND result_aggregate_id IS NOT NULL
     AND result_aggregate_revision >= 1
     AND completed_at IS NOT NULL)
    OR (state <> 'completed'
        AND result_kind IS NULL
        AND result_aggregate_id IS NULL
        AND result_aggregate_revision IS NULL
        AND completed_at IS NULL)
  ) IS TRUE),
  ADD CONSTRAINT telegram_action_intents_fact_record_fkey
    FOREIGN KEY (fact_record_id) REFERENCES tracking_fact_records(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT telegram_action_intents_flexible_period_fkey
    FOREIGN KEY (flexible_period_id) REFERENCES flexible_periods(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE UNIQUE INDEX telegram_action_intents_active_semantic_key
  ON telegram_action_intents(semantic_key)
  WHERE state IN ('offered', 'awaiting_value', 'awaiting_reason', 'ready');

CREATE UNIQUE INDEX telegram_action_intents_member_awaiting_key
  ON telegram_action_intents(space_id, member_id)
  WHERE state IN ('awaiting_value', 'awaiting_reason');

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
       OR NEW.plan_goal_snapshot_id IS DISTINCT FROM OLD.plan_goal_snapshot_id
       OR NEW.local_date <> OLD.local_date
       OR NEW.intent_kind <> OLD.intent_kind
       OR NEW.checkpoint_id IS DISTINCT FROM OLD.checkpoint_id
       OR NEW.boolean_result IS DISTINCT FROM OLD.boolean_result
       OR NEW.text_result IS DISTINCT FROM OLD.text_result
       OR NEW.checklist_item_id IS DISTINCT FROM OLD.checklist_item_id
       OR NEW.checklist_item_state IS DISTINCT FROM OLD.checklist_item_state
       OR NEW.or_variant_id IS DISTINCT FROM OLD.or_variant_id
       OR NEW.fact_record_id IS DISTINCT FROM OLD.fact_record_id
       OR NEW.expected_record_revision IS DISTINCT FROM OLD.expected_record_revision
       OR NEW.flexible_period_id IS DISTINCT FROM OLD.flexible_period_id
       OR NEW.expires_at <> OLD.expires_at
       OR NEW.created_at <> OLD.created_at
       OR NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION 'telegram action intent identity is immutable'
        USING ERRCODE = '55000';
    END IF;

    IF NEW.source_facts_revision <> OLD.source_facts_revision
       AND NOT (
         OLD.intent_kind = 'close_day'
         AND OLD.state = 'offered'
         AND NEW.state = 'ready'
       ) THEN
      RAISE EXCEPTION 'telegram action intent source revision is immutable'
        USING ERRCODE = '55000';
    END IF;

    IF NOT (
      (OLD.state = 'offered'
       AND NEW.state IN ('awaiting_value', 'awaiting_reason', 'ready', 'expired'))
      OR (OLD.state = 'awaiting_value'
          AND NEW.state IN ('awaiting_reason', 'ready', 'expired'))
      OR (OLD.state = 'awaiting_reason'
          AND NEW.state IN ('ready', 'expired'))
      OR (OLD.state = 'ready'
          AND NEW.state IN (
            'awaiting_value', 'awaiting_reason', 'completed', 'expired'
          ))
    ) THEN
      RAISE EXCEPTION 'telegram action intent transition is invalid'
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
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER telegram_action_intents_guard
BEFORE UPDATE OR DELETE ON telegram_action_intents
FOR EACH ROW EXECUTE FUNCTION guard_telegram_action_intent();
