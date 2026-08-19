# The a360d399 record-update gate — measurement against 180 real commits (2026-08-18)

The ledger answer for subject `a360d39985d537e8` says: *"Build the gate: a commit that touches a
tracked-work path must carry the corresponding record update, enforced in the pre-commit gate."*
The build lap measured every candidate shape before implementing; the measurement falsifies the
stated property's mechanical enforceability, so the entry goes back to the owner as a re-scope
question instead of a silent build. This record is the evidence base for that question.

## Measurement

Method: the last 180 commits, touched paths classified *work*
(`src/ | scripts/ | tests/ | .claude/hooks/`) vs *record*
(`docs/backlog* | docs/HANDOFF.md | .claude/nightly-decisions.json | open-items.json`); the
heuristic shape fires when work>0 and record=0.

- **Any-work threshold: 30/180 fire (~17%), zero true positives.** Fired commits inspected:
  nightly-item executions whose ledger stamp is cross-commit BY DESIGN (`completed_ref` needs the
  work commit's sha — e.g. `13c08618` stamped later by `9e868721`), plus pure refactors, test
  splits, and CI fixes — the exact class the design brief said must never require a docs edit.
- **≥6-work-file threshold: ~7/180 (~4%), still all false.**
- **True positives in the window: 0.** Work commits needing records demonstrably carry them
  already (`ba112c9b`, `0c0ff8f1`, `94f1a4d0` all stage backlog/HANDOFF beside src). The one real
  incident (2026-07-28, execution state in an untracked checkpoint while HANDOFF/backlog/queue
  went stale) predates the window.
- **Declared work↔record path pairs: zero declarable.** The incident's work touched arbitrary
  paths; every path↔path correspondence that IS mechanical already has its own gate
  (loop-core patterns, hooks↔settings, guard-reach, handoff-roadmap, backlog-index).
- **Bypass decay:** at 4–17% false-fire, an inline escape becomes reflex within a week, and the
  *compliant* path trains one-line noise edits into `open-bugs.md` — records manufactured to feed
  a gate, which `check:backlog-budget` and the documentation philosophy both fight.

## What already covers the incident's mechanical halves

| Half | Enforced by |
|---|---|
| HANDOFF generated-state parity | `check:handoff-roadmap` at commit + CI + the closeout gate at Stop |
| answered≠done ledger visibility | `completed_at`/`completed_ref` split + SessionStart nudge (`nightly-surface.mjs`) |
| nobody-asked-at-close | closeout-challenge evidence legs |
| backlog status prose says the right thing | **nothing — and nothing mechanical can** (the sol-5 class; `check:backlog-status` bans status fields, so there is no field a gate could demand) |

## The one surviving narrowed shape (buildable, but a re-scope)

A deny-once tripwire on the incident's mechanical signature: at commit time, any UNTRACKED `*.md`
under `.audit-tools/nightly/` (EXCLUDING `proposals/` — tracked records are born untracked there,
a measured false-fire) or any `checkpoint`-named file under `.audit-tools/` outside the
`audit/`/`remediation/` run dirs → block once with the paths named, append to a lifetime ack
file, retry proceeds. No env, no incantation — the escape IS the retry (the stale-main deny-once
mechanic). Fire rate against the current tree: zero; honest risk is dead weight (n=1 incident),
not over-firing. It enforces "one forced, evidence-named look at the records", NOT "the record
update rides the same commit" — which is why building it without the owner's re-scope would be a
false close of the ledger answer.

## The decision this feeds

Owner picks one: (1) close `a360d399` as covered-by-neighbors, recording this measurement as the
re-decision; (2) build the narrowed tripwire above and re-scope the answer to it; (3) build the
high-threshold heuristic as measured (~7 false fires per 180 commits, 0 true, reflex-bypass risk
— included for completeness, the measurement argues against it).
