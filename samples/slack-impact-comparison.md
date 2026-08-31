# Slack-style evidence impact: with/without comparison

This is a diagnostic report, not a system-exported brief. It documents four live
OpenRouter runs (`google/gemini-3.5-flash-lite`, provider `openrouter`, all with
nonzero token usage — see `slack-impact-comparison.json` for exact provenance)
performed to satisfy the Mandatory Data-Generation Subtask's demonstration
requirement: show how the generated Slack-style updates affect the brief.

## What was tested

Same opportunity (OPP-1001), same requester (USR-5001, Maya Levin), same live
pipeline, run twice back-to-back on 2026-08-31 with exactly one input changed:
whether the requester's authorization scope includes the `slack` source type.

"Without Slack" was produced by setting `can_read = false` on
`permission_grants` row `grant:USR-5001:ACC-2001:slack` directly in the
`slacato_samples` scratch database, then restoring it to `true` immediately
after the run completed. This is the same authorization-scope mechanism the
system already uses for every permission check — `readPermissionGrants()` is
read fresh from the database on every run — not a fixture edit and not a
hand-edited artifact. `fixtures/cato/policies/access_permissions.tsv` was never
touched, and neither `slacato` nor `slacato_e2e` was touched.

## The retrieval-level difference (real, reproducible)

| | With Slack authorized | Without Slack authorized |
|---|---|---|
| Evidence pool | 27 entries | 27 entries |
| Rank 13 | `slack:SLK-9002:0`, score 0.142, 285 chars | `gong_transcript:CALL-008:transcript:2` (was rank 14) |
| New entries admitted | — | `gong_summary:CALL-005:summary:0` at rank 19 (never appeared in the with-Slack run) |
| Slack content | "We still need the final owner matrix and success metrics confirmed by the client stakeholders." | absent |

Removing Slack authorization mechanically removes the Slack chunk from the
retrieval pool and backfills the freed slot with the next-best candidate.
Everything else about the pipeline run is identical.

## The brief-level result (the honest finding)

Across all 4 with-Slack-authorized runs we have visibility into — 2 fresh
OPP-1001 runs and 1 OPP-1002 run performed for this demonstration, plus the
already-shipped OPP-1003/USR-5003 run (`restricted-run-trace.json`) — **no
finalized Deal Brief contains a Slack citation.** This report does not
fabricate one.

What we can show precisely, because it is visible in `specialist_artifacts`,
is exactly where Slack evidence drops out of the pipeline:

1. **Ingested** — yes. 9 rows in `fixtures/cato/slack/account_team_updates.tsv`.
2. **Authorized** — yes, and correctly scoped (see the A/B pair above).
3. **Retrieved and ranked** — yes, competitively. The single admitted Slack
   chunk landed at rank 13–16 of ~27 with a fusion score (0.111–0.147) inside
   the same band as many Gong transcript entries (0.13–0.17).
4. **Prompted** — yes, in full. `included_characters` for the Slack row was
   always its complete chunk size (279–330 characters), never truncated to 0,
   present in the same evidence pool handed to every specialist agent.
5. **Claimed by a specialist** — yes, once, out of the 3 with-Slack runs
   performed for this demonstration (OPP-1001 x2, OPP-1002 x1). In
   run `run_a12bd817...`, the Conversation Intelligence Agent emitted:
   > `claim_8` (confidence 0.9): "We still need the final owner matrix and
   > success metrics confirmed by the client stakeholders."
   > citing `slack:SLK-9002:0`, locator
   > `slack/account_team_updates.tsv#SLK-9002#chunk-0`.
6. **Validated** — yes, for that claim. It was not among the artifact's
   `INSUFFICIENT_CLAIM_SUPPORT` claims; `pruneClaims()` kept it as supported.
7. **Carried into the final Deal Brief** — no, in all 4 with-Slack runs
   observed (the 3 performed here plus the pre-existing shipped OPP-1003 run).
   The Negotiation Strategy Agent re-synthesizes `buyerGoalsAndBusinessDrivers`,
   `negotiationState`, and `recommendedNextActions` directly from the shared
   evidence pool with its own new claim IDs and statements, rather than
   forwarding upstream specialist claims verbatim. In the run where Slack was
   claimed at step 5, the Strategy Agent selected two Gong-sourced claims for
   `buyerGoalsAndBusinessDrivers` instead and did not carry `claim_8` forward.
   `missingInformation` is populated only from claims that *failed*
   validation, so a well-supported but unselected claim has no path into that
   section either.

## Root cause

Not a permission or retrieval defect — a volume asymmetry. In
`packages/core/src/application/evidence/retriever.ts`, `buildEvidencePlan`
sets `slack: Math.min(input.limit, 2)` per section query while
`gong_transcript` is left uncapped (`gong_transcript: input.limit`). For
OPP-1001 this produced 18 Gong transcript chunks — 84.6% of the run's
22,670-character evidence context — against 1 Slack chunk (1.26% of the
context). The generation-model agents are handed the whole pool and choose
what to write about; a single short update surrounded by 18 same-topic
transcript chunks is a plausible candidate for extraction (it happened once)
but a hard one for the downstream synthesis step to prioritize.

**What would change this:** raising the Slack cap relative to
`gong_transcript` in `sourceLimits`, or requiring the Negotiation Strategy
Agent's synthesis prompt to draw at least one claim from every authorized
source type that returned evidence, would give Slack updates a materially
better chance of reaching the shipped brief without changing retrieval or
permissions.

## Runs used

4 live runs performed for this demonstration — 3 with Slack authorized
(OPP-1001/USR-5001 x2, OPP-1002/USR-5002 x1) and 1 without Slack authorized
(OPP-1001/USR-5001) — all `openrouter` / `google/gemini-3.5-flash-lite` with
nonzero token usage (exact figures in `slack-impact-comparison.json`), plus
cross-reference to the already-shipped `restricted-run-trace.json` run
(a 4th with-Slack data point, not newly run here). The existing
`normal-opportunity-brief.*` and `restricted-opportunity-brief.*` samples were
not touched or regenerated for this comparison.

Full machine-readable data: [`slack-impact-comparison.json`](slack-impact-comparison.json).
