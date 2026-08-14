-- T10 permits the planner worker to append system-authored weekly results.
LOCK TABLE plan_months, plan_publications, plan_goal_snapshots,
  flexible_periods, tracking_fact_records, tracking_fact_revisions,
  tracking_action_groups, tracking_fact_changes, command_receipts
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM command_receipts
     WHERE command_type = 'planning.close-week.v1'
        OR result_kind = 'planning.week-close.v1'
  ) THEN
    RAISE EXCEPTION 'T10 cannot adopt pre-existing CloseWeek receipts'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER FUNCTION "t01_action_has_exact_shape"(UUID)
  RENAME TO "t09_action_has_exact_shape_dispatch";

ALTER TABLE "tracking_fact_records"
  ALTER COLUMN "created_by_member_id" DROP NOT NULL,
  ADD COLUMN "created_by_system_actor_id" VARCHAR(32),
  ADD CONSTRAINT "tracking_fact_records_actor_check" CHECK (
    (
      "created_by_member_id" IS NOT NULL
      AND "created_by_system_actor_id" IS NULL
    ) OR (
      "created_by_member_id" IS NULL
      AND "created_by_system_actor_id" = 'planner-worker'
    )
  );

ALTER TABLE "tracking_fact_revisions"
  ALTER COLUMN "recorded_by_member_id" DROP NOT NULL,
  ADD COLUMN "recorded_by_system_actor_id" VARCHAR(32),
  ADD CONSTRAINT "tracking_fact_revisions_actor_check" CHECK (
    (
      "recorded_by_member_id" IS NOT NULL
      AND "recorded_by_system_actor_id" IS NULL
    ) OR (
      "recorded_by_member_id" IS NULL
      AND "recorded_by_system_actor_id" = 'planner-worker'
    )
  );

ALTER TABLE "tracking_action_groups"
  ALTER COLUMN "member_id" DROP NOT NULL,
  ADD COLUMN "system_actor_id" VARCHAR(32),
  DROP CONSTRAINT "tracking_action_groups_actor_check",
  ADD CONSTRAINT "tracking_action_groups_actor_check" CHECK (
    (
      "actor_kind" = 'member'
      AND "member_id" IS NOT NULL
      AND "system_actor_id" IS NULL
      AND "actor_scope" = 'member:' || "member_id"::text
    ) OR (
      "actor_kind" = 'system'
      AND "member_id" IS NULL
      AND "system_actor_id" = 'planner-worker'
      AND "actor_scope" = 'system:planner-worker'
    )
  ),
  DROP CONSTRAINT "tracking_action_groups_action_check",
  ADD CONSTRAINT "tracking_action_groups_action_check" CHECK (
    "action_kind" IN (
      'fact_recorded', 'fact_corrected', 'fact_tombstoned', 'fact_undone',
      'day_closed', 'week_closed'
    )
  ),
  DROP CONSTRAINT "tracking_action_groups_command_check",
  ADD CONSTRAINT "tracking_action_groups_command_check" CHECK (
    "command_type" IN (
      'tracking.record-fact.v1',
      'tracking.record-time.v1',
      'tracking.record-rating.v1',
      'tracking.record-checkpoint.v1',
      'tracking.record-text.v1',
      'tracking.record-checklist-item.v1',
      'tracking.record-or-variant.v1',
      'tracking.record-composite-occurrence.v1',
      'tracking.correct-record.v1',
      'tracking.delete-record.v1',
      'tracking.undo-last-own-action.v1',
      'tracking.close-day.v1',
      'tracking.record-weekly-task-result.v1',
      'planning.close-week.v1'
    )
  ),
  DROP CONSTRAINT "tracking_action_groups_reason_check",
  ADD CONSTRAINT "tracking_action_groups_reason_check" CHECK (
    (
      "action_kind" IN (
        'fact_recorded', 'fact_undone', 'day_closed', 'week_closed'
      )
      AND "reason" IS NULL
    ) OR (
      "action_kind" IN ('fact_corrected', 'fact_tombstoned')
      AND "reason" IS NOT NULL
      AND length("reason") <= 2000
      AND t03_text_is_nonempty("reason")
    )
  );

