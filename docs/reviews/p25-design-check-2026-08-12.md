# P25 design-check — pre-implementation gate

**Target build:** P25 / owner decision `sol-9` (2026-08-12) — remove the guessable host-result file
path from both orchestrators' host handoff; results arrive only through a validating tool-owned
submit; fan-out records its expected shard set at dispatch so a missing shard reports as transport
failure; plus a designed hand-recovery lane.

**Tree state:** HEAD `27b722c8`, branch `main`, clean. Analysis only — no repo file was written.

**Lanes used:** own verification (primary), two read-only recon subagents, one independent
adversarial lane (`agy`). The `codex exec` lane was attempted first and returned
`You've hit your usage limit ... try again at Aug 17th` — ChatGPT quota is exhausted, so the
independent verdict rests on `agy` plus my own reproduction of each claim against source.

---

## VERDICT: **proceed-with-changes** (material re-scope required)

The *problem* is real, well-evidenced, and worth fixing. The *mechanism as specified* is aimed at the
wrong surface and its headline half is refuted by the repo's own recorded history.

Three findings drive the re-scope:

1. **The surface P25 names is already fixed — as of today.** Both
   `src/audit/cli/dispatch/hostHandoff.ts` and `src/remediate/steps/dispatch/hostHandoff.ts` were
   *created* by commit `467b1e8f` (2026-08-12, the zero-adapter retirement). Verified:
   `git log --oneline --follow` returns exactly one commit for each file. Every record in P25's
   recurrence tables (2026-07-21 → 2026-08-08) **predates the existence of the code P25 proposes to
   change.** The host handoff already has a tool-computed path, an expected-set manifest, prompt
   binding, and an explicit no-directory-fallback guarantee.
2. **The drift is on a different surface**: the flat `incoming/<filename>.json` directory consumed by
   `src/audit/cli/nextStepHelpers.ts`. That is where the host types a filename it can get wrong, and
   it is where 5-of-8, 3-of-3 and 9-of-10 were measured.
3. **"Validating submit command" is the mechanism the repo already tried and whose failure corpus it
   already recorded.** It does not remove the file; it adds a step on top of it.

The owner's addendum (a designed hand-recovery lane) is the part that survives intact — and under the
re-scope it becomes nearly free, because the corrected design never removes the file write in the
first place.

---

## 1. Retirement-collision check

### 1.1 What `467b1e8f` actually deleted, and why

`git show 467b1e8f --name-status` deletes 100+ files. `src/audit/cli/submitPacketCommand.ts` is one of
them, but reading it shows *what company it kept*:

```
D  src/audit/cli/prepareDispatchCommand.ts      D  src/audit/cli/dispatch/sizingWindow.ts
D  src/audit/cli/submitPacketCommand.ts         D  src/audit/cli/dispatch/quotaPool.ts
D  src/audit/cli/mergeAndIngestCommand.ts       D  src/audit/cli/dispatch/tierRouting.ts
D  src/audit/cli/validateResultCommand.ts       D  src/shared/decompose/workPartition.ts
D  src/audit/cli/waveManifest.ts                D  src/audit/cli/workerRunCommand.ts
```

`submitPacketCommand` was keyed on **`--packet-id`**, and a packet is a *sizing/partition* identity —
a position ordinal inside a wave (project memory: `attempt-key-has-no-admission-identity`). It loaded
`pending-audit-tasks.json`, filtered a `dispatch-result-map.json` by `packet_id`, computed a
packet-wide `boundaryPaths` union, and only then validated + persisted. Its dependencies were
`prepare-dispatch`, `waveManifest`, and `workPartition` — the backend-window sizing substrate the
retirement directive explicitly killed ("the declared sizing window goes with them").

So `submit-packet` was **deleted as collateral of retiring the PACKET concept**, not because a
validating write is forbidden. Its own body is almost pure ingestion: validate schema, check task
identity, reject duplicates/unassigned/missing, then `writeJsonFile(entry.result_path, ...)`. Nothing
in it spawns, routes, sizes, or accounts quota.

