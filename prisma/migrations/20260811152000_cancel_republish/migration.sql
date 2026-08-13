BEGIN;

LOCK TABLE plan_months, plan_publications, planning_action_groups,
  planning_publication_changes, command_receipts IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM command_receipts
     WHERE command_type IN (
       'planning.cancel-publication.v1',
       'planning.republish-month.v1'
     )
  ) OR EXISTS (
    SELECT 1 FROM planning_action_groups
     WHERE action_kind = 'month_publication_cancelled'
  ) THEN
    RAISE EXCEPTION 'P08 lifecycle history already exists before its migration'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE "plan_months"
  ADD COLUMN "facts_revision" BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT "plan_months_facts_revision_check"
    CHECK ("facts_revision" >= 0);

ALTER TABLE "planning_publication_changes"
  ADD COLUMN "change_kind" VARCHAR(16) NOT NULL DEFAULT 'published',
  ALTER COLUMN "confirmed_draft_revision" DROP NOT NULL,
  ALTER COLUMN "confirmed_preview_schema_version" DROP NOT NULL,
  ALTER COLUMN "confirmed_preview_hash_version" DROP NOT NULL,
  ALTER COLUMN "confirmed_preview_hash" DROP NOT NULL,
  ALTER COLUMN "after_active_publication_id" DROP NOT NULL,
  DROP CONSTRAINT "planning_publication_changes_pointer_check",
  DROP CONSTRAINT "planning_publication_changes_publication_key";

ALTER TABLE "planning_publication_changes"
  ALTER COLUMN "change_kind" DROP DEFAULT,
  ADD CONSTRAINT "planning_publication_changes_shape_check" CHECK (
    (
      "change_kind" = 'published'
      AND "confirmed_draft_revision" IS NOT NULL
      AND "confirmed_preview_schema_version" IS NOT NULL
      AND "confirmed_preview_hash_version" IS NOT NULL
      AND "confirmed_preview_hash" IS NOT NULL
      AND "before_active_publication_id" IS NULL
      AND "after_active_publication_id" = "publication_id"
    ) OR (
      "change_kind" = 'cancelled'
      AND "confirmed_draft_revision" IS NULL
      AND "confirmed_preview_schema_version" IS NULL
      AND "confirmed_preview_hash_version" IS NULL
      AND "confirmed_preview_hash" IS NULL
      AND "before_active_publication_id" = "publication_id"
      AND "after_active_publication_id" IS NULL
    )
  ),
  ADD CONSTRAINT "planning_publication_changes_publication_kind_key"
    UNIQUE ("publication_id", "change_kind");

ALTER TABLE "planning_action_groups"
  DROP CONSTRAINT "planning_action_groups_action_kind_check",
  ADD CONSTRAINT "planning_action_groups_action_kind_check" CHECK (
    "action_kind" IN (
      'draft_created', 'month_focus_updated',
      'goal_definition_created', 'goal_definition_versioned',
      'goal_definition_archived', 'goal_definition_restored',
      'goal_definition_copied', 'draft_goal_added', 'draft_goal_updated',
      'draft_goal_removed', 'draft_goals_reordered', 'month_published',
      'month_publication_cancelled'
    )
  ),
  DROP CONSTRAINT "planning_action_groups_target_check",
  ADD CONSTRAINT "planning_action_groups_target_check" CHECK (
    ("action_kind" IN (
      'draft_created', 'month_focus_updated', 'draft_goal_added',
      'draft_goal_updated', 'draft_goal_removed', 'draft_goals_reordered',
      'month_published', 'month_publication_cancelled'
    ) AND "plan_month_id" IS NOT NULL AND "goal_definition_id" IS NULL)
    OR ("action_kind" IN (
      'goal_definition_created', 'goal_definition_versioned',
      'goal_definition_archived', 'goal_definition_restored',
      'goal_definition_copied'
    ) AND "plan_month_id" IS NULL AND "goal_definition_id" IS NOT NULL)
  );

DROP INDEX "planning_action_groups_lifecycle_after_revision_key";
CREATE UNIQUE INDEX "planning_action_groups_lifecycle_after_revision_key"
  ON "planning_action_groups"("plan_month_id", "after_revision")
  WHERE "action_kind" IN ('month_published', 'month_publication_cancelled');

