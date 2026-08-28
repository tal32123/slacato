import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fetchCanonicalFixtures } from '../../scripts/fetch-fixtures.js';

describe('canonical fixture fetch', () => {
  it('copies only the expected files from a verified pinned revision', () => {
    const root = mkdtempSync(join(tmpdir(), 'slacato-fetch-test-'));
    const source = join(root, 'source');
    const destination = join(root, 'fixtures');
    mkdirSync(join(source, 'synthetic_data/salesforce'), { recursive: true });
    writeFileSync(join(source, 'synthetic_data/salesforce/accounts.tsv'), 'account_id\taccount_name\nACC-1\tFixture\n');
    execFileSync('git', ['init', '-q'], { cwd: source });
    execFileSync('git', ['add', '.'], { cwd: source });
    execFileSync('git', ['-c', 'user.name=SlaCato Test', '-c', 'user.email=test@slacato.example', 'commit', '-qm', 'fixture'], { cwd: source });
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();

    const attribution = fetchCanonicalFixtures({
      repository: source,
      commit,
      destination,
      files: ['salesforce/accounts.tsv']
    });

    expect(readFileSync(join(destination, 'salesforce/accounts.tsv'), 'utf8')).toContain('ACC-1');
    expect(attribution).toMatchObject({ repository: source, commit, files: [{ path: 'salesforce/accounts.tsv' }] });
    expect(JSON.parse(readFileSync(join(destination, 'source-attribution.json'), 'utf8'))).toEqual(attribution);
  });

  it('rejects a revision that does not equal the requested hash', () => {
    expect(() => fetchCanonicalFixtures({
      repository: '/does/not/matter', commit: 'not-a-sha', destination: '/does/not/matter', files: []
    })).toThrow(/40-character/i);
  });
});
