CREATE TABLE "goal_definitions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "space_id" UUID NOT NULL,
    "state" VARCHAR(16) NOT NULL,
    "revision" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "goal_definitions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "goal_definitions_state_check"
      CHECK ("state" IN ('active', 'archived')),
    CONSTRAINT "goal_definitions_revision_check" CHECK ("revision" >= 1),
    CONSTRAINT "goal_definitions_state_archived_at_check"
      CHECK (
        ("state" = 'active' AND "archived_at" IS NULL)
        OR ("state" = 'archived' AND "archived_at" IS NOT NULL)
      ),
    CONSTRAINT "goal_definitions_space_id_id_key" UNIQUE ("space_id", "id"),
    CONSTRAINT "goal_definitions_space_id_fkey" FOREIGN KEY ("space_id")
      REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "goal_definitions_space_state_created_id_idx"
  ON "goal_definitions"("space_id", "state", "created_at", "id");

CREATE TABLE "goal_series" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "goal_definition_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "goal_series_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "goal_series_definition_id_id_key"
      UNIQUE ("goal_definition_id", "id"),
    CONSTRAINT "goal_series_goal_definition_id_fkey"
      FOREIGN KEY ("goal_definition_id") REFERENCES "goal_definitions"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE "goal_definition_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "goal_definition_id" UUID NOT NULL,
    "version_number" BIGINT NOT NULL,
    "goal_series_id" UUID NOT NULL,
    "series_decision" VARCHAR(16) NOT NULL,
    "title" TEXT NOT NULL,
    "why" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "goal_definition_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "goal_definition_versions_version_number_check"
      CHECK ("version_number" >= 1),
    CONSTRAINT "goal_definition_versions_series_decision_check"
      CHECK ("series_decision" IN ('continue', 'new')),
    CONSTRAINT "goal_definition_versions_title_check"
      CHECK ("title" ~ '[^[:space:]]' AND char_length("title") BETWEEN 1 AND 200),
    CONSTRAINT "goal_definition_versions_why_check"
      CHECK ("why" ~ '[^[:space:]]' AND char_length("why") BETWEEN 1 AND 2000),
    CONSTRAINT "goal_definition_versions_category_check"
      CHECK ("category" ~ '[^[:space:]]' AND char_length("category") BETWEEN 1 AND 100),
    CONSTRAINT "goal_definition_versions_definition_number_key"
      UNIQUE ("goal_definition_id", "version_number"),
    CONSTRAINT "goal_definition_versions_definition_id_id_key"
      UNIQUE ("goal_definition_id", "id"),
    CONSTRAINT "goal_definition_versions_goal_definition_id_fkey"
      FOREIGN KEY ("goal_definition_id") REFERENCES "goal_definitions"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "goal_definition_versions_definition_series_fkey"
      FOREIGN KEY ("goal_definition_id", "goal_series_id")
      REFERENCES "goal_series"("goal_definition_id", "id")
      ON DELETE RESTRICT ON UPDATE RESTRICT
);

ALTER TABLE "planning_action_groups"
  ALTER COLUMN "plan_month_id" DROP NOT NULL,
  ADD COLUMN "goal_definition_id" UUID;