CREATE OR REPLACE FUNCTION "guard_t01_fact_record"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tracking_fact_records cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.id <> OLD.id OR NEW.space_id <> OLD.space_id
     OR NEW.plan_month_id <> OLD.plan_month_id
     OR NEW.publication_id <> OLD.publication_id
     OR NEW.plan_goal_snapshot_id <> OLD.plan_goal_snapshot_id
     OR NEW.local_date <> OLD.local_date OR NEW.fact_kind <> OLD.fact_kind
     OR NEW.fixed_expectation_id IS DISTINCT FROM OLD.fixed_expectation_id
     OR NEW.flexible_period_id IS DISTINCT FROM OLD.flexible_period_id
     OR NEW.contribution_id IS DISTINCT FROM OLD.contribution_id
     OR NEW.checklist_item_id IS DISTINCT FROM OLD.checklist_item_id
     OR NEW.or_variant_id IS DISTINCT FROM OLD.or_variant_id
     OR NEW.created_by_member_id IS DISTINCT FROM OLD.created_by_member_id
     OR NEW.created_by_system_actor_id IS DISTINCT FROM
        OLD.created_by_system_actor_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'tracking_fact_records identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "t10_close_week_command_id"(
  base_command_id UUID,
  closure_generation BIGINT
)
RETURNS UUID AS $$
DECLARE
  hash_value TEXT;
BEGIN
  IF closure_generation = 0 THEN
    RETURN base_command_id;
  END IF;
  hash_value := md5(
    'planning.close-week.v1:' || base_command_id::text || ':' ||
    closure_generation::text
  );
  RETURN (
    substring(hash_value, 1, 8) || '-' ||
    substring(hash_value, 9, 4) || '-3' ||
    substring(hash_value, 14, 3) || '-a' ||
    substring(hash_value, 18, 3) || '-' ||
    substring(hash_value, 21, 12)
  )::uuid;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

CREATE FUNCTION "t10_action_has_exact_shape"(target_action UUID)
RETURNS BOOLEAN AS $$
DECLARE
  action_value tracking_action_groups%ROWTYPE;
  receipt_value command_receipts%ROWTYPE;
  month_value plan_months%ROWTYPE;
  period_start_value DATE;
  period_end_value DATE;
  base_command_id_value UUID;
  closure_generation_value BIGINT;
  change_count BIGINT;
