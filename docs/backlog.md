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

- **Review-necessity approval gate (TOOL FIX — root cause of this whole thread).** `remediate-code`
  must emit, between plan and implement, **item-sets tiered by how much review they need**, each with
  pros/cons + impl cost, for the user to approve/disapprove. Design-review (architecture/conceptual)
  findings and free-form items must NOT be silently auto-dispositioned by quality-tail blocks. Enforce
  in the tool, never host discretion — the host driving it autonomously is exactly the failure mode that
  hid 30/42 design findings this run. (Ethan, 2026-06-15.)
- **A1 — Fast path past the 15-phase pipeline.** Size/ambiguity/seam-gated lean path
  (`shouldEnterContractPipeline`) so a handful of concrete fixes don't pay full adversarial +
  3-repair-loop cost. Risk to design around: a mis-routed subtle change must not skip the safety net.
  (ARC-ad53dd0d.)
- **A3+A4 — Move correctness into the tool; unify the two obligation engines.** audit-code expresses the
  ordered-obligation engine declaratively (PRIORITY[] + registry); remediate re-derives it in a
  ~2835-line imperative switch → one shared declarative engine. Collapse the ~8 finding_id-keyed record
  types + 2 coverage ledgers into one canonical `RemediationItem` with typed projections. The redesign
  track. (ARC-f5a5612b, ARC-f5a5612b-3, ARC-b85edf3f.)
- **A8 — Make the rolling/isolation/verify engine the LIVE DEFAULT.** It shipped wired-but-default-OFF;
  the live path is still host-fanned waves on the shared tree (host discretion). Sequence: validate a
  real multi-worker dispatch → flip default-ON → wire audit-code symmetrically → harden worktree reuse.
  **THE blocker for nightly autonomy.** Supersedes the drift-plan R1 item and links the "confirmed
  dispatch bugs" section below. (ARC-f378135d family.)
- **B1 / B2 / B3 — greenlit** (the magic-numbers, diff-based-re-review, and staleness-cascade friction
  items in *Known friction* below; now accepted work, not just logged friction).
- **B4 — Hard-exclude tool-refuted findings.** A tier-2 REFUTED finding (e.g. madge-disproven cycle) is
  only marked `grounding:'ungrounded'` and still merges as fact; promote refuted → quarantined-excluded
  at ingest (quarantine, not delete). (ARC-48c05a13, ARC-48c05a13-2.)
- **B8 — Finding-merge location discriminator.** `findingKey` excludes affected_files, so two distinct
  defects sharing lens+category+generic-title union into one finding pointing at the wrong file. Add a
  location discriminator. (ARC-1a497c28-2.)
- **A5+A11 — Two-tier own-vs-import dependency policy + replace hand-rolled manifest parsers.** Write the
  policy (import vetted libs for correctness-sensitive parsers/schema/lock; keep own for tiny domain
  bits), then replace the hand-rolled TOML/YAML manifest scanners that silently drop dependency-graph
  edges with vetted pure-JS parsers. (ARC-843ce274, ARC-4d950c7f.)
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

- **Magic numbers, esp. the adversarial-pass count (=2) — audit ALL of them.** The
  critic→judge→repair loop runs a fixed number of rounds; dispatch concurrency, the
  60s anchor timeout, STALE_LOCK_MS=30s, hashContent slice lengths (8/16/32),
  BLOCK_SAFETY_MARGIN, the `>=4`-token paired-keyword heuristic, etc. are all magic.
  Investigate where each is *really* justified vs. should be derived/config/until-converged
  (e.g. run adversarial rounds until a clean round, not a fixed 2). (Ethan, 2026-06-16.)
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

- **Dispatch is host-waved, not quota-driven rolling — engine WIRED behind a flag; cutover remains.**
  Root cause (2026-06-15 conceptual review): the rolling dispatch + worktree engine
  (`runRollingDispatch` / `driveRollingDispatch` / `createWorktree`) had **zero
  non-test callers** — built, refactored repeatedly, never wired into the live path,
  so every run fell back to the host waving a static N-packet plan with
  `max_concurrent_agents` = the raw host flag. **DECISION 2026-06-15 (Ethan): WIRE THE
  ENGINE IN — option (a), NOT delete.** **Partial as of 2026-06-15:** remediate-code now
  has `driveRollingImplementDispatch` driving the shared `createRollingDispatcher` over
  quota-derived pools (`computeDispatchCapacity`, not the raw flag) with
  dispatch-next-on-complete, per-node isolated worktree, and verify-before-accept +
  write-scope/lost-update enforcement folded into the deterministic merge — but it is
  gated behind a **default-OFF** flag (`dispatch.rolling_engine` /
  `REMEDIATE_ROLLING_ENGINE`) and the host-fanned wave step is **retained as the
  default fallback** (the conversation host has no programmatic per-node dispatcher, so
  it still takes the fallback). **Remaining:** (1) the atomic-replace removal of the
  host-wave fallback + flip the flag default ON, gated on a *validated* real
  multi-worker rolling dispatch (don't force the cutover); (2) symmetric wiring of
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

## Deferred fixes (product bugs)

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
