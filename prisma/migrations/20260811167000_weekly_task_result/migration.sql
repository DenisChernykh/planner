-- T09 stores an explicit member-authored result for a weekly planned task.
LOCK TABLE plan_months, plan_publications, plan_goal_snapshots,
  flexible_periods, tracking_fact_records, tracking_fact_revisions,
  tracking_action_groups, tracking_fact_changes, command_receipts
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM command_receipts
     WHERE command_type = 'tracking.record-weekly-task-result.v1'
  ) THEN
    RAISE EXCEPTION 'T09 cannot adopt pre-existing weekly task receipts'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER FUNCTION "t01_fact_record_has_exact_shape"(UUID)
  RENAME TO "t08_fact_record_has_exact_shape_dispatch";
ALTER FUNCTION "t01_action_has_exact_shape"(UUID)
  RENAME TO "t08_action_has_exact_shape_dispatch";
ALTER FUNCTION "t04_fact_record_has_exact_shape_dispatch"(UUID)
  RENAME TO "t04_fact_record_has_exact_shape_legacy";
ALTER FUNCTION "t05_fact_record_has_exact_shape"(UUID)
  RENAME TO "t05_fact_record_has_exact_shape_legacy";

ALTER TABLE "tracking_fact_records"
  DROP CONSTRAINT "tracking_fact_records_kind_check",
  ADD CONSTRAINT "tracking_fact_records_kind_check" CHECK (
    "fact_kind" IN (
      'boolean', 'quantity_add', 'quantity_latest', 'actual_time', 'rating',
      'text', 'checklist_item', 'or_variant', 'fixed_not_done',
      'weekly_task_result'
    )
  );

CREATE UNIQUE INDEX "tracking_fact_records_weekly_task_result_key"
  ON "tracking_fact_records"("flexible_period_id")
  WHERE "fact_kind" = 'weekly_task_result';

ALTER TABLE "tracking_action_groups"
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
      'tracking.record-weekly-task-result.v1'
    )
  );

CREATE FUNCTION "t09_fact_record_has_exact_shape"(target_record UUID)
RETURNS BOOLEAN AS $$
DECLARE
  record_value tracking_fact_records%ROWTYPE;
  current_value tracking_fact_revisions%ROWTYPE;
  period_value flexible_periods%ROWTYPE;
  snapshot_value plan_goal_snapshots%ROWTYPE;
  publication_value plan_publications%ROWTYPE;
  month_value plan_months%ROWTYPE;
  revision_count BIGINT;
  maximum_revision BIGINT;
