ALTER TABLE "plan_months"
  ADD COLUMN "lifecycle_mode" VARCHAR(16) NOT NULL DEFAULT 'ordinary',
  ADD CONSTRAINT "plan_months_lifecycle_mode_check"
    CHECK ("lifecycle_mode" IN ('ordinary', 'reopened'));

CREATE TABLE "planning_month_reopen_changes" (
    "action_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,

    CONSTRAINT "planning_month_reopen_changes_pkey" PRIMARY KEY ("action_id"),
    CONSTRAINT "planning_month_reopen_changes_reason_check"
      CHECK (btrim("reason") <> '' AND char_length("reason") <= 2000),
    CONSTRAINT "planning_month_reopen_changes_action_id_fkey"
      FOREIGN KEY ("action_id") REFERENCES "planning_action_groups"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "planning_month_reopen_action_revision_key"
  ON "planning_action_groups"("plan_month_id", "after_revision")
  WHERE "action_kind" = 'month_reopened';

CREATE FUNCTION "require_l02_reopen_change_parent"()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM planning_action_groups action
     WHERE action.id = NEW.action_id
       AND action.action_kind = 'month_reopened'
       AND action.actor_kind = 'member'
       AND action.member_id IS NOT NULL
       AND action.system_actor_id IS NULL
       AND action.command_type = 'planning.reopen-month.v1'
  ) THEN
    RAISE EXCEPTION 'reopen detail requires exact member reopen action'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "planning_month_reopen_changes_parent_check"
BEFORE INSERT ON "planning_month_reopen_changes"
FOR EACH ROW EXECUTE FUNCTION "require_l02_reopen_change_parent"();

CREATE FUNCTION "require_l02_reopen_action_detail"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.action_kind = 'month_reopened'
     AND NOT EXISTS (
       SELECT 1 FROM planning_month_reopen_changes change
        WHERE change.action_id = NEW.id
     ) THEN
    RAISE EXCEPTION 'month reopen action requires immutable detail'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "planning_month_reopen_action_detail_consistent"
AFTER INSERT ON "planning_action_groups"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_l02_reopen_action_detail"();

CREATE TRIGGER "planning_month_reopen_changes_reject_update_delete"
BEFORE UPDATE OR DELETE ON "planning_month_reopen_changes"
FOR EACH ROW EXECUTE FUNCTION "reject_p01_immutable_row_change"();

ALTER TABLE "planning_action_groups"
  DROP CONSTRAINT "planning_action_groups_action_kind_check",
  ADD CONSTRAINT "planning_action_groups_action_kind_check" CHECK (
    "action_kind" IN (
      'draft_created', 'draft_copied', 'draft_created_from_seed',
      'month_focus_updated', 'goal_definition_created',
      'goal_definition_versioned', 'goal_definition_archived',
      'goal_definition_restored', 'goal_definition_copied',
      'draft_goal_added', 'draft_goal_updated', 'draft_goal_removed',
      'draft_goals_reordered', 'month_published',
      'month_publication_cancelled', 'month_grace_started',
      'month_closed', 'month_reopened'
    )
  ),
  DROP CONSTRAINT "planning_action_groups_target_check",
  ADD CONSTRAINT "planning_action_groups_target_check" CHECK (
    ("action_kind" IN (
      'draft_created', 'draft_copied', 'draft_created_from_seed',
      'month_focus_updated', 'draft_goal_added', 'draft_goal_updated',
      'draft_goal_removed', 'draft_goals_reordered', 'month_published',
      'month_publication_cancelled', 'month_grace_started',
      'month_closed', 'month_reopened'
    ) AND "plan_month_id" IS NOT NULL AND "goal_definition_id" IS NULL)
    OR ("action_kind" IN (
      'goal_definition_created', 'goal_definition_versioned',
      'goal_definition_archived', 'goal_definition_restored',
      'goal_definition_copied'
    ) AND "plan_month_id" IS NULL AND "goal_definition_id" IS NOT NULL)
  );

DROP TRIGGER "plan_months_guard_l01_lifecycle_update" ON "plan_months";
DROP FUNCTION "guard_l01_month_lifecycle_update"();

CREATE FUNCTION "guard_l02_month_lifecycle_update"()
RETURNS TRIGGER AS $$
DECLARE
  publication plan_publications%ROWTYPE;
  cancellation_local_date DATE;
