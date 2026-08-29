ALTER TABLE runs DROP CONSTRAINT runs_status_check;
--> statement-breakpoint
ALTER TABLE runs ADD CONSTRAINT runs_status_check CHECK (status IN (
  'created','retrieving','specialists_running','synthesizing','validating',
  'awaiting_approval','finalizing','completed','rejected','failed','cancelled'
));
