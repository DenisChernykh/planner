CREATE TABLE "spaces" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "singleton_key" SMALLINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spaces_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "spaces_singleton_key_check" CHECK ("singleton_key" = 1),
    CONSTRAINT "spaces_singleton_key_key" UNIQUE ("singleton_key")
);

CREATE TABLE "memberships" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "space_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "slot" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "memberships_slot_check" CHECK ("slot" IN (1, 2)),
    CONSTRAINT "memberships_space_id_slot_key" UNIQUE ("space_id", "slot"),
    CONSTRAINT "memberships_space_id_user_id_key" UNIQUE ("space_id", "user_id"),
    CONSTRAINT "memberships_user_id_key" UNIQUE ("user_id"),
    CONSTRAINT "memberships_space_id_fkey" FOREIGN KEY ("space_id")
      REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id")
      REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "telegram_access_allowlist" (
    "space_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "telegram_id" BIGINT NOT NULL,

    CONSTRAINT "telegram_access_allowlist_pkey" PRIMARY KEY ("space_id", "user_id"),
    CONSTRAINT "telegram_access_allowlist_user_id_key" UNIQUE ("user_id"),
    CONSTRAINT "telegram_access_allowlist_telegram_id_key" UNIQUE ("telegram_id"),
    CONSTRAINT "telegram_access_allowlist_membership_fkey"
      FOREIGN KEY ("space_id", "user_id")
      REFERENCES "memberships"("space_id", "user_id")
      ON DELETE RESTRICT ON UPDATE CASCADE
);