BEGIN
  IF (NEW.id = OLD.id
      AND NEW.space_id = OLD.space_id
      AND NEW.month_start = OLD.month_start
      AND NEW.created_at = OLD.created_at) IS NOT TRUE THEN
    RAISE EXCEPTION 'plan month identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;

  IF (OLD.status IN ('published', 'grace')
      AND NEW.status = OLD.status
      AND NEW.lifecycle_mode = OLD.lifecycle_mode
      AND NEW.active_publication_id = OLD.active_publication_id
      AND NEW.revision = OLD.revision
      AND NEW.updated_at = OLD.updated_at
      AND NEW.facts_revision = OLD.facts_revision + 1) THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'draft' THEN
    SELECT * INTO publication FROM plan_publications
     WHERE id = NEW.active_publication_id AND plan_month_id = OLD.id;
    IF (OLD.active_publication_id IS NULL
        AND OLD.lifecycle_mode = 'ordinary'
        AND OLD.facts_revision = 0
        AND NEW.status = 'published'
        AND NEW.lifecycle_mode = 'ordinary'
        AND NEW.active_publication_id IS NOT NULL
        AND NEW.revision = OLD.revision + 1
        AND NEW.facts_revision = OLD.facts_revision
        AND NEW.updated_at = publication.published_at
        AND publication.source_plan_month_revision = OLD.revision) IS NOT TRUE
    THEN
      RAISE EXCEPTION 'invalid publication lifecycle transition'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'published' AND NEW.status = 'draft' THEN
    SELECT * INTO publication FROM plan_publications
     WHERE id = OLD.active_publication_id AND plan_month_id = OLD.id;
    cancellation_local_date :=
      (NEW.updated_at AT TIME ZONE 'Asia/Yekaterinburg')::date;
    IF (OLD.lifecycle_mode = 'ordinary'
        AND OLD.active_publication_id IS NOT NULL
        AND publication.id = OLD.active_publication_id
        AND OLD.facts_revision = 0
        AND NEW.lifecycle_mode = 'ordinary'
        AND NEW.active_publication_id IS NULL
        AND NEW.revision = OLD.revision + 1
        AND NEW.facts_revision = 0
        AND NEW.updated_at >= publication.published_at
        AND cancellation_local_date < OLD.month_start) IS NOT TRUE THEN
      RAISE EXCEPTION 'invalid publication cancellation lifecycle transition'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF (OLD.status = 'published'
      AND OLD.lifecycle_mode = 'ordinary'
      AND NEW.status = 'grace'
      AND NEW.lifecycle_mode = 'ordinary'
      AND NEW.active_publication_id = OLD.active_publication_id
      AND NEW.revision = OLD.revision + 1
      AND NEW.facts_revision = OLD.facts_revision
      AND (NEW.updated_at AT TIME ZONE 'Asia/Yekaterinburg')::date >=
          (OLD.month_start + INTERVAL '1 month')::date) THEN
    RETURN NEW;
  END IF;

  IF (OLD.status = 'grace'
      AND OLD.lifecycle_mode = 'ordinary'
      AND NEW.status = 'closed'
      AND NEW.lifecycle_mode = 'ordinary'
      AND NEW.active_publication_id = OLD.active_publication_id
      AND NEW.revision = OLD.revision + 1
      AND NEW.facts_revision = OLD.facts_revision
      AND (NEW.updated_at AT TIME ZONE 'Asia/Yekaterinburg')::date >=
          (OLD.month_start + INTERVAL '1 month' + INTERVAL '3 days')::date) THEN
    RETURN NEW;
  END IF;

  IF (OLD.status = 'closed'
      AND NEW.status = 'grace'
      AND NEW.lifecycle_mode = 'reopened'
      AND NEW.active_publication_id = OLD.active_publication_id
      AND NEW.revision = OLD.revision + 1
      AND NEW.facts_revision = OLD.facts_revision) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'plan month lifecycle transition is not available in L02'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "plan_months_guard_l02_lifecycle_update"
BEFORE UPDATE ON "plan_months"
FOR EACH ROW EXECUTE FUNCTION "guard_l02_month_lifecycle_update"();

DROP TRIGGER "plan_months_lifecycle_effect_consistent" ON "plan_months";
DROP FUNCTION "require_l01_month_lifecycle_effect"();

