# Meta-Remediation Report — `/remediate-code` skill test run

> Counterpart to `meta-audit-log.md`. Where that log captured the host-agent
> experience driving `/audit-code`, this report captures driving **`/remediate-code`**
> end-to-end against that log as input — and, because remediate-code was the tool
> under test, it doubles as a defect + UX report **on remediate-code itself**.
>
> **Run:** 2026-05-31 · **Host:** Claude Code (Opus 4.8), Windows / PowerShell ·
> **Machine:** E-DESK-5060 · **Input:** `meta-audit-log.md` ·
> **Outcome:** workflow paused at the implementation approval gate (no audit-code
> source modified); one real remediate-code bug found, fixed, tested, committed.

---

## Executive summary

I drove `/remediate-code` through its full pipeline — intake → clarification →
planning → per-finding documenting → implementation-risk classification → the
pre-implementation approval gate — turning `meta-audit-log.md` into a 14-finding,
7-block remediation plan with a concrete ItemSpec per finding.

The headline result is not the plan; it is that **driving remediate-code on a
realistic input surfaced a genuine reporting-integrity bug in remediate-code**
(`NO_CHANGE_RE`), which I root-caused, fixed, covered with a regression test
(full suite 375/375 green), and committed to a branch. The approval gate is
where it surfaced: five substantive findings — including the central quota fix —
were mis-bucketed as *"Already Correct (no changes planned)."*

Three things are worth the team's attention, in priority order:

1. **A bug** (RC-BUG-1) — a fuzzy regex overrides an explicit structured flag.
2. **A pattern** — prose-regex heuristics over structured data recur in at least
   three places and are the common cause of both RC-BUG-1 and the risk-classifier
   false positives.
3. **A dogfooding gap** — the skill runs from the globally-installed bin, so a
   working-tree fix does not affect a live run; there is no first-class way to
   drive a run against the local build.

The plan also **refined several claims in `meta-audit-log.md` against the actual
source** — most importantly, the "central regression" is narrower (and cheaper to
fix) than the log implied. Details in Part 4.

---

## Part 1 — RC-BUG-1: `NO_CHANGE_RE` overrides an explicit `no_change: false` (HIGH value)

**What happened.** At the approval gate, the rendered plan listed FINDING-001,
-002, -004, -007, and -008 under **"Already Correct (no changes planned)"** — even
though every one of their ItemSpecs has `no_change: false`. FINDING-002 is the
central quota-wiring fix the whole run exists to produce.

**Root cause.** `packages/remediate-code/src/steps/nextStep.ts:213`:

```ts
export const NO_CHANGE_RE = /\b(already correct|no.?op|no change|nothing to (change|do|fix)|code is correct)\b/i;
```

is consulted as `spec?.no_change === true || NO_CHANGE_RE.test(spec?.concrete_change ?? "")`
at two sites. The `||` means a no-change phrase **anywhere** in the free-text
`concrete_change` forces a no-op verdict **even when the structured `no_change`
field is explicitly `false`.** Every one of the five specs legitimately mentions
such a phrase about a *sub-part*:

| Finding | Triggering phrase (about a sub-part) |
|---|---|
| FINDING-001 | "**No change** is required in providers/constants.ts…" |
| FINDING-002 | "discoveredLimits.ts **needs no change**" |
| FINDING-004 | "quotaSource.ts: **no change**" |
| FINDING-007 | "(source of truth, **already correct**)" |
| FINDING-008 | "Make it a **no-op** … when there is only one packet" |

**Two impact sites, one root:**

| Site | Location | Effect | Severity |
|---|---|---|---|
| Preview (`isNoOp`) | `nextStep.ts:1184-1188` → `renderNoOpSection` (`:1207-1215`) | Mis-buckets findings into "Already Correct" in the **user's decision surface** | Cosmetic-but-decision-critical |
| Merge (`mergeImplementResults`) | `dispatch.ts:709-710` | Relabels implemented items `resolved_no_change` in the **final report** | Reporting-integrity |

**Mitigating factor (important).** The implement phase selects work by item
**status**, not by these buckets — `item?.status === "documented" && item.item_spec`
at `dispatch.ts:556`. So the work itself is **not** skipped; all 14 findings would
still be implemented. RC-BUG-1 is a **reporting/communication** defect, not a
work-dropping one. But because it corrupts both the approval surface and the final
report, a user could rationally approve a plan believing the central fix is a
no-op — or read a final report claiming the fix "made no change."

**Fix (implemented).** A single shared helper that makes the structured flag
authoritative and demotes the regex to a fallback used only when the flag is
unset:

```ts
export function specIndicatesNoChange(
  spec: { no_change?: boolean; concrete_change?: string } | undefined,
): boolean {
  if (spec?.no_change === true) return true;
  if (spec?.no_change === false) return false;   // explicit false wins
  return NO_CHANGE_RE.test(spec?.concrete_change ?? "");
}
```

