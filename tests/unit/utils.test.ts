import { describe, expect, it } from 'vitest';
import { cn } from '../../apps/web/src/lib/utils';

describe('cn', () => {
  it('merges conflicting Tailwind classes', () => {
    expect(cn('p-2', false, 'p-4')).toBe('p-4');
  });
});