BEGIN
  SELECT * INTO action_value FROM tracking_action_groups
   WHERE id = target_action;
  SELECT * INTO receipt_value FROM command_receipts
   WHERE actor_scope = action_value.actor_scope
     AND command_type = action_value.command_type
     AND command_id = action_value.command_id;
  SELECT * INTO month_value FROM plan_months
   WHERE id = action_value.plan_month_id;
  SELECT period.period_start, period.period_end
    INTO period_start_value, period_end_value
    FROM tracking_fact_changes change
    JOIN tracking_fact_records record ON record.id = change.fact_record_id
    JOIN flexible_periods period ON period.id = record.flexible_period_id
   WHERE change.action_id = target_action
   ORDER BY period.id
   LIMIT 1;
  SELECT count(*) INTO change_count FROM tracking_fact_changes
   WHERE action_id = target_action;
  SELECT period.id INTO base_command_id_value
    FROM flexible_periods period
   WHERE period.publication_id = action_value.publication_id
     AND period.period_kind = 'weekly_planned_task'
     AND period.period_start = period_start_value
     AND period.period_end = period_end_value
   ORDER BY period.id LIMIT 1;
  SELECT count(DISTINCT prior_action.id)
    INTO closure_generation_value
    FROM tracking_action_groups prior_action
    JOIN tracking_fact_changes prior_change
      ON prior_change.action_id = prior_action.id
    JOIN tracking_fact_records prior_record
      ON prior_record.id = prior_change.fact_record_id
    JOIN flexible_periods prior_period
      ON prior_period.id = prior_record.flexible_period_id
   WHERE prior_action.command_type = 'planning.close-week.v1'
     AND prior_action.id <> target_action
     AND prior_action.publication_id = action_value.publication_id
     AND prior_action.after_facts_revision < action_value.after_facts_revision
     AND prior_period.period_start = period_start_value
     AND prior_period.period_end = period_end_value;

  RETURN (
    action_value.id IS NOT NULL
    AND action_value.action_kind = 'week_closed'
    AND action_value.command_type = 'planning.close-week.v1'
    AND action_value.actor_kind = 'system'
    AND action_value.actor_scope = 'system:planner-worker'
    AND action_value.member_id IS NULL
    AND action_value.system_actor_id = 'planner-worker'
    AND action_value.plan_goal_snapshot_id IS NULL
    AND action_value.reason IS NULL
    AND action_value.before_facts_revision >= 0
    AND action_value.after_facts_revision =
        action_value.before_facts_revision + 1
    AND change_count BETWEEN 1 AND 200
    AND period_start_value IS NOT NULL
    AND period_end_value IS NOT NULL
    AND period_start_value <= period_end_value
    AND (action_value.occurred_at AT TIME ZONE 'Asia/Yekaterinburg')::date
        > period_end_value
    AND action_value.command_id = t10_close_week_command_id(
      base_command_id_value,
      closure_generation_value
    )
    AND month_value.id = action_value.plan_month_id
    AND month_value.space_id = action_value.space_id
    AND month_value.active_publication_id = action_value.publication_id
    AND month_value.status IN ('published', 'grace')
    AND month_value.facts_revision = action_value.after_facts_revision
    AND receipt_value.actor_scope = 'system:planner-worker'
    AND receipt_value.command_type = 'planning.close-week.v1'
    AND receipt_value.result_kind = 'planning.week-close.v1'
    AND receipt_value.aggregate_id = action_value.id
    AND receipt_value.aggregate_revision = action_value.after_facts_revision
    AND receipt_value.completed_at = action_value.occurred_at
    AND NOT EXISTS (
      SELECT 1
        FROM tracking_fact_changes change
        JOIN tracking_fact_records record ON record.id = change.fact_record_id
        JOIN tracking_fact_revisions after_revision
          ON after_revision.id = change.after_revision_id
        JOIN flexible_periods period ON period.id = record.flexible_period_id
        LEFT JOIN tracking_fact_revisions before_revision
          ON before_revision.id = change.before_revision_id
       WHERE change.action_id = target_action
         AND NOT (
           record.space_id = action_value.space_id
           AND record.plan_month_id = action_value.plan_month_id
           AND record.publication_id = action_value.publication_id
           AND record.fact_kind = 'weekly_task_result'
           AND record.fixed_expectation_id IS NULL
           AND record.flexible_period_id = period.id
           AND record.contribution_id IS NULL
           AND record.checklist_item_id IS NULL
           AND record.or_variant_id IS NULL
           AND record.local_date = period.period_start
           AND record.current_revision_id = after_revision.id
           AND record.updated_at = action_value.occurred_at
           AND period.publication_id = action_value.publication_id
           AND period.plan_goal_snapshot_id = record.plan_goal_snapshot_id
           AND period.period_kind = 'weekly_planned_task'
           AND period.period_target = 1
           AND period.period_start = period_start_value
           AND period.period_end = period_end_value
           AND after_revision.fact_record_id = record.id
           AND after_revision.revision_kind = 'recorded'
           AND after_revision.boolean_result = 'not_done'
           AND after_revision.recorded_by_member_id IS NULL
           AND after_revision.recorded_by_system_actor_id = 'planner-worker'
           AND after_revision.created_at = action_value.occurred_at
           AND (
             (
               change.before_revision_id IS NULL
               AND after_revision.revision_number = 1
               AND record.created_by_member_id IS NULL
               AND record.created_by_system_actor_id = 'planner-worker'
               AND record.created_at = action_value.occurred_at
             ) OR (
               change.before_revision_id IS NOT NULL
               AND before_revision.fact_record_id = record.id
               AND before_revision.revision_kind = 'tombstoned'
               AND after_revision.revision_number =
                   before_revision.revision_number + 1
             )
           )
           AND t09_fact_record_has_exact_shape(record.id)
         ) IS TRUE
    )
    AND NOT EXISTS (
      SELECT 1
        FROM flexible_periods period
        JOIN plan_goal_snapshots snapshot
          ON snapshot.id = period.plan_goal_snapshot_id
         AND snapshot.publication_id = period.publication_id
        LEFT JOIN tracking_fact_records record
          ON record.flexible_period_id = period.id
         AND record.fact_kind = 'weekly_task_result'
        LEFT JOIN tracking_fact_revisions revision
          ON revision.id = record.current_revision_id
       WHERE period.publication_id = action_value.publication_id
         AND period.period_kind = 'weekly_planned_task'
         AND period.period_start = period_start_value
         AND period.period_end = period_end_value
         AND snapshot.config #>> '{repetition,kind}' = 'weekly_planned_task'
         AND snapshot.config #>> '{measurement,kind}' = 'boolean'
         AND (record.id IS NULL OR revision.revision_kind <> 'recorded')
    )
  ) IS TRUE;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION "t01_action_has_exact_shape"(target_action UUID)
