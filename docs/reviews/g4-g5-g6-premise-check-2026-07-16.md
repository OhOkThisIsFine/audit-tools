# G4/G5/G6 premise check — 2026-07-16

Dated record. HANDOFF's ▶ IMMEDIATE NEXT gates the remaining G-series behind an owner worth-it call and
says to assess each item on its own merits BEFORE opening a lap. This is that assessment, verified against
code at HEAD (`26076e34`), not spec prose.

## Verdict summary

| Item | Premise | Verdict |
|---|---|---|
| G4 | split quota/block_quota by capability-vs-policy | **OUTSTANDING — and carries a live inverted-precedence bug** |
| G5 | auditor-id stamp + declared ∩ ambient + lies-reachably quarantine | **2 of 3 clauses DEAD; reduces to the quarantine alone** |
| G6 | remediate `--auditor` round-trip | **ALIVE, fully outstanding — remediate dispatches with no pool today** |

## G4 — OUTSTANDING, and it is not ceremony

The spec's "may fold into G2" note is **stale/false at HEAD** — G2 shipped and did not fold it. Strike it.

One sub-clause shipped incidentally as a G2/G2.5 byproduct: per-source quota travels with the source
(`DispatchableSource.quota?: QuotaModelLimits`, `src/shared/types/sessionConfig.ts:327` → `buildSourcePool`,
`src/shared/quota/apiPool.ts:264-270`). Everything else is untouched: `RepoSessionIntent` self-describes as a
"HALF-type" deferring `quota`/`block_quota`/`host_can_dispatch_subagents` to G4/G5
(`src/shared/types/sessionConfig.ts:681-685`), and neither field is in `DISPATCH_INVENTORY_FIELDS`
(`sessionConfig.ts:646-659`) — so both still persist to `session-config.json`.

> **⚠ CORRECTED 2026-07-16 (same day), during implementation.** The "two sites invert the invariant"
> framing below is **half wrong** and the correction shrinks G4 substantially. See
> *"Correction: G4 is ONE bug, and it is narrow"* immediately after the table. The table is retained
> because its precedence facts are accurate; only the *interpretation* was wrong.

### The load-bearing finding: two sites invert the G2 invariant

The readers are live, not write-only. Two of them make a **repo-stored, cross-auditor-inherited capability
value outrank the current auditor's fresh descriptor/discovery**:

| Field (repo intent, inherited) | Live reader | Descriptor counterpart | Precedence today |
|---|---|---|---|
| `quota.models[hostModel]` | `src/shared/quota/limits.ts:115-127` | `self.context_tokens` / `output_tokens` → `discoveredLimits` | **repo table WINS** (rung 1, above discovery at `:133`) |
| `block_quota.host_model` | `src/shared/quota/limits.ts:67`; `quotaPool.ts:119-124` | `self.model_id` | **repo WINS** — `quotaModelKeySegment = hostModel ?? params.hostModelId` (`quotaPool.ts:129`) |
| `quota.host_active_subagent_limit` | `src/shared/quota/hostLimits.ts:78` | `self.max_active_subagents` | descriptor wins; repo is a live fallback |
| `quota.default_context_tokens` / `reserved_output_tokens` | `limits.ts:94-95` | `self.context_tokens` / `output_tokens` | repo is the floor |
| `block_quota.context_tokens` / `reserved_output_tokens` | `src/remediate/phases/plan.ts:47-51` | — | repo only |

### Correction: G4 is ONE bug, and it is narrow

The original claim — *"auditor A **writes** `quota.models[...]`; auditor B reads it and sizes packets against
A's machine"* — is **false**. Verified: **nothing writes `quota` or `block_quota`.** Every hit in `src/` is a
read. They are operator-authored in `session-config.json`, and `packetFilter.ts:259` explicitly instructs the
operator *"Set `quota.default_context_tokens` or `quota.models` in session-config.json to override."* That was
an assumption in the recon, not a finding — the same trap this document exists to catch.

Re-derived against that fact, the fields split cleanly:

| Field | Really? | Verdict |
|---|---|---|
| `quota.models[<model>]` | keyed **by model name** — model X's window is the same for every auditor | **NOT a bug.** Operator escape hatch, documented at `packetFilter.ts:259`. An explicit override outranking discovery is the intended design. **Do not "fix" `limits.ts:115`** — that would break the escape hatch. |
| `quota.default_context_tokens` / `reserved_output_tokens` | a conservative floor | policy — stays on intent |
| `block_quota.context_tokens` / `reserved_output_tokens` | remediate's block context budget (`plan.ts:47-51`) | policy — stays on intent |
| `quota.host_active_subagent_limit` | per-auditor, but descriptor already wins and the doc calls it *"Operator override"* (`auditorDescriptor.ts:35`) | fallback — not load-bearing |
| **`block_quota.host_model`** | **auditor IDENTITY sitting in the repo** | **THE bug.** |

