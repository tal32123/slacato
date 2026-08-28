ALTER TABLE permission_grants ADD COLUMN IF NOT EXISTS can_read_restricted boolean NOT NULL DEFAULT false;
