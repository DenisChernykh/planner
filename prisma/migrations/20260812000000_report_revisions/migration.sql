CREATE TABLE "report_revisions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "plan_month_id" UUID NOT NULL,
    "publication_id" UUID NOT NULL,
    "revision" BIGINT NOT NULL,
    "publication_snapshot_hash" CHAR(64) NOT NULL,
    "source_facts_revision" BIGINT NOT NULL,
    "formula_version" VARCHAR(128) NOT NULL,
    "payload" JSONB NOT NULL,
    "payload_checksum" CHAR(64) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by_system_actor_id" VARCHAR(32) NOT NULL,

    CONSTRAINT "report_revisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "report_revisions_revision_check" CHECK ("revision" >= 1),
    CONSTRAINT "report_revisions_source_facts_revision_check"
      CHECK ("source_facts_revision" >= 0),
    CONSTRAINT "report_revisions_status_check"
      CHECK ("status" IN ('original', 'revised')),
    CONSTRAINT "report_revisions_actor_check"
      CHECK ("created_by_system_actor_id" = 'planner-worker'),
    CONSTRAINT "report_revisions_publication_hash_check"
      CHECK ("publication_snapshot_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "report_revisions_payload_checksum_check"
      CHECK ("payload_checksum" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "report_revisions_plan_month_fkey"
      FOREIGN KEY ("plan_month_id") REFERENCES "plan_months"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "report_revisions_publication_fkey"
      FOREIGN KEY ("publication_id") REFERENCES "plan_publications"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "report_revisions_publication_same_month_fkey"
      FOREIGN KEY ("plan_month_id", "publication_id")
      REFERENCES "plan_publications"("plan_month_id", "id")
      ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "report_revisions_month_revision_key"
  ON "report_revisions"("plan_month_id", "revision");
CREATE UNIQUE INDEX "report_revisions_one_original_per_month_key"
  ON "report_revisions"("plan_month_id")
  WHERE "status" = 'original';
CREATE INDEX "report_revisions_month_status_idx"
  ON "report_revisions"("plan_month_id", "status");

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
      'month_publication_cancelled', 'month_grace_started', 'month_closed'
    )
  ),
  DROP CONSTRAINT "planning_action_groups_target_check",
  ADD CONSTRAINT "planning_action_groups_target_check" CHECK (
    ("action_kind" IN (
      'draft_created', 'draft_copied', 'draft_created_from_seed',
      'month_focus_updated', 'draft_goal_added', 'draft_goal_updated',
      'draft_goal_removed', 'draft_goals_reordered', 'month_published',
      'month_publication_cancelled', 'month_grace_started', 'month_closed'
    ) AND "plan_month_id" IS NOT NULL AND "goal_definition_id" IS NULL)
    OR ("action_kind" IN (
      'goal_definition_created', 'goal_definition_versioned',
      'goal_definition_archived', 'goal_definition_restored',
      'goal_definition_copied'
    ) AND "plan_month_id" IS NULL AND "goal_definition_id" IS NOT NULL)
  );

CREATE FUNCTION "reject_report_revision_change"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'report_revisions rows are immutable'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "report_revisions_reject_update_delete"
BEFORE UPDATE OR DELETE ON "report_revisions"
FOR EACH ROW EXECUTE FUNCTION "reject_report_revision_change"();

DROP TRIGGER "plan_months_guard_p08_lifecycle_update" ON "plan_months";
DROP FUNCTION "guard_p08_month_lifecycle_update"();

CREATE FUNCTION "guard_l01_month_lifecycle_update"()
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
        AND OLD.facts_revision = 0
        AND NEW.status = 'published'
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
    IF (OLD.active_publication_id IS NOT NULL
        AND publication.id = OLD.active_publication_id
        AND OLD.facts_revision = 0
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
      AND NEW.status = 'grace'
      AND NEW.active_publication_id = OLD.active_publication_id
      AND NEW.revision = OLD.revision + 1
      AND NEW.facts_revision = OLD.facts_revision
      AND (NEW.updated_at AT TIME ZONE 'Asia/Yekaterinburg')::date >=
          (OLD.month_start + INTERVAL '1 month')::date) THEN
    RETURN NEW;
  END IF;

  IF (OLD.status = 'grace'
      AND NEW.status = 'closed'
      AND NEW.active_publication_id = OLD.active_publication_id
      AND NEW.revision = OLD.revision + 1
      AND NEW.facts_revision = OLD.facts_revision
      AND (NEW.updated_at AT TIME ZONE 'Asia/Yekaterinburg')::date >=
          (OLD.month_start + INTERVAL '1 month' + INTERVAL '3 days')::date) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'plan month lifecycle transition is not available in L01'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "plan_months_guard_l01_lifecycle_update"
BEFORE UPDATE ON "plan_months"
FOR EACH ROW EXECUTE FUNCTION "guard_l01_month_lifecycle_update"();

DROP TRIGGER "plan_months_lifecycle_effect_consistent" ON "plan_months";
DROP FUNCTION "require_p08_month_lifecycle_effect"();

CREATE FUNCTION "require_l01_month_lifecycle_effect"()
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
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "plan_months_lifecycle_effect_consistent"
AFTER UPDATE OF status, revision, active_publication_id ON "plan_months"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_l01_month_lifecycle_effect"();

CREATE FUNCTION "require_l01_report_revision_effect"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'original' AND NOT EXISTS (
    SELECT 1
      FROM plan_months month
      JOIN planning_action_groups action
        ON action.plan_month_id = month.id
       AND action.action_kind = 'month_closed'
       AND action.actor_kind = 'system'
       AND action.actor_scope = 'system:planner-worker'
       AND action.system_actor_id = 'planner-worker'
       AND action.command_type = 'planning.close-month.v1'
       AND action.before_revision = month.revision - 1
       AND action.after_revision = month.revision
      JOIN command_receipts receipt
        ON receipt.actor_scope = action.actor_scope
       AND receipt.command_type = action.command_type
       AND receipt.command_id = action.command_id
     WHERE month.id = NEW.plan_month_id
       AND month.status = 'closed'
       AND NEW.publication_id = month.active_publication_id
       AND receipt.result_kind = 'planning.report-revision.v1'
       AND receipt.aggregate_id = NEW.id
       AND receipt.aggregate_revision = NEW.revision
  ) THEN
    RAISE EXCEPTION 'original report revision requires exact close effect'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "report_revisions_lifecycle_effect_consistent"
AFTER INSERT ON "report_revisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_l01_report_revision_effect"();

CREATE FUNCTION "require_l01_command_receipt_effect"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.command_type = 'planning.start-month-grace.v1'
     OR (NEW.result_kind = 'planning.plan-month.v1'
         AND NEW.command_type <> 'planning.cancel-publication.v1') THEN
    IF (NEW.actor_scope = 'system:planner-worker'
        AND NEW.command_type = 'planning.start-month-grace.v1'
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
             AND month.revision = NEW.aggregate_revision
        )) IS NOT TRUE THEN
      RAISE EXCEPTION 'grace receipt requires exact lifecycle effect'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.command_type = 'planning.close-month.v1'
        OR NEW.result_kind = 'planning.report-revision.v1' THEN
    IF (NEW.actor_scope = 'system:planner-worker'
        AND NEW.command_type = 'planning.close-month.v1'
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
             AND month.revision > 1
        )) IS NOT TRUE THEN
      RAISE EXCEPTION 'close receipt requires exact report and lifecycle effect'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "command_receipts_l01_effect_consistent"
AFTER INSERT ON "command_receipts"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_l01_command_receipt_effect"();