**The single real defect:** `resolveHostModel` (`limits.ts:56-71`) resolves `explicit ?? block_quota.host_model
?? env`, and `quotaPool.ts:129` then does `quotaModelKeySegment = hostModel ?? params.hostModelId` — so the
**repo's `block_quota.host_model` outranks the descriptor's `self.model_id`**. Auditor B keys its quota to
auditor A's model. That is the [[capability-is-per-auditor-not-per-audit]] violation, and it is the only one.

**`limits.ts:115` is downstream collateral, not a second site.** `quota.models[hostModel]` only misfires
*because* `hostModel` was mis-resolved to A's model. Fix the identity and that rung correctly applies the
operator's override for the model actually running.

**So G4's "split quota/block_quota by capability-vs-policy" reduces to: move `block_quota.host_model` to the
descriptor (`self.model_id`), which is where it already has a counterpart.** The rest of `quota`/`block_quota`
is policy and belongs on the intent. The spec's framing oversold the split; the `RepoSessionIntent`
"HALF-type" note (`sessionConfig.ts:681-685`) should be narrowed accordingly rather than treated as three
fields' worth of deferred work.

### Correction 2 — even THAT may be a non-bug. G4 is an OWNER CALL, not a queued task.

Pushing one level further (during the 2026-07-16 implementation lap), the remaining claim does not clearly
survive either. It assumed `host_model` and `model_id` are two like things in the wrong order. They are not:

- `self.model_id` is documented as *"Opaque model identity … a quota-key segment only"*
  (`auditorDescriptor.ts:27-28`) and *"a key segment ONLY — never a window authority"* (`quotaPool.ts:125-128`).
- `block_quota.host_model` is a real model NAME — a window authority (it keys `quota.models` and
  `resolveModelStatics`).

**The descriptor has no model-NAME field at all.** So `quotaModelKeySegment = hostModel ?? hostModelId` is not
an inverted precedence between two peers — it is "prefer a real model name over an opaque key segment", which
is correct by construction. And `block_quota.host_model` is then an OPERATOR HINT, same family as the
`AUDIT_CODE_HOST_MODEL` env var and `quota.models` — not an auditor self-report. A stale one is the operator's
own stale config, exactly the class we just ruled legitimate for `quota.models`.

**If that reading holds, G4 is a non-bug and should be CLOSED, not implemented.** The counter-argument worth
weighing: an operator's `block_quota.host_model` is a claim about *their* host, and it silently persists into a
run driven by a *different* auditor — which is at least in tension with
[[capability-is-per-auditor-not-per-audit]] even if it is not the mechanical inheritance bug first claimed.

**Do not change quota precedence semantics on this premise without an owner decision.** Note the 2026-07-16
assembly lift moved `hostModel ?? hostModelId` INTO the shared core (`hostPool.ts`), so the behavior — right or
wrong — is now one implementation for both draws rather than two. That widens the blast radius if it IS a bug,
and is an argument for settling the question, not for having avoided the lift.

### Scoreboard after three passes

G4 shrank at every pass: "two inverted sites" → "one inverted site" → "possibly zero". Each pass killed a
claim that had file:line evidence attached and read as verified. That is the actual lesson of this document.

### The second, arguably bigger half: the parallel channel

`resolveSessionConfig` (`src/shared/config/resolveSessionConfig.ts:86-116`) maps **none** of
`self.model_id` / `context_tokens` / `output_tokens` / `max_active_subagents` / `roster` /
`can_dispatch_subagents` onto the effective config. Those reach dispatch only as flat locals hand-threaded
through three audit CLI commands (`nextStepCommand.ts:130-133`, `prepareDispatchCommand.ts:43-48`,
`quotaCommand.ts:38`) — a second channel bypassing the one seam. Collapsing that parallel channel is likely
more of G4's value than the field deletion itself.

## G5 — premise mostly dead; narrow the spec before laying it out

Three clauses, assessed separately:

- **(a) `declared ∩ ambient-verifiable` reach — SHIPPED as G2.5** (`resolveAmbientSources`,
  `src/shared/providers/auditorSources.ts`). Delete from G5.
- **(b) auditor-id stamp — DEAD AS SPECCED.** `auditor_id` / `resolved_at` are parsed
  (`src/audit/cli/args.ts:348-349`) and read at exactly one site — `src/audit/cli/prompts.ts:61-62`, purely as
  an is-descriptor-non-empty test for re-emission. Textbook write-only field
  ([[write-only-data-looks-authoritative]]). G2.5's argument holds (each IDE spawns its own process → own env
  → nothing shared to contaminate), and the spec's own Honest-residuals section contradicts the clause: the
  `(provider, account)` consumption ledger, not auditor identity, is the load-bearing double-grant boundary.
  Before building a stamp, name the transient run-state that is actually cross-auditor-shared and re-derive
  whether an id is the fix.
