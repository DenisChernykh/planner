-- T08 atomically closes unresolved fixed expectations with generic not_done facts.
LOCK TABLE plan_months, plan_publications, plan_goal_snapshots,
  fixed_expectations, tracking_fact_records, tracking_fact_revisions,
  tracking_action_groups, tracking_fact_changes, command_receipts
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM command_receipts
     WHERE command_type = 'tracking.close-day.v1'
        OR result_kind = 'tracking.day-close.v1'
  ) THEN
    RAISE EXCEPTION 'T08 cannot adopt pre-existing CloseDay receipts'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER FUNCTION "t01_fact_record_has_exact_shape"(UUID)
  RENAME TO "t06_fact_record_has_exact_shape_dispatch";
ALTER FUNCTION "t01_action_has_exact_shape"(UUID)
  RENAME TO "t06_action_has_exact_shape_dispatch";

ALTER TABLE "tracking_fact_records"
  DROP CONSTRAINT "tracking_fact_records_kind_check",
  ADD CONSTRAINT "tracking_fact_records_kind_check" CHECK (
    "fact_kind" IN (
      'boolean', 'quantity_add', 'quantity_latest', 'actual_time', 'rating',
      'text', 'checklist_item', 'or_variant', 'fixed_not_done'
    )
  );

DROP INDEX "tracking_fact_records_fixed_single_value_key";
CREATE UNIQUE INDEX "tracking_fact_records_fixed_single_value_key"
  ON "tracking_fact_records"("fixed_expectation_id")
  WHERE "fixed_expectation_id" IS NOT NULL
    AND "fact_kind" IN (
      'boolean', 'quantity_latest', 'actual_time', 'rating', 'text'
    );
CREATE UNIQUE INDEX "tracking_fact_records_fixed_not_done_key"
  ON "tracking_fact_records"("fixed_expectation_id")
  WHERE "fact_kind" = 'fixed_not_done';

ALTER TABLE "tracking_fact_revisions"
  ADD COLUMN "fixed_outcome" VARCHAR(16),
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
           "or_variant_value", "fixed_outcome"
         ) = 0)
        OR ("quantity_value" IS NOT NULL
            AND "quantity_value" ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
            AND num_nonnulls(
              "boolean_result", "actual_time_value", "rating_value",
              "text_value", "text_result", "checklist_item_state",
              "or_variant_value", "fixed_outcome"
            ) = 0)
        OR ("actual_time_value" IS NOT NULL
            AND "actual_time_value" < TIME '24:00'
            AND num_nonnulls(
              "boolean_result", "quantity_value", "rating_value",
              "text_value", "text_result", "checklist_item_state",
              "or_variant_value", "fixed_outcome"
            ) = 0)
        OR ("rating_value" IS NOT NULL
            AND num_nonnulls(
              "boolean_result", "quantity_value", "actual_time_value",
              "text_value", "text_result", "checklist_item_state",
              "or_variant_value", "fixed_outcome"
            ) = 0)
        OR ("text_value" IS NOT NULL
            AND t03_text_is_nonempty("text_value")
            AND "text_result" IS NOT NULL
            AND "text_result" IN ('done', 'not_done')
            AND num_nonnulls(
              "boolean_result", "quantity_value", "actual_time_value",
              "rating_value", "checklist_item_state", "or_variant_value",
              "fixed_outcome"
            ) = 0)
        OR ("checklist_item_state" IS NOT NULL
            AND "checklist_item_state" IN ('done', 'not_done')
            AND num_nonnulls(
              "boolean_result", "quantity_value", "actual_time_value",
              "rating_value", "text_value", "text_result",
              "or_variant_value", "fixed_outcome"
            ) = 0)
        OR ("or_variant_value" IS NOT NULL
            AND "or_variant_value" ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
            AND num_nonnulls(
              "boolean_result", "quantity_value", "actual_time_value",
              "rating_value", "text_value", "text_result",
              "checklist_item_state", "fixed_outcome"
            ) = 0)
        OR ("fixed_outcome" IS NOT NULL
            AND "fixed_outcome" = 'not_done'
            AND num_nonnulls(
              "boolean_result", "quantity_value", "actual_time_value",
              "rating_value", "text_value", "text_result",
              "checklist_item_state", "or_variant_value"
            ) = 0)
      )
    ) OR (
      "revision_kind" = 'tombstoned'
      AND num_nonnulls(
        "boolean_result", "quantity_value", "actual_time_value",
        "rating_value", "text_value", "text_result",
        "checklist_item_state", "or_variant_value", "fixed_outcome"
      ) = 0
    )
  );

