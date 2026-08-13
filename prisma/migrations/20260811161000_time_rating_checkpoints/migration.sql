-- T02 extends the typed tracking kernel with actual-time, rating and checkpoint facts.
LOCK TABLE plan_months, plan_publications, plan_goal_snapshots,
  fixed_expectations, flexible_periods, tracking_fact_records,
  tracking_fact_revisions, tracking_action_groups, tracking_fact_changes,
  command_receipts IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM command_receipts
     WHERE command_type IN (
       'tracking.record-time.v1',
       'tracking.record-rating.v1',
       'tracking.record-checkpoint.v1'
     )
  ) THEN
    RAISE EXCEPTION 'T02 cannot adopt pre-existing typed tracking receipts'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE "tracking_fact_records"
  DROP CONSTRAINT "tracking_fact_records_kind_check",
  ADD CONSTRAINT "tracking_fact_records_kind_check" CHECK (
    "fact_kind" IN (
      'boolean', 'quantity_add', 'quantity_latest', 'actual_time', 'rating'
    )
  );

DROP INDEX "tracking_fact_records_single_value_key";
CREATE UNIQUE INDEX "tracking_fact_records_fixed_single_value_key"
  ON "tracking_fact_records"("fixed_expectation_id")
  WHERE "fixed_expectation_id" IS NOT NULL
    AND "fact_kind" <> 'quantity_add';
CREATE UNIQUE INDEX "tracking_fact_records_flexible_single_value_key"
  ON "tracking_fact_records"("flexible_period_id", "local_date")
  WHERE "flexible_period_id" IS NOT NULL
    AND "fact_kind" <> 'quantity_add';

ALTER TABLE "tracking_fact_revisions"
  ADD COLUMN "actual_time_value" TIME(0),
  ADD COLUMN "rating_value" BIGINT,
  DROP CONSTRAINT "tracking_fact_revisions_value_check",
  ADD CONSTRAINT "tracking_fact_revisions_value_check" CHECK (
    (
      "revision_kind" = 'recorded'
      AND num_nonnulls(
        "boolean_result", "quantity_value", "actual_time_value", "rating_value"
      ) = 1
      AND ("boolean_result" IS NULL OR "boolean_result" IN ('done', 'not_done'))
      AND ("actual_time_value" IS NULL OR "actual_time_value" < TIME '24:00')
      AND (
        "quantity_value" IS NULL
        OR "quantity_value" ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
      )
    ) OR (
      "revision_kind" = 'tombstoned'
      AND num_nonnulls(
        "boolean_result", "quantity_value", "actual_time_value", "rating_value"
      ) = 0
    )
  );

ALTER TABLE "tracking_action_groups"
  DROP CONSTRAINT "tracking_action_groups_command_check",
  ADD CONSTRAINT "tracking_action_groups_command_check" CHECK (
    "command_type" IN (
      'tracking.record-fact.v1',
      'tracking.record-time.v1',
      'tracking.record-rating.v1',
      'tracking.record-checkpoint.v1'
    )
  );

CREATE OR REPLACE FUNCTION "t01_fact_record_has_exact_shape"(target_record UUID)
RETURNS BOOLEAN AS $$
DECLARE
  record_value tracking_fact_records%ROWTYPE;
  current_value tracking_fact_revisions%ROWTYPE;
  snapshot_value plan_goal_snapshots%ROWTYPE;
  publication_value plan_publications%ROWTYPE;
  month_value plan_months%ROWTYPE;
  fixed_value fixed_expectations%ROWTYPE;
  period_value flexible_periods%ROWTYPE;
  revision_count BIGINT;
  maximum_revision BIGINT;
  measurement_kind TEXT;
  value_kind TEXT;
  aggregation_kind TEXT;
  precision_value INTEGER;
  minimum_rating BIGINT;
  maximum_rating BIGINT;
  checkpoint_satisfaction JSONB;
