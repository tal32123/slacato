# Slack-style evidence impact: with/without comparison

This is a diagnostic report, not a system-exported brief. It documents the live
OpenRouter runs performed to satisfy the Mandatory Data-Generation Subtask's
demonstration requirement: *show how the generated Slack-style updates affect
the brief, including at least one cited generated update*.

Machine-readable data, including every run id, token count, manifest rank and
cited claim quoted below: [`slack-impact-comparison.json`](slack-impact-comparison.json).
The same measurement rendered for reading at a glance, generated from that file:
[`slack-impact.html`](slack-impact.html).

## What was tested

Same opportunity (OPP-1003, the restricted deal), same requester (USR-5003,
Nora Chen), same live pipeline (`openrouter` / `google/gemini-3.5-flash-lite`),
run twice with exactly one input changed: whether the requester's authorization
scope includes the `slack` source type.

"Without Slack" was produced by setting `can_read = false` on `permission_grants`
row `grant:USR-5003:ACC-2003:slack` in the `slacato_samples` scratch database,
running the pipeline, then restoring it to `true`. Permission grants are read
fresh on every run, so this changes that run's authorization scope and nothing
else. `fixtures/cato/slack/account_team_updates.tsv` was never touched and no
generated artifact was hand-edited.

Every source type reported below is resolved by joining each cited evidence id
back to the run's immutable evidence manifest. Nothing here relies on the
brief's own `sourceType` field, which is generated output.

## The retrieval-level difference

| | With Slack authorized | Without Slack authorized |
|---|---|---|
| Manifest entries | 22 | 22 |
| Slack entries | 3 (`SLK-9009` rank 1, `SLK-9007` rank 7, `SLK-9008` rank 11) | 0 |
| Backfill | — | `gong_summary` rises from 3 entries to 6 |
| Missing source types | none | none |

Removing Slack authorization removes the Slack chunks from the authorized pool
and the next-best candidates take their slots. The highest-ranked evidence in
the authorized run is an account-team update: `slack:SLK-9009:0`, fusion score
0.139, 330 characters, admitted in full.

## The brief-level difference

With Slack authorized, three claims **outside** Source Evidence cite an
account-team update — that is, Slack updates shape conclusions, not just the
evidence list:

| Brief section | Cited update | Claim |
|---|---|---|
| `executiveSummary.claims[0]` | `slack:SLK-9009:0` | "Executive stakeholders disagree on whether aggressive discounting or risk mitigation should lead the final negotiations." |
| `buyerGoalsAndBusinessDrivers.claims[1]` | `slack:SLK-9007:0` | "Data protection controls and segmentation models are fully accepted by the security architect." |
| `negotiationState.claims[1]` | `slack:SLK-9008:0` | "Exception handling procedures requested by the research team are still undocumented." |

The Executive Summary narrative in the shipped restricted brief *is* the
`ambiguity_or_conflict` update `SLK-9009`, carried by its sole citation. All
three updates also appear in Source Evidence with their own summaries.

Without Slack authorized, the same section reads "Internal buyer group has
conflicting priorities", zero claims anywhere in the brief cite a Slack update,
and Source Evidence contains no Slack entry at all.

## The reviewer-visible difference

`apps/api/src/modules/deals/deal-workspace.mapper.ts` marks a brief section
`accountTeamUpdateImpact` when one of that section's cited evidence ids is an
authorized Slack record, and the web workspace renders that as the
**"Account-team update impact"** badge. Captured live from
`GET /api/deals/OPP-1003` as USR-5003 against the shipped restricted run, the
badge is on for **Executive Summary, Buyer Goals and Business Drivers,
Negotiation State and Source Evidence**, and off for the other five sections.
Reading the same workspace against the without-Slack run, no section carries it.

## Supporting runs

The two other shipped sample briefs show the same behaviour on their own deals,
measured the same way:

| Run | Deal | Slack in Source Evidence | Claims outside Source Evidence citing Slack |
|---|---|---|---|
| `run_4f76c467…` | OPP-1001 (Maya Levin) | 2 | 1 (`stakeholderMap`) |
| `run_768cb55a…` | OPP-1002 (Owen Patel) | 2 | 3 (`stakeholderMap`, `negotiationState`) |

OPP-1001 reaches fewer account-team updates than the other two deals, and that
is authorization working as designed rather than a defect: `SLK-9003`, the
`ambiguity_or_conflict` update on that account, is classified
`sensitive_pricing`, and Maya Levin's grant carries
`can_view_sensitive_pricing = false`. The two updates she can read are the least
decision-shaping of the three kinds the generator produces.

## What this replaces

An earlier version of this report concluded that Slack evidence was retrieved,
ranked, prompted and validated but never reached a finalized brief. That was an
accurate measurement of the code at the time and is no longer true. Two fixes
falsified it: `d2cf83d` capped the Gong-transcript candidate window so
transcripts stopped crowding Slack out of the prompt context, and `40d4a0f`
stopped the prose safety filter matching `role:` without a word boundary — every
Slack row carries an `authorRole:` field, so claims quoting a Slack update were
being discarded as instruction-like prose. The measurements above are from the
current code.
