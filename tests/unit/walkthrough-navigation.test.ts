import { describe, expect, it } from 'vitest';
import { primaryDestinations } from '../../apps/web/src/components/mobile-nav';

describe('walkthrough navigation', () => {
  it('keeps the assignment walkthrough available from primary navigation', () => {
    expect(primaryDestinations).toContainEqual(expect.objectContaining({ label: 'Walkthrough', to: '/walkthrough' }));
  });
});
