import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Cato Tailwind theme tokens', () => {
  it('registers every shadcn semantic color and the amber palette accent', () => {
    const css = readFileSync(new URL('../../apps/web/src/styles/globals.css', import.meta.url), 'utf8');
    for (const token of [
      'background', 'foreground', 'card', 'card-foreground', 'popover', 'popover-foreground',
      'primary', 'primary-foreground', 'secondary', 'secondary-foreground', 'muted',
      'muted-foreground', 'accent', 'accent-foreground', 'destructive', 'destructive-foreground',
      'border', 'input', 'ring'
    ]) {
      expect(css).toContain(`--color-${token}: var(--${token});`);
    }
    expect(css).toContain('#f5c13d');
  });
});
