import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The technical overview is a graded deliverable that also has to be reachable from the running
 * app, so a copy lives in the web app's public directory. Two copies drift the moment someone edits
 * one, and the served page silently becomes the stale one - this is the only thing stopping that.
 *
 * The served copy is excluded from biome for the same reason docs/ is: linting it would hold a
 * byte-for-byte copy to rules the original is exempt from, and the only way to satisfy them would
 * be to edit the deliverable to suit its own copy.
 */
describe('served documentation', () => {
  it('serves the same technical overview the repository ships', () => {
    const doc = readFileSync('docs/technical-overview.html', 'utf8');
    const served = readFileSync('apps/web/public/technical-overview.html', 'utf8');
    expect(served).toBe(doc);
  });
});