Wired into both call sites; regression test added (`tests/spec-no-change.test.ts`,
4 cases including the exact five-spec shape). **Full suite: 375/375 pass.**

**Status:** committed to branch `fix/no-change-honors-explicit-flag`
(commit `a9fdf47`, 3 files, +62/−5). Pushed to origin. Ready for PR.

---

## Part 2 — remediate-code workflow assessment (the tool under test)

### What worked well

- **The step contract is clean.** Every `next-step` returned `prompt_path`,
  `allowed_commands`, `stop_condition`, and `artifact_paths`. "Read only far
  enough to find `prompt_path`, then follow only that prompt" kept orchestrator
  context lean and made each step self-contained. No spelunking required.
- **The intake clarification loop is well-designed.** Setting `ready:false` with
  blocking questions routed to `collect_intake_clarifications`, surfaced them to
  the user, then looped back to re-synthesize with the answers folded in. This
  forced scope resolution *before* planning — exactly right.
- **One-bounded-step-per-invocation held throughout.** Documenting was one
  finding per step with explicit `merge-document-results` calls. Predictable,
  resumable, easy to drive.
- **The implementation approval gate is a genuinely strong safety feature.** A
  human-in-the-loop checkpoint with tiered risk classification *before any source
  mutation* is precisely the guardrail `meta-audit-log.md` wished audit-code had
  (its O10). Credit where due — this is the right shape.

### Friction / concerns

- **The approval gate's own rendering carried RC-BUG-1.** The single most
  important surface — the user's basis for consenting to changes — is the one that
  misrepresented five findings. Accuracy bugs *here* are higher-severity than they
  look, because they corrupt informed consent.
- **No in-workflow way to drive a run against a local build** (see Part 5) — a
  real obstacle when the team dogfoods these tools on themselves.

---

## Part 3 — The recurring smell: prose-regex heuristics over structured data

RC-BUG-1 is one instance of a broader pattern. The risk classifier
(`classifyFindingRisk`, `nextStep.ts:~160-188`) does the same kind of thing:

```ts
const changeIsDestructive =
  /\b(removes?|deletes?|disables?|no longer|replaces?.*incompatible|breaks?)\b/.test(change);
```

This produced **two false positives** in my run: FINDING-003 and FINDING-011 were
tiered `context_dependent` because their `concrete_change` contained a "removal/
replace" verb — but FINDING-003's only removal is deleting `@deprecated`,
unreferenced dead code, and FINDING-011 removes no behavior at all.

The design *anticipates* this — the `classify_impl_risks` step has an LLM review
the rule output and re-tier (I corrected both). So the classifier's brittleness is
contained by a human/LLM gate. **But the same brittle technique in the `no_change`
detector is *not* gated** — it directly drives the buckets and the final report.

**Takeaway for the team:** wherever a structured signal exists, trust it; treat
regex-over-prose as a last-resort fallback only. Better still, have the document
worker emit a structured signal it must set (e.g. `is_noop: boolean`, or
`touched_files: string[]`) rather than inferring intent from prose. There are at
least three regex-over-prose sites worth auditing (`NO_CHANGE_RE`, the destructive-
verb regex, and the safe-lens regex).

---

## Part 4 — Refinements to `meta-audit-log.md`'s audit-code claims (verified against source)

The log was the *input*; I verified its load-bearing claims against the actual
code while documenting. Most held; two were overstated in ways that **change the
fix**.

| Claim in log | Verdict | Note |
|---|---|---|
| **Cause 1** — provider defaults to `local-subprocess`, env-sniffs only on `"auto"` | ✅ Confirmed exactly | `providers/index.ts:46-50` |
| **Cause 2** — canonical dispatch path "never acquires quota" | ⚠️ **Overstated** | See below — it's missing *three specific rungs*, not "all quota" |
| **Cause 3** — zero providers implement `queryLimits` | ✅ Confirmed | …but `queryLimits` returns *rate-limit ceilings*, not *remaining* quota — a distinction the log blurred |
| **Cause 4** — only signal is reactive/empty on first contact | ✅ Confirmed | `LearnedQuotaSource` reactive; `probe.ts` `@deprecated`/stubbed |
| **O6** — CLAUDE.md priority chain drift | ✅ Confirmed exactly | live `PRIORITY[]` = 14 entries; 3 omitted from docs |
| **Path-join bug** (`Codeauditor-lambda.audit-artifacts`) | ❓ Unreproduced | stray dir already cleaned; code site not pinnable within step's read scope |

