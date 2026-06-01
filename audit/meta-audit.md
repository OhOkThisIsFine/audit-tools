# Meta-audit: my experience running `/audit-code`

Running the audit-code orchestrator on the `audit-tools` monorepo itself (dogfooding),
while logging friction, ambiguity, errors, and surprises as a host agent driving the loop.

Format: chronological log. Each entry = step + observation + severity (nit / friction / ambiguity / error / blocker).

---

## Pre-flight

- **[ambiguity, low]** The `/audit-code` loader gives two command forms: `audit-code …` (global bin)
  vs `node audit-code.mjs …` ("inside the auditor-lambda repository itself"). I AM inside the repo,
  but the wrapper lives at `packages/audit-code/audit-code.mjs`, not repo root, so neither form is
  literally copy-pasteable from the worktree root. Had to resolve the path myself.
- **[ambiguity, low]** Naming mismatch surfaces immediately: the loader/skill say "auditor-lambda
  repository", but the actual repo is `audit-tools` and the package dir is `packages/audit-code`.
  Knowing these are the same thing requires the CLAUDE.md decoder ring.
- **[note]** Unclear whether running from the worktree root audits the whole monorepo (intended?)
  or whether I should scope to a single package. Defaulting to whole-repo from worktree root.

---

## Step: `ensure`

- **[friction, medium]** `node packages/audit-code/audit-code.mjs ensure --quiet` failed immediately:
  `ENOENT ... packages\audit-code\dist`. The working tree isn't built in a fresh worktree, and the
  `/audit-code` loader's first instruction (`ensure`) has an implicit, undocumented prerequisite
  (`npm run build`). A host agent following the loader literally hits a hard error on step one.
  The error is a raw `ENOENT` with no hint like "run npm run build first" — diagnosing it requires
  prior repo knowledge (the CLAUDE.md build-order section).
- **[note]** Building shared-first then all, per CLAUDE.md, to use the faithful working-tree version
  (rather than the possibly-stale global bin the memory note warns about).

## Step: build (the worktree trap) — HEADLINE META FINDING

- **[error→false-positive-averted, HIGH]** `npm run build` (all) and then `npm run build -w packages/audit-code`
  BOTH failed with ~16 `TS2305 "Module '@audit-tools/shared' has no exported member X"` errors
  (`spawnLoggedCommand`, `buildQuotaSource`, `scheduleWave`, `shellQuote`, `applyWorkerTaskLaunchSettings`,
  `resolveOpenCodeSpawnCommand`, `buildProviderModelKey`, `ScheduleWaveOptions`, `resolveWorkerTaskTimeoutMs`, …).
  At face value this looks like "the repo's main/release commit does not build" — a severe finding.
- **It is NOT real.** Verified against source: `packages/shared/src/index.ts` exports every one of these,
  and the freshly-built `packages/shared/dist/index.d.ts` contains them. The true cause:
  - This worktree has **no `node_modules`** (`npm install` never ran here).
  - Node/tsc resolution therefore walks UP to the **main checkout's** `node_modules/@audit-tools/shared`,
    which symlinks to the MAIN checkout's `packages/shared`, whose `dist` is an OLDER build
    (grep for the new exports → 0 hits). So the dependents typecheck against a stale `shared`.
- **Why this matters for the audit tool specifically:** Claude Code's *own* git-worktree feature
  (this session is in `.claude/worktrees/festive-hofstadter-afd3a8`) drops you into exactly this state.
  The `/audit-code` loader says "inside the repo, use `node audit-code.mjs ensure`" but never says
  `npm install` / build is required, and nothing detects or explains the stale-resolution trap.
  A less careful host agent would confidently report a non-existent "broken build" finding.
  This is a close cousin of the known "dogfooding trap" (global bin is stale vs working tree).
- **[friction, HIGH]** Recovery requires repo-specific knowledge not surfaced anywhere in the workflow:
  run `npm install` in the worktree to create the local workspace symlink, then rebuild shared+audit-code.

## Step 1: `design_review`

- **[observation, good]** A single `next-step` call ran the entire deterministic pipeline (manifest →
  disposition → structure → planning → risk → 12 structural findings) and handed me a rich, well-structured
  design-review prompt. The deterministic front-loading is genuinely nice; I didn't have to drive those steps.
- **[error in TOOL OUTPUT, medium]** The file inventory misclassifies file types:
  "gcc machine description: 49" (these are Markdown `.md` files — GCC uses `.md` for machine descriptions,
  and the classifier's linguist-style mapping is winning over Markdown) and "miniyaml: 11" (OpenRA format;
  almost certainly `.yml`/`.yaml` or similar misread). The repo has zero GCC/MiniYAML files. This is the
  audit tool mislabeling its OWN repo — a credibility hit in the very first artifact a user sees.