BEGIN
  SELECT * INTO record_value FROM tracking_fact_records
   WHERE id = target_record;
  SELECT * INTO current_value FROM tracking_fact_revisions
   WHERE id = record_value.current_revision_id;
  SELECT * INTO period_value FROM flexible_periods
   WHERE id = record_value.flexible_period_id;
  SELECT * INTO snapshot_value FROM plan_goal_snapshots
   WHERE id = record_value.plan_goal_snapshot_id;
  SELECT * INTO publication_value FROM plan_publications
   WHERE id = record_value.publication_id;
  SELECT * INTO month_value FROM plan_months
   WHERE id = record_value.plan_month_id;
  SELECT count(*), max(revision_number)
    INTO revision_count, maximum_revision
    FROM tracking_fact_revisions WHERE fact_record_id = target_record;

  RETURN (
    record_value.id IS NOT NULL
    AND record_value.fact_kind = 'weekly_task_result'
    AND record_value.fixed_expectation_id IS NULL
    AND record_value.flexible_period_id IS NOT NULL
    AND record_value.contribution_id IS NULL
    AND record_value.checklist_item_id IS NULL
    AND record_value.or_variant_id IS NULL
    AND period_value.id = record_value.flexible_period_id
    AND period_value.publication_id = record_value.publication_id
    AND period_value.plan_goal_snapshot_id = record_value.plan_goal_snapshot_id
    AND period_value.period_kind = 'weekly_planned_task'
    AND period_value.period_target = 1
    AND period_value.period_days IS NULL
    AND cardinality(period_value.active_dates) = 0
    AND cardinality(period_value.eligible_dates) = 0
    AND record_value.local_date = period_value.period_start
    AND period_value.period_start <= period_value.period_end
    AND snapshot_value.id = record_value.plan_goal_snapshot_id
    AND snapshot_value.publication_id = record_value.publication_id
    AND snapshot_value.plan_month_id = record_value.plan_month_id
    AND snapshot_value.space_id = record_value.space_id
    AND snapshot_value.config #>> '{repetition,kind}' =
        'weekly_planned_task'
    AND snapshot_value.config #>> '{measurement,kind}' = 'boolean'
    AND snapshot_value.config -> 'checkpoints' = 'null'::jsonb
    AND publication_value.id = record_value.publication_id
    AND publication_value.plan_month_id = record_value.plan_month_id
    AND publication_value.space_id = record_value.space_id
    AND period_value.period_end >= publication_value.active_local_date
    AND month_value.id = record_value.plan_month_id
    AND month_value.space_id = record_value.space_id
    AND month_value.active_publication_id = record_value.publication_id
    AND month_value.status IN ('published', 'grace')
    AND current_value.id = record_value.current_revision_id
    AND current_value.fact_record_id = record_value.id
    AND current_value.revision_number = maximum_revision
    AND revision_count = maximum_revision
    AND maximum_revision >= 1
    AND record_value.updated_at = current_value.created_at
    AND NOT EXISTS (
      SELECT 1 FROM tracking_fact_revisions revision
       WHERE revision.fact_record_id = record_value.id
         AND NOT (
           (
             revision.revision_kind = 'recorded'
             AND revision.boolean_result IS NOT NULL
             AND revision.boolean_result IN ('done', 'not_done')
             AND num_nonnulls(
               revision.quantity_value, revision.actual_time_value,
               revision.rating_value, revision.text_value,
               revision.text_result, revision.checklist_item_state,
               revision.or_variant_value, revision.fixed_outcome
             ) = 0
           ) OR (
             revision.revision_kind = 'tombstoned'
             AND num_nonnulls(
               revision.boolean_result, revision.quantity_value,
               revision.actual_time_value, revision.rating_value,
               revision.text_value, revision.text_result,
               revision.checklist_item_state, revision.or_variant_value,
               revision.fixed_outcome
             ) = 0
           )
         )
    )
  ) IS TRUE;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION "t04_fact_record_has_exact_shape_dispatch"(target_record UUID)
RETURNS BOOLEAN AS $$
DECLARE
  kind_value TEXT;
BEGIN
  SELECT fact_kind INTO kind_value FROM tracking_fact_records
   WHERE id = target_record;
  IF kind_value = 'weekly_task_result' THEN
    RETURN t09_fact_record_has_exact_shape(target_record);
  END IF;
  RETURN t04_fact_record_has_exact_shape_legacy(target_record);
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION "t05_fact_record_has_exact_shape"(target_record UUID)
RETURNS BOOLEAN AS $$
DECLARE
  kind_value TEXT;
BEGIN
  SELECT fact_kind INTO kind_value FROM tracking_fact_records
   WHERE id = target_record;
  IF kind_value = 'weekly_task_result' THEN
    RETURN t09_fact_record_has_exact_shape(target_record);
  END IF;
  RETURN t05_fact_record_has_exact_shape_legacy(target_record);
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION "t01_fact_record_has_exact_shape"(target_record UUID)
RETURNS BOOLEAN AS $$
DECLARE
  kind_value TEXT;
BEGIN
  SELECT fact_kind INTO kind_value FROM tracking_fact_records
   WHERE id = target_record;
  IF kind_value = 'weekly_task_result' THEN
    RETURN t09_fact_record_has_exact_shape(target_record);
  END IF;
  RETURN t08_fact_record_has_exact_shape_dispatch(target_record);
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION "t09_action_has_exact_shape"(target_action UUID)
RETURNS BOOLEAN AS $$
DECLARE
  action_value tracking_action_groups%ROWTYPE;
  change_value tracking_fact_changes%ROWTYPE;
  record_value tracking_fact_records%ROWTYPE;
  revision_value tracking_fact_revisions%ROWTYPE;
  period_value flexible_periods%ROWTYPE;
  snapshot_value plan_goal_snapshots%ROWTYPE;
  publication_value plan_publications%ROWTYPE;
  month_value plan_months%ROWTYPE;
  receipt_value command_receipts%ROWTYPE;
  change_count BIGINT;
