# Frozen-snapshot track — design-check record, 8 October 2026

<!-- review-routing: backlog-forward -->

Pre-implementation record for the forward track "An audit run audits a frozen snapshot of the
repository" in [`forward-tracks.md`](../backlog/forward-tracks.md). Dated record, not a spec.

## Property

No edit to the live tree during a run changes that run's inputs, and a later run re-runs only the
charter lanes whose evidence changed.

## Retirement check

- Commit `580afb1c` (2026-07-22) added a disposable detached worktree of `HEAD`
  (`src/shared/providers/reviewSnapshot.ts`) as the WRITE-SCOPE guard for review workers that
  audit-tools launched. Commit `467b1e8f` (2026-08-12) deleted it with the whole launch substrate
  ("zero adapters, host-owned execution").
- Verdict: no collision. The retirement removed LAUNCHING work. A snapshot that pins what the run
  READS launches nothing; host lanes only receive its path. The retirement stands unchanged.
- `spec/multi-ide-concurrent-runs-design.md` ("The host owns worktree creation and concurrency")
  governs remediation work items, where the host chooses how to execute. It does not govern the
  tool's own input pinning.
- Commit `22da82b7` concerns test-suite root cleanliness and is unrelated.

## Decisions (settled by `docs/project-philosophy.md`, not asked)

1. **The tool creates the snapshot.** Correctness is guaranteed by the tool, never by the host.
2. **A dirty tree is snapshotted as it is.** At run start the tool builds a commit of the working
   tree (tracked changes plus untracked, non-ignored files) through a temporary index, without
   touching the user's index or refs, and keeps it reachable under a private ref. Prior art:
   `worktreeContentId` in `src/remediate/steps/gateCommands.ts`. Refusing dirt is a manual step;
   pinning `HEAD` only silently stops auditing uncommitted work.
3. **A non-git root is frozen by a copy** of its non-ignored files into a snapshot directory. A
   decision may not rest on an unmeasured rarity, and refusing breaks everything-agnostic.
4. **Repo-local tool dependencies are linked** from the live root into the snapshot: each git-ignored
   entry present in the live root, except `.audit-tools/`, is linked (junction on win32, symlink
   elsewhere). Language-neutral; no per-ecosystem install knowledge.
5. **Findings map onto the live tree through the existing read-at-ref leg.** `audit_read.commit`
   becomes the pin, and `dirty_paths` is empty by construction, so `closeVerifyHeadEvidence`
   (`src/remediate/phases/closeVerifyHeadEvidence.ts`) verifies every finding. No line-remap
   machinery is added.
6. **Charter lanes record their packet digest.** Each register lane stores the digest of the packet
   it was written from (`charterExtractionInputRevision`, `src/audit/orchestrator/charterPackets.ts`);
   a later run re-runs only a lane whose fresh digest differs.

## Refutation pass (AGY gemini-3.8-flash-high, report-only; each verdict checked against source)

- **Rejected.** "467b1e8f retired tool-created worktrees as such": the deleted producers served
  launched workers, and the owner's track direction (2026-10-05) post-dates the retirement and names
  a worktree. "580afb1c rejected snapshotting dirt": its message lists dirty-tree drift only as a
  residual. "Linked entries recurse in intake": `walk` (`fsIntake.ts`) follows only
  `entry.isDirectory()`, which a junction or symlink is not.
