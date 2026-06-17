# Backlog — known friction, deferred fixes & future product directions

A living log of things to fix or build later, so they are not lost between
sessions. This is also the home for deferred product-design specs that are still
too early to encode as implementation contracts.

**Remove an entry once it ships** — this is a to-do list, not a status log. When
an item needs design detail, record durable contracts, gates, and principles
rather than "where the code is today."

> **Last reconciled 2026-06-13** against the shipped rolling-dispatch redesign +
> the self-audit remediation. Removed (verified against current `src`): the whole
> "2026-06-11 dogfood" friction block — lens interactivity, conceptual-review
> depth, `wave_size`→rolling, host-only `next-step`, canary, packet proximity,
> quota pre-check — all resolved by the redesign; the stale "waves" wording item;
> and the shipped-status entries (workflow redesigns, contract-pipeline build,
> agent reflections, scope/intent checkpoint, structured fast-path). A design-doc
> drift check ran the same day — unbuilt design commitments are now tracked under
> *Design commitments not yet built*.
>
> **Re-reconciled 2026-06-13 (second pass)** against `src`: removed the `opentoken
> wrap` friction and the orchestrator opentoken work-item (verified gone from src;
> guard test `no-opentoken-guard.test.mjs`; superseded by the headroom proxy);
> narrowed the `free_form_intent` commitment to its genuinely-unbuilt halves —
> clause escalation (`interpretFreeFormIntentForAudit` still unwired) and
> remediate-code interpretation (audit-code no-verbatim + lens weighting already
> shipped).

## Accepted go-forward program (2026-06-15 review)

After the 2026-06-15 self-remediation, Ethan was shown the design-review + free-form items that the
run had auto-dispositioned without surfacing them (only 12 of 42 architecture findings got code; 30
were silently "direction recorded" / "already true" inside `*-quality-tail` blocks). Full per-item
pros/cons were captured in `.audit-tools/deferred-items-for-review.md` at decision time; the durable
record of what was **greenlit** is here. Each is a target, not a status line — remove when shipped.

