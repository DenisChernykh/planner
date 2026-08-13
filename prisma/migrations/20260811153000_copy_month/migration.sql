-- P09 copies one immutable publication into a new editable draft.
LOCK TABLE plan_months, plan_drafts, plan_draft_goals,
  plan_draft_goal_revisions, plan_publications, plan_goal_snapshots,
  planning_action_groups, command_receipts IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF to_regclass('planning_month_copy_changes') IS NOT NULL THEN
    RAISE EXCEPTION 'P09 copy history table already exists';
  END IF;
  IF EXISTS (
    SELECT 1 FROM planning_action_groups WHERE action_kind = 'draft_copied'
  ) OR EXISTS (
    SELECT 1 FROM command_receipts
     WHERE command_type = 'planning.create-draft-from-publication.v1'
  ) THEN
    RAISE EXCEPTION 'P09 copy history already exists without its migration';
  END IF;
END;
$$;

CREATE TABLE "planning_month_copy_changes" (
  "action_id" UUID NOT NULL,
  "source_publication_id" UUID NOT NULL,
  "copied_goal_count" INTEGER NOT NULL,
  "after_order" UUID[] NOT NULL,

  CONSTRAINT "planning_month_copy_changes_pkey" PRIMARY KEY ("action_id"),
  CONSTRAINT "planning_month_copy_changes_count_check" CHECK (
    "copied_goal_count" BETWEEN 0 AND 200
    AND cardinality("after_order") = "copied_goal_count"
  ),
  CONSTRAINT "planning_month_copy_changes_order_check" CHECK (
    array_position("after_order", NULL) IS NULL
    AND "p03_uuid_array_is_distinct"("after_order")
  ),
  CONSTRAINT "planning_month_copy_changes_action_fkey"
    FOREIGN KEY ("action_id") REFERENCES "planning_action_groups"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "planning_month_copy_changes_source_fkey"
    FOREIGN KEY ("source_publication_id") REFERENCES "plan_publications"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

ALTER TABLE "planning_action_groups"
  DROP CONSTRAINT "planning_action_groups_action_kind_check",
  ADD CONSTRAINT "planning_action_groups_action_kind_check" CHECK (
    "action_kind" IN (
      'draft_created', 'draft_copied', 'month_focus_updated',
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
      'draft_created', 'draft_copied', 'month_focus_updated',
      'draft_goal_added', 'draft_goal_updated', 'draft_goal_removed',
      'draft_goals_reordered', 'month_published',
      'month_publication_cancelled'
    ) AND "plan_month_id" IS NOT NULL AND "goal_definition_id" IS NULL)
    OR ("action_kind" IN (
      'goal_definition_created', 'goal_definition_versioned',
      'goal_definition_archived', 'goal_definition_restored',
      'goal_definition_copied'
    ) AND "plan_month_id" IS NULL AND "goal_definition_id" IS NOT NULL)
  );

DROP INDEX "planning_action_groups_draft_after_revision_key";
CREATE UNIQUE INDEX "planning_action_groups_draft_after_revision_key"
  ON "planning_action_groups"("plan_month_id", "after_revision")
  WHERE "action_kind" IN (
    'draft_created', 'draft_copied', 'month_focus_updated',
    'draft_goal_added', 'draft_goal_updated', 'draft_goal_removed',
    'draft_goals_reordered'
  );

CREATE FUNCTION "p09_month_copy_matches_source"(
  target_month UUID,
  source_publication UUID,
  copied_order UUID[]
)
RETURNS BOOLEAN AS $$
DECLARE
  source_count INTEGER;
  root_count INTEGER;
  active_root_count INTEGER;
  revision_count INTEGER;
  current_order UUID[];
BEGIN
  SELECT count(*)::int INTO source_count
    FROM plan_goal_snapshots WHERE publication_id = source_publication;
  SELECT count(*)::int,
         count(*) FILTER (WHERE detached_at IS NULL)::int,
         COALESCE(array_agg(id ORDER BY display_order, id)
           FILTER (WHERE detached_at IS NULL), ARRAY[]::UUID[])
    INTO root_count, active_root_count, current_order
    FROM plan_draft_goals WHERE plan_month_id = target_month;
  SELECT count(*)::int INTO revision_count
    FROM plan_draft_goal_revisions revision
    JOIN plan_draft_goals root ON root.id = revision.plan_goal_id
   WHERE root.plan_month_id = target_month;

  IF source_count <> root_count
     OR source_count <> active_root_count
     OR source_count <> revision_count
     OR current_order <> copied_order THEN
    RETURN FALSE;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM plan_goal_snapshots snapshot
      LEFT JOIN plan_draft_goals root
        ON root.plan_month_id = target_month
       AND root.display_order = snapshot.display_order
       AND root.detached_at IS NULL
      LEFT JOIN plan_draft_goal_revisions revision
        ON revision.plan_goal_id = root.id
       AND revision.id = root.current_revision_id
     WHERE snapshot.publication_id = source_publication
       AND (
         root.id IS NULL
         OR copied_order[snapshot.display_order + 1] <> root.id
         OR root.space_id <> snapshot.space_id
         OR root.goal_definition_id <> snapshot.goal_definition_id
         OR revision.id IS NULL
         OR revision.revision_number <> 1
         OR revision.space_id <> snapshot.space_id
         OR revision.goal_definition_id <> snapshot.goal_definition_id
         OR revision.goal_definition_version_id <>
              snapshot.goal_definition_version_id
         OR revision.goal_series_id <> snapshot.goal_series_id
         OR revision.scope_kind <> snapshot.scope_kind
         OR revision.owner_member_id IS DISTINCT FROM snapshot.owner_member_id
         OR revision.config <> snapshot.config
         OR revision.source_provenance IS DISTINCT FROM
              snapshot.source_provenance
       )
  ) THEN
    RETURN FALSE;
  END IF;
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION "p09_month_copy_has_exact_shape"(
  copy_action UUID,
  source_publication UUID,
  copied_count INTEGER,
  copied_order UUID[]
)
RETURNS BOOLEAN AS $$
DECLARE
  parent planning_action_groups%ROWTYPE;
  source plan_publications%ROWTYPE;
  destination plan_months%ROWTYPE;
  draft plan_drafts%ROWTYPE;
  source_count INTEGER;
