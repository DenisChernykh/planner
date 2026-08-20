CREATE TABLE reminder_schedules (
  id UUID PRIMARY KEY,
  space_id UUID NOT NULL,
  member_id UUID NOT NULL UNIQUE,
  revision BIGINT NOT NULL DEFAULT 1,
  time_zone VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL,
  updated_at TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT reminder_schedules_revision_check CHECK (revision > 0),
  CONSTRAINT reminder_schedules_time_zone_check
    CHECK (time_zone = 'Asia/Yekaterinburg'),
  CONSTRAINT reminder_schedules_member_fkey
    FOREIGN KEY (space_id, member_id)
    REFERENCES memberships (space_id, id)
    ON UPDATE CASCADE
    ON DELETE RESTRICT,
  CONSTRAINT reminder_schedules_id_space_key UNIQUE (space_id, id),
  CONSTRAINT reminder_schedules_space_id_id_member_key UNIQUE (space_id, id, member_id)
);

CREATE TABLE reminder_schedule_slots (
  id UUID PRIMARY KEY,
  schedule_id UUID NOT NULL,
  slot_kind VARCHAR(16) NOT NULL,
  local_time TIME(0),
  next_due_at TIMESTAMPTZ(3),
  created_at TIMESTAMPTZ(3) NOT NULL,
  updated_at TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT reminder_schedule_slots_kind_check
    CHECK (slot_kind IN ('morning', 'day', 'evening')),
  CONSTRAINT reminder_schedule_slots_time_due_check
    CHECK (local_time IS NOT NULL OR next_due_at IS NULL),
  CONSTRAINT reminder_schedule_slots_schedule_fkey
    FOREIGN KEY (schedule_id)
    REFERENCES reminder_schedules (id)
    ON UPDATE CASCADE
    ON DELETE RESTRICT,
  CONSTRAINT reminder_schedule_slots_schedule_kind_key
    UNIQUE (schedule_id, slot_kind)
);

CREATE INDEX reminder_schedule_slots_due_scan_idx
  ON reminder_schedule_slots (next_due_at, slot_kind, id);

CREATE TABLE reminder_occurrences (
  id UUID PRIMARY KEY,
  space_id UUID NOT NULL,
  recipient_member_id UUID NOT NULL,
  schedule_id UUID NOT NULL,
  local_date DATE NOT NULL,
  slot_kind VARCHAR(16) NOT NULL,
  schedule_revision BIGINT NOT NULL,
  due_at TIMESTAMPTZ(3) NOT NULL,
  expires_at TIMESTAMPTZ(3) NOT NULL,
  state VARCHAR(16) NOT NULL,
  lease_owner VARCHAR(128),
  lease_until TIMESTAMPTZ(3),
  fencing_token BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ(3) NOT NULL,
  updated_at TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT reminder_occurrences_kind_check
    CHECK (slot_kind IN ('morning', 'day', 'evening')),
  CONSTRAINT reminder_occurrences_state_check
    CHECK (state IN ('pending', 'claimed', 'cancelled', 'expired')),
  CONSTRAINT reminder_occurrences_revision_check
    CHECK (schedule_revision > 0),
  CONSTRAINT reminder_occurrences_window_check
    CHECK (due_at < expires_at),
  CONSTRAINT reminder_occurrences_fence_check
    CHECK (fencing_token >= 0),
  CONSTRAINT reminder_occurrences_lease_check
    CHECK (
      (state = 'claimed' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL)
      OR (state <> 'claimed' AND lease_owner IS NULL AND lease_until IS NULL)
    ),
  CONSTRAINT reminder_occurrences_recipient_fkey
    FOREIGN KEY (space_id, recipient_member_id)
    REFERENCES memberships (space_id, id)
    ON UPDATE CASCADE
    ON DELETE RESTRICT,
  CONSTRAINT reminder_occurrences_schedule_fkey
    FOREIGN KEY (space_id, schedule_id, recipient_member_id)
    REFERENCES reminder_schedules (space_id, id, member_id)
    ON UPDATE CASCADE
    ON DELETE RESTRICT,
  CONSTRAINT reminder_occurrences_recipient_date_slot_key
    UNIQUE (recipient_member_id, local_date, slot_kind)
);

CREATE INDEX reminder_occurrences_due_scan_idx
  ON reminder_occurrences (state, due_at, expires_at, id);

CREATE INDEX reminder_occurrences_schedule_slot_idx
  ON reminder_occurrences (schedule_id, slot_kind, local_date, state);