- **Review-necessity approval gate (root cause of this whole thread) — ✓ COMPLETE + SHIPPED**
  (remediator-lambda 0.27.0, 2026-06-16). ONE review surface per run for both paths; design-review /
  free-form findings can no longer be silently auto-dispositioned by quality-tail blocks (enforced in the
  tool, not host discretion). Path A gates the original findings at intake; Path B gates the deduped/grounded
  node findings at the planning point. The classic impl-risk preview is removed. Detail in memory
  `review-gate-execution-status`. (Kept here as the program's anchor; everything below was downstream of it.)
- **A1 — Fast path past the contract pipeline — ✓ DONE (2026-06-17, `b47d189`).** A conservative lean
  fast path: `evaluateFastPath` (`remediate-code/src/steps/leanFastPath.ts`) admits ONLY a handful (≤5) of
  S7-grounded (`grounding.status==="grounded"`), high-confidence, ≤5-file, non-systemic / non-related-coupled
  / non-architecture-lens structured-audit findings, and defaults to the full pipeline on ANY doubt — that is
  how "a mis-routed subtle change must not skip the safety net" is enforced (a misclassified complex change
  costs extra pipeline work, never a skipped design review). `buildLeanExtractedPlan` emits the SAME
  `extracted-plan.json` the contract pipeline promotes, so the lean path rejoins the existing
  plan→implement→close machinery untouched; the RETAINED safety net is the deterministic grounding re-pass +
  `applyPlanPipeline`'s affected-file hash snapshot + per-node verify-before-merge + the final whole-repo gate.
  Only the adversarial critic→judge→repair + obligation derivation are dropped. Wired into
  `handleReadyIntakeContractPipeline` right after the Path-A review gate (over `gate.approved`) so coverage is
  still built over the originals and declined findings keep their dispositions. The insight that kept it small:
  the heavy pipeline was only ever ONE producer of `extracted-plan.json`; the lean path is a second producer,
  so it needs no new join point. New grounded fixture + unit/integration tests; both existing structured-audit
  fixtures lack the S7 verdict, so every prior pipeline test stays on the pipeline path. (ARC-ad53dd0d.)
- **A3+A4 — Unify the two obligation engines + canonical remediation item. IN PROGRESS** (plan +
  decomposition: [`a3-a4-engine-unification-plan.md`](a3-a4-engine-unification-plan.md)). audit-code is
  already declarative (a `PRIORITY[]` linear scan over a content-hash staleness DAG); remediate re-derives
  selection in an imperative guard cascade (`steps/nextStep.ts` `decideNextStepLoop`) with back-edges +
  internal recursion → collapse to ONE shared declarative engine. **Step 1 DONE** (`4a041d0`): the
  ordered-selection scan + the `Obligation`/`ObligationState` vocabulary are single-sourced in
  `@audit-tools/shared` (`findFirstActionableObligation`); audit binds `PRIORITY` onto it.
  **Scope corrections from recon (durable):** (a) the engines are structurally divergent — audit
  emit-only / one-unit-per-call vs remediate transition+emit / recursive — so the shared engine grows a
  transition/emit `advance` loop at the remediate-rewire step (proven by its real consumer, not built
  consumer-less). (b) A4's "8 finding_id types + 2 ledgers → 1" is **over-specced**: `RemediationItemState`
  already IS the canonical hub, `TestSpec` was dead (deleted `ee3431e`), `VerificationResult`/`TriageBatch`
  are thin transients, and `CoverageLedgerEntry`/`RemediationOutcomeItem` are genuinely distinct domains —
  real A4 = formalize the hub + fold the transients + single-source the disposition vocab; the
  `RemediationItemState`→`RemediationItem` rename is unnecessary ~10-file churn (the name is already
  accurate — skipped). **A4 DONE** (`ed6ad2a` / `6283a34` / `6fea584`): dead `VerificationResult` deleted +
  `TriageBatch` localized to `triage.ts`; new `state/itemStatus.ts` is the single authority for the
  `RemediationItem` status enum + every classification of it — the `statusToDisposition` /
  `dispositionToOutcomeStatus` maps (exhaustive `Record<RemediationItemStatus,…>`) and the
  `isTerminal` / `isVerifiedComplete` / `isSkip` / `isInProgress` predicates — retiring the duplicated
  `OUTCOME_BY_STATUS` map, the 3× `isSkip` open-codings, and the 7× `resolved||resolved_no_change` ones. The
  extracted status enum is the formalized hub; recon also corrected the plan's ambiguous "merge the two
  disposition unions" — `PerFindingDisposition` (terminal outcome) and `CoverageLedgerEntry.disposition`
  (planning fate) are disjoint domains and stay separate; only the status→vocab *mapping* was single-sourced.
  **A3 step 3 (the keystone) IN PROGRESS** — `decideNextStepLoop` is now
  preamble → `advance(pre-intake)` → `countStep` → `advance(main)`, the whole guard cascade re-expressed as a
  declarative `ObligationDef` list on the shared `advance` loop: **3a** `8250aab` (added `advance` /
  `ObligationDef` / `findNextObligation` to `@audit-tools/shared/src/engine/`, 10 unit tests); **slice 1**
  `79e2dcd` (pre-intake gates, +2 teeth-verified regression tests for the entry-gate-freeze + cascade-ordered-
  warning traps); **slice 2a** `ae0326c` (post-intake tail + the 3 tail recursion sites → transitions).
  **Remaining — slice 2b:** unwind the phase-handler internal recursion (`handlePlanning` /
  `handleImplementing` / `handleAllTerminalTransition` / `handleClosing` / `buildImplementDispatchStep` still
  `return decideNextStepLoop(...true)`) into `transition`/`emit` outcomes; 3 boundary cases need individual
  regression tests (closing→complete cross-engine, `buildImplementDispatchStep` merge-reenter, forceReplan/
  count) — see the plan doc Status. Then step 4 reconcile (drop vestigial `skipCount` + dead params; parity-
  check audit vs remediate). The redesign track. (ARC-f5a5612b, ARC-f5a5612b-3, ARC-b85edf3f.)
- **A8 — Rolling dispatch: one shared core + two co-equal full-rolling drivers (REFRAMED 2026-06-16).**
  NO LONGER "flip a flag / delete the host fallback" — that reading was incoherent with conversation-first
  (in-conversation subagent dispatch is FIRST-CLASS; subscription/no-API users depend on it — memory
  `conversation-first-subagent-dispatch-first-class`). Target: ONE shared rolling `acceptNode` core
  (per-node worktree → tool-owned commit → verify-in-worktree → cherry-pick merge → branch-diff write-scope)
  fed by TWO full-rolling drivers selected by availability — (1) **host-subagent** (turn-based per-completion
  `accept-node` callback; soft-isolation-by-detection since the host's subagent can't be cwd-confined) and
  (2) **in-process provider** (codex/local-LLM/`claude -p`-when-not-nested; cwd-confined hard isolation).
  **Progress (on `main`, unpublished):** in-process driver functional `dc4d9c2`; codex provider real `0fa13d3`;
  shared `acceptNodeWorktree` core extracted `d2003313`; host-subagent driver BUILT (`73424050`/`414e302e`);
  **host-subagent driver VALIDATED via real-subagent end-to-end smoke + a false-resolve bug found & fixed
  (`f18138fe`) — both rolling drivers discarded `acceptNodeWorktree`'s `merged` outcome, so a verify-failed
  in-scope node was marked `resolved` while its fix never landed; fix = per-node accept-outcome sidecar +
  merge-state gate in `mergeImplementResults`, red→green + real-git tests, suite 1622.** **DONE
  (2026-06-17):** the in-process PROVIDER path is built, WIRED into `decideNextStep` (routes there when
  `rolling_engine` ON + an explicit backend provider is configured — precedence over host-subagent), and
  validated end-to-end through the REAL next-step path over live NVIDIA NIM (`tests/nim-rolling-e2e.test.ts`,
  gated `RUN_NIM_E2E=1`): ≥2 nodes land via worktree→verify→merge, a verify-fail auto-retries (capped) then
  routes to triage (`blocked`), never false-resolved. The `openai-compatible` provider was built to make NIM
  usable (codex+NIM is a dead end — codex 0.140 dropped `wire_api=chat`; NIM's Responses API rejects codex's
  `namespace` tools). **`rolling_engine` flipped default-ON `8819713`** — rolling is the implement default;
  the wave is opt-out (`rolling_engine:false`). **Remaining:** (a) audit-code symmetric wiring of
  `runRollingDispatch` (still dormant); (b-residual) the {host-subagent (Claude) + NIM} HYBRID topology + a
  live cross-provider spill run (see *Cross-IDE/provider quota detection* below). *(FIXED: worktree-branch reuse
  across a `rate_limited` re-queue — `resetNodeWorktreeAndBranch` removes the worktree, prunes stale admin
  entries, and force-deletes the leftover branch so every re-dispatch starts clean from HEAD.
  FIXED: the worktree-walks-up-to-parent-repo foot-gun — `createWorktree`
  now asserts `git rev-parse --show-toplevel` == the target root and refuses rather than escaping to an ancestor.
  FIXED: `openai-compatible` is now surfaced as a confirmed pool — `discoverProviders` config-gates it,
  `buildConfirmedPools` emits it as a 2nd CapacityPool alongside the primary, and `makeProviderNodeDispatcher`
  resolves the provider PER-SLOT so the INV-QD-14 spill mechanically routes a node to the openai-compatible pool
  in the in-process driver.)* Plan: `docs/a8-rolling-cutover-plan.md`. (ARC-f378135d family.)
- **B1 ✓ DONE / B2 / B3 — greenlit** (magic-numbers audit [done — see *Known friction* below],
  diff-based-re-review, and staleness-cascade; B2/B3 are accepted work, not just logged friction).
- **B4 — Hard-exclude tool-refuted findings — ✓ DONE.** A tier-2 REFUTED finding (e.g. a madge-disproven
  cycle) is now a distinct `grounding:'refuted'` status, quarantined-EXCLUDED from the admitted contract
  rather than collapsed into `ungrounded` (still-merged-as-fact). Shipped: (1) `FindingGrounding.status`
  gained `"refuted"` (shared `finding.ts`) + the `audit_findings` schema enum; (2) `combineGroundingWithAnchor`
  returns `refuted`; (3) synthesis partitions refuted findings out of `findings`/`work_blocks` into
  `AuditFindingsReport.quarantined_findings` (quarantine, not delete — the raw `audit_results.jsonl` still
  retains them); (4) the report renders a "Refuted Findings (quarantined — excluded)" section + the breakdown
  counts `refuted`; (5) `mergeGrounding` precedence is grounded > refuted > ungrounded (a grounded pass still
  wins — "refuted only excludes when nothing grounded it"); (6) tests in `grounding-surfacing.test.mjs` +
  `anchor-grounding.test.mjs`. (ARC-48c05a13, ARC-48c05a13-2.)
- **B8 — Finding-merge location discriminator — ✓ RESOLVED (no code change; decision + guard).** Recon
  confirmed the real authority is `shared/src/findingIdentitySignature.ts` (drift-plan R2). Its tier-1
  (`anchor|path|scope`) already discriminates by location; the only location-free collapse is tier 2
  (`rule|lens|category`), which fires solely for FILELESS findings. **Decision (2026-06-17): the collapse is
  CORRECT, not a bug.** A fileless finding's only stable identity is lens+category; the title is deliberately
  tier 3 (volatile, so reworded re-emissions still collapse). Adding the title to tier 2 to split such
  findings would re-introduce exactly the over-splitting the single-source authority exists to prevent — a
  genuinely different fileless defect must differ by CATEGORY (the auditor's discriminator). Documented in the
  tier-2 comment + an explicit `B8 decision` guard test in `finding-identity.test.mjs`. (ARC-1a497c28-2.)
- **A5+A11 — Two-tier dependency policy + vetted manifest parsers — ✓ DONE.** Policy written (CLAUDE.md
  *Preferences*: import vetted pure-JS libs for correctness-sensitive parsing/schema/lock; own only tiny
  fully-owned domain bits). Replaced the hand-rolled TOML scanner (`toml.ts` → `smol-toml`) and YAML scanner
  (`yaml.ts` → `yaml`) — both now parse properly, so Cargo `workspace.members` (dotted-key + inline-table),
  pyproject `[tool.pytest.ini_options].testpaths` (dotted + scalar), pnpm `packages:` (inline-flow), and
  nested YAML path refs are recovered instead of silently dropped. `cargo.ts`/`pyproject.ts`/`pnpm.ts`/
  `yamlPaths.ts` rewritten to walk the parsed object; all degrade to empty on malformed input (never throw).
  audit-code's first third-party runtime deps (`smol-toml`, `yaml`) — both pure-JS / OS-agnostic. Dropped-edge
  regression tests added. (ARC-843ce274, ARC-4d950c7f.)
- **A6 — Kill the schema dual-encoding.** 47 JSON schemas + parallel hand-written TS validators (already
  drifted once); single-source one from the other so drift is impossible, and remove the dead-imported
  `ajv`. (ARC-ad53dd0d-2.)
- **A12 — Single-package collapse** (see *Single-package install/publish* below; Ethan reversed the
  earlier same-day defer — now wanted).
- **A7 (REFRAMED) — Validate the host machinery EVERYWHERE, don't cut it.** The multi-host vision is
  alive: Ethan uses the package regularly in **Codex, OpenCode, and Antigravity**, not just Claude Code.
  The finding flips from "delete the unvalidated 7-host install ceremony" to "build real
  install/verify/integration validation across all hosts" — Claude Code is the only validated route
  today. (ARC-32e49e65, reframed.)

**Deferred this round (not greenlit now):** A2 — falsifiable finding-quality oracle (golden corpus,
precision/recall, hallucination rate gated in CI). High value, own track; revisit. (ARC-fab14144.)
A9 (single autonomy acceptance test) and A10 (multi-process coordination primitive) revisit when A8
makes multi-process concrete. Tier-C cleanups + B5/B6/B7/B9/B10/B11 remain in the review doc, not yet
triaged.

## Known friction (agent / dev experience)

### Contract-pipeline friction surfaced during the 2026-06-15 self-remediation (systematic fixes wanted)

Hit while driving the full `remediate-code` contract pipeline over the 227-finding
audit + backlog + drift-plan. Ethan: find systematic fixes so this can't bite any
agent (strong or weak), not "be careful" patches.

- **B1 — Magic numbers audit — ✓ DONE (audited; one config knob added, rest verdicted).** Investigated
  every named constant; verdicts:
  - **Adversarial critic→judge→repair caps** (`MAX_CONTRACT_REPAIR_ITERATIONS` / `MAX_DAG_REGENERATION_ATTEMPTS`
    / `MAX_CYCLIC_SEAM_RESOLUTION_ATTEMPTS` = 2, `contractPipeline.ts`): **JUSTIFIED as-is.** The premise that it
    "runs a fixed 2 rounds" was inaccurate — the loop already runs UNTIL the judge approves (a clean round) OR
    the cap, then proceeds with residual risks. The 2 is an anti-oscillation safety valve, not a fixed count.
    Config-ifying would add `sessionConfig` coupling to a deliberately config-free module + a footgun (raise it
    and a non-converging judge runs unboundedly) for marginal gain. Left as-is.
  - **Anchor command timeout (60s)** → **CONFIG (shipped).** A legitimately-slow check on a large repo was
    silently killed → `inconclusive`; now `AUDIT_CODE_ANCHOR_TIMEOUT_MS` overrides it per-run (default 60s),
    mirroring the existing `AUDIT_CODE_DISABLE_ANCHORS` env pattern. `resolveAnchorTimeoutMs` + test.
  - **JUSTIFIED, no change:** `STALE_LOCK_MS`=30s (local crash-recovery timeout — correct), `hashContent`
    slice lengths (not magic — caller-supplied, single-source primitive), `BLOCK_SAFETY_MARGIN`=0.7 (structural
    host-prompt headroom invariant), the `>=4`-token paired-keyword filter (linguistic noise filter — sound),
    `ANCHOR_GROUNDING_CONCURRENCY` (already CPU-derived, clamped [2,8]).
  - **`DEFAULT_WAVE_SIZE`=5** (`dispatch.ts`): a legacy fallback that fires only when the host reports no
    concurrency limit; rolling dispatch now derives concurrency from quota, so it rarely matters. Low-priority;
    left (would be env-derivable if it ever bites). (Ethan, 2026-06-16.)
- **Re-reviews are full passes over unchanged designs — make them diff-based.** When an
  upstream artifact's content-hash changes, the conceptual critique / counterexample /
  assessment re-run as *full* passes even when the change was cosmetic (e.g. adding
  gate-satisfying verbatim text to `outputs` with no design change). A re-review should
  diff against the prior-reviewed version (with file access for context) and only
  re-examine what changed, returning "prior verdict still holds" cheaply. Today the host
  must either burn another full critic subagent (~100-190k tokens) or hand-re-emit the
  prior verdict. (Ethan, 2026-06-16.)
- **Staleness cascade re-runs the whole downstream chain on every upstream edit.** Any
  edit to finalized_module_contracts re-stales obligation_ledger → test_validator_plan →
  contract_assessment (and the host must re-author each), even when the obligation set is
  unchanged (stable ids). Cosmetic/text-only upstream changes shouldn't force full
  downstream re-authoring. Pairs with the diff-review item: staleness should be
  content/semantics-aware, or downstream artifacts keyed on the *obligation set* not the
  raw upstream hash.
- **Paired-obligation gate (OBL-CO-01) keyword regex is a hidden contract.** It scans each
  obligation's assertions for a positive-signal word (`passes|returns|produces|valid|
  matches|...`) AND a negative-signal word (`reject|throw|fail|never|not|...`); a `\b`
  word boundary means "POSITIVE:"/"NEGATIVE:" prefixes and words like "reproduced"
  (≠ `\bproduces\b`) DON'T satisfy it. Caused several rewrite loops. Fix: accept the
  explicit POSITIVE/NEGATIVE labels the prompt implies, or state the required keyword set
  in the prompt, or replace the regex heuristic with the explicit labels.
- **S5 seam-derivation gate (INV-CO-12) ignores `seam_adjustments`.** It builds its corpus
  from inputs/outputs/invariants/side_effects/validation_boundary only and requires every
  ≥4-char token of each seam `agreed_interface` to appear there — but `seam_adjustments`
  (the natural place to record a seam decision) is NOT scanned. Recording the decision
  where it belongs fails the gate; you must duplicate the verbatim interface into
  `outputs`. Fix: scan `seam_adjustments` too, or document the corpus + require the
  reflection there.
- **validate-artifact wants the plain payload; next-step wraps the file in a content-hash
  envelope.** After next-step, every artifact on disk is `{artifact_name, content_hash,
  dependency_hashes, payload}`; `validate-artifact` then rejects it (expects top-level
  contract_version/...). To re-validate or re-edit you must unwrap `.payload` back to a
  plain file. Non-obvious round-trip; either make validate-artifact accept the wrapped
  form, or don't rewrap files the host may still edit.
- **Async typecheck hook = stale-dist false alarm after shared edits.** After a worker
  edits `@audit-tools/shared/src`, the PostToolUse hook runs a dependent package's `tsc`
  against the not-yet-rebuilt `shared/dist` and reports phantom "no exported member"
  errors. Authoritative fix is the central single-flight `npm run build -w
  @audit-tools/shared`. Hook should rebuild shared first (or scope to the edited package
  only / debounce to the final edit). (Recurrence of the known mid-edit-hook item.)
- **Worker "build+check green" can be true for the worker yet stale for the next consumer.**
  A worker that edits shared can pass its own check (it rebuilt shared/dist) but the value
  to the *next* node depends on the central rebuild-between-levels actually running; a
  worker's green claim alone isn't sufficient. The rolling-engine wire-in (N-rolling)
  should own this; until then the host must run the central rebuild after each shared-
  touching merge.
- **Workers can't distinguish serial-prior edits from concurrent sessions.** Under serial
  host dispatch, worker N sees workers 1..N-1's edits as a "dirty tree" and (citing the
  memory note about concurrent sessions) assumed live concurrent writers. Harmless here
  because write-scope was respected, but the worker should be told its declared
  write-scope + that prior in-scope edits are expected — the rolling write-scope/ownership
  enforcement (ARC-f378135d-2) is the real fix.

- **`quota` command silently drops the capability-handshake flags.** The
  informational `quota` command parses neither the scalar
  `--host-context-tokens`/`--host-output-tokens` pair nor
  `--host-models`/`--host-model-id`, so its capacity estimate reflects only
  cached/learned limits. Low stakes (read-only diagnostics); wiring the flags
  would make it useful for previewing roster capacity. (The other half of this
  entry — `run-to-completion` — was resolved 2026-06-12 by deleting the batch
  loop entirely; `next-step` is the only terminal loop.)

- **Run CLAUDECODE-unset tests via the PowerShell tool, not nested `cmd /c`.**
  `cmd /c "set CLAUDECODE=&& npm test"` from inside the bash tool printed only the
  cmd banner and swallowed all test output. `$env:CLAUDECODE=$null; npm test` in the
  PowerShell tool works cleanly. (Spotted 2026-06-12 during N6.)

- **Implement-worker result `finding_id` placeholder is ambiguous → merge rejects.**
  `prepareImplementDispatch` renders the result template as `"finding_id": "FINDING-ID"`
  with a tempting `Satisfies obligations: FND-*` line just above it, so standard-tier
  workers report the `FND-*` *obligation* id (and split one node into several
  `item_results`) instead of the node/item id shown under `## Items` / `Findings:` —
  the `N-*` key that `state.items` is actually keyed by. `merge-implement-results`
  then throws `Unknown finding_id in implement result: FND-…`. The correct id is just
  `block_id` minus the `CP-BLOCK-` prefix. Fix in the renderer: emit the real node id
  into the template and instruct "one item_result per item id under ## Items; never use
  the FND-* obligation ids." Workaround 2026-06-13: inject the exact node id into each
  worker's dispatch wrapper prompt — eliminated the error for 11/11 wave-2 blocks
  (3/7 wave-1 blocks hit it and needed post-hoc result-file patching).

- **Global install defers `postinstall` under npm's allow-scripts policy.**
  `npm install -g auditor-lambda` installs the bin but prints
  `npm warn allow-scripts … (postinstall: node scripts/postinstall.mjs)` and skips
  it, so the host-integration deploy (OpenCode config + `/audit-code` skill/prompt)
  silently doesn't run. Finish with `npm approve-scripts auditor-lambda` or invoke
  `postinstall.mjs` manually. (This also gates the overbroad-perms deploy flagged
  by `CFG-4996560e`, so it's not purely a regression.)
- **`t.mock.module` is unusable in audit-code tests.** audit-code runs tests via
  `node --import tsx/esm --test`; `t.mock.module` needs
  `--experimental-test-module-mocks` and conflicts with the tsx/esm loader, so it
  throws `t.mock.module is not a function`. Use a dependency-injection point
  instead (e.g. `cmdWorkerRun(argv, deps)` in
  `src/cli/workerRunCommand.ts`) rather than module-graph mocking.
- **Backslash escaping / arg serialization.** Inline `node -e "…\\…"` (regexes,
  Windows paths) gets mangled by shell backslash handling — write a small script
  file instead of inlining. Separately, the Workflow tool's `args` can arrive as a
  JSON *string* rather than a parsed object, so `args.foo` is `undefined`; defend
  with `const a = typeof args === 'string' ? JSON.parse(args) : args`. (The
  orchestrator-rendered command path now routes through the shared
  `renderPromptCommand`/`toPromptPathToken`, so this is mainly a trap for
  hand-typed or inline `node -e` commands.)
- **The `Bash` tool mangles Windows backslash paths.** A plain command like
  `node C:\…\audit-code.mjs merge-and-ingest …` run through `Bash` drops the
  backslashes (`C:\a\b` → `C:ab` → MODULE_NOT_FOUND). Use the `PowerShell` tool for
  Windows-absolute-path commands, or forward slashes (Node accepts `C:/…`). The
  orchestrators now emit POSIX-slash commands for this reason (`renderCommand`), so
  the trap is mainly for hand-typed paths. The `opentoken wrap` step-JSON mangling
  friction graduated to a command-class wrap policy — control-plane commands are
  wrap-exempt, encoded in the dispatch prompts + memory
  `opentoken-wrap-mangles-orchestrator-prompts`.
- **Fresh git worktrees lack `node_modules`.** A newly created worktree resolves
  `@audit-tools/shared` against a stale `dist/` → spurious "no exported member"
  type errors. Run `npm install` in the worktree before `npm run check`.
- **New default-on orchestrator behavior breaks existing fixtures.** Turning a
  dispatch behavior on by default can change first-contact output and break
  end-to-end fixtures that assumed the old shape; the fix at the time was seeding
  the old default in the test helper. Any new default-on behavior needs a sweep of
  existing fixtures, or should ship default-off until they catch up. (The original
  canary example is gone — the canary→graduate phase was removed entirely — but
  the lesson stands.)
- **audit-code `node --test` needs the tsx loader.** Bare
  `node --test packages/audit-code/tests/*.test.mjs` fails with
  `ERR_MODULE_NOT_FOUND` because the `.mjs` tests import built `.ts` via `.js`
  specifiers. Use the canonical `node --import tsx/esm --test …`, as in the
  package's `test` script, or `npm run test:single -- tests/<file>.test.mjs`. This
  is a trap when running one test file by hand or telling a subagent to "run
  node --test".
- **The `Bash` and `PowerShell` tools share one working directory.** A `cd` inside
  a `Bash` call changes the directory the next `PowerShell` call runs in, so a
  later `npm run check -w packages/<pkg>` fails with *No workspaces found* because
  the path doubles. Use a subshell `(cd … && …)` in Bash, or pass absolute paths
  and `Set-Location` the repo root explicitly, rather than relying on per-tool CWD.
- **PowerShell block output cannot be piped inline after a `foreach` statement.**
  A shape like `foreach (...) { ... } | ConvertTo-Json` throws "An empty pipe
  element is not allowed"; assign the loop output first (`$out = foreach (...) {
  ... }`) and pipe `$out`.
- **PowerShell `-Filter` is not a regex.** Patterns like
  `document-FINDING-00[1-6].result.json` can match nothing even when files exist;
  use `Where-Object { $_.Name -match '...' }` for numbered result checks.
- **PowerShell unwraps single-element arrays in `ConvertTo-Json`.** `@(@{...})`
  collapses to a bare object, so a one-result `submit-packet` payload serializes as
  an object instead of a 1-element array and is rejected. Workers had to
  string-concat the surrounding `[`/`]`. The packet and worker prompts now carry
  this guidance (bracket-wrap the output, or `Write-Output -NoEnumerate`).
  (Sibling of the `foreach`/`-Filter` PowerShell traps above.)

- **`--host-can-dispatch-subagents` is documented as a boolean but defined with a value.**
  The `/remediate-code` and `/audit-code` loaders show `--host-can-dispatch-subagents`
  as a bare flag, but commander defines it as `--host-can-dispatch-subagents <value>`,
  so passing it bare swallows the *next* flag as its value
  (`… --host-can-dispatch-subagents --host-max-concurrent 4` made `4` a stray positional
  → "too many arguments for 'next-step'"). Spotted 2026-06-14. Fix: define it as a true
  boolean option (no `<value>`) so the documented usage works, or change the loader docs
  to `--host-can-dispatch-subagents true`. (The `--host-models` JSON roster itself passes
  fine through the PowerShell→.cmd shim when single-quoted.)
- **`conversation-start.md` is not auto-registered as an intake source.** When
  `/remediate-code` receives conversational/memory guidance *alongside* an `--input`
  report, the loader writes the guidance to `intake/conversation-start.md`, but
  `synthesize_intake`'s source-manifest lists only the `--input` document — so the
  guidance reaches planning only if the host folds it in by hand (it did, 2026-06-14).
  Fix: have intake discover `intake/conversation-start.md` (and any `intake/*.md`) and
  add it to the source-manifest as a supplementary `conversation` source, so mixed
  report+guidance runs are first-class.
- **Implement-worker `finding_id` trap recurred — renderer fix still unshipped.** The
  documented renderer fix above (emit the real node id + "one item_result per item id;
  never FND-*/OBL-* obligation ids") is still not in `prepareImplementDispatch`; the
  2026-06-14 run hit it again (an opus worker emitted one item_result per obligation incl.
  `OBL-WS-C` → `merge-implement-results` threw; the result file was patched post-hoc).
  Two-sided fix worth doing together: (1) renderer emits the node id + the one-entry rule;
  (2) make `merge-implement-results` *tolerant* — if an unknown `finding_id` is actually a
  known obligation id, map it back to its owning node instead of throwing (and collapse
  multiple per-obligation `item_results` for one node).

### Self-audit 2026-06-15 — confirmed dispatch / contract bugs (HIGH)

Surfaced live during a self-audit run (and independently by a Codex Desktop run on
another checkout). **Remediated 2026-06-15 except the rolling-engine cutover:** the
worker-prompt inline-vs-write contract mismatch (packet prompt now writes its
`AuditResult[]` to `result_path`, drift guard test added), the `quoted_text`
ungrounded root cause (a verbatim quote per finding is now effectively mandatory in
the packet prompt + self-check), and the `.gemini`/IDE-renderer `--host-models`
continuation drift (every IDE asset now derives from the one canonical body with a
no-drift guard) all shipped this run. The one item still open is the rolling-engine
cutover below.

- **Dispatch is host-waved, not quota-driven rolling — engine wired + flipped default-ON (2026-06-17).**
  Root cause (2026-06-15 conceptual review): the rolling dispatch + worktree engine
  (`runRollingDispatch` / `driveRollingDispatch` / `createWorktree`) had **zero
  non-test callers** — built, refactored repeatedly, never wired into the live path,
  so every run fell back to the host waving a static N-packet plan with
  `max_concurrent_agents` = the raw host flag. **DECISION 2026-06-15 (Ethan): WIRE THE
  ENGINE IN — option (a), NOT delete.** **DONE 2026-06-17 (cutover for remediate; see A8 above):** the flag is
  flipped **default-ON** (`8819713`) and the in-process provider engine (`driveRollingImplementDispatch`,
  over quota-derived pools with dispatch-next-on-complete + per-node worktree + verify-before-accept +
  write-scope/lost-update merge) is now WIRED into `decideNextStep` and validated end-to-end over live NIM
  through the real next-step path. The host-fanned wave is **RETAINED as an explicit opt-out**
  (`rolling_engine:false`), NOT removed — conversation-first subagent dispatch is first-class, so deleting it
  was never the right reading. **Remaining:** (2) symmetric wiring of
  audit-code's `runRollingDispatch` into the audit live path with the same flag-gated
  pattern (still dormant); (3) harden worktree-branch reuse across a `rate_limited`
  re-queue inside the in-process driver. Architectural constraint stands: in
  conversation-first mode the HOST spawns subagents, so the tool must drive rolling via
  the local-subprocess provider or own the dispatch-next-on-complete bookkeeping the
  host executes — not just emit a static plan.

### Auditor-agnostic robustness — enforce-in-tooling fixes (2026-06-14)

Surfaced re-evaluating the 452-finding remediation run under the standing invariant
*"enforce in tooling, never host discretion"* (CLAUDE.md). Each item is a place the run only
succeeded because a capable host intervened — a latent failure mode for a weaker auditor. The
fix is the enforced change, not host care. (The three Known-friction bullets just above —
finding_id trap, `--host-can-dispatch-subagents`, conversation-start intake — belong to this set.)

- **Single bootstrap, not write-then-call.** The loader has the host write
  `conversation-start.md` then separately call `next-step`. Enforce a single entry operation
  (`next-step` accepts `--guidance-file`, or the loader is one command) so no host must
  remember the two-step dance.
- **Upstream evidence must auto-thread to dependent nodes.** The still-real verification node
  produced the import-graph / COR-3410f5f6 / version verdicts; the host relayed them into the
  dependent workers' prompts by hand. Enforce: a node's result is automatically threaded into
  the dispatch prompts of nodes that depend on it (verification edges already exist in the DAG —
  the dispatcher should ingest the upstream result, not the host).
- **Bounded findings digest as an artifact.** Reading scope from the 742 KB
  `audit-findings.json` was hand-rolled PowerShell (overflow-prone). Enforce: intake emits a
  bounded findings digest (counts, by-severity/lens/package, top findings, work-block map) the
  step prompt points to — no host should query raw findings ad-hoc.
- **Worker verification commands declared, not improvised.** Build-race safety (never two
  `npm run build` on one package; verify via `check`+`test`; rebuild shared between dependency
  levels) was host reasoning. Enforce: the dispatch plan/worker prompt states the exact verify
  commands per node (check + package test, never build); the scheduler owns shared rebuilds
  between levels.
- **Rolling per-node dispatch + concurrency owned by the scheduler.** The host hand-grouped and
  hand-paced 6 waves. Enforce dispatch-when-verified-complete with a quota-driven concurrency
  pool + incremental merge (see *Design commitments not yet built → Rolling per-node dispatch*).
  The host executes a steady-state pool; it should not design the waves.
- **Write-scope enforced, not self-reported.** Two workers edited `shared` out of scope
  (converged green, but unenforced). Enforce: the merge validates each worker's actual edits
  against its declared write-scope and rejects out-of-scope writes (ARC-f378135d).
- **Cross-block break propagation.** An OBL-C002 behavior change broke a seam test (SEAM-8c) in
  another block that the host fixed by hand. Enforce: paired positive+negative obligations
  (already tracked) + a cross-block reconciliation pass so a behavior change derives the
  dependent expectations to update — no host mop-up.
- **Result-shape errors impossible by construction.** `finding_id` / one-entry-per-node and
  field-type schema errors should be caught at write-time by a shared validator the worker runs,
  and `merge-implement-results` should be tolerant (map obligation→node, collapse multi-entry)
  rather than throwing. *(Contract-pipeline half shipped 2026-06-15: `validate-artifact` CLI +
  `CONTRACT_PIPELINE_VALIDATORS` give workers a write-time self-check for the contract artifacts,
  referenced in every phase prompt. The implement-worker-result half — `finding_id` mapping +
  tolerant merge — remains, tracked under the `finding_id` Known-friction bullets above.)*
- **Mid-edit typecheck-hook false alarms.** The async PostToolUse hook fired on transient
  mid-edit states during concurrent waves (authoritative `check` was green each time). Enforce:
  debounce the hook / scope it to the final edit, and define the final-green node as the
  authoritative gate, so a weaker host isn't derailed by advisory noise.
- **Model tier set by the planner, not the host.** `model_hint.tier` was flat "standard"; the
  host hand-upgraded architecture-heavy nodes to deep. Enforce: the planner sets tier by node
  complexity.
- **Per-finding coverage ledger.** The run tracked 17 blocks, not 452 finding dispositions.
  Enforce a per-finding ledger so every source finding has an auditable terminal disposition
  (closes CE-007 / OBL-GOAL-COVERAGE).
- **Generator↔fixture drift guard.** `generate-auditor-contract-fixture.mjs` now imports the
  shared constant; add a test asserting regenerated output == committed fixture so the generator
  can never silently re-break the suite.

### Friction from the June 8–9 self-audit (auditor feedback)

- **Whether to allow declared-boundary files as `affected_files` evidence.** The
  `submit-packet` rejection now *lists* the task's allowed files (shipped
  2026-06-09), but auditors still may reference only their assigned files — a
  finding that needs to cite an in-boundary-but-unassigned file (e.g. a
  `schemas/finding.schema.json` to fully describe a duplicate-schema finding) must
  drop that evidence. Open contract decision: allow declared-boundary files as
  evidence, or keep the strict assigned-files-only rule.
- **Read tool truncates lines over ~2000 chars.** Large `file_coverage` arrays
  inside prior-result JSON exceed the per-line cap, so auditors couldn't
  reconstruct exact arrays and fell back to `Get-Content`/bash. Worth noting for
  any task that must read wide single-line JSON.

### Cross-package drift map — reinvented pieces to unite (2026-06-15)

A 6-way recon sweep mapped code duplicated/reinvented across `shared` + the two
orchestrators that should be single-sourced. Full plan with verified `file:line`
evidence: [`drift-consolidation-plan.md`](drift-consolidation-plan.md).

**Status — consolidation shipped 2026-06-15 (this self-remediation run).** Every
drift item the sweep found has landed: the live merge-trap bug (`ensureNodeId`), the
shared finding-identity-signature authority (R2), the step-contract writer (R3), the
IDE host-asset renderers (E1), the allowlisted read-only command runner + quote-verify
grounding moved to shared (E2/E3) with remediate honoring `finding.grounding` (G1), the
shared provider classes (E4) and `makeProviderKeyedFactory`/`collectClaudeCodeJsonLines`
(E5), and the small primitives P1–P9 (model-tier ordinal, severity/confidence rank
tables — fixing the inverted/off-by-one copies, `AccessDeclaration`, the single atomic
JSON writer, `mintUniqueId`, `hashContent`, `normalizeRepoPath`, the `.audit-tools` path
module, and the dispatch-tail/`model_hint.tier` prose) — each with a single-source guard
test. The CLAUDE.md lock doc-fix landed in Wave-0 and is now guarded by
`packages/audit-code/tests/file-lock-doc-sync.test.mjs`. **The only drift-plan item not
fully closed is R1 (wire the rolling engine), tracked above under *Self-audit 2026-06-15*
— wired behind a default-OFF flag this run, with the atomic cutover still remaining.**

- **Intermittent hermeticity flake: `phase-plan.test.ts` "non-audit JSON file falls through
  to the LLM extractor path".** Fails ~1-in-N full-suite runs, passes in isolation and most
  full runs (observed 2026-06-16 while adding the review-gate tests — unrelated code path).
  The two `runPlanPhase` describe blocks share module-level `currentRoot`/`currentOptions`/
  `baseState`, and the test asserts the LLM-extractor path *rejects* (ENOENT on a missing
  `result_plan.json`) — both are concurrency/global-state sensitive. Fix: scope the
  shared `let`s per-describe (or use the unique-dir-per-test pattern consistently) and make
  the "falls through → throws" assertion not depend on dispatch global state.

## Deferred fixes (product bugs)

### Something keeps opening the OpenCode app/window unprompted (Windows) — find & fix

**Symptom (Ethan, 2026-06-16):** the OpenCode app keeps launching unprompted during normal work.
Unknown trigger — could be a test, a skill, an MCP server, or a bash invocation that hits the OpenCode
*executable* (launches the GUI/TUI) instead of the headless `opencode` CLI.

**Update (Ethan, 2026-06-16):** OpenCode is now UNINSTALLED on his machine. So the same trigger will now
likely surface as a command-line ERROR (`opencode` not found / non-zero exit) instead of opening the app —
which is itself a useful signal: watch for an `opencode`-not-found error in CLI output, that pinpoints the
exact caller. Deferred per Ethan (leave logged); revisit in a dedicated pass.

**Recon already done (don't redo — start from the prime suspect):**
- **SAFE — not these:** provider detection probes PATH with `where`/`which opencode`, never spawns it
  (`packages/shared/src/providers/providerConfirmation.ts:62-63`). Postinstall only *writes*
  `~/.config/opencode/opencode.json` (global `/audit-code` command + `auditor` agent + permissions) — no
  spawn (`packages/audit-code/scripts/postinstall.mjs:196-244`). All provider unit tests inject a stub
  `launchCommand` that captures argv and returns `{accepted,exitCode}` without spawning
  (`packages/remediate-code/tests/providers.test.ts:378-408`); `opencode-launch.test.mjs` only exercises
  the pure `resolveOpenCodeSpawnCommand`. Skills don't invoke `opencode`.
- **PRIME SUSPECT:** the *only* place the `opencode` binary is actually spawned is
  `OpenCodeProvider.launch()` → `opencode run` (prompt via stdin), and on Windows that is wrapped as
  `cmd.exe /d /s /c "opencode run …"` (`packages/shared/src/providers/opencodeProvider.ts:44-49` +
  `opencodeLaunch.ts:25-29`). This fires whenever the orchestrator auto-resolves/selects `opencode` as a
  *dispatch* provider for a real run. If the `opencode` on the user's PATH is the desktop/TUI launcher
  (not a pure headless CLI), or if `opencode run` itself opens a window, every dispatch "opens OpenCode" —
  exactly Ethan's "hitting the executable not the CLI" hypothesis.
- **SECOND VECTOR:** provider auto-resolution may be *picking* opencode when it shouldn't (it's detected on
  PATH). Conversation-first means claude-code/the host should be the default dispatch target — check the
  resolution order in `packages/*/src/providers/index.ts` + `shared/src/providers/providerFactory.ts`.
- **CONFIRMED REPRO (2026-06-16):** with `CLAUDECODE` unset (the release-gate env), `runPlanPhase`'s
  free-form extractor → `createFreshSessionProvider` → `provider.launch` auto-resolved a CLI backend whose
  subprocess HUNG (30s) rather than fast-failing — surfaced as a hang in `phase-plan.test.ts` under
  `verify:release`. That test was made hermetic (commit `b8c8c30a`, injects the `extractFindings` seam), but
  the underlying hang remains: a provider-less / OpenCode-uninstalled env should fast-fail, not block. Strong
  evidence the auto-resolver picks a non-headless/missing `opencode` and `opencode run` hangs on stdin.

**Next steps to find & fix:**
1. On the affected machine: `where opencode` — is it the headless CLI or the desktop-app launcher? Confirm
   whether `opencode run` opens a window for the installed version.
2. Check provider auto-resolution order — is `opencode` being selected for dispatch over claude-code? If so,
   that's the real-run trigger; fix the ordering / don't auto-select opencode as a dispatch target.
3. If `opencode run` is not reliably headless, gate it (headless flag) or stop auto-selecting opencode.
4. Reconsider whether the postinstall should register the global OpenCode command/agent at all when OpenCode
   isn't a desired host (the multi-host deploy writes to all 4 hosts unconditionally).

### Manual real-OpenCode validation of scoped permissions (user-owned)

The project-scope OpenCode deploy was aligned with the shared scoped-permission
helpers by the redesign run (N-D02, shipped 2026-06-11). Still pending: manual
validation against real OpenCode that agent-scoped allowances propagate to
spawned subtasks (can't be unit-tested). Revert path if audits start hitting
ask-prompts: re-add the broad rule or rerun an older postinstall.

### remediate-code host-dispatch gaps

- **Provider `queryLimits` is deferred because it has near-zero value today.** The
  canonical dispatch call site already treats an absent method and a `null` return
  identically (`await provider.queryLimits?.(…).catch(() => null) ?? null`), so
  null-returning stubs change nothing at runtime. Revisit only if a provider gains
  a real proactive rate-limit endpoint. This belongs with heterogeneous,
  quota-aware dispatch.

## Design commitments not yet built

Surfaced by a 2026-06-13 drift check of the design docs against `src`. These are
design decisions the docs record but the code has not implemented — tracked here
so the gap is explicit. Re-run the check (design doc vs code) to refresh; don't
record build status in the design docs themselves.

- **`free_form_intent` clause escalation + remediate-code interpretation.**
  Partially shipped 2026-06-13: audit-code no longer pastes intent verbatim into
  worker prompts (removed + guarded by `296c1b90` /
  `no-verbatim-free-form-intent.test.mjs`), and lens-weight interpretation is wired
  (`planningExecutors.ts` → `interpretFreeFormIntent`). Two halves genuinely remain:
  (a) the clause-aware `interpretFreeFormIntentForAudit` (`intentInterpreter.ts`) —
  which produces `checkpoint_questions` / `has_unencodable` — is built but still
  **unwired** (no caller reads it), so unencodable clauses are silently dropped
  instead of escalated to a blocking checkpoint question; (b) `remediate-code` still
  threads `free_form_intent` into remediation worker prompts (`nextStep.ts`) rather
  than interpreting it for priority / lens weighting. Resolve toward the docs
  (interpret + escalate) in both orchestrators.
- **Rolling per-node dispatch (dispatch-when-verified-complete) — remediate-code.**
  The design wants per-result re-scheduling: as each node result lands,
  verify→merge→re-check newly-unblocked nodes→dispatch into freed quota. The code
  builds one wave per `next-step` and gates `prepareImplementDispatch` on item
  *status*, not verified-complete; the host dispatches the wave, waits for all
  results, merges, then re-enters. Batch-then-merge, not rolling.
- **Provider confirmation Gate-0 (shared, session-level) — remediate-code.** The
  design wants one provider confirmation spanning an audit→remediate run.
  remediate-code has no `provider_confirmation` state; each tool resolves its
  provider independently.
- **Parallel module-contract phases — remediate-code.** `buildParallelModuleWaveStep`
  (`contractPipeline.ts`) dispatches a single sequential agent over all modules, not
  N parallel per-module agents.
- **audit-code mid-run pause + scope annotation + folded ingestion.**
  `waiting_for_provider` / `advancePausedState` is built in
  `shared/src/rolling/pausedState.ts` but `rollingDispatch.ts` doesn't use it (it
  only detects stranded packets post-run). Design-review prompts don't annotate
  units `[in scope]` / `[excluded: …]`. Ingestion is still a separate
  `audit_results_ingested` obligation rather than folded into the dispatch turn.
- **Paired obligations (positive + negative test specs) — remediate-code contract
  pipeline.** A behavior-*change* obligation should derive BOTH a positive test (the
  new invariant holds) and a negative test (the old behavior is absent everywhere)
  at obligation/test-spec derivation time, so a partial implementation cannot satisfy
  it. The no-prose-closure half has shipped — `mergeImplementResults` gates a
  `resolved_no_change` ("verified-already-satisfied") closure on executable evidence
  (`hasExecutableEvidence`), routing prose-only claims to triage. This
  paired-derivation half is the remaining piece.

## Features to add later

### More deterministic analysis in the audit process — investigate

Goal: shift more of the audit's signal from LLM judgment to deterministic static
analysis, so findings are cheaper, reproducible, and grounded *by construction*.
Extends the directions already in-tree: `src/adapters/` (semgrep / eslint /
npm-audit normalizers), `src/extractors/` (deterministic repo analysis feeding the
language-neutral graph), and `src/validation/anchorGrounding.ts` (S7 — runs
allowlisted read-only `grep`/`rg`/`madge`/`git` commands to refute ungrounded
findings). The premise of this repo is "deterministic by default; LLM only for
judgment" — this item asks where the deterministic frontier can be pushed further.

Investigation plan:
- **Survey deterministic levers** and decide which graduate to first-class
  extractors/adapters (enriching the shared graph + risk register) rather than LLM
  lenses. Candidates: AST/structural matching (tree-sitter, ast-grep); dependency &
  cycle analysis (`madge` is already shelled out to in `anchorGrounding` — promote to
  a real extractor that emits graph edges?); dead-code / unused-export (knip,
  ts-prune); complexity & duplication metrics; type-coverage; broader semgrep
  rulepacks; CodeQL for deeper dataflow.
- **Contract conformance is the constraint.** Each new analyzer must enrich shared
  language-neutral artifacts and route through the adapter-normalize pattern — never
  fork planning logic per ecosystem (CLAUDE.md invariant). Prefer in-process
  deterministic adapters (reproducible, no network) over MCP; reserve MCP for cases
  that need a real external engine (e.g. CodeQL).
- **Mine ralph-architecture-sweep's *methodology*, not its mechanism**
  (https://github.com/Aijo24/ralph-architecture-sweep, checked 2026-06-15). It is a
  Claude Code *skill* driving the `ralph` autonomous loop — LLM-driven multi-agent
  (proposer agents + an independent verifier), **not** deterministic static analysis,
  so it does not itself advance the "more deterministic" goal. Architecturally it
  mirrors what audit-code already has (propose→independent-verify ≈ our critic→judge;
  analysis-only, delta-aware sweep ≈ our deepening). What's worth extracting is its
  heuristics, re-expressed as deterministic graph queries: the **deletion test**
  (imagine removing a module — is it load-bearing, or dead/low-fan-in? → query
  unused/low-in-degree graph nodes), **seam detection** (repeated patterns across
  call sites → query repeated call-site signatures / structural clones), and
  **vertical-slice** issue packaging (already close to our work-block rendering).
- Decide build vs. defer per lever after the survey; this entry is the *plan to
  investigate*, not a committed spec.

### Contract-governed implementation pipeline — durable principles

The pipeline shipped 2026-06 (artifact contracts, schemas, validators, content-hash
staleness DAG, deterministic grounding of LLM findings, and the adversarial
**critic → judge → repair** loop). The build details live in the code + design
docs; the principles to keep honoring are:

- Treat LLM output as untrusted until validated; deterministic validators run
  before LLM critics.
- No implementation task without traceability to a requirement, invariant, or
  accepted counterexample.
- Conceptual critique may propose better designs, but adopted changes must be
  reflected in the contract before implementation.
- "Tests pass" is never sufficient proof of completion.
- Use **contract assessment** (invariants / boundaries / obligations) and
  **conceptual design critique** (philosophy / alternatives) as the two named
  modes — never the bare phrase "design assessment".

### Heterogeneous multi-agent dispatch — *partial*

`computeDispatchCapacity({ pools, pendingItemTokens })` in `@audit-tools/shared`
sizes dispatch just in time, partitions pending token estimates across
`CapacityPool`s, and sums concurrent slots with per-pool quota summaries.
Remaining (deferred as `FINDING-020` — cross-package): per-packet provider
assignment, host-model detection for additional pools, and building a real second
pool such as an IDE model or another CLI provider.

### Cross-IDE/provider quota detection — needs a concerted effort (+ CLI-agent dispatch)

Quota/limit detection is still unreliable across the different host IDEs and providers
(Claude Code, Codex, OpenCode, antigravity, VS Code tasks, …): per-model+provider limit
discovery, learned-limit feedback, and the capability handshake don't yet produce a
dependable capacity picture everywhere. This is a known deficiency, not a small bug — it
wants a dedicated, end-to-end pass over the quota subsystem + the per-provider wiring,
with real per-IDE/provider validation (not just unit fixtures). Target: a
provider+IDE+model triple yields a *trustworthy* capacity/limit estimate dispatch can
rely on, degrading safely (byte-estimate + 429/TPM learning + safety margin) when a
source is silent — never a confidently-wrong number. (Ethan flagged 2026-06-15.)

**PROACTIVE signal for Claude — SHIPPED + WIRED (2026-06-16, commit `a7eef160`; the key unlock).**
Confirmed live (200 on this machine) and implemented as `ClaudeOAuthQuotaSource`
(`packages/shared/src/quota/claudeOAuthQuotaSource.ts`): reads `claudeAiOauth.accessToken` from
`~/.claude/.credentials.json`, GETs `api.anthropic.com/api/oauth/usage`
(`anthropic-beta: oauth-2025-04-20`), maps the most-constraining window (normalized `limits[]` +
`five_hour`/`seven_day`) → `QuotaUsageSnapshot.remaining_pct` (a 0–1 fraction) so the scheduler
throttles/cools-down BEFORE a 429. Default member of `buildQuotaSource` (ahead of learned); wired into
audit's `buildDispatchPool` (already fed the cascade — got it for free) + remediate's
`scheduleWave`/`buildConfirmedPools`. Per-model = data-driven via `limits[].scope.model` (NO hardcoded
model names — INV-QD-04); tier is in local creds (`/profile` optional); cache ~45s/key; degrade→null on
missing-creds/expired/non-200/network; **no token refresh** (host CLI owns the rotating creds);
hermeticity guard skips the live endpoint under test runners + an `AUDIT_TOOLS_DISABLE_PROACTIVE_QUOTA`
kill-switch. This makes the Claude (incl. subagent) pool proactively quota-aware — REQUIRED for cross-pool
balancing (a host that thinks it has infinite subagent capacity never spills). **The binding constraint is
quota+rate, NOT a max-parallel-subagents `N`** (Ethan, 2026-06-16). Caveats: undocumented (defensive parse
+ degrade); read-only OAuth-token use (Bearer to api.anthropic.com only, never log); OS-portability (macOS
may store creds in the keychain, not the file — degrade if absent). Full recipe + confirmed shape: memory
`claude-oauth-usage-quota-endpoint`; build doc: `docs/quota-detection-build.md`.

**RESEARCH DONE (2026-06-16) → [`docs/cross-provider-quota-matrix.md`](cross-provider-quota-matrix.md)**
— the per-provider QuotaSource matrix (signal tier + recipe + token source + degrade + citations),
mostly read straight from each tool's open source (the way the Claude endpoint was found). Verdicts:
- **codex / OpenAI: PROACTIVE GET `chatgpt.com/backend-api/wham/usage`** (Bearer + `ChatGPT-Account-Id`
  from `~/.codex/auth.json`) → primary(5h)/secondary(weekly) `used_percent`+`reset_at`. HIGH (codex Rust
  source + URL-pin test + 5 tools). Even better than Claude (proactive GET *and* `x-codex-*` headers).
- **opencode: FEDERATES** — no own quota; a token broker. Resolve active provider from
  `~/.local/share/opencode/auth.json` + `account.json`, delegate to the underlying source (anthropic→reuse
  Claude usage; openai→reuse codex wham; copilot→copilot_internal/user; google→reactive).
- **antigravity (Gemini): proactive POST `cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels`**
  (or the local Language-Server-over-localhost, lower ToS risk) → `remainingFraction`+`resetTime`; token in
  `%APPDATA%/Antigravity/User/globalStorage/state.vscdb`. MED proactive / HIGH dated-error. Raw Gemini API =
  reactive-only (Google staff: no proactive header).
- **VS Code Copilot: PROACTIVE GET `api.github.com/copilot_internal/user`** → `quota_snapshots.premium_interactions`
  `{percent_remaining, unlimited}` + `quota_reset_date`. HIGH endpoint; token is DPAPI-encrypted in `state.vscdb`
  (extract via the `gh`/`copilot` CLI token on Windows).
- **Cursor / other IDEs / local LLM:** Cursor = org Admin API; most BYOK = delegate to provider; local = unbounded.

**SOURCES BUILT (2026-06-16, `a2cb6220`, green):** extracted `BaseHttpQuotaSource` (cache/guard/degrade) +
per-provider `fetchXxxUsage` fns, then `CodexQuotaSource` (wham/usage), `CopilotQuotaSource`
(copilot_internal/user; gho token from the `gh`/`copilot` CLI), `AntigravityQuotaSource` (cloudcode-pa
fetchAvailableModels; opt-in/degrade-heavy token), and an `OpenCodeQuotaSource` broker (routes by model
provider-namespace → the underlying `fetchXxxUsage` with OpenCode's own token). All on `BaseHttpQuotaSource`,
registered in `buildQuotaSource` (provider-gated) → audit + remediate dispatch consume them for free. Tests:
codex(10)/copilot(10)/antigravity(9)/opencode(8) + the base/Claude refactor. Each gates by provider + skips the
live endpoint under test runners / `AUDIT_TOOLS_DISABLE_PROACTIVE_QUOTA`.

**SPILL BUILT (2026-06-16, `0a620bf8`, green) — item (a) done.** Proactive utilization-driven cross-pool spill
landed as INV-QD-14 in the shared `selectProvider` (`dispatch/rollingDispatch.ts`). Root gap: `scheduleWave`
floors `max_concurrent` at 1, so the old selection always returned the top capability-ranked non-exhausted pool
*regardless of live utilization* — the proactive `remaining_pct` only throttled the chosen pool, never spilled.
Now selection deprioritises a quota-degraded pool (live `remaining_pct` < `QUOTA_REMAINING_PCT_LOW`, or in an
active cooldown) so load spills to a peer with headroom BEFORE a 429; capability/cost rank preserved within each
health group; degraded pools stay a fallback (no stall); inert when quota disabled. One shared seam → both
orchestrators. 4 new INV-QD-14 tests; shared rolling 27/27, remediate 1622, audit 2192/1skip.

**REMAINING:** (a-residual) **surface `openai-compatible` (NIM) as a real SECOND pool to spill INTO.** Spill
logic is complete + unit-proven, and as of 2026-06-17 the `openai-compatible` provider EXISTS (NIM is a real,
free, always-available OpenAI-compatible backend — see A8) so a genuine second pool is finally buildable. The
concrete remaining step: surface `openai-compatible` as a *confirmed pool* in `buildConfirmedPools` /
provider-confirmation — it is config-gated (base_url+model), NOT PATH-probed, so `discoverProviders` doesn't
surface it today. Once it sits alongside the Claude pool, the proactive `selectProvider` spill (INV-QD-14) can
fire end-to-end. This is the *Heterogeneous multi-agent dispatch* item (FINDING-020) + "detect and dispatch to
CLI/API agents as additional pools" below. The binding constraint is quota+rate, NOT max-parallel-`N`. (b) **live confirmation — Codex ✓ DONE (2026-06-17, live 200: production class path +
raw `rate_limit.{primary,secondary}_window` shape matches the parser); Copilot still pending** (no
file-reachable credential on the test machine — gh uses the OS keyring + the gh token lacks `copilot` scope;
the degrade path is confirmed, the response-shape mapping stays fixture-tested only — re-confirm where a
Copilot token is file-reachable). Claude was already live-confirmed. Read-only token use only; ToS caveats
(Antigravity, Anthropic-via-OpenCode) in the doc. (Antigravity excluded + token rotation dropped per Ethan
2026-06-16.) The Copilot run also surfaced + FIXED an OS-portability bug (gh hosts path hardcoded to
`~/.config/gh` → `resolveGhHostsPath` now OS-agnostic).

**ASSESSED 2026-06-17 — Gemini CLI + NVIDIA NIM (matrix §6 / §5); NEITHER warrants a new proactive source.**
- **Gemini CLI:** HAS a clean proactive signal (`cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` →
  `buckets[].{remainingFraction,resetTime}`; token `~/.gemini/oauth_creds.json` — cleaner than Antigravity's
  SQLite scrape). BUT its individual/free/Pro/Ultra tiers **stop serving on gemini-cli 2026-06-18** (VERIFIED
  vs Google's deprecation page); survivors are Std/Ent only, on the SAME cloudcode-pa family the existing
  `AntigravityQuotaSource` already covers (Google steers consumers to Antigravity). → **don't build** unless a
  Std/Ent gemini-cli pool becomes a real dispatch target. **Community cross-check (2026-06-17): the
  future-proof Gemini-family target is Antigravity CLI (`agy`)** — folds in gemini-cli + IDE consumers by
  2026-06-18, same 5h+weekly dual-limit as Codex/Claude; community tools (`skainguyen1412/antigravity-usage`,
  `fuelcheck`, Antigravity Cockpit, CodexBar #1178) already poll it via the local-LS / cloudcode-pa dual route
  our `AntigravityQuotaSource` uses. Build caveat: `agy`'s token store likely ≠ the IDE's `state.vscdb`.
- **NVIDIA NIM:** OpenAI-compatible; **no proactive quota in either mode** (community-confirmed: forum
  threads explicitly ask for a credits/usage API and get none; NGC SDK exposes only *storage* quota). Hosted (`integrate.api.nvidia.com`)
  = reactive 429 + `Retry-After` (no `X-RateLimit-*`, no credits GET); self-hosted = unbounded local pool
  (`/v1/metrics` is vLLM perf telemetry, not quota). → no `QuotaSource`; slot as a reactive-hosted /
  unbounded-local **pool**. NIM is a strong candidate for the a-residual "real 2nd pool to spill into"
  (OpenAI-compatible, free credits or local GPU — exercises INV-QD-14 e2e without a new proactive source).

Part of the same push: **detect and dispatch to CLI agents as additional pools.** The
heterogeneous-dispatch machinery (`computeDispatchCapacity`, `CapacityPool`) can already
model multiple pools, but there is no real second pool. Detecting an available CLI agent
(another `claude`/`codex`/`opencode` process, or an IDE model) and routing
packets/blocks to it — each under its own provider+quota constraints — is the concrete
next capability. Builds on *Heterogeneous multi-agent dispatch* above + the per-model
+provider quota vision (memory `quota-dispatch-vision`).

### Token savings and model routing — DECIDED 2026-06-11

**Decision: headroom (https://github.com/chopratejas/headroom) replaces
opentoken everywhere.** Host level done; orchestrator opentoken removal DONE
2026-06-13 (deleted from src, guarded by `no-opentoken-guard.test.mjs`). The only
remaining piece is host-side: enable + validate the headroom proxy in an opt-in
session before any global env flip (see below).

- **Host (done 2026-06-11):** `headroom` MCP server registered at user scope
  (`claude mcp add --scope user headroom -- headroom mcp serve`); the
  opentoken entry was removed from the Desktop config in the same pass.
  Windows install trap: PyPI ships no Windows wheels for the Rust extension
  and `[all]` needs MSVC (hnswlib) — working recipe is
  `uv tool install --no-build headroom-ai --with fastapi --with uvicorn --with mcp`
  (pure-python wheel, 0.20.15). Proxy mode (`headroom proxy` +
  `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`; auto-compresses all tool-output
  traffic with CCR retrieval) is installed but NOT enabled — validate it in a
  single opt-in session before any global env flip.
- **Orchestrators — opentoken removal DONE (2026-06-13).** The opentoken exec-wrap
  (`wrapForOpenToken` / `quoteForOpenTokenCmd` / `runTracked`'s `opentoken` option,
  the sessionConfig field, provider wiring) was deleted from src — superseded by the
  host-level headroom proxy (`853e8a79`, `1b4d227a`; guarded by
  `no-opentoken-guard.test.mjs`), which also retired the cmd.exe wrap-quoting trap
  class. Optional / unbuilt: a `headroom-ai` TS SDK library step (`compress(messages,
  { model })`) that compresses packet evidence at build time + worker payloads at
  ingestion — now low-priority, since the host proxy already compresses tool-output
  traffic. Minor: a vestigial `DO_NOT_TOKEN_WRAP_NOTE` remains in `prompts.ts`;
  verify it isn't needed for proxy traffic before deleting it.
- **tokencost — rejected entirely (2026-06-11), including the local-tokenizer
  substitute.** `tokencost-js` counts Claude tokens via the Anthropic counting
  API (a network call inside deterministic planning — wrong shape) and the
  Python original can't run in Node. The local-tokenizer alternative was also
  dropped: the shipped redesign standardized byte-based estimation as the
  single primitive (N-S04, `estimateTokensFromBytes`), quota learning
  self-corrects from real 429/TPM signals, `BLOCK_SAFETY_MARGIN` absorbs
  estimator error, and BPE tokenizers aren't Claude's tokenizer anyway. The
  headroom proxy's stats are the measured-usage upgrade path. Optional later:
  per-model price fields for ledger cost lines (pure data, no deps). Revisit a
  tokenizer only on observed systematic mispacking.

### Nightly autonomous audit→remediate pipeline — capstone, UNBLOCKED

Redesigns landed 2026-06-11 (46/46); the dogfood gate is met — a fresh self-audit
ran end-to-end on the new architecture 2026-06-13 (97/97 remediated). Remaining to
build: scheduled run (cloud routine or local headless `claude -p`) → audit →
auto-remediate actionable findings behind green test gates → PR + findings
report, escalating only ambiguity/low-confidence fixes to Ethan.

### Single-package install/publish (`audit-tools`)

Collapse the three published packages (`auditor-lambda` + `remediator-lambda` +
`@audit-tools/shared`) into ONE published+installed package — provisionally **`audit-tools`**
(name is free on npm as of 2026-06-15) — exposing both the `audit-code` and `remediate-code`
bins, with the shared library internal. One install, one publish, one version line; removes
the three-way naming mismatch (dir vs npm name vs bin) and the shared-built-first release
ordering. Points to settle when picked up: whether `shared` stays an internal workspace or is
inlined; collapsing the per-package `release:*` scripts + the GitHub-Release-tag publish
workflow to one; keep the `audit-code`/`remediate-code` bin names; and deprecating/redirecting
the old `auditor-lambda`/`remediator-lambda` package names. **ACCEPTED (Ethan, 2026-06-15
review) — now wanted; reverses the earlier same-day defer.** Tracked under the accepted
go-forward program at the top of this file (A12).
