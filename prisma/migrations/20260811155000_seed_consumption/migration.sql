-- P11 consumes the immutable April seed once and creates one complete draft.
LOCK TABLE spaces, memberships, plan_months, plan_drafts, goal_definitions,
  goal_series, goal_definition_versions, plan_draft_goals,
  plan_draft_goal_revisions, plan_publications, planning_action_groups,
  command_receipts IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF to_regclass('planning_seed_consumptions') IS NOT NULL THEN
    RAISE EXCEPTION 'P11 seed consumption table already exists';
  END IF;
  IF EXISTS (
    SELECT 1 FROM planning_action_groups
     WHERE action_kind = 'draft_created_from_seed'
  ) OR EXISTS (
    SELECT 1 FROM command_receipts
     WHERE command_type = 'planning.create-draft-from-seed.v1'
  ) THEN
    RAISE EXCEPTION 'P11 seed history already exists without its migration';
  END IF;
END;
$$;

CREATE TABLE "planning_seed_consumptions" (
  "action_id" UUID NOT NULL,
  "space_id" UUID NOT NULL,
  "plan_month_id" UUID NOT NULL,
  "seed_id" VARCHAR(64) NOT NULL,
  "seed_version" INTEGER NOT NULL,
  "seed_schema_version" VARCHAR(128) NOT NULL,
  "actor_persona" VARCHAR(16) NOT NULL,
  "member_a_member_id" UUID NOT NULL,
  "member_b_member_id" UUID NOT NULL,
  "seeded_goal_count" INTEGER NOT NULL,
  "goal_definition_ids" UUID[] NOT NULL,
  "after_order" UUID[] NOT NULL,

  CONSTRAINT "planning_seed_consumptions_pkey" PRIMARY KEY ("action_id"),
  CONSTRAINT "planning_seed_consumptions_plan_month_key"
    UNIQUE ("plan_month_id"),
  CONSTRAINT "planning_seed_consumptions_space_seed_key"
    UNIQUE ("space_id", "seed_id"),
  CONSTRAINT "planning_seed_consumptions_space_month_key"
    UNIQUE ("space_id", "plan_month_id"),
  CONSTRAINT "planning_seed_consumptions_seed_check" CHECK (
    "seed_id" = 'april-plan'
    AND "seed_version" = 1
    AND "seed_schema_version" = 'planner.april-plan-seed.v1'
  ),
  CONSTRAINT "planning_seed_consumptions_persona_check"
    CHECK ("actor_persona" IN ('memberA', 'memberB')),
  CONSTRAINT "planning_seed_consumptions_pair_check"
    CHECK ("member_a_member_id" <> "member_b_member_id"),
  CONSTRAINT "planning_seed_consumptions_goal_count_check" CHECK (
    "seeded_goal_count" = 41
    AND cardinality("goal_definition_ids") = "seeded_goal_count"
    AND cardinality("after_order") = "seeded_goal_count"
  ),
  CONSTRAINT "planning_seed_consumptions_goal_arrays_check" CHECK (
    array_position("goal_definition_ids", NULL) IS NULL
    AND array_position("after_order", NULL) IS NULL
    AND "p03_uuid_array_is_distinct"("goal_definition_ids")
    AND "p03_uuid_array_is_distinct"("after_order")
  ),
  CONSTRAINT "planning_seed_consumptions_action_fkey"
    FOREIGN KEY ("action_id") REFERENCES "planning_action_groups"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "planning_seed_consumptions_space_fkey"
    FOREIGN KEY ("space_id") REFERENCES "spaces"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "planning_seed_consumptions_plan_month_fkey"
    FOREIGN KEY ("space_id", "plan_month_id")
    REFERENCES "plan_months"("space_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "planning_seed_consumptions_member_a_member_fkey"
    FOREIGN KEY ("space_id", "member_a_member_id")
    REFERENCES "memberships"("space_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "planning_seed_consumptions_member_b_member_fkey"
    FOREIGN KEY ("space_id", "member_b_member_id")
    REFERENCES "memberships"("space_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

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
      'month_publication_cancelled'
    )
  ),
  DROP CONSTRAINT "planning_action_groups_target_check",
  ADD CONSTRAINT "planning_action_groups_target_check" CHECK (
    ("action_kind" IN (
      'draft_created', 'draft_copied', 'draft_created_from_seed',
      'month_focus_updated', 'draft_goal_added', 'draft_goal_updated',
      'draft_goal_removed', 'draft_goals_reordered', 'month_published',
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
    'draft_created', 'draft_copied', 'draft_created_from_seed',
    'month_focus_updated', 'draft_goal_added', 'draft_goal_updated',
    'draft_goal_removed', 'draft_goals_reordered'
  );

CREATE FUNCTION "p11_seed_goals_have_exact_shape"(
  target_month UUID,
  target_space UUID,
  event_time TIMESTAMPTZ,
  member_a_member UUID,
  member_b_member UUID,
  definition_order UUID[],
  root_order UUID[]
)
RETURNS BOOLEAN AS $$
DECLARE
  root_count INTEGER;
  active_root_count INTEGER;
  revision_count INTEGER;
  definition_count INTEGER;
  series_count INTEGER;
  version_count INTEGER;
  catalog_change_count INTEGER;
  publication_count INTEGER;
  current_root_order UUID[];
  current_definition_order UUID[];
  current_manifest JSONB;
  expected_manifest CONSTANT JSONB := $p11_manifest$[{"owner":"memberB","title":"Показатель 103","why":"Показатель 165","category":"Режим","config":{"schemaVersion":1,"repetition":{"kind":"daily"},"measurement":{"kind":"actual_time","start":"08:00","end":"09:30"},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":1,"rawValue":"Показатель 102","rawDenominator":"/30","resolution":"Показатель 063"}},{"owner":"memberB","title":"Показатель 082","why":"Показатель 142","category":"Режим","config":{"schemaVersion":1,"repetition":{"kind":"daily"},"measurement":{"kind":"actual_time","start":"21:00","end":"23:00"},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":1,"rawValue":"Показатель 081","rawDenominator":"/30","resolution":"Показатель 064"}},{"owner":"memberB","title":"Утро без телефона","why":"Показатель 143","category":"Режим","config":{"schemaVersion":1,"repetition":{"kind":"daily"},"measurement":{"kind":"quantity","mode":"targeted","unit":"минуты","precision":0,"aggregation":"add","target":"60"},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":1,"rawValue":"Показатель 004","rawDenominator":"/30","resolution":"Показатель 092"}},{"owner":"memberB","title":"Показатель 086","why":"псих состояние","category":"Самочувствие","config":{"schemaVersion":1,"repetition":{"kind":"daily"},"measurement":{"kind":"rating","minimum":1,"maximum":10},"checkpoints":{"aggregation":"independent","items":[{"checkpointId":"10000000-0000-4000-8000-000000000001","name":"утро","deadline":"12:00","satisfaction":{"kind":"rating"}},{"checkpointId":"10000000-0000-4000-8000-000000000002","name":"день","deadline":"18:00","satisfaction":{"kind":"rating"}},{"checkpointId":"10000000-0000-4000-8000-000000000003","name":"вечер","deadline":"22:00","satisfaction":{"kind":"rating"}}]}},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":1,"rawValue":"Показатель 094","rawDenominator":null,"resolution":"Показатель 130"}},{"owner":"memberB","title":"Вода 1200 мл","why":"здоровье и красота","category":"Здоровье","config":{"schemaVersion":1,"repetition":{"kind":"daily"},"measurement":{"kind":"quantity","mode":"targeted","unit":"мл","precision":0,"aggregation":"add","target":"1200"},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":1,"rawValue":"Показатель 046","rawDenominator":"/30","resolution":"Показатель 065"}},{"owner":"memberB","title":"День без сладкого","why":"здоровье и красота","category":"Питание","config":{"schemaVersion":1,"repetition":{"kind":"monthly","n":"26"},"measurement":{"kind":"boolean"},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":1,"rawValue":"Показатель 056","rawDenominator":"/26","resolution":"Показатель 129"}},{"owner":"memberB","title":"Режим питания","why":"Показатель 151","category":"Питание","config":{"schemaVersion":1,"repetition":{"kind":"daily"},"measurement":{"kind":"boolean"},"checkpoints":{"aggregation":"all","items":[{"checkpointId":"10000000-0000-4000-8000-000000000004","name":"завтрак до 9:30","deadline":"09:30","satisfaction":{"kind":"boolean"}},{"checkpointId":"10000000-0000-4000-8000-000000000005","name":"обед 11:30–12:30","deadline":"12:30","satisfaction":{"kind":"boolean"}},{"checkpointId":"10000000-0000-4000-8000-000000000006","name":"ужин 18:30–20:00","deadline":"20:00","satisfaction":{"kind":"boolean"}}]}},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":2,"rawValue":"Показатель 118","rawDenominator":"/30","resolution":"Показатель 045"}},{"owner":"memberB","title":"Свежевыжатый сок","why":"здоровье и красота","category":"Питание","config":{"schemaVersion":1,"repetition":{"kind":"monthly","n":"8"},"measurement":{"kind":"boolean"},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":2,"rawValue":"Показатель 047","rawDenominator":"/8","resolution":"Flexible monthly Boolean N=8."}},{"owner":"memberB","title":"Витамин D","why":"здоровье","category":"Здоровье","config":{"schemaVersion":1,"repetition":{"kind":"daily"},"measurement":{"kind":"boolean"},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":2,"rawValue":"Показатель 031","rawDenominator":"/30","resolution":"Ежедневный Boolean."}},{"owner":"memberB","title":"Железо","why":"здоровье","category":"Здоровье","config":{"schemaVersion":1,"repetition":{"kind":"daily"},"measurement":{"kind":"boolean"},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":2,"rawValue":"ЖЕЛЕЗО – здоровье","rawDenominator":"/30","resolution":"Ежедневный Boolean."}},{"owner":"memberB","title":"Уход за волосами","why":"здоровье и красота","category":"Уход","config":{"schemaVersion":1,"repetition":{"kind":"monthly","n":"8"},"measurement":{"kind":"boolean"},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":2,"rawValue":"Показатель 125","rawDenominator":"/8","resolution":"Flexible monthly Boolean N=8."}},{"owner":"memberB","title":"Массаж лица","why":"Показатель 182","category":"Уход","config":{"schemaVersion":1,"repetition":{"kind":"monthly","n":"8"},"measurement":{"kind":"any_of","variants":[{"variantId":"10000000-0000-4000-8000-000000000007","label":"сделать массаж лица","unit":"раз","precision":0,"target":"1"},{"variantId":"10000000-0000-4000-8000-000000000008","label":"Показатель 186","unit":"раз","precision":0,"target":"1"}]},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":2,"rawValue":"Показатель 126","rawDenominator":"/8","resolution":"Показатель 083"}},{"owner":"memberB","title":"Медитации","why":"Показатель 169","category":"Самочувствие","config":{"schemaVersion":1,"repetition":{"kind":"monthly","n":"16"},"measurement":{"kind":"boolean"},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":3,"rawValue":"Показатель 123","rawDenominator":"/20","resolution":"Показатель 095"}},{"owner":"memberB","title":"Показатель 060","why":"Показатель 146","category":"Самочувствие","config":{"schemaVersion":1,"repetition":{"kind":"daily"},"measurement":{"kind":"boolean"},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":3,"rawValue":"Показатель 070","rawDenominator":"/30","resolution":"Показатель 067"}},{"owner":"memberB","title":"Показатель 136","why":"Показатель 162","category":"Активность","config":{"schemaVersion":1,"repetition":{"kind":"weekly","n":"2"},"measurement":{"kind":"any_of","variants":[{"variantId":"10000000-0000-4000-8000-000000000009","label":"фитнес-клуб","unit":"раз","precision":0,"target":"1"},{"variantId":"10000000-0000-4000-8000-000000000010","label":"тренировка дома","unit":"раз","precision":0,"target":"1"}]},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":3,"rawValue":"Показатель 101","rawDenominator":"/8","resolution":"Показатель 059"}},{"owner":"memberB","title":"МФР","why":"Показатель 173","category":"Активность","config":{"schemaVersion":1,"repetition":{"kind":"monthly","n":"8"},"measurement":{"kind":"boolean"},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":3,"rawValue":"Показатель 124","rawDenominator":"/8","resolution":"Показатель 016"}},{"owner":"memberB","title":"7000 шагов","why":"регулярная ходьба","category":"Активность","config":{"schemaVersion":1,"repetition":{"kind":"weekly","n":"5"},"measurement":{"kind":"quantity","mode":"targeted","unit":"шаги","precision":0,"aggregation":"latest","target":"7000"},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":3,"rawValue":"Показатель 109","rawDenominator":"/20","resolution":"Показатель 028"}},{"owner":"memberB","title":"Показатель 138","why":"Показатель 005","category":"Развитие","config":{"schemaVersion":1,"repetition":{"kind":"weekly","n":"2"},"measurement":{"kind":"any_of","variants":[{"variantId":"10000000-0000-4000-8000-000000000011","label":"чтение","unit":"страницы","precision":0,"target":"100"},{"variantId":"10000000-0000-4000-8000-000000000012","label":"аудиокнига","unit":"минуты","precision":0,"target":"60"}]},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":3,"rawValue":"Показатель 110","rawDenominator":"/8","resolution":"Показатель 027"}},{"owner":"shared","title":"Показатель 127","why":"Показатель 194","category":"Отношения","config":{"schemaVersion":1,"repetition":{"kind":"weekly","n":"2"},"measurement":{"kind":"any_of","variants":[{"variantId":"10000000-0000-4000-8000-000000000013","label":"фитнес-клуб","unit":"раз","precision":0,"target":"1"},{"variantId":"10000000-0000-4000-8000-000000000014","label":"кино","unit":"раз","precision":0,"target":"1"},{"variantId":"10000000-0000-4000-8000-000000000015","label":"свидание","unit":"раз","precision":0,"target":"1"},{"variantId":"10000000-0000-4000-8000-000000000016","label":"увлечение","unit":"раз","precision":0,"target":"1"},{"variantId":"10000000-0000-4000-8000-000000000017","label":"прогулка","unit":"раз","precision":0,"target":"1"}]},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":4,"rawValue":"Показатель 007","rawDenominator":"/10","resolution":"Показатель 058"}},{"owner":"memberB","title":"Расслабляющий вечер","why":"Показатель 174","category":"Самочувствие","config":{"schemaVersion":1,"repetition":{"kind":"monthly","n":"8"},"measurement":{"kind":"boolean"},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":4,"rawValue":"Показатель 119","rawDenominator":"/8","resolution":"Показатель 017"}},{"owner":"memberB","title":"Урок нового навыка","why":"Показатель 171","category":"Развитие","config":{"schemaVersion":1,"repetition":{"kind":"weekly","n":"1"},"measurement":{"kind":"boolean"},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":4,"rawValue":"Показатель 002","rawDenominator":"/4","resolution":"Показатель 025"}},{"owner":"memberB","title":"Показатель 111","why":"Показатель 141","category":"Контент","config":{"schemaVersion":1,"repetition":{"kind":"weekly","n":"2"},"measurement":{"kind":"checklist","items":[{"itemId":"10000000-0000-4000-8000-000000000018","label":"вк"},{"itemId":"10000000-0000-4000-8000-000000000019","label":"Дзен"},{"itemId":"10000000-0000-4000-8000-000000000020","label":"тик-ток"},{"itemId":"10000000-0000-4000-8000-000000000021","label":"инст"}]},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":4,"rawValue":"Показатель 079","rawDenominator":"/8","resolution":"Показатель 015"}},{"owner":"memberB","title":"Показатель 112","why":"Показатель 024","category":"Контент","config":{"schemaVersion":1,"repetition":{"kind":"weekly","n":"2"},"measurement":{"kind":"checklist","items":[{"itemId":"10000000-0000-4000-8000-000000000022","label":"Telegram"},{"itemId":"10000000-0000-4000-8000-000000000023","label":"Дзен"},{"itemId":"10000000-0000-4000-8000-000000000024","label":"MAX"}]},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":4,"rawValue":"Показатель 080","rawDenominator":"/8","resolution":"Показатель 014"}},{"owner":"memberB","title":"Показатель 075","why":"Показатель 183","category":"Работа","config":{"schemaVersion":1,"repetition":{"kind":"monthly","n":"1"},"measurement":{"kind":"quantity","mode":"targeted","unit":"коллаборации","precision":0,"aggregation":"add","target":"7"},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":5,"rawValue":"Показатель 077","rawDenominator":null,"resolution":"Показатель 021"}},{"owner":"memberB","title":"Поиск работы Участник А","why":"Показатель 172","category":"Работа","config":{"schemaVersion":1,"repetition":{"kind":"weekly","n":"3"},"measurement":{"kind":"boolean"},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":5,"rawValue":"Показатель 100","rawDenominator":"/12","resolution":"Показатель 037"}},{"owner":"memberB","title":"Показатель 097","why":"Показатель 191","category":"Проект","config":{"schemaVersion":1,"repetition":{"kind":"weekly","n":"5"},"measurement":{"kind":"boolean"},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":5,"rawValue":"Показатель 098","rawDenominator":"/20","resolution":"Показатель 026"}},{"owner":"memberB","title":"Командная публикация","why":"Показатель 176","category":"Контент","config":{"schemaVersion":1,"repetition":{"kind":"weekly","n":"2"},"measurement":{"kind":"any_of","variants":[{"variantId":"10000000-0000-4000-8000-000000000025","label":"ролик","unit":"публикация","precision":0,"target":"1"},{"variantId":"10000000-0000-4000-8000-000000000026","label":"Показатель 168","unit":"публикация","precision":0,"target":"1"},{"variantId":"10000000-0000-4000-8000-000000000027","label":"Показатель 018","unit":"публикация","precision":0,"target":"1"}]},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":5,"rawValue":"Показатель 107","rawDenominator":"/8","resolution":"Показатель 038"}},{"owner":"memberA","title":"Фитнес Участник А","why":"Показатель 162","category":"Активность","config":{"schemaVersion":1,"repetition":{"kind":"weekly","n":"2"},"measurement":{"kind":"boolean"},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":5,"rawValue":"Показатель 050","rawDenominator":"/8","resolution":"Показатель 034"}},{"owner":"memberA","title":"7000 шагов Участник А","why":"регулярная ходьба","category":"Активность","config":{"schemaVersion":1,"repetition":{"kind":"weekly","n":"5"},"measurement":{"kind":"quantity","mode":"targeted","unit":"шаги","precision":0,"aggregation":"latest","target":"7000"},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":5,"rawValue":"Показатель 109","rawDenominator":"/20","resolution":"Показатель 035"}},{"owner":"memberA","title":"Показатель 053","why":"Показатель 161","category":"Питание","config":{"schemaVersion":1,"repetition":{"kind":"daily"},"measurement":{"kind":"boolean"},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":5,"rawValue":"Показатель 052","rawDenominator":"/30","resolution":"Показатель 036"}},{"owner":"shared","title":"Общий порядок","why":"Показатель 147","category":"Дом","config":{"schemaVersion":1,"repetition":{"kind":"daily"},"measurement":{"kind":"boolean"},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":6,"rawValue":"Показатель 049","rawDenominator":"/30","resolution":"Показатель 023"}},{"owner":"memberA","title":"Показатель 054","why":"Показатель 161","category":"Питание","config":{"schemaVersion":1,"repetition":{"kind":"daily"},"measurement":{"kind":"boolean"},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":6,"rawValue":"Показатель 051","rawDenominator":"/30","resolution":"Показатель 036"}},{"owner":"shared","title":"Важная задача дня","why":"Показатель 160","category":"Фокус","config":{"schemaVersion":1,"repetition":{"kind":"daily"},"measurement":{"kind":"text"},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":6,"rawValue":"Показатель 001","rawDenominator":null,"resolution":"Показатель 022"}},{"owner":"memberB","title":"Outreach: неделя 1","why":"Показатель 158","category":"Работа","config":{"schemaVersion":1,"repetition":{"kind":"weekly_planned_task","weekOrdinal":"1","taskText":"Показатель 158"},"measurement":{"kind":"boolean"},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":6,"rawValue":"Показатель 003","rawDenominator":null,"resolution":"Владелец Участник Б; weekly_planned_task недели 1 без фиксированного дня."}},{"owner":"memberB","title":"Outreach: неделя 2","why":"Показатель 157","category":"Работа","config":{"schemaVersion":1,"repetition":{"kind":"weekly_planned_task","weekOrdinal":"2","taskText":"Показатель 157"},"measurement":{"kind":"boolean"},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":6,"rawValue":"Показатель 006","rawDenominator":null,"resolution":"Владелец Участник Б; weekly_planned_task недели 2 без фиксированного дня."}},{"owner":"memberB","title":"Outreach: неделя 3","why":"Показатель 184","category":"Работа","config":{"schemaVersion":1,"repetition":{"kind":"weekly_planned_task","weekOrdinal":"3","taskText":"Показатель 184"},"measurement":{"kind":"boolean"},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":6,"rawValue":"Показатель 008","rawDenominator":null,"resolution":"Владелец Участник Б; weekly_planned_task недели 3 без фиксированного дня."}},{"owner":"memberB","title":"Outreach: неделя 4","why":"глемпенги","category":"Работа","config":{"schemaVersion":1,"repetition":{"kind":"weekly_planned_task","weekOrdinal":"4","taskText":"глемпенги"},"measurement":{"kind":"boolean"},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":6,"rawValue":"Показатель 010","rawDenominator":null,"resolution":"Владелец Участник Б; weekly_planned_task недели 4 без фиксированного дня."}},{"owner":"memberB","title":"Outreach: неделя 5","why":"Показатель 195","category":"Работа","config":{"schemaVersion":1,"repetition":{"kind":"weekly_planned_task","weekOrdinal":"5","taskText":"Показатель 195"},"measurement":{"kind":"boolean"},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":6,"rawValue":"Показатель 011","rawDenominator":null,"resolution":"Владелец Участник Б; weekly_planned_task недели 5 без фиксированного дня."}},{"owner":"memberB","title":"Показатель 062","why":"Показатель 153","category":"Работа","config":{"schemaVersion":1,"repetition":{"kind":"monthly","n":"1"},"measurement":{"kind":"quantity","mode":"informational","unit":"руб.","precision":0,"aggregation":"add","target":null},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":7,"rawValue":"Показатель 076","rawDenominator":null,"resolution":"Показатель 061"}},{"owner":"memberB","title":"Показатель 088","why":"Показатель 178","category":"Контент","config":{"schemaVersion":1,"repetition":{"kind":"monthly","n":"1"},"measurement":{"kind":"quantity","mode":"targeted","unit":"подписчики","precision":0,"aggregation":"latest","target":"50"},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":7,"rawValue":"Показатель 090","rawDenominator":"/50","resolution":"Показатель 020"}},{"owner":"memberB","title":"Показатель 087","why":"рост аудитории MAX","category":"Контент","config":{"schemaVersion":1,"repetition":{"kind":"monthly","n":"1"},"measurement":{"kind":"quantity","mode":"informational","unit":"подписчики","precision":0,"aggregation":"latest","target":null},"checkpoints":null},"sourceProvenance":{"schemaVersion":1,"sourceDocument":"monthly-plan-template","sourcePage":7,"rawValue":"Показатель 089","rawDenominator":null,"resolution":"Показатель 019"}}]$p11_manifest$::jsonb;
BEGIN
  SELECT count(*)::int,
         count(*) FILTER (WHERE detached_at IS NULL)::int,
         COALESCE(array_agg(id ORDER BY display_order, id)
           FILTER (WHERE detached_at IS NULL), ARRAY[]::UUID[]),
         COALESCE(array_agg(goal_definition_id ORDER BY display_order, id)
           FILTER (WHERE detached_at IS NULL), ARRAY[]::UUID[])
    INTO root_count, active_root_count, current_root_order,
         current_definition_order
    FROM plan_draft_goals
   WHERE plan_month_id = target_month;

  SELECT count(*)::int INTO revision_count
    FROM plan_draft_goal_revisions revision
    JOIN plan_draft_goals root ON root.id = revision.plan_goal_id
   WHERE root.plan_month_id = target_month;
  SELECT count(*)::int INTO definition_count
    FROM goal_definitions
   WHERE id = ANY(definition_order) AND space_id = target_space;
  SELECT count(*)::int INTO series_count
    FROM goal_series WHERE goal_definition_id = ANY(definition_order);
  SELECT count(*)::int INTO version_count
    FROM goal_definition_versions
   WHERE goal_definition_id = ANY(definition_order);
  SELECT count(*)::int INTO catalog_change_count
    FROM planning_goal_catalog_changes change
   WHERE change.goal_definition_id = ANY(definition_order);
  SELECT count(*)::int INTO publication_count
    FROM plan_publications WHERE plan_month_id = target_month;
  SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'owner', CASE
                 WHEN revision.scope_kind = 'shared' THEN 'shared'
                 WHEN revision.owner_member_id = member_a_member THEN 'memberA'
                 WHEN revision.owner_member_id = member_b_member THEN 'memberB'
                 ELSE 'invalid'
               END,
               'title', version.title,
               'why', version.why,
               'category', version.category,
               'config', revision.config - 'scope',
               'sourceProvenance', revision.source_provenance
             )
             ORDER BY root.display_order, root.id
           ),
           '[]'::jsonb
         )
    INTO current_manifest
    FROM plan_draft_goals root
    JOIN plan_draft_goal_revisions revision
      ON revision.plan_goal_id = root.id
     AND revision.id = root.current_revision_id
    JOIN goal_definition_versions version
      ON version.id = revision.goal_definition_version_id
   WHERE root.plan_month_id = target_month
     AND root.detached_at IS NULL;

  IF root_count <> 41 OR active_root_count <> 41 OR revision_count <> 41
     OR definition_count <> 41 OR series_count <> 41 OR version_count <> 41
     OR catalog_change_count <> 0 OR publication_count <> 0
     OR current_root_order <> root_order
     OR current_definition_order <> definition_order
     OR current_manifest <> expected_manifest THEN
    RETURN FALSE;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM unnest(root_order, definition_order) WITH ORDINALITY
        AS expected(root_id, definition_id, ordinal)
      LEFT JOIN plan_draft_goals root ON root.id = expected.root_id
      LEFT JOIN plan_draft_goal_revisions revision
        ON revision.plan_goal_id = root.id
       AND revision.id = root.current_revision_id
      LEFT JOIN goal_definitions definition
        ON definition.id = expected.definition_id
      LEFT JOIN goal_definition_versions version
        ON version.goal_definition_id = definition.id
       AND version.id = revision.goal_definition_version_id
      LEFT JOIN goal_series series
        ON series.goal_definition_id = definition.id
       AND series.id = revision.goal_series_id
     WHERE root.id IS NULL
        OR root.plan_month_id <> target_month
        OR root.space_id <> target_space
        OR root.goal_definition_id <> expected.definition_id
        OR root.display_order <> expected.ordinal - 1
        OR root.detached_at IS NOT NULL
        OR root.attached_at <> event_time
        OR root.created_at <> event_time
        OR root.updated_at <> event_time
        OR revision.id IS NULL
        OR revision.space_id <> target_space
        OR revision.goal_definition_id <> expected.definition_id
        OR revision.revision_number <> 1
        OR revision.created_at <> event_time
        OR revision.scope_kind NOT IN ('personal', 'shared')
        OR (revision.scope_kind = 'personal'
            AND revision.owner_member_id NOT IN (member_a_member, member_b_member))
        OR (revision.scope_kind = 'shared'
            AND revision.owner_member_id IS NOT NULL)
        OR definition.id IS NULL
        OR definition.space_id <> target_space
        OR definition.state <> 'active'
        OR definition.revision <> 1
        OR definition.archived_at IS NOT NULL
        OR definition.created_at <> event_time
        OR definition.updated_at <> event_time
        OR version.id IS NULL
        OR version.version_number <> 1
        OR version.series_decision <> 'new'
        OR version.created_at <> event_time
        OR series.id IS NULL
        OR series.created_at <> event_time
  ) THEN
    RETURN FALSE;
  END IF;
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION "p11_seed_consumption_has_exact_shape"(seed_action UUID)
RETURNS BOOLEAN AS $$
DECLARE
  change planning_seed_consumptions%ROWTYPE;
  parent planning_action_groups%ROWTYPE;
  receipt command_receipts%ROWTYPE;
  destination plan_months%ROWTYPE;
  draft plan_drafts%ROWTYPE;
  member_count INTEGER;
