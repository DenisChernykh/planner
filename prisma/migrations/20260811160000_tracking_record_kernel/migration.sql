-- T01 stores Boolean and quantity facts as typed append-only records.
LOCK TABLE spaces, memberships, plan_months, plan_publications,
  plan_goal_snapshots, fixed_expectations, flexible_periods,
  command_receipts IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM command_receipts
     WHERE command_type = 'tracking.record-fact.v1'
        OR result_kind = 'tracking.fact-record.v1'
  ) THEN
    RAISE EXCEPTION 'T01 cannot adopt pre-existing tracking receipts'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM plan_months WHERE facts_revision <> 0) THEN
    RAISE EXCEPTION 'T01 cannot adopt unexplained facts revisions'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE TABLE "tracking_fact_records" (
  "id" UUID NOT NULL,
  "space_id" UUID NOT NULL,
  "plan_month_id" UUID NOT NULL,
  "publication_id" UUID NOT NULL,
  "plan_goal_snapshot_id" UUID NOT NULL,
  "local_date" DATE NOT NULL,
  "fact_kind" VARCHAR(24) NOT NULL,
  "fixed_expectation_id" UUID,
  "flexible_period_id" UUID,
  "contribution_id" UUID,
  "current_revision_id" UUID,
  "created_by_member_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "tracking_fact_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tracking_fact_records_id_space_key" UNIQUE ("id", "space_id"),
  CONSTRAINT "tracking_fact_records_id_current_key"
    UNIQUE ("id", "current_revision_id"),
  CONSTRAINT "tracking_fact_records_contribution_key"
    UNIQUE ("contribution_id"),
  CONSTRAINT "tracking_fact_records_kind_check" CHECK (
    "fact_kind" IN ('boolean', 'quantity_add', 'quantity_latest')
  ),
  CONSTRAINT "tracking_fact_records_calendar_check" CHECK (
    ("fixed_expectation_id" IS NOT NULL AND "flexible_period_id" IS NULL)
    OR ("fixed_expectation_id" IS NULL AND "flexible_period_id" IS NOT NULL)
  ),
  CONSTRAINT "tracking_fact_records_contribution_check" CHECK (
    ("fact_kind" = 'quantity_add' AND "contribution_id" IS NOT NULL)
    OR ("fact_kind" <> 'quantity_add' AND "contribution_id" IS NULL)
  ),
  CONSTRAINT "tracking_fact_records_time_check"
    CHECK ("updated_at" >= "created_at"),
  CONSTRAINT "tracking_fact_records_space_fkey"
    FOREIGN KEY ("space_id") REFERENCES "spaces"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "tracking_fact_records_month_fkey"
    FOREIGN KEY ("space_id", "plan_month_id")
    REFERENCES "plan_months"("space_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "tracking_fact_records_publication_fkey"
    FOREIGN KEY ("plan_month_id", "publication_id")
    REFERENCES "plan_publications"("plan_month_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "tracking_fact_records_snapshot_fkey"
    FOREIGN KEY ("publication_id", "plan_goal_snapshot_id")
    REFERENCES "plan_goal_snapshots"("publication_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "tracking_fact_records_fixed_expectation_fkey"
    FOREIGN KEY ("fixed_expectation_id") REFERENCES "fixed_expectations"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "tracking_fact_records_flexible_period_fkey"
    FOREIGN KEY ("flexible_period_id") REFERENCES "flexible_periods"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "tracking_fact_records_creator_fkey"
    FOREIGN KEY ("space_id", "created_by_member_id")
    REFERENCES "memberships"("space_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "tracking_fact_records_single_value_key"
  ON "tracking_fact_records"(
    "publication_id", "plan_goal_snapshot_id", "local_date"
  ) WHERE "fact_kind" IN ('boolean', 'quantity_latest');
CREATE INDEX "tracking_fact_records_target_idx"
  ON "tracking_fact_records"(
    "publication_id", "plan_goal_snapshot_id", "local_date", "created_at", "id"
  );

CREATE TABLE "tracking_fact_revisions" (
  "id" UUID NOT NULL,
  "fact_record_id" UUID NOT NULL,
  "revision_number" BIGINT NOT NULL,
  "revision_kind" VARCHAR(16) NOT NULL,
  "boolean_result" VARCHAR(16),
  "quantity_value" TEXT,
  "recorded_by_member_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "tracking_fact_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tracking_fact_revisions_record_number_key"
    UNIQUE ("fact_record_id", "revision_number"),
  CONSTRAINT "tracking_fact_revisions_record_id_key"
    UNIQUE ("fact_record_id", "id"),
  CONSTRAINT "tracking_fact_revisions_number_check"
    CHECK ("revision_number" >= 1),
  CONSTRAINT "tracking_fact_revisions_kind_check"
    CHECK ("revision_kind" IN ('recorded', 'tombstoned')),
  CONSTRAINT "tracking_fact_revisions_value_check" CHECK (
    (
      "revision_kind" = 'recorded'
      AND (
        ("boolean_result" IN ('done', 'not_done') AND "quantity_value" IS NULL)
        OR (
          "boolean_result" IS NULL
          AND "quantity_value" ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
        )
      )
    ) OR (
      "revision_kind" = 'tombstoned'
      AND "boolean_result" IS NULL
      AND "quantity_value" IS NULL
    )
  ),
  CONSTRAINT "tracking_fact_revisions_record_fkey"
    FOREIGN KEY ("fact_record_id") REFERENCES "tracking_fact_records"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "tracking_fact_revisions_actor_fkey"
    FOREIGN KEY ("recorded_by_member_id") REFERENCES "memberships"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

ALTER TABLE "tracking_fact_records"
  ADD CONSTRAINT "tracking_fact_records_current_revision_fkey"
  FOREIGN KEY ("id", "current_revision_id")
  REFERENCES "tracking_fact_revisions"("fact_record_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "tracking_action_groups" (
  "id" UUID NOT NULL,
  "action_kind" VARCHAR(32) NOT NULL,
  "actor_kind" VARCHAR(16) NOT NULL,
  "actor_scope" VARCHAR(64) NOT NULL,
  "member_id" UUID NOT NULL,
  "space_id" UUID NOT NULL,
  "plan_month_id" UUID NOT NULL,
  "publication_id" UUID NOT NULL,
  "plan_goal_snapshot_id" UUID NOT NULL,
  "command_type" VARCHAR(128) NOT NULL,
  "command_id" UUID NOT NULL,
  "before_facts_revision" BIGINT NOT NULL,
  "after_facts_revision" BIGINT NOT NULL,
  "occurred_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "tracking_action_groups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tracking_action_groups_action_check"
    CHECK ("action_kind" = 'fact_recorded'),
  CONSTRAINT "tracking_action_groups_actor_check" CHECK (
    "actor_kind" = 'member'
    AND "actor_scope" = 'member:' || "member_id"::text
  ),
  CONSTRAINT "tracking_action_groups_command_check"
    CHECK ("command_type" = 'tracking.record-fact.v1'),
  CONSTRAINT "tracking_action_groups_facts_revision_check" CHECK (
    "before_facts_revision" >= 0
    AND "after_facts_revision" = "before_facts_revision" + 1
  ),
  CONSTRAINT "tracking_action_groups_command_key"
    UNIQUE ("actor_scope", "command_type", "command_id"),
  CONSTRAINT "tracking_action_groups_month_facts_revision_key"
    UNIQUE ("plan_month_id", "after_facts_revision"),
  CONSTRAINT "tracking_action_groups_member_fkey"
    FOREIGN KEY ("space_id", "member_id")
    REFERENCES "memberships"("space_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "tracking_action_groups_space_fkey"
    FOREIGN KEY ("space_id") REFERENCES "spaces"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "tracking_action_groups_month_fkey"
    FOREIGN KEY ("space_id", "plan_month_id")
    REFERENCES "plan_months"("space_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "tracking_action_groups_publication_fkey"
    FOREIGN KEY ("plan_month_id", "publication_id")
    REFERENCES "plan_publications"("plan_month_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "tracking_action_groups_snapshot_fkey"
    FOREIGN KEY ("publication_id", "plan_goal_snapshot_id")
    REFERENCES "plan_goal_snapshots"("publication_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "tracking_action_groups_receipt_fkey"
    FOREIGN KEY ("actor_scope", "command_type", "command_id")
    REFERENCES "command_receipts"("actor_scope", "command_type", "command_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE "tracking_fact_changes" (
  "action_id" UUID NOT NULL,
  "fact_record_id" UUID NOT NULL,
  "before_revision_id" UUID,
  "after_revision_id" UUID NOT NULL,

  CONSTRAINT "tracking_fact_changes_pkey" PRIMARY KEY ("action_id"),
  CONSTRAINT "tracking_fact_changes_after_revision_key"
    UNIQUE ("after_revision_id"),
  CONSTRAINT "tracking_fact_changes_action_fkey"
    FOREIGN KEY ("action_id") REFERENCES "tracking_action_groups"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "tracking_fact_changes_record_fkey"
    FOREIGN KEY ("fact_record_id") REFERENCES "tracking_fact_records"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "tracking_fact_changes_before_revision_fkey"
    FOREIGN KEY ("fact_record_id", "before_revision_id")
    REFERENCES "tracking_fact_revisions"("fact_record_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "tracking_fact_changes_after_revision_fkey"
    FOREIGN KEY ("fact_record_id", "after_revision_id")
    REFERENCES "tracking_fact_revisions"("fact_record_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE FUNCTION "guard_t01_fact_record"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tracking_fact_records cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.id <> OLD.id OR NEW.space_id <> OLD.space_id
     OR NEW.plan_month_id <> OLD.plan_month_id
     OR NEW.publication_id <> OLD.publication_id
     OR NEW.plan_goal_snapshot_id <> OLD.plan_goal_snapshot_id
     OR NEW.local_date <> OLD.local_date OR NEW.fact_kind <> OLD.fact_kind
     OR NEW.fixed_expectation_id IS DISTINCT FROM OLD.fixed_expectation_id
     OR NEW.flexible_period_id IS DISTINCT FROM OLD.flexible_period_id
     OR NEW.contribution_id IS DISTINCT FROM OLD.contribution_id
     OR NEW.created_by_member_id <> OLD.created_by_member_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'tracking_fact_records identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tracking_fact_records_guard_update_delete"
BEFORE UPDATE OR DELETE ON "tracking_fact_records"
FOR EACH ROW EXECUTE FUNCTION "guard_t01_fact_record"();

CREATE TRIGGER "tracking_fact_revisions_reject_update_delete"
BEFORE UPDATE OR DELETE ON "tracking_fact_revisions"
FOR EACH ROW EXECUTE FUNCTION "reject_p01_immutable_row_change"();
CREATE TRIGGER "tracking_action_groups_reject_update_delete"
BEFORE UPDATE OR DELETE ON "tracking_action_groups"
FOR EACH ROW EXECUTE FUNCTION "reject_p01_immutable_row_change"();
CREATE TRIGGER "tracking_fact_changes_reject_update_delete"
BEFORE UPDATE OR DELETE ON "tracking_fact_changes"
FOR EACH ROW EXECUTE FUNCTION "reject_p01_immutable_row_change"();

CREATE FUNCTION "guard_t01_facts_revision_update"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.facts_revision IS DISTINCT FROM OLD.facts_revision THEN
    IF NEW.facts_revision <> OLD.facts_revision + 1
       OR NEW.id <> OLD.id OR NEW.space_id <> OLD.space_id
       OR NEW.month_start <> OLD.month_start OR NEW.status <> OLD.status
       OR NEW.revision <> OLD.revision
       OR NEW.active_publication_id IS DISTINCT FROM OLD.active_publication_id
       OR NEW.created_at <> OLD.created_at OR NEW.updated_at <> OLD.updated_at THEN
      RAISE EXCEPTION 'facts_revision requires one isolated tracking increment'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "plan_months_guard_facts_revision_update"
BEFORE UPDATE ON "plan_months"
FOR EACH ROW EXECUTE FUNCTION "guard_t01_facts_revision_update"();

CREATE FUNCTION "t01_fact_record_has_exact_shape"(target_record UUID)
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
  measurement_kind TEXT;
  aggregation_kind TEXT;
  precision_value INTEGER;
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
  measurement_kind := snapshot_value.config #>> '{measurement,kind}';
  aggregation_kind := snapshot_value.config #>> '{measurement,aggregation}';
  precision_value := NULLIF(snapshot_value.config #>> '{measurement,precision}', '')::integer;

  IF record_value.id IS NULL OR current_value.id IS NULL
     OR snapshot_value.id IS NULL OR publication_value.id IS NULL
     OR month_value.id IS NULL OR record_value.space_id <> snapshot_value.space_id
     OR record_value.plan_month_id <> snapshot_value.plan_month_id
     OR record_value.publication_id <> snapshot_value.publication_id
     OR publication_value.plan_month_id <> record_value.plan_month_id
     OR publication_value.space_id <> record_value.space_id
     OR month_value.space_id <> record_value.space_id
     OR month_value.active_publication_id <> publication_value.id
     OR month_value.status NOT IN ('published', 'grace')
     OR record_value.local_date < publication_value.active_local_date
     OR record_value.local_date < month_value.month_start
     OR record_value.local_date >= (month_value.month_start + INTERVAL '1 month')::date
     OR snapshot_value.config -> 'checkpoints' <> 'null'::jsonb
     OR snapshot_value.config #>> '{repetition,kind}' = 'weekly_planned_task'
     OR current_value.fact_record_id <> record_value.id
     OR current_value.revision_number <> maximum_revision
     OR revision_count <> maximum_revision
     OR current_value.revision_kind <> 'recorded'
     OR record_value.updated_at <> current_value.created_at THEN
    RETURN FALSE;
  END IF;

  IF record_value.fixed_expectation_id IS NOT NULL THEN
    IF fixed_value.id IS NULL OR fixed_value.publication_id <> record_value.publication_id
       OR fixed_value.plan_goal_snapshot_id <> record_value.plan_goal_snapshot_id
       OR fixed_value.expectation_date <> record_value.local_date
       OR fixed_value.component_kind <> 'goal' OR fixed_value.component_id IS NOT NULL THEN
      RETURN FALSE;
    END IF;
  ELSE
    IF period_value.id IS NULL OR period_value.publication_id <> record_value.publication_id
       OR period_value.plan_goal_snapshot_id <> record_value.plan_goal_snapshot_id
       OR period_value.period_target <= 0
       OR NOT (record_value.local_date = ANY(period_value.eligible_dates)) THEN
      RETURN FALSE;
    END IF;
  END IF;

  IF record_value.fact_kind = 'boolean' THEN
    IF measurement_kind <> 'boolean' OR current_value.boolean_result IS NULL
       OR current_value.quantity_value IS NOT NULL THEN RETURN FALSE; END IF;
  ELSIF record_value.fact_kind = 'quantity_add' THEN
    IF measurement_kind <> 'quantity' OR aggregation_kind <> 'add'
       OR record_value.contribution_id IS NULL THEN RETURN FALSE; END IF;
  ELSIF record_value.fact_kind = 'quantity_latest' THEN
    IF measurement_kind <> 'quantity' OR aggregation_kind <> 'latest'
       OR record_value.contribution_id IS NOT NULL THEN RETURN FALSE; END IF;
  ELSE
    RETURN FALSE;
  END IF;

  IF record_value.fact_kind IN ('quantity_add', 'quantity_latest') AND EXISTS (
    SELECT 1 FROM tracking_fact_revisions revision
     WHERE revision.fact_record_id = target_record
       AND revision.revision_kind = 'recorded'
       AND (
         revision.boolean_result IS NOT NULL OR revision.quantity_value IS NULL
         OR revision.quantity_value !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
         OR CASE WHEN strpos(revision.quantity_value, '.') = 0 THEN 0
                 ELSE length(split_part(revision.quantity_value, '.', 2)) END
              > precision_value
       )
  ) THEN RETURN FALSE; END IF;
  IF record_value.fact_kind = 'boolean' AND EXISTS (
    SELECT 1 FROM tracking_fact_revisions revision
     WHERE revision.fact_record_id = target_record
       AND revision.revision_kind = 'recorded'
       AND (revision.boolean_result NOT IN ('done', 'not_done')
            OR revision.quantity_value IS NOT NULL)
  ) THEN RETURN FALSE; END IF;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION "t01_action_has_exact_shape"(target_action UUID)
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
  SELECT * INTO record_value FROM tracking_fact_records WHERE id = change_value.fact_record_id;
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
    AND action_value.action_kind = 'fact_recorded'
    AND action_value.actor_kind = 'member'
    AND action_value.actor_scope = 'member:' || action_value.member_id::text
    AND action_value.command_type = 'tracking.record-fact.v1'
    AND action_value.before_facts_revision >= 0
    AND action_value.after_facts_revision = action_value.before_facts_revision + 1
    AND month_value.id = action_value.plan_month_id
    AND month_value.facts_revision = action_value.after_facts_revision
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
    AND after_value.fact_record_id = record_value.id
    AND after_value.recorded_by_member_id = action_value.member_id
    AND after_value.created_at = action_value.occurred_at
    AND after_value.revision_kind = 'recorded'
    AND (
      (change_value.before_revision_id IS NULL
       AND after_value.revision_number = 1
       AND record_value.created_by_member_id = action_value.member_id
       AND record_value.created_at = action_value.occurred_at)
      OR
      (change_value.before_revision_id IS NOT NULL
       AND before_value.fact_record_id = record_value.id
       AND after_value.revision_number = before_value.revision_number + 1)
    )
    AND (record_value.fact_kind <> 'quantity_add'
         OR change_value.before_revision_id IS NULL)
    AND (snapshot_value.scope_kind = 'shared'
         OR snapshot_value.owner_member_id = action_value.member_id)
    AND receipt_value.result_kind = 'tracking.fact-record.v1'
    AND receipt_value.aggregate_id = record_value.id
    AND receipt_value.aggregate_revision = after_value.revision_number
    AND receipt_value.completed_at = action_value.occurred_at
    AND t01_fact_record_has_exact_shape(record_value.id)
  ) IS TRUE;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION "require_t01_fact_change_effect"()
RETURNS TRIGGER AS $$
BEGIN
  IF t01_action_has_exact_shape(NEW.action_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'tracking fact change effect mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "tracking_fact_changes_effect_consistent"
AFTER INSERT ON "tracking_fact_changes"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_t01_fact_change_effect"();

CREATE FUNCTION "require_t01_action_detail"()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM tracking_fact_changes WHERE action_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'tracking action requires fact change'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "tracking_action_requires_fact_change"
AFTER INSERT ON "tracking_action_groups"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_t01_action_detail"();

CREATE FUNCTION "require_t01_receipt_effect"()
RETURNS TRIGGER AS $$
BEGIN
  IF (NEW.command_type = 'tracking.record-fact.v1'
      OR NEW.result_kind = 'tracking.fact-record.v1') AND NOT (
    NEW.command_type = 'tracking.record-fact.v1'
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
CREATE CONSTRAINT TRIGGER "command_receipts_tracking_effect_consistent"
AFTER INSERT ON "command_receipts"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_t01_receipt_effect"();

CREATE FUNCTION "require_t01_revision_change"()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM tracking_fact_changes change
     WHERE change.after_revision_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'tracking revision requires fact change'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "tracking_fact_revision_requires_change"
AFTER INSERT ON "tracking_fact_revisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_t01_revision_change"();

CREATE FUNCTION "require_t01_record_effect"()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM tracking_fact_changes change
    JOIN tracking_fact_records current_record
      ON current_record.id = change.fact_record_id
     WHERE change.fact_record_id = NEW.id
       AND change.after_revision_id = current_record.current_revision_id
       AND t01_fact_record_has_exact_shape(current_record.id)
  ) THEN
    RAISE EXCEPTION 'tracking record requires exact current effect'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "tracking_fact_record_effect_consistent"
AFTER INSERT OR UPDATE ON "tracking_fact_records"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_t01_record_effect"();

CREATE FUNCTION "require_t01_facts_revision_effect"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.facts_revision IS DISTINCT FROM OLD.facts_revision AND NOT EXISTS (
    SELECT 1 FROM tracking_action_groups action
     WHERE action.plan_month_id = NEW.id
       AND action.before_facts_revision = OLD.facts_revision
       AND action.after_facts_revision = NEW.facts_revision
       AND t01_action_has_exact_shape(action.id)
  ) THEN
    RAISE EXCEPTION 'facts revision requires exact tracking action'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "plan_months_facts_revision_effect_consistent"
AFTER UPDATE OF "facts_revision" ON "plan_months"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_t01_facts_revision_effect"();