ALTER TABLE "tracking_action_groups"
  ALTER COLUMN "plan_goal_snapshot_id" DROP NOT NULL,
  DROP CONSTRAINT "tracking_action_groups_action_check",
  ADD CONSTRAINT "tracking_action_groups_action_check" CHECK (
    "action_kind" IN (
      'fact_recorded', 'fact_corrected', 'fact_tombstoned', 'fact_undone',
      'day_closed'
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
      'tracking.undo-last-own-action.v1',
      'tracking.close-day.v1'
    )
  ),
  DROP CONSTRAINT "tracking_action_groups_reason_check",
  ADD CONSTRAINT "tracking_action_groups_reason_check" CHECK (
    (
      "action_kind" IN ('fact_recorded', 'fact_undone', 'day_closed')
      AND "reason" IS NULL
    )
    OR (
      "action_kind" IN ('fact_corrected', 'fact_tombstoned')
      AND "reason" IS NOT NULL
      AND length("reason") <= 2000
      AND t03_text_is_nonempty("reason")
    )
  );

ALTER TABLE "tracking_fact_changes"
  DROP CONSTRAINT "tracking_fact_changes_pkey",
  ADD CONSTRAINT "tracking_fact_changes_pkey"
    PRIMARY KEY ("action_id", "fact_record_id");