CREATE TABLE reminder_schedule_changes (
  action_id UUID PRIMARY KEY,
  schedule_id UUID NOT NULL,
  space_id UUID NOT NULL,
  member_id UUID NOT NULL,
  actor_scope VARCHAR(64) NOT NULL,
  command_type VARCHAR(128) NOT NULL,
  command_id UUID NOT NULL,
  before_revision BIGINT,
  after_revision BIGINT NOT NULL,
  before_morning TIME(0),
  before_day TIME(0),
  before_evening TIME(0),
  after_morning TIME(0),
  after_day TIME(0),
  after_evening TIME(0),
  occurred_at TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT reminder_schedule_changes_revision_check
    CHECK (after_revision > 0 AND (before_revision IS NULL OR before_revision > 0)),
  CONSTRAINT reminder_schedule_changes_schedule_fkey
    FOREIGN KEY (space_id, schedule_id, member_id)
    REFERENCES reminder_schedules (space_id, id, member_id)
    ON UPDATE CASCADE
    ON DELETE RESTRICT,
  CONSTRAINT reminder_schedule_changes_member_fkey
    FOREIGN KEY (space_id, member_id)
    REFERENCES memberships (space_id, id)
    ON UPDATE CASCADE
    ON DELETE RESTRICT,
  CONSTRAINT reminder_schedule_changes_receipt_fkey
    FOREIGN KEY (actor_scope, command_type, command_id)
    REFERENCES command_receipts (actor_scope, command_type, command_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT reminder_schedule_changes_receipt_key
    UNIQUE (actor_scope, command_type, command_id)
);

CREATE OR REPLACE FUNCTION guard_reminder_schedule_slots_order()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  morning TIME(0);
  day_slot TIME(0);
  evening TIME(0);
BEGIN
  SELECT
    max(local_time) FILTER (WHERE slot_kind = 'morning'),
    max(local_time) FILTER (WHERE slot_kind = 'day'),
    max(local_time) FILTER (WHERE slot_kind = 'evening')
  INTO morning, day_slot, evening
  FROM reminder_schedule_slots
  WHERE schedule_id = NEW.schedule_id;

  IF morning IS NOT NULL AND day_slot IS NOT NULL AND morning >= day_slot THEN
    RAISE EXCEPTION 'Reminder slots are not ordered';
  END IF;
  IF day_slot IS NOT NULL AND evening IS NOT NULL AND day_slot >= evening THEN
    RAISE EXCEPTION 'Reminder slots are not ordered';
  END IF;
  IF morning IS NOT NULL AND evening IS NOT NULL AND morning >= evening THEN
    RAISE EXCEPTION 'Reminder slots are not ordered';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER reminder_schedule_slots_order_trigger
AFTER INSERT OR UPDATE ON reminder_schedule_slots
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION guard_reminder_schedule_slots_order();

CREATE FUNCTION require_reminder_schedule_change_effect()
RETURNS TRIGGER AS $$
DECLARE
  receipt command_receipts%ROWTYPE;
BEGIN
  SELECT * INTO receipt
    FROM command_receipts
   WHERE actor_scope = NEW.actor_scope
     AND command_type = NEW.command_type
     AND command_id = NEW.command_id;

  IF (
    NEW.actor_scope = 'member:' || NEW.member_id::text
    AND NEW.command_type = 'reminders.save-schedule.v1'
    AND receipt.result_kind = 'reminders.schedule.v1'
    AND receipt.aggregate_id = NEW.schedule_id
    AND receipt.aggregate_revision = NEW.after_revision
    AND receipt.completed_at = NEW.occurred_at
    AND (
      (NEW.before_revision IS NULL AND NEW.after_revision = 1)
      OR (NEW.before_revision IS NOT NULL
          AND NEW.after_revision = NEW.before_revision + 1)
    )
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'reminder_schedule_change_effect_mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER reminder_schedule_change_effect_consistent
AFTER INSERT ON reminder_schedule_changes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_reminder_schedule_change_effect();

CREATE FUNCTION require_reminder_schedule_receipt_effect()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.command_type = 'reminders.save-schedule.v1'
     AND (
       NEW.result_kind <> 'reminders.schedule.v1'
       OR NOT EXISTS (
         SELECT 1
           FROM reminder_schedule_changes change
          WHERE change.actor_scope = NEW.actor_scope
            AND change.command_type = NEW.command_type
            AND change.command_id = NEW.command_id
            AND change.schedule_id = NEW.aggregate_id
            AND change.after_revision = NEW.aggregate_revision
            AND change.occurred_at = NEW.completed_at
       )
     ) THEN
    RAISE EXCEPTION 'reminder schedule receipt requires exact change'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER reminder_schedule_receipt_effect_consistent
AFTER INSERT ON command_receipts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_reminder_schedule_receipt_effect();

CREATE OR REPLACE FUNCTION reject_reminder_schedule_change_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Reminder schedule history is immutable';
END;
$$;

CREATE TRIGGER reminder_schedule_changes_immutable_update
BEFORE UPDATE ON reminder_schedule_changes
FOR EACH ROW EXECUTE FUNCTION reject_reminder_schedule_change_mutation();

CREATE TRIGGER reminder_schedule_changes_immutable_delete
BEFORE DELETE ON reminder_schedule_changes
FOR EACH ROW EXECUTE FUNCTION reject_reminder_schedule_change_mutation();