BEGIN
  SELECT * INTO record_value FROM tracking_fact_records WHERE id = target_record;
  SELECT * INTO current_value FROM tracking_fact_revisions
   WHERE id = record_value.current_revision_id;
  SELECT * INTO snapshot_value FROM plan_goal_snapshots
   WHERE id = record_value.plan_goal_snapshot_id;
  SELECT * INTO publication_value FROM plan_publications
   WHERE id = record_value.publication_id;
  SELECT * INTO month_value FROM plan_months WHERE id = record_value.plan_month_id;
  SELECT * INTO fixed_value FROM fixed_expectations
   WHERE id = record_value.fixed_expectation_id;
  SELECT * INTO period_value FROM flexible_periods
   WHERE id = record_value.flexible_period_id;
  SELECT count(*), max(revision_number)
    INTO revision_count, maximum_revision
    FROM tracking_fact_revisions WHERE fact_record_id = target_record;

  measurement_kind := snapshot_value.config #>> '{measurement,kind}';
  value_kind := measurement_kind;
  aggregation_kind := snapshot_value.config #>> '{measurement,aggregation}';
  precision_value := NULLIF(
    snapshot_value.config #>> '{measurement,precision}', ''
  )::integer;
  minimum_rating := NULLIF(
    snapshot_value.config #>> '{measurement,minimum}', ''
  )::bigint;
  maximum_rating := NULLIF(
    snapshot_value.config #>> '{measurement,maximum}', ''
  )::bigint;

  IF record_value.id IS NULL OR current_value.id IS NULL
     OR snapshot_value.id IS NULL OR publication_value.id IS NULL
     OR month_value.id IS NULL OR record_value.space_id <> snapshot_value.space_id
     OR record_value.plan_month_id <> snapshot_value.plan_month_id
     OR record_value.publication_id <> snapshot_value.publication_id
     OR publication_value.plan_month_id <> record_value.plan_month_id
     OR publication_value.space_id <> record_value.space_id
     OR month_value.space_id <> record_value.space_id
     OR month_value.active_publication_id <> publication_value.id
     OR month_value.status NOT IN ('published', 'grace')
     OR record_value.local_date < publication_value.active_local_date
     OR record_value.local_date < month_value.month_start
     OR record_value.local_date >= (month_value.month_start + INTERVAL '1 month')::date
     OR snapshot_value.config #>> '{repetition,kind}' = 'weekly_planned_task'
     OR current_value.fact_record_id <> record_value.id
     OR current_value.revision_number <> maximum_revision
     OR revision_count <> maximum_revision
     OR current_value.revision_kind <> 'recorded'
     OR record_value.updated_at <> current_value.created_at THEN
    RETURN FALSE;
  END IF;

  IF record_value.fixed_expectation_id IS NOT NULL THEN
    IF fixed_value.id IS NULL
       OR fixed_value.publication_id <> record_value.publication_id
       OR fixed_value.plan_goal_snapshot_id <> record_value.plan_goal_snapshot_id
       OR fixed_value.expectation_date <> record_value.local_date THEN
      RETURN FALSE;
    END IF;
    IF fixed_value.component_kind = 'goal' THEN
      IF fixed_value.component_id IS NOT NULL
         OR snapshot_value.config -> 'checkpoints' <> 'null'::jsonb THEN
        RETURN FALSE;
      END IF;
    ELSIF fixed_value.component_kind = 'checkpoint' THEN
      IF fixed_value.component_id IS NULL
         OR snapshot_value.config -> 'checkpoints' = 'null'::jsonb THEN
        RETURN FALSE;
      END IF;
      SELECT item -> 'satisfaction' INTO checkpoint_satisfaction
        FROM jsonb_array_elements(
          snapshot_value.config #> '{checkpoints,items}'
        ) item
       WHERE item ->> 'checkpointId' = fixed_value.component_id::text;
      IF checkpoint_satisfaction IS NULL THEN RETURN FALSE; END IF;
      value_kind := checkpoint_satisfaction ->> 'kind';
    ELSE
      RETURN FALSE;
    END IF;
  ELSE
    IF snapshot_value.config -> 'checkpoints' <> 'null'::jsonb
       OR period_value.id IS NULL
       OR period_value.publication_id <> record_value.publication_id
       OR period_value.plan_goal_snapshot_id <> record_value.plan_goal_snapshot_id
       OR period_value.period_target <= 0
       OR NOT (record_value.local_date = ANY(period_value.eligible_dates)) THEN
      RETURN FALSE;
    END IF;
  END IF;

  IF record_value.fact_kind = 'boolean' THEN
    IF value_kind <> 'boolean' OR current_value.boolean_result IS NULL
       OR current_value.quantity_value IS NOT NULL
       OR current_value.actual_time_value IS NOT NULL
       OR current_value.rating_value IS NOT NULL THEN RETURN FALSE; END IF;
  ELSIF record_value.fact_kind = 'quantity_add' THEN
    IF value_kind <> 'quantity' OR aggregation_kind <> 'add'
       OR record_value.contribution_id IS NULL
       OR fixed_value.component_kind = 'checkpoint' THEN RETURN FALSE; END IF;
  ELSIF record_value.fact_kind = 'quantity_latest' THEN
    IF value_kind <> 'quantity' OR aggregation_kind <> 'latest'
       OR record_value.contribution_id IS NOT NULL
       OR fixed_value.component_kind = 'checkpoint' THEN RETURN FALSE; END IF;
  ELSIF record_value.fact_kind = 'actual_time' THEN
    IF value_kind <> 'actual_time' OR record_value.flexible_period_id IS NOT NULL
       OR current_value.actual_time_value IS NULL THEN RETURN FALSE; END IF;
  ELSIF record_value.fact_kind = 'rating' THEN
    IF value_kind <> 'rating' OR record_value.flexible_period_id IS NOT NULL
       OR current_value.rating_value IS NULL THEN RETURN FALSE; END IF;
  ELSE
    RETURN FALSE;
  END IF;

  IF record_value.fact_kind IN ('quantity_add', 'quantity_latest') AND EXISTS (
    SELECT 1 FROM tracking_fact_revisions revision
     WHERE revision.fact_record_id = target_record
       AND revision.revision_kind = 'recorded'
       AND (
         revision.boolean_result IS NOT NULL OR revision.quantity_value IS NULL
         OR revision.actual_time_value IS NOT NULL OR revision.rating_value IS NOT NULL
         OR revision.quantity_value !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
         OR CASE WHEN strpos(revision.quantity_value, '.') = 0 THEN 0
                 ELSE length(split_part(revision.quantity_value, '.', 2)) END
              > precision_value
       )
  ) THEN RETURN FALSE; END IF;
  IF record_value.fact_kind = 'boolean' AND EXISTS (
    SELECT 1 FROM tracking_fact_revisions revision
     WHERE revision.fact_record_id = target_record
       AND revision.revision_kind = 'recorded'
       AND (revision.boolean_result NOT IN ('done', 'not_done')
            OR revision.quantity_value IS NOT NULL
            OR revision.actual_time_value IS NOT NULL
            OR revision.rating_value IS NOT NULL)
  ) THEN RETURN FALSE; END IF;
  IF record_value.fact_kind = 'actual_time' AND EXISTS (
    SELECT 1 FROM tracking_fact_revisions revision
     WHERE revision.fact_record_id = target_record
       AND revision.revision_kind = 'recorded'
       AND (revision.actual_time_value IS NULL
            OR revision.actual_time_value >= TIME '24:00'
            OR date_part('second', revision.actual_time_value) <> 0
            OR revision.boolean_result IS NOT NULL
            OR revision.quantity_value IS NOT NULL
            OR revision.rating_value IS NOT NULL)
  ) THEN RETURN FALSE; END IF;
  IF record_value.fact_kind = 'rating' AND EXISTS (
    SELECT 1 FROM tracking_fact_revisions revision
     WHERE revision.fact_record_id = target_record
       AND revision.revision_kind = 'recorded'
       AND (revision.rating_value IS NULL
            OR revision.rating_value < minimum_rating
            OR revision.rating_value > maximum_rating
            OR revision.boolean_result IS NOT NULL
            OR revision.quantity_value IS NOT NULL
            OR revision.actual_time_value IS NOT NULL)
  ) THEN RETURN FALSE; END IF;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION "t01_action_has_exact_shape"(target_action UUID)
