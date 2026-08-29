import { AlertTriangle, CheckCircle2, CircleDashed, LockKeyhole } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const statusPresentation = {
  ready: {
    label: 'Ready',
    icon: CheckCircle2,
    className: 'border-primary/25 bg-secondary text-secondary-foreground'
  },
  attention: {
    label: 'Needs attention',
    icon: AlertTriangle,
    className: 'border-attention/50 bg-attention/20 text-attention-foreground'
  },
  unavailable: {
    label: 'Unavailable',
    icon: CircleDashed,
    className: 'border-border bg-muted text-muted-foreground'
  },
  readonly: {
    label: 'Read-only',
    icon: LockKeyhole,
    className: 'border-primary/25 bg-secondary text-secondary-foreground'
  }
} as const;

export type ProductStatus = keyof typeof statusPresentation;

/** Presents a product status with consistent wording, color, and iconography. */
export function StatusBadge({
  status,
  label
}: Readonly<{ status: ProductStatus; label?: string }>): React.JSX.Element {
  const presentation = statusPresentation[status];
  const Icon = presentation.icon;
  return (
    <Badge variant="outline" className={cn('gap-1.5 py-1', presentation.className)}>
      <Icon aria-hidden="true" />
      {label ?? presentation.label}
    </Badge>
  );
}
