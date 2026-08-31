import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildFixtureSet,
  CANONICAL_SOURCE_FILES,
  type FixtureSet
} from '../packages/core/src/index.js';

/**
 * Reads the canonical fixture tree from disk and hands the raw, unmodified content to the
 * pure, filesystem-free validator in `@slacato/core`. This is the only place in the ingest
 * pipeline that touches the filesystem for fixture data — `packages/core` stays substitutable
 * runtime code with zero I/O of its own.
 */
export function parseFixtureSet(root: string): FixtureSet {
  const attributionJson: unknown = JSON.parse(
    readFileSync(join(root, 'source-attribution.json'), 'utf8')
  );
  const sourceFileContents = new Map<string, string>(
    CANONICAL_SOURCE_FILES.map((path) => [path, readFileSync(join(root, path), 'utf8')])
  );
  const transcriptFileNames = readdirSync(join(root, 'gong/transcripts'));
  const slackContent = readFileSync(join(root, 'slack/account_team_updates.tsv'), 'utf8');
  const slackGenerationJson: unknown = JSON.parse(
    readFileSync(join(root, 'slack/generation.json'), 'utf8')
  );

  return buildFixtureSet({
    attributionJson,
    sourceFileContents,
    transcriptFileNames,
    slackContent,
    slackGenerationJson
  });
}
