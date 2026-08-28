import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Cato Tailwind theme tokens', () => {
  it('registers every shadcn semantic color and the amber palette accent', () => {
    const css = readFileSync(new URL('../../apps/web/src/styles/globals.css', import.meta.url), 'utf8');
    for (const token of ['card', 'card-foreground', 'secondary', 'secondary-foreground', 'accent', 'accent-foreground', 'destructive', 'input', 'ring']) {
      expect(css).toContain(`--color-${token}: var(--${token});`);
    }
    expect(css).toContain('#f5c13d');
  });
});