DROP TRIGGER "plan_months_guard_p07_lifecycle_update" ON "plan_months";
DROP FUNCTION "guard_p07_month_lifecycle_update"();

CREATE FUNCTION "guard_p08_month_lifecycle_update"()
RETURNS TRIGGER AS $$
DECLARE
  publication plan_publications%ROWTYPE;
  latest_publication_revision BIGINT;
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

  IF (OLD.status = 'published'
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
      RAISE EXCEPTION 'invalid P08 publication lifecycle transition'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'published' THEN
    SELECT * INTO publication FROM plan_publications
     WHERE id = OLD.active_publication_id AND plan_month_id = OLD.id;
    SELECT max(publication_revision) INTO latest_publication_revision
      FROM plan_publications WHERE plan_month_id = OLD.id;
    cancellation_local_date :=
      (NEW.updated_at AT TIME ZONE 'Asia/Yekaterinburg')::date;
    IF (OLD.active_publication_id IS NOT NULL
        AND publication.id = OLD.active_publication_id
        AND publication.publication_revision = latest_publication_revision
        AND OLD.facts_revision = 0
        AND NEW.status = 'draft'
        AND NEW.active_publication_id IS NULL
        AND NEW.revision = OLD.revision + 1
        AND NEW.facts_revision = 0
        AND NEW.updated_at >= publication.published_at
        AND cancellation_local_date < OLD.month_start) IS NOT TRUE THEN
      RAISE EXCEPTION 'invalid P08 cancellation lifecycle transition'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'plan month lifecycle transition is not available in P08'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "plan_months_guard_p08_lifecycle_update"
BEFORE UPDATE ON "plan_months"
FOR EACH ROW EXECUTE FUNCTION "guard_p08_month_lifecycle_update"();

CREATE FUNCTION "require_p08_month_lifecycle_effect"()
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
      RAISE EXCEPTION 'P08 cancellation requires exact history and receipt'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "plan_months_lifecycle_effect_consistent"
AFTER UPDATE OF status, revision, active_publication_id ON "plan_months"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_p08_month_lifecycle_effect"();

DROP TRIGGER "plan_months_require_publication_pointer" ON "plan_months";
DROP TRIGGER "plan_publications_require_month_pointer" ON "plan_publications";
DROP FUNCTION "require_p07_month_pointer"();

CREATE FUNCTION "require_p08_month_pointer"()
RETURNS TRIGGER AS $$
DECLARE
  target_id UUID;
  target_status VARCHAR(16);
  target_pointer UUID;
BEGIN
  target_id := COALESCE(
    (to_jsonb(NEW)->>'plan_month_id')::uuid,
    (to_jsonb(NEW)->>'id')::uuid
  );
  SELECT status, active_publication_id INTO target_status, target_pointer
    FROM plan_months WHERE id = target_id;
  IF ((target_status = 'draft' AND target_pointer IS NULL)
      OR (target_status IN ('published', 'grace', 'closed')
          AND target_pointer IS NOT NULL)) IS NOT TRUE THEN
    RAISE EXCEPTION 'plan month publication pointer mismatch'
      USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'plan_publications'
     AND (target_pointer = NEW.id
          AND (SELECT count(*) FROM planning_publication_changes
                WHERE publication_id = NEW.id
                  AND change_kind = 'published') = 1) IS NOT TRUE THEN
    RAISE EXCEPTION 'publication is not the exact active audited pointer'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "plan_months_require_publication_pointer"
AFTER INSERT OR UPDATE OF status, active_publication_id ON "plan_months"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_p08_month_pointer"();

CREATE CONSTRAINT TRIGGER "plan_publications_require_month_pointer"
AFTER INSERT ON "plan_publications"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_p08_month_pointer"();

DROP TRIGGER "planning_publication_changes_validate"
  ON "planning_publication_changes";
DROP FUNCTION "validate_p07_publication_change"();

CREATE FUNCTION "validate_p08_publication_change"()
RETURNS TRIGGER AS $$
DECLARE
  parent planning_action_groups%ROWTYPE;
  publication plan_publications%ROWTYPE;
  month_value plan_months%ROWTYPE;
  previous_cancelled BOOLEAN;
  member_matches_space BOOLEAN;
BEGIN
  SELECT * INTO parent FROM planning_action_groups WHERE id = NEW.action_id;
  SELECT * INTO publication FROM plan_publications WHERE id = NEW.publication_id;
  SELECT * INTO month_value FROM plan_months WHERE id = publication.plan_month_id;
  SELECT EXISTS (
    SELECT 1
      FROM plan_publications previous
      JOIN planning_publication_changes change
        ON change.publication_id = previous.id
       AND change.change_kind = 'cancelled'
     WHERE previous.plan_month_id = publication.plan_month_id
       AND previous.publication_revision = publication.publication_revision - 1
  ) INTO previous_cancelled;
  SELECT EXISTS (
    SELECT 1 FROM memberships membership
     WHERE membership.id = parent.member_id
       AND membership.space_id = publication.space_id
  ) INTO member_matches_space;

  IF NEW.change_kind = 'published' THEN
    IF (parent.action_kind = 'month_published'
        AND parent.actor_kind = 'member'
        AND parent.system_actor_id IS NULL
        AND parent.plan_month_id = publication.plan_month_id
        AND parent.member_id = publication.published_by_member_id
        AND parent.before_revision = publication.source_plan_month_revision
        AND parent.after_revision = publication.source_plan_month_revision + 1
        AND parent.occurred_at = publication.published_at
        AND (
          (parent.command_type = 'planning.publish-month.v1'
            AND publication.publication_revision = 1)
          OR (parent.command_type = 'planning.republish-month.v1'
            AND publication.publication_revision > 1
            AND previous_cancelled)
        )
        AND NEW.confirmed_draft_revision = publication.source_draft_revision
        AND NEW.confirmed_preview_schema_version =
            publication.source_preview_schema_version
        AND NEW.confirmed_preview_hash_version = publication.preview_hash_version
        AND NEW.confirmed_preview_hash = publication.preview_hash) IS NOT TRUE THEN
      RAISE EXCEPTION 'invalid P08 publication history detail'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.change_kind = 'cancelled' THEN
    IF (parent.action_kind = 'month_publication_cancelled'
        AND parent.actor_kind = 'member'
        AND parent.system_actor_id IS NULL
        AND member_matches_space
        AND parent.plan_month_id = publication.plan_month_id
        AND parent.command_type = 'planning.cancel-publication.v1'
        AND parent.before_revision IS NOT NULL
        AND parent.after_revision = parent.before_revision + 1
        AND publication.publication_revision = (
          SELECT max(candidate.publication_revision)
            FROM plan_publications candidate
           WHERE candidate.plan_month_id = publication.plan_month_id
        )) IS NOT TRUE THEN
      RAISE EXCEPTION 'invalid P08 cancellation history detail'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid P08 publication change kind'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "planning_publication_changes_validate"
BEFORE INSERT ON "planning_publication_changes"
FOR EACH ROW EXECUTE FUNCTION "validate_p08_publication_change"();

DROP TRIGGER "planning_publication_changes_effect_consistent"
  ON "planning_publication_changes";
DROP FUNCTION "require_p07_publication_effect"();

CREATE FUNCTION "require_p08_publication_effect"()
RETURNS TRIGGER AS $$
DECLARE
  parent planning_action_groups%ROWTYPE;
  publication plan_publications%ROWTYPE;
  month_value plan_months%ROWTYPE;
  receipt command_receipts%ROWTYPE;
BEGIN
  SELECT * INTO parent FROM planning_action_groups WHERE id = NEW.action_id;
  SELECT * INTO publication FROM plan_publications WHERE id = NEW.publication_id;
  SELECT * INTO month_value FROM plan_months WHERE id = publication.plan_month_id;
  SELECT * INTO receipt FROM command_receipts
   WHERE actor_scope = parent.actor_scope
     AND command_type = parent.command_type
     AND command_id = parent.command_id;

  IF NEW.change_kind = 'published' THEN
    IF (month_value.status = 'published'
        AND month_value.active_publication_id = publication.id
        AND month_value.revision = parent.after_revision
        AND parent.command_type IN (
          'planning.publish-month.v1', 'planning.republish-month.v1'
        )
        AND receipt.result_kind = 'planning.plan-publication.v1'
        AND receipt.aggregate_id = publication.id
        AND receipt.aggregate_revision = publication.publication_revision
        AND receipt.completed_at = publication.published_at) IS NOT TRUE THEN
      RAISE EXCEPTION 'P08 publication history effect or receipt mismatch'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.change_kind = 'cancelled' THEN
    IF (month_value.status = 'draft'
        AND month_value.active_publication_id IS NULL
        AND month_value.facts_revision = 0
        AND month_value.revision = parent.after_revision
        AND month_value.updated_at = parent.occurred_at
        AND (parent.occurred_at AT TIME ZONE 'Asia/Yekaterinburg')::date
              < month_value.month_start
        AND receipt.result_kind = 'planning.plan-month.v1'
        AND receipt.aggregate_id = month_value.id
        AND receipt.aggregate_revision = month_value.revision
        AND receipt.completed_at = parent.occurred_at) IS NOT TRUE THEN
      RAISE EXCEPTION 'P08 cancellation history effect or receipt mismatch'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "planning_publication_changes_effect_consistent"
AFTER INSERT ON "planning_publication_changes"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_p08_publication_effect"();

DROP TRIGGER "command_receipts_publication_effect_consistent"
  ON "command_receipts";
DROP FUNCTION "require_p07_publication_receipt_effect"();

CREATE FUNCTION "require_p08_publication_receipt_effect"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.command_type IN (
       'planning.publish-month.v1',
       'planning.republish-month.v1',
       'planning.cancel-publication.v1'
     ) OR NEW.result_kind = 'planning.plan-publication.v1' THEN
    IF NEW.command_type IN (
         'planning.publish-month.v1', 'planning.republish-month.v1'
       ) THEN
      IF (NEW.result_kind = 'planning.plan-publication.v1'
          AND EXISTS (
            SELECT 1
              FROM planning_action_groups action
              JOIN planning_publication_changes change
                ON change.action_id = action.id
               AND change.change_kind = 'published'
              JOIN plan_publications publication
                ON publication.id = change.publication_id
             WHERE action.actor_scope = NEW.actor_scope
               AND action.command_type = NEW.command_type
               AND action.command_id = NEW.command_id
               AND publication.id = NEW.aggregate_id
               AND publication.publication_revision = NEW.aggregate_revision
               AND publication.published_at = NEW.completed_at
          )) IS NOT TRUE THEN
        RAISE EXCEPTION 'publication receipt requires exact P08 action and detail'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.command_type = 'planning.cancel-publication.v1' THEN
      IF (NEW.result_kind = 'planning.plan-month.v1'
          AND EXISTS (
            SELECT 1
              FROM planning_action_groups action
              JOIN planning_publication_changes change
                ON change.action_id = action.id
               AND change.change_kind = 'cancelled'
             WHERE action.actor_scope = NEW.actor_scope
               AND action.command_type = NEW.command_type
               AND action.command_id = NEW.command_id
               AND action.plan_month_id = NEW.aggregate_id
               AND action.after_revision = NEW.aggregate_revision
               AND action.occurred_at = NEW.completed_at
          )) IS NOT TRUE THEN
        RAISE EXCEPTION 'cancellation receipt requires exact P08 action and detail'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'publication result kind requires a P08 publication command'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "command_receipts_publication_effect_consistent"
AFTER INSERT ON "command_receipts"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_p08_publication_receipt_effect"();

DROP TRIGGER "planning_publication_action_requires_detail"
  ON "planning_action_groups";
DROP FUNCTION "require_p07_publication_detail"();

CREATE FUNCTION "require_p08_publication_detail"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.action_kind IN ('month_published', 'month_publication_cancelled')
     AND NOT EXISTS (
       SELECT 1 FROM planning_publication_changes WHERE action_id = NEW.id
     ) THEN
    RAISE EXCEPTION 'planning publication change required'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "planning_publication_action_requires_detail"
AFTER INSERT ON "planning_action_groups"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_p08_publication_detail"();

COMMIT;
