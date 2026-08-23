ALTER TABLE "report_revisions"
  DROP CONSTRAINT "report_revisions_actor_check",
  ALTER COLUMN "created_by_system_actor_id" DROP NOT NULL,
  ADD COLUMN "created_by_member_id" UUID,
  ADD CONSTRAINT "report_revisions_created_by_member_fkey"
    FOREIGN KEY ("created_by_member_id") REFERENCES "memberships"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "report_revisions_actor_check" CHECK (
    ("status" = 'original'
      AND "created_by_system_actor_id" = 'planner-worker'
      AND "created_by_member_id" IS NULL)
    OR
    ("status" = 'revised'
      AND "created_by_system_actor_id" IS NULL
      AND "created_by_member_id" IS NOT NULL)
  );

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
      'month_closed', 'month_reopened', 'month_reclosed'
    )
  ),
  DROP CONSTRAINT "planning_action_groups_target_check",
  ADD CONSTRAINT "planning_action_groups_target_check" CHECK (
    ("action_kind" IN (
      'draft_created', 'draft_copied', 'draft_created_from_seed',
      'month_focus_updated', 'draft_goal_added', 'draft_goal_updated',
      'draft_goal_removed', 'draft_goals_reordered', 'month_published',
      'month_publication_cancelled', 'month_grace_started',
      'month_closed', 'month_reopened', 'month_reclosed'
    ) AND "plan_month_id" IS NOT NULL AND "goal_definition_id" IS NULL)
    OR ("action_kind" IN (
      'goal_definition_created', 'goal_definition_versioned',
      'goal_definition_archived', 'goal_definition_restored',
      'goal_definition_copied'
    ) AND "plan_month_id" IS NULL AND "goal_definition_id" IS NOT NULL)
  );

CREATE UNIQUE INDEX "planning_action_groups_reclose_revision_key"
  ON "planning_action_groups"("plan_month_id", "after_revision")
  WHERE "action_kind" = 'month_reclosed';

DROP TRIGGER "plan_months_guard_l02_lifecycle_update" ON "plan_months";
DROP FUNCTION "guard_l02_month_lifecycle_update"();

CREATE FUNCTION "guard_l03_month_lifecycle_update"()
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
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
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
  IF (OLD.status = 'grace'
      AND OLD.lifecycle_mode = 'reopened'
      AND NEW.status = 'closed'
      AND NEW.lifecycle_mode = 'reopened'
      AND NEW.active_publication_id = OLD.active_publication_id
      AND NEW.revision = OLD.revision + 1
      AND NEW.facts_revision = OLD.facts_revision) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'plan month lifecycle transition is not available in L03'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "plan_months_guard_l03_lifecycle_update"
BEFORE UPDATE ON "plan_months"
FOR EACH ROW EXECUTE FUNCTION "guard_l03_month_lifecycle_update"();

DROP TRIGGER "plan_months_lifecycle_effect_consistent" ON "plan_months";
DROP FUNCTION "require_l02_month_lifecycle_effect"();

