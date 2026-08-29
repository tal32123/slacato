import { describe, expect, it } from 'vitest';
import { formatDealAmount } from '../../apps/web/src/features/deals/deal-format';

describe('deal amount formatting', () => {
  it('uses the deal currency when present and a number-only fallback otherwise', () => {
    expect(formatDealAmount({ amount: 125_000, currency: 'USD' })).toBe('$125,000');
    expect(formatDealAmount({ amount: 125_000, currency: null })).toBe('125,000');
    expect(formatDealAmount({ amount: null, currency: 'EUR' })).toBe('Not recorded');
  });
});
