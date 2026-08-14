CREATE TABLE telegram_ingress_state (
  consumer_key VARCHAR(64) PRIMARY KEY,
  next_update_id BIGINT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT telegram_ingress_state_singleton_check CHECK (
    consumer_key = 'local-get-updates.v1'
  ),
  CONSTRAINT telegram_ingress_state_offset_check CHECK (
    next_update_id BETWEEN 0 AND 4503599627370496
  ),
  CONSTRAINT telegram_ingress_state_revision_check CHECK (revision >= 0)
);

INSERT INTO telegram_ingress_state
  (consumer_key, next_update_id, revision)
VALUES ('local-get-updates.v1', 0, 0);

CREATE FUNCTION guard_telegram_ingress_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'telegram ingress state cannot be deleted'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.consumer_key <> 'local-get-updates.v1'
       OR NEW.next_update_id <> 0
       OR NEW.revision <> 0 THEN
      RAISE EXCEPTION 'telegram ingress state insert is invalid'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.consumer_key <> OLD.consumer_key
     OR NEW.next_update_id <= OLD.next_update_id
     OR NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'telegram ingress state transition is invalid'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := GREATEST(OLD.updated_at, clock_timestamp());
  RETURN NEW;
END;
$$;

CREATE TRIGGER telegram_ingress_state_guard
BEFORE INSERT OR UPDATE OR DELETE ON telegram_ingress_state
FOR EACH ROW EXECUTE FUNCTION guard_telegram_ingress_state();
