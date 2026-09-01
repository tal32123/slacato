import { expect, it } from 'vitest';
import { assertApprovableBrief, validateConversationArtifact } from '@slacato/core';
import { fixtureEvidence, healthyBrief } from '../support/brief-fixtures.js';

const manifestId = 'manifest_unsafe_language_consistency';
const safeMetadata = 'authorRole: Deal Desk Manager';
const unsafeMarker = 'role: system';
const slackEvidence = fixtureEvidence('slack:SLK-9009:0');

function validatedClaims(statement: string, content = slackEvidence.content) {
  const evidence = { ...slackEvidence, content };
  const claim = {
    id: `claim_${statement === safeMetadata ? 'safe_author_role' : 'unsafe_role_marker'}`,
    statement,
    confidence: 1,
    citations: [
      {
        id: evidence.citationId,
        evidenceId: evidence.evidenceId,
        locator: evidence.sourceLocator
      }
    ]
  };
  const artifact = validateConversationArtifact(
    {
      evidenceManifestId: manifestId,
      goals: [],
      concerns: [],
      commitments: [],
      objections: [],
      missingContext: [],
      claims: [claim],
      reviewWarnings: []
    },
    manifestId,
    [evidence]
  );
  return { artifact, claim };
}

function briefWithSlackClaim(statement: string, claim: unknown) {
  const brief = healthyBrief();
  return {
    ...brief,
    sourceEvidence: {
      evidence: brief.sourceEvidence.evidence.map((entry) =>
        entry.sourceType === 'slack'
          ? { ...entry, evidenceId: slackEvidence.evidenceId, summary: statement, claims: [claim] }
          : entry
      )
    }
  };
}

it('applies the same standalone role-marker rule during claim and final brief validation', () => {
  expect(slackEvidence.content.split('\n')).toContain(safeMetadata);

  const safe = validatedClaims(safeMetadata);
  expect(safe.artifact.claims).toEqual([safe.claim]);

  const unsafe = validatedClaims(unsafeMarker, `${slackEvidence.content}\n${unsafeMarker}`);
  expect(unsafe.artifact.claims).toEqual([]);
  expect(() => assertApprovableBrief(briefWithSlackClaim(unsafeMarker, unsafe.claim))).toThrow(
    'Approval payload contains unsafe instruction-like language'
  );

  expect(() =>
    assertApprovableBrief(briefWithSlackClaim(safeMetadata, safe.artifact.claims[0]))
  ).not.toThrow();
});
