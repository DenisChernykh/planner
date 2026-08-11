ALTER TABLE "telegram_access_allowlist"
  ADD CONSTRAINT "telegram_access_allowlist_user_id_telegram_id_key"
  UNIQUE ("user_id", "telegram_id");

CREATE TABLE "telegram_external_identities" (
    "issuer" VARCHAR(255) NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "provider_user_id" BIGINT NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_external_identities_pkey"
      PRIMARY KEY ("issuer", "subject"),
    CONSTRAINT "telegram_external_identities_issuer_check"
      CHECK ("issuer" = 'https://oauth.telegram.org'),
    CONSTRAINT "telegram_external_identities_subject_check"
      CHECK (length("subject") > 0),
    CONSTRAINT "telegram_external_identities_provider_user_id_check"
      CHECK ("provider_user_id" BETWEEN 1 AND 4503599627370495),
    CONSTRAINT "telegram_external_identities_issuer_provider_user_id_key"
      UNIQUE ("issuer", "provider_user_id"),
    CONSTRAINT "telegram_external_identities_issuer_user_id_key"
      UNIQUE ("issuer", "user_id"),
    CONSTRAINT "telegram_external_identities_allowlist_fkey"
      FOREIGN KEY ("user_id", "provider_user_id")
      REFERENCES "telegram_access_allowlist"("user_id", "telegram_id")
      ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE FUNCTION "reject_telegram_external_identity_update"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'telegram_external_identities rows are immutable'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "telegram_external_identities_reject_update"
BEFORE UPDATE ON "telegram_external_identities"
FOR EACH ROW
EXECUTE FUNCTION "reject_telegram_external_identity_update"();
