ALTER TABLE "plan_months"
  ADD CONSTRAINT "plan_months_space_id_id_key" UNIQUE ("space_id", "id");

ALTER TABLE "memberships"
  ADD CONSTRAINT "memberships_space_id_id_key" UNIQUE ("space_id", "id");

CREATE TABLE "plan_draft_goals" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "space_id" UUID NOT NULL,
  "plan_month_id" UUID NOT NULL,
  "goal_definition_id" UUID NOT NULL,
  "display_order" INTEGER NOT NULL,
  "current_revision_id" UUID,
  "attached_at" TIMESTAMPTZ(3) NOT NULL,
  "detached_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "plan_draft_goals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "plan_draft_goals_order_check" CHECK ("display_order" BETWEEN 0 AND 399),
  CONSTRAINT "plan_draft_goals_attachment_check" CHECK (
    "detached_at" IS NULL OR "detached_at" >= "attached_at"
  ),
  CONSTRAINT "plan_draft_goals_id_space_definition_key"
    UNIQUE ("id", "space_id", "goal_definition_id"),
  CONSTRAINT "plan_draft_goals_id_current_revision_key"
    UNIQUE ("id", "current_revision_id"),
  CONSTRAINT "plan_draft_goals_month_space_fkey"
    FOREIGN KEY ("space_id", "plan_month_id")
    REFERENCES "plan_months"("space_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "plan_draft_goals_definition_space_fkey"
    FOREIGN KEY ("space_id", "goal_definition_id")
    REFERENCES "goal_definitions"("space_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "plan_draft_goals_active_definition_key"
  ON "plan_draft_goals"("plan_month_id", "goal_definition_id")
  WHERE "detached_at" IS NULL;
CREATE UNIQUE INDEX "plan_draft_goals_active_order_key"
  ON "plan_draft_goals"("plan_month_id", "display_order")
  WHERE "detached_at" IS NULL;
CREATE INDEX "plan_draft_goals_editor_idx"
  ON "plan_draft_goals"("plan_month_id", "display_order", "id")
  WHERE "detached_at" IS NULL;

CREATE FUNCTION "p03_uuid_array_is_distinct"(values_to_check UUID[])
RETURNS BOOLEAN AS $$
  SELECT cardinality(values_to_check) =
    (SELECT count(DISTINCT item)::int FROM unnest(values_to_check) item);
$$ LANGUAGE sql IMMUTABLE STRICT;

CREATE FUNCTION "p03_jsonb_has_exact_keys"(
  value_to_check JSONB,
  expected_keys TEXT[]
)
RETURNS BOOLEAN AS $$
  SELECT CASE
    WHEN jsonb_typeof(value_to_check) <> 'object' THEN FALSE
    ELSE value_to_check ?& expected_keys
      AND cardinality(expected_keys) = (
        SELECT count(*)::int FROM jsonb_object_keys(value_to_check)
      )
  END;
$$ LANGUAGE sql IMMUTABLE STRICT;

CREATE TABLE "plan_draft_goal_revisions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "plan_goal_id" UUID NOT NULL,
  "space_id" UUID NOT NULL,
  "goal_definition_id" UUID NOT NULL,
  "revision_number" BIGINT NOT NULL,
  "goal_definition_version_id" UUID NOT NULL,
  "goal_series_id" UUID NOT NULL,
  "scope_kind" VARCHAR(16) NOT NULL,
  "owner_member_id" UUID,
  "config" JSONB NOT NULL,
  "source_provenance" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "plan_draft_goal_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "plan_draft_goal_revisions_number_check" CHECK ("revision_number" >= 1),
  CONSTRAINT "plan_draft_goal_revisions_config_object_check" CHECK (
    ("p03_jsonb_has_exact_keys"("config", ARRAY[
      'schemaVersion', 'scope', 'repetition', 'measurement', 'checkpoints'
    ])
    AND "config"->'schemaVersion' = '1'::jsonb
    AND jsonb_typeof("config"->'scope') = 'object'
    AND jsonb_typeof("config"->'repetition') = 'object'
    AND jsonb_typeof("config"->'measurement') = 'object'
    AND (
      "config"->'checkpoints' = 'null'::jsonb
      OR jsonb_typeof("config"->'checkpoints') = 'object'
    )
    ) IS TRUE
  ),
  CONSTRAINT "plan_draft_goal_revisions_scope_check" CHECK (
    (("scope_kind" = 'personal'
      AND "p03_jsonb_has_exact_keys"(
        "config"->'scope', ARRAY['kind', 'ownerMemberId']
      )
      AND "config"->'scope'->>'kind' = 'personal'
      AND ("config"->'scope'->>'ownerMemberId')::uuid IS NOT DISTINCT FROM "owner_member_id")
    OR
    ("scope_kind" = 'shared' AND "owner_member_id" IS NULL
      AND "p03_jsonb_has_exact_keys"("config"->'scope', ARRAY['kind'])
      AND "config"->'scope'->>'kind' = 'shared'
      AND NOT ("config"->'scope' ? 'ownerMemberId'))
    ) IS TRUE
  ),
  CONSTRAINT "plan_draft_goal_revisions_provenance_object_check" CHECK (
    ("source_provenance" IS NULL OR (
      jsonb_typeof("source_provenance") = 'object'
      AND "p03_jsonb_has_exact_keys"("source_provenance", ARRAY[
        'schemaVersion', 'sourceDocument', 'sourcePage', 'rawValue',
        'rawDenominator', 'resolution'
      ])
      AND "source_provenance"->'schemaVersion' = '1'::jsonb
      AND jsonb_typeof("source_provenance"->'sourceDocument') = 'string'
      AND jsonb_typeof("source_provenance"->'sourcePage') = 'number'
      AND (
        jsonb_typeof("source_provenance"->'rawValue') IN ('null', 'string')
      )
      AND (
        jsonb_typeof("source_provenance"->'rawDenominator') IN ('null', 'string')
      )
      AND jsonb_typeof("source_provenance"->'resolution') = 'string'
    )) IS TRUE
  ),
  CONSTRAINT "plan_draft_goal_revisions_goal_number_key"
    UNIQUE ("plan_goal_id", "revision_number"),
  CONSTRAINT "plan_draft_goal_revisions_goal_id_key"
    UNIQUE ("plan_goal_id", "id"),
  CONSTRAINT "plan_draft_goal_revisions_goal_identity_fkey"
    FOREIGN KEY ("plan_goal_id", "space_id", "goal_definition_id")
    REFERENCES "plan_draft_goals"("id", "space_id", "goal_definition_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "plan_draft_goal_revisions_definition_version_fkey"
    FOREIGN KEY ("goal_definition_id", "goal_definition_version_id")
    REFERENCES "goal_definition_versions"("goal_definition_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "plan_draft_goal_revisions_definition_series_fkey"
    FOREIGN KEY ("goal_definition_id", "goal_series_id")
    REFERENCES "goal_series"("goal_definition_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "plan_draft_goal_revisions_owner_fkey"
    FOREIGN KEY ("space_id", "owner_member_id")
    REFERENCES "memberships"("space_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

ALTER TABLE "plan_draft_goals"
  ADD CONSTRAINT "plan_draft_goals_current_revision_fkey"
    FOREIGN KEY ("id", "current_revision_id")
    REFERENCES "plan_draft_goal_revisions"("plan_goal_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "planning_action_groups"
  DROP CONSTRAINT "planning_action_groups_action_kind_check",
  ADD CONSTRAINT "planning_action_groups_action_kind_check"
    CHECK ("action_kind" IN (
      'draft_created', 'month_focus_updated',
      'goal_definition_created', 'goal_definition_versioned',
      'goal_definition_archived', 'goal_definition_restored',
      'goal_definition_copied', 'draft_goal_added', 'draft_goal_updated',
      'draft_goal_removed', 'draft_goals_reordered'
    )),
  DROP CONSTRAINT "planning_action_groups_target_check",
  ADD CONSTRAINT "planning_action_groups_target_check" CHECK (
    ("action_kind" IN (
      'draft_created', 'month_focus_updated', 'draft_goal_added',
      'draft_goal_updated', 'draft_goal_removed', 'draft_goals_reordered'
    ) AND "plan_month_id" IS NOT NULL AND "goal_definition_id" IS NULL)
    OR
    ("action_kind" IN (
      'goal_definition_created', 'goal_definition_versioned',
      'goal_definition_archived', 'goal_definition_restored',
      'goal_definition_copied'
    ) AND "plan_month_id" IS NULL AND "goal_definition_id" IS NOT NULL)
  );

CREATE UNIQUE INDEX "planning_action_groups_month_after_revision_key"
  ON "planning_action_groups"("plan_month_id", "after_revision")
  WHERE "plan_month_id" IS NOT NULL;

CREATE FUNCTION "reject_p03_duplicate_month_transition"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.plan_month_id IS NOT NULL
     AND NEW.action_kind IN (
       'draft_goal_added', 'draft_goal_updated',
       'draft_goal_removed', 'draft_goals_reordered'
     )
     AND EXISTS (
    SELECT 1 FROM planning_action_groups
     WHERE plan_month_id = NEW.plan_month_id
       AND after_revision = NEW.after_revision
  ) THEN
    RAISE EXCEPTION 'planning month revision transition is already recorded'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "planning_action_groups_transition_unique"
BEFORE INSERT ON "planning_action_groups"
FOR EACH ROW EXECUTE FUNCTION "reject_p03_duplicate_month_transition"();

CREATE TABLE "planning_draft_goal_changes" (
  "action_id" UUID NOT NULL,
  "plan_goal_id" UUID,
  "before_revision_id" UUID,
  "after_revision_id" UUID,
  "reordered_goal_count" INTEGER,
  "before_order" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "after_order" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],

  CONSTRAINT "planning_draft_goal_changes_pkey" PRIMARY KEY ("action_id"),
  CONSTRAINT "planning_draft_goal_changes_count_check" CHECK (
    "reordered_goal_count" IS NULL OR "reordered_goal_count" BETWEEN 0 AND 200
  ),
  CONSTRAINT "planning_draft_goal_changes_order_check" CHECK (
    (cardinality("before_order") BETWEEN 0 AND 200
      AND cardinality("after_order") BETWEEN 0 AND 200
      AND array_position("before_order", NULL) IS NULL
      AND array_position("after_order", NULL) IS NULL
      AND "p03_uuid_array_is_distinct"("before_order")
      AND "p03_uuid_array_is_distinct"("after_order")) IS TRUE
  ),
  CONSTRAINT "planning_draft_goal_changes_action_fkey"
    FOREIGN KEY ("action_id") REFERENCES "planning_action_groups"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "planning_draft_goal_changes_goal_fkey"
    FOREIGN KEY ("plan_goal_id") REFERENCES "plan_draft_goals"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "planning_draft_goal_changes_before_revision_fkey"
    FOREIGN KEY ("plan_goal_id", "before_revision_id")
    REFERENCES "plan_draft_goal_revisions"("plan_goal_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "planning_draft_goal_changes_after_revision_fkey"
    FOREIGN KEY ("plan_goal_id", "after_revision_id")
    REFERENCES "plan_draft_goal_revisions"("plan_goal_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "planning_draft_goal_changes_after_revision_key"
  ON "planning_draft_goal_changes"("after_revision_id")
  WHERE "after_revision_id" IS NOT NULL;

CREATE FUNCTION "guard_p03_draft_goal_root"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'plan_draft_goals rows cannot be physically deleted'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.id <> OLD.id OR NEW.space_id <> OLD.space_id
     OR NEW.plan_month_id <> OLD.plan_month_id
     OR NEW.goal_definition_id <> OLD.goal_definition_id
     OR NEW.attached_at <> OLD.attached_at OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'plan_draft_goals identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.detached_at IS NOT NULL AND NEW.detached_at IS DISTINCT FROM OLD.detached_at THEN
    RAISE EXCEPTION 'plan_draft_goals detached state is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.detached_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'detached plan_draft_goals rows are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "plan_draft_goals_guard_update_delete"
BEFORE UPDATE OR DELETE ON "plan_draft_goals"
FOR EACH ROW EXECUTE FUNCTION "guard_p03_draft_goal_root"();

CREATE FUNCTION "require_p03_dense_active_order"()
RETURNS TRIGGER AS $$
DECLARE
  active_count INTEGER;
  minimum_order INTEGER;
  maximum_order INTEGER;
BEGIN
  SELECT count(*)::int, min(display_order), max(display_order)
    INTO active_count, minimum_order, maximum_order
    FROM plan_draft_goals
   WHERE plan_month_id = NEW.plan_month_id AND detached_at IS NULL;
  IF active_count > 200 OR (
    active_count > 0 AND (
      minimum_order <> 0 OR maximum_order <> active_count - 1
    )
  ) THEN
    RAISE EXCEPTION 'plan_draft_goals_active_order_invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "plan_draft_goals_dense_active_order"
AFTER INSERT OR UPDATE ON "plan_draft_goals"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_p03_dense_active_order"();

CREATE TRIGGER "plan_draft_goal_revisions_reject_update_delete"
BEFORE UPDATE OR DELETE ON "plan_draft_goal_revisions"
FOR EACH ROW EXECUTE FUNCTION "reject_p01_immutable_row_change"();

CREATE TRIGGER "planning_draft_goal_changes_reject_update_delete"
BEFORE UPDATE OR DELETE ON "planning_draft_goal_changes"
FOR EACH ROW EXECUTE FUNCTION "reject_p01_immutable_row_change"();

CREATE FUNCTION "validate_planning_draft_goal_change"()
RETURNS TRIGGER AS $$
DECLARE
  parent_kind VARCHAR(32);
  parent_month UUID;
  parent_before BIGINT;
  parent_after BIGINT;
  goal_month UUID;
  goal_current_revision UUID;
  goal_detached_at TIMESTAMPTZ(3);
  before_revision_number BIGINT;
  after_revision_number BIGINT;
  current_draft_revision BIGINT;
  current_active_order UUID[];
BEGIN
  SELECT action_kind, plan_month_id, before_revision, after_revision
    INTO parent_kind, parent_month, parent_before, parent_after
    FROM planning_action_groups WHERE id = NEW.action_id;
  IF parent_kind IS NULL OR EXISTS (
    SELECT 1 FROM planning_month_focus_changes WHERE action_id = NEW.action_id
  ) OR EXISTS (
    SELECT 1 FROM planning_goal_catalog_changes WHERE action_id = NEW.action_id
  ) THEN
    RAISE EXCEPTION 'planning_draft_goal_changes_detail_conflict'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.plan_goal_id IS NOT NULL THEN
    SELECT plan_month_id, current_revision_id, detached_at
      INTO goal_month, goal_current_revision, goal_detached_at
      FROM plan_draft_goals
      WHERE id = NEW.plan_goal_id;
  END IF;
  IF NEW.before_revision_id IS NOT NULL THEN
    SELECT revision_number INTO before_revision_number
      FROM plan_draft_goal_revisions
     WHERE plan_goal_id = NEW.plan_goal_id AND id = NEW.before_revision_id;
  END IF;
  IF NEW.after_revision_id IS NOT NULL THEN
    SELECT revision_number INTO after_revision_number
      FROM plan_draft_goal_revisions
     WHERE plan_goal_id = NEW.plan_goal_id AND id = NEW.after_revision_id;
  END IF;
  SELECT revision INTO current_draft_revision
    FROM plan_drafts WHERE plan_month_id = parent_month;
  SELECT COALESCE(array_agg(id ORDER BY display_order, id), ARRAY[]::UUID[])
    INTO current_active_order
    FROM plan_draft_goals
   WHERE plan_month_id = parent_month AND detached_at IS NULL;
  IF (parent_before IS NOT NULL AND parent_after = parent_before + 1
      AND current_draft_revision = parent_after) IS NOT TRUE THEN
    RAISE EXCEPTION 'planning_draft_goal_changes_revision_shape'
      USING ERRCODE = '23514';
  END IF;
  IF parent_kind = 'draft_goal_added' THEN
    IF (NEW.plan_goal_id IS NOT NULL AND goal_month = parent_month
      AND NEW.before_revision_id IS NULL AND NEW.after_revision_id IS NOT NULL
      AND NEW.after_revision_id = goal_current_revision
      AND after_revision_number = 1 AND goal_detached_at IS NULL
      AND NEW.reordered_goal_count IS NULL
      AND cardinality(NEW.before_order) = 0
      AND cardinality(NEW.after_order) = 0) IS NOT TRUE THEN
      RAISE EXCEPTION 'planning_draft_goal_changes_shape' USING ERRCODE = '23514';
    END IF;
  ELSIF parent_kind = 'draft_goal_updated' THEN
    IF (NEW.plan_goal_id IS NOT NULL AND goal_month = parent_month
      AND NEW.before_revision_id IS NOT NULL AND NEW.after_revision_id IS NOT NULL
      AND NEW.after_revision_id = goal_current_revision
      AND after_revision_number = before_revision_number + 1
      AND goal_detached_at IS NULL
      AND NEW.reordered_goal_count IS NULL
      AND cardinality(NEW.before_order) = 0
      AND cardinality(NEW.after_order) = 0) IS NOT TRUE THEN
      RAISE EXCEPTION 'planning_draft_goal_changes_shape' USING ERRCODE = '23514';
    END IF;
  ELSIF parent_kind = 'draft_goal_removed' THEN
    IF (NEW.plan_goal_id IS NOT NULL AND goal_month = parent_month
      AND NEW.before_revision_id IS NOT NULL AND NEW.after_revision_id IS NULL
      AND NEW.before_revision_id = goal_current_revision
      AND goal_detached_at IS NULL
      AND NEW.reordered_goal_count IS NULL
      AND cardinality(NEW.after_order) + 1 = cardinality(NEW.before_order)
      AND NEW.plan_goal_id = ANY(NEW.before_order)
      AND NEW.after_order = array_remove(NEW.before_order, NEW.plan_goal_id)
      AND NEW.before_order = current_active_order) IS NOT TRUE THEN
      RAISE EXCEPTION 'planning_draft_goal_changes_shape' USING ERRCODE = '23514';
    END IF;
  ELSIF parent_kind = 'draft_goals_reordered' THEN
    IF (NEW.plan_goal_id IS NULL AND NEW.before_revision_id IS NULL
      AND NEW.after_revision_id IS NULL AND NEW.reordered_goal_count IS NOT NULL
      AND cardinality(NEW.before_order) = NEW.reordered_goal_count
      AND cardinality(NEW.after_order) = NEW.reordered_goal_count
      AND NEW.before_order @> NEW.after_order
      AND NEW.after_order @> NEW.before_order
      AND NEW.before_order = current_active_order) IS NOT TRUE THEN
      RAISE EXCEPTION 'planning_draft_goal_changes_shape' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'planning_draft_goal_changes_parent_kind' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "planning_draft_goal_changes_validate"
BEFORE INSERT ON "planning_draft_goal_changes"
FOR EACH ROW EXECUTE FUNCTION "validate_planning_draft_goal_change"();

CREATE FUNCTION "require_p03_draft_goal_change_effect"()
RETURNS TRIGGER AS $$
DECLARE
  parent_kind VARCHAR(32);
  parent_month UUID;
  parent_actor_scope VARCHAR(64);
  parent_command_type VARCHAR(128);
  parent_command_id UUID;
  parent_after BIGINT;
  receipt_result_kind VARCHAR(128);
  receipt_aggregate_id UUID;
  receipt_aggregate_revision BIGINT;
  current_draft_revision BIGINT;
  current_active_order UUID[];
  goal_current_revision UUID;
  goal_detached_at TIMESTAMPTZ(3);
BEGIN
  SELECT action_kind, plan_month_id, actor_scope, command_type, command_id,
         after_revision
    INTO parent_kind, parent_month, parent_actor_scope, parent_command_type,
         parent_command_id, parent_after
    FROM planning_action_groups WHERE id = NEW.action_id;
  SELECT result_kind, aggregate_id, aggregate_revision
    INTO receipt_result_kind, receipt_aggregate_id, receipt_aggregate_revision
    FROM command_receipts
   WHERE actor_scope = parent_actor_scope
     AND command_type = parent_command_type
     AND command_id = parent_command_id;
  SELECT revision INTO current_draft_revision
    FROM plan_drafts WHERE plan_month_id = parent_month;
  SELECT COALESCE(array_agg(id ORDER BY display_order, id), ARRAY[]::UUID[])
    INTO current_active_order
    FROM plan_draft_goals
   WHERE plan_month_id = parent_month AND detached_at IS NULL;
  IF (receipt_result_kind = 'planning.plan-draft.v1'
      AND receipt_aggregate_id = parent_month
      AND receipt_aggregate_revision = parent_after
      AND current_draft_revision = parent_after) IS NOT TRUE THEN
    RAISE EXCEPTION 'planning_draft_goal_change_receipt_mismatch'
      USING ERRCODE = '23514';
  END IF;
  IF parent_kind IN ('draft_goal_removed', 'draft_goals_reordered')
     AND (NEW.after_order = current_active_order) IS NOT TRUE THEN
    RAISE EXCEPTION 'planning_draft_goal_change_final_order_mismatch'
      USING ERRCODE = '23514';
  END IF;
  IF parent_kind IN (
    'draft_goal_added', 'draft_goal_updated', 'draft_goal_removed'
  ) THEN
    SELECT current_revision_id, detached_at
      INTO goal_current_revision, goal_detached_at
      FROM plan_draft_goals WHERE id = NEW.plan_goal_id;
  END IF;
  IF parent_kind IN ('draft_goal_added', 'draft_goal_updated')
     AND (goal_current_revision = NEW.after_revision_id
          AND goal_detached_at IS NULL) IS NOT TRUE THEN
    RAISE EXCEPTION 'planning_draft_goal_change_current_effect_mismatch'
      USING ERRCODE = '23514';
  END IF;
  IF parent_kind = 'draft_goal_removed'
     AND (goal_current_revision = NEW.before_revision_id
          AND goal_detached_at IS NOT NULL) IS NOT TRUE THEN
      RAISE EXCEPTION 'planning_draft_goal_change_detach_missing'
        USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "planning_draft_goal_change_effect_consistent"
AFTER INSERT ON "planning_draft_goal_changes"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_p03_draft_goal_change_effect"();

CREATE FUNCTION "require_p03_current_revision"()
RETURNS TRIGGER AS $$
DECLARE
  current_number BIGINT;
  maximum_number BIGINT;
  minimum_number BIGINT;
  revision_count BIGINT;
  current_pointer UUID;
  target_plan_goal_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'plan_draft_goal_revisions' THEN
    target_plan_goal_id := NEW.plan_goal_id;
  ELSE
    target_plan_goal_id := NEW.id;
  END IF;
  SELECT current_revision_id INTO current_pointer FROM plan_draft_goals
   WHERE id = target_plan_goal_id;
  IF current_pointer IS NULL THEN
    RAISE EXCEPTION 'plan_draft_goals_current_revision_required'
      USING ERRCODE = '23514';
  END IF;
  SELECT revision_number INTO current_number
   FROM plan_draft_goal_revisions
   WHERE plan_goal_id = target_plan_goal_id AND id = current_pointer;
  SELECT min(revision_number), max(revision_number), count(*)
    INTO minimum_number, maximum_number, revision_count
    FROM plan_draft_goal_revisions WHERE plan_goal_id = target_plan_goal_id;
  IF current_number IS NULL OR current_number <> maximum_number
     OR minimum_number <> 1 OR revision_count <> maximum_number THEN
    RAISE EXCEPTION 'plan_draft_goals_current_revision_mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "plan_draft_goals_require_current_revision"
AFTER INSERT OR UPDATE OF current_revision_id ON "plan_draft_goals"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_p03_current_revision"();

CREATE CONSTRAINT TRIGGER "plan_draft_goal_revision_requires_current_pointer"
AFTER INSERT ON "plan_draft_goal_revisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_p03_current_revision"();

CREATE FUNCTION "require_p03_draft_goal_detail"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.action_kind IN (
    'draft_goal_added', 'draft_goal_updated', 'draft_goal_removed',
    'draft_goals_reordered'
  ) AND NOT EXISTS (
    SELECT 1 FROM planning_draft_goal_changes WHERE action_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'planning_draft_goal_change_required' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "planning_draft_goal_action_requires_detail"
AFTER INSERT ON "planning_action_groups"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_p03_draft_goal_detail"();