- **[nit] denominator inconsistency**: header says "489 files"; the "dominant unit" structural finding says
  "238 of 401 files (59%)". Two different totals (489 vs 401) presented without explaining the gap
  (~88 files presumably dispositioned out). Minor but confusing in a flagship report.
- **[ambiguity, low]** The repo name shown is the worktree dir name "festive-hofstadter-afd3a8" (a throwaway
  Claude-Code worktree slug), not "audit-tools". Findings/report will be stamped with a meaningless name.

### design_review — executing the step

- **[positive]** The prompt is genuinely good: rich deterministic context (units, 1488-edge graph, 40 surfaces,
  40 flows, risk scores, 12 structural findings), a clear schema, and "prefer fewer high-quality findings."
  This is the kind of context that makes a qualitative review tractable.
- **[ambiguity, medium]** "Read the project source to understand what it does and how it works" has NO scope/budget
  guidance for a 489-file repo. A host agent could read 5 files or 200. I self-limited to the orchestration cores +
  providers + shared barrel. Different agents would produce very different depth — non-deterministic review quality.
- **[ambiguity, low]** The output schema example hardcodes `"lens": "architecture"`. Unclear whether other lens
  values are permitted for design findings. I used architecture/maintainability/data_integrity/operability/reliability;
  if the ingestion validates lens against a fixed enum this could reject findings.
- **[friction, low]** CLAUDE.md is by far the best architecture document in the repo, but the prompt never points to it;
  the deterministic context partially re-derives what CLAUDE.md already states. A host without my context wouldn't know to read it.
- **[trust erosion]** The inventory misclassification (DR-005) sits IN the context I was handed, so I had to
  consciously discount the file-type section while trusting the graph/units. A report that mislabels its own inputs
  makes the agent second-guess the rest.

## Step 2: `dispatch_review` (the bulk phase) — second HEADLINE finding

- **[error/design, HIGH] wave_size=1 is an artifact of failed model detection.** dispatch-quota.json shows
  `model: null`, `source: "provider_default"`, `confidence: "low"`, `resolved_limits.context_tokens: 32000`,
  `output_tokens: 4096`, and `estimated_wave_tokens: 32289`. Because the auditor couldn't detect the host model
  (we ARE running inside Claude Code/Opus with ~200k context), it fell back to a 32k default, and since one
  packet's estimate (32289) already exceeds 32000, it forces strictly SERIAL dispatch of all 95 packets.
  On a host that supports large context + parallel subagents this is pathological: a ~170-task audit that could
  run ~10–16 wide is instead 95-deep serial. The single biggest throughput problem in the run.
- **[friction, HIGH] scale**: 95 packets / 170 tasks. Even parallelized this is a very large, expensive fan-out;
  serial (as the contract dictates) is impractical for an interactive session.
- **[error/design, MEDIUM] ~60 `large_packet` warnings**: packets of 2,600–4,009 lines flagged as "may hit quota
  limits." The packet chunker (chunking.ts) is emitting packets sized well past the resolved budget — so even
  the tool predicts many of its own dispatches may fail. Chunker target size and resolved token limits are not
  reconciled.
- **[contract inconsistency, LOW]** The dispatch prompt says "Each dispatch plan entry includes an `access` object
  with `read_paths` and `write_paths`" and to pre-approve them, but plan entries (entry[0]) have NO `access` key —
  the access data lives only at the step level. A host honoring the instruction literally would find nothing to pre-approve.
- **[ambiguity, MEDIUM]** The contract says "launch up to wave_size subagents in parallel" but provides no guidance
  for when wave_size is obviously wrong (a low-confidence provider_default). The host must either obey a crippling
  serial cadence or knowingly deviate from the contract. There's no documented escape hatch (e.g., set model in
  session-config to raise limits).
- **[decision]** Pausing to confirm scope with the user: full 95-packet run vs a representative demonstration,
  given the cost and the meta-audit framing. Note: the priority chain requires ALL audit_tasks_completed before
  ingestion/synthesis, so a partial subset will NOT cleanly reach a synthesized report — next-step would just
  re-dispatch the remainder. That constraint shapes the options.
- **[CONFIRMED BUG, from user] wave_size miscalculation is a KNOWN, recurring defect**: user states it is "still
  not being calculated correctly after repeated attempts to fix it." So the serial-dispatch pathology I observed
  is not a one-off — it has resisted multiple fixes. Strong signal that the quota/wave-size resolution path
  (model detection → resolved_limits → estimated_wave_tokens → wave_size) needs a different approach, not another patch.
- **[decision, mine]** Executing full run via the Agent tool in manual waves of 10 (the contract's named mechanism
  is "the task tool or equivalent subagent dispatch"; honoring exact wave_size=10 per user). Using **Sonnet** for the
  bulk review subagents — feasible/affordable at 95-packet scale and strong at bounded per-lens review. The
  self-healing next-step loop (re-dispatches packets lacking results) covers any subagent that fails to submit.