CREATE FUNCTION "require_l03_month_lifecycle_effect"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'published' AND NEW.status = 'draft' AND NOT EXISTS (
    SELECT 1 FROM planning_action_groups action
    JOIN planning_publication_changes change ON change.action_id = action.id
      AND change.change_kind = 'cancelled'
    JOIN command_receipts receipt ON receipt.actor_scope = action.actor_scope
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

  IF OLD.status = 'grace' AND NEW.status = 'closed' THEN
    IF OLD.lifecycle_mode = 'ordinary' AND NOT EXISTS (
      SELECT 1 FROM report_revisions report
      JOIN plan_publications publication
        ON publication.id = OLD.active_publication_id
       AND publication.plan_month_id = NEW.id
      JOIN planning_action_groups action ON action.plan_month_id = NEW.id
        AND action.action_kind = 'month_closed'
        AND action.actor_kind = 'system'
        AND action.actor_scope = 'system:planner-worker'
        AND action.member_id IS NULL
        AND action.system_actor_id = 'planner-worker'
        AND action.command_type = 'planning.close-month.v1'
        AND action.before_revision = OLD.revision
        AND action.after_revision = NEW.revision
        AND action.occurred_at = NEW.updated_at
      JOIN command_receipts receipt ON receipt.actor_scope = action.actor_scope
        AND receipt.command_type = action.command_type
        AND receipt.command_id = action.command_id
      WHERE report.plan_month_id = NEW.id
        AND report.publication_id = OLD.active_publication_id
        AND report.publication_snapshot_hash = publication.preview_hash
        AND report.status = 'original'
        AND report.created_by_system_actor_id = 'planner-worker'
        AND report.created_by_member_id IS NULL
        AND report.source_facts_revision = OLD.facts_revision
        AND report.created_at = NEW.updated_at
        AND receipt.result_kind = 'planning.report-revision.v1'
        AND receipt.aggregate_id = report.id
        AND receipt.aggregate_revision = report.revision
        AND receipt.completed_at = NEW.updated_at
    ) THEN
      RAISE EXCEPTION 'month close requires exact report revision, history and receipt'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.lifecycle_mode = 'reopened' AND NOT EXISTS (
      SELECT 1 FROM report_revisions report
      JOIN plan_publications publication
        ON publication.id = OLD.active_publication_id
       AND publication.plan_month_id = NEW.id
      JOIN memberships author ON author.id = report.created_by_member_id
        AND author.space_id = NEW.space_id
      JOIN planning_action_groups action ON action.plan_month_id = NEW.id
        AND action.action_kind = 'month_reclosed'
        AND action.actor_kind = 'member'
        AND action.actor_scope = 'member:' || author.id::text
        AND action.member_id = author.id
        AND action.system_actor_id IS NULL
        AND action.command_type = 'planning.reclose-month.v1'
        AND action.before_revision = OLD.revision
        AND action.after_revision = NEW.revision
        AND action.occurred_at = NEW.updated_at
      JOIN command_receipts receipt ON receipt.actor_scope = action.actor_scope
        AND receipt.command_type = action.command_type
        AND receipt.command_id = action.command_id
      WHERE report.plan_month_id = NEW.id
        AND report.publication_id = OLD.active_publication_id
        AND report.publication_snapshot_hash = publication.preview_hash
        AND report.status = 'revised'
        AND report.created_by_system_actor_id IS NULL
        AND report.source_facts_revision = OLD.facts_revision
        AND report.created_at = NEW.updated_at
        AND receipt.result_kind = 'planning.report-revision.v1'
        AND receipt.aggregate_id = report.id
        AND receipt.aggregate_revision = report.revision
        AND receipt.completed_at = NEW.updated_at
    ) THEN
      RAISE EXCEPTION 'month reclose requires exact revised report, history and receipt'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF OLD.status = 'published' AND NEW.status = 'grace' AND NOT EXISTS (
    SELECT 1 FROM planning_action_groups action
    JOIN command_receipts receipt ON receipt.actor_scope = action.actor_scope
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
      AND receipt.aggregate_id = NEW.id
      AND receipt.aggregate_revision = NEW.revision
      AND receipt.completed_at = NEW.updated_at
  ) THEN
    RAISE EXCEPTION 'month grace start requires exact history and receipt'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'closed' AND NEW.status = 'grace' AND NOT EXISTS (
    SELECT 1 FROM planning_action_groups action
    JOIN planning_month_reopen_changes change ON change.action_id = action.id
    JOIN command_receipts receipt ON receipt.actor_scope = action.actor_scope
      AND receipt.command_type = action.command_type
      AND receipt.command_id = action.command_id
    WHERE action.plan_month_id = NEW.id
      AND action.action_kind = 'month_reopened'
      AND action.actor_kind = 'member'
      AND action.actor_scope = 'member:' || action.member_id::text
      AND action.system_actor_id IS NULL
      AND action.command_type = 'planning.reopen-month.v1'
      AND action.before_revision = OLD.revision
      AND action.after_revision = NEW.revision
      AND action.occurred_at = NEW.updated_at
      AND receipt.result_kind = 'planning.plan-month.v1'
      AND receipt.aggregate_id = NEW.id
      AND receipt.aggregate_revision = NEW.revision
      AND receipt.completed_at = NEW.updated_at
  ) THEN
    RAISE EXCEPTION 'month reopen requires exact history, reason and receipt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "plan_months_lifecycle_effect_consistent"
AFTER UPDATE OF status, lifecycle_mode, revision, active_publication_id
ON "plan_months"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_l03_month_lifecycle_effect"();

DROP TRIGGER "report_revisions_lifecycle_effect_consistent" ON "report_revisions";
DROP FUNCTION "require_l01_report_revision_effect"();

CREATE FUNCTION "require_l03_report_revision_effect"()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM report_revisions report
     WHERE report.plan_month_id = NEW.plan_month_id
     GROUP BY report.plan_month_id
    HAVING MIN(report.revision) <> 1
        OR COUNT(*)::bigint <> MAX(report.revision)
  ) THEN
    RAISE EXCEPTION 'report revisions must form a dense sequence'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'original' AND NOT EXISTS (
    SELECT 1 FROM plan_months month
    JOIN plan_publications publication
      ON publication.id = month.active_publication_id
     AND publication.plan_month_id = month.id
    JOIN planning_action_groups action ON action.plan_month_id = month.id
      AND action.action_kind = 'month_closed'
      AND action.actor_kind = 'system'
      AND action.actor_scope = 'system:planner-worker'
      AND action.member_id IS NULL
      AND action.system_actor_id = 'planner-worker'
      AND action.command_type = 'planning.close-month.v1'
      AND action.before_revision = month.revision - 1
      AND action.after_revision = month.revision
      AND action.occurred_at = NEW.created_at
    JOIN command_receipts receipt ON receipt.actor_scope = action.actor_scope
      AND receipt.command_type = action.command_type
      AND receipt.command_id = action.command_id
    WHERE month.id = NEW.plan_month_id
      AND month.status = 'closed'
      AND month.lifecycle_mode = 'ordinary'
      AND NEW.publication_id = month.active_publication_id
      AND NEW.publication_snapshot_hash = publication.preview_hash
      AND NEW.source_facts_revision = month.facts_revision
      AND receipt.result_kind = 'planning.report-revision.v1'
      AND receipt.aggregate_id = NEW.id
      AND receipt.aggregate_revision = NEW.revision
      AND receipt.completed_at = NEW.created_at
  ) THEN
    RAISE EXCEPTION 'original report revision requires exact close effect'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'revised' AND NOT EXISTS (
    SELECT 1 FROM plan_months month
    JOIN plan_publications publication
      ON publication.id = month.active_publication_id
     AND publication.plan_month_id = month.id
    JOIN memberships author ON author.id = NEW.created_by_member_id
      AND author.space_id = month.space_id
    JOIN planning_action_groups action ON action.plan_month_id = month.id
      AND action.action_kind = 'month_reclosed'
      AND action.actor_kind = 'member'
      AND action.actor_scope = 'member:' || author.id::text
      AND action.member_id = author.id
      AND action.system_actor_id IS NULL
      AND action.command_type = 'planning.reclose-month.v1'
      AND action.before_revision = month.revision - 1
      AND action.after_revision = month.revision
      AND action.occurred_at = NEW.created_at
    JOIN command_receipts receipt ON receipt.actor_scope = action.actor_scope
      AND receipt.command_type = action.command_type
      AND receipt.command_id = action.command_id
    WHERE month.id = NEW.plan_month_id
      AND month.status = 'closed'
      AND month.lifecycle_mode = 'reopened'
      AND NEW.publication_id = month.active_publication_id
      AND NEW.publication_snapshot_hash = publication.preview_hash
      AND NEW.source_facts_revision = month.facts_revision
      AND receipt.result_kind = 'planning.report-revision.v1'
      AND receipt.aggregate_id = NEW.id
      AND receipt.aggregate_revision = NEW.revision
      AND receipt.completed_at = NEW.created_at
  ) THEN
    RAISE EXCEPTION 'revised report revision requires exact reclose effect'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "report_revisions_lifecycle_effect_consistent"
