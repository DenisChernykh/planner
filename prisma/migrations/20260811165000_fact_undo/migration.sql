-- T06 adds append-only compensation of the last own reversible action.
LOCK TABLE plan_months, plan_publications, plan_goal_snapshots,
  tracking_fact_records, tracking_fact_revisions, tracking_action_groups,
  tracking_fact_changes, command_receipts IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM command_receipts
     WHERE command_type = 'tracking.undo-last-own-action.v1'
  ) THEN
    RAISE EXCEPTION 'T06 cannot adopt pre-existing undo receipts'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER FUNCTION "t01_action_has_exact_shape"(UUID)
  RENAME TO "t05_action_has_exact_shape_dispatch";

ALTER TABLE "tracking_action_groups"
  DROP CONSTRAINT "tracking_action_groups_action_check",
  ADD CONSTRAINT "tracking_action_groups_action_check" CHECK (
    "action_kind" IN (
      'fact_recorded', 'fact_corrected', 'fact_tombstoned', 'fact_undone'
    )
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
      'tracking.delete-record.v1',
      'tracking.undo-last-own-action.v1'
    )
  ),
  DROP CONSTRAINT "tracking_action_groups_reason_check",
  ADD CONSTRAINT "tracking_action_groups_reason_check" CHECK (
    (
      "action_kind" IN ('fact_recorded', 'fact_undone')
      AND "reason" IS NULL
    )
    OR (
      "action_kind" IN ('fact_corrected', 'fact_tombstoned')
      AND "reason" IS NOT NULL
      AND length("reason") <= 2000
      AND t03_text_is_nonempty("reason")
    )
  );