### Executing the 95-packet bulk review (waves of 10)

- **[positive]** Dispatch mechanism is robust: 95/95 packets submitted valid AuditResults, 0 rejected on ingest.
  The packet-prompt → subagent → submit-command → result-file → merge-and-ingest pipeline worked flawlessly at
  10-wide concurrency. Self-healing (re-dispatch missing) never needed for content reasons.
- **[cost reality]** Per-packet subagent cost ~25k–115k tokens (~60k avg), 30s–240s each. ~95 packets ≈ 6–7M
  subagent tokens for the review phase alone. The full audit of a ~30k-LOC repo is a multi-million-token operation.
- **[ERROR/BLOCKER, HIGH] hit ACCOUNT session usage limit mid-run (wave 8).** All 10 subagents returned 0 tokens
  + "You've hit your session limit · resets 3:30pm". The audit's OWN quota subsystem (the thing meant to pace
  dispatch) has no visibility into the host account's usage cap, so it can't prevent or gracefully handle this.
  Recovery was manual: confirm the reset time had passed, re-dispatch the failed wave. A long unattended run would
  silently lose a wave's work (subagents that died mid-task without submitting). The audit tool should detect
  "worker returned a host-limit sentinel" and treat it as retryable/paused rather than a normal (empty) result.
- **[error/design, MEDIUM] `spurious_file_count` balloons across rounds.** First merge: 3 (genuine stray files
  some subagents left: `packet-23-results.json`, `tmp-packet-87-result.json`, etc.). Each later merge re-counts ALL
  previously-ingested result files as "spurious" (3 → 173 → 179 → 185 → 191) because they aren't in the *current*
  round's dispatch plan. Harmless but it buries genuine stray-file warnings and looks alarming. merge-and-ingest
  should archive/move ingested results or scope the "unexpected" check to the active run plan.
- **[worker hygiene, LOW]** A few subagents wrote extra/temp files (`tmp-packet-87-result.json`, plural
  `*-results.json`) alongside the canonical submitted result. Submit still worked; but worker prompts/submit tooling
  could clean up or forbid stray writes.
- **[false-alarm averted, again] selective deepening LOOKS like it loops but converges.** After the base 170 tasks,
  ingestion adds 6 "selective deepening" tasks per round; I saw 4 consecutive rounds each "Added 6" and worried it
  was non-terminating. Verified against source (selectiveDeepening.ts:976-983) and the task manifest: there is a
  cumulative cap `DEFAULT_MAX_TOTAL_DEEPENING_TASKS=24` that counts completed deepening tasks too. 6×4=24 → cap hit
  → 5th ingest added 0 → advanced to runtime_validation. Working as designed. BUT the UX is poor: nothing in the
  per-round output tells the host "18/24 deepening budget used," so a host can't tell convergence from a loop
  without reading source. A progress line ("selective deepening: 24/24 budget reached") would remove the doubt.
- **[friction, MEDIUM] dispatch_review reappears many times** (1 base + 4 deepening rounds = 5 dispatch/merge/next
  cycles), each re-emitting wave_size=1. For a host, the loop is: read plan, dispatch, merge, next, repeat — with
  no aggregate "you are N% through the whole audit" signal. Easy to lose the thread over a long run.
- **stats so far:** 176 review tasks (170 base + lens-steward/deepening), ~390+ raw findings pre-synthesis.

## Steps 3-4: runtime validation + synthesis — third HEADLINE finding

- **[positive]** Synthesis SUCCEEDED at producing the real deliverables: `audit-findings.json` (583KB) and
  `audit-report.md` (441KB), **404 findings** merged/deduped (27 high / 127 medium / 235 low / 15 info),
  394 files audited, 3 remediation work blocks, 8 runtime-validation confirmations. The design-review findings
  (DR-001..DR-008) are merged in. So the audit substantively COMPLETED — the primary outputs are valid and complete.
- **[BUG, HIGH] deterministic executor loop OSCILLATES.** A single `next-step` (after ingestion) ran the internal
  advance loop to **iteration 708/1000** before crashing. The cap is 1000; 708 internal iterations for what should
  be ~2 deterministic steps (runtime_validation → synthesis) means `runtime_validation_current` and
  `synthesis_current` are invalidating each other in the staleness DAG and ping-ponging. After the crash,
  audit_state shows synthesis_current=stale again despite synthesis having rendered successfully. This is a
  convergence bug in the staleness/dependency logic (staleness.ts / artifactMetadata.ts / the advance loop).
