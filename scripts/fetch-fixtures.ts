import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANONICAL_FIXTURE_COMMIT,
  CANONICAL_FIXTURE_REPOSITORY,
  CANONICAL_SOURCE_FILES
} from '../packages/core/src/index.js';

export const PINNED_REPOSITORY = CANONICAL_FIXTURE_REPOSITORY;
export const PINNED_COMMIT = CANONICAL_FIXTURE_COMMIT;
export const CANONICAL_FILES = CANONICAL_SOURCE_FILES;

export type FixtureAttribution = Readonly<{
  repository: string;
  commit: string;
  sourceCommittedAt: string;
  files: readonly Readonly<{ path: string; sha256: string }>[];
  note: string;
}>;
export type FixtureFetchOptions = Readonly<{
  repository: string;
  commit: string;
  destination: string;
  files: readonly string[];
}>;

/** Runs a Git command in the temporary repository used to collect canonical fixtures. */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}

/** Fetches only an explicit commit and copies only an allowlisted synthetic-data inventory. */
export function fetchCanonicalFixtures(options: FixtureFetchOptions): FixtureAttribution {
  if (!/^[0-9a-f]{40}$/.test(options.commit))
    throw new Error('Pinned fixture revision must be a lowercase 40-character SHA-1');
  if (options.files.length === 0) throw new Error('Canonical fixture inventory must not be empty');
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'slacato-canonical-'));
  try {
    git(temporaryRoot, ['init', '-q']);
    git(temporaryRoot, ['remote', 'add', 'origin', options.repository]);
    git(temporaryRoot, ['fetch', '--quiet', '--depth=1', 'origin', options.commit]);
    const resolvedCommit = git(temporaryRoot, ['rev-parse', 'FETCH_HEAD']).trim();
    if (resolvedCommit !== options.commit)
      throw new Error(
        `Fixture revision mismatch: expected ${options.commit}, received ${resolvedCommit}`
      );
    const sourceCommittedAt = git(temporaryRoot, [
      'show',
      '-s',
      '--format=%cI',
      'FETCH_HEAD'
    ]).trim();
    const files = options.files.map((path) => {
      if (path.startsWith('/') || path.includes('..') || path.includes('\\'))
        throw new Error(`Unsafe fixture path: ${path}`);
      const content = execFileSync('git', ['show', `FETCH_HEAD:synthetic_data/${path}`], {
        cwd: temporaryRoot,
        maxBuffer: 8 * 1024 * 1024
      });
      const destination = join(options.destination, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content);
      return { path, sha256: createHash('sha256').update(content).digest('hex') };
    });
    const attribution: FixtureAttribution = {
      repository: options.repository,
      commit: resolvedCommit,
      sourceCommittedAt,
      files,
      note: 'Canonical synthetic files copied verbatim. Slack fixtures are candidate-generated and attributed separately.'
    };
    mkdirSync(options.destination, { recursive: true });
    writeFileSync(
      join(options.destination, 'source-attribution.json'),
      `${JSON.stringify(attribution, null, 2)}\n`
    );
    return attribution;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

/** Runs the canonical-fixture fetch CLI and reports the verified revision. */
function main(): void {
  const destination = resolve(process.cwd(), 'fixtures/cato');
  const result = fetchCanonicalFixtures({
    repository: PINNED_REPOSITORY,
    commit: PINNED_COMMIT,
    destination,
    files: CANONICAL_FILES
  });
  process.stdout.write(
    `Verified ${result.commit}; copied ${result.files.length} canonical files.\n`
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main();