BEGIN
  SELECT * INTO change FROM planning_seed_consumptions
   WHERE action_id = seed_action;
  SELECT * INTO parent FROM planning_action_groups WHERE id = seed_action;
  SELECT * INTO receipt FROM command_receipts
   WHERE actor_scope = parent.actor_scope
     AND command_type = parent.command_type
     AND command_id = parent.command_id;
  SELECT * INTO destination FROM plan_months WHERE id = change.plan_month_id;
  SELECT * INTO draft FROM plan_drafts WHERE plan_month_id = change.plan_month_id;
  SELECT count(*)::int INTO member_count FROM memberships
   WHERE space_id = change.space_id;

  RETURN (
    change.action_id IS NOT NULL
    AND change.seed_id = 'april-plan'
    AND change.seed_version = 1
    AND change.seed_schema_version = 'planner.april-plan-seed.v1'
    AND change.seeded_goal_count = 41
    AND change.member_a_member_id <> change.member_b_member_id
    AND member_count = 2
    AND parent.id = change.action_id
    AND parent.action_kind = 'draft_created_from_seed'
    AND parent.command_type = 'planning.create-draft-from-seed.v1'
    AND parent.actor_kind = 'member'
    AND parent.member_id = CASE change.actor_persona
      WHEN 'memberA' THEN change.member_a_member_id
      WHEN 'memberB' THEN change.member_b_member_id
    END
    AND parent.plan_month_id = change.plan_month_id
    AND parent.before_revision IS NULL
    AND parent.after_revision = 1
    AND destination.id = change.plan_month_id
    AND destination.space_id = change.space_id
    AND destination.status = 'draft'
    AND destination.revision = 1
    AND destination.facts_revision = 0
    AND destination.active_publication_id IS NULL
    AND destination.created_at = parent.occurred_at
    AND destination.updated_at = parent.occurred_at
    AND draft.plan_month_id = destination.id
    AND draft.focus = 'Показатель 108'
    AND draft.revision = 1
    AND draft.created_at = parent.occurred_at
    AND draft.updated_at = parent.occurred_at
    AND receipt.result_kind = 'planning.plan-draft.v1'
    AND receipt.aggregate_id = destination.id
    AND receipt.aggregate_revision = 1
    AND receipt.completed_at = parent.occurred_at
    AND p11_seed_goals_have_exact_shape(
      destination.id,
      destination.space_id,
      parent.occurred_at,
      change.member_a_member_id,
      change.member_b_member_id,
      change.goal_definition_ids,
      change.after_order
    )
  ) IS TRUE;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION "require_p11_seed_consumption_effect"()
