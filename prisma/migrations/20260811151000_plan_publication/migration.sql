BEGIN;

LOCK TABLE plan_months, command_receipts IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM plan_months WHERE status <> 'draft'
  ) OR EXISTS (
    SELECT 1 FROM command_receipts
     WHERE command_type = 'planning.publish-month.v1'
        OR result_kind = 'planning.plan-publication.v1'
  ) THEN
    RAISE EXCEPTION
      'P07 requires every pre-publication plan month to remain draft; immutable publication history cannot be backfilled'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE "plan_months"
  ADD COLUMN "active_publication_id" UUID;

CREATE TABLE "plan_publications" (
  "id" UUID NOT NULL,
  "space_id" UUID NOT NULL,
  "plan_month_id" UUID NOT NULL,
  "publication_revision" BIGINT NOT NULL,
  "source_draft_revision" BIGINT NOT NULL,
  "source_plan_month_revision" BIGINT NOT NULL,
  "focus" TEXT NOT NULL,
  "activation_mode" VARCHAR(16) NOT NULL,
  "active_local_date" DATE NOT NULL,
  "late_publication" BOOLEAN NOT NULL,
  "time_zone" VARCHAR(64) NOT NULL,
  "source_preview_schema_version" VARCHAR(100) NOT NULL,
  "preview_hash_version" VARCHAR(100) NOT NULL,
  "preview_hash" CHAR(64) NOT NULL,
  "calendar_formula_version" VARCHAR(100) NOT NULL,
  "evaluation_formula_version" VARCHAR(100) NOT NULL,
  "score_formula_version" VARCHAR(100) NOT NULL,
  "published_by_member_id" UUID NOT NULL,
  "published_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "plan_publications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "plan_publications_revision_check" CHECK (
    "publication_revision" >= 1
    AND "source_draft_revision" >= 1
    AND "source_plan_month_revision" >= 1
  ),
  CONSTRAINT "plan_publications_focus_check"
    CHECK (btrim("focus") <> '' AND char_length("focus") <= 500),
  CONSTRAINT "plan_publications_activation_check" CHECK (
    "activation_mode" IN ('immediate', 'scheduled')
    AND "active_local_date" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
    AND "time_zone" = 'Asia/Yekaterinburg'
    AND (
      ("activation_mode" = 'scheduled' AND "late_publication" = false)
      OR "activation_mode" = 'immediate'
    )
  ),
  CONSTRAINT "plan_publications_version_check" CHECK (
    "source_preview_schema_version" ~ '^[a-z0-9][a-z0-9.-]{0,99}$'
    AND "preview_hash_version" ~ '^[a-z0-9][a-z0-9.-]{0,99}$'
    AND "calendar_formula_version" ~ '^[a-z0-9][a-z0-9.-]{0,99}$'
    AND "evaluation_formula_version" ~ '^[a-z0-9][a-z0-9.-]{0,99}$'
    AND "score_formula_version" ~ '^[a-z0-9][a-z0-9.-]{0,99}$'
  ),
  CONSTRAINT "plan_publications_hash_check"
    CHECK ("preview_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "plan_publications_month_revision_key"
    UNIQUE ("plan_month_id", "publication_revision"),
  CONSTRAINT "plan_publications_month_id_key"
    UNIQUE ("plan_month_id", "id"),
  CONSTRAINT "plan_publications_space_id_key"
    UNIQUE ("space_id", "id"),
  CONSTRAINT "plan_publications_month_fkey"
    FOREIGN KEY ("space_id", "plan_month_id")
    REFERENCES "plan_months"("space_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "plan_publications_draft_fkey"
    FOREIGN KEY ("plan_month_id")
    REFERENCES "plan_drafts"("plan_month_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "plan_publications_publisher_fkey"
    FOREIGN KEY ("space_id", "published_by_member_id")
    REFERENCES "memberships"("space_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

ALTER TABLE "plan_months"
  ADD CONSTRAINT "plan_months_active_publication_fkey"
    FOREIGN KEY ("id", "active_publication_id")
    REFERENCES "plan_publications"("plan_month_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "plan_goal_snapshots" (
  "id" UUID NOT NULL,
  "publication_id" UUID NOT NULL,
  "space_id" UUID NOT NULL,
  "plan_month_id" UUID NOT NULL,
  "source_plan_goal_id" UUID NOT NULL,
  "source_draft_goal_revision_id" UUID NOT NULL,
  "source_config_revision" BIGINT NOT NULL,
  "goal_definition_id" UUID NOT NULL,
  "goal_definition_version_id" UUID NOT NULL,
  "goal_series_id" UUID NOT NULL,
  "display_order" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "why" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "scope_kind" VARCHAR(16) NOT NULL,
  "owner_member_id" UUID,
  "config" JSONB NOT NULL,
  "source_provenance" JSONB,
  "calendar" JSONB NOT NULL,

  CONSTRAINT "plan_goal_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "plan_goal_snapshots_revision_order_check"
    CHECK ("source_config_revision" >= 1 AND "display_order" BETWEEN 0 AND 199),
  CONSTRAINT "plan_goal_snapshots_metadata_check" CHECK (
    btrim("title") <> '' AND char_length("title") <= 200
    AND btrim("why") <> '' AND char_length("why") <= 2000
    AND btrim("category") <> '' AND char_length("category") <= 100
  ),
  CONSTRAINT "plan_goal_snapshots_scope_check" CHECK (
    ("scope_kind" = 'personal' AND "owner_member_id" IS NOT NULL)
    OR ("scope_kind" = 'shared' AND "owner_member_id" IS NULL)
  ),
  CONSTRAINT "plan_goal_snapshots_config_check"
    CHECK (jsonb_typeof("config") = 'object'),
  CONSTRAINT "plan_goal_snapshots_provenance_check"
    CHECK ("source_provenance" IS NULL OR jsonb_typeof("source_provenance") = 'object'),
  CONSTRAINT "plan_goal_snapshots_calendar_check"
    CHECK ((jsonb_typeof("calendar") = 'object'
      AND "calendar"->>'kind' IN ('fixed', 'quota', 'weekly_planned_task')) IS TRUE),
  CONSTRAINT "plan_goal_snapshots_publication_source_key"
    UNIQUE ("publication_id", "source_plan_goal_id"),
  CONSTRAINT "plan_goal_snapshots_publication_order_key"
    UNIQUE ("publication_id", "display_order"),
  CONSTRAINT "plan_goal_snapshots_publication_id_key"
    UNIQUE ("publication_id", "id"),
  CONSTRAINT "plan_goal_snapshots_publication_fkey"
    FOREIGN KEY ("plan_month_id", "publication_id")
    REFERENCES "plan_publications"("plan_month_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "plan_goal_snapshots_source_root_fkey"
    FOREIGN KEY ("source_plan_goal_id", "space_id", "goal_definition_id")
    REFERENCES "plan_draft_goals"("id", "space_id", "goal_definition_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "plan_goal_snapshots_source_revision_fkey"
    FOREIGN KEY ("source_plan_goal_id", "source_draft_goal_revision_id")
    REFERENCES "plan_draft_goal_revisions"("plan_goal_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "plan_goal_snapshots_definition_version_fkey"
    FOREIGN KEY ("goal_definition_id", "goal_definition_version_id")
    REFERENCES "goal_definition_versions"("goal_definition_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "plan_goal_snapshots_series_fkey"
    FOREIGN KEY ("goal_definition_id", "goal_series_id")
    REFERENCES "goal_series"("goal_definition_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "plan_goal_snapshots_owner_fkey"
    FOREIGN KEY ("space_id", "owner_member_id")
    REFERENCES "memberships"("space_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE "fixed_expectations" (
  "id" UUID NOT NULL,
  "publication_id" UUID NOT NULL,
  "plan_goal_snapshot_id" UUID NOT NULL,
  "expectation_date" DATE NOT NULL,
  "component_kind" VARCHAR(24) NOT NULL,
  "component_id" UUID,

  CONSTRAINT "fixed_expectations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fixed_expectations_component_check" CHECK (
    ("component_kind" = 'goal' AND "component_id" IS NULL)
    OR ("component_kind" IN ('checkpoint', 'checklist_item')
        AND "component_id" IS NOT NULL)
  ),
  CONSTRAINT "fixed_expectations_publication_snapshot_fkey"
    FOREIGN KEY ("publication_id", "plan_goal_snapshot_id")
    REFERENCES "plan_goal_snapshots"("publication_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fixed_expectations_stable_key"
    UNIQUE NULLS NOT DISTINCT
      ("publication_id", "plan_goal_snapshot_id", "expectation_date", "component_id")
);

CREATE TABLE "flexible_periods" (
  "id" UUID NOT NULL,
  "publication_id" UUID NOT NULL,
  "plan_goal_snapshot_id" UUID NOT NULL,
  "period_kind" VARCHAR(24) NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "period_start" DATE NOT NULL,
  "period_end" DATE NOT NULL,
  "period_days" INTEGER,
  "active_dates" DATE[] NOT NULL DEFAULT ARRAY[]::DATE[],
  "eligible_dates" DATE[] NOT NULL DEFAULT ARRAY[]::DATE[],
  "period_target" INTEGER NOT NULL,

  CONSTRAINT "flexible_periods_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "flexible_periods_kind_check"
    CHECK ("period_kind" IN ('weekly', 'monthly', 'weekly_planned_task')),
  CONSTRAINT "flexible_periods_bounds_check" CHECK (
    "ordinal" BETWEEN 1 AND 6 AND "period_start" <= "period_end"
    AND "period_target" >= 0
  ),
  CONSTRAINT "flexible_periods_shape_check" CHECK (
    ("period_kind" = 'weekly'
      AND "period_days" = 7
      AND ("period_target" = 0) = (cardinality("eligible_dates") = 0)
      AND "period_target" <= cardinality("eligible_dates"))
    OR ("period_kind" = 'monthly'
      AND "period_days" BETWEEN 28 AND 31
      AND ("period_target" = 0) = (cardinality("eligible_dates") = 0)
      AND "period_target" <= cardinality("eligible_dates"))
    OR ("period_kind" = 'weekly_planned_task'
      AND "period_days" IS NULL AND "period_target" = 1
      AND cardinality("active_dates") = 0
      AND cardinality("eligible_dates") = 0)
  ),
  CONSTRAINT "flexible_periods_publication_snapshot_fkey"
    FOREIGN KEY ("publication_id", "plan_goal_snapshot_id")
    REFERENCES "plan_goal_snapshots"("publication_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "flexible_periods_stable_key"
    UNIQUE ("publication_id", "plan_goal_snapshot_id", "period_kind",
            "period_start", "period_end"),
  CONSTRAINT "flexible_periods_ordinal_key"
    UNIQUE ("publication_id", "plan_goal_snapshot_id", "period_kind", "ordinal")
);

CREATE TABLE "planning_publication_changes" (
  "action_id" UUID NOT NULL,
  "publication_id" UUID NOT NULL,
  "confirmed_draft_revision" BIGINT NOT NULL,
  "confirmed_preview_schema_version" VARCHAR(100) NOT NULL,
  "confirmed_preview_hash_version" VARCHAR(100) NOT NULL,
  "confirmed_preview_hash" CHAR(64) NOT NULL,
  "before_active_publication_id" UUID,
  "after_active_publication_id" UUID NOT NULL,

  CONSTRAINT "planning_publication_changes_pkey" PRIMARY KEY ("action_id"),
  CONSTRAINT "planning_publication_changes_revision_check"
    CHECK ("confirmed_draft_revision" >= 1),
  CONSTRAINT "planning_publication_changes_version_check" CHECK (
    "confirmed_preview_schema_version" ~ '^[a-z0-9][a-z0-9.-]{0,99}$'
    AND "confirmed_preview_hash_version" ~ '^[a-z0-9][a-z0-9.-]{0,99}$'
  ),
  CONSTRAINT "planning_publication_changes_hash_check"
    CHECK ("confirmed_preview_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "planning_publication_changes_pointer_check"
    CHECK ("before_active_publication_id" IS NULL
      AND "after_active_publication_id" = "publication_id"),
  CONSTRAINT "planning_publication_changes_publication_key"
    UNIQUE ("publication_id"),
  CONSTRAINT "planning_publication_changes_action_fkey"
    FOREIGN KEY ("action_id") REFERENCES "planning_action_groups"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "planning_publication_changes_publication_fkey"
    FOREIGN KEY ("publication_id") REFERENCES "plan_publications"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

ALTER TABLE "planning_action_groups"
  DROP CONSTRAINT "planning_action_groups_action_kind_check",
  ADD CONSTRAINT "planning_action_groups_action_kind_check" CHECK (
    "action_kind" IN (
      'draft_created', 'month_focus_updated',
      'goal_definition_created', 'goal_definition_versioned',
      'goal_definition_archived', 'goal_definition_restored',
      'goal_definition_copied', 'draft_goal_added', 'draft_goal_updated',
      'draft_goal_removed', 'draft_goals_reordered', 'month_published'
    )
  ),
  DROP CONSTRAINT "planning_action_groups_target_check",
  ADD CONSTRAINT "planning_action_groups_target_check" CHECK (
    ("action_kind" IN (
      'draft_created', 'month_focus_updated', 'draft_goal_added',
      'draft_goal_updated', 'draft_goal_removed', 'draft_goals_reordered',
      'month_published'
    ) AND "plan_month_id" IS NOT NULL AND "goal_definition_id" IS NULL)
    OR ("action_kind" IN (
      'goal_definition_created', 'goal_definition_versioned',
      'goal_definition_archived', 'goal_definition_restored',
      'goal_definition_copied'
    ) AND "plan_month_id" IS NULL AND "goal_definition_id" IS NOT NULL)
  );

DROP TRIGGER "planning_action_groups_transition_unique"
  ON "planning_action_groups";
DROP FUNCTION "reject_p03_duplicate_month_transition"();
DROP INDEX "planning_action_groups_month_after_revision_key";

CREATE UNIQUE INDEX "planning_action_groups_draft_after_revision_key"
  ON "planning_action_groups"("plan_month_id", "after_revision")
  WHERE "action_kind" IN (
    'draft_created', 'month_focus_updated', 'draft_goal_added',
    'draft_goal_updated', 'draft_goal_removed', 'draft_goals_reordered'
  );

CREATE UNIQUE INDEX "planning_action_groups_lifecycle_after_revision_key"
  ON "planning_action_groups"("plan_month_id", "after_revision")
  WHERE "action_kind" = 'month_published';

CREATE FUNCTION "p07_date_array_is_sorted_unique"(values_to_check DATE[])
RETURNS BOOLEAN AS $$
  SELECT COALESCE(
    cardinality(values_to_check) = (
      SELECT count(DISTINCT value) FROM unnest(values_to_check) value
    )
    AND NOT EXISTS (
      SELECT 1
        FROM generate_subscripts(values_to_check, 1) index
       WHERE index > 1
         AND values_to_check[index - 1] >= values_to_check[index]
    )
    AND array_position(values_to_check, NULL) IS NULL,
    false
  );
$$ LANGUAGE SQL IMMUTABLE;

CREATE FUNCTION "p07_dates_inside"(
  values_to_check DATE[], lower_bound DATE, upper_bound DATE
)
RETURNS BOOLEAN AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM unnest(values_to_check) value
     WHERE value < lower_bound OR value > upper_bound
  );
$$ LANGUAGE SQL IMMUTABLE;

CREATE FUNCTION "p07_jsonb_is_exact_date_suffix"(
  values_to_check JSONB, lower_bound DATE, upper_bound DATE
)
RETURNS BOOLEAN AS $$
  SELECT (jsonb_typeof(values_to_check) = 'array'
    AND values_to_check = COALESCE((
      SELECT jsonb_agg(to_char(day_value, 'YYYY-MM-DD') ORDER BY day_value)
        FROM generate_series(
          lower_bound::timestamp,
          upper_bound::timestamp,
          INTERVAL '1 day'
        ) day_value
       WHERE lower_bound <= upper_bound
    ), '[]'::jsonb)) IS TRUE;
$$ LANGUAGE SQL IMMUTABLE;

ALTER TABLE "flexible_periods"
  ADD CONSTRAINT "flexible_periods_dates_check" CHECK (
    "p07_date_array_is_sorted_unique"("active_dates")
    AND "p07_date_array_is_sorted_unique"("eligible_dates")
    AND "active_dates" = "eligible_dates"
    AND "p07_dates_inside"("active_dates", "period_start", "period_end")
  );

CREATE FUNCTION "guard_p07_publication_revision"()
RETURNS TRIGGER AS $$
DECLARE
  month_start_value DATE;
  month_revision_value BIGINT;
  month_status_value VARCHAR(16);
  month_pointer_value UUID;
  draft_revision_value BIGINT;
  draft_focus_value TEXT;
  published_local_date DATE;
  expected_revision BIGINT;
BEGIN
  SELECT month.month_start, month.revision, month.status,
         month.active_publication_id, draft.revision, draft.focus
    INTO month_start_value, month_revision_value, month_status_value,
         month_pointer_value, draft_revision_value, draft_focus_value
    FROM plan_months month
    JOIN plan_drafts draft ON draft.plan_month_id = month.id
   WHERE month.id = NEW.plan_month_id
   FOR UPDATE OF month, draft;
  SELECT COALESCE(max(publication_revision), 0) + 1
    INTO expected_revision FROM plan_publications
   WHERE plan_month_id = NEW.plan_month_id;
  published_local_date := (NEW.published_at AT TIME ZONE NEW.time_zone)::date;
  IF month_start_value IS NULL
     OR month_status_value <> 'draft'
     OR month_pointer_value IS NOT NULL
     OR NEW.publication_revision <> expected_revision
     OR NEW.source_plan_month_revision <> month_revision_value
     OR NEW.source_draft_revision <> draft_revision_value
     OR NEW.focus <> draft_focus_value
     OR NEW.source_preview_schema_version <> 'planner.publication-preview.v1'
     OR NEW.preview_hash_version <> 'planner.publication-preview-hash.v1'
     OR NEW.calendar_formula_version <> 'planner.calendar-targets.v1'
     OR NEW.evaluation_formula_version <> 'planner.goal-evaluation.v1'
     OR NEW.score_formula_version <> 'planner.score-coverage.v1'
     OR NEW.published_at::text IN ('infinity', '-infinity')
     OR date_trunc('month', NEW.active_local_date)::date <> month_start_value
     OR NEW.late_publication <> (NEW.active_local_date > month_start_value)
     OR (NEW.activation_mode = 'immediate'
         AND (date_trunc('month', published_local_date)::date <> month_start_value
              OR NEW.active_local_date <> published_local_date))
     OR (NEW.activation_mode = 'scheduled'
         AND (month_start_value <>
                (date_trunc('month', published_local_date) + INTERVAL '1 month')::date
              OR NEW.active_local_date <> month_start_value)) THEN
    RAISE EXCEPTION 'invalid publication revision or activation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "plan_publications_guard_revision"
BEFORE INSERT ON "plan_publications"
FOR EACH ROW EXECUTE FUNCTION "guard_p07_publication_revision"();

CREATE FUNCTION "guard_p07_month_lifecycle_update"()
RETURNS TRIGGER AS $$
DECLARE
  publication plan_publications%ROWTYPE;
BEGIN
  IF (NEW.id = OLD.id
      AND NEW.space_id = OLD.space_id
      AND NEW.month_start = OLD.month_start
      AND NEW.created_at = OLD.created_at) IS NOT TRUE THEN
    RAISE EXCEPTION 'plan month identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'draft' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'published plan month lifecycle is immutable before P08'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'draft' AND NEW IS DISTINCT FROM OLD THEN
    SELECT * INTO publication FROM plan_publications
     WHERE id = NEW.active_publication_id AND plan_month_id = OLD.id;
    IF (OLD.active_publication_id IS NULL
        AND NEW.status = 'published'
        AND NEW.active_publication_id IS NOT NULL
        AND NEW.revision = OLD.revision + 1
        AND NEW.updated_at = publication.published_at
        AND publication.source_plan_month_revision = OLD.revision) IS NOT TRUE
    THEN
      RAISE EXCEPTION 'invalid P07 plan month lifecycle transition'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "plan_months_guard_p07_lifecycle_update"
BEFORE UPDATE ON "plan_months"
FOR EACH ROW EXECUTE FUNCTION "guard_p07_month_lifecycle_update"();

CREATE FUNCTION "p07_calendar_has_exact_shape"(calendar_value JSONB)
RETURNS BOOLEAN AS $$
DECLARE
  period JSONB;
  date_item JSONB;
  date_value DATE;
  previous_date DATE;
  target_month_start DATE;
  target_month_end DATE;
  active_date DATE;
  period_start_value DATE;
  period_end_value DATE;
  expected_period_start DATE;
  expected_ordinal INTEGER;
  period_ordinal INTEGER;
  period_days_value INTEGER;
  period_target_value INTEGER;
BEGIN
  IF jsonb_typeof(calendar_value) <> 'object' THEN RETURN false; END IF;
  target_month_start := (calendar_value->>'targetMonth' || '-01')::date;
  target_month_end := (target_month_start + INTERVAL '1 month - 1 day')::date;
  active_date := (calendar_value->>'activeLocalDate')::date;
  IF to_char(target_month_start, 'YYYY-MM') <> calendar_value->>'targetMonth'
     OR active_date::text <> calendar_value->>'activeLocalDate'
     OR date_trunc('month', active_date)::date <> target_month_start THEN
    RETURN false;
  END IF;
  IF calendar_value->>'kind' = 'fixed' THEN
    IF NOT p03_jsonb_has_exact_keys(calendar_value, ARRAY[
      'targetMonth', 'activeLocalDate', 'timeZone', 'kind', 'expectationDates'
    ]) OR jsonb_typeof(calendar_value->'expectationDates') <> 'array' THEN
      RETURN false;
    END IF;
    FOR date_item IN
      SELECT value FROM jsonb_array_elements(calendar_value->'expectationDates')
    LOOP
      IF jsonb_typeof(date_item) <> 'string'
         OR date_item #>> '{}' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RETURN false;
      END IF;
      date_value := (date_item #>> '{}')::date;
      IF date_value::text <> date_item #>> '{}'
         OR date_trunc('month', date_value)::date <> target_month_start
         OR date_value < active_date
         OR (previous_date IS NOT NULL AND date_value <= previous_date) THEN
        RETURN false;
      END IF;
      previous_date := date_value;
    END LOOP;
    RETURN true;
  END IF;
  IF calendar_value->>'kind' = 'quota' THEN
    IF (p03_jsonb_has_exact_keys(calendar_value, ARRAY[
      'targetMonth', 'activeLocalDate', 'timeZone', 'kind', 'cadence', 'periods'
    ]) AND calendar_value->>'cadence' IN ('weekly', 'monthly')
       AND jsonb_typeof(calendar_value->'periods') = 'array'
       AND (
         (calendar_value->>'cadence' = 'monthly'
          AND jsonb_array_length(calendar_value->'periods') = 1)
         OR
         (calendar_value->>'cadence' = 'weekly'
          AND jsonb_array_length(calendar_value->'periods') BETWEEN 4 AND 6)
       )) IS NOT TRUE THEN
      RETURN false;
    END IF;
    expected_ordinal := 1;
    expected_period_start := target_month_start;
    FOR period IN SELECT value FROM jsonb_array_elements(calendar_value->'periods') LOOP
      IF (p03_jsonb_has_exact_keys(period, ARRAY[
        'cadence', 'ordinal', 'periodStart', 'periodEnd', 'periodDays',
        'activeDates', 'eligibleDates', 'periodTarget'
      ]) AND period->>'cadence' = calendar_value->>'cadence'
         AND jsonb_typeof(period->'ordinal') = 'number'
         AND period->>'ordinal' ~ '^[1-9][0-9]*$'
         AND jsonb_typeof(period->'periodDays') = 'number'
         AND period->>'periodDays' ~ '^[1-9][0-9]*$'
         AND jsonb_typeof(period->'periodTarget') = 'number'
         AND period->>'periodTarget' ~ '^(0|[1-9][0-9]*)$'
         AND jsonb_typeof(period->'activeDates') = 'array'
         AND jsonb_typeof(period->'eligibleDates') = 'array') IS NOT TRUE THEN
        RETURN false;
      END IF;
      period_ordinal := (period->>'ordinal')::integer;
      period_days_value := (period->>'periodDays')::integer;
      period_target_value := (period->>'periodTarget')::integer;
      period_start_value := (period->>'periodStart')::date;
      period_end_value := (period->>'periodEnd')::date;
      IF (period_start_value::text = period->>'periodStart'
          AND period_end_value::text = period->>'periodEnd'
          AND period_start_value <= period_end_value
          AND date_trunc('month', period_start_value)::date = target_month_start
          AND date_trunc('month', period_end_value)::date = target_month_start
          AND period_ordinal = expected_ordinal
          AND period_target_value <= jsonb_array_length(period->'eligibleDates')
          AND (period_target_value = 0) =
              (jsonb_array_length(period->'eligibleDates') = 0)
          AND p07_jsonb_is_exact_date_suffix(
            period->'activeDates', GREATEST(period_start_value, active_date),
            period_end_value
          )
          AND p07_jsonb_is_exact_date_suffix(
            period->'eligibleDates', GREATEST(period_start_value, active_date),
            period_end_value
          )) IS NOT TRUE THEN
        RETURN false;
      END IF;
      IF calendar_value->>'cadence' = 'monthly' THEN
        IF (period_ordinal = 1
            AND period_start_value = target_month_start
            AND period_end_value = target_month_end
            AND period_days_value = target_month_end - target_month_start + 1
            ) IS NOT TRUE THEN
          RETURN false;
        END IF;
      ELSE
        IF (period_start_value = expected_period_start
            AND period_end_value - period_start_value + 1 BETWEEN 1 AND 7
            AND period_days_value = 7) IS NOT TRUE THEN
          RETURN false;
        END IF;
        expected_period_start := period_end_value + 1;
      END IF;
      expected_ordinal := expected_ordinal + 1;
    END LOOP;
    IF calendar_value->>'cadence' = 'weekly'
       AND expected_period_start <> target_month_end + 1 THEN
      RETURN false;
    END IF;
    RETURN true;
  END IF;
  IF calendar_value->>'kind' = 'weekly_planned_task' THEN
    IF NOT p03_jsonb_has_exact_keys(calendar_value, ARRAY[
      'targetMonth', 'activeLocalDate', 'timeZone', 'kind', 'periods'
    ]) OR jsonb_typeof(calendar_value->'periods') <> 'array'
       OR jsonb_array_length(calendar_value->'periods') > 1 THEN
      RETURN false;
    END IF;
    FOR period IN SELECT value FROM jsonb_array_elements(calendar_value->'periods') LOOP
      IF (p03_jsonb_has_exact_keys(period, ARRAY[
        'cadence', 'ordinal', 'periodStart', 'periodEnd', 'periodTarget'
      ]) AND period->>'cadence' = 'weekly'
         AND jsonb_typeof(period->'ordinal') = 'number'
         AND period->>'ordinal' ~ '^[1-5]$'
         AND (period->>'ordinal')::integer BETWEEN 1 AND 5
         AND jsonb_typeof(period->'periodTarget') = 'number'
         AND period->>'periodTarget' = '1') IS NOT TRUE THEN
        RETURN false;
      END IF;
      period_ordinal := (period->>'ordinal')::integer;
      period_start_value := (period->>'periodStart')::date;
      period_end_value := (period->>'periodEnd')::date;
      IF (period_start_value::text = period->>'periodStart'
          AND period_end_value::text = period->>'periodEnd'
          AND period_start_value <= period_end_value
          AND date_trunc('month', period_start_value)::date = target_month_start
          AND date_trunc('month', period_end_value)::date = target_month_start
          AND period_end_value - period_start_value + 1 BETWEEN 1 AND 7
          AND period_end_value >= active_date) IS NOT TRUE THEN
        RETURN false;
      END IF;
    END LOOP;
    RETURN true;
  END IF;
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE FUNCTION "validate_p07_snapshot"()
RETURNS TRIGGER AS $$
DECLARE
  publication_space UUID;
  publication_month UUID;
  publication_target_month TEXT;
  publication_active_date DATE;
  publication_time_zone VARCHAR(64);
  publication_month_status VARCHAR(16);
  publication_month_pointer UUID;
  source_month UUID;
  source_order INTEGER;
  source_revision UUID;
  source_revision_number BIGINT;
  source_version UUID;
  source_series UUID;
  source_scope VARCHAR(16);
  source_owner UUID;
  source_config JSONB;
  source_provenance_value JSONB;
  source_title TEXT;
  source_why TEXT;
  source_category TEXT;
BEGIN
  SELECT publication.space_id, publication.plan_month_id,
         to_char(month.month_start, 'YYYY-MM'),
         publication.active_local_date, publication.time_zone,
         month.status, month.active_publication_id
    INTO publication_space, publication_month, publication_target_month,
         publication_active_date, publication_time_zone,
         publication_month_status, publication_month_pointer
    FROM plan_publications publication
    JOIN plan_months month ON month.id = publication.plan_month_id
   WHERE publication.id = NEW.publication_id;
  SELECT root.plan_month_id, root.display_order, root.current_revision_id,
         revision.revision_number, revision.goal_definition_version_id,
         revision.goal_series_id, revision.scope_kind,
         revision.owner_member_id, revision.config,
         revision.source_provenance, version.title, version.why,
         version.category
    INTO source_month, source_order, source_revision,
         source_revision_number, source_version, source_series,
         source_scope, source_owner, source_config,
         source_provenance_value, source_title, source_why, source_category
    FROM plan_draft_goals root
    JOIN plan_draft_goal_revisions revision
      ON revision.plan_goal_id = root.id
     AND revision.id = root.current_revision_id
    JOIN goal_definition_versions version
      ON version.goal_definition_id = root.goal_definition_id
     AND version.id = revision.goal_definition_version_id
   WHERE root.id = NEW.source_plan_goal_id
     AND root.detached_at IS NULL;
  IF (publication_space = NEW.space_id
      AND publication_month = NEW.plan_month_id
      AND source_month = NEW.plan_month_id
      AND source_order = NEW.display_order
      AND source_revision = NEW.source_draft_goal_revision_id
      AND source_revision_number = NEW.source_config_revision
      AND source_version = NEW.goal_definition_version_id
      AND source_series = NEW.goal_series_id
      AND source_scope = NEW.scope_kind
      AND source_owner IS NOT DISTINCT FROM NEW.owner_member_id
      AND source_config = NEW.config
      AND source_provenance_value IS NOT DISTINCT FROM NEW.source_provenance
      AND source_title = NEW.title
      AND source_why = NEW.why
      AND source_category = NEW.category
      AND publication_month_status = 'draft'
      AND publication_month_pointer IS NULL
      AND p07_calendar_has_exact_shape(NEW.calendar)
      AND NEW.calendar->>'targetMonth' = publication_target_month
      AND NEW.calendar->>'activeLocalDate' = publication_active_date::text
      AND NEW.calendar->>'timeZone' = publication_time_zone
      AND (
        (NEW.config->'repetition'->>'kind' IN ('daily', 'weekdays', 'one_off')
         AND NEW.calendar->>'kind' = 'fixed')
        OR
        (NEW.config->'repetition'->>'kind' IN ('weekly', 'monthly')
         AND NEW.calendar->>'kind' = 'quota'
         AND NEW.calendar->>'cadence' = NEW.config->'repetition'->>'kind')
        OR
        (NEW.config->'repetition'->>'kind' = 'weekly_planned_task'
         AND NEW.calendar->>'kind' = 'weekly_planned_task'
         AND (
           (jsonb_array_length(NEW.calendar->'periods') = 1
            AND NEW.calendar->'periods'->0->>'ordinal' =
                NEW.config->'repetition'->>'weekOrdinal')
           OR
           jsonb_array_length(NEW.calendar->'periods') = 0
         ))
      )
      AND NEW.config->'scope'->>'kind' = NEW.scope_kind
      AND COALESCE(NEW.config->'scope'->>'ownerMemberId', '') =
          COALESCE(NEW.owner_member_id::text, '')) IS NOT TRUE THEN
    RAISE EXCEPTION 'invalid publication snapshot source'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "plan_goal_snapshots_validate"
BEFORE INSERT ON "plan_goal_snapshots"
FOR EACH ROW EXECUTE FUNCTION "validate_p07_snapshot"();

CREATE FUNCTION "validate_p07_fixed_expectation"()
RETURNS TRIGGER AS $$
DECLARE
  calendar JSONB;
  config_value JSONB;
  month_status_value VARCHAR(16);
  month_pointer_value UUID;
BEGIN
  SELECT snapshot.calendar, snapshot.config, month.status,
         month.active_publication_id
    INTO calendar, config_value, month_status_value, month_pointer_value
    FROM plan_goal_snapshots snapshot
    JOIN plan_publications publication ON publication.id = snapshot.publication_id
    JOIN plan_months month ON month.id = publication.plan_month_id
   WHERE snapshot.publication_id = NEW.publication_id
     AND snapshot.id = NEW.plan_goal_snapshot_id;
  IF (calendar->>'kind' = 'fixed'
      AND month_status_value = 'draft'
      AND month_pointer_value IS NULL
      AND date_trunc('month', NEW.expectation_date)::date =
          (calendar->>'targetMonth' || '-01')::date
      AND NEW.expectation_date >= (calendar->>'activeLocalDate')::date
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(calendar->'expectationDates') date_value
         WHERE date_value = NEW.expectation_date::text
      )
      AND (
        (NEW.component_kind = 'goal'
         AND NEW.component_id IS NULL
         AND config_value->'checkpoints' = 'null'::jsonb
         AND config_value->'measurement'->>'kind' <> 'checklist')
        OR
        (NEW.component_kind = 'checklist_item'
         AND NEW.component_id IS NOT NULL
         AND config_value->'checkpoints' = 'null'::jsonb
         AND config_value->'measurement'->>'kind' = 'checklist'
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(config_value->'measurement'->'items') item
            WHERE item->>'itemId' = NEW.component_id::text
         ))
        OR
        (NEW.component_kind = 'checkpoint'
         AND NEW.component_id IS NOT NULL
         AND jsonb_typeof(config_value->'checkpoints') = 'object'
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(config_value->'checkpoints'->'items') item
            WHERE item->>'checkpointId' = NEW.component_id::text
         ))
      )) IS NOT TRUE THEN
    RAISE EXCEPTION 'invalid fixed expectation membership'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "fixed_expectations_validate"
BEFORE INSERT ON "fixed_expectations"
FOR EACH ROW EXECUTE FUNCTION "validate_p07_fixed_expectation"();

CREATE FUNCTION "validate_p07_flexible_period"()
RETURNS TRIGGER AS $$
DECLARE
  calendar JSONB;
  expected JSONB;
  month_status_value VARCHAR(16);
  month_pointer_value UUID;
BEGIN
  SELECT snapshot.calendar, month.status, month.active_publication_id
    INTO calendar, month_status_value, month_pointer_value
    FROM plan_goal_snapshots snapshot
    JOIN plan_publications publication ON publication.id = snapshot.publication_id
    JOIN plan_months month ON month.id = publication.plan_month_id
   WHERE snapshot.publication_id = NEW.publication_id
     AND snapshot.id = NEW.plan_goal_snapshot_id;
  SELECT period INTO expected
    FROM jsonb_array_elements(calendar->'periods') period
   WHERE (period->>'ordinal')::integer = NEW.ordinal;
  IF (expected IS NOT NULL
      AND month_status_value = 'draft'
      AND month_pointer_value IS NULL
      AND date_trunc('month', NEW.period_start)::date =
          (calendar->>'targetMonth' || '-01')::date
      AND date_trunc('month', NEW.period_end)::date =
          (calendar->>'targetMonth' || '-01')::date
      AND expected->>'periodStart' = NEW.period_start::text
      AND expected->>'periodEnd' = NEW.period_end::text
      AND (expected->>'periodTarget')::integer = NEW.period_target
      AND (
        (calendar->>'kind' = 'quota'
         AND calendar->>'cadence' = NEW.period_kind
         AND (expected->>'periodDays')::integer = NEW.period_days
         AND expected->'activeDates' = to_jsonb(NEW.active_dates::text[])
         AND expected->'eligibleDates' = to_jsonb(NEW.eligible_dates::text[])
         AND p07_dates_inside(
           NEW.active_dates,
           GREATEST(NEW.period_start, (calendar->>'activeLocalDate')::date),
           NEW.period_end
         )
         AND p07_dates_inside(
           NEW.eligible_dates,
           GREATEST(NEW.period_start, (calendar->>'activeLocalDate')::date),
           NEW.period_end
         ))
        OR
        (calendar->>'kind' = 'weekly_planned_task'
         AND NEW.period_kind = 'weekly_planned_task'
         AND NEW.ordinal BETWEEN 1 AND 5
         AND NEW.period_end >= (calendar->>'activeLocalDate')::date
         AND NEW.period_days IS NULL
         AND cardinality(NEW.active_dates) = 0
         AND cardinality(NEW.eligible_dates) = 0)
      )) IS NOT TRUE THEN
    RAISE EXCEPTION 'invalid flexible period membership'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "flexible_periods_validate"
BEFORE INSERT ON "flexible_periods"
FOR EACH ROW EXECUTE FUNCTION "validate_p07_flexible_period"();

CREATE FUNCTION "require_p07_month_pointer"()
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
                WHERE publication_id = NEW.id) = 1) IS NOT TRUE THEN
    RAISE EXCEPTION 'publication is not the exact active audited pointer'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "plan_months_require_publication_pointer"
AFTER INSERT OR UPDATE OF status, active_publication_id ON "plan_months"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_p07_month_pointer"();

CREATE CONSTRAINT TRIGGER "plan_publications_require_month_pointer"
AFTER INSERT ON "plan_publications"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_p07_month_pointer"();

CREATE FUNCTION "require_p07_publication_complete"()
RETURNS TRIGGER AS $$
DECLARE
  target_publication UUID;
  target_month UUID;
  source_count BIGINT;
  snapshot_count BIGINT;
  bad_calendars BIGINT;
  final_draft_revision BIGINT;
  final_draft_focus TEXT;
  publication_source_revision BIGINT;
  publication_focus TEXT;
BEGIN
  target_publication := COALESCE(
    (to_jsonb(NEW)->>'publication_id')::uuid,
    (to_jsonb(NEW)->>'id')::uuid
  );
  SELECT plan_month_id, source_draft_revision, focus
    INTO target_month, publication_source_revision, publication_focus
    FROM plan_publications
   WHERE id = target_publication;
  SELECT revision, focus INTO final_draft_revision, final_draft_focus
    FROM plan_drafts WHERE plan_month_id = target_month;
  SELECT count(*) INTO source_count FROM plan_draft_goals
   WHERE plan_month_id = target_month AND detached_at IS NULL;
  SELECT count(*) INTO snapshot_count FROM plan_goal_snapshots
   WHERE publication_id = target_publication;
  SELECT count(*) INTO bad_calendars FROM plan_goal_snapshots snapshot
   WHERE snapshot.publication_id = target_publication
     AND ((
       (snapshot.calendar->>'kind' = 'fixed' AND
        (SELECT count(*) FROM fixed_expectations expectation
          WHERE expectation.publication_id = target_publication
            AND expectation.plan_goal_snapshot_id = snapshot.id) =
        jsonb_array_length(snapshot.calendar->'expectationDates') *
        CASE
          WHEN snapshot.config->'checkpoints' IS DISTINCT FROM 'null'::jsonb
            THEN jsonb_array_length(snapshot.config->'checkpoints'->'items')
          WHEN snapshot.config->'measurement'->>'kind' = 'checklist'
            THEN jsonb_array_length(snapshot.config->'measurement'->'items')
          ELSE 1
        END)
       OR
       (snapshot.calendar->>'kind' IN ('quota', 'weekly_planned_task') AND
        (SELECT count(*) FROM flexible_periods period
          WHERE period.publication_id = target_publication
            AND period.plan_goal_snapshot_id = snapshot.id) =
        jsonb_array_length(snapshot.calendar->'periods'))
     ) IS NOT TRUE);
  IF (target_month IS NOT NULL
      AND publication_source_revision = final_draft_revision
      AND publication_focus = final_draft_focus
      AND source_count = snapshot_count
      AND bad_calendars = 0
      AND NOT EXISTS (
        SELECT 1 FROM plan_goal_snapshots snapshot
         WHERE snapshot.publication_id = target_publication
         GROUP BY snapshot.publication_id
        HAVING min(snapshot.display_order) <> 0
           OR max(snapshot.display_order) <> count(*) - 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM plan_goal_snapshots snapshot
        JOIN plan_draft_goals root ON root.id = snapshot.source_plan_goal_id
        WHERE snapshot.publication_id = target_publication
          AND (root.plan_month_id <> target_month
               OR root.detached_at IS NOT NULL
               OR root.display_order <> snapshot.display_order
               OR root.current_revision_id <> snapshot.source_draft_goal_revision_id)
      )) IS NOT TRUE THEN
    RAISE EXCEPTION 'publication child rows are incomplete'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "plan_publications_require_complete_children"
AFTER INSERT ON "plan_publications"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_p07_publication_complete"();

CREATE FUNCTION "validate_p07_publication_change"()
RETURNS TRIGGER AS $$
DECLARE
  parent planning_action_groups%ROWTYPE;
  publication plan_publications%ROWTYPE;
BEGIN
  SELECT * INTO parent FROM planning_action_groups WHERE id = NEW.action_id;
  SELECT * INTO publication FROM plan_publications WHERE id = NEW.publication_id;
  IF (parent.action_kind = 'month_published'
      AND parent.actor_kind = 'member'
      AND parent.system_actor_id IS NULL
      AND parent.plan_month_id = publication.plan_month_id
      AND parent.member_id = publication.published_by_member_id
      AND parent.before_revision = publication.source_plan_month_revision
      AND parent.after_revision = publication.source_plan_month_revision + 1
      AND parent.occurred_at = publication.published_at
      AND parent.command_type = 'planning.publish-month.v1'
      AND NEW.confirmed_draft_revision = publication.source_draft_revision
      AND NEW.confirmed_preview_schema_version =
          publication.source_preview_schema_version
      AND NEW.confirmed_preview_hash_version = publication.preview_hash_version
      AND NEW.confirmed_preview_hash = publication.preview_hash) IS NOT TRUE THEN
    RAISE EXCEPTION 'invalid publication history detail'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "planning_publication_changes_validate"
BEFORE INSERT ON "planning_publication_changes"
FOR EACH ROW EXECUTE FUNCTION "validate_p07_publication_change"();

CREATE FUNCTION "require_p07_publication_effect"()
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
  IF (month_value.status = 'published'
      AND month_value.active_publication_id = publication.id
      AND month_value.revision = parent.after_revision
      AND parent.command_type = 'planning.publish-month.v1'
      AND receipt.result_kind = 'planning.plan-publication.v1'
      AND receipt.aggregate_id = publication.id
      AND receipt.aggregate_revision = publication.publication_revision
      AND receipt.completed_at = publication.published_at) IS NOT TRUE THEN
    RAISE EXCEPTION 'publication history effect or receipt mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "planning_publication_changes_effect_consistent"
AFTER INSERT ON "planning_publication_changes"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_p07_publication_effect"();

CREATE FUNCTION "require_p07_publication_receipt_effect"()
RETURNS TRIGGER AS $$
BEGIN
  IF (NEW.command_type = 'planning.publish-month.v1'
      OR NEW.result_kind = 'planning.plan-publication.v1') AND NOT (
    NEW.command_type = 'planning.publish-month.v1'
    AND NEW.result_kind = 'planning.plan-publication.v1'
    AND EXISTS (
    SELECT 1
      FROM planning_action_groups action
      JOIN planning_publication_changes change ON change.action_id = action.id
      JOIN plan_publications publication ON publication.id = change.publication_id
     WHERE action.actor_scope = NEW.actor_scope
       AND action.command_type = NEW.command_type
       AND action.command_id = NEW.command_id
       AND action.command_type = 'planning.publish-month.v1'
       AND publication.id = NEW.aggregate_id
       AND publication.publication_revision = NEW.aggregate_revision
       AND publication.published_at = NEW.completed_at
  )) THEN
    RAISE EXCEPTION 'publication receipt requires exact action and detail'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "command_receipts_publication_effect_consistent"
AFTER INSERT ON "command_receipts"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_p07_publication_receipt_effect"();

CREATE FUNCTION "require_p07_publication_detail"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.action_kind = 'month_published' AND NOT EXISTS (
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
FOR EACH ROW EXECUTE FUNCTION "require_p07_publication_detail"();

CREATE TRIGGER "plan_publications_reject_update_delete"
BEFORE UPDATE OR DELETE ON "plan_publications"
FOR EACH ROW EXECUTE FUNCTION "reject_p01_immutable_row_change"();

CREATE TRIGGER "plan_goal_snapshots_reject_update_delete"
BEFORE UPDATE OR DELETE ON "plan_goal_snapshots"
FOR EACH ROW EXECUTE FUNCTION "reject_p01_immutable_row_change"();

CREATE TRIGGER "fixed_expectations_reject_update_delete"
BEFORE UPDATE OR DELETE ON "fixed_expectations"
FOR EACH ROW EXECUTE FUNCTION "reject_p01_immutable_row_change"();

CREATE TRIGGER "flexible_periods_reject_update_delete"
BEFORE UPDATE OR DELETE ON "flexible_periods"
FOR EACH ROW EXECUTE FUNCTION "reject_p01_immutable_row_change"();

CREATE TRIGGER "planning_publication_changes_reject_update_delete"
BEFORE UPDATE OR DELETE ON "planning_publication_changes"
FOR EACH ROW EXECUTE FUNCTION "reject_p01_immutable_row_change"();

COMMIT;
