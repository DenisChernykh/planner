-- T04 adds independently versioned OR variants and flexible composite facts.
LOCK TABLE plan_months, plan_publications, plan_goal_snapshots,
  fixed_expectations, flexible_periods, tracking_fact_records,
  tracking_fact_revisions, tracking_action_groups, tracking_fact_changes,
  command_receipts IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM command_receipts
     WHERE command_type IN (
       'tracking.record-or-variant.v1',
       'tracking.record-composite-occurrence.v1'
     )
  ) THEN
    RAISE EXCEPTION 'T04 cannot adopt pre-existing typed tracking receipts'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE "tracking_fact_records"
  ADD COLUMN "or_variant_id" UUID,
  DROP CONSTRAINT "tracking_fact_records_kind_check",
  ADD CONSTRAINT "tracking_fact_records_kind_check" CHECK (
    "fact_kind" IN (
      'boolean', 'quantity_add', 'quantity_latest', 'actual_time', 'rating',
      'text', 'checklist_item', 'or_variant'
    )
  ),
  DROP CONSTRAINT "tracking_fact_records_checklist_item_check",
  ADD CONSTRAINT "tracking_fact_records_component_check" CHECK (
    ("fact_kind" = 'checklist_item'
      AND "checklist_item_id" IS NOT NULL AND "or_variant_id" IS NULL)
    OR ("fact_kind" = 'or_variant'
      AND "or_variant_id" IS NOT NULL AND "checklist_item_id" IS NULL)
    OR ("fact_kind" NOT IN ('checklist_item', 'or_variant')
      AND "checklist_item_id" IS NULL AND "or_variant_id" IS NULL)
  );

DROP INDEX "tracking_fact_records_fixed_single_value_key";
CREATE UNIQUE INDEX "tracking_fact_records_fixed_single_value_key"
  ON "tracking_fact_records"("fixed_expectation_id")
  WHERE "fixed_expectation_id" IS NOT NULL
    AND "fact_kind" NOT IN ('quantity_add', 'checklist_item', 'or_variant');
CREATE UNIQUE INDEX "tracking_fact_records_fixed_or_variant_key"
  ON "tracking_fact_records"("fixed_expectation_id", "or_variant_id")
  WHERE "fact_kind" = 'or_variant';

DROP INDEX "tracking_fact_records_flexible_single_value_key";
CREATE UNIQUE INDEX "tracking_fact_records_flexible_single_value_key"
  ON "tracking_fact_records"("flexible_period_id", "local_date")
  WHERE "flexible_period_id" IS NOT NULL
    AND "fact_kind" NOT IN ('quantity_add', 'checklist_item', 'or_variant');
CREATE UNIQUE INDEX "tracking_fact_records_flexible_checklist_item_key"
  ON "tracking_fact_records"(
    "flexible_period_id", "local_date", "checklist_item_id"
  ) WHERE "fact_kind" = 'checklist_item';
CREATE UNIQUE INDEX "tracking_fact_records_flexible_or_variant_key"
  ON "tracking_fact_records"(
    "flexible_period_id", "local_date", "or_variant_id"
  ) WHERE "fact_kind" = 'or_variant';

