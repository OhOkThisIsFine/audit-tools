# Backlog — known friction, deferred fixes & future product directions

A living log of things to fix or build later, so they are not lost between
sessions. This is also the home for deferred product-design specs that are still
too early to encode as implementation contracts.

**Remove an entry once it ships** — this is a to-do list, not a status log. When
an item needs design detail, record durable contracts, gates, and principles
rather than "where the code is today."

> **Last reconciled 2026-06-09** against the remediation that shipped
> `@audit-tools/shared@0.10.0` / `auditor-lambda@0.11.0` /
> `remediator-lambda@0.10.0`. Items verified resolved in-tree were removed;
> friction surfaced by the June 8–9 self-audit (agents' own feedback +
> `.audit-tools/audit/audit-report.md`, 281 findings) was folded in. The
> contract-pipeline spec was trimmed to what is unbuilt — the full original spec
> is in git history before this date.

## Known friction (agent / dev experience)

- **`run-to-completion` / `quota` commands silently drop the capability-handshake
  flags.** Neither path parses `--host-context-tokens` / `--host-output-tokens`
  (since N5b) nor `--host-models` / `--host-model-id` (F2/F3) — a flag passed
  there is ignored without error and the batch loop sizes from cached/learned
  limits only (`lookupDiscoveredLimits` still applies). Pre-existing for the
  scalar pair; surfaced by the F1–F5 adversarial review 2026-06-12. Decide:
  wire the flags through `runToCompletion`'s `renderSemanticReviewStep`/
  `scheduleWave` call sites, or declare the handshake conversation-only and
  reject the flags loudly on the batch path (or retire the second terminal loop
  entirely — known wart).

- **Run CLAUDECODE-unset tests via the PowerShell tool, not nested `cmd /c`.**
  `cmd /c "set CLAUDECODE=&& npm test"` from inside the bash tool printed only the
  cmd banner and swallowed all test output. `$env:CLAUDECODE=$null; npm test` in the
  PowerShell tool works cleanly. (Spotted 2026-06-12 during N6.)

- **Stale "waves" wording in the rolling-dispatch prompt.** The rolling dispatch
  step prompt header still reads "After all waves complete:" even though dispatch
  is fully rolling (`max_concurrent_agents`, no `wave_size`). Cosmetic; reword to
  "After all packets complete:" in the dispatch prompt renderer. (Spotted 2026-06-12
  dispatch verification.)

- **Global install defers `postinstall` under npm's allow-scripts policy.**
  `npm install -g auditor-lambda` installs the bin but prints
  `npm warn allow-scripts … (postinstall: node scripts/postinstall.mjs)` and skips
  it, so the host-integration deploy (OpenCode config + `/audit-code` skill/prompt)
  silently doesn't run. Finish with `npm approve-scripts auditor-lambda` or invoke
  `postinstall.mjs` manually. (This also gates the overbroad-perms deploy flagged
  by `CFG-4996560e`, so it's not purely a regression.)
- **`opentoken wrap` CLI is not always installed.** The global instruction is to
  wrap every terminal command in `opentoken wrap <cmd>`, but the `opentoken`
  binary isn't on PATH in every environment (absent in both bash and PowerShell on
  a 2026-06 Windows session; confirmed still absent 2026-06-11). When it's
  missing, run commands directly and route only genuinely large outputs through
  a compression MCP tool — wrapping a 2-line build log is pointless. Direction:
  headroom replaces opentoken (see *Token savings and model routing*); this
  entry retires when the orchestrator swap ships.
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
- **New default-on orchestrator behavior breaks existing fixtures.** Turning the
  dispatch canary on by default changed `prepare-dispatch` first-contact output
  and broke end-to-end fixtures that assumed a single-round, all-packets dispatch;
  the fix was seeding `dispatch.canary:false` in the test helper. Any new
  default-on behavior needs a sweep of existing fixtures, or should ship
  default-off until they catch up.
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

### Friction from the June 8–9 self-audit (auditor feedback)

