import { describe, expect, it } from 'vitest';
import { primaryDestinations } from '../../apps/web/src/components/mobile-nav';

describe('primary navigation', () => {
  it('keeps only the four protected workspace destinations', () => {
    expect(primaryDestinations.map(({ label, to }) => ({ label, to }))).toEqual([
      { label: 'Deals', to: '/deals' },
      { label: 'Runs', to: '/runs' },
      { label: 'Approvals', to: '/approvals' },
      { label: 'Settings', to: '/settings' }
    ]);
    expect(primaryDestinations).not.toContainEqual(expect.objectContaining({ to: '/walkthrough' }));
  });
});
