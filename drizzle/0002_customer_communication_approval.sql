CREATE OR REPLACE FUNCTION public.backfill_legacy_deal_brief_action_audience(input jsonb) RETURNS jsonb
    LANGUAGE sql
    IMMUTABLE
    STRICT
    AS $$
SELECT CASE
  WHEN jsonb_typeof(input) <> 'object'
    OR NOT input ?& ARRAY[
      'dealSnapshot',
      'executiveSummary',
      'buyerGoalsAndBusinessDrivers',
      'stakeholderMap',
      'negotiationState',
      'recommendedNextActions',
      'missingInformation',
      'sourceEvidence',
      'confidenceAndReviewWarnings'
    ]::text[]
    OR jsonb_typeof(input #> '{recommendedNextActions,actions}') <> 'array'
  THEN input
  ELSE jsonb_set(
    input,
    '{recommendedNextActions,actions}',
    COALESCE(
      (
        SELECT jsonb_agg(
          CASE
            WHEN jsonb_typeof(action.value) = 'object' AND NOT action.value ? 'audience'
            THEN action.value || '{"audience":"customer"}'::jsonb
            ELSE action.value
          END
          ORDER BY action.ordinality
        )
        FROM jsonb_array_elements(input #> '{recommendedNextActions,actions}')
          WITH ORDINALITY AS action(value, ordinality)
      ),
      '[]'::jsonb
    ),
    false
  )
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.canonical_jsonb_text(input jsonb) RETURNS text
    LANGUAGE sql
    IMMUTABLE
    STRICT
    AS $$
SELECT CASE jsonb_typeof(input)
  WHEN 'object' THEN
    '{' || COALESCE(
      (
        SELECT string_agg(to_jsonb(member.key)::text || ':' || public.canonical_jsonb_text(member.value), ',' ORDER BY member.key)
        FROM jsonb_each(input) AS member(key, value)
      ),
      ''
    ) || '}'
  WHEN 'array' THEN
    '[' || COALESCE(
      (
        SELECT string_agg(public.canonical_jsonb_text(element.value), ',' ORDER BY element.ordinality)
        FROM jsonb_array_elements(input) WITH ORDINALITY AS element(value, ordinality)
      ),
      ''
    ) || ']'
  ELSE input::text
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.canonical_jsonb_sha256(input jsonb) RETURNS text
    LANGUAGE sql
    IMMUTABLE
    STRICT
    AS $$
SELECT encode(sha256(convert_to(public.canonical_jsonb_text(input), 'UTF8')), 'hex');
$$;
--> statement-breakpoint
ALTER TABLE "approval_requirement_entries" DROP CONSTRAINT IF EXISTS "approval_requirement_entries_category_check";
--> statement-breakpoint
ALTER TABLE "approval_requirement_entries" DROP CONSTRAINT IF EXISTS "approval_requirement_entries_category_ck";
--> statement-breakpoint
ALTER TABLE "approval_requirement_entries" ADD CONSTRAINT "approval_requirement_entries_category_ck" CHECK ("category" in ('commercial_discount','legal_terms','evidence_review','customer_communication','customer_concession'));
--> statement-breakpoint
DROP TABLE IF EXISTS public.legacy_deal_brief_audience_hash_backfill;
--> statement-breakpoint
CREATE TABLE public.legacy_deal_brief_audience_hash_backfill (
  run_id text NOT NULL,
  old_hash text NOT NULL,
  new_hash text NOT NULL,
  old_recommendation_ids jsonb,
  new_recommendation_ids jsonb
);
--> statement-breakpoint
DROP TABLE IF EXISTS public.legacy_deal_brief_audience_live_subject_backfill;
--> statement-breakpoint
CREATE TABLE public.legacy_deal_brief_audience_live_subject_backfill (
  subject_id text PRIMARY KEY,
  run_id text NOT NULL
);
--> statement-breakpoint
INSERT INTO public.legacy_deal_brief_audience_hash_backfill
  (run_id, old_hash, new_hash, old_recommendation_ids, new_recommendation_ids)
SELECT subject.run_id,
  subject.subject_hash,
  public.canonical_jsonb_sha256(migrated.payload),
  subject.recommendation_ids,
  (
    SELECT COALESCE(
      jsonb_agg(
        to_jsonb(
          format(
            'recommendation:%s:%s',
            action.ordinality - 1,
            left(public.canonical_jsonb_sha256(action.value), 16)
          )
        )
        ORDER BY action.ordinality
      ),
      '[]'::jsonb
    )
    FROM jsonb_array_elements(migrated.payload #> '{recommendedNextActions,actions}')
      WITH ORDINALITY AS action(value, ordinality)
  )
FROM approval_subjects AS subject
CROSS JOIN LATERAL (
  SELECT public.backfill_legacy_deal_brief_action_audience(subject.payload) AS payload
) AS migrated
WHERE subject.payload IS DISTINCT FROM migrated.payload;
--> statement-breakpoint
INSERT INTO public.legacy_deal_brief_audience_live_subject_backfill (subject_id, run_id)
SELECT subject.id, subject.run_id
FROM approval_subjects AS subject
JOIN runs AS run ON run.id = subject.run_id
CROSS JOIN LATERAL (
  SELECT public.backfill_legacy_deal_brief_action_audience(subject.payload) AS payload
) AS migrated
WHERE run.status = 'awaiting_approval'
  AND subject.superseded_by_subject_id IS NULL
  AND subject.payload IS DISTINCT FROM migrated.payload;
--> statement-breakpoint
INSERT INTO public.legacy_deal_brief_audience_hash_backfill (run_id, old_hash, new_hash)
SELECT checkpoint.run_id,
  checkpoint.payload->>'subjectHash',
  public.canonical_jsonb_sha256(migrated.payload)
FROM workflow_checkpoints AS checkpoint
CROSS JOIN LATERAL (
  SELECT public.backfill_legacy_deal_brief_action_audience(checkpoint.payload->'payload') AS payload
) AS migrated
WHERE checkpoint.payload->>'subjectHash' IS NOT NULL
  AND checkpoint.payload->'payload' IS DISTINCT FROM migrated.payload;
--> statement-breakpoint
INSERT INTO public.legacy_deal_brief_audience_hash_backfill (run_id, old_hash, new_hash)
SELECT subject.run_id,
  decision.approved_subject_hash,
  public.canonical_jsonb_sha256(migrated.payload)
FROM approval_decisions AS decision
JOIN approval_subjects AS subject ON subject.id = decision.approval_subject_id
CROSS JOIN LATERAL (
  SELECT public.backfill_legacy_deal_brief_action_audience(decision.approved_payload) AS payload
) AS migrated
WHERE decision.approved_payload IS DISTINCT FROM migrated.payload;
--> statement-breakpoint
ALTER TABLE approval_subjects DISABLE TRIGGER approval_subjects_immutable;
--> statement-breakpoint
WITH migrated AS MATERIALIZED (
  SELECT subject.id,
    public.backfill_legacy_deal_brief_action_audience(subject.payload) AS payload
  FROM approval_subjects AS subject
)
UPDATE approval_subjects AS subject
SET payload = migrated.payload,
  subject_hash = public.canonical_jsonb_sha256(migrated.payload),
  recommendation_ids = (
    SELECT COALESCE(
      jsonb_agg(
        to_jsonb(
          format(
            'recommendation:%s:%s',
            action.ordinality - 1,
            left(public.canonical_jsonb_sha256(action.value), 16)
          )
        )
        ORDER BY action.ordinality
      ),
      '[]'::jsonb
    )
    FROM jsonb_array_elements(migrated.payload #> '{recommendedNextActions,actions}')
      WITH ORDINALITY AS action(value, ordinality)
  )
FROM migrated
WHERE subject.id = migrated.id
  AND subject.payload IS DISTINCT FROM migrated.payload;
--> statement-breakpoint
UPDATE approval_subjects AS subject
SET policy_triggers =
  CASE
    WHEN subject.policy_triggers @> '["customer_facing_language"]'::jsonb
    THEN subject.policy_triggers
    ELSE subject.policy_triggers || '["customer_facing_language"]'::jsonb
  END
FROM public.legacy_deal_brief_audience_live_subject_backfill AS live
WHERE subject.id = live.subject_id;
--> statement-breakpoint
ALTER TABLE approval_subjects ENABLE TRIGGER approval_subjects_immutable;
--> statement-breakpoint
DROP TABLE IF EXISTS public.legacy_deal_brief_customer_requirement_backfill;
--> statement-breakpoint
CREATE TABLE public.legacy_deal_brief_customer_requirement_backfill (
  subject_id text PRIMARY KEY,
  entry_id text NOT NULL
);
--> statement-breakpoint
ALTER TABLE approval_requirement_entries
  DISABLE TRIGGER approval_requirement_entries_immutable;
--> statement-breakpoint
INSERT INTO approval_requirement_entries
  (
    id,
    approval_subject_id,
    category,
    eligible_authorities,
    policy_triggers,
    depends_on,
    ordinal
  )
SELECT 'approval:customer_communication:account_owner:legacy-audience',
  live.subject_id,
  'customer_communication',
  '["account_owner"]'::jsonb,
  '["customer_facing_language"]'::jsonb,
  COALESCE(
    (
      SELECT jsonb_agg(to_jsonb(existing.id) ORDER BY existing.ordinal, existing.id)
      FROM approval_requirement_entries AS existing
      WHERE existing.approval_subject_id = live.subject_id
    ),
    '[]'::jsonb
  ),
  COALESCE(
    (
      SELECT max(existing.ordinal) + 1
      FROM approval_requirement_entries AS existing
      WHERE existing.approval_subject_id = live.subject_id
    ),
    0
  )
FROM public.legacy_deal_brief_audience_live_subject_backfill AS live
WHERE NOT EXISTS (
  SELECT 1
  FROM approval_requirement_entries AS existing
  WHERE existing.approval_subject_id = live.subject_id
    AND existing.category IN ('customer_communication', 'customer_concession')
    AND existing.eligible_authorities @> '["account_owner"]'::jsonb
    AND NOT EXISTS (
      SELECT 1
      FROM approval_decisions AS decision
      WHERE decision.approval_subject_id = existing.approval_subject_id
        AND decision.entry_id = existing.id
    )
);
--> statement-breakpoint
INSERT INTO public.legacy_deal_brief_customer_requirement_backfill (subject_id, entry_id)
SELECT DISTINCT ON (live.subject_id) live.subject_id, entry.id
FROM public.legacy_deal_brief_audience_live_subject_backfill AS live
JOIN approval_requirement_entries AS entry
  ON entry.approval_subject_id = live.subject_id
WHERE entry.category IN ('customer_communication', 'customer_concession')
  AND entry.eligible_authorities @> '["account_owner"]'::jsonb
  AND NOT EXISTS (
    SELECT 1
    FROM approval_decisions AS decision
    WHERE decision.approval_subject_id = entry.approval_subject_id
      AND decision.entry_id = entry.id
  )
ORDER BY live.subject_id,
  CASE WHEN entry.category = 'customer_communication' THEN 0 ELSE 1 END,
  entry.ordinal,
  entry.id;
--> statement-breakpoint
UPDATE approval_requirement_entries AS entry
SET category = 'customer_communication',
  eligible_authorities = '["account_owner"]'::jsonb,
  policy_triggers = merged.policy_triggers
FROM public.legacy_deal_brief_customer_requirement_backfill AS canonical
CROSS JOIN LATERAL (
  SELECT jsonb_agg(to_jsonb(trigger_name) ORDER BY trigger_name) AS policy_triggers
  FROM (
    SELECT DISTINCT jsonb_array_elements_text(existing.policy_triggers) AS trigger_name
    FROM approval_requirement_entries AS existing
    WHERE existing.approval_subject_id = canonical.subject_id
      AND existing.category IN ('customer_communication', 'customer_concession')
      AND existing.eligible_authorities @> '["account_owner"]'::jsonb
    UNION
    SELECT 'customer_facing_language'
  ) AS triggers
) AS merged
WHERE entry.approval_subject_id = canonical.subject_id
  AND entry.id = canonical.entry_id;
--> statement-breakpoint
WITH duplicates AS MATERIALIZED (
  SELECT entry.approval_subject_id AS subject_id,
    entry.id AS duplicate_entry_id,
    canonical.entry_id AS canonical_entry_id
  FROM approval_requirement_entries AS entry
  JOIN public.legacy_deal_brief_customer_requirement_backfill AS canonical
    ON canonical.subject_id = entry.approval_subject_id
  WHERE entry.id <> canonical.entry_id
    AND entry.category IN ('customer_communication', 'customer_concession')
    AND entry.eligible_authorities @> '["account_owner"]'::jsonb
    AND NOT EXISTS (
      SELECT 1
      FROM approval_decisions AS decision
      WHERE decision.approval_subject_id = entry.approval_subject_id
        AND decision.entry_id = entry.id
    )
),
rebuilt AS MATERIALIZED (
  SELECT requirement.approval_subject_id,
    requirement.id,
    (
      SELECT COALESCE(
        jsonb_agg(to_jsonb(mapped.dependency_id) ORDER BY mapped.first_ordinal),
        '[]'::jsonb
      )
      FROM (
        SELECT COALESCE(duplicate.canonical_entry_id, dependency.value) AS dependency_id,
          min(dependency.ordinality) AS first_ordinal
        FROM jsonb_array_elements_text(requirement.depends_on)
          WITH ORDINALITY AS dependency(value, ordinality)
        LEFT JOIN duplicates AS duplicate
          ON duplicate.subject_id = requirement.approval_subject_id
          AND duplicate.duplicate_entry_id = dependency.value
        WHERE COALESCE(duplicate.canonical_entry_id, dependency.value) <> requirement.id
        GROUP BY COALESCE(duplicate.canonical_entry_id, dependency.value)
      ) AS mapped
    ) AS depends_on
  FROM approval_requirement_entries AS requirement
  JOIN public.legacy_deal_brief_customer_requirement_backfill AS canonical
    ON canonical.subject_id = requirement.approval_subject_id
)
UPDATE approval_requirement_entries AS requirement
SET depends_on = rebuilt.depends_on
FROM rebuilt
WHERE requirement.approval_subject_id = rebuilt.approval_subject_id
  AND requirement.id = rebuilt.id
  AND requirement.depends_on IS DISTINCT FROM rebuilt.depends_on;
--> statement-breakpoint
WITH duplicates AS (
  SELECT entry.approval_subject_id AS subject_id, entry.id AS entry_id
  FROM approval_requirement_entries AS entry
  JOIN public.legacy_deal_brief_customer_requirement_backfill AS canonical
    ON canonical.subject_id = entry.approval_subject_id
  WHERE entry.id <> canonical.entry_id
    AND entry.category IN ('customer_communication', 'customer_concession')
    AND entry.eligible_authorities @> '["account_owner"]'::jsonb
    AND NOT EXISTS (
      SELECT 1
      FROM approval_decisions AS decision
      WHERE decision.approval_subject_id = entry.approval_subject_id
        AND decision.entry_id = entry.id
    )
)
DELETE FROM approval_requirement_entries AS entry
USING duplicates
WHERE entry.approval_subject_id = duplicates.subject_id
  AND entry.id = duplicates.entry_id;
--> statement-breakpoint
ALTER TABLE approval_requirement_entries
  ENABLE TRIGGER approval_requirement_entries_immutable;
--> statement-breakpoint
ALTER TABLE briefs DISABLE TRIGGER briefs_finalized_immutable;
--> statement-breakpoint
WITH migrated AS MATERIALIZED (
  SELECT brief.id,
    public.backfill_legacy_deal_brief_action_audience(brief.payload) AS payload
  FROM briefs AS brief
)
UPDATE briefs AS brief
SET payload = migrated.payload,
  subject_hash = public.canonical_jsonb_sha256(migrated.payload)
FROM migrated
WHERE brief.id = migrated.id
  AND brief.payload IS DISTINCT FROM migrated.payload;
--> statement-breakpoint
ALTER TABLE briefs ENABLE TRIGGER briefs_finalized_immutable;
--> statement-breakpoint
ALTER TABLE approval_decisions DISABLE TRIGGER approval_decisions_immutable;
--> statement-breakpoint
WITH migrated AS MATERIALIZED (
  SELECT decision.id,
    public.backfill_legacy_deal_brief_action_audience(decision.original_payload) AS original_payload,
    public.backfill_legacy_deal_brief_action_audience(decision.approved_payload) AS approved_payload,
    public.backfill_legacy_deal_brief_action_audience(decision.edited_payload) AS edited_payload
  FROM approval_decisions AS decision
)
UPDATE approval_decisions AS decision
SET original_payload = migrated.original_payload,
  approved_payload = migrated.approved_payload,
  edited_payload = migrated.edited_payload,
  original_subject_hash = public.canonical_jsonb_sha256(migrated.original_payload),
  approved_subject_hash = public.canonical_jsonb_sha256(migrated.approved_payload)
FROM migrated
WHERE decision.id = migrated.id
  AND (
    decision.original_payload IS DISTINCT FROM migrated.original_payload
    OR decision.approved_payload IS DISTINCT FROM migrated.approved_payload
    OR decision.edited_payload IS DISTINCT FROM migrated.edited_payload
  );
--> statement-breakpoint
ALTER TABLE approval_decisions ENABLE TRIGGER approval_decisions_immutable;
--> statement-breakpoint
WITH migrated AS MATERIALIZED (
  SELECT checkpoint.id,
    checkpoint.payload,
    public.backfill_legacy_deal_brief_action_audience(checkpoint.payload->'value') AS strategy_value,
    public.backfill_legacy_deal_brief_action_audience(checkpoint.payload->'payload') AS validated_payload
  FROM workflow_checkpoints AS checkpoint
),
strategy_rebuilt AS MATERIALIZED (
  SELECT migrated.id,
    migrated.payload AS original_payload,
    migrated.validated_payload,
    CASE
      WHEN migrated.payload ? 'value'
      THEN jsonb_set(
        migrated.payload,
        '{value}',
        migrated.strategy_value,
        false
      )
      ELSE migrated.payload
    END AS payload
  FROM migrated
),
brief_rebuilt AS MATERIALIZED (
  SELECT strategy_rebuilt.id,
    strategy_rebuilt.original_payload,
    strategy_rebuilt.validated_payload,
    CASE
      WHEN strategy_rebuilt.original_payload ? 'payload'
      THEN jsonb_set(
        strategy_rebuilt.payload,
        '{payload}',
        strategy_rebuilt.validated_payload,
        false
      )
      ELSE strategy_rebuilt.payload
    END AS payload
  FROM strategy_rebuilt
),
rebuilt AS MATERIALIZED (
  SELECT brief_rebuilt.id,
    CASE
      WHEN brief_rebuilt.original_payload->'payload'
        IS DISTINCT FROM brief_rebuilt.validated_payload
        AND brief_rebuilt.original_payload ? 'subjectHash'
      THEN brief_rebuilt.payload || jsonb_build_object(
        'subjectHash',
        public.canonical_jsonb_sha256(brief_rebuilt.validated_payload)
      )
      ELSE brief_rebuilt.payload
    END AS payload
  FROM brief_rebuilt
)
UPDATE workflow_checkpoints AS checkpoint
SET payload = rebuilt.payload
FROM rebuilt
WHERE checkpoint.id = rebuilt.id
  AND checkpoint.payload IS DISTINCT FROM rebuilt.payload;
--> statement-breakpoint
WITH migrated AS MATERIALIZED (
  SELECT artifact.id,
    public.backfill_legacy_deal_brief_action_audience(artifact.content) AS content
  FROM specialist_artifacts AS artifact
  WHERE artifact.kind = 'strategy'
)
UPDATE specialist_artifacts AS artifact
SET content = migrated.content,
  content_hash = public.canonical_jsonb_sha256(migrated.content)
FROM migrated
WHERE artifact.id = migrated.id
  AND artifact.content IS DISTINCT FROM migrated.content;
--> statement-breakpoint
WITH migrated AS MATERIALIZED (
  SELECT command.id,
    command.payload,
    public.backfill_legacy_deal_brief_action_audience(command.payload->'payload') AS brief
  FROM outbox_commands AS command
  WHERE command.type = 'process-deal-brief-step'
    AND command.payload->>'step' = 'finalize'
),
rebuilt AS MATERIALIZED (
  SELECT migrated.id,
    jsonb_set(migrated.payload, '{payload}', migrated.brief, false)
      || CASE
        WHEN migrated.payload ? 'subjectHash'
        THEN jsonb_build_object(
          'subjectHash',
          public.canonical_jsonb_sha256(migrated.brief)
        )
        ELSE '{}'::jsonb
      END AS payload
  FROM migrated
  WHERE migrated.payload->'payload' IS DISTINCT FROM migrated.brief
)
UPDATE outbox_commands AS command
SET payload = rebuilt.payload
FROM rebuilt
WHERE command.id = rebuilt.id;
--> statement-breakpoint
ALTER TABLE trace_spans DISABLE TRIGGER trace_spans_append_only;
--> statement-breakpoint
WITH hash_mapping AS (
  SELECT run_id, old_hash, min(new_hash) AS new_hash
  FROM public.legacy_deal_brief_audience_hash_backfill
  WHERE old_hash <> new_hash
  GROUP BY run_id, old_hash
)
UPDATE trace_spans AS span
SET payload =
  CASE
    WHEN span.payload->>'subjectHash' = mapping.old_hash
    THEN jsonb_set(
      span.payload,
      '{subjectHash}',
      to_jsonb(mapping.new_hash),
      false
    )
    ELSE jsonb_set(
      span.payload,
      '{artifactHash}',
      to_jsonb(mapping.new_hash),
      false
    )
  END
FROM hash_mapping AS mapping
WHERE span.run_id = mapping.run_id
  AND (
    span.payload->>'subjectHash' = mapping.old_hash
    OR span.payload->>'artifactHash' = mapping.old_hash
  );
--> statement-breakpoint
WITH recommendation_mapping AS (
  SELECT DISTINCT run_id, old_recommendation_ids, new_recommendation_ids
  FROM public.legacy_deal_brief_audience_hash_backfill
  WHERE old_recommendation_ids IS NOT NULL
    AND old_recommendation_ids IS DISTINCT FROM new_recommendation_ids
)
UPDATE trace_spans AS span
SET payload = jsonb_set(
  span.payload,
  '{recommendationIds}',
  mapping.new_recommendation_ids,
  false
)
FROM recommendation_mapping AS mapping
WHERE span.run_id = mapping.run_id
  AND span.payload->'recommendationIds' = mapping.old_recommendation_ids;
--> statement-breakpoint
ALTER TABLE trace_spans ENABLE TRIGGER trace_spans_append_only;
--> statement-breakpoint
DROP TABLE public.legacy_deal_brief_customer_requirement_backfill;
--> statement-breakpoint
DROP TABLE public.legacy_deal_brief_audience_live_subject_backfill;
--> statement-breakpoint
DROP TABLE public.legacy_deal_brief_audience_hash_backfill;
--> statement-breakpoint
DROP FUNCTION public.canonical_jsonb_sha256(jsonb);
--> statement-breakpoint
DROP FUNCTION public.canonical_jsonb_text(jsonb);
--> statement-breakpoint
DROP FUNCTION public.backfill_legacy_deal_brief_action_audience(jsonb);
--> statement-breakpoint