CREATE FUNCTION "require_l02_month_lifecycle_effect"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'published' AND NEW.status = 'draft' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM planning_action_groups action
        JOIN planning_publication_changes change
          ON change.action_id = action.id
         AND change.change_kind = 'cancelled'
        JOIN command_receipts receipt
          ON receipt.actor_scope = action.actor_scope
         AND receipt.command_type = action.command_type
         AND receipt.command_id = action.command_id
       WHERE action.plan_month_id = NEW.id
         AND action.action_kind = 'month_publication_cancelled'
         AND action.before_revision = OLD.revision
         AND action.after_revision = NEW.revision
         AND action.occurred_at = NEW.updated_at
         AND change.publication_id = OLD.active_publication_id
         AND receipt.result_kind = 'planning.plan-month.v1'
         AND receipt.aggregate_id = NEW.id
         AND receipt.aggregate_revision = NEW.revision
         AND receipt.completed_at = NEW.updated_at
    ) THEN
      RAISE EXCEPTION 'publication cancellation requires exact history and receipt'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF OLD.status = 'grace' AND NEW.status = 'closed' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM report_revisions report
        JOIN planning_action_groups action
          ON action.plan_month_id = NEW.id
         AND action.action_kind = 'month_closed'
         AND action.actor_kind = 'system'
         AND action.actor_scope = 'system:planner-worker'
         AND action.system_actor_id = 'planner-worker'
         AND action.command_type = 'planning.close-month.v1'
         AND action.before_revision = OLD.revision
         AND action.after_revision = NEW.revision
         AND action.occurred_at = NEW.updated_at
        JOIN command_receipts receipt
          ON receipt.actor_scope = action.actor_scope
         AND receipt.command_type = action.command_type
         AND receipt.command_id = action.command_id
       WHERE report.plan_month_id = NEW.id
        AND report.publication_id = OLD.active_publication_id
        AND report.status = 'original'
        AND report.source_facts_revision = OLD.facts_revision
        AND report.publication_snapshot_hash = (
          SELECT publication.preview_hash
            FROM plan_publications publication
           WHERE publication.id = OLD.active_publication_id
        )
        AND report.created_at = NEW.updated_at
        AND receipt.result_kind = 'planning.report-revision.v1'
        AND receipt.actor_scope = 'system:planner-worker'
        AND receipt.command_type = 'planning.close-month.v1'
        AND receipt.aggregate_id = report.id
        AND receipt.aggregate_revision = report.revision
        AND receipt.completed_at = NEW.updated_at
    ) THEN
      RAISE EXCEPTION 'month close requires exact report revision, history and receipt'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF OLD.status = 'published' AND NEW.status = 'grace' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM planning_action_groups action
        JOIN command_receipts receipt
          ON receipt.actor_scope = action.actor_scope
         AND receipt.command_type = action.command_type
         AND receipt.command_id = action.command_id
       WHERE action.plan_month_id = NEW.id
         AND action.action_kind = 'month_grace_started'
         AND action.actor_kind = 'system'
         AND action.actor_scope = 'system:planner-worker'
         AND action.system_actor_id = 'planner-worker'
         AND action.command_type = 'planning.start-month-grace.v1'
         AND action.before_revision = OLD.revision
         AND action.after_revision = NEW.revision
         AND action.occurred_at = NEW.updated_at
         AND receipt.result_kind = 'planning.plan-month.v1'
         AND receipt.actor_scope = 'system:planner-worker'
         AND receipt.command_type = 'planning.start-month-grace.v1'
         AND receipt.aggregate_id = NEW.id
         AND receipt.aggregate_revision = NEW.revision
         AND receipt.completed_at = NEW.updated_at
    ) THEN
      RAISE EXCEPTION 'month grace start requires exact history and receipt'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF OLD.status = 'closed' AND NEW.status = 'grace' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM planning_action_groups action
        JOIN planning_month_reopen_changes change
          ON change.action_id = action.id
        JOIN command_receipts receipt
          ON receipt.actor_scope = action.actor_scope
         AND receipt.command_type = action.command_type
         AND receipt.command_id = action.command_id
       WHERE action.plan_month_id = NEW.id
         AND action.action_kind = 'month_reopened'
         AND action.actor_kind = 'member'
         AND action.member_id IS NOT NULL
         AND action.actor_scope LIKE 'member:%'
         AND action.system_actor_id IS NULL
         AND action.command_type = 'planning.reopen-month.v1'
         AND action.before_revision = OLD.revision
         AND action.after_revision = NEW.revision
         AND action.occurred_at = NEW.updated_at
         AND receipt.result_kind = 'planning.plan-month.v1'
         AND receipt.actor_scope = action.actor_scope
         AND receipt.command_type = action.command_type
         AND receipt.aggregate_id = NEW.id
         AND receipt.aggregate_revision = NEW.revision
         AND receipt.completed_at = NEW.updated_at
    ) THEN
      RAISE EXCEPTION 'month reopen requires exact history, reason and receipt'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "plan_months_lifecycle_effect_consistent"
AFTER UPDATE OF status, lifecycle_mode, revision, active_publication_id
ON "plan_months"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_l02_month_lifecycle_effect"();

DROP TRIGGER "command_receipts_l01_effect_consistent" ON "command_receipts";
DROP FUNCTION "require_l01_command_receipt_effect"();

