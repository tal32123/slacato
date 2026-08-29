import { Link } from 'react-router';
import { LockKeyhole } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AccessState } from './unauthorized';

/** Explains that the current persona lacks permission to open the requested page. */
export function ForbiddenRoute(): React.JSX.Element {
  return (
    <AccessState
      eyebrow="Permission boundary"
      title="This workspace is not available"
      detail="The active persona cannot access this resource. No account, evidence, or restricted-opportunity details have been disclosed."
      icon={LockKeyhole}
      action={<Button asChild><Link to="/login">Change persona</Link></Button>}
    />
  );
}