- **`submit-packet` rejects in-boundary `affected_files`.** `file_coverage`
  validation rejects an `affected_files` entry that crosses a packet boundary even
  when the referenced file is in the task's declared boundary list (e.g. a
  `schemas/finding.schema.json` needed to fully describe a duplicate-schema
  finding). Workers had to drop legitimate evidence files. The error also doesn't
  surface which files ARE allowed — the assigned `file_paths` are opaque to the
  agent. **Shipped 2026-06-09:** the rejection now lists the task's allowed files.
  Still open: whether to *allow* declared-boundary files as `affected_files`
  evidence (a contract decision — auditors currently may reference only assigned
  files).
- **Read tool truncates lines over ~2000 chars.** Large `file_coverage` arrays
  inside prior-result JSON exceed the per-line cap, so auditors couldn't
  reconstruct exact arrays and fell back to `Get-Content`/bash. Largely a
  downstream symptom of the scope pollution above (auditing huge JSON), but worth
  noting for any task that must read wide JSON.

### Friction from 2026-06-11 dogfood self-audit

- **Lens selection needs interactive user confirmation.** The `confirm_intent`
  step proposes lens exclusions but the host auto-writes `intent_checkpoint.json`
  without pausing for user input. Should present proposals, allow the user to
  accept/reject/add custom lenses, then write the checkpoint. Currently users
  can only exclude proposed lenses — no affordance for requesting unlisted ones.
- **Conceptual design review lacks depth control.** A single subagent runs the
  full conceptual review. Should support optional multi-reviewer depth: fan out
  N independent reviewers with distinct philosophies (e.g. DDD purist, pragmatic
  simplicity, security-first), then a judge compiles the strongest ideas. Maps
  to the existing Workflow judge-panel pattern or an MCP multi-agent skill.
- **wave_size dispatch not replaced by rolling quota-aware dispatch.** The
  redesign spec called for rolling dispatch that adapts to learned quota, but
  the current implementation still uses fixed `wave_size` batching (162 packets
  across 41 waves of 4). This wastes quota on under-packed waves and can't
  adapt mid-run to rate-limit feedback.
- **Subagent prompts include `next-step` in allowed_commands.** Design review
  subagents called `next-step` themselves, advancing the pipeline before the
  host confirmed both passes were complete. The contract review agent pushed
  past the conceptual-review gate while that agent was still running. Subagents
  should write findings only; `next-step` is a host-only command.
- **Canary wave skipped in fan-out dispatch.** `canary_packet_id: null` despite
  `phase: "fan_out"` — the canary→graduate flow from the redesign isn't wired.
  The orchestrator jumps straight to full-fleet dispatch without validating a
  single packet first.
- **High packet count / low tasks-per-packet ratio.** 162 packets for 228 tasks
  (1.4 tasks/packet). The redesign's rolling dispatch should batch by unit
  proximity to reduce dispatch overhead — many current packets contain only one
  task, wasting a full agent context per trivial review.
- **No quota pre-check before dispatch commitment.** The dispatch plan commits to
  162 agents without consulting learned rate limits or provider capacity. The
  redesign spec called for quota-aware dispatch that checks available budget
  before sizing the fleet and adapts dynamically to 429/TPM signals mid-run.

## Deferred fixes (product bugs)

### Manual real-OpenCode validation of scoped permissions (user-owned)

