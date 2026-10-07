# Dogfood audit run and lap friction — interim record — 2026-10-05

<!-- review-routing: backlog-forward -->

Interim record of lap 0306686d ("clean the repo, then run a dogfooding audit"). The audit run is paused at
about half way because the weekly Claude quota ran out. This record exists so that the friction list and the
run state survive the loss of the local machine. The next session routes each entry to its backlog file
(`docs/backlog/open-bugs.md`, `docs/backlog/minor-bugs.md`, `docs/backlog/durable-traps.md`, or
`C:/Code/docs/backlog.md` for machine-wide items) and then writes the final dogfood record.

## Routing (2026-10-06)

Every entry below now lives in its backlog file (`open-bugs.md`, `minor-bugs.md`, `forward-tracks.md`;
machine-wide items in `C:/Code/docs/backlog.md`). Three leads were checked against source and refuted, so
they have no entry: `runDeterministicFold` keeps the refreshed intake bundle; DR-001 is fixed by `000d8067`
(`resolveEditSurfaceManifest` fences landed paths); and remediation does pause with "Verification command
required" when no command is discovered. The AGY false-fact item has no entry: the machine rule to verify
every lane output against source already covers it. The final record waits for the end of the run.

## Run state at pause

- Run: audit-code dev wrapper on the lap worktree, run id `9d4d3419-3c01-42b3-b880-493e9fab32b5`, 1245 files.
  Owner choices: lenses architecture, maintainability, tests, config_deployment, observability; deep conceptual
  review with 7 perspectives; full scope; analyzers semgrep, jscpd and osv-scanner granted, eslint and knip declined;
  all lanes on Claude sub-agents.
- Charter extraction and charter comparison: accepted (second pass). 284 of about 530 inspection items accepted.
- Next step: design review (7 conceptual perspectives and the judge must run again; the contract review stands),
  then the systemic challenge, the remaining inspection items, clarification, deepening and synthesis.
- Owner decision: finish this run first with no source edits in the audited worktree; then build the frozen-snapshot
  design (below) as its own lap.

## Owner design direction (forward track)

Freeze the audited repository at audit start: the audit pins a commit and audits its own worktree of that commit,
so no edit made during a run can make the run's artifacts stale. The staleness and dependency machinery then serves
sequential audits: a later audit reviews only the files changed since the last completed audit's pinned commit.
Existing pieces: the delta scope and `applyContentAddressedPreservation` in
`src/audit/orchestrator/planningExecutors.ts`. Open design points: a dirty tree, a repository without git,
dependencies for repo-local tools in the snapshot, and mapping findings onto the live tree for remediation.

## Defects in audit-code found by the run

1. FIXED (`0183f933`, PR 22): chunk task ids were positional (`part-N`) or scope-only. Each re-plan re-chunks the
   pending files, so one id named other files, accepted results failed validation, and `next-step` stopped
   (75, then 306 errors).
2. One invalid accepted result stops the whole run (`executeAdvance` in `src/audit/cli/auditStep.ts` throws)
   instead of returning that one item for repair.
3. A re-plan discards in-flight work for every re-chunked task (logged in `docs/backlog/open-bugs.md`).
4. Staleness is coarse: a one-line comment edit re-ran every charter lane, while the structural and revealed lanes
   read only two unchanged test files. Inspection ingest waits behind the charter step.
5. Coverage claims are self-attested: a Haiku batch reported 44 results and wrote 12; a Sonnet batch claimed full
   coverage of two files it never opened, and the contract checks accepted the claim.
6. Every step prompt lists all pending work items (180-250 KB) before its own instructions.
7. The charter structural and revealed packets held only the two `projectTestAdmission` test files of 1244 files;
   the stated packet is 3.3 MB (215 excerpts), and both stated runs read only the core documents.
8. Conceptual perspective lanes read only the head of the read-only call-site map; nothing makes them read it.
9. Leads from inspection, not yet verified: `runDeterministicFold` re-runs intake and discards the result; the
   file-lock heartbeat only logs a stolen lock; `explain-task` takes the task id from `argv[3]`; `args.ts` turns a
   value between 0 and 1 into 0; the status command misses `not_applicable`; `SchemaVersionMismatchError` advises
   deleting authored state; `loopCoreClosure.mjs` never tries `index.ts`; the vitest shard baseline is stale (254
   files missing); `check-backlog-budget --update-baseline` grandfathers new violators.
10. Design review (first pass): DR-001 (high, confirmed by a second reader): remediation close stages and commits
    edits made after the run on paths the run already committed.
11. Charter comparison: the README says "language-agnostic", but test commands are discovered only for npm, Go and
    pytest; the docs say remediation can pause for a decision when no verification command exists, and the code has
    no such path.

## Repository gates and hooks

- `attest-loop-core-review.mjs` reports its refusals one class at a time (sites-pinned, then the generated backlog
  index); each fix changes the tree, so the task-id fix needed four full suites before commit and one before land.
  `npm run staged:legs` before the first suite finds both at once.
- A loop-core commit needs a second full suite before it can land (open-bugs entry).
- `tests/shared/bounded-call-single-source.test.ts` matches `advance(` in raw text, so a comment tripped it.
- The constitutional-doc gate refuses a change confined to a generated region (open-bugs entry).
- The sites-pinned leg reports one file per run.
- A repeated `--reviewed-by` keeps only its last value.
- The repo's tool-input guard refused a plain worktree sub-agent, taking it for an audit node.

## Delegation and quota

- Machine-wide (agent-dispatch): two litellm xhigh workers ran 46 minutes each on self-contained briefs and changed
  no file; one xhigh worker sat 15 minutes in one reasoning step; `opencode_wait` always exceeds this host's call
  limit (use `opencode_check`).
- About 15 concurrent Claude sub-agents hit the plan limit four times; every in-flight agent died and lost its
  partial work. Waves of about 9, refilled one at a time, worked.
- An AGY refuter stated a Windows file-permission fact with confidence; a red proof showed it false.

## Smaller items

- Machine-wide: the session-start guard reported "HEAD is 13 commits behind origin/main" when HEAD equalled it.
- The Skill tool served stale `/ship` text after the file had changed.
- Git Bash rewrites a native-program argument that starts with `/` as a path (use the Edit tool or
  `MSYS_NO_PATHCONV=1`).
- The minor-bugs "auditor severity calibration" entry outlived its answer.
