ALTER TABLE trace_spans DROP CONSTRAINT IF EXISTS trace_spans_run_id_fkey;
ALTER TABLE trace_spans ADD COLUMN IF NOT EXISTS trace_id text;
ALTER TABLE trace_spans ADD COLUMN IF NOT EXISTS span_id text;
ALTER TABLE trace_spans ADD COLUMN IF NOT EXISTS step text;
ALTER TABLE trace_spans ADD COLUMN IF NOT EXISTS attempt integer;

UPDATE trace_spans SET
  trace_id = coalesce(trace_id, 'trace_' || md5(run_id)),
  span_id = coalesce(span_id, id),
  step = coalesce(step, kind),
  attempt = coalesce(attempt, 1)
WHERE trace_id IS NULL OR span_id IS NULL OR step IS NULL OR attempt IS NULL;

ALTER TABLE trace_spans ALTER COLUMN trace_id SET NOT NULL;
ALTER TABLE trace_spans ALTER COLUMN span_id SET NOT NULL;
ALTER TABLE trace_spans ALTER COLUMN step SET NOT NULL;
ALTER TABLE trace_spans ALTER COLUMN attempt SET NOT NULL;
ALTER TABLE trace_spans ADD CONSTRAINT trace_spans_attempt_ck CHECK (attempt > 0);
ALTER TABLE trace_spans ADD CONSTRAINT trace_spans_run_span_uq UNIQUE (run_id, span_id);
ALTER TABLE trace_spans ADD CONSTRAINT trace_spans_parent_fk
  FOREIGN KEY (run_id, parent_id) REFERENCES trace_spans(run_id, span_id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX IF NOT EXISTS trace_spans_run_started_idx ON trace_spans(run_id, started_at, span_id);
CREATE INDEX IF NOT EXISTS trace_spans_trace_idx ON trace_spans(trace_id, started_at, span_id);

ALTER TABLE run_events ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE run_events ADD CONSTRAINT run_events_version_ck CHECK (version > 0);
CREATE INDEX IF NOT EXISTS run_events_run_created_idx ON run_events(run_id, created_at, sequence);

CREATE OR REPLACE FUNCTION reject_observability_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trace_spans_append_only ON trace_spans;
CREATE TRIGGER trace_spans_append_only BEFORE UPDATE OR DELETE ON trace_spans
FOR EACH ROW EXECUTE FUNCTION reject_observability_mutation();

DROP TRIGGER IF EXISTS run_events_append_only ON run_events;
CREATE TRIGGER run_events_append_only BEFORE UPDATE OR DELETE ON run_events
FOR EACH ROW EXECUTE FUNCTION reject_observability_mutation();

DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_observability_mutation();