AFTER INSERT ON "report_revisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_l03_report_revision_effect"();

CREATE FUNCTION "require_l03_close_action_effect"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.action_kind = 'month_closed' AND NOT EXISTS (
    SELECT 1 FROM plan_months month
    JOIN plan_publications publication
      ON publication.id = month.active_publication_id
     AND publication.plan_month_id = month.id
    JOIN report_revisions report ON report.plan_month_id = month.id
      AND report.status = 'original'
      AND report.created_by_system_actor_id = 'planner-worker'
      AND report.created_by_member_id IS NULL
      AND report.publication_id = month.active_publication_id
      AND report.publication_snapshot_hash = publication.preview_hash
      AND report.source_facts_revision = month.facts_revision
      AND report.created_at = NEW.occurred_at
    JOIN command_receipts receipt ON receipt.actor_scope = NEW.actor_scope
      AND receipt.command_type = NEW.command_type
      AND receipt.command_id = NEW.command_id
      AND receipt.result_kind = 'planning.report-revision.v1'
      AND receipt.aggregate_id = report.id
      AND receipt.aggregate_revision = report.revision
      AND receipt.completed_at = NEW.occurred_at
    WHERE month.id = NEW.plan_month_id
      AND month.status = 'closed'
      AND month.lifecycle_mode = 'ordinary'
      AND month.revision = NEW.after_revision
      AND NEW.before_revision = month.revision - 1
      AND NEW.actor_kind = 'system'
      AND NEW.actor_scope = 'system:planner-worker'
      AND NEW.member_id IS NULL
      AND NEW.system_actor_id = 'planner-worker'
      AND NEW.command_type = 'planning.close-month.v1'
  ) THEN
    RAISE EXCEPTION 'month close action requires exact report, lifecycle and receipt'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.action_kind = 'month_reclosed' AND NOT EXISTS (
    SELECT 1 FROM plan_months month
    JOIN plan_publications publication
      ON publication.id = month.active_publication_id
     AND publication.plan_month_id = month.id
    JOIN memberships author ON author.id = NEW.member_id
      AND author.space_id = month.space_id
    JOIN report_revisions report ON report.plan_month_id = month.id
      AND report.status = 'revised'
      AND report.created_by_system_actor_id IS NULL
      AND report.created_by_member_id = author.id
      AND report.publication_id = month.active_publication_id
      AND report.publication_snapshot_hash = publication.preview_hash
      AND report.source_facts_revision = month.facts_revision
      AND report.created_at = NEW.occurred_at
    JOIN command_receipts receipt ON receipt.actor_scope = NEW.actor_scope
      AND receipt.command_type = NEW.command_type
      AND receipt.command_id = NEW.command_id
      AND receipt.result_kind = 'planning.report-revision.v1'
      AND receipt.aggregate_id = report.id
      AND receipt.aggregate_revision = report.revision
      AND receipt.completed_at = NEW.occurred_at
    WHERE month.id = NEW.plan_month_id
      AND month.status = 'closed'
      AND month.lifecycle_mode = 'reopened'
      AND month.revision = NEW.after_revision
      AND NEW.before_revision = month.revision - 1
      AND NEW.actor_kind = 'member'
      AND NEW.actor_scope = 'member:' || author.id::text
      AND NEW.system_actor_id IS NULL
      AND NEW.command_type = 'planning.reclose-month.v1'
  ) THEN
    RAISE EXCEPTION 'month reclose action requires exact report, lifecycle and receipt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "planning_close_action_l03_effect_consistent"
