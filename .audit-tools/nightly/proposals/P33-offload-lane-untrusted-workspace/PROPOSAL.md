# P33 — The free-provider lane has no file access and answers anyway

## The problem

The nightly's declared second independent lane is
`powershell -File C:\Users\ethan\freellmapi\claude.ps1 -p "<prompt>"`. That
launcher isolates `CLAUDE_CONFIG_DIR` (correctly — a claude.ai session collides
with a proxy token). But the isolated config at
`C:\Users\ethan\freellmapi\claude-config\.claude.json` has never trusted this
workspace. Its `projects` map holds `C:/Code/freellmapi`, `C:/Code`, and a temp
dir — **not** `C:/Code/audit-tools`, and trust is not inherited from the parent
directory.

So every invocation opens with:

> Ignoring 29 permissions.allow entries from .claude/settings.json: this
> workspace has not been trusted.

and the lane runs with no repo tools.

**The failure is silent, not loud.** The lane does not error and does not return
empty — it answers from nothing. On 2026-08-14 it was asked for a doc-drift
review of `docs/audit-pkg/*.md` and returned a confident, well-formed *sprint
closeout* reporting "zero findings" and a green 5111-test run it never executed.
That was recorded in `23d2a1e8` as "the free-provider lane returned a closeout,
not a review — record it as zero corroboration". The diagnosis stopped at the
symptom; this is the cause.

That is the worst possible failure shape for a corroboration lane: it manufactures
agreement. `[[lane-agreement-is-not-evidence]]` already records two fabricated
confirmations in one run.

## Recurrence

5 records across 4 dates:

- `memory/nested-claude-p-lane-fails-oauth.md` — 2026-08-05, same warning, fix
  already written down (`hasTrustDialogAccepted: true`).
- `memory/dispatch-lane-children-hit-repo-stop-gates.md` — 2026-08-07, listed as
  a per-dispatch checklist item; set that day **for a different isolated config
  dir**. The freellmapi dir was never covered, which is why it kept recurring.
- `memory/pool-lane-needs-verification-shaped-prompts.md` — records the same
  permissions-dropping effect.
- `.audit-tools/nightly/pool-leg1-2026-08-14.log:1` — the warning, then the
  fabricated closeout.
- `.audit-tools/nightly/pool-leg2-2026-08-15.log` — tonight; the entire log is
  that one line.

## The mechanism — a removal, then a guard

**Removal (the actual fix).** Add `C:/Code/audit-tools` to `projects` in
`C:\Users\ethan\freellmapi\claude-config\.claude.json` with
`hasTrustDialogAccepted: true`. One key, one file. Trusting a workspace the owner
works in interactively every day grants nothing that is not already granted.

**Guard (do this too — the removal fixes one workspace, not the class).** Make
`claude.ps1` assert the flag for its target workspace before spending lane
minutes, and refuse loudly if absent. A dead lane is recoverable; a lane that
fabricates corroboration is not. This is the same principle as
`[[false-red-is-as-corrosive-as-false-green]]`, and it is why the guard is worth
building even after the config key lands.

## Why leg 3 is not applying this

Both edits are outside the repo, in the owner's machine config and in the
launcher. `[[offload-switch-is-owner-owned-config]]` records the owner's
2026-08-07 decision that the offload lane's toggles stay owner-owned. That ruling
is about repo-behavior kill switches and this is a property of the lane's own
config dir, so it is arguably outside it — but it is close enough that the owner
should confirm rather than have the nightly assume.

## Cost while it stands

The nightly has claimed two independent lanes since 2026-08-13 and has had one.
Every "two lanes agreed" statement in that window is really one lane. Tonight's
leg-2 corroboration did not run; it is in this run's `skipped` list.