RETURNS BOOLEAN AS $$
DECLARE
  type_value TEXT;
BEGIN
  SELECT command_type INTO type_value FROM tracking_action_groups
   WHERE id = target_action;
  IF type_value = 'planning.close-week.v1' THEN
    RETURN t10_action_has_exact_shape(target_action);
  END IF;
  RETURN t09_action_has_exact_shape_dispatch(target_action);
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION "require_t01_fact_change_effect"()
RETURNS TRIGGER AS $$
DECLARE
  command_value TEXT;
BEGIN
  SELECT command_type INTO command_value
    FROM tracking_action_groups WHERE id = NEW.action_id;
  IF NEW.before_revision_id IS NOT NULL
     AND command_value NOT IN (
       'tracking.correct-record.v1', 'tracking.delete-record.v1',
       'tracking.undo-last-own-action.v1', 'planning.close-week.v1'
     ) THEN
    RAISE EXCEPTION 'tracking command cannot append this correction'
      USING ERRCODE = '23514';
  END IF;
  IF command_value = 'tracking.close-day.v1'
     AND NEW.before_revision_id IS NOT NULL THEN
    RAISE EXCEPTION 'CloseDay must create generic marker records'
      USING ERRCODE = '23514';
  END IF;
  IF t01_action_has_exact_shape(NEW.action_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'tracking fact change effect mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "require_t01_receipt_effect"()
RETURNS TRIGGER AS $$
BEGIN
  IF (
    NEW.command_type IN (
      'tracking.record-fact.v1', 'tracking.record-time.v1',
      'tracking.record-rating.v1', 'tracking.record-checkpoint.v1',
      'tracking.record-text.v1', 'tracking.record-checklist-item.v1',
      'tracking.record-or-variant.v1',
      'tracking.record-composite-occurrence.v1',
      'tracking.correct-record.v1', 'tracking.delete-record.v1',
      'tracking.undo-last-own-action.v1', 'tracking.close-day.v1',
      'tracking.record-weekly-task-result.v1', 'planning.close-week.v1'
    ) OR NEW.result_kind IN (
      'tracking.fact-record.v1', 'tracking.day-close.v1',
      'planning.week-close.v1'
    )
  ) AND NOT (
    (
      (
        NEW.command_type IN (
          'tracking.record-fact.v1', 'tracking.record-time.v1',
          'tracking.record-rating.v1', 'tracking.record-checkpoint.v1',
          'tracking.record-text.v1', 'tracking.record-checklist-item.v1',
          'tracking.record-or-variant.v1',
          'tracking.record-composite-occurrence.v1',
          'tracking.correct-record.v1', 'tracking.delete-record.v1',
          'tracking.undo-last-own-action.v1',
          'tracking.record-weekly-task-result.v1'
        ) AND NEW.result_kind = 'tracking.fact-record.v1'
      ) OR (
        NEW.command_type = 'tracking.close-day.v1'
        AND NEW.result_kind = 'tracking.day-close.v1'
      ) OR (
        NEW.command_type = 'planning.close-week.v1'
        AND NEW.result_kind = 'planning.week-close.v1'
      )
    ) AND EXISTS (
      SELECT 1 FROM tracking_action_groups action
       WHERE action.actor_scope = NEW.actor_scope
         AND action.command_type = NEW.command_type
         AND action.command_id = NEW.command_id
         AND t01_action_has_exact_shape(action.id)
    )
  ) THEN
    RAISE EXCEPTION 'tracking receipt requires exact effect'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