- **Accepted — design amended:**
  1. **Two roots.** The run keeps the LIVE root for repository identity (consent
     `repository_root` in `readRunConsentUnlocked`, artifacts dir, git refs, cleanup) and gains a
     SOURCE root for every content read and every repo-local spawn. Same split as memory
     `two-identities-repository-and-tree`.
  2. **Stable manifest name.** `buildRepoManifestFromFs` names the manifest after the root basename;
     the name comes from the live root, or every new snapshot path re-stales the whole DAG.
  3. **Host prompts are cwd-explicit to the source root**, so host lanes read the frozen tree and
     `total_lines` at ingest matches.
  4. **Persisted pin.** The pin (commit id or copy id) and the snapshot path are run state, read by
     every bounded step; a missing snapshot of a git pin is re-created from the pin; a missing copy
     of a non-git root fails closed (the frozen inputs are gone).
  5. **Location outside the repository root.** A snapshot under the root is found by the target
     repository's own test runner and meets the long-path trap (`durable-traps.md`). The snapshot
     lives in a short per-repository directory outside the root; the private ref
     (`refs/audit-tools/…`) is pruned by cleanup.
- **Accepted as a residual.** A synthetic pin exists only in this repository's object store;
  remediation in a separate clone withholds verdicts, as it does today for an unpushed `HEAD`.

## Implementation notes (as built)

- **Byte-exact snapshot.** A normal checkout re-applies line-ending filters (a file written with LF
  under `core.autocrlf=true` read back as CRLF). The checkout is added with `--no-checkout`, filled
  with the live bytes, and the pin is computed FROM that copy, so the pin describes exactly the bytes
  the run reads even when the live tree moves during the copy.
- **Location** is `<state dir>/snapshots/<key>` (`resolveAuditCodeStateDir`): outside the root, short,
  not cleaned by an OS temp sweeper, and hermetic in tests through `AUDIT_CODE_STATE_DIR`.
- **Auto-fix** formats the snapshot, writes each formatted file back to the live tree only when its
  live bytes are still the run-start bytes (a concurrent edit is reported, never overwritten), and
  re-pins the snapshot with a child commit.
- `src/audit/io/runSnapshot.ts` joined the loop-core set: it defines what a run reads.

## Independent review rounds (Opus, report-only)

