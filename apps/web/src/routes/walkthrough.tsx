import { useMemo, useState } from 'react';
import {
  ArrowRight,
  BookOpenCheck,
  Check,
  Circle,
  ExternalLink,
  RotateCcw,
  ShieldCheck
} from 'lucide-react';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

const PROGRESS_KEY = 'slacato.walkthrough.completed.v1';

type WalkthroughStep = Readonly<{
  id: string;
  title: string;
  assignmentRequirement: string;
  persona: string;
  screen: string;
  action: string;
  expectedProof: string;
  links: readonly Readonly<{ label: string; to: string; primary?: boolean }>[];
}>;

const steps: readonly WalkthroughStep[] = [
  {
    id: 'authorized-brief',
    title: 'Generate an authorized strategic deal brief',
    assignmentRequirement: 'Turn opportunity data and authorized evidence into an actionable, evidence-grounded brief.',
    persona: 'Maya Levin · Account Owner',
    screen: 'Settings → Deals → OPP-1001',
    action: 'Select Maya in Settings, open OPP-1001, then choose Generate Brief. Open the run while it processes and return to the deal when it completes.',
    expectedProof: 'The deal workspace shows structured strategy, risks, stakeholders, recommendations, and citations. The stable run URL shows retrieval, specialist, synthesis, and validation phases.',
    links: [
      { label: 'Choose Maya', to: '/settings' },
      { label: 'Open OPP-1001', to: '/deals/OPP-1001', primary: true }
    ]
  },
  {
    id: 'slack-citation',
    title: 'Inspect Slack evidence and its citation',
    assignmentRequirement: 'Add reviewed synthetic Slack data, retrieve it with the supplied sources, and visibly cite it in the result.',
    persona: 'Maya Levin · Account Owner',
    screen: 'OPP-1001 brief → Evidence',
    action: 'In the generated OPP-1001 brief, open a citation labelled Slack and inspect the evidence detail rather than trusting the generated claim alone.',
    expectedProof: 'The evidence drawer identifies Slack as the source and shows its locator and authorized excerpt. Citation resolution is reauthorized for the active persona.',
    links: [{ label: 'Inspect OPP-1001 brief', to: '/deals/OPP-1001', primary: true }]
  },
  {
    id: 'restricted-approval',
    title: 'Exercise restricted-deal approval routing',
    assignmentRequirement: 'Handle sensitive OPP-1003 recommendations through explicit, policy-derived human approvals.',
    persona: 'Nora Chen · Restricted Account Owner',
    screen: 'Settings → OPP-1003 → Run → Approvals',
    action: 'Select Nora, generate the OPP-1003 brief, and follow the run into Awaiting approval. Then switch among Rina Vale, Tomas Reed, and Iris Wynn to inspect only the approval authority each persona holds.',
    expectedProof: 'The run does not publish gated recommendations prematurely. Approval entries remain separate for Deal Desk, Sales Leader, Legal Reviewer, and any required account-owner confirmation.',
    links: [
      { label: 'Choose Nora', to: '/settings' },
      { label: 'Open OPP-1003', to: '/deals/OPP-1003', primary: true },
      { label: 'Open approvals', to: '/approvals' }
    ]
  },
  {
    id: 'opaque-denial',
    title: 'Verify unauthorized access does not leak data',
    assignmentRequirement: 'Demonstrate that an unauthorized user cannot access restricted OPP-1003 or learn its protected metadata.',
    persona: 'Harper Noor · Unauthorized Requester',
    screen: 'Settings → direct OPP-1003 URL',
    action: 'Select Harper, then use the direct restricted-deal link below. Also check Deals and Runs while Harper is active.',
    expectedProof: 'The direct request ends in an opaque authorization message. Protected deal name, account, brief, evidence, run, and approval details are absent; lists contain only Harper’s authorized scope.',
    links: [
      { label: 'Choose Harper', to: '/settings' },
      { label: 'Attempt restricted URL', to: '/deals/OPP-1003', primary: true }
    ]
  },
  {
    id: 'audit-runtime',
    title: 'Inspect traces, persistence, and AI configuration',
    assignmentRequirement: 'Make the agent workflow auditable and show real retrieval, persisted state, model configuration, and structured generation.',
    persona: 'Return to the persona that created the run',
    screen: 'Runs → run detail → Diagnostics',
    action: 'Open a completed or active run and inspect its phase history, checkpoints, model attempts, evidence manifest, and validation status. Then open Diagnostics.',
    expectedProof: 'Runs survive navigation at stable URLs. Diagnostics reports OpenRouter, the pinned GLM generation model, the explicit embedding model and index health, while the run provides the trace linking inputs to output.',
    links: [
      { label: 'Inspect runs', to: '/runs', primary: true },
      { label: 'Inspect diagnostics', to: '/diagnostics' }
    ]
  }
];