- **[BUG, HIGH — Windows] EPERM atomic-rename crash.** The crash at iter 708 was:
  `Failed to write runtime_validation_report.json: EPERM: operation not permitted, rename '.<tmp>' -> 'runtime_validation_report.json'`.
  The write-tmp-then-rename pattern fails on Windows when the destination is locked/open (antivirus, or a concurrent
  reader/writer — and the oscillation means runtime_validation_report is being rewritten hundreds of times). For a
  "Windows-aware" project this atomic-write helper needs Windows rename-retry (EPERM/EBUSY backoff) — ironically the
  repo HAS file-lock retry logic in shared/quota/fileLock.ts but the artifact writer (io/json.ts writeJsonFile)
  apparently doesn't use a retrying rename.
- **[BUG, MEDIUM — transient] MODULE_NOT_FOUND on a follow-up next-step.** A subsequent `next-step` invocation died
  with a top-level `MODULE_NOT_FOUND` (it had worked seconds earlier). Likely a concurrent cleanup/process race
  (there were 7 node.exe still live) transiently removing/moving a required file mid-load. Non-deterministic startup
  failures like this make the loop fragile under concurrency.
- **[friction, HIGH] the finalization is where it falls apart.** The expensive part (170+24 LLM reviews) all
  succeeded; the cheap deterministic finalization (runtime validation + synthesis state-tracking) is what thrashed,
  crashed, and left the run in a non-terminal state — even though the deliverables on disk are complete. A user
  watching this would see "it crashed" and might not realize the report was actually produced.
- **[note] synthesis_narrative_current = missing** — optional LLM narrative layer (themes/exec-summary/top-risks)
  not produced. It "omits cleanly without a provider," but inside Claude Code the host COULD produce it; the loop
  never got there because it crashed first.
- **[confirmation] reproduced twice.** Re-running next-step oscillated again to **iteration 891/1000** and crashed
  on EPERM renaming `audit-report.md` this time (first run: 708, runtime_validation_report.json). Non-deterministic
  iteration count + different victim file each run = classic Windows atomic-rename-under-churn fragility. dist and
  the `shared` symlink are confirmed INTACT, so the one-off `MODULE_NOT_FOUND` was a transient concurrency race
  (multiple next-step/cleanup processes touching files at once), not a real breakage — but non-deterministic
  startup failures under concurrency are themselves a robustness gap.

## Conclusion

- **Audit substantively SUCCEEDED.** End-to-end run completed every phase that matters: deterministic intake →
  design review (8 findings) → 170 agent reviews + 24 selective-deepening → runtime validation (8 confirmations) →
  synthesis. Canonical `audit-findings.json` + `audit-report.md` rendered with **404 findings**
  (27 high / 127 medium / 235 low / 15 info) across 394 files. Deliverables preserved to
  `%TEMP%/audit-tools-audit-output/`.
- **It did NOT reach a clean terminal `complete` state** purely because of the deterministic-finalization
  oscillation + Windows EPERM. The expensive LLM work was 100% reliable; the cheap bookkeeping at the end is what's
  broken. That inversion is the single most important takeaway.

### Friction ranked (highest first)
1. **Finalization oscillation + Windows EPERM** (synthesis↔runtime_validation, ~700-900 iters, crashes) — HIGH, blocks clean completion.
2. **Worktree build trap** (no node_modules → resolves to main checkout's stale shared dist → fake "missing export" errors) — HIGH, blocks startup, easy to misdiagnose as a broken release.
3. **wave_size=1 miscalc** (model detection fails → 32k provider_default → serial) — HIGH, known/recurring; cripples throughput.
4. **Account session-limit invisible to the audit's own quota system** — HIGH, silently kills a wave mid-run.
5. **`ensure` has no preflight/doctor** — MEDIUM, turns 1-3 into cryptic errors.
6. **File-type misclassification** (.md→"gcc machine description", .yml→"miniyaml") — MEDIUM, erodes trust in the very first artifact.
7. **`spurious_file_count` inflation** (3→191) — MEDIUM, buries real stray-file warnings.
8. **Two false alarms that cost investigation time** (deepening "loop" that actually caps at 24; "broken build" that was stale resolution) — MEDIUM; both needed source-reading to disprove → better progress/telemetry would prevent the doubt.
9. **No aggregate progress signal** across the 5 dispatch/merge/next cycles — MEDIUM.
10. **Contract nits**: dispatch prompt promises a per-entry `access` object that isn't present; two different file-count denominators (489 vs 401); repo name shown is the throwaway worktree slug; design-review prompt gives no scope budget for a 489-file repo; lens enum ambiguity. — LOW each.

### What worked well
- Deterministic front-loading (one next-step ran the whole analysis pipeline and produced a rich design-review prompt).
- The packet → subagent → submit → merge-and-ingest pipeline: 100% valid submissions, 0 rejects, robust at 10-wide.
- Self-healing re-dispatch and idempotent merge made the session-limit interruption fully recoverable.
- Selective deepening + lens-steward verification is a genuinely good design (bounded, finding-driven).