AFTER INSERT ON "planning_action_groups"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_l03_close_action_effect"();

DROP TRIGGER "command_receipts_l02_effect_consistent" ON "command_receipts";
DROP FUNCTION "require_l02_command_receipt_effect"();

CREATE FUNCTION "require_l03_command_receipt_effect"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.command_type = 'planning.start-month-grace.v1' THEN
    IF (NEW.actor_scope = 'system:planner-worker'
        AND NEW.result_kind = 'planning.plan-month.v1'
        AND EXISTS (
          SELECT 1 FROM plan_months month
          JOIN planning_action_groups action ON action.plan_month_id = month.id
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
          SELECT 1 FROM plan_months month
          JOIN planning_action_groups action ON action.plan_month_id = month.id
            AND action.action_kind = 'month_reopened'
            AND action.actor_kind = 'member'
            AND action.actor_scope = NEW.actor_scope
            AND action.command_type = NEW.command_type
            AND action.command_id = NEW.command_id
            AND action.before_revision = NEW.aggregate_revision - 1
            AND action.after_revision = NEW.aggregate_revision
            AND action.occurred_at = NEW.completed_at
          JOIN planning_month_reopen_changes change ON change.action_id = action.id
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
          SELECT 1 FROM plan_months month
          JOIN plan_publications publication
            ON publication.id = month.active_publication_id
           AND publication.plan_month_id = month.id
          JOIN report_revisions report ON report.id = NEW.aggregate_id
            AND report.plan_month_id = month.id
            AND report.status = 'original'
            AND report.created_by_system_actor_id = 'planner-worker'
            AND report.created_by_member_id IS NULL
            AND report.revision = NEW.aggregate_revision
            AND report.publication_snapshot_hash = publication.preview_hash
            AND report.created_at = month.updated_at
          JOIN planning_action_groups action ON action.plan_month_id = month.id
            AND action.action_kind = 'month_closed'
            AND action.actor_kind = 'system'
            AND action.actor_scope = NEW.actor_scope
            AND action.system_actor_id = 'planner-worker'
            AND action.command_type = NEW.command_type
            AND action.command_id = NEW.command_id
            AND action.before_revision = month.revision - 1
            AND action.after_revision = month.revision
            AND action.occurred_at = month.updated_at
          WHERE month.status = 'closed'
            AND month.lifecycle_mode = 'ordinary'
        )) IS NOT TRUE THEN
      RAISE EXCEPTION 'close receipt requires exact report and lifecycle effect'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.command_type = 'planning.reclose-month.v1' THEN
    IF (NEW.actor_scope LIKE 'member:%'
        AND NEW.result_kind = 'planning.report-revision.v1'
        AND EXISTS (
          SELECT 1 FROM plan_months month
          JOIN plan_publications publication
            ON publication.id = month.active_publication_id
           AND publication.plan_month_id = month.id
          JOIN memberships author ON author.space_id = month.space_id
            AND author.id::text = substring(NEW.actor_scope from 8)
          JOIN report_revisions report ON report.id = NEW.aggregate_id
            AND report.plan_month_id = month.id
            AND report.status = 'revised'
            AND report.created_by_system_actor_id IS NULL
            AND report.created_by_member_id = author.id
            AND report.revision = NEW.aggregate_revision
            AND report.publication_snapshot_hash = publication.preview_hash
            AND report.created_at = month.updated_at
          JOIN planning_action_groups action ON action.plan_month_id = month.id
            AND action.action_kind = 'month_reclosed'
            AND action.actor_kind = 'member'
            AND action.actor_scope = NEW.actor_scope
            AND action.member_id = author.id
            AND action.system_actor_id IS NULL
            AND action.command_type = NEW.command_type
            AND action.command_id = NEW.command_id
            AND action.before_revision = month.revision - 1
            AND action.after_revision = month.revision
            AND action.occurred_at = month.updated_at
          WHERE month.status = 'closed'
            AND month.lifecycle_mode = 'reopened'
        )) IS NOT TRUE THEN
      RAISE EXCEPTION 'reclose receipt requires exact report and lifecycle effect'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "command_receipts_l03_effect_consistent"
AFTER INSERT ON "command_receipts"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_l03_command_receipt_effect"();