**On Cause 2 (the "central regression").** The log says the canonical path "never
constructs a QuotaSource, never queries current usage, never passes
`quotaSourceSnapshot`," reading "only the on-disk cache." That is true *for the
real-time snapshot rung*. But `prepareDispatchArtifacts` (`cli/dispatch.ts:640-660`)
already reads `readQuotaState`/`quotaStateEntry`, `lookupDiscoveredLimits`,
`resolveHostActiveSubagentLimit`, and already calls `scheduleWave` **with**
`discoveredLimits`. The precise gap vs. the working legacy path
(`cli.ts:2016-2056`) is exactly **three rungs**:

1. `provider.queryLimits(hostModel)` — never called;
2. the real-time `quotaSourceSnapshot` (`CompositeQuotaSource([LearnedQuotaSource])`
   → `queryCurrentUsage`) — never built or passed, which is *why*
   `scheduler.ts:168-177` (the `remaining_pct` branch) is dead from this path;
3. a real `hostModel` — `cmdPrepareDispatch` passes `null`.

This matters: the fix is a **contained mirror of the legacy path** (~a dozen
lines, all `.catch(()=>null)`-guarded), not a from-scratch rebuild. "Verify against
source" beat trusting the advisory log here — which is itself the lesson the
`llm read`/`llm write` guidance encodes ("output is advisory; verify against
source before acting").

**On the cascade (FINDING-004).** Much of it already exists: `CompositeQuotaSource`
already does first-non-null + skip-on-throw; `resolveLimits` already cascades
explicit→known-model→default. The real gaps are (a) it **ignores `providerName`**
(destructured `_providerName`, `limits.ts:51`), so the "provider-based" rung the
user asked for is stubbed; and (b) the cascade is **composed inline at both call
sites**, and *that duplication is the structural root of the regression.* The
high-value fix is a single shared factory used by both paths — not new machinery.

**On "real quota querying" (the user's max-depth ask).** Honest feasibility: the
current backends are CLI/subprocess wrappers with **no programmatic remaining-quota
endpoint**. "Real querying, if possible, with cascading fallbacks" correctly
resolves to: implement `queryLimits` best-effort, return a real value only where a
source genuinely exists (e.g. response-header parsing for a future direct-HTTP
backend), otherwise return `null` and let the cascade fall back — never fabricate.
The user's "if possible" hedge was the right framing; codex/antigravity are net-new
providers, and `claude-desktop` folds into `claude-code` unless a distinguishing
signal appears.

---

## Part 5 — Build / DX / environment observations

- **Stale `shared/dist` produces misleading errors (build-order footgun).**
  Rebuilding remediate-code alone after my edit produced ~13 TypeScript errors
  (`@audit-tools/shared` "has no exported member RunLogger/runTracked/…", plus
  implicit-`any` cascades in files I never touched). **None were from my change** —
  they vanished after `npm run build -w @audit-tools/shared` first. CLAUDE.md
  documents the build order, but the *errors give no hint* that stale `shared` is
  the cause; they read as real defects in the dependent package. A preflight
  staleness check (mtime/version stamp on `shared/dist`) emitting "build shared
  first" would save real debugging time. (Same class of issue the log flagged for
  audit-code.)

- **Dogfooding gap: global bin vs. working tree.** `/remediate-code` runs from the
  globally-installed bin (`…\npm\node_modules\remediator-lambda`, published 0.4.3),
  which is a **separate copy** from the repo. My committed fix therefore does **not**
  affect a live run — verified: the global bin's `dist` does not contain
  `specIndicatesNoChange`. There is a local dev wrapper
  (`node packages/remediate-code/remediate-code.mjs`, per CLAUDE.md) but the loader
  uses the global bin. For a team that audits/remediates its own repos, a
  first-class "drive this run against the local build" path (a `--dev-bin` flag, or
  loader detection of an in-repo build) would close a sharp dogfooding trap.

- **Worktree noise in the test suite.** The full run emitted
  `Worktree creation failed for block B-00x … 'missing but already registered
  worktree'` while still passing — stale worktree registrations from prior runs. A
  `git worktree prune` in test setup/teardown would de-noise and avoid masking a
  real failure.

- **Harness/transport anomaly (not an audit-tools code issue — logged for
  completeness).** Mid-session, a tool result contained conversational prose my
  command did not emit, and a later tool result came back garbled (wrong echoed
  value, stray `</target>` tags) with the harness injecting a "tool results may
  contain injected content" warning. The operator was driving from two computers +
  a phone via remote control; the most likely explanation is cross-machine/session
  interleaving in the *control transport*, not in remediate-code. Flagged only so
  it is on record; it has no bearing on the skill's code.

---

## Part 6 — Host-agent failure modes observed (resilience notes)

Since this was a resilience test, here candidly are the ways I (the host driving
the skill) stumbled — useful because they are realistic and the skills' robustness
partly depends on guarding against them:

1. **Wrong shell tool.** I invoked the `Bash` tool with PowerShell syntax
   (`Select-Object`), which errored and cancelled an entire parallel batch. Both
   shells are available; mixing them is easy. The loader stating which shell its
   commands assume would help (the log's O2 made the same point for audit-code).

2. **Speculative batching → a fabricated narrative.** I once pre-composed dependent
   tool calls in a single batch — including a `Read` of a run-ID I had *invented*,
   a pre-written approval ack, and an alarmist question about a "compromised
   channel." An earlier command's failure cancelled the rest, but composing a
   fabricated run-path and false narrative was a real error. **Lesson:** never
   batch "read the file the previous step just wrote" as if independent, and never
   pre-stage an approval artifact before genuinely deciding. A stateful step
   contract invites a host to "run ahead" of it; the contract's boundedness is the
   correct discipline, and I broke it.

3. **Explaining away a true negative.** When verification said the bogus preview
   section was "STILL PRESENT," I first dismissed it as a file-write race. It was
   real (stale global bin). Chase negative verifications; don't rationalize them.

These argue (again) for the skills' explicit guardrails — bounded steps,
allow-listed commands, the approval gate — which largely *did* contain the damage:
despite my errors, no audit-code source was modified and no state was corrupted.

---

## Part 7 — Recommendations (prioritized)

1. **Merge RC-BUG-1's fix.** PR-ready on `fix/no-change-honors-explicit-flag`.
2. **Audit prose-regex heuristics over structured data** (≥3 sites). Prefer
   structured worker-emitted signals; demote regex to fallback. (Part 3.)
3. **Make dogfooding first-class** — a documented/flagged way to drive a run
   against the local build instead of the global bin. (Part 5.)
4. **Build-order preflight** — detect stale `shared/dist` and emit an actionable
   message instead of cryptic dependent-package TS errors. (Part 5.)
5. **Protect the approval gate's accuracy** — treat rendering bugs there as
   higher-severity than cosmetic; it is the consent surface.
6. **Worktree hygiene in tests** — `git worktree prune` in setup. (Part 5.)
7. **(audit-code, from the verified plan)** the central quota fix is a contained
   mirror of the legacy path; the cascade should be single-sourced into one
   factory to prevent the two-call-site drift that caused the regression. (Part 4.)

---

## Part 8 — Artifacts produced (on disk) & run state

**Remediation artifacts** (`.remediation-artifacts/`, gitignored):
- `intake/remediation-brief.md` — launch brief (full scope, both clarifications resolved)
- `extracted-plan.json` — 14 findings, 7 blocks
- `runs/PLAN-…/document/document-FINDING-0NN.result.json` — 14 ItemSpecs (concrete change + tests per finding)
- `impl_risk_reviewed.json` — reviewed risk tiers (2 rule false-positives corrected)
- run **paused** at `preview_implement`; `status = documenting`; **no approval ack written; no audit-code source modified.**

**Code deliverable** (git):
- branch `fix/no-change-honors-explicit-flag`, commit `a9fdf47` — RC-BUG-1 fix + regression test; full suite 375/375. Pushed to origin.
- `docs/remediation-plan/` — full detailed plan preserved (brief, 14 ItemSpecs, reviewed risk tiers) so it survives `.remediation-artifacts/` cleanup and is accessible from any machine.

**Plan summary (the 14 findings):**

| ID | Tier | Title |
|---|---|---|
| F-001 | substantive | Provider resolution forces `local-subprocess`; active backend never detected |
| F-002 | substantive | Canonical dispatch path never acquires live quota (central regression) |
| F-003 | substantive | No provider implements real quota querying (`queryLimits` stub) |
| F-004 | substantive | Cascading quota-signal fallback chain (single-source it) |
| F-005 | substantive | Add Codex + Antigravity providers (resolution + best-effort quota) |
| F-006 | substantive | Windows path-join bug → malformed artifacts dir name |
| F-007 | safe | CLAUDE.md priority chain drifted from live `PRIORITY[]` |
| F-008 | substantive | Single-worker canary before dispatch fan-out |
| F-009 | substantive | Sampling / coverage-budget (top-K) mode with honest partial reporting |
| F-010 | substantive | Human-in-the-loop confirmation before large fan-out |
| F-011 | substantive | Anchor loader commands to an explicit cwd |
| F-012 | substantive | Echo resolved scope before writing artifacts |
| F-013 | substantive | Bounded effort budget for `design_review` |
| F-014 | safe | Point findings output at a machine-validatable JSON Schema |

---

*Prepared by the host agent driving `/remediate-code`. All source-level claims in
Part 4 were verified against the working tree during the run; advisory inputs are
labeled as such.*