### 1.2 Where the line falls — ingestion (kept) vs execution substrate (retired)

The directive keeps "result **ingestion** — consumption, not execution" and "the right to faithfully
RECORD what the host says ran". A precise test, in four parts:

**A submit is INGESTION (allowed) when all of these hold:**
- Its identity keys are **content/work identity** the tool already minted and persisted at dispatch —
  `run_id`, `work_item_id`, `prompt_sha256`. These describe *what work*, not *who ran it*.
- It is **terminal**: it validates, records, and returns. It does not decide what happens next, does
  not select or schedule follow-on work, does not launch anything.
- Its payload is **result content plus provenance the host volunteers**. Recording "the host says
  model X ran this" is allowed; *acting* on it is not.
- Refusal is **fail-closed and local**: a bad payload is rejected/quarantined, and the obligation
  simply stays unsatisfied so the ordinary next-step re-emits it.

**A submit is EXECUTION SUBSTRATE (retired) when any of these appear:**
- It is keyed on a **partition/sizing identity** — `packet_id`, `wave_id`, a shard index that exists
  because a backend window was divided. This is exactly what killed `submit-packet`.
- It carries or validates **backend fields** — provider, model, endpoint, token budget, cost, rate
  limit, retry/failover policy, concurrency, lease, admission.
- It **schedules**: accepting a result causes the tool to hand out the next unit, re-dispatch a
  failure, or size the next batch.
- It requires the tool to know a backend's **allowance or window** to decide acceptance.

**Verdict on P25 against that line:**

| P25 component | Classification | Note |
|---|---|---|
| Validating submit for a host result | **Ingestion — allowed** | Keyed on `run_id`/`work_item_id`/`prompt_sha256`; terminal |
| Recording an expected set at dispatch | **Ingestion — allowed** | This is a *completeness* manifest, not a schedule. It already exists (`host-result-map.json`, `RemediationState.host_handoff.work_item_ids`) |
| Reporting a missing member as transport failure | **Ingestion — allowed** | A diagnostic about the tool's own expectation |
| Validated hand-recovery lane | **Ingestion — allowed** | Same validator, different trigger |
| ⚠ The word **"shard"** | **Flag — wording only** | "Shard set" is sizing vocabulary. If a shard is ever derived from a backend window, this becomes retired machinery. The tool partitions on **content coherence** only. Name it the *expected submission set* / *lane set* and derive it from the lane/work-item enumeration the tool already computes |
| ⚠ "absent → **transport** failure" | **Flag — wording only** | "Transport" is the retired vocabulary's word. The tool has no transport. The honest classification is `submission_missing` — the tool asserts only *"I expected N, I have M, here are the M−N by name"*, never a claim about why |

**Retirement verdict: CLEAN, with two vocabulary corrections.** Nothing in P25's *substance*
recreates the retired substrate, provided the expected-set is derived from content-coherent lane
enumeration (never a backend window) and acceptance never schedules follow-on work. The two flagged
words are the sort of thing that decays into the retired design three refactors later, so fix them in
the spec now.

**One additional collision to respect:** `src/audit/cli.ts` still registers `ingest-results` and
`validate-results`, but `mergeAndIngestCommand.ts` and `validateResultCommand.ts` were deleted — the
verbs were re-homed, not retired. Any new submit verb must not become a fourth ingestion entry point.
There are already three (`next-step`'s folded host-handoff ingest, `ingest-results`, and the
`incoming/` gates), and `ingest-results` notably bypasses the binding/corroboration the handoff
boundary enforces. **Consolidation, not addition, is the correct shape here.**

---

## 2. Independent refutation — findings

Each finding was reproduced against source before being recorded. The `agy` lane independently
reached R1, R2 and R4; R3, R5, R6 and R7 are mine; R8 is an `agy` claim I checked and **rejected**.

### R1 — P25 targets a surface that already implements P25 *(fatal to the build as specified)*

`src/audit/cli/dispatch/hostHandoff.ts:237-243`:

```ts
function resultPathFor(paths: ResolvedBoundaryPaths, workItemId: string): string {
  const absolute = join(paths.resultDir, `${sha256(workItemId)}.json`);
  return repoRelative(paths.root, absolute, `result path for ${workItemId}`);
}
```

At ingest, `validateHandoffBinding` cross-checks `host-workload.json` ↔ `host-task-bindings.json` ↔
`host-result-map.json` and hard-errors when `resultMap.entries.length !== items.size` — the expected
set must cover the workload exactly. Ingestion then iterates `resultMap.entries` (the expected set),
never a directory listing. `tests/audit/host-handoff.test.ts:339-348` already asserts that a valid
result at an *unbound* path is refused ("No directory scan/fallback may steal a valid result from an
unbound path").

The remediate side is the same shape, with the expected set in `RemediationState.host_handoff`
(`work_item_ids` + `workload_sha256`), and it goes further: `corroborateHostResult` re-runs the
required tests itself rather than trusting the host's "tests passed" claim.

**So on the surface P25 names, "record the expected set at dispatch" is already built, and the path is
already tool-computed.** Implementing P25 there would be a no-op at best.

### R2 — the measured drift is on `incoming/`, and P25 does not touch it

`src/audit/cli/nextStepHelpers.ts:119-134`:

```ts
const filePath = join(artifactsDir, "incoming", filename);
```

Flat, unhashed, and the tool *tells the host the string to type* — `nextStepCommand.ts:183` builds
`incoming/design-review-contract-findings.json` and renders it into the prompt; `:519-522` does the
same per charter kind; `charterExtractionPrompt.ts:155` renders "Write your submission as JSON to
`<path>`".

Evidence attribution (verified against the records):

| record | verdict |
|---|---|
| 08-05 #3 — 5 of 8, "2 wrong filename, 1 wrong directory" | **`incoming/`** — only possible when the host types both |
| 08-08 O2 — 3 of 3 charter lanes | **`incoming/`** |
| 08-08 O6 — 9 of 10 running rate, markdown-fenced JSON | **`incoming/`** |
| 08-06 lead 1 | **`incoming/`** — names `tryConsumeIncoming` explicitly |
| 07-21 silent-destroy design-review ingest | **`incoming/`** |
| 08-05 #2, 08-08 O8, 08-06 lead 2, 07-22 #12 | **retired packet lane** — "inline-result", "submit", "pending-audit-tasks.json" |
| 08-08 O12 | **outside audit-tools** — a host-side offload driver parsing raw LLM stdout |

Not one record is attributable to the host-handoff boundary. The backlog entry P25 cites
(`open-bugs.md:467-474`, P25's ":477" is stale) states the property as *"every incoming artifact rides
a tool-validated write"* and names the `incoming/` lanes explicitly.

### R3 — a submit command does not remove the file; the repo already measured this

Project memory holds **two dedicated trap entries** for the previous submit lane:

- `submit-packet-json-array-trap` — *"~15+ failed attempts"*; PowerShell object literals serialize to
  a JSON object, so submit rejects them in a repeating loop.
- `audit-worker-submit-packet-shell` — *"~30 sessions"* each wasting ~2k tokens on Bash-heredoc death,
  PowerShell-verbs-in-Bash-tool errors, and absolute-vs-repo-relative path rejections.

The decisive detail is the *recommended working pattern* in that second entry:

> "**Write** the results JSON to a temp file, then run ONE PowerShell call:
> `Get-Content <file> -Raw | node audit-code.mjs submit-packet ...`"

The reliable way to submit was **write the file, then pipe it**. The submit command never removed the
file write — it added a second, shell-fragile step on top of it, and the drift surface grew from
{filename} to {filename, verb, flags, quoting, encoding, stdin}. P25's core claim — *"there is no
filename left to get wrong"* — is falsified by the repo's own record of the same mechanism.

### R4 — Windows makes the argv path structurally unavailable

Windows `CreateProcess` caps the command line at 32,767 chars (8,191 under `cmd.exe`). Charter
submissions and synthesis narratives routinely exceed that, so `--results-b64` (base64 inflates ~33%)
is not viable for real payloads — which is precisely why the deleted command supported *both* a
`-b64` flag and stdin, and why the memory entry's working recipe is a file plus a pipe. Under the
project's **OS-agnostic** invariant, a design whose only reliable channel is "write a file and pipe
it" should simply be *"write a file"*, with the tool owning the filename.

### R5 — the "clean empty" is on the **host** side, not inside the tool

This is the most important correction to the problem statement. I traced every absent-file path:

- `runOmittableGate` (`nextStepHelpers.ts:1064-1100`): absent → `shouldOmit(bundle)` → **`run_omit`
  only when the gate's own predicate says no host turn is owed** (e.g. narrative disabled, shallow
  charter ceiling). Otherwise it **re-emits the step**.
- `handleCharterExtractionBranch` (`:1272-1290`): an absent lane `continue`s; K-of-N is unsatisfied,
  so the step **re-emits naming the missing lane**. `run_omit` fires only for a shallow ceiling — a
  deliberate config, not drift-masking.
- `handleDesignReviewBranch` (`:856-978`): no `run_omit` branch at all — an unsatisfied pass **always**
  returns a host step.

**The tool already re-emits on absence.** So the 2026-08-08 "session ends without ever calling Write,
exit 0, indistinguishable from success" was indistinguishable *to the orchestrating host agent*, which
saw a subagent exit 0 and assumed the lane landed. The backlog entry says this exactly: *"The repairs
are invisible to the tool, so an uninstrumented run reads as clean."*

**Consequence:** the load-bearing defect is not that absence is silent — it is that **hand-repair is
unrecorded**. A host that drifts, notices, and hand-fixes the file produces a run indistinguishable
from a run that never drifted. That is why the problem recurs at a measured 9-of-10 while every
individual run looks fine. **No amount of path-hiding fixes this; only recording does.** This is the
single biggest gap between what P25 proposes and what the evidence demands.

### R6 — the two orchestrators have already drifted on failure classification ("one core, two draws")

`src/audit/cli/dispatch/hostHandoff.ts:803-820`:

```ts
} catch (error) {
  if (isFileMissingError(error) || isJsonParseError(error)) return null;
  throw error;
}
```

Both **absent** and **malformed** collapse to `null`, and the caller does `continue` with no record.
The audit ingest summary has **no `issues` field at all**.

Remediate, by contrast, defines `RemediationHostIngestIssue` with distinct `result_missing` and
`result_malformed` codes and reports them.

Same obligation, two behaviours, one of them silent — a textbook violation of *one core, two draws*.
Any P25 work must fix this by **single-sourcing the classifier**, not by patching audit to match.

### R7 — a real adjacent data-loss strand P25 does not mention

`handleDesignReviewBranch:882-892` — `consumeArrayIncoming` **deletes the file on successful parse**,
but the merge is guarded by `&& existing`:

```ts
} else if (contractResult.status === "ok" && existing) {
```

When `bundle.design_assessment` is absent, a **valid** submission is consumed, deleted, and dropped —
the legacy arm even says so: *"File consumed but no target to merge into — keep folding."* The
obligation re-emits, so the run is not corrupted, but the host's work is destroyed with no quarantine
and no diagnostic. This is the one place where a genuine silent-destroy survives at HEAD, and it is
adjacent to everything P25 touches.

### R8 — an `agy` claim I checked and **rejected** *(recorded so it is not inherited as fact)*

`agy` asserted that a submit command would break the drain/fold by introducing "race conditions
between host submissions and state transitions", and would trigger an "involuntary staleness cascade"
via `computeArtifactMetadata`. I could not reproduce either. Submissions are consumed *inside*
`next-step` under the existing lock discipline, not concurrently with it; and a submit that writes a
tool-owned path before the same process ingests it is the current design, which does not cascade.
`agy`'s suggested test (`design-review-contract-independence.test.ts:138-143`) is also **not a valid
red test** — it asserts today's correct behaviour and would merely *need changing*, which the skill
explicitly rules out ("a test that would pass against the unfixed tree proves nothing"; the inverse —
a test that must be edited to accommodate the fix — is a contract change, not a red test). Treated as
advisory, unverified, and not carried forward.

---

## 3. How the design must change

Re-scoped build, in priority order. Each item states the property it holds.

**P25-a — give `incoming/` the treatment the host handoff already has.** *(the actual fix)*
Move the design-review / charter / systemic-challenge / narrative submissions from
`incoming/<host-typed-name>.json` to a **tool-computed, binding-derived path**, exactly as
`resultPathFor` does — `submissions/<sha256(submission_id)>.json`, where `submission_id` is minted at
step-emit time and carried in the step contract's `write_paths`. The host still writes a file (R3, R4)
— it just cannot invent the name, and the prompt renders the path as an opaque token rather than a
guessable convention. A write to any other path is not read by anything.
*Property: a mistyped filename or directory is unrepresentable, with no new shell surface.*

**P25-b — one expected-submission-set contract, single-sourced.**
Persist, at step-emit, the enumerated set of submissions the step expects (the K lanes of a K-of-N
fan-out), keyed by `submission_id`. At the next ingest, classify each member: `accepted`,
`submission_missing`, `submission_malformed`, `submission_rejected(reason)`. Derive the set from the
existing lane enumeration — **never from a backend window**, and do not call it a shard set (§1.2).
*Property: "I expected 3, I have 2, lane `revealed` is missing" — by name, every time.*

**P25-c — record drift and repair.** *(the highest-value item; R5)*
Every classification event above appends to a run-scoped ledger. A quarantine, a missing submission, a
re-emit-after-drift, and a hand-recovery submit are all **recorded events**, surfaced in the run
summary and the audit report's process section. This is squarely inside "the right to faithfully
RECORD what the host says ran".
*Property: a run that drifted and was repaired is distinguishable from a run that never drifted — so
the 9-of-10 rate becomes measurable from the artifacts instead of from a human reading a transcript.*

**P25-d — unify the failure classifier across both orchestrators.** *(R6)*
Promote remediate's issue-code vocabulary into `src/shared`; audit's ingest stops returning bare
`null`. One core, two thin draws.

**P25-e — hand-recovery as a first-class, validated, recorded lane.** *(owner's addendum)*
Under this re-scope hand-recovery is nearly free and is the *only* place a new verb earns its keep:
`<bin> recover-submission --submission-id <id> --from <path>`. It runs **the same validator** as the
normal lane (no weaker path — that is the whole point), writes to the tool-owned path, and records
`recovered_by_hand` in the P25-c ledger.
*Property: hand-recovery cannot silently look like a normal result — the distinction the current
design loses is exactly what gets recorded.* Note the asymmetry that makes this safe: the ordinary
lane needs no verb (the host writes a tool-named file), so the fragile shell surface of R3/R4 is paid
**only** on the rare rescue path, by an operator at a terminal, never by 30 fan-out workers.

**P25-f — fix the consume-then-drop data loss.** *(R7)*
`consumeArrayIncoming` must not delete a valid submission it cannot merge; quarantine it and record it.

**Not doing:** removing the file-write channel; adding a submit verb to the normal path; any
`--results-b64`/stdin payload channel; any expected-set derived from sizing.

### Migration / in-flight runs

`host-workload.json` and the step contract are versioned. Bump the contract version and make an
unknown/absent `submission_id` set fall back to the current `incoming/` reader **for that run only**,
keyed on the persisted contract version — not on a global flag. A run in flight at upgrade keeps
working; new runs get the bound path. The `incoming/` reader is deleted in a later commit once no
in-flight run can carry the old version. Note this is the one place the *atomic-replace* invariant
needs an explicit owner call — see §6.

---

## 4. Seam design — modules and contracts

**New shared core** (`src/shared/submission/`) — the one core both draws use:

| module | owns |
|---|---|
| `submissionIdentity.ts` | mint `submission_id`; `submissionPathFor(paths, id)` — the single sha256 path rule. **Single-source with `resultPathFor`**: the audit and remediate handoffs must call this, not keep their own copies (they are already near-identical at `hostHandoff.ts:237` / `:343`) |
| `expectedSubmissions.ts` | the expected-set contract: persist at emit, load at ingest, diff → per-member classification |
| `submissionClassifier.ts` | the **one** absent/malformed/rejected/accepted vocabulary (promoted from `RemediationHostIngestIssue`) |
| `submissionLedger.ts` | append-only drift/repair event record (P25-c), stable content-derived ordering |
| `handRecovery.ts` | the validated recovery entry point both bins draw from |

**Touched, per orchestrator (thin draws only):**

- `src/audit/cli/nextStepHelpers.ts` — `tryConsumeIncoming` / `consumeArrayIncoming` /
  `runOmittableGate` read a bound path from the expected-set instead of a literal filename;
  `HOST_GATE_DESCRIPTORS` (`:1523-1567`) becomes the enumeration the expected-set is derived from —
  it is already the single-sourced gate registry, so this is the natural seam.
- `src/audit/cli/nextStepCommand.ts`, `conceptualDispatch.ts`, `charterExtractionPrompt.ts`,
  `systemic/secondOrderAdversaryPrompt.ts` — render the tool-computed path token
  (`toPromptPathToken`) instead of building a filename.
- `src/audit/cli/dispatch/hostHandoff.ts` — `readSubmittedResult` returns a classified result, not
  `null`; summary gains `issues`.
- `src/remediate/steps/dispatch/hostHandoff.ts` — its issue codes re-exported from the shared core.
- `src/shared/loopCorePaths.ts` — ⚠ **`nextStepHelpers.ts` is NOT in the loop-core set today**, so the
  whole `incoming/` mechanism is outside the attestation gate. This build makes it result-ingestion
  substrate; **add `src/shared/submission/` and `src/audit/cli/nextStepHelpers.ts` to the patterns in
  the same commit.**
- `scripts/guard-reach-data.mjs` — register any new check; `check:guard-reach` is a red build otherwise.
- Host asset templates (`.agent/`, `.github/`, `.claude/`, `.gemini/`) — `host-asset-renderer-drift`
  and `host-bootstrap-descriptors` tests will bite if the rendered contract changes.

**Not touched:** anything under provider/quota/routing (all deleted); `ingest-results` semantics
beyond the classifier.

---

## 5. Failing tests to write FIRST (red at HEAD)

Ordered; each is red at `27b722c8` and green only after the named item. Reproduction notes reflect the
existing-coverage check — none of these duplicates a current test.

1. **`tests/shared/submission-path-is-tool-owned.test.ts`** — *the headline test.*
   For every descriptor in `HOST_GATE_DESCRIPTORS`, assert the emitted step's declared write path is
   the tool-computed `submissionPathFor(...)` and that **no host-facing prompt string contains a
   literal `incoming/` filename**. Red at HEAD: `nextStepCommand.ts:183` renders
   `incoming/design-review-contract-findings.json` into the prompt. *(P25-a)*

2. **`tests/shared/expected-submission-set.test.ts`** — emit a 3-lane charter fan-out, satisfy 2,
   ingest. Assert the classification names the third lane by id with `submission_missing`, and that
   the summary reports `expected: 3, accepted: 2`. Red at HEAD: no expected-set exists for the
   `incoming/` gates and nothing reports a count. *(P25-b)*

3. **`tests/audit/host-ingest-issue-codes.test.ts`** — write a malformed result at the bound path,
   ingest, assert `summary.issues.map(i => i.code)` contains `result_malformed`; delete it and assert
   `result_missing`. Red at HEAD: `readSubmittedResult` returns `null` for both and the audit summary
   has no `issues` field. **Verified net-new**: `tests/audit/host-handoff.test.ts:319-348` asserts only
   the coalesced `completed_work_item_ids: []`, and `result_missing` is asserted by name nowhere in the
   repo. *(P25-d, R6)*

4. **`tests/shared/submission-ledger-records-drift.test.ts`** — submit a malformed lane, then a valid
   one for the same id. Assert the ledger holds both a rejection event and an acceptance event, so the
   repaired run is distinguishable from a clean one. Red at HEAD: no ledger. *(P25-c — the fix for the
   invisible-hand-repair defect in R5)*

5. **`tests/shared/hand-recovery-uses-the-same-validator.test.ts`** — feed the recovery lane a payload
   the normal lane rejects; assert identical rejection, and that a successful recovery is recorded as
   `recovered_by_hand`. Red at HEAD: no recovery lane. *(P25-e — closes the "does hand-recovery reopen
   the hole" question by construction)*

6. **`tests/audit/design-review-consume-without-target.test.ts`** — write a valid
   `design-review-contract-findings.json` with `design_assessment` absent; assert the submission is
   **not** destroyed (quarantined + recorded). Red at HEAD: `handleDesignReviewBranch:882-892` deletes
   it. *(P25-f, R7 — this one is independently worth landing even if P25 is deferred)*

7. **`tests/shared/submission-contract-has-no-sizing-identity.test.ts`** — a contract guard: assert no
   submission/expected-set type carries `packet_id`, `wave_id`, `shard_index`, provider, model, or
   token-budget fields. Red only if the build drifts — this is the **mechanically enforced retirement
   guard** that replaces a backlog note about the §1.2 line, per *durable traps are mechanically
   enforced, not remembered*.

---

## 6. Open questions — owner only

1. **The re-scope itself.** `sol-9` says "remove the guessable path from both orchestrators' host
   handoff". That surface was created today and already does this (R1), while the measured drift is on
   `incoming/` (R2). **Is the decision re-pointed at `incoming/` (P25-a…f above), or was the
   host-handoff surface genuinely intended?** Everything downstream depends on this answer. My
   recommendation: re-point.

2. **Does the "validating submit command" survive at all?** R3/R4 argue the normal path should stay a
   file write to a tool-owned name, with a verb only on the rare hand-recovery lane. That is narrower
   than `sol-9` as written. **Confirm the verb is recovery-only**, or say the normal-path submit verb
   is wanted anyway despite the ~30-session trap corpus.

3. **Migration vs. atomic-replace.** *Ideal code over compatibility* and the **atomic-replace ordering
   invariant** say new-mechanism-plus-deletion in one commit — which would break any audit run in
   flight at upgrade. The alternative is one versioned-fallback commit followed by a deletion commit
   (§3), which is technically add-then-delete. **Accept the two-commit migration, or declare in-flight
   runs expendable and do it atomically?** Given there is a live dogfood lap pending, I'd ask rather
   than assume. My recommendation: atomic, and re-run the lap — the repo has no external consumers and
   `force-synthesis` can rescue anything valuable.

---

## Three-line hand-back (skill §5)

- **Retirement verdict:** clean — a validating *ingestion* submit is explicitly retained by `467b1e8f`;
  what was retired is the *packet/sizing* identity it used to be keyed on. Two vocabulary items
  ("shard", "transport") must be renamed, and one contract test (#7) should enforce the line
  mechanically.
- **Adjacent strand made reachable:** the `incoming/` gate family in `nextStepHelpers.ts` — currently
  **outside** `loopCorePaths.ts`, so this build must add it to the attestation set in the same commit;
  it also harbours a live consume-then-drop data loss (R7).
- **Failing test pinned:** `tests/shared/submission-path-is-tool-owned.test.ts` — red at HEAD because
  `nextStepCommand.ts:183` renders a host-typed `incoming/` filename into the prompt.

**Gate outcome: proceed-with-changes, pending owner answers to §6.1 and §6.2** — those two change what
gets built, so implementation should not start ahead of them.