CREATE TABLE "tracking_fact_undo_changes" (
  "action_id" UUID NOT NULL,
  "undone_action_id" UUID NOT NULL,
  "restored_from_revision_id" UUID,

  CONSTRAINT "tracking_fact_undo_changes_pkey" PRIMARY KEY ("action_id"),
  CONSTRAINT "tracking_fact_undo_changes_undone_action_key"
    UNIQUE ("undone_action_id"),
  CONSTRAINT "tracking_fact_undo_changes_action_fkey"
    FOREIGN KEY ("action_id") REFERENCES "tracking_action_groups"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "tracking_fact_undo_changes_undone_action_fkey"
    FOREIGN KEY ("undone_action_id") REFERENCES "tracking_action_groups"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "tracking_fact_undo_changes_restored_revision_fkey"
    FOREIGN KEY ("restored_from_revision_id")
    REFERENCES "tracking_fact_revisions"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TRIGGER "tracking_fact_undo_changes_reject_update_delete"
BEFORE UPDATE OR DELETE ON "tracking_fact_undo_changes"
FOR EACH ROW EXECUTE FUNCTION "reject_p01_immutable_row_change"();

CREATE FUNCTION "t06_action_has_exact_shape"(target_action UUID)
RETURNS BOOLEAN AS $$
DECLARE
  action_value tracking_action_groups%ROWTYPE;
  change_value tracking_fact_changes%ROWTYPE;
  undo_value tracking_fact_undo_changes%ROWTYPE;
  undone_action tracking_action_groups%ROWTYPE;
  undone_change tracking_fact_changes%ROWTYPE;
  record_value tracking_fact_records%ROWTYPE;
  before_value tracking_fact_revisions%ROWTYPE;
  after_value tracking_fact_revisions%ROWTYPE;
  restored_value tracking_fact_revisions%ROWTYPE;
  receipt_value command_receipts%ROWTYPE;
  month_value plan_months%ROWTYPE;
  publication_value plan_publications%ROWTYPE;
  snapshot_value plan_goal_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO action_value FROM tracking_action_groups
   WHERE id = target_action;
  SELECT * INTO change_value FROM tracking_fact_changes
   WHERE action_id = target_action;
  SELECT * INTO undo_value FROM tracking_fact_undo_changes
   WHERE action_id = target_action;
  SELECT * INTO undone_action FROM tracking_action_groups
   WHERE id = undo_value.undone_action_id;
  SELECT * INTO undone_change FROM tracking_fact_changes
   WHERE action_id = undone_action.id;
  SELECT * INTO record_value FROM tracking_fact_records
   WHERE id = change_value.fact_record_id;
  SELECT * INTO before_value FROM tracking_fact_revisions
   WHERE id = change_value.before_revision_id;
  SELECT * INTO after_value FROM tracking_fact_revisions
   WHERE id = change_value.after_revision_id;
  SELECT * INTO restored_value FROM tracking_fact_revisions
   WHERE id = undo_value.restored_from_revision_id;
  SELECT * INTO receipt_value FROM command_receipts
   WHERE actor_scope = action_value.actor_scope
     AND command_type = action_value.command_type
     AND command_id = action_value.command_id;
  SELECT * INTO month_value FROM plan_months
   WHERE id = action_value.plan_month_id;
  SELECT * INTO publication_value FROM plan_publications
   WHERE id = action_value.publication_id;
  SELECT * INTO snapshot_value FROM plan_goal_snapshots
   WHERE id = action_value.plan_goal_snapshot_id;

  RETURN (
    action_value.id IS NOT NULL
    AND action_value.action_kind = 'fact_undone'
    AND action_value.command_type = 'tracking.undo-last-own-action.v1'
    AND action_value.actor_kind = 'member'
    AND action_value.actor_scope = 'member:' || action_value.member_id::text
    AND action_value.reason IS NULL
    AND action_value.before_facts_revision >= 0
    AND action_value.after_facts_revision = action_value.before_facts_revision + 1
    AND month_value.id = action_value.plan_month_id
    AND month_value.space_id = action_value.space_id
    AND month_value.facts_revision = action_value.after_facts_revision
    AND month_value.status IN ('published', 'grace')
    AND month_value.active_publication_id = action_value.publication_id
    AND (action_value.occurred_at AT TIME ZONE 'Asia/Yekaterinburg')::date
        <= (month_value.month_start + INTERVAL '1 month + 2 days')::date
    AND publication_value.id = action_value.publication_id
    AND publication_value.plan_month_id = action_value.plan_month_id
    AND publication_value.space_id = action_value.space_id
    AND snapshot_value.id = action_value.plan_goal_snapshot_id
    AND snapshot_value.publication_id = action_value.publication_id
    AND snapshot_value.space_id = action_value.space_id
    AND (snapshot_value.scope_kind = 'shared'
         OR snapshot_value.owner_member_id = action_value.member_id)
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
    AND undo_value.action_id = action_value.id
    AND undo_value.undone_action_id = undone_action.id
    AND undone_action.actor_kind = 'member'
    AND undone_action.member_id = action_value.member_id
    AND undone_action.space_id = action_value.space_id
    AND undone_action.plan_month_id = action_value.plan_month_id
    AND undone_action.action_kind IN (
      'fact_recorded', 'fact_corrected', 'fact_tombstoned'
    )
    AND undone_change.action_id = undone_action.id
    AND undone_change.fact_record_id = record_value.id
    AND undo_value.restored_from_revision_id
        IS NOT DISTINCT FROM undone_change.before_revision_id
    AND NOT EXISTS (
      SELECT 1
        FROM tracking_action_groups candidate
        JOIN tracking_fact_changes candidate_change
          ON candidate_change.action_id = candidate.id
        LEFT JOIN tracking_fact_undo_changes compensation
          ON compensation.undone_action_id = candidate.id
       WHERE candidate.plan_month_id = action_value.plan_month_id
         AND candidate.actor_kind = 'member'
         AND candidate.member_id = action_value.member_id
         AND candidate.action_kind IN (
           'fact_recorded', 'fact_corrected', 'fact_tombstoned'
         )
         AND candidate.after_facts_revision > undone_action.after_facts_revision
         AND compensation.action_id IS NULL
    )
    AND EXISTS (
      WITH RECURSIVE effective_revision(revision_id) AS (
        SELECT before_value.id
        UNION
        SELECT current_undo.restored_from_revision_id
          FROM effective_revision current_state
          JOIN tracking_fact_changes current_change
            ON current_change.after_revision_id = current_state.revision_id
           AND current_change.fact_record_id = record_value.id
          JOIN tracking_action_groups current_action
            ON current_action.id = current_change.action_id
          JOIN tracking_fact_undo_changes current_undo
            ON current_undo.action_id = current_action.id
         WHERE current_action.action_kind = 'fact_undone'
           AND current_action.actor_kind = 'member'
           AND current_action.member_id = action_value.member_id
           AND current_undo.restored_from_revision_id IS NOT NULL
      )
      SELECT 1 FROM effective_revision
       WHERE revision_id = undone_change.after_revision_id
    )
    AND (
      (
        undone_change.before_revision_id IS NULL
        AND undo_value.restored_from_revision_id IS NULL
        AND after_value.revision_kind = 'tombstoned'
        AND num_nonnulls(
          after_value.boolean_result, after_value.quantity_value,
          after_value.actual_time_value, after_value.rating_value,
          after_value.text_value, after_value.text_result,
          after_value.checklist_item_state, after_value.or_variant_value
        ) = 0
      )
      OR (
        undone_change.before_revision_id IS NOT NULL
        AND restored_value.id = undone_change.before_revision_id
        AND restored_value.fact_record_id = record_value.id
        AND after_value.revision_kind = restored_value.revision_kind
        AND after_value.boolean_result
            IS NOT DISTINCT FROM restored_value.boolean_result
        AND after_value.quantity_value
            IS NOT DISTINCT FROM restored_value.quantity_value
        AND after_value.actual_time_value
            IS NOT DISTINCT FROM restored_value.actual_time_value
        AND after_value.rating_value
            IS NOT DISTINCT FROM restored_value.rating_value
        AND after_value.text_value
            IS NOT DISTINCT FROM restored_value.text_value
        AND after_value.text_result
            IS NOT DISTINCT FROM restored_value.text_result
        AND after_value.checklist_item_state
            IS NOT DISTINCT FROM restored_value.checklist_item_state
        AND after_value.or_variant_value
            IS NOT DISTINCT FROM restored_value.or_variant_value
      )
    )
    AND receipt_value.result_kind = 'tracking.fact-record.v1'
    AND receipt_value.aggregate_id = record_value.id
    AND receipt_value.aggregate_revision = after_value.revision_number
    AND receipt_value.completed_at = action_value.occurred_at
    AND t01_fact_record_has_exact_shape(record_value.id)
  ) IS TRUE;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION "t01_action_has_exact_shape"(target_action UUID)
RETURNS BOOLEAN AS $$
DECLARE
  type_value TEXT;
BEGIN
  SELECT command_type INTO type_value FROM tracking_action_groups
   WHERE id = target_action;
  IF type_value = 'tracking.undo-last-own-action.v1' THEN
    RETURN t06_action_has_exact_shape(target_action);
  END IF;
  RETURN t05_action_has_exact_shape_dispatch(target_action);
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
       'tracking.correct-record.v1', 'tracking.delete-record.v1',
       'tracking.undo-last-own-action.v1'
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
      'tracking.correct-record.v1', 'tracking.delete-record.v1',
      'tracking.undo-last-own-action.v1'
    ) OR NEW.result_kind = 'tracking.fact-record.v1'
  ) AND NOT (
    NEW.command_type IN (
      'tracking.record-fact.v1', 'tracking.record-time.v1',
      'tracking.record-rating.v1', 'tracking.record-checkpoint.v1',
      'tracking.record-text.v1', 'tracking.record-checklist-item.v1',
      'tracking.record-or-variant.v1',
      'tracking.record-composite-occurrence.v1',
      'tracking.correct-record.v1', 'tracking.delete-record.v1',
      'tracking.undo-last-own-action.v1'
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

CREATE FUNCTION "require_t06_undo_detail"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.command_type = 'tracking.undo-last-own-action.v1'
     AND NOT EXISTS (
       SELECT 1 FROM tracking_fact_undo_changes detail
        WHERE detail.action_id = NEW.id
     ) THEN
    RAISE EXCEPTION 'undo action requires compensation detail'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "tracking_action_requires_undo_detail"
AFTER INSERT ON "tracking_action_groups"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_t06_undo_detail"();

CREATE FUNCTION "require_t06_undo_effect"()
RETURNS TRIGGER AS $$
BEGIN
  IF t06_action_has_exact_shape(NEW.action_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'tracking undo effect mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "tracking_fact_undo_effect_consistent"
AFTER INSERT ON "tracking_fact_undo_changes"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_t06_undo_effect"();
