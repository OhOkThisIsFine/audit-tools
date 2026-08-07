# `/insights` triage — 2026-08-07

Record of the weekly `/insights` pass and the disposition of every suggestion it made.
Dated review record: a one-off account of what was decided on a day, excluded by construction
from doc review. Durable outcomes land in code, `spec/`, the backlog or memory.

Report: `~/.claude/usage-data/report-2026-08-07-020953.html`
Window: 2026-06-22 → 2026-08-07, 2,220 messages / 189 sessions. Triaged against HEAD `885d0ba9`.

## Why this pass ran at all

The stamp `.audit-tools/nightly/insights-last-run.json` was absent, so the pass was due. It had been
recorded on 2026-08-05 as a *blocked lane* — the nested `claude -p` spawn failed with
`Failed to authenticate: OAuth session expired and could not be refreshed`. A cheap probe
(`claude -p "reply with the single word OK"`, exit 0) showed the lane had recovered on its own with
no repo change, so the real pass ran. The credential outage is intermittent, not standing; the memory
recording it has been corrected to say so, and to probe rather than assume either state.

## Disposition rule

Every suggestion is a LEAD at the same bar as a backlog entry claiming to be shipped, and is verified
against HEAD before it can become a proposal. Three classes: **already shipped** (name the mechanism
at HEAD, drop the suggestion), **debatable** (escalate), **genuinely open** (becomes a leg-3
proposal). Leg 3's propose-only bound applies unchanged — this pass landed nothing.

## Already shipped — 10

Each names the mechanism at HEAD that already covers it. All verified by reading the file, not by
recalling that it exists.

| Suggestion | Mechanism at HEAD |
|---|---|
| "Shell & editing hazards": backticks command-substitute, heredoc mangling, `\| tail` masks the exit code, PowerShell here-strings in Bash | `.claude/hooks/shell-trap-guard.mjs` — covers `backtick`, `heredoc`, `here-string`, `masked suite`, `mktemp` as *blocking* PreToolUse rules. It fired on this very run's first `npm run check:… \| Select-Object -Last 20`. |
| "Try Hooks — formalize your guards in settings.json" | Already formalized: 12 hooks in `.claude/hooks/`, wired across `SessionStart` / `PreToolUse` / `PostToolUse` / `Stop` in `.claude/settings.json`, with reach reconciled as data by `npm run check:guard-reach`. |
| "Red-Green Discipline: every fix lands with a test shown failing first" | `.claude/skills/design-check/SKILL.md` (failing-test-first handoff) plus the standing convention in memory. |
| "Offload lanes: default to NIM/AGY/Codex, expect timeouts, cheapest model that satisfies the schema" | The offload lane + dispatch ladder in the global `CLAUDE.md`, and the `/llm-relay` skill that owns the routing mechanics. |
| "Automate the nightly review lap in headless mode" | This routine. `~/.claude/scheduled-tasks/nightly-maintenance/` has been running it locally; the suggestion describes what produced the report it appears in. |
| "Custom Skills — split /start-lap into composable skills" | `ship`, `start-lap`, `design-check`, `disambiguate-backlog`, `llm-relay` already exist as separate invocable skills. |
| "Task Agents — mandatory independent reviewer with authority to refuse" | `design-check`'s independent refutation pass, plus the loop-core review attestation the pre-commit gate enforces on loop-core paths. |
| "Verification before claiming done; re-run a failing suite in isolation" | The test-failure protocol in the global `CLAUDE.md` (rerun alone before calling it a regression; EBUSY/EPERM on Windows is flake-first), plus `closeout-challenge-gate.mjs`, which attaches mechanical evidence (unpushed commits, HANDOFF/backlog divergence, memory files missing from `MEMORY.md`). |
| "Triage the model tier before you triage the backlog" | P11's health contract (`12722548`): `scripts/shared/triage-backlog.mjs` resolves its model live from `llm-relay config get routing.pools`, runs one preflight call so a dead lane aborts at entry 0, and writes a coverage stamp. The *specific* remedy (pilot 3 entries against each candidate) is not shipped, but the failure mode it targets — a silent partial sweep behind a wrong alias — is now mechanically caught and reported as a number. |
| "Environment-hermetic pre-flight harness" | Substantially shipped as `.claude/hooks/session-start-guards.mjs`: missing `node_modules`, stale-main probe, stale `index.lock`/`shallow.lock`, idle-worktree reaping, and offload-lane liveness so a down proxy is a known constraint at lap start. The suggestion's shell-quoting canary is handled *preventively* by `shell-trap-guard.mjs` instead of detected after the fact. |

## Debatable — 6, escalated as observations

These are not refuted by anything at HEAD, but none carries a premise that can be pinned to a
quotable fragment of a tracked source file, so none can be written as an item in the answerable
queue — the queue's probes exist to make items auto-close off the *code* moving, and a behavioural
suggestion has no code side. They are recorded here rather than forced into a shape that would strand
them open forever.

1. **Scope control as a written rule** — "never sweep unrelated staged changes into a commit; report
   remaining count when pausing". Partially covered by the change-only-what-was-asked convention and
   the closeout gate; the staging half is not mechanically enforced.
2. **Explicit item budget per backlog lap** — "close exactly N, then report what's left". A framing
   change to how the owner opens a lap, not a tool change.
3. **Blast-radius call-site inventory before editing** — grep every producer and consumer of a
   contract before the first edit. Targets the top friction category (buggy_code, 75 sessions) but
   would be host discretion unless it became a gate, and a gate here has a large false-positive
   surface.
4. **Confidence ledger at closeout** — tag every claim PROVEN or ASSUMED with pasted output. The
   closeout gate already attaches mechanical evidence; a full ledger is a larger behavioural contract.
5. **Backlog swarm with worktree-isolated subagents and reviewer veto.** Worth noting precisely: the
   `tool-input-guard` denial of `isolation: "worktree"` is scoped to *audit-code / remediate-code
   dispatch nodes*, where the tool already creates the node's worktree. It does **not** refute
   worktree isolation for ordinary backlog work, so this suggestion is not already-decided-against —
   an easy and wrong call to make from the guard's existence alone.
6. **Autonomous release train with a pre-computed rollback commit.** `/ship` plus release CI already
   cover cut-and-publish; scheduling it unattended and pre-testing the rollback is a forward
   direction, not a correction.

## Genuinely open — 0

Nothing survived to become a leg-3 proposal. That is the expected shape of a report whose window
opens 2026-06-22: the guard and skill layers grew substantially inside it, so most of what the report
recommends had already landed by the time it was written.

## Standing observation about this signal

The report's own strongest lead — "buggy code was by far your most common friction, 75 sessions,
often surfacing only after review agents or CI caught it" — is a *measurement*, not a suggestion, and
it is the part of the pass worth keeping. The suggestions decay quickly against an active guard
layer; the friction counts measured from outside the sessions do not.