BEGIN
  SELECT * INTO parent FROM planning_action_groups WHERE id = copy_action;
  SELECT * INTO source FROM plan_publications
   WHERE id = source_publication;
  SELECT * INTO destination FROM plan_months WHERE id = parent.plan_month_id;
  SELECT * INTO draft FROM plan_drafts WHERE plan_month_id = destination.id;
  SELECT count(*)::int INTO source_count FROM plan_goal_snapshots
   WHERE publication_id = source_publication;

  RETURN (
    parent.id IS NOT NULL
    AND parent.action_kind = 'draft_copied'
    AND parent.command_type = 'planning.create-draft-from-publication.v1'
    AND parent.actor_kind = 'member'
    AND parent.member_id IS NOT NULL
    AND parent.before_revision IS NULL
    AND parent.after_revision = 1
    AND source.id IS NOT NULL
    AND source.space_id = destination.space_id
    AND source.plan_month_id <> destination.id
    AND destination.status = 'draft'
    AND destination.revision = 1
    AND destination.facts_revision = 0
    AND destination.active_publication_id IS NULL
    AND draft.plan_month_id = destination.id
    AND draft.revision = 1
    AND draft.focus = source.focus
    AND destination.created_at = parent.occurred_at
    AND destination.updated_at = parent.occurred_at
    AND draft.created_at = parent.occurred_at
    AND draft.updated_at = parent.occurred_at
    AND source_count = copied_count
    AND EXISTS (
      SELECT 1 FROM memberships member
       WHERE member.id = parent.member_id
         AND member.space_id = destination.space_id
    )
    AND p09_month_copy_matches_source(
      destination.id,
      source.id,
      copied_order
    )
  ) IS TRUE;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION "validate_p09_month_copy_change"()
RETURNS TRIGGER AS $$
BEGIN
  IF p09_month_copy_has_exact_shape(
    NEW.action_id,
    NEW.source_publication_id,
    NEW.copied_goal_count,
    NEW.after_order
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'planning_month_copy_changes_shape'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "planning_month_copy_changes_validate"
BEFORE INSERT ON "planning_month_copy_changes"
FOR EACH ROW EXECUTE FUNCTION "validate_p09_month_copy_change"();

CREATE TRIGGER "planning_month_copy_changes_reject_update_delete"
BEFORE UPDATE OR DELETE ON "planning_month_copy_changes"
FOR EACH ROW EXECUTE FUNCTION "reject_p01_immutable_row_change"();

CREATE FUNCTION "require_p09_month_copy_effect"()
RETURNS TRIGGER AS $$
DECLARE
  parent planning_action_groups%ROWTYPE;
  receipt command_receipts%ROWTYPE;
  destination plan_months%ROWTYPE;
BEGIN
  SELECT * INTO parent FROM planning_action_groups WHERE id = NEW.action_id;
  SELECT * INTO receipt FROM command_receipts
   WHERE actor_scope = parent.actor_scope
     AND command_type = parent.command_type
     AND command_id = parent.command_id;
  SELECT * INTO destination FROM plan_months WHERE id = parent.plan_month_id;

  IF (
    receipt.result_kind = 'planning.plan-draft.v1'
    AND receipt.aggregate_id = destination.id
    AND receipt.aggregate_revision = 1
    AND receipt.completed_at = parent.occurred_at
    AND p09_month_copy_has_exact_shape(
      NEW.action_id,
      NEW.source_publication_id,
      NEW.copied_goal_count,
      NEW.after_order
    )
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'planning_month_copy_changes_effect_mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "planning_month_copy_effect_consistent"
AFTER INSERT ON "planning_month_copy_changes"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_p09_month_copy_effect"();

CREATE FUNCTION "require_p09_month_copy_detail"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.action_kind = 'draft_copied' AND NOT EXISTS (
    SELECT 1 FROM planning_month_copy_changes WHERE action_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'planning_month_copy_change_required'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "planning_month_copy_action_requires_detail"
AFTER INSERT ON "planning_action_groups"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_p09_month_copy_detail"();

CREATE FUNCTION "require_p09_month_copy_receipt_effect"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.command_type = 'planning.create-draft-from-publication.v1'
     AND NOT EXISTS (
       SELECT 1
         FROM planning_action_groups action
         JOIN planning_month_copy_changes change ON change.action_id = action.id
        WHERE action.actor_scope = NEW.actor_scope
          AND action.command_type = NEW.command_type
          AND action.command_id = NEW.command_id
          AND action.action_kind = 'draft_copied'
          AND action.plan_month_id = NEW.aggregate_id
          AND action.before_revision IS NULL
          AND action.after_revision = NEW.aggregate_revision
          AND action.occurred_at = NEW.completed_at
     ) THEN
    RAISE EXCEPTION 'copy receipt requires exact P09 action and detail'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "command_receipts_month_copy_effect_consistent"
AFTER INSERT ON "command_receipts"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_p09_month_copy_receipt_effect"();
