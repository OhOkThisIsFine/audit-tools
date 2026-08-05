# P8 — a premise probe pointed at an UNTRACKED file still yields `absent`, and `absent` means "done"

## The defect, in one line

`evaluateOneProbe` justifies its strongest verdict — `absent`, which all-absent turns into
`resolved` / `premise: gone` — with **git evidence**. When the probe's file is untracked or
gitignored, git has nothing to say about it, and the function returns `absent` anyway.

## Why P7's fix does not cover this

P7 (shipped as `3750a943`, *"premise-probe absence is git-evidenced, never inferred from ENOENT"*)
closed the case where the file **does not exist**. This is the case where the file **does exist**
and git still cannot speak about it. The two run through different branches:

```js
// scripts/nightly/items.mjs — evaluateOneProbe
if (fileText !== null) {
  // File present, fragment nowhere: the direct read IS the absence evidence —
  // git adds rename protection (above) and a citation (below), and when it
  // cannot answer we lose only those extras, not the verdict itself.
  const removal = gitLines(root, ['log', '-1', '--format=%h', '-S', probe.contains, '--', probe.file]);
  return { state: 'absent', commit: removal?.[0] ?? null };   // <-- here
}
```

The comment states the design intent exactly: *"when it cannot answer we lose only those extras,
not the verdict itself."* That reasoning is sound for a **tracked** file — the direct read is real
evidence, git only adds provenance. It is unsound for an untracked one, because the premise being
probed is *"does this defect still exist in the codebase"*, and an untracked runtime artifact is
not the codebase. Its content changes every run for reasons that have nothing to do with the fix.

The `git grep` rename-protection leg above it has the same blind spot: `git grep` searches the
tracked tree, so a fragment that lives only in ignored output can never be found `moved`, and the
function falls straight through to `absent`.

## It fired tonight, on a live entry that is NOT fixed

Tonight's leg-2 triage stamped `premise: gone` on `open-bugs.md:9` — *"Remediation pause/recovery is
not durable (2026-08-03, medium)"* — on this probe:

```json
{ "file": ".audit-tools/remediation/state.json", "contains": "status: implementing" }
```

`.audit-tools/remediation/state.json` is **gitignored** (`.gitignore:84` — `.audit-tools/*/*`). The
string is absent right now for the mundane reason that no remediation run is currently mid-flight.

The entry's actual property — *"`plan_only`, pause, cancel, and resume persist the node, claim,
worktree, process-group outcome, and exact continuation action"* — is **unbuilt at HEAD**:

```
$ grep -rn "plan_only" src/remediate --include='*.ts'
(no matches)
```

So the strongest available verdict was manufactured from a file that carries no evidence either way,
about work that has not started. Had a deletion pass trusted the stamp, a live medium-severity entry
would have been deleted.

The second `gone` of the night has the same shape: a probe on `docs/reviews/re-dogfood-2026-07-21.md`
for the fragment `#14`. `docs/reviews` is on the `git grep` exclusion list *and* is
excluded-by-construction from the doc corpus, so that probe can also only ever resolve one way.

## Recurrence — three consecutive nights, three different wrong signals

| Date | What the probe lifecycle got wrong |
|---|---|
| 2026-07-25 | 15 of 21 surfaced items were already fixed at HEAD — the reason probes were introduced |
| 2026-07-30 | 44% of classified rows carried a `premise` stamp that was not trustworthy evidence (nightly `sol-3` → P7) |
| 2026-08-05 | both `gone` stamps false: one on a gitignored runtime artifact, one on an excluded review record |

Each night the *specific* fault differs and the *class* is identical: **a probe is allowed to point
at something the evidence chain cannot reason about, and the failure surfaces as the confident
verdict rather than as an abstention.**

## The mechanism — refuse the probe target, don't patch the verdict

Prefer making the trap unrepresentable over catching it. The probe contract already says the
fragment must be quoted from a file's *current content*; it does not say **which files may be
probed**. Add that constraint at the two points where probes enter the system.

1. **Classify the target before evaluating it.** In `evaluateOneProbe`, resolve the probe's file
   against `git ls-files --error-unmatch <path>` once per distinct path (cached per call). An
   untracked or ignored path can never produce `absent` — it returns a new terminal state
   `untrackable`, which `evaluateProbes` treats exactly like `bad_path`/`unknown` today: it is
   signal-free, so `status` cannot become `resolved` on it.

2. **Refuse it at creation.** `writeOpenItems` already throws when a probe does not pass at HEAD.
   Extend the same refusal: a probe naming an untracked path is malformed, with the message saying
   why (*"probe target is not tracked by git; a runtime artifact under `.audit-tools/` or a
   gitignored file carries no evidence about whether a defect is fixed — quote the source file the
   fix would touch"*). This is the load-bearing half — it stops the bad probe being written at all,
   rather than tolerating it downstream.

3. **Same rule for the `git grep` exclusion set.** A probe whose file sits under `docs/backlog`,
   `docs/reviews`, `docs/HANDOFF.md`, `docs/nightly-inbox.md` or `.claude` is probing the *record*,
   not the *code*. Those paths are already excluded from the rename-protection search precisely
   because a quote there says nothing about the premise; a probe pointed directly at one is the same
   error, one step earlier. Refuse it identically.

`scripts/shared/triage-backlog.mjs` imports `evaluateProbes` from the same module, so both consumers
— the nightly items file and the leg-2 triage stamps — are fixed by the one change.

## What it would have caught

Tonight's two false `gone` stamps, at the moment the record was written rather than after a hand
trace. And the general case the probe mechanism exists to prevent, running in reverse: instead of a
stale item surviving, a live item being closed.

## False-positive surface

A probe legitimately aimed at a tracked generated artifact (`docs/backlog.md`'s seek index,
`docs/nightly-inbox.md`) — tracked, so rule 1 admits it; `nightly-inbox.md` is caught by rule 3,
which is correct, since the inbox is the routine's own output and probing it is circular.

The real cost is a probe about *runtime behaviour* that genuinely has no source anchor. That case
should abstain rather than assert, which is exactly what `untrackable` does: the item stays open and
a human decides. An item that cannot be probed against source is an item whose premise nobody can
mechanically check, and surfacing that honestly is the point.

## Patch + tests

`PATCH.md` in this directory carries the change to `scripts/nightly/items.mjs` and the red-green
tests. Tests go under `tests/` — vitest excludes `.claude/**`, and `scripts/nightly/items.mjs` is
already covered by tests there.
