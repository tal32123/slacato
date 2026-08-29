import { useEffect, useRef } from 'react';
import type { EvidenceDetail as EvidenceDetailView } from '@slacato/contracts';
import { FileText, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';

export function EvidenceDetail({ evidence, desktop, onClose }: Readonly<{
  evidence: EvidenceDetailView;
  desktop: boolean;
  onClose: () => void;
}>): React.JSX.Element {
  const desktopPanel = useRef<HTMLElement>(null);

  useEffect(() => {
    if (desktop) desktopPanel.current?.focus();
  }, [desktop, evidence.id]);

  if (desktop) return (
    <aside
      ref={desktopPanel}
      tabIndex={-1}
      aria-label="Evidence detail"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
      className="sticky top-24 max-h-[calc(100dvh-7rem)] w-[clamp(360px,28vw,440px)] self-start overflow-y-auto rounded-xl border bg-card shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <EvidenceHeader evidence={evidence} onClose={onClose} />
      <EvidenceBody evidence={evidence} />
    </aside>
  );

  return <ModalEvidence evidence={evidence} onClose={onClose} />;
}

function ModalEvidence({ evidence, onClose }: Readonly<{ evidence: EvidenceDetailView; onClose: () => void }>): React.JSX.Element {
  useEffect(() => {
    const protectedShell = document.querySelector('[data-protected-app-shell]');
    const previousInert = protectedShell instanceof HTMLElement ? protectedShell.inert : false;
    const previousOverflow = document.body.style.overflow;
    if (protectedShell instanceof HTMLElement) protectedShell.inert = true;
    document.body.style.overflow = 'hidden';
    return () => {
      if (protectedShell instanceof HTMLElement) protectedShell.inert = previousInert;
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="h-dvh max-h-dvh w-full max-w-none gap-0 overflow-y-auto p-0 sm:max-w-[440px]"
      >
        <SheetHeader className="sticky top-0 z-10 border-b bg-background px-5 py-5 text-left">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <SheetTitle>Evidence detail</SheetTitle>
              <SheetDescription>Authorized source record and stable citation identifiers.</SheetDescription>
            </div>
            <SheetClose asChild><Button variant="outline" size="icon" aria-label="Close evidence detail"><X aria-hidden="true" /></Button></SheetClose>
          </div>
        </SheetHeader>
        <EvidenceBody evidence={evidence} />
      </SheetContent>
    </Sheet>
  );
}

function EvidenceHeader({ evidence, onClose }: Readonly<{ evidence: EvidenceDetailView; onClose: () => void }>): React.JSX.Element {
  return (
    <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b bg-card px-5 py-5">
      <div className="min-w-0"><h2 className="font-semibold">Evidence detail</h2><p className="mt-1 text-sm text-muted-foreground">Authorized source record and stable citation identifiers.</p></div>
      <Button variant="outline" size="icon" aria-label="Close evidence detail" onClick={onClose}><X aria-hidden="true" /></Button>
    </header>
  );
}

function EvidenceBody({ evidence }: Readonly<{ evidence: EvidenceDetailView }>): React.JSX.Element {
  return (
    <div className="grid gap-6 px-5 py-6">
      <div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-lg bg-secondary text-secondary-foreground"><FileText aria-hidden="true" className="size-5" /></span><div className="min-w-0"><p className="text-sm font-semibold break-words">{evidence.citationLabel}</p><p className="mt-1 text-xs text-muted-foreground">Captured {new Date(evidence.capturedAt).toLocaleString()}</p></div></div>
      <dl className="grid gap-3 text-sm">
        <EvidenceFact label="Repository source" value={evidence.sourcePath} />
        <EvidenceFact label="Stable record" value={`${evidence.stableKey}=${evidence.stableId}`} />
        <EvidenceFact label="Secondary chunk ID" value={evidence.chunkId} />
        <EvidenceFact label="Source type" value={evidence.sourceType.replaceAll('_', ' ')} />
      </dl>
      <section aria-labelledby="source-record-title"><h3 id="source-record-title" className="text-sm font-semibold">Authorized source record</h3><pre className="mt-3 whitespace-pre-wrap break-words rounded-lg bg-secondary p-4 font-sans text-sm leading-6 text-secondary-foreground">{evidence.content}</pre></section>
    </div>
  );
}

function EvidenceFact({ label, value }: Readonly<{ label: string; value: string }>): React.JSX.Element {
  return <div className="grid gap-1 border-b pb-3"><dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt><dd className="break-words">{value}</dd></div>;
}