RETURNS TRIGGER AS $$
BEGIN
  IF p11_seed_consumption_has_exact_shape(NEW.action_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'planning_seed_consumption_effect_mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "planning_seed_consumption_effect_consistent"
AFTER INSERT ON "planning_seed_consumptions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_p11_seed_consumption_effect"();

CREATE FUNCTION "require_p11_seed_consumption_detail"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.action_kind = 'draft_created_from_seed' AND NOT EXISTS (
    SELECT 1 FROM planning_seed_consumptions WHERE action_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'planning_seed_consumption_required'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "planning_seed_action_requires_consumption"
AFTER INSERT ON "planning_action_groups"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_p11_seed_consumption_detail"();

CREATE FUNCTION "require_p11_seed_receipt_effect"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.command_type = 'planning.create-draft-from-seed.v1'
     AND NOT EXISTS (
       SELECT 1
         FROM planning_action_groups action
         JOIN planning_seed_consumptions change ON change.action_id = action.id
        WHERE action.actor_scope = NEW.actor_scope
          AND action.command_type = NEW.command_type
          AND action.command_id = NEW.command_id
          AND action.action_kind = 'draft_created_from_seed'
          AND action.plan_month_id = NEW.aggregate_id
          AND action.before_revision IS NULL
          AND action.after_revision = NEW.aggregate_revision
          AND action.occurred_at = NEW.completed_at
          AND p11_seed_consumption_has_exact_shape(action.id)
     ) THEN
    RAISE EXCEPTION 'seed receipt requires exact P11 action and consumption'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "command_receipts_seed_effect_consistent"
AFTER INSERT ON "command_receipts"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_p11_seed_receipt_effect"();

CREATE TRIGGER "planning_seed_consumptions_reject_update_delete"
BEFORE UPDATE OR DELETE ON "planning_seed_consumptions"
FOR EACH ROW EXECUTE FUNCTION "reject_p01_immutable_row_change"();