RETURNS BOOLEAN AS $$
DECLARE
  action_value tracking_action_groups%ROWTYPE;
  change_value tracking_fact_changes%ROWTYPE;
  record_value tracking_fact_records%ROWTYPE;
  before_value tracking_fact_revisions%ROWTYPE;
  after_value tracking_fact_revisions%ROWTYPE;
  receipt_value command_receipts%ROWTYPE;
  month_value plan_months%ROWTYPE;
  snapshot_value plan_goal_snapshots%ROWTYPE;
  fixed_value fixed_expectations%ROWTYPE;
BEGIN
  SELECT * INTO action_value FROM tracking_action_groups WHERE id = target_action;
  SELECT * INTO change_value FROM tracking_fact_changes WHERE action_id = target_action;
  SELECT * INTO record_value FROM tracking_fact_records WHERE id = change_value.fact_record_id;
  SELECT * INTO before_value FROM tracking_fact_revisions
   WHERE id = change_value.before_revision_id;
  SELECT * INTO after_value FROM tracking_fact_revisions
   WHERE id = change_value.after_revision_id;
  SELECT * INTO receipt_value FROM command_receipts
   WHERE actor_scope = action_value.actor_scope
     AND command_type = action_value.command_type
     AND command_id = action_value.command_id;
  SELECT * INTO month_value FROM plan_months WHERE id = action_value.plan_month_id;
  SELECT * INTO snapshot_value FROM plan_goal_snapshots
   WHERE id = action_value.plan_goal_snapshot_id;
  SELECT * INTO fixed_value FROM fixed_expectations
   WHERE id = record_value.fixed_expectation_id;

  RETURN (
    action_value.id IS NOT NULL
    AND action_value.action_kind = 'fact_recorded'
    AND action_value.actor_kind = 'member'
    AND action_value.actor_scope = 'member:' || action_value.member_id::text
    AND action_value.command_type IN (
      'tracking.record-fact.v1', 'tracking.record-time.v1',
      'tracking.record-rating.v1', 'tracking.record-checkpoint.v1'
    )
    AND (
      (action_value.command_type = 'tracking.record-fact.v1'
       AND record_value.fact_kind IN ('boolean', 'quantity_add', 'quantity_latest')
       AND COALESCE(fixed_value.component_kind, 'goal') = 'goal')
      OR (action_value.command_type = 'tracking.record-time.v1'
          AND record_value.fact_kind = 'actual_time'
          AND fixed_value.component_kind = 'goal')
      OR (action_value.command_type = 'tracking.record-rating.v1'
          AND record_value.fact_kind = 'rating'
          AND fixed_value.component_kind = 'goal')
      OR (action_value.command_type = 'tracking.record-checkpoint.v1'
          AND record_value.fact_kind IN ('boolean', 'actual_time', 'rating')
          AND fixed_value.component_kind = 'checkpoint')
    )
    AND action_value.before_facts_revision >= 0
    AND action_value.after_facts_revision = action_value.before_facts_revision + 1
    AND month_value.id = action_value.plan_month_id
    AND month_value.facts_revision = action_value.after_facts_revision
    AND record_value.id = change_value.fact_record_id
    AND record_value.space_id = action_value.space_id
    AND record_value.plan_month_id = action_value.plan_month_id
    AND record_value.publication_id = action_value.publication_id
    AND record_value.plan_goal_snapshot_id = action_value.plan_goal_snapshot_id
    AND record_value.local_date <= (
      action_value.occurred_at AT TIME ZONE 'Asia/Yekaterinburg'
    )::date
    AND record_value.current_revision_id = after_value.id
    AND record_value.updated_at = action_value.occurred_at
    AND after_value.fact_record_id = record_value.id
    AND after_value.recorded_by_member_id = action_value.member_id
    AND after_value.created_at = action_value.occurred_at
    AND after_value.revision_kind = 'recorded'
    AND (
      (change_value.before_revision_id IS NULL
       AND after_value.revision_number = 1
       AND record_value.created_by_member_id = action_value.member_id
       AND record_value.created_at = action_value.occurred_at)
      OR
      (change_value.before_revision_id IS NOT NULL
       AND before_value.fact_record_id = record_value.id
       AND after_value.revision_number = before_value.revision_number + 1)
    )
    AND (record_value.fact_kind <> 'quantity_add'
         OR change_value.before_revision_id IS NULL)
    AND (snapshot_value.scope_kind = 'shared'
         OR snapshot_value.owner_member_id = action_value.member_id)
    AND receipt_value.result_kind = 'tracking.fact-record.v1'
    AND receipt_value.aggregate_id = record_value.id
    AND receipt_value.aggregate_revision = after_value.revision_number
    AND receipt_value.completed_at = action_value.occurred_at
    AND t01_fact_record_has_exact_shape(record_value.id)
  ) IS TRUE;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION "require_t01_receipt_effect"()
RETURNS TRIGGER AS $$
BEGIN
  IF (
    NEW.command_type IN (
      'tracking.record-fact.v1', 'tracking.record-time.v1',
      'tracking.record-rating.v1', 'tracking.record-checkpoint.v1'
    ) OR NEW.result_kind = 'tracking.fact-record.v1'
  ) AND NOT (
    NEW.command_type IN (
      'tracking.record-fact.v1', 'tracking.record-time.v1',
      'tracking.record-rating.v1', 'tracking.record-checkpoint.v1'
    )
    AND NEW.result_kind = 'tracking.fact-record.v1'
    AND EXISTS (
      SELECT 1 FROM tracking_action_groups action
       WHERE action.actor_scope = NEW.actor_scope
         AND action.command_type = NEW.command_type
         AND action.command_id = NEW.command_id
         AND t01_action_has_exact_shape(action.id)
    )
  ) THEN
    RAISE EXCEPTION 'tracking receipt requires exact fact effect'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
