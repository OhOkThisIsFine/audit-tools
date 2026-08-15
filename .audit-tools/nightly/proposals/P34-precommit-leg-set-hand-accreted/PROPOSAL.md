# P34 — The pre-commit gate's leg set is hand-accreted, so four live gates still first fail in release CI

## The problem

`.claude/hooks/pre-commit-gate.mjs` runs a hand-picked subset of `verify:checks`
before allowing a commit. The subset grew one incident at a time, each leg added
after a gate wired only into `verify:checks` failed release CI and burned a tag.
The hook's own comments say so:

- at the `check:handoff-roadmap` leg — "a gate wired only there first fails in
  RELEASE CI and burns a tag — **the class that burned v0.34.17**"
- at the `check:backlog-budget` leg — "Bit 2026-08-08: a docs-only commit
  verified with `npm run build && npm run check` left CI workflows red"
- at the `check:backlog-status` leg — "Bit 2026-08-08, and by the same shape the
  2b-iv comment above describes"

Every fix was one more hand-added leg with its own hand-written trigger paths.
The method that produced the gap is still the method.

## The live gap, verified tonight

`verify:checks` runs 26 legs. The hook invokes 10. Four of the missing ones are
the same cheap doc/registry class as the four already hand-added, and each can
still land red on a docs-only commit and first fail in release CI:

- `check:doc-code-citations`
- `check:philosophy-brief`
- `check:memory-citations`
- `check:gate-enumeration`

Verified by diffing the `verify:checks` script in `package.json` against every
`npm run check:*` invocation in the hook (`grep` over the hook returns no match
for any of the four names, in any invocation form).

## Recurrence

5 records across 4 dates: `docs/backlog/open-bugs.md` 2026-07-25 (a contract
change swept `tests/`, missed `scripts/`, "the pre-commit hook does NOT run
[`verify:checks`], so it failed release CI"); the 2026-07-29 friction walk item
(4), cost "one burned tag v0.34.40"; and the three hook comments above naming
v0.34.17 and two 2026-08-08 red-CI commits. Two burned tags are named in the
source itself.

## The mechanism

Derive the hook's leg set from `scripts/guard-reach-data.mjs` instead of
maintaining a second copy of a subset of it: run every gate whose declared REACH
globs intersect the staged path set. The registry already declares, per guard,
exactly which files it inspects — the hook is currently a hand-maintained
duplicate of that data, which is the repo's own documented duplication failure
mode.

This is a sibling of **P26**, which applies the same registry to CI's
hand-written `paths:` block, but a distinct consumer with independently dated
evidence; P26's text scopes itself to `.github/workflows/ci.yml` and does not
mention the hook.

## False-positive surface — the real one is commit latency

Widening from a hand-picked cheap set to a registry-derived one can pull
expensive gates (`vitest-gate`, the packaged smokes, `check:deadcode`) into every
`src/**` commit, which would make committing cost a full verify. So the registry
needs a per-guard eligibility flag (`preCommit: true|false`) and the derivation
must honour it.

That flag is the point, not a workaround: today the omission of a gate from the
hook is invisible — indistinguishable from an oversight, which is precisely how
four gates went missing. As declared data, "CI-only, too expensive" becomes a
statement someone made on purpose, and `check:guard-reach` can reconcile it.

## Already enforced? No

`check:guard-reach` reconciles the registry against the tracked tree — a file no
row claims, a guard wired into no gate — but does **not** reconcile the registry
against the hook's leg set. The hook is not a consumer of `REACH` at all.
