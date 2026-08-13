-- T05 adds audited corrections and personal-record tombstones.
LOCK TABLE plan_months, plan_publications, plan_goal_snapshots,
  fixed_expectations, flexible_periods, tracking_fact_records,
  tracking_fact_revisions, tracking_action_groups, tracking_fact_changes,
  command_receipts IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM command_receipts
     WHERE command_type IN (
       'tracking.correct-record.v1', 'tracking.delete-record.v1'
     )
  ) THEN
    RAISE EXCEPTION 'T05 cannot adopt pre-existing correction receipts'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER FUNCTION "t01_fact_record_has_exact_shape"(UUID)
  RENAME TO "t04_fact_record_has_exact_shape_dispatch";
ALTER FUNCTION "t01_action_has_exact_shape"(UUID)
  RENAME TO "t04_action_has_exact_shape_dispatch";

ALTER TABLE "tracking_action_groups"
  ADD COLUMN "reason" TEXT,
  DROP CONSTRAINT "tracking_action_groups_action_check",
  ADD CONSTRAINT "tracking_action_groups_action_check" CHECK (
    "action_kind" IN ('fact_recorded', 'fact_corrected', 'fact_tombstoned')
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
      'tracking.delete-record.v1'
    )
  ),
  ADD CONSTRAINT "tracking_action_groups_reason_check" CHECK (
    ("action_kind" = 'fact_recorded' AND "reason" IS NULL)
    OR (
      "action_kind" IN ('fact_corrected', 'fact_tombstoned')
      AND "reason" IS NOT NULL
      AND length("reason") <= 2000
      AND t03_text_is_nonempty("reason")
    )
  );

CREATE FUNCTION "t05_fact_record_has_exact_shape"(target_record UUID)
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
     OR current_value.fact_record_id <> record_value.id
     OR current_value.revision_number <> maximum_revision
     OR revision_count <> maximum_revision
     OR maximum_revision < 2
     OR current_value.revision_kind <> 'tombstoned'
     OR record_value.updated_at <> current_value.created_at THEN
    RETURN FALSE;
  END IF;

  IF record_value.fixed_expectation_id IS NOT NULL THEN
    IF record_value.flexible_period_id IS NOT NULL OR fixed_value.id IS NULL
       OR fixed_value.publication_id <> record_value.publication_id
       OR fixed_value.plan_goal_snapshot_id <> record_value.plan_goal_snapshot_id
       OR fixed_value.expectation_date <> record_value.local_date THEN
      RETURN FALSE;
    END IF;
  ELSE
    IF record_value.flexible_period_id IS NULL OR period_value.id IS NULL
       OR period_value.publication_id <> record_value.publication_id
       OR period_value.plan_goal_snapshot_id <> record_value.plan_goal_snapshot_id
       OR period_value.period_target <= 0
       OR NOT (record_value.local_date = ANY(period_value.eligible_dates)) THEN
      RETURN FALSE;
    END IF;
  END IF;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION "t01_fact_record_has_exact_shape"(target_record UUID)
RETURNS BOOLEAN AS $$
DECLARE
  current_kind TEXT;
BEGIN
  SELECT revision.revision_kind INTO current_kind
    FROM tracking_fact_records record
    JOIN tracking_fact_revisions revision
      ON revision.id = record.current_revision_id
   WHERE record.id = target_record;
  IF current_kind = 'tombstoned' THEN
    RETURN t05_fact_record_has_exact_shape(target_record);
  END IF;
  RETURN t04_fact_record_has_exact_shape_dispatch(target_record);
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION "t05_action_has_exact_shape"(target_action UUID)
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
    AND action_value.actor_kind = 'member'
    AND action_value.actor_scope = 'member:' || action_value.member_id::text
    AND (
      (action_value.command_type = 'tracking.correct-record.v1'
       AND action_value.action_kind = 'fact_corrected'
       AND after_value.revision_kind = 'recorded')
      OR
      (action_value.command_type = 'tracking.delete-record.v1'
       AND action_value.action_kind = 'fact_tombstoned'
       AND before_value.revision_kind = 'recorded'
       AND after_value.revision_kind = 'tombstoned'
       AND snapshot_value.scope_kind = 'personal'
       AND snapshot_value.owner_member_id = action_value.member_id)
    )
    AND action_value.reason IS NOT NULL
    AND length(action_value.reason) <= 2000
    AND t03_text_is_nonempty(action_value.reason)
    AND action_value.before_facts_revision >= 0
    AND action_value.after_facts_revision = action_value.before_facts_revision + 1
    AND month_value.id = action_value.plan_month_id
    AND month_value.facts_revision = action_value.after_facts_revision
    AND month_value.status IN ('published', 'grace')
    AND month_value.active_publication_id = action_value.publication_id
    AND (action_value.occurred_at AT TIME ZONE 'Asia/Yekaterinburg')::date
        <= (month_value.month_start + INTERVAL '1 month + 2 days')::date
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
    AND before_value.id = change_value.before_revision_id
    AND before_value.fact_record_id = record_value.id
    AND after_value.fact_record_id = record_value.id
    AND after_value.revision_number = before_value.revision_number + 1
    AND after_value.recorded_by_member_id = action_value.member_id
    AND after_value.created_at = action_value.occurred_at
    AND (snapshot_value.scope_kind = 'shared'
         OR snapshot_value.owner_member_id = action_value.member_id)
    AND receipt_value.result_kind = 'tracking.fact-record.v1'
    AND receipt_value.aggregate_id = record_value.id
    AND receipt_value.aggregate_revision = after_value.revision_number
    AND receipt_value.completed_at = action_value.occurred_at
    AND (
      (after_value.revision_kind = 'recorded'
       AND t04_fact_record_has_exact_shape_dispatch(record_value.id))
      OR
      (after_value.revision_kind = 'tombstoned'
       AND t05_fact_record_has_exact_shape(record_value.id))
    )
  ) IS TRUE;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION "t01_action_has_exact_shape"(target_action UUID)
RETURNS BOOLEAN AS $$
DECLARE
  action_value tracking_action_groups%ROWTYPE;
BEGIN
  SELECT * INTO action_value FROM tracking_action_groups WHERE id = target_action;
  IF action_value.command_type IN (
    'tracking.correct-record.v1', 'tracking.delete-record.v1'
  ) THEN
    RETURN t05_action_has_exact_shape(target_action);
  END IF;
  RETURN t04_action_has_exact_shape_dispatch(target_action);
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
       'tracking.correct-record.v1', 'tracking.delete-record.v1'
     ) THEN
    RAISE EXCEPTION 'old tracking command cannot append a correction'
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
      'tracking.correct-record.v1', 'tracking.delete-record.v1'
    ) OR NEW.result_kind = 'tracking.fact-record.v1'
  ) AND NOT (
    NEW.command_type IN (
      'tracking.record-fact.v1', 'tracking.record-time.v1',
      'tracking.record-rating.v1', 'tracking.record-checkpoint.v1',
      'tracking.record-text.v1', 'tracking.record-checklist-item.v1',
      'tracking.record-or-variant.v1',
      'tracking.record-composite-occurrence.v1',
      'tracking.correct-record.v1', 'tracking.delete-record.v1'
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