ALTER TABLE "tracking_fact_revisions"
  ADD COLUMN "or_variant_value" TEXT,
  DROP CONSTRAINT "tracking_fact_revisions_value_check",
  ADD CONSTRAINT "tracking_fact_revisions_value_check" CHECK (
    (
      "revision_kind" = 'recorded'
      AND (
        ("boolean_result" IS NOT NULL
         AND "boolean_result" IN ('done', 'not_done')
         AND num_nonnulls(
           "quantity_value", "actual_time_value", "rating_value",
           "text_value", "text_result", "checklist_item_state",
           "or_variant_value"
         ) = 0)
        OR ("quantity_value" IS NOT NULL
            AND "quantity_value" ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
            AND num_nonnulls(
              "boolean_result", "actual_time_value", "rating_value",
              "text_value", "text_result", "checklist_item_state",
              "or_variant_value"
            ) = 0)
        OR ("actual_time_value" IS NOT NULL
            AND "actual_time_value" < TIME '24:00'
            AND num_nonnulls(
              "boolean_result", "quantity_value", "rating_value",
              "text_value", "text_result", "checklist_item_state",
              "or_variant_value"
            ) = 0)
        OR ("rating_value" IS NOT NULL
            AND num_nonnulls(
              "boolean_result", "quantity_value", "actual_time_value",
              "text_value", "text_result", "checklist_item_state",
              "or_variant_value"
            ) = 0)
        OR ("text_value" IS NOT NULL
            AND t03_text_is_nonempty("text_value")
            AND "text_result" IS NOT NULL
            AND "text_result" IN ('done', 'not_done')
            AND num_nonnulls(
              "boolean_result", "quantity_value", "actual_time_value",
              "rating_value", "checklist_item_state", "or_variant_value"
            ) = 0)
        OR ("checklist_item_state" IS NOT NULL
            AND "checklist_item_state" IN ('done', 'not_done')
            AND num_nonnulls(
              "boolean_result", "quantity_value", "actual_time_value",
              "rating_value", "text_value", "text_result",
              "or_variant_value"
            ) = 0)
        OR ("or_variant_value" IS NOT NULL
            AND "or_variant_value" ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
            AND num_nonnulls(
              "boolean_result", "quantity_value", "actual_time_value",
              "rating_value", "text_value", "text_result",
              "checklist_item_state"
            ) = 0)
      )
    ) OR (
      "revision_kind" = 'tombstoned'
      AND num_nonnulls(
        "boolean_result", "quantity_value", "actual_time_value",
        "rating_value", "text_value", "text_result",
        "checklist_item_state", "or_variant_value"
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
      'tracking.record-checkpoint.v1',
      'tracking.record-text.v1',
      'tracking.record-checklist-item.v1',
      'tracking.record-or-variant.v1',
      'tracking.record-composite-occurrence.v1'
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
     OR NEW.created_by_member_id <> OLD.created_by_member_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'tracking_fact_records identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "t04_fact_record_has_exact_shape"(target_record UUID)
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
  value_kind TEXT;
  checkpoint_satisfaction JSONB;
  component_config JSONB;
  precision_value INTEGER;
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

  value_kind := snapshot_value.config #>> '{measurement,kind}';
  IF record_value.id IS NULL OR current_value.id IS NULL
     OR snapshot_value.id IS NULL OR publication_value.id IS NULL
     OR month_value.id IS NULL
     OR record_value.space_id <> snapshot_value.space_id
     OR record_value.plan_month_id <> snapshot_value.plan_month_id
     OR record_value.publication_id <> snapshot_value.publication_id
     OR publication_value.plan_month_id <> record_value.plan_month_id
     OR publication_value.space_id <> record_value.space_id
     OR month_value.space_id <> record_value.space_id
     OR month_value.active_publication_id <> publication_value.id
     OR month_value.status NOT IN ('published', 'grace')
     OR record_value.local_date < publication_value.active_local_date
     OR record_value.local_date < month_value.month_start
     OR record_value.local_date >=
        (month_value.month_start + INTERVAL '1 month')::date
     OR snapshot_value.config #>> '{repetition,kind}' = 'weekly_planned_task'
     OR record_value.contribution_id IS NOT NULL
     OR current_value.fact_record_id <> record_value.id
     OR current_value.revision_number <> maximum_revision
     OR revision_count <> maximum_revision
     OR current_value.revision_kind <> 'recorded'
     OR record_value.updated_at <> current_value.created_at THEN
    RETURN FALSE;
  END IF;

  IF record_value.fixed_expectation_id IS NOT NULL THEN
    IF fixed_value.id IS NULL OR record_value.flexible_period_id IS NOT NULL
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
    IF record_value.flexible_period_id IS NULL
       OR snapshot_value.config -> 'checkpoints' <> 'null'::jsonb
       OR period_value.id IS NULL
       OR period_value.publication_id <> record_value.publication_id
       OR period_value.plan_goal_snapshot_id <> record_value.plan_goal_snapshot_id
       OR period_value.period_target <= 0
       OR NOT (record_value.local_date = ANY(period_value.eligible_dates)) THEN
      RETURN FALSE;
    END IF;
  END IF;

  IF record_value.fact_kind = 'or_variant' THEN
    IF value_kind <> 'any_of' OR record_value.or_variant_id IS NULL
       OR record_value.checklist_item_id IS NOT NULL THEN RETURN FALSE; END IF;
    SELECT variant INTO component_config
      FROM jsonb_array_elements(
        snapshot_value.config #> '{measurement,variants}'
      ) variant
     WHERE variant ->> 'variantId' = record_value.or_variant_id::text;
    IF component_config IS NULL THEN RETURN FALSE; END IF;
    precision_value := NULLIF(component_config ->> 'precision', '')::integer;
    IF precision_value NOT IN (0, 1, 2, 3) THEN RETURN FALSE; END IF;
    IF EXISTS (
      SELECT 1 FROM tracking_fact_revisions revision
       WHERE revision.fact_record_id = target_record
         AND revision.revision_kind = 'recorded'
         AND (revision.or_variant_value IS NULL
              OR revision.or_variant_value !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
              OR CASE
                   WHEN strpos(revision.or_variant_value, '.') = 0 THEN 0
                   ELSE length(split_part(revision.or_variant_value, '.', 2))
                 END > precision_value
              OR num_nonnulls(
                revision.boolean_result, revision.quantity_value,
                revision.actual_time_value, revision.rating_value,
                revision.text_value, revision.text_result,
                revision.checklist_item_state
              ) <> 0)
    ) THEN RETURN FALSE; END IF;
  ELSIF record_value.fact_kind = 'checklist_item' THEN
    IF record_value.fixed_expectation_id IS NOT NULL OR value_kind <> 'checklist'
       OR record_value.checklist_item_id IS NULL
       OR record_value.or_variant_id IS NOT NULL
       OR NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(
           snapshot_value.config #> '{measurement,items}'
         ) item
          WHERE item ->> 'itemId' = record_value.checklist_item_id::text
       ) THEN RETURN FALSE; END IF;
    IF EXISTS (
      SELECT 1 FROM tracking_fact_revisions revision
       WHERE revision.fact_record_id = target_record
         AND revision.revision_kind = 'recorded'
         AND (revision.checklist_item_state IS NULL
              OR revision.checklist_item_state NOT IN ('done', 'not_done')
              OR num_nonnulls(
                revision.boolean_result, revision.quantity_value,
                revision.actual_time_value, revision.rating_value,
                revision.text_value, revision.text_result,
                revision.or_variant_value
              ) <> 0)
    ) THEN RETURN FALSE; END IF;
  ELSE
    RETURN FALSE;
  END IF;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION "t01_fact_record_has_exact_shape"(target_record UUID)
RETURNS BOOLEAN AS $$
DECLARE
  record_value tracking_fact_records%ROWTYPE;
BEGIN
  SELECT * INTO record_value FROM tracking_fact_records WHERE id = target_record;
  IF record_value.fact_kind = 'or_variant'
     OR (record_value.fact_kind = 'checklist_item'
         AND record_value.flexible_period_id IS NOT NULL) THEN
    RETURN t04_fact_record_has_exact_shape(target_record);
  END IF;
  IF record_value.fact_kind IN ('text', 'checklist_item') THEN
    RETURN t03_fact_record_has_exact_shape(target_record);
  END IF;
  RETURN t02_fact_record_has_exact_shape(target_record);
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION "t04_action_has_exact_shape"(target_action UUID)
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
BEGIN
  SELECT * INTO action_value FROM tracking_action_groups WHERE id = target_action;
  SELECT * INTO change_value FROM tracking_fact_changes WHERE action_id = target_action;
  SELECT * INTO record_value FROM tracking_fact_records
   WHERE id = change_value.fact_record_id;
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

  RETURN (
    action_value.id IS NOT NULL
    AND action_value.action_kind = 'fact_recorded'
    AND action_value.actor_kind = 'member'
    AND action_value.actor_scope = 'member:' || action_value.member_id::text
    AND (
      (action_value.command_type = 'tracking.record-or-variant.v1'
       AND record_value.fact_kind = 'or_variant'
       AND record_value.fixed_expectation_id IS NOT NULL)
      OR
      (action_value.command_type = 'tracking.record-composite-occurrence.v1'
       AND record_value.fact_kind IN ('checklist_item', 'or_variant')
       AND record_value.flexible_period_id IS NOT NULL)
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
    AND (snapshot_value.scope_kind = 'shared'
         OR snapshot_value.owner_member_id = action_value.member_id)
    AND receipt_value.result_kind = 'tracking.fact-record.v1'
    AND receipt_value.aggregate_id = record_value.id
    AND receipt_value.aggregate_revision = after_value.revision_number
    AND receipt_value.completed_at = action_value.occurred_at
    AND t04_fact_record_has_exact_shape(record_value.id)
  ) IS TRUE;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION "t01_action_has_exact_shape"(target_action UUID)
RETURNS BOOLEAN AS $$
DECLARE
  type_value TEXT;
BEGIN
  SELECT command_type INTO type_value
    FROM tracking_action_groups WHERE id = target_action;
  IF type_value IN (
    'tracking.record-or-variant.v1',
    'tracking.record-composite-occurrence.v1'
  ) THEN
    RETURN t04_action_has_exact_shape(target_action);
  END IF;
  IF type_value IN (
    'tracking.record-text.v1', 'tracking.record-checklist-item.v1'
  ) THEN
    RETURN t03_action_has_exact_shape(target_action);
  END IF;
  RETURN t02_action_has_exact_shape(target_action);
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
      'tracking.record-composite-occurrence.v1'
    ) OR NEW.result_kind = 'tracking.fact-record.v1'
  ) AND NOT (
    NEW.command_type IN (
      'tracking.record-fact.v1', 'tracking.record-time.v1',
      'tracking.record-rating.v1', 'tracking.record-checkpoint.v1',
      'tracking.record-text.v1', 'tracking.record-checklist-item.v1',
      'tracking.record-or-variant.v1',
      'tracking.record-composite-occurrence.v1'
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
