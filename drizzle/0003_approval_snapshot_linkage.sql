DO $$ BEGIN
  ALTER TABLE approval_subjects ADD CONSTRAINT approval_subjects_id_run_hash_uq UNIQUE (id, run_id, subject_hash);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE briefs ADD CONSTRAINT briefs_approval_subject_snapshot_fk FOREIGN KEY (approval_subject_id, run_id, subject_hash) REFERENCES approval_subjects(id, run_id, subject_hash);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
