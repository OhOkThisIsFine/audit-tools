# audit-code / remediate-code — dogfood feedback (2026-06-19)

> **Status: synced + reconciled (2026-06-19).** Recorded during a separate conversation
> while another machine worked the repo; that work is now merged (`main` @ `8122ccae`).
> Two pushed commits already address part of this list — see Reconciliation. Items 1, 2,
> and #3 still need a clarify-with-Ethan pass before format/behavior is finalized.

## Reconciliation against synced work (`main` @ 8122ccae)

**Already addressed by the other machine — verify, then close:**
- ✅ **False "blocked" write-scope** + **commit-vs-state divergence** → `8122ccae`
  moves write-scope enforcement INTO `acceptNodeWorktree` (`enforceAcceptWriteScope`):
  after verify, *before* cherry-pick, so a violation prevents the merge instead of
  landing then being flagged post-hoc. Worker `amended_files` adjudicated at accept time
  vs an ephemeral `OwnershipRegistry`. Post-hoc merge-time gate deleted.
- ✅ **Verify output not captured** (recovery flew blind) → `81bc8fe6` persists a
  `diagnostic` (failing verify cmd + stdout/stderr) into `accept-outcome-*.json`, echoed
  into triage `failure_reason`.
- ✅ **`accept-node` missing `--run-id`** prompt friction → `81bc8fe6` renders
  `accept-node --id <BLOCK_ID> --run-id <runId>`.

**Fixed on branch `resume-list-dogfood-fixes` (not yet merged/pushed):**
- ✅ `resolved_no_change` crashes merge → `38d9cf1e` (type + validator + merge branch + collapse + rolling success-check)
- ✅ `free_form_intent` `5.1`→`5`+`1` mangle → `6d0d101a` (decimal-safe clause split)
- ✅ audit `scope_summary.json` missing → `7a9a7925` (thread artifactsDir into intake executor)
- ✅ untracked files invisible to worktree → `da6e142f` (seedUntrackedDeclaredPaths)
- ✅ direct-commit-to-base branch (BUG 1) → `53e5caf2` (dedicated `remediation/<runId>` branch, base never touched, left for review)
- ✅ failed-node data loss / NODE-3 (BUG 2) → `f437e80f` (durable `refs/remediation-quarantine/` ref survives `branch -D`/prune; "Preserved for Recovery" report section)
- ✅ INV-CO-12 near-verbatim demand (BUG B) → `3f08d192` (judge derivation on CONTENT terms by majority, drop function-word stopwords; fail-closed preserved)
- ✅ contract re-emit churn on cosmetic edits (BUG Y) → `a9cf29d0` (whitespace-normalize projection + narrow the intermediate `module_contracts` entries; deeper prose-field stripping deliberately deferred — those feed downstream LLM prompts, so stripping under-fires staleness)

**All 8 code bugs fixed.** Still open (format/behavioral — need Ethan):
- Note 3 — ambiguity-up-front (behavioral: detect+clarify all scoping/judgment ambiguity at intake/confirm-intent, never defer mid-run).
- Notes 1 & 2 — lens-proposition markdown schema; standardized finding display. **Need Ethan's format call** — plan: draft concrete proposals for review.

Source: `/audit-code` → `/remediate-code` run on the friction-loop repo. Two buckets:
Ethan's notes, and concrete issues hit in the flow.

## User notes (need clarify-with-Ethan before finalizing)

1. **Lens proposition needs a real schema.** Intake asks which lenses to cover as free
   prose, not a structured contract. Define a **markdown schema for the lens proposition**
   — proposed lenses, mandatory vs optional, suggested-exclude + reason, custom-lens slots
   — so the host renders/asks it consistently instead of improvising an `AskUserQuestion`.
   Clarify format with Ethan first.
2. **Audit finding display needs consistent formatting + clarity.** Final-report finding
   blocks are uneven (some have evidence bullets, some don't; field order/labels vary; long
   architecture summaries are single dense paragraphs). Standardize per-finding layout; make
   severity/lens/confidence/files scan at a glance. Clarify format with Ethan first.
3. **Ambiguity must be resolved before planning, not deferred mid-run.** A batch of
   architecture findings got routed to "handle later" due to scoping/judgment ambiguity that
   surfaced *after* planning started. Remediator should detect + clarify every such ambiguity
   up front (intake/confirm-intent), so the whole set is decided in one pass and nothing
   silently falls out of scope once remediation is underway.

## Issues hit in the flow

### audit-code
- **Lens question was unstructured** — confirm-intent left the host to invent the lens
  question format (ties to note #1).
- **`scope_summary.json` referenced by the loader didn't exist** — loader says to read it
  after the intake step; file wasn't produced (scope came from the step prompt instead).
  Either emit it or drop the instruction.

### remediate-code
- **Worktree write-scope gate produced false "blocked" states.** Workers that edited exactly
  their declared file (e.g. `install.ps1`, `hooks/friction-session-start.ps1`) were rejected
  with *"edited files outside its declared write scope"* even though the edit was in scope.
  The DAG node schema the host fills has no explicit `write_scope` field, so the gate derived
  a scope that didn't match the obligation's own files.
- **Commits landed despite "blocked".** `accept-node` committed NODE-1/2/4 to the branch, yet
  `merge-implement-results` reported them rejected and state marked them blocked — commit
  state and run state diverged.
- **Tool committed directly to `main`.** No branch-first; host had to retro-create a feature
  branch and reset `main`.
- **One node never landed and was unrecoverable from its worktree.** NODE-3 (stop-pipeline)
  failed verify (`verify_passed=false, merged=false`) and its worktree was already pruned by
  recovery time (`git worktree remove failed … is not a working tree`), so the verified fix
  was gone — had to be re-implemented by hand.
- **Invalid worker status crashed the merge.** A worker wrote `status: "resolved_no_change"`;
  `merge-implement-results` hard-errored (*"must be resolved or blocked"*) instead of treating
  it as a no-op. Needs a permitted no-change status or graceful handling.
- **Untracked files invisible to worktree isolation.** `opencode.json` and
  `.gemini/commands/audit-code.toml` exist in the main tree but are git-untracked, so they
  don't appear in committed-files-only worktrees — the config node couldn't see its own
  targets. Audit scoped them; remediation can't reach them.
- **Contract-pipeline re-emit churn.** Cosmetic upstream edits (whitespace, one added array
  element) re-fired downstream phases (critique, test-plan, assessment) via semantic-hash
  changes, each needing a full re-emit even when the prior verdict was unaffected. Diff-based
  re-review helped but the loop still cycled several times.
- **`free_form_intent` clause splitting mangled text.** Clauses split on `;` and `.`, turning
  *"Windows PowerShell 5.1"* into *"Windows PowerShell 5"* + *"1"* and emitting spurious
  "unencodable clause" warnings.
- **Structural gate (INV-CO-12) wanted near-verbatim text.** The seam-derivation gate only
  passed once the agreed-interface string was embedded almost verbatim in a module's
  `seam_adjustments`; paraphrase failed it.

## Net result
30/30 findings addressed (22 code / 5 documented / 3 surfaced), but a large fraction of the
remediation had to be done by hand outside the tool because of the gate/state issues above.
The flow worked; the **worktree-gate + state-accounting layer** is where it broke down.

## Triage hint (for the resume session)
Highest-leverage cluster = remediate-code worktree-gate + state-accounting (false-blocked
write-scope, commit-vs-state divergence, direct-to-main, pruned-worktree data loss, invalid
status crash, untracked-file invisibility). These are correctness/data-loss bugs — likely
take priority over the format/schema notes (1, 2) which are UX + need Ethan's format call.
