CREATE TABLE "plan_months" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "space_id" UUID NOT NULL,
    "month_start" DATE NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "revision" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "plan_months_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "plan_months_month_start_check"
      CHECK (
        "month_start" BETWEEN DATE '0001-01-01' AND DATE '9999-12-01'
        AND EXTRACT(DAY FROM "month_start") = 1
      ),
    CONSTRAINT "plan_months_status_check"
      CHECK ("status" IN ('draft', 'published', 'grace', 'closed')),
    CONSTRAINT "plan_months_revision_check" CHECK ("revision" >= 1),
    CONSTRAINT "plan_months_space_month_key" UNIQUE ("space_id", "month_start"),
    CONSTRAINT "plan_months_space_id_fkey" FOREIGN KEY ("space_id")
      REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "plan_drafts" (
    "plan_month_id" UUID NOT NULL,
    "focus" TEXT NOT NULL,
    "revision" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "plan_drafts_pkey" PRIMARY KEY ("plan_month_id"),
    CONSTRAINT "plan_drafts_focus_check"
      CHECK (btrim("focus") <> '' AND char_length("focus") <= 500),
    CONSTRAINT "plan_drafts_revision_check" CHECK ("revision" >= 1),
    CONSTRAINT "plan_drafts_plan_month_id_fkey" FOREIGN KEY ("plan_month_id")
      REFERENCES "plan_months"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "command_receipts" (
    "actor_scope" VARCHAR(64) NOT NULL,
    "command_type" VARCHAR(128) NOT NULL,
    "command_id" UUID NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "result_kind" VARCHAR(128) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "aggregate_revision" BIGINT NOT NULL,
    "completed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "command_receipts_pkey"
      PRIMARY KEY ("actor_scope", "command_type", "command_id"),
    CONSTRAINT "command_receipts_actor_scope_check"
      CHECK (
        "actor_scope" = 'system:planner-worker'
        OR "actor_scope" ~ '^member:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      ),
    CONSTRAINT "command_receipts_command_type_check"
      CHECK ("command_type" ~ '^[a-z][a-z0-9.-]*\.v[1-9][0-9]*$'),
    CONSTRAINT "command_receipts_fingerprint_check"
      CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "command_receipts_result_kind_check"
      CHECK ("result_kind" ~ '^[a-z][a-z0-9.-]*\.v[1-9][0-9]*$'),
    CONSTRAINT "command_receipts_aggregate_revision_check"
      CHECK ("aggregate_revision" >= 1)
);

CREATE TABLE "planning_action_groups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "action_kind" VARCHAR(32) NOT NULL,
    "actor_kind" VARCHAR(16) NOT NULL,
    "actor_scope" VARCHAR(64) NOT NULL,
    "member_id" UUID,
    "system_actor_id" VARCHAR(32),
    "plan_month_id" UUID NOT NULL,
    "command_type" VARCHAR(128) NOT NULL,
    "command_id" UUID NOT NULL,
    "before_revision" BIGINT,
    "after_revision" BIGINT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "planning_action_groups_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "planning_action_groups_action_kind_check"
      CHECK ("action_kind" IN ('draft_created', 'month_focus_updated')),
    CONSTRAINT "planning_action_groups_actor_kind_check"
      CHECK ("actor_kind" IN ('member', 'system')),
    CONSTRAINT "planning_action_groups_actor_consistency_check"
      CHECK (
        (
          "actor_kind" = 'member'
          AND "member_id" IS NOT NULL
          AND "system_actor_id" IS NULL
          AND "actor_scope" = 'member:' || "member_id"::text
        ) OR (
          "actor_kind" = 'system'
          AND "member_id" IS NULL
          AND "system_actor_id" = 'planner-worker'
          AND "actor_scope" = 'system:planner-worker'
        )
      ),
    CONSTRAINT "planning_action_groups_before_revision_check"
      CHECK ("before_revision" IS NULL OR "before_revision" >= 1),
    CONSTRAINT "planning_action_groups_after_revision_check"
      CHECK ("after_revision" >= 1),
    CONSTRAINT "planning_action_groups_command_key"
      UNIQUE ("actor_scope", "command_type", "command_id"),
    CONSTRAINT "planning_action_groups_member_id_fkey" FOREIGN KEY ("member_id")
      REFERENCES "memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "planning_action_groups_plan_month_id_fkey" FOREIGN KEY ("plan_month_id")
      REFERENCES "plan_months"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "planning_action_groups_receipt_fkey"
      FOREIGN KEY ("actor_scope", "command_type", "command_id")
      REFERENCES "command_receipts"("actor_scope", "command_type", "command_id")
      ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE "planning_month_focus_changes" (
    "action_id" UUID NOT NULL,
    "before_focus" TEXT,
    "after_focus" TEXT NOT NULL,

    CONSTRAINT "planning_month_focus_changes_pkey" PRIMARY KEY ("action_id"),
    CONSTRAINT "planning_month_focus_changes_after_focus_check"
      CHECK (btrim("after_focus") <> '' AND char_length("after_focus") <= 500),
    CONSTRAINT "planning_month_focus_changes_before_focus_check"
      CHECK ("before_focus" IS NULL OR char_length("before_focus") <= 500),
    CONSTRAINT "planning_month_focus_changes_action_id_fkey" FOREIGN KEY ("action_id")
      REFERENCES "planning_action_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE FUNCTION "reject_p01_immutable_row_change"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "command_receipts_reject_update_delete"
BEFORE UPDATE OR DELETE ON "command_receipts"
FOR EACH ROW EXECUTE FUNCTION "reject_p01_immutable_row_change"();

CREATE TRIGGER "planning_action_groups_reject_update_delete"
BEFORE UPDATE OR DELETE ON "planning_action_groups"
FOR EACH ROW EXECUTE FUNCTION "reject_p01_immutable_row_change"();

CREATE TRIGGER "planning_month_focus_changes_reject_update_delete"
BEFORE UPDATE OR DELETE ON "planning_month_focus_changes"
FOR EACH ROW EXECUTE FUNCTION "reject_p01_immutable_row_change"();
