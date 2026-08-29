// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AccountApprovalAuthorityView } from '@slacato/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionMatrix } from '../../apps/web/src/components/permission-matrix';

afterEach(cleanup);

describe('PermissionMatrix', () => {
  it('renders approval authority separately when the persona has no source grants', () => {
    const approvalAuthorities: readonly AccountApprovalAuthorityView[] = [
      { accountId: 'ACC-2003', authorities: ['legal_reviewer'] }
    ];
    render(createElement(PermissionMatrix, {
      grants: [],
      approvalAuthorities
    }));

    expect(screen.getByText('This persona has no source permissions in the canonical fixture.')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Account approval authority matrix' })).toHaveTextContent('ACC-2003');
    expect(screen.getByRole('table', { name: 'Account approval authority matrix' })).toHaveTextContent('Legal Reviewer');
  });
});
