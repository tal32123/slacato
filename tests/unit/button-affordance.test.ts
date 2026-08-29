// @vitest-environment jsdom

import { createElement } from 'react';
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from '../../apps/web/src/components/ui/button';

describe('Button', () => {
  it('uses a pointer cursor to identify an enabled button as interactive', () => {
    render(createElement(Button, undefined, 'Generate brief'));

    expect(screen.getByRole('button', { name: 'Generate brief' })).toHaveClass('cursor-pointer');
  });
});
