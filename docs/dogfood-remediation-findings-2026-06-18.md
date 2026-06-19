# Dogfood findings — remediate-code on its own backlog (2026-06-18)

Ran `remediate-code` end-to-end on a curated batch of backlog "enforce-in-tooling"
fixes, as the host driver (Claude Code, host-subagent rolling dispatch on Windows).
This is the record of what the dogfood produced. The contract pipeline + rolling
dispatch were exercised fully (intake → confirm → goal/context/decomposition →
module contracts → seam → finalize → conceptual critique → test plan → assessment →
adversarial critic → judge → repair loop → implementation DAG → review gate →
rolling implement → accept-node → merge → triage → report).

## Headline

The dogfood found and **fixed 3 real, shipped bugs** (the rolling implement path was
100% broken on Windows), landed **4 backlog fixes (F5–F8)** through the tool, and
surfaced several frictions. Net: main green, all changes landed via the tool's own
accept-node cherry-pick after the blocking bug was fixed.

## Bugs found + FIXED (committed, tested)

1. **Rolling-verify 100% broken on Windows** (`6a551b28`). `verifyNodeInWorktree`
   (`src/remediate/steps/dispatch.ts`) spawned `npm`/`npx` with `shell:false` and no
   `resolveWindowsShimSpawnCommand` → every node's first verify command (`npm run build`)
   hit ENOENT → `verify_passed:false` → every node blocked at triage. The whole
   host-rolling implement path could never land anything on Windows. Fixed by routing
   verify commands through the shared Windows-shim resolver (OS-agnostic invariant) +
   surfacing spawn `r.error` as a verify failure. (Analogue of the audit colon-in-packet-id
   win32 bug from the prior session — same class: a core path bypassing an OS abstraction.)
2. **Stale per-node branch on re-dispatch** (`c9575b7f`). `createNodeWorktree`
   (`src/remediate/steps/rollingSession.ts`) used bare `removeWorktree`, leaving the branch;
   a triage retry then failed `git worktree add -b` with "branch already exists", aborting
   the whole re-dispatch. Fixed by using `resetNodeWorktreeAndBranch` (parity with the
   in-process driver).
3. **Orphaned worktree directory on re-dispatch** (`e29cec16`). When a prior attempt left an
   orphaned worktree dir (admin entry gone, files remain), `git worktree remove` no-ops and
   `git worktree add` refuses ("'<path>' already exists"). `resetNodeWorktreeAndBranch` now
   `rmSync`-removes the leftover directory after prune.

Each shipped with a real-git / platform-aware regression test.

## Backlog fixes landed (F5–F8) — through the tool

After the verify-shim fix, the rolling drivers re-dispatched and `accept-node` verified +
cherry-picked all four into main (`bca2850c` F5, `3ecb492d` F6+F7, `c5005289` F8):
- **F5** — `parseJsonLoose` string/escape-aware balance scan (largest/non-trivial complete
  object; tolerates trailing garbage + a pre-payload example object) + `response_format_json`
  default-ON with degrade-on-HTTP-rejection (400/422) retry. (`src/shared/providers/openAiCompatibleProvider.ts`)
- **F6** — OBL-CO-01 paired-obligation gate recognizes explicit `POSITIVE:`/`NEGATIVE:` labels
  as authoritative polarity (skips keyword detection for labeled assertions).
- **F7** — INV-CO-12 seam-derivation gate includes `seam_adjustments` in its corpus.
- **F8** — `validate-artifact` auto-unwraps a content-hash envelope via the canonical
  `isEnvelope` (relocated to `artifactStore.ts` for an acyclic import).

The adversarial critic→judge→repair loop did real work: it tightened F5's contract
(CE-001 "first complete object" → largest/non-trivial; CE-002 degrade-on-400 → any rejection)
before implementation, and those tightenings are in the shipped code.

## Stale backlog discovered

The original batch was 10 items; **against-source verification found 6 already shipped**
(old F1/F2/F3/F4/F9/F10) but never removed from `docs/backlog.md`. (An Explore agent's
blanket "all 10 done" was wrong on F5/F7/F8 — verifying against source mattered.) The
6 stale entries should be pruned from the backlog.

## Frictions surfaced (not yet fixed — see backlog)

- **Write-scope gate runs AFTER accept-node cherry-picks.** In the host-rolling path the
  out-of-scope edits land in main first, then `merge-implement-results` flags them — so the
  gate reports post-hoc rather than preventing the landing. (Plus: the host-declared
  `file_scope` in module_decomposition is a guess the rolling worker can't amend via the
  surfaced prompt; my narrow/guessed scopes — wrong test filenames, the isEnvelope relocation,
  a sessionConfig doc touch — all tripped it though the edits were correct.)
- **`accept-outcome` sidecar / triage discards the verify command output.** `outcome:error`
  with no captured stderr left the first triage blind to the root cause (had to reproduce by
  reading source). The sidecar should persist the failing command + output.
- **`--input` after intake is a hard conflict.** The `/remediate-code` loader says to pass
  the same flags each `next-step`, but a post-intake `--input` triggers an input_conflict +
  resume/restart ack dance. The loader guidance should say to drop `--input` once a run exists.
- **`accept-node` requires `--run-id` but the dispatch prompt shows only `--id`.** Doc drift.
- **Dogfooding uses the stale global bin.** Driving the run with fixes in flight required the
  local `node remediate-code.mjs` wrapper, not the global `remediate-code` (known trap).

## Outcome

Main green end-to-end (`npm run build && npm run check` clean; full suite 1630 vitest +
shared/audit node:test pass, CLAUDECODE unset). The remediation run was halted at the final
triage (the write-scope rejection is a host-under-declaration false-positive; the value was
already landed + verified by the tool), and this report is the deliverable record.