BEGIN
  SELECT * INTO action_value FROM tracking_action_groups
   WHERE id = target_action;
  SELECT count(*) INTO change_count FROM tracking_fact_changes
   WHERE action_id = target_action;
  SELECT * INTO change_value FROM tracking_fact_changes
   WHERE action_id = target_action;
  SELECT * INTO record_value FROM tracking_fact_records
   WHERE id = change_value.fact_record_id;
  SELECT * INTO revision_value FROM tracking_fact_revisions
   WHERE id = change_value.after_revision_id;
  SELECT * INTO period_value FROM flexible_periods
   WHERE id = record_value.flexible_period_id;
  SELECT * INTO snapshot_value FROM plan_goal_snapshots
   WHERE id = record_value.plan_goal_snapshot_id;
  SELECT * INTO publication_value FROM plan_publications
   WHERE id = action_value.publication_id;
  SELECT * INTO month_value FROM plan_months
   WHERE id = action_value.plan_month_id;
  SELECT * INTO receipt_value FROM command_receipts
   WHERE actor_scope = action_value.actor_scope
     AND command_type = action_value.command_type
     AND command_id = action_value.command_id;

  RETURN (
    action_value.id IS NOT NULL
    AND action_value.action_kind = 'fact_recorded'
    AND action_value.command_type =
        'tracking.record-weekly-task-result.v1'
    AND action_value.actor_kind = 'member'
    AND action_value.actor_scope = 'member:' || action_value.member_id::text
    AND action_value.reason IS NULL
    AND action_value.plan_goal_snapshot_id IS NOT NULL
    AND action_value.before_facts_revision >= 0
    AND action_value.after_facts_revision =
        action_value.before_facts_revision + 1
    AND change_count = 1
    AND change_value.action_id = action_value.id
    AND change_value.before_revision_id IS NULL
    AND record_value.id = change_value.fact_record_id
    AND record_value.space_id = action_value.space_id
    AND record_value.plan_month_id = action_value.plan_month_id
    AND record_value.publication_id = action_value.publication_id
    AND record_value.plan_goal_snapshot_id =
        action_value.plan_goal_snapshot_id
    AND record_value.current_revision_id = revision_value.id
    AND record_value.created_by_member_id = action_value.member_id
    AND record_value.created_at = action_value.occurred_at
    AND record_value.updated_at = action_value.occurred_at
    AND revision_value.id = change_value.after_revision_id
    AND revision_value.fact_record_id = record_value.id
    AND revision_value.revision_number = 1
    AND revision_value.revision_kind = 'recorded'
    AND revision_value.boolean_result IN ('done', 'not_done')
    AND revision_value.recorded_by_member_id = action_value.member_id
    AND revision_value.created_at = action_value.occurred_at
    AND period_value.id = record_value.flexible_period_id
    AND period_value.publication_id = action_value.publication_id
    AND period_value.plan_goal_snapshot_id =
        action_value.plan_goal_snapshot_id
    AND snapshot_value.id = action_value.plan_goal_snapshot_id
    AND snapshot_value.publication_id = action_value.publication_id
    AND snapshot_value.space_id = action_value.space_id
    AND (snapshot_value.scope_kind = 'shared'
         OR snapshot_value.owner_member_id = action_value.member_id)
    AND publication_value.id = action_value.publication_id
    AND publication_value.plan_month_id = action_value.plan_month_id
    AND publication_value.space_id = action_value.space_id
    AND (action_value.occurred_at AT TIME ZONE 'Asia/Yekaterinburg')::date
        >= publication_value.active_local_date
    AND (action_value.occurred_at AT TIME ZONE 'Asia/Yekaterinburg')::date
        >= period_value.period_start
    AND (action_value.occurred_at AT TIME ZONE 'Asia/Yekaterinburg')::date
        <= period_value.period_end
    AND month_value.id = action_value.plan_month_id
    AND month_value.space_id = action_value.space_id
    AND month_value.active_publication_id = action_value.publication_id
    AND month_value.status = 'published'
    AND month_value.facts_revision = action_value.after_facts_revision
    AND receipt_value.command_type =
        'tracking.record-weekly-task-result.v1'
    AND receipt_value.result_kind = 'tracking.fact-record.v1'
    AND receipt_value.aggregate_id = record_value.id
    AND receipt_value.aggregate_revision = 1
    AND receipt_value.completed_at = action_value.occurred_at
    AND t09_fact_record_has_exact_shape(record_value.id)
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
  IF type_value = 'tracking.record-weekly-task-result.v1' THEN
    RETURN t09_action_has_exact_shape(target_action);
  END IF;
  RETURN t08_action_has_exact_shape_dispatch(target_action);
END;
$$ LANGUAGE plpgsql STABLE;

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
      'tracking.record-weekly-task-result.v1'
    ) OR NEW.result_kind IN (
      'tracking.fact-record.v1', 'tracking.day-close.v1'
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
