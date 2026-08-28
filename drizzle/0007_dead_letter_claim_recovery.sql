ALTER TABLE outbox_commands DROP CONSTRAINT IF EXISTS outbox_commands_status_check;
ALTER TABLE outbox_commands ADD CONSTRAINT outbox_commands_status_check CHECK (status IN ('pending','claimed','published','dead_letter_claimed','dead_letter'));