- **Round 1 — 12 findings, one high** (a git-ignored POSIX symlink stopped every run). Most traced to
  ONE cause: the snapshot's `HEAD` was a synthetic commit, so untracked files became tracked, history
  mining counted the commit, `--since HEAD` shifted, and retained `audit-read` refs collided between
  checkouts. **Rework:** the snapshot's `HEAD` is the live `HEAD` at run start and its index the live
  index; the content pin is internal (the run's own ref, deleted at run end) and only restores a lost
  checkout. `audit_read` keeps today's meaning, so decision 5's gain is withdrawn: remediation still
  refuses findings in dirty files, as it did before. `--since` resolves once in the live root and is
  persisted. Each ignored entry is placed by type; one failure is a warning, never fatal.
- **Round 2 — 12 findings, none high.** Fixed: index from the live index (a staged file stays
  tracked), an unborn repository stays unborn, ignored files are copied (never hard-linked — a tool's
  cache write would reach the user's file), the re-pin subtracts placed links, a restore persists its
  links, removal never prunes, `ensureRunSourceRoot` owns "a complete run gets no snapshot" for every
  run path, a `.audit-tools` segment at any depth is never copied, an untracked nested repository is
  copied, symlink targets stay inside the snapshot.
- **Round 3 — 6 findings, none high.** Fixed: the live index tree is written from a COPY of the
  index file (`write-tree` on the live index takes the user's `index.lock`, so a held lock silently
  dropped the staged set); promotion removes the snapshot whatever the status (it deletes the
  artifacts dir for a rendered report on an unfinished run too); a TRACKED path under a
  `.audit-tools` segment is content; an untracked nested repository is copied through its own
  listing and its ignored entries placed, never copied; an absolute symlink target inside the
  repository maps onto the snapshot; an unborn checkout is intact only while its `HEAD` names the
  unborn branch. Residual: a restore does not re-place a nested repository's ignored entries.
- **Residual:** git discovery inside a COPY snapshot is fenced for this process only
  (`GIT_CEILING_DIRECTORIES`); a host lane's own git can still climb to a repository holding the state
  dir. Lanes are told only to read files there.

## Owner decision — cross-run reuse (2026-10-08)

Question: how a later audit reuses the previous completed audit's work (the track's sequential-audit
and charter-lane-reuse halves), given that promotion deleted the whole artifacts dir at completion
(owner decision `74c89b226ab9b9cd`, 2026-08-31). Options offered: promote a carry set; keep the
artifacts dir; ship the frozen half first; charter reuse only.
**Answer: keep the artifacts dir.** Completion stops deleting it; the next run re-pins and the
existing staleness DAG decides what is still valid. This reverses the delete-at-completion half of
`74c89b226ab9b9cd`.

## Verified recon map (Explore sub-agent, 2026-10-08; read-only input for reviewers)

- **Root.** `getRootDir` (`src/audit/cli/args.ts`) → `discoverRepoRoot` / `resolveRepoRoot`
  (`src/shared/io/repoRoot.ts`). Artifacts dir is separate (`getArtifactsDir`).
- **Root readers.** Manifest: `runIntakeExecutor` (`src/audit/orchestrator/intakeExecutors.ts`) →
  `buildRepoManifestFromFs` (`src/audit/extractors/fsIntake.ts`); `buildLineIndex`
  (`src/audit/cli/lineIndex.ts`); `checkFileIntegrity` (`src/audit/orchestrator/fileIntegrity.ts`);
  `readRepoFile` / `materializeCharterPacket` (`src/audit/orchestrator/charterPackets.ts`);
  `charterFidelityPacket.ts`; `commentDecomposition.ts`; `docsDigest.ts`; the css/html/python/typescript
  analyzers; `acquisitionEngine.ts`. Git with `cwd: root`: `disposition.ts`, `scopeIndexBaseline.ts`,
  `src/shared/git.ts`, `findingGrounding.ts`, `rootLogObservations.ts`. Tools with `cwd: root`:
  `localCommands.ts`, `syntaxResolutionExecutor.ts`, `autoFixExecutor.ts`, `acquisitionExecutor.ts`.
  Repository tests: `runCommand(task.command, root)` (`ingestionExecutors.ts`), discovered by
  `discoverRuntimeValidationCommand(root)` (`planningExecutors.ts`).
- **No run-start pin today.** `audit_read` (`AuditRead`, `src/shared/types/finding.ts`) is stamped at
  synthesis by `readAuditReadState` (`src/shared/git.ts`). `GitHistoryBaseline.head` only skips
  re-mining. Run identity is spread: consent `run_id` (`src/shared/analyzerRunConsent.ts`), review
  wave ids (`src/audit/cli/reviewRun.ts`).
- **Delta.** `--since` diffs a caller-supplied ref against the working tree (`scope.ts`,
  `changedFiles` in `src/shared/git.ts`). `applyContentAddressedPreservation`
  (`src/audit/orchestrator/coverageElementBaseline.ts`) compares per-file content keys, not git.
- **Charter staleness.** `DEPENDENCY_SLICE_PROJECTIONS["charter_register.json"]`
  (`src/audit/orchestrator/dependencySlices.ts`) uses `charterReadFileSlice` over one read-set, so one
  change stales all three lanes. A per-kind packet digest is bound at emit and checked at ingest
  (`reviewSubmission.ts`), but it is transient and not stored in `charter_register`.
- **Worktrees.** No `git worktree add` in `src/`. `auditToolsWorktreesDir`
  (`src/shared/io/auditToolsPaths.ts`) has no producer. `nodeWorktreeAncestor`
  (`src/shared/io/nodeWorktreeGuard.ts`) refuses CLI subcommands run from inside
  `.audit-tools/worktrees/<name>`. Durable trap: `git worktree add` aborts on long Windows paths.
- **Integrity re-check.** `nextStepHelpers.ts` hashes pending-task files against the manifest on
  every fold and re-runs intake on a difference; on a frozen tree it can never fire.
- **Non-git.** `isGitRepo`, `warnIfNotGitRepo`; delta scope falls back to a full audit.
</content>
</invoke>