CREATE TABLE "tracking_day_closures" (
  "action_id" UUID NOT NULL,
  "publication_id" UUID NOT NULL,
  "local_date" DATE NOT NULL,
  "member_id" UUID NOT NULL,
  "preview_schema_version" VARCHAR(100) NOT NULL,
  "preview_hash_version" VARCHAR(100) NOT NULL,
  "preview_hash" CHAR(64) NOT NULL,
  "expectation_ids" UUID[] NOT NULL,
  "closed_count" INTEGER NOT NULL,

  CONSTRAINT "tracking_day_closures_pkey" PRIMARY KEY ("action_id"),
  CONSTRAINT "tracking_day_closures_target_key"
    UNIQUE ("publication_id", "local_date", "member_id"),
  CONSTRAINT "tracking_day_closures_count_check" CHECK (
    "closed_count" BETWEEN 0 AND 10000
    AND "closed_count" = cardinality("expectation_ids")
  ),
  CONSTRAINT "tracking_day_closures_preview_check" CHECK (
    "preview_schema_version" = 'tracking.close-day-preview.v1'
    AND "preview_hash_version" = 'tracking.close-day-preview-hash.v1'
    AND "preview_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "tracking_day_closures_action_fkey"
    FOREIGN KEY ("action_id") REFERENCES "tracking_action_groups"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "tracking_day_closures_publication_fkey"
    FOREIGN KEY ("publication_id") REFERENCES "plan_publications"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "tracking_day_closures_member_fkey"
    FOREIGN KEY ("member_id") REFERENCES "memberships"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TRIGGER "tracking_day_closures_reject_update_delete"
BEFORE UPDATE OR DELETE ON "tracking_day_closures"
FOR EACH ROW EXECUTE FUNCTION "reject_p01_immutable_row_change"();

CREATE FUNCTION "t08_fact_record_has_exact_shape"(target_record UUID)
RETURNS BOOLEAN AS $$
DECLARE
  record_value tracking_fact_records%ROWTYPE;
  revision_value tracking_fact_revisions%ROWTYPE;
  fixed_value fixed_expectations%ROWTYPE;
  snapshot_value plan_goal_snapshots%ROWTYPE;
  publication_value plan_publications%ROWTYPE;
  month_value plan_months%ROWTYPE;
  revision_count BIGINT;
BEGIN
  SELECT * INTO record_value FROM tracking_fact_records WHERE id = target_record;
  SELECT * INTO revision_value FROM tracking_fact_revisions
   WHERE id = record_value.current_revision_id;
  SELECT * INTO fixed_value FROM fixed_expectations
   WHERE id = record_value.fixed_expectation_id;
  SELECT * INTO snapshot_value FROM plan_goal_snapshots
   WHERE id = record_value.plan_goal_snapshot_id;
  SELECT * INTO publication_value FROM plan_publications
   WHERE id = record_value.publication_id;
  SELECT * INTO month_value FROM plan_months WHERE id = record_value.plan_month_id;
  SELECT count(*) INTO revision_count FROM tracking_fact_revisions
   WHERE fact_record_id = target_record;

  RETURN (
    record_value.id IS NOT NULL
    AND record_value.fact_kind = 'fixed_not_done'
    AND record_value.flexible_period_id IS NULL
    AND record_value.contribution_id IS NULL
    AND record_value.checklist_item_id IS NULL
    AND record_value.or_variant_id IS NULL
    AND fixed_value.id = record_value.fixed_expectation_id
    AND fixed_value.publication_id = record_value.publication_id
    AND fixed_value.plan_goal_snapshot_id = record_value.plan_goal_snapshot_id
    AND fixed_value.expectation_date = record_value.local_date
    AND snapshot_value.id = record_value.plan_goal_snapshot_id
    AND snapshot_value.publication_id = record_value.publication_id
    AND snapshot_value.space_id = record_value.space_id
    AND publication_value.id = record_value.publication_id
    AND publication_value.plan_month_id = record_value.plan_month_id
    AND publication_value.space_id = record_value.space_id
    AND month_value.id = record_value.plan_month_id
    AND month_value.space_id = record_value.space_id
    AND month_value.active_publication_id = record_value.publication_id
    AND month_value.status IN ('published', 'grace')
    AND record_value.local_date >= publication_value.active_local_date
    AND record_value.local_date >= month_value.month_start
    AND record_value.local_date <
        (month_value.month_start + INTERVAL '1 month')::date
    AND revision_count = 1
    AND revision_value.id = record_value.current_revision_id
    AND revision_value.fact_record_id = record_value.id
    AND revision_value.revision_number = 1
    AND revision_value.revision_kind = 'recorded'
    AND revision_value.fixed_outcome = 'not_done'
    AND revision_value.recorded_by_member_id = record_value.created_by_member_id
    AND revision_value.created_at = record_value.created_at
    AND record_value.updated_at = revision_value.created_at
  ) IS TRUE;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION "t01_fact_record_has_exact_shape"(target_record UUID)
RETURNS BOOLEAN AS $$
DECLARE
  kind_value TEXT;
BEGIN
  SELECT fact_kind INTO kind_value FROM tracking_fact_records
   WHERE id = target_record;
  IF kind_value = 'fixed_not_done' THEN
    RETURN t08_fact_record_has_exact_shape(target_record);
  END IF;
  RETURN t06_fact_record_has_exact_shape_dispatch(target_record);
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION "t08_action_has_exact_shape"(target_action UUID)
RETURNS BOOLEAN AS $$
DECLARE
  action_value tracking_action_groups%ROWTYPE;
  detail_value tracking_day_closures%ROWTYPE;
  month_value plan_months%ROWTYPE;
  publication_value plan_publications%ROWTYPE;
  receipt_value command_receipts%ROWTYPE;
  change_count BIGINT;
  ordered_ids UUID[];
BEGIN
  SELECT * INTO action_value FROM tracking_action_groups
   WHERE id = target_action;
  SELECT * INTO detail_value FROM tracking_day_closures
   WHERE action_id = target_action;
  SELECT * INTO month_value FROM plan_months
   WHERE id = action_value.plan_month_id;
  SELECT * INTO publication_value FROM plan_publications
   WHERE id = action_value.publication_id;
  SELECT * INTO receipt_value FROM command_receipts
   WHERE actor_scope = action_value.actor_scope
     AND command_type = action_value.command_type
     AND command_id = action_value.command_id;
  SELECT count(*) INTO change_count FROM tracking_fact_changes
   WHERE action_id = target_action;
  SELECT COALESCE(array_agg(change_record.fixed_expectation_id ORDER BY
             snapshot.display_order,
             CASE expectation.component_kind
               WHEN 'goal' THEN 0
               WHEN 'checkpoint' THEN 1
               ELSE 2
             END,
             expectation.component_id NULLS FIRST, expectation.id), ARRAY[]::uuid[])
    INTO ordered_ids
    FROM tracking_fact_changes change
    JOIN tracking_fact_records change_record
      ON change_record.id = change.fact_record_id
    JOIN fixed_expectations expectation
      ON expectation.id = change_record.fixed_expectation_id
    JOIN plan_goal_snapshots snapshot
      ON snapshot.id = expectation.plan_goal_snapshot_id
   WHERE change.action_id = target_action;

  RETURN (
    action_value.id IS NOT NULL
    AND action_value.action_kind = 'day_closed'
    AND action_value.command_type = 'tracking.close-day.v1'
    AND action_value.actor_kind = 'member'
    AND action_value.actor_scope = 'member:' || action_value.member_id::text
    AND action_value.plan_goal_snapshot_id IS NULL
    AND action_value.reason IS NULL
    AND action_value.before_facts_revision >= 0
    AND action_value.after_facts_revision = action_value.before_facts_revision + 1
    AND detail_value.action_id = action_value.id
    AND detail_value.publication_id = action_value.publication_id
    AND detail_value.member_id = action_value.member_id
    AND detail_value.closed_count = change_count
    AND detail_value.expectation_ids = ordered_ids
    AND cardinality(detail_value.expectation_ids) = (
      SELECT count(DISTINCT value) FROM unnest(detail_value.expectation_ids) value
    )
    AND month_value.id = action_value.plan_month_id
    AND month_value.space_id = action_value.space_id
    AND month_value.facts_revision = action_value.after_facts_revision
    AND month_value.status IN ('published', 'grace')
    AND month_value.active_publication_id = action_value.publication_id
    AND publication_value.id = action_value.publication_id
    AND publication_value.plan_month_id = action_value.plan_month_id
    AND publication_value.space_id = action_value.space_id
    AND detail_value.local_date >= publication_value.active_local_date
    AND detail_value.local_date >= month_value.month_start
    AND detail_value.local_date <
        (month_value.month_start + INTERVAL '1 month')::date
    AND detail_value.local_date <= (
      action_value.occurred_at AT TIME ZONE 'Asia/Yekaterinburg'
    )::date
    AND (action_value.occurred_at AT TIME ZONE 'Asia/Yekaterinburg')::date
        <= (month_value.month_start + INTERVAL '1 month + 2 days')::date
    AND NOT EXISTS (
      SELECT 1
        FROM tracking_fact_changes change
        JOIN tracking_fact_records record_value
          ON record_value.id = change.fact_record_id
        JOIN tracking_fact_revisions revision_value
          ON revision_value.id = change.after_revision_id
        JOIN fixed_expectations expectation
          ON expectation.id = record_value.fixed_expectation_id
        JOIN plan_goal_snapshots snapshot
          ON snapshot.id = record_value.plan_goal_snapshot_id
       WHERE change.action_id = action_value.id
         AND NOT (
           change.before_revision_id IS NULL
           AND record_value.fact_kind = 'fixed_not_done'
           AND record_value.space_id = action_value.space_id
           AND record_value.plan_month_id = action_value.plan_month_id
           AND record_value.publication_id = action_value.publication_id
           AND record_value.local_date = detail_value.local_date
           AND record_value.current_revision_id = revision_value.id
           AND record_value.created_by_member_id = action_value.member_id
           AND record_value.created_at = action_value.occurred_at
           AND record_value.updated_at = action_value.occurred_at
           AND revision_value.fact_record_id = record_value.id
           AND revision_value.revision_number = 1
           AND revision_value.revision_kind = 'recorded'
           AND revision_value.fixed_outcome = 'not_done'
           AND revision_value.recorded_by_member_id = action_value.member_id
           AND revision_value.created_at = action_value.occurred_at
           AND expectation.publication_id = action_value.publication_id
           AND expectation.expectation_date = detail_value.local_date
           AND snapshot.publication_id = action_value.publication_id
           AND (snapshot.scope_kind = 'shared'
                OR snapshot.owner_member_id = action_value.member_id)
           AND NOT EXISTS (
             SELECT 1
               FROM tracking_fact_records other_record
               JOIN tracking_fact_revisions other_revision
                 ON other_revision.id = other_record.current_revision_id
              WHERE other_record.fixed_expectation_id = expectation.id
                AND other_record.id <> record_value.id
                AND other_revision.revision_kind = 'recorded'
           )
           AND t08_fact_record_has_exact_shape(record_value.id)
         )
    )
    AND NOT EXISTS (
      SELECT 1
        FROM fixed_expectations expectation
        JOIN plan_goal_snapshots snapshot
          ON snapshot.publication_id = expectation.publication_id
         AND snapshot.id = expectation.plan_goal_snapshot_id
       WHERE expectation.publication_id = action_value.publication_id
         AND expectation.expectation_date = detail_value.local_date
         AND (snapshot.scope_kind = 'shared'
              OR snapshot.owner_member_id = action_value.member_id)
         AND NOT EXISTS (
           SELECT 1
             FROM tracking_fact_records record_value
             JOIN tracking_fact_revisions revision_value
               ON revision_value.id = record_value.current_revision_id
            WHERE record_value.fixed_expectation_id = expectation.id
              AND revision_value.revision_kind = 'recorded'
         )
    )
    AND receipt_value.command_type = 'tracking.close-day.v1'
    AND receipt_value.result_kind = 'tracking.day-close.v1'
    AND receipt_value.aggregate_id = action_value.id
    AND receipt_value.aggregate_revision = action_value.after_facts_revision
    AND receipt_value.completed_at = action_value.occurred_at
  ) IS TRUE;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION "t01_action_has_exact_shape"(target_action UUID)
RETURNS BOOLEAN AS $$
DECLARE
  type_value TEXT;
  change_count BIGINT;
BEGIN
  SELECT command_type INTO type_value FROM tracking_action_groups
   WHERE id = target_action;
  IF type_value = 'tracking.close-day.v1' THEN
    RETURN t08_action_has_exact_shape(target_action);
  END IF;
  SELECT count(*) INTO change_count FROM tracking_fact_changes
   WHERE action_id = target_action;
  RETURN change_count = 1
    AND t06_action_has_exact_shape_dispatch(target_action);
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
    RAISE EXCEPTION 'tracking command cannot append this correction'
      USING ERRCODE = '23514';
  END IF;
  IF command_value = 'tracking.close-day.v1'
     AND NEW.before_revision_id IS NOT NULL THEN
    RAISE EXCEPTION 'CloseDay must create generic marker records'
      USING ERRCODE = '23514';
  END IF;
  IF t01_action_has_exact_shape(NEW.action_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'tracking fact change effect mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "require_t01_action_detail"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.command_type <> 'tracking.close-day.v1'
     AND NOT EXISTS (
       SELECT 1 FROM tracking_fact_changes WHERE action_id = NEW.id
     ) THEN
    RAISE EXCEPTION 'tracking action requires fact change'
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
      'tracking.undo-last-own-action.v1', 'tracking.close-day.v1'
    ) OR NEW.result_kind IN (
      'tracking.fact-record.v1', 'tracking.day-close.v1'
    )
  ) AND NOT (
    (
      (
        NEW.command_type IN (
          'tracking.record-fact.v1', 'tracking.record-time.v1',
          'tracking.record-rating.v1', 'tracking.record-checkpoint.v1',
          'tracking.record-text.v1', 'tracking.record-checklist-item.v1',
          'tracking.record-or-variant.v1',
          'tracking.record-composite-occurrence.v1',
          'tracking.correct-record.v1', 'tracking.delete-record.v1',
          'tracking.undo-last-own-action.v1'
        ) AND NEW.result_kind = 'tracking.fact-record.v1'
      ) OR (
        NEW.command_type = 'tracking.close-day.v1'
        AND NEW.result_kind = 'tracking.day-close.v1'
      )
    ) AND EXISTS (
      SELECT 1 FROM tracking_action_groups action
       WHERE action.actor_scope = NEW.actor_scope
         AND action.command_type = NEW.command_type
         AND action.command_id = NEW.command_id
         AND t01_action_has_exact_shape(action.id)
    )
  ) THEN
    RAISE EXCEPTION 'tracking receipt requires exact effect'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "require_t08_close_detail"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.command_type = 'tracking.close-day.v1'
     AND NOT EXISTS (
       SELECT 1 FROM tracking_day_closures detail
        WHERE detail.action_id = NEW.id
     ) THEN
    RAISE EXCEPTION 'CloseDay action requires closure detail'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "tracking_action_requires_day_closure"
AFTER INSERT ON "tracking_action_groups"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_t08_close_detail"();

CREATE FUNCTION "require_t08_close_effect"()
RETURNS TRIGGER AS $$
BEGIN
  IF t08_action_has_exact_shape(NEW.action_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'CloseDay effect mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "tracking_day_closure_effect_consistent"
AFTER INSERT ON "tracking_day_closures"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_t08_close_effect"();