The project-scope OpenCode deploy was aligned with the shared scoped-permission
helpers by the redesign run (N-D02, shipped 2026-06-11). Still pending: manual
validation against real OpenCode that agent-scoped allowances propagate to
spawned subtasks (can't be unit-tested). Revert path if audits start hitting
ask-prompts: re-add the broad rule or rerun an older postinstall.

### audit-code + remediate-code: scope & intent checkpoint — *shipped 2026-06-09*

The lightweight scope/intent checkpoint validated by the June 8–9 self-audit
shipped across both orchestrators. The enriched `IntentCheckpoint` (shared)
carries `free_form_intent`, `excluded_scope`, `must_not_touch`, and remediate
`filters` (severity/lens/package/theme); the design now lives in the code +
`schemas/intent_checkpoint.schema.json` + the Preferences log, not here.

- **audit-code:** a reachable, conversational `confirm_intent` host step (native
  `host_delegation` + deterministic scope pre-digest + headless auto-complete
  fallback). Accepted `excluded_scope` prunes planning before tasks are built,
  `free_form_intent` is threaded into worker packet prompts, and skipped scope is
  surfaced in the report ("Excluded / Out-of-Scope") and `audit-findings.json`.
- **remediate-code:** the confirm step prompt is enriched to the full shape, and
  `runPlanPhase` filters findings (after cross-lens dedup) by
  filters/excluded_scope/must_not_touch — drops recorded in the coverage ledger
  (`dropped_by_checkpoint`) and a "Skipped by Intent Checkpoint" report section.

**Remaining:** the pre-digest *lists* scope dirs + auto-exclusions for the host to
confirm, but the tool does not itself pre-flag *suspicious* inclusions
(node_modules/dist/vendored) beyond listing them — the host (an LLM agent) makes
that call.

### remediate-code: structured `audit-findings.json` fast path skips intake — *resolved 2026-06-09*

Closed by the scope/intent checkpoint (subsumed `FINDING-012`): the
`confirm_intent` gate sits at the top of `decideNextStepInner` — before any
source-type branching — so a lone `audit-findings.json` cannot bypass it. The
structured flow is `synthesize_intake` → `confirm_intent` (summary present, no
checkpoint) → deterministic `runPlanPhase`, which consumes the JSON contract
losslessly and applies the checkpoint's filters/excluded_scope/must_not_touch
(drops recorded as `dropped_by_checkpoint`). Verified end-to-end; regression
coverage in `tests/next-step.test.ts` ("structured fast path is gated by
confirm_intent…") — the only test of the no-checkpoint flow, since the other
structured-path tests pre-write a checkpoint.

### remediate-code host-dispatch gaps

- **Provider `queryLimits` is deferred because it has near-zero value today.** The
  canonical dispatch call site already treats an absent method and a `null` return
  identically (`await provider.queryLimits?.(…).catch(() => null) ?? null`), so
  null-returning stubs change nothing at runtime. Revisit only if a provider gains
  a real proactive rate-limit endpoint. This belongs with heterogeneous,
  quota-aware dispatch.

## Features to add later

### Workflow redesigns — *shipped 2026-06-11*

Both redesigns ([`docs/audit-workflow-design.md`](audit-workflow-design.md),
[`docs/remediation-workflow-design.md`](remediation-workflow-design.md)) were
implemented end-to-end by the 46-node contract-pipeline run completed
2026-06-11 (46/46 resolved, 0 blocked) and shipped through today's releases
(auditor-lambda 0.17.0 / remediator-lambda 0.14.0 / @audit-tools/shared
0.14.0). The design docs remain the durable contracts. Next validation step:
dogfood — a fresh self-audit on the new architecture.

### Contract-governed implementation pipeline — *shipped 2026-06*

The full pipeline is built and wired: artifact contracts, JSON schemas,
validators, artifact store + content-hash staleness DAG, next-step prompt
renderers, deterministic grounding of LLM-extracted findings (phantom
`affected_files` stripped with one bounded repair attempt; evidence classified
grounded/ungrounded by `path:line` citation with ungrounded findings downgraded
to low confidence — all recorded in the coverage ledger), and the adversarial
**critic → judge → repair** loop between assessment and implementation planning
(counterexample search; `accepted` / `out_of_scope` / `duplicate` / `invalid` /
`residual_risk` classification; judge-directed targeted repair re-deriving
downstream artifacts via the staleness DAG, capped at 2 iterations; traceability
gate rejecting any `implementation_dag` node that traces to no obligation or
accepted counterexample). Worker-written raw payloads are validated and
enveloped at ingestion; structured `audit-findings.json` keeps the deterministic
fast path. The closing `VerificationReport` is emitted by the close phase
(FINDING-027), not as a pre-implementation pipeline phase — by design.

Durable principles to keep honoring: treat LLM output as untrusted until
validated; no implementation task without traceability to a requirement,
invariant, or accepted counterexample; deterministic validators run before LLM
critics; conceptual critique may propose better designs but adopted changes must
be reflected in the contract before implementation; "tests pass" is never
sufficient proof of completion. Use **contract assessment** (invariants /
boundaries / obligations) and **conceptual design critique** (philosophy /
alternatives) as the two named modes — never the bare phrase "design assessment".

### Heterogeneous multi-agent dispatch — *partial*

`computeDispatchCapacity({ pools, pendingItemTokens })` in `@audit-tools/shared`
sizes dispatch just in time, partitions pending token estimates across
`CapacityPool`s, and sums concurrent slots with per-pool quota summaries.
Remaining (deferred as `FINDING-020` — cross-package): per-packet provider
assignment, host-model detection for additional pools, and building a real second
pool such as an IDE model or another CLI provider.

### Make agent meta-audit reflections a first-class artifact — *shipped 2026-06-09*

Fully shipped. Workers in both orchestrators are invited (opt-in, best-effort)
to append `agent_reflection` lines to the run's `agent-feedback.jsonl`; the
parse/aggregate/render lives in `@audit-tools/shared` (`agentReflections.ts`),
audit-code loads the file into the bundle with an `agent-feedback.jsonl →
audit-report.md` staleness edge (always-rehashed like `tooling_manifest.json`;
see `spec/dependency-map.md`), and remediate-code aggregates it in the close
phase. Both reports emit a "Process Feedback" section when reflections exist.

### Token savings and model routing — DECIDED 2026-06-11

**Decision: headroom (https://github.com/chopratejas/headroom) replaces
opentoken everywhere.** Host level done; orchestrator swap is a redesign work
item.

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
- **Orchestrators (redesign work item):** replace the opentoken exec-wrap with
  the npm `headroom-ai` TS SDK (`compress(messages, { model })`) as a library
  step — compress packet evidence at build time and worker payloads at
  ingestion. Atomic replace in one node: delete `wrapForOpenToken` /
  `quoteForOpenTokenCmd` / `runTracked`'s `opentoken` option
  (`shared/src/tooling/exec.ts`), the sessionConfig field, the `prompts.ts`
  wrap-exemption text, and provider wiring (~28 files reference opentoken).
  Bonus: this deletes the cmd.exe wrap-quoting trap class entirely.
- **tokencost — rejected entirely (2026-06-11), including the local-tokenizer
  substitute.** `tokencost-js` counts Claude tokens via the Anthropic counting
  API (a network call inside deterministic planning — wrong shape) and the
  Python original can't run in Node. The local-tokenizer alternative was also
  dropped: the shipped redesign standardized byte-based estimation as the
  single primitive (N-S04, `estimateTokensFromBytes`), quota learning
  self-corrects from real 429/TPM signals, `BLOCK_SAFETY_MARGIN` absorbs
  estimator error, and BPE tokenizers aren't Claude's tokenizer anyway. The
  headroom proxy's stats are the measured-usage upgrade path. Optional later:
  per-model price fields on `KNOWN_MODEL_LIMITS` for ledger cost lines (pure
  data, no deps). Revisit a tokenizer only on observed systematic mispacking.

### Nightly autonomous audit→remediate pipeline — capstone, UNBLOCKED

Decision 2026-06-11 was redesigns-first — and they landed the same day (46/46).
Remaining gate: one dogfooding self-audit on the new architecture. Then build:
scheduled run (cloud routine or local headless `claude -p`) → audit →
auto-remediate actionable findings behind green test gates → PR + findings
report, escalating only ambiguity/low-confidence fixes to Ethan.