- **(c) lies-reachably quarantine — GENUINELY OUTSTANDING.** Self-documented at
  `src/shared/providers/auditorSources.ts:147-148`; it is the sole catcher for the inline-`api_key` refusal
  G2.5 shipped.

**G5 ≈ clause (c) alone.**

## G6 — ALIVE, fully outstanding — and it is a REGRESSION vs. the released version

**This is the load-bearing finding of the whole check.** Remediate's loss of dispatch is not a pre-existing
gap — it is a capability regression introduced by the un-released G-series, and it makes the batch
un-shippable as-is.

- **At `v0.32.68` (released): remediate COULD dispatch to a non-self pool.** It read the full `SessionConfig`
  off disk, `sources[]` included, and fed it to the dispatch machinery
  (`v0.32.68:src/remediate/steps/nextStep.ts:3217-3226`, `:1789-1793`, `:4132`;
  `v0.32.68:src/remediate/steps/contractPipeline.ts:1650-1656`). `sources?: DispatchableSource[]` was a
  persisted, validated field (`v0.32.68:src/shared/types/sessionConfig.ts:613-620`). No null-descriptor seam
  existed — `applyDispatchInventory` is absent at that tag.
- **At HEAD: it CANNOT.** All three remediate sites pass a hardcoded `null`
  (`contractPipeline.ts:1659`, `nextStep.ts:1788`, `:3225`); `resolveSessionConfig.ts:86-89` short-circuits on
  a null descriptor **before** `resolveAmbientSources` (`:104`), so G2.5's reach resolution never runs for
  remediate. And there is no disk fallback: `sources` is in `DISPATCH_INVENTORY_FIELDS`
  (`sessionConfig.ts:644-657`), so a resolved backend set is unrepresentable on disk by design.
  Net: `effective.sources` is always `undefined` → driver-self-only, no pool.
- **Culprit: `59116fe2` (G2 type-split).** `git log -S 'resolveSessionConfig(intentForSchedule, null)' --all`
  → that commit alone. Its message states the fail-closed change deliberately; `26076e34` (G3 B+D+C) later
  cemented it by deleting the persisted pool slot, but did not cause it.
- **Deliberate mechanism, under-disclosed consequence.** 59116fe2's "Honest scope" paragraph enumerates the
  half-type deferrals (G3/G4/G5) but never mentions remediate losing its pool. That consequence was first
  written down here, on 2026-07-16 — ~4 laps after it landed, and it carried no backlog entry.

**Audit is NOT broken.** `src/audit/cli/nextStepCommand.ts:330-362` builds `hostDescriptor` unconditionally
(typed `AuditorDescriptor`, never null) → the descriptor path resolves
`descriptor.sources ?? resolveAmbientSources(options).sources`. All real audit callers pass a descriptor; the
two `null` sites (`dispatch.ts:230`, `intakeExecutors.ts:178`) are documented fallbacks behind
`params.sessionConfig ?? …`. So audit traded persisted `sources[]` for descriptor+ambient and kept its pool;
**remediate got the removal without the replacement.**

### Shippability consequence

Releasing HEAD as-is ships a remediate that cannot dispatch to any non-self pool, where `v0.32.68` could. The
G-series is **not behavior-neutral**. Either land G6 before release, or accept the loss knowingly and say so
in the release notes — it must not go out on the assumption that the refactor was capability-preserving.

### Mechanism detail

Remediate has zero descriptor wiring. `--auditor` is parsed only in `src/audit/cli/args.ts:245` and emitted
only in `src/audit/cli/prompts.ts:64`; no remediate consumer exists.
`src/remediate/steps/contractPipeline.ts:1652-1659` hardcodes `resolveSessionConfig(intentForSchedule, null)`
with the comment "remediate has no `--auditor` descriptor yet — G6", and per `resolveSessionConfig.ts:35-41` a
null descriptor **fails closed to driver-self-only** — so remediate dispatches with no pool at all today.

Disjoint read paths confirmed: audit `<artifactsDir>/session-config.json`
(`src/audit/supervisor/sessionConfig.ts`) vs remediate
`<root>/.remediation-artifacts/session-config.json ?? <root>/session-config.json`
(`src/remediate/steps/nextStep.ts:1782-1785`, `:3218-3221`, `:4136`). G6 still gates the G3 policy-to-intent
endpoint exactly as the spec claims.

## Recommended order

**G4 first** — it is the only one of the three carrying a live inverted-precedence bug, and it shares the
`resolveSessionConfig` seam with G6, so doing G4 first means G6 inherits one channel instead of two. Narrow
G5 in the spec to the quarantine clause before opening it.

Backlog carries no G4/G5/G6 entries; `docs/backlog.md:46` (Gate-0 exclusion residue) is G3-scoped.