ALTER TABLE "planning_action_groups"
  DROP CONSTRAINT "planning_action_groups_action_kind_check",
  ADD CONSTRAINT "planning_action_groups_action_kind_check"
    CHECK ("action_kind" IN (
      'draft_created',
      'month_focus_updated',
      'goal_definition_created',
      'goal_definition_versioned',
      'goal_definition_archived',
      'goal_definition_restored',
      'goal_definition_copied'
    )),
  ADD CONSTRAINT "planning_action_groups_target_check"
    CHECK (
      ("action_kind" IN ('draft_created', 'month_focus_updated')
        AND "plan_month_id" IS NOT NULL AND "goal_definition_id" IS NULL)
      OR
      ("action_kind" IN (
        'goal_definition_created', 'goal_definition_versioned',
        'goal_definition_archived', 'goal_definition_restored',
        'goal_definition_copied'
      ) AND "plan_month_id" IS NULL AND "goal_definition_id" IS NOT NULL)
    ),
  ADD CONSTRAINT "planning_action_groups_goal_definition_id_fkey"
    FOREIGN KEY ("goal_definition_id") REFERENCES "goal_definitions"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "planning_goal_catalog_changes" (
    "action_id" UUID NOT NULL,
    "goal_definition_id" UUID NOT NULL,
    "before_state" VARCHAR(16),
    "after_state" VARCHAR(16) NOT NULL,
    "before_version_id" UUID,
    "after_version_id" UUID,
    "copy_source_definition_id" UUID,
    "copy_source_version_id" UUID,
    "series_decision" VARCHAR(16),

    CONSTRAINT "planning_goal_catalog_changes_pkey" PRIMARY KEY ("action_id"),
    CONSTRAINT "planning_goal_catalog_changes_before_state_check"
      CHECK ("before_state" IS NULL OR "before_state" IN ('active', 'archived')),
    CONSTRAINT "planning_goal_catalog_changes_after_state_check"
      CHECK ("after_state" IN ('active', 'archived')),
    CONSTRAINT "planning_goal_catalog_changes_series_decision_check"
      CHECK ("series_decision" IS NULL OR "series_decision" IN ('continue', 'new')),
    CONSTRAINT "planning_goal_catalog_changes_action_id_fkey"
      FOREIGN KEY ("action_id") REFERENCES "planning_action_groups"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "planning_goal_catalog_changes_goal_definition_id_fkey"
      FOREIGN KEY ("goal_definition_id") REFERENCES "goal_definitions"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "planning_goal_catalog_changes_before_version_fkey"
      FOREIGN KEY ("goal_definition_id", "before_version_id")
      REFERENCES "goal_definition_versions"("goal_definition_id", "id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "planning_goal_catalog_changes_after_version_fkey"
      FOREIGN KEY ("goal_definition_id", "after_version_id")
      REFERENCES "goal_definition_versions"("goal_definition_id", "id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "planning_goal_catalog_changes_copy_source_definition_id_fkey"
      FOREIGN KEY ("copy_source_definition_id") REFERENCES "goal_definitions"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "planning_goal_catalog_changes_copy_source_version_fkey"
      FOREIGN KEY ("copy_source_definition_id", "copy_source_version_id")
      REFERENCES "goal_definition_versions"("goal_definition_id", "id")
      ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE FUNCTION "guard_goal_definition_change"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'goal_definitions rows cannot be physically deleted'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.id <> OLD.id OR NEW.space_id <> OLD.space_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'goal_definitions identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'goal_definitions_revision_consecutive'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "goal_definitions_guard_update_delete"
BEFORE UPDATE OR DELETE ON "goal_definitions"
FOR EACH ROW EXECUTE FUNCTION "guard_goal_definition_change"();

CREATE FUNCTION "guard_goal_definition_version_continuity"()
RETURNS TRIGGER AS $$
DECLARE
  definition_state VARCHAR(16);
  predecessor_series UUID;
BEGIN
  SELECT state INTO definition_state FROM goal_definitions
   WHERE id = NEW.goal_definition_id FOR UPDATE;
  IF definition_state IS NULL THEN
    RAISE EXCEPTION 'goal_definition_versions_definition_missing'
      USING ERRCODE = '23503';
  END IF;
  IF definition_state <> 'active' THEN
    RAISE EXCEPTION 'goal_definition_versions_archived'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.version_number = 1 THEN
    IF NEW.series_decision <> 'new' OR EXISTS (
      SELECT 1 FROM goal_definition_versions
       WHERE goal_definition_id = NEW.goal_definition_id
    ) THEN
      RAISE EXCEPTION 'goal_definition_versions_continuity'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT goal_series_id INTO predecessor_series
      FROM goal_definition_versions
     WHERE goal_definition_id = NEW.goal_definition_id
       AND version_number = NEW.version_number - 1;
    IF predecessor_series IS NULL THEN
      RAISE EXCEPTION 'goal_definition_versions_continuity'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.series_decision = 'continue'
       AND NEW.goal_series_id <> predecessor_series THEN
      RAISE EXCEPTION 'goal_definition_versions_continuity'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.series_decision = 'new'
       AND EXISTS (
         SELECT 1 FROM goal_definition_versions
          WHERE goal_definition_id = NEW.goal_definition_id
            AND goal_series_id = NEW.goal_series_id
       ) THEN
      RAISE EXCEPTION 'goal_definition_versions_continuity'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "goal_definition_versions_continuity"
BEFORE INSERT ON "goal_definition_versions"
FOR EACH ROW EXECUTE FUNCTION "guard_goal_definition_version_continuity"();

CREATE TRIGGER "goal_series_reject_update_delete"
BEFORE UPDATE OR DELETE ON "goal_series"
FOR EACH ROW EXECUTE FUNCTION "reject_p01_immutable_row_change"();

CREATE TRIGGER "goal_definition_versions_reject_update_delete"
BEFORE UPDATE OR DELETE ON "goal_definition_versions"
FOR EACH ROW EXECUTE FUNCTION "reject_p01_immutable_row_change"();

CREATE FUNCTION "validate_planning_goal_catalog_change"()
RETURNS TRIGGER AS $$
DECLARE
  parent_kind VARCHAR(32);
  parent_target UUID;
  parent_before_revision BIGINT;
  parent_after_revision BIGINT;
  before_version_number BIGINT;
  after_version_number BIGINT;
  after_version_decision VARCHAR(16);
BEGIN
  SELECT action_kind, goal_definition_id, before_revision, after_revision
    INTO parent_kind, parent_target, parent_before_revision, parent_after_revision
    FROM planning_action_groups WHERE id = NEW.action_id;
  IF parent_kind IS NULL OR parent_target <> NEW.goal_definition_id THEN
    RAISE EXCEPTION 'planning_goal_catalog_changes_parent_mismatch'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM planning_month_focus_changes WHERE action_id = NEW.action_id
  ) THEN
    RAISE EXCEPTION 'planning_goal_catalog_changes_detail_conflict'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.before_version_id IS NOT NULL THEN
    SELECT version_number INTO before_version_number
      FROM goal_definition_versions
     WHERE goal_definition_id = NEW.goal_definition_id
       AND id = NEW.before_version_id;
  END IF;
  IF NEW.after_version_id IS NOT NULL THEN
    SELECT version_number, series_decision
      INTO after_version_number, after_version_decision
      FROM goal_definition_versions
     WHERE goal_definition_id = NEW.goal_definition_id
       AND id = NEW.after_version_id;
  END IF;
  IF parent_kind = 'goal_definition_created' THEN
    IF (parent_before_revision IS NULL AND parent_after_revision = 1
      AND NEW.before_state IS NULL AND NEW.after_state = 'active'
      AND NEW.before_version_id IS NULL AND NEW.after_version_id IS NOT NULL
      AND after_version_number = 1 AND after_version_decision = 'new'
      AND NEW.copy_source_definition_id IS NULL
      AND NEW.copy_source_version_id IS NULL AND NEW.series_decision = 'new') IS NOT TRUE THEN
      RAISE EXCEPTION 'planning_goal_catalog_changes_shape'
        USING ERRCODE = '23514';
    END IF;
  ELSIF parent_kind = 'goal_definition_versioned' THEN
    IF (parent_before_revision IS NOT NULL
      AND parent_after_revision = parent_before_revision + 1
      AND NEW.before_state = 'active' AND NEW.after_state = 'active'
      AND NEW.before_version_id IS NOT NULL AND NEW.after_version_id IS NOT NULL
      AND NEW.before_version_id <> NEW.after_version_id
      AND after_version_number = before_version_number + 1
      AND NEW.copy_source_definition_id IS NULL
      AND NEW.copy_source_version_id IS NULL
      AND NEW.series_decision = after_version_decision) IS NOT TRUE THEN
      RAISE EXCEPTION 'planning_goal_catalog_changes_shape'
        USING ERRCODE = '23514';
    END IF;
  ELSIF parent_kind = 'goal_definition_archived' THEN
    IF (parent_before_revision IS NOT NULL
      AND parent_after_revision = parent_before_revision + 1
      AND NEW.before_state = 'active' AND NEW.after_state = 'archived'
      AND NEW.before_version_id IS NOT NULL
      AND NEW.after_version_id = NEW.before_version_id
      AND NEW.copy_source_definition_id IS NULL
      AND NEW.copy_source_version_id IS NULL AND NEW.series_decision IS NULL) IS NOT TRUE THEN
      RAISE EXCEPTION 'planning_goal_catalog_changes_shape'
        USING ERRCODE = '23514';
    END IF;
  ELSIF parent_kind = 'goal_definition_restored' THEN
    IF (parent_before_revision IS NOT NULL
      AND parent_after_revision = parent_before_revision + 1
      AND NEW.before_state = 'archived' AND NEW.after_state = 'active'
      AND NEW.before_version_id IS NOT NULL
      AND NEW.after_version_id = NEW.before_version_id
      AND NEW.copy_source_definition_id IS NULL
      AND NEW.copy_source_version_id IS NULL AND NEW.series_decision IS NULL) IS NOT TRUE THEN
      RAISE EXCEPTION 'planning_goal_catalog_changes_shape'
        USING ERRCODE = '23514';
    END IF;
  ELSIF parent_kind = 'goal_definition_copied' THEN
    IF (parent_before_revision IS NULL AND parent_after_revision = 1
      AND NEW.before_state IS NULL AND NEW.after_state = 'active'
      AND NEW.before_version_id IS NULL AND NEW.after_version_id IS NOT NULL
      AND after_version_number = 1 AND after_version_decision = 'new'
      AND NEW.copy_source_definition_id IS NOT NULL
      AND NEW.copy_source_definition_id <> NEW.goal_definition_id
      AND NEW.copy_source_version_id IS NOT NULL AND NEW.series_decision = 'new') IS NOT TRUE THEN
      RAISE EXCEPTION 'planning_goal_catalog_changes_shape'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'planning_goal_catalog_changes_parent_kind'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "planning_goal_catalog_changes_validate"
BEFORE INSERT ON "planning_goal_catalog_changes"
FOR EACH ROW EXECUTE FUNCTION "validate_planning_goal_catalog_change"();

CREATE FUNCTION "validate_planning_month_focus_change_parent"()
RETURNS TRIGGER AS $$
DECLARE
  parent_kind VARCHAR(32);
BEGIN
  SELECT action_kind INTO parent_kind
    FROM planning_action_groups WHERE id = NEW.action_id;
  IF parent_kind NOT IN ('draft_created', 'month_focus_updated') THEN
    RAISE EXCEPTION 'planning_month_focus_changes_parent_kind'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM planning_goal_catalog_changes WHERE action_id = NEW.action_id
  ) THEN
    RAISE EXCEPTION 'planning_month_focus_changes_detail_conflict'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "planning_month_focus_changes_validate_parent"
BEFORE INSERT ON "planning_month_focus_changes"
FOR EACH ROW EXECUTE FUNCTION "validate_planning_month_focus_change_parent"();

CREATE TRIGGER "planning_goal_catalog_changes_reject_update_delete"
BEFORE UPDATE OR DELETE ON "planning_goal_catalog_changes"
FOR EACH ROW EXECUTE FUNCTION "reject_p01_immutable_row_change"();

CREATE FUNCTION "require_planning_catalog_detail"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.action_kind LIKE 'goal_definition_%' AND NOT EXISTS (
    SELECT 1 FROM planning_goal_catalog_changes WHERE action_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'planning_goal_catalog_change_required'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "planning_catalog_action_requires_detail"
AFTER INSERT ON "planning_action_groups"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_planning_catalog_detail"();
