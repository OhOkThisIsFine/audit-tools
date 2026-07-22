---
name: start-lap
description: Start a work lap in audit-tools — sync with remote main (fetch + fast-forward, stale-worktree guard), read the current HANDOFF + backlog, surface open doc-review items, then present current state + the immediate next item so work can begin. Use at the top of a session instead of "sync with remote, then continue from HANDOFF and backlog".
---

# Start-lap — sync + orient + get rolling

Automates the session-open ritual. Repo root = the audit-tools checkout. Remote `audit-tools`,
branch `main` (not origin, not master). Do the mechanical steps yourself; only hand back on a
destructive ambiguity (see step 2). End by telling the owner the immediate next item — don't ask
"what now" when HANDOFF already names it.

## 1. Sync with remote main (stale-worktree guard — do this FIRST)

A worktree can be branched behind `audit-tools/main` and miss landed work. From repo root, Bash tool:

```bash
git rev-parse --abbrev-ref HEAD          # confirm current branch
git fetch audit-tools main
git log --oneline HEAD..audit-tools/main # commits on remote not local
```

- **On `main` and behind** → fast-forward: `git merge --ff-only audit-tools/main`. If ff-only fails
  (local `main` has diverging commits), STOP and surface it — don't force.
- **On a lap/worktree branch that is a clean ANCESTOR of `audit-tools/main`** (verify:
  `git merge-base --is-ancestor HEAD audit-tools/main` + clean tree + empty
  `git log audit-tools/main..HEAD`) → fast-forward it too: `git merge --ff-only audit-tools/main`.
  No unique commits = no strand risk, and lap work then starts from current code (ship pushes
  `HEAD:main` from the lap branch, so it never needs to be `main` itself).
- **On a `remediation/<runId>` branch, or any branch with unique commits** (branch-strand trap):
  don't touch it. Note it in the hand-back — committing docs from here strands them off main. The
  owner may want to switch to main first.
- **Empty log** → already current, continue.

If the fast-forward pulled new commits, the HANDOFF/backlog you may have already seen are stale —
re-read them in step 3 from the updated tree.

## 2. Fresh-worktree / clean-tree check

- No `node_modules` in a fresh worktree → `npm install` (else `audit-tools/shared` resolves a stale
  `dist/` → fake "missing export" errors). Skip if `node_modules` exists.
- `git status` — a clean tree is expected at lap start. Unexplained foreign working-tree edits →
  could be your own compacted-out WIP (check `git reflog`), not a concurrent session. Surface, don't
  discard.

## 3. Read the roadmap (post-sync, verbatim)

Read [`docs/HANDOFF.md`](../../docs/HANDOFF.md) and [`docs/backlog.md`](../../docs/backlog.md) with the
Read tool (these must be verbatim). HANDOFF's **Live state** + **Suggested ordering**
give the immediate next item; backlog carries per-item detail + line-refs.

## 4. Reconstruct "what shipped since" (the gap HANDOFF leaves)

HANDOFF deliberately omits per-lap shipped detail (changelog creep). The commit log is what fills it:

```bash
git log --oneline -12                         # recent shipped work — orientation, not narration
```

Released-vs-local delta (is a release pending?): latest `vX.Y.Z` tag vs `package.json` version, and

```bash
git log --oneline "$(git describe --tags --abbrev=0 --match 'v*')"..HEAD
```

Any commits listed = un-released work sitting on main (HANDOFF's "live state" usually names why).

## 5. Surface open doc-review items

The SessionStart hook prints any open doc-review items (proposed instruction-file edits + design
decisions) at session start. If present, list them tersely so the owner can approve/reject — they're
applied via `node .claude/hooks/doc-review-resolve.mjs <ID>...` once actioned. Don't auto-apply
instruction-file edits; those are the owner's call.

## 6. Hand back — oriented + begin the next item

Terse digest: current live version + released-vs-local delta, sync result (N commits
pulled / already current / stranded on branch X), a one-line skim of what shipped since (step 4), the
**immediate next item** from HANDOFF's roadmap with its backlog home, and any open doc-review items
awaiting the owner. Then **start on that next item** — risk-tier it first
([[risk-tier-loop-laps-cheap-vs-heavy]]): scale pipeline depth to the risk tier — full adversarial depth
for loop-core / complex work, leaner for trivial mechanical clusters; it's ONE pipeline dialed by risk,
not a separate lean path — unless the owner redirects. Getting rolling is the point of the skill; don't park at "here's the next
item, what now?".
