# P53 — move the commit gate to git's own boundary, and correct the record that calls the jurisdiction defect closed

**Leg 3 (recurring-problem solutions). Proposal only — nothing was landed.**
**Scope: THIS REPOSITORY for the gate; the project memory store for the record.**

## The trap

A guard fires on a broad trigger — every shell call — and then judges something
it does not own: a foreign repository, a read-only command, a commit-message
body. Or it refuses with a bypass string that does not work when pasted back.

## Recurrence — 10 records across 7 distinct dates

| Record | Date |
|---|---|
| `memory/pre-commit-gate-roundtrip-clobber-trap.md` — a substring match on "commit" engaged the tree-rewriting round-trip on `git diff` | 2026-07-23 |
| `memory/a-guards-escape-must-work-as-stated.md` — an inline `NAME=1` prefix never reached the hook's environment | 2026-07-26 |
| `memory/a-gate-must-not-ask-the-local-disk.md` — `existsSync` targets made the verdict machine-dependent; main went red | 2026-07-28 |
| `memory/false-red-is-as-corrosive-as-false-green.md` §3 — a gate with no jurisdiction blocked a foreign repo | 2026-08-19 |
| `docs/backlog/durable-traps.md:323` — the gate scans commit-message *text* for the trap it guards | (dated in entry) |
| `docs/backlog/durable-traps.md:89` — a session rooted above the repo loads none of its hooks; every gate silently off | (dated in entry) |
| `C:\Code\docs\backlog.md:253`, `:276` — `shell-conventions-guard` reads `cd <dir> && <gen>` as a chained generator | 2026-08-30 |
| `C:\Code\docs\backlog.md:341`, `:636`, `:707` — heredoc detection matches a doubled angle bracket | 2026-08-30/31 |
| `docs/backlog/open-bugs.md:39` — `bypassEnabled` rejects the advertised escape on any statement after a newline | 2026-09-04 |
| `docs/backlog/open-bugs.md:52` — `pre-commit-gate.mjs` refused `git commit -m init` in a fresh `mktemp -d` repo | 2026-09-04 |

## The sharp half — a record calls this closed while it is live

`memory/false-red-is-as-corrosive-as-false-green.md:40` reads: *"A third source,
**CLOSED 2026-08-19**: a gate with no jurisdiction … Closed mechanically … pinned
by `tests/shared/pre-commit-gate-target-repo.test.ts`."*

The gate's resolver is genuinely careful — a cd-chain fold, `git -C` hops,
identity by absolute `--git-common-dir` so linked worktrees stay gated. Its own
header also declares it **fail-closed on an unresolvable hop**, accepting "the
old false RED in an exotic shape" as the residue.

The 2026-09-04 measurement in `docs/backlog/open-bugs.md:52` is that residue
firing. `cd $(mktemp -d)` is a command-substitution hop the parser must poison,
so a throwaway probe repo resolves to *this* repo and is refused, naming
`docs/doc-review-guidelines.md` and `docs/project-philosophy.md` — files that
belong to a different repository entirely.

The accepted residue is not exotic: a `mktemp -d` scratch repo is a routine agent
idiom. The record is not false, but it is read as a closure, and this is the only
cluster where the record actively misleads the next session.

## Proposed mechanism — the boundary git already owns

Move the commit-gating legs to `core.hooksPath`, pointing at a tracked
`.claude/hooks/` pre-commit script, instead of parsing arbitrary shell text at
PreToolUse to locate where a commit will happen. Jurisdiction then cannot be
wrong by construction: git runs *this* repository's hook for *this* repository's
commits and never for a `mktemp -d` repo. No cd-chain fold, no poisoned hops, no
fail-closed policy to tune.

This is not an imported idea. `CLAUDE.md`'s own **PH-05** — *a gate states the
boundary it OWNS* — names this exact instance: *"`pre-commit-gate.mjs` parsing
arbitrary shell text to locate git's own boundary."* The repository holds the
principle and has not built the consequence.

**This is a split, not a replacement.** The PreToolUse hook keeps honest work:
the non-commit shell traps, which have no git boundary to defer to.

## Cost, stated honestly

- A git hook fires *after* the agent composes the commit, not before, so the
  pre-flight value — blocking a doomed commit early, a cheap `npm run check` —
  is reduced.
- `--no-verify` becomes a bypass the PreToolUse form does not have.
- The staged-snapshot round-trip is unnecessary at git's boundary, but the
  loop-core and constitutional-doc attestation bindings must be re-derived there.
- **The gate currently treats `core.hooksPath` as an ATTACK.** `pre-commit-gate.mjs:509`
  and `:524` reject any commit whose command carries a `core.hooksPath` override,
  as hook-bypass detection. Adopting this proposal means the same mechanism is the
  gate's own installation path, so that rule must be re-scoped — an override
  pointing AT the tracked hook directory is the intended state, and only an
  override pointing elsewhere is a bypass. This is a real collision, not a
  detail, and it is the first thing an implementation has to settle.

## Narrower alternative, if the split is rejected

Invert the fail-closed policy for one specific case: when **no statement in the
chain names this repository AND the chain creates a directory** (`mktemp`, a
`$(...)` substitution feeding `cd`), abstain instead of claiming jurisdiction.

This is weaker — it is still a parser guessing — and its false-positive surface
is real: any abstention rule is a hole a genuine audit-tools commit could slip
through if the chain is written unusually. That is precisely why the original
author chose fail-closed, and this proposal does not claim that judgment was
wrong at the time.

## False-positive surface of the proposed mechanism

The `core.hooksPath` form has essentially no jurisdiction false positives — that
is the point of moving to git's boundary. What it changes is *when* refusals
arrive, which will surprise sessions trained on the current timing.

## The record half

Independently of which mechanism is chosen,
`memory/false-red-is-as-corrosive-as-false-green.md:40` should stop reading as a
closure while the residue is live. Leg 3 is propose-only, so this run did not
edit it.