CREATE FUNCTION "require_l02_command_receipt_effect"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.command_type = 'planning.start-month-grace.v1' THEN
    IF (NEW.actor_scope = 'system:planner-worker'
        AND NEW.result_kind = 'planning.plan-month.v1'
        AND EXISTS (
          SELECT 1
            FROM plan_months month
            JOIN planning_action_groups action
              ON action.plan_month_id = month.id
             AND action.action_kind = 'month_grace_started'
             AND action.actor_kind = 'system'
             AND action.actor_scope = NEW.actor_scope
             AND action.system_actor_id = 'planner-worker'
             AND action.command_type = NEW.command_type
             AND action.command_id = NEW.command_id
             AND action.before_revision = NEW.aggregate_revision - 1
             AND action.after_revision = NEW.aggregate_revision
             AND action.occurred_at = NEW.completed_at
           WHERE month.id = NEW.aggregate_id
             AND month.status = 'grace'
             AND month.lifecycle_mode = 'ordinary'
             AND month.revision = NEW.aggregate_revision
        )) IS NOT TRUE THEN
      RAISE EXCEPTION 'grace receipt requires exact lifecycle effect'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.command_type = 'planning.reopen-month.v1' THEN
    IF (NEW.actor_scope LIKE 'member:%'
        AND NEW.result_kind = 'planning.plan-month.v1'
        AND EXISTS (
          SELECT 1
            FROM plan_months month
            JOIN planning_action_groups action
              ON action.plan_month_id = month.id
             AND action.action_kind = 'month_reopened'
             AND action.actor_kind = 'member'
             AND action.actor_scope = NEW.actor_scope
             AND action.command_type = NEW.command_type
             AND action.command_id = NEW.command_id
             AND action.before_revision = NEW.aggregate_revision - 1
             AND action.after_revision = NEW.aggregate_revision
             AND action.occurred_at = NEW.completed_at
            JOIN planning_month_reopen_changes change
              ON change.action_id = action.id
           WHERE month.id = NEW.aggregate_id
             AND month.status = 'grace'
             AND month.lifecycle_mode = 'reopened'
             AND month.revision = NEW.aggregate_revision
             AND month.updated_at = NEW.completed_at
        )) IS NOT TRUE THEN
      RAISE EXCEPTION 'reopen receipt requires exact lifecycle effect'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.command_type = 'planning.close-month.v1' THEN
    IF (NEW.actor_scope = 'system:planner-worker'
        AND NEW.result_kind = 'planning.report-revision.v1'
        AND EXISTS (
          SELECT 1
            FROM plan_months month
            JOIN report_revisions report
              ON report.id = NEW.aggregate_id
             AND report.plan_month_id = month.id
             AND report.status = 'original'
             AND report.revision = NEW.aggregate_revision
             AND report.created_at = month.updated_at
            JOIN planning_action_groups action
              ON action.plan_month_id = month.id
             AND action.action_kind = 'month_closed'
             AND action.actor_kind = 'system'
             AND action.actor_scope = NEW.actor_scope
             AND action.system_actor_id = 'planner-worker'
             AND action.command_type = NEW.command_type
             AND action.command_id = NEW.command_id
             AND action.before_revision = month.revision - 1
             AND action.after_revision = month.revision
             AND action.occurred_at = month.updated_at
           WHERE month.id = report.plan_month_id
             AND month.status = 'closed'
             AND month.lifecycle_mode = 'ordinary'
             AND month.revision > 1
        )) IS NOT TRUE THEN
      RAISE EXCEPTION 'close receipt requires exact report and lifecycle effect'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "command_receipts_l02_effect_consistent"
AFTER INSERT ON "command_receipts"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_l02_command_receipt_effect"();

-- Reopened months keep the T05 correction/delete shape but intentionally
-- remove the ordinary three-day correction deadline.  The original T05
-- function is recreated here because migrations are immutable and PostgreSQL
-- does not support altering a function body in place.
CREATE OR REPLACE FUNCTION "t05_action_has_exact_shape"(target_action UUID)
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
    AND (
      month_value.lifecycle_mode = 'reopened'
      OR (action_value.occurred_at AT TIME ZONE 'Asia/Yekaterinburg')::date
         <= (month_value.month_start + INTERVAL '1 month + 2 days')::date
    )
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

-- L02 narrows the entire tracking envelope, not only the application
-- commands.  Existing T01/T10 shape functions intentionally accept a grace
-- month, so keep their ordinary behavior and reject every non-T05 action at
-- the deferred boundary while the month is reopened.
CREATE FUNCTION "reject_l02_reopened_tracking_action"()
RETURNS TRIGGER AS $$
DECLARE
  lifecycle_mode_value TEXT;
BEGIN
  SELECT COALESCE(to_jsonb(month)->>'lifecycle_mode', 'ordinary')
    INTO lifecycle_mode_value
    FROM plan_months month
   WHERE month.id = NEW.plan_month_id;
  IF lifecycle_mode_value = 'reopened'
     AND NEW.action_kind NOT IN ('fact_corrected', 'fact_tombstoned') THEN
    RAISE EXCEPTION 'reopened month permits only T05 correction or delete'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "tracking_action_groups_l02_reopened_boundary"
AFTER INSERT ON "tracking_action_groups"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "reject_l02_reopened_tracking_action"();