export function WalkthroughRoute(): React.JSX.Element {
  const [completed, setCompleted] = useState<ReadonlySet<string>>(readProgress);
  const completedCount = completed.size;
  const percent = Math.round((completedCount / steps.length) * 100);
  const progressLabel = `${completedCount} of ${steps.length} walkthrough scenarios reviewed`;

  const completedSteps = useMemo(() => [...completed], [completed]);

  const toggleStep = (id: string): void => {
    const next = new Set(completedSteps);
    if (next.has(id)) next.delete(id); else next.add(id);
    persistProgress(next);
    setCompleted(next);
  };

  const reset = (): void => {
    persistProgress(new Set());
    setCompleted(new Set());
  };

  return (
    <div className="grid gap-8">
      <header className="grid gap-6 rounded-2xl border border-primary/25 bg-[linear-gradient(135deg,hsl(var(--primary)/0.11),hsl(var(--card))_60%)] p-6 sm:p-8 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-end">
        <div className="max-w-4xl">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary"><BookOpenCheck aria-hidden="true" />Cato home task</Badge>
            <Badge variant="outline">Interactive guide</Badge>
          </div>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">See the assignment working, end to end</h1>
          <p className="mt-3 max-w-3xl leading-7 text-muted-foreground">
            Use the guided spotlight tour to move through the real interface, or keep this page open as a reference for the assignment scenarios and expected proof.
          </p>
          <Button className="mt-5 min-h-11" onClick={() => window.dispatchEvent(new Event('slacato:start-guided-tour'))}>Start guided spotlight tour<ArrowRight aria-hidden="true" /></Button>
        </div>
        <div className="rounded-xl border bg-card/85 p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="font-medium">Demo progress</span>
            <span className="text-muted-foreground">{percent}%</span>
          </div>
          <Progress className="mt-3" value={percent} aria-label={progressLabel} />
          <p className="mt-2 text-xs text-muted-foreground">{progressLabel}. Saved in this browser.</p>
          {completedCount > 0 && <Button variant="ghost" size="sm" className="mt-2 px-0" onClick={reset}><RotateCcw aria-hidden="true" />Reset progress</Button>}
        </div>
      </header>

      <section aria-labelledby="map-heading">
        <div className="max-w-3xl">
          <p className="text-sm font-medium text-primary">Requirement → proof</p>
          <h2 id="map-heading" className="mt-1 text-2xl font-semibold tracking-tight">Five scenarios tell the product story</h2>
          <p className="mt-2 leading-6 text-muted-foreground">The persona is part of each scenario because authorization changes what may be retrieved, generated, cited, approved, and even named.</p>
        </div>

        <ol className="mt-6 grid gap-5">
          {steps.map((step, index) => {
            const done = completed.has(step.id);
            return (
              <li key={step.id}>
                <Card className={cn('gap-0 overflow-hidden shadow-none transition-colors', done && 'border-primary/40 bg-primary/[0.03]')}>
                  <CardHeader className="border-b sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-start">
                    <span className={cn('grid size-10 place-items-center rounded-full border text-sm font-semibold', done ? 'border-primary bg-primary text-primary-foreground' : 'bg-secondary')}>
                      {done ? <Check aria-hidden="true" className="size-5" /> : index + 1}
                    </span>
                    <div>
                      <CardTitle className="text-lg leading-6">{step.title}</CardTitle>
                      <CardDescription className="mt-2 leading-6"><span className="font-medium text-foreground">Assignment requirement: </span>{step.assignmentRequirement}</CardDescription>
                    </div>
                    <Button
                      variant={done ? 'secondary' : 'outline'}
                      className="min-h-11 justify-self-start sm:justify-self-end"
                      aria-pressed={done}
                      onClick={() => toggleStep(step.id)}
                    >
                      {done ? <Check aria-hidden="true" /> : <Circle aria-hidden="true" />}
                      {done ? 'Reviewed' : 'Mark reviewed'}
                    </Button>
                  </CardHeader>
                  <CardContent className="grid gap-6 py-6 lg:grid-cols-3">
                    <GuideFact label="Use this persona" value={step.persona} />
                    <GuideFact label="Go here" value={step.screen} />
                    <GuideFact label="Do this" value={step.action} />
                    <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 lg:col-span-3">
                      <div className="flex gap-3">
                        <ShieldCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" />
                        <div><h3 className="text-sm font-semibold">Expected proof</h3><p className="mt-1 text-sm leading-6 text-muted-foreground">{step.expectedProof}</p></div>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 lg:col-span-3">
                      {step.links.map((link) => (
                        <Button key={`${step.id}:${link.to}:${link.label}`} asChild variant={link.primary ? 'default' : 'outline'} className="min-h-11">
                          <Link to={link.to}>{link.label}{link.primary ? <ArrowRight aria-hidden="true" /> : <ExternalLink aria-hidden="true" />}</Link>
                        </Button>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}

function GuideFact({ label, value }: Readonly<{ label: string; value: string }>): React.JSX.Element {
  return <div><h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</h3><p className="mt-2 text-sm leading-6">{value}</p></div>;
}

function readProgress(): ReadonlySet<string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(PROGRESS_KEY) ?? '[]') as unknown;
    if (!Array.isArray(value)) return new Set();
    const validIds = new Set(steps.map((step) => step.id));
    return new Set(value.filter((id): id is string => typeof id === 'string' && validIds.has(id)));
  } catch {
    return new Set();
  }
}

function persistProgress(progress: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(PROGRESS_KEY, JSON.stringify([...progress]));
  } catch {
    // The guide still works when browser storage is disabled.
  }
}
