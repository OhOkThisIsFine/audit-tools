# Insights-report triage — 2026-07-25

Source: `/insights` over 164 analyzed sessions (2026-06-22 → 2026-07-25), report at
`~/.claude/usage-data/report-2026-07-25-114058.html`.

Twelve suggestions. Verified each against HEAD rather than accepting it: **five were already shipped**
(the report reads a window that starts before the fix landed), **three are debatable** and are left for
the owner, **four were genuinely open** and are implemented in this pass.

The report's own top finding — defects that reintroduce a deliberately retired design — reproduced
inside the report itself: suggestion 1 recommends re-adding a retry policy for a failure mode whose
root cause was found and fixed on 2026-07-23. That is the strongest argument for the pre-implementation
gate this pass adds.

## Already shipped — no action

| Suggestion | Where it already lives |
|---|---|
| PreToolUse/PostToolUse hooks for shell + control-byte traps | 11 hooks in `.claude/hooks/`, wired in `.claude/settings.json`, contract-tested in `tests/shared/hook-trap-guards.test.mjs` |
| `\| tail` masks a suite exit code; PowerShell here-strings in Bash | Both already DENY rules in `shell-trap-guard.mjs` |
| "Create `npm run gates` so local and CI cannot diverge" | `verify:checks` is that script; `ci.yml:123` and `publish-package.yml:72` both invoke it, and `check:doc-manifest` — the gate that forced the v0.34.18 forward-bump — is inside it and inside the pre-commit hook |
| Red-green regression discipline; hermeticity rerun before calling a regression | Project memory (red-green, restore-by-inverting, test-must-reach-the-code) + the *Test failure protocol* in the global instructions |
| "Do not pin model ids / pre-build model combos" | *Never make us hand-maintain a model/price/limit table* and *Everything-agnostic by default* in `CLAUDE.md` |

## Debatable — escalated, and DECLINED by the owner (2026-07-25)

All three were put to the owner and declined; none is implemented, and none is open. The retirements
and standing decisions they would have overturned stand as written. Do not re-open these from the
report — the report is the stale side of each disagreement.

**1. Offload retry policy.** The report proposes: *"On `UND_ERR_HEADERS_TIMEOUT`, retry once with an
alias model, then fall back to the next lane."* This encodes a diagnosis that was disproved. The error
was the **caller's** transport — global `fetch` rides undici's default headers timeout while a large
model can take >5 min to first byte — and it was fixed on 2026-07-23 by moving `llm-call.mjs` to
`node:http` with a 30-min ceiling. Retrying with a different alias is exactly the wrong move that cost
three aliases before the real cause was found; it would train a model-switch reflex against a transport
bug. The serial-dispatch half of the same suggestion is already recorded (`durable-traps.md`, the
~2-concurrent rate-limit entry).

**2. "When you spot adjacent work, list it in the backlog and ask before doing it."** This conflicts
with two standing decisions: *end-of-sprint cleanup runs unprompted*, and *implementation
effort/complexity is NOT a cost — never pick a lighter half-measure*. The report's own evidence for it
is a scope-creep incident on a docs prompt, which is narrower than the rule it proposes. Tightening
this would trade a real, deliberate property for a symptom fix.

**3. A `## Shell Safety Rules` prose block in `CLAUDE.md`.** The rules are right, but the repo's policy
is that *a trap detectable at a tool call is refused there, and its backlog entry is deleted rather
than restated* — two copies decay independently. Of the four proposed lines, three are already DENY
rules; the fourth (backticks) is implemented below as a rule, not as prose. The heredoc ban is also
too broad: heredocs are the recommended fix for the here-string trap, and the guard deliberately treats
a heredoc body as data.

## Implemented in this pass

**Live-backtick DENY rule** (`shell-split.mjs` + `shell-trap-guard.mjs`). A backtick command-substitutes
everywhere except inside single quotes — *including inside double quotes*, which is where prose lives,
and is how a backlog file landed with command output spliced into its markdown. `stripQuoted` could not
be reused: it blanks both quote kinds, erasing the case that bites. `findLiveBackticks` tracks quote
state and reports substituting positions only. Escaped backticks, single-quoted backticks, heredoc
bodies, and PowerShell (where a backtick is the escape character) all stay allowed.
Override: `AUDIT_TOOLS_ALLOW_BACKTICKS=1`.

**Session-start environment preflight** (`session-start-guards.mjs`). Two probes added beside the
existing stale-main and `node_modules` checks:
- a stale `index.lock` / `shallow.lock` older than 60s, reported with the removal command but never
  removed (deleting a live git process's lock corrupts the index);
- offload-lane liveness against the LiteLLM proxy, so a down lane is a constraint known at lap start
  instead of a stall discovered mid-fan-out. The lane has no standalone fallback, which is what makes
  this worth ten seconds.

**`/design-check` skill** (`.claude/skills/design-check/SKILL.md`). The pre-implementation gate. The
report's largest friction bucket (53 `buggy_code`, 24 `wrong_approach`) is caught by adversarial review
that runs *after* the code exists, so every catch costs a rewrite. The skill runs the retirement-
collision check against `CLAUDE.md` standing decisions, `durable-traps.md`, `git log -S`, and the memory
index; delegates an independent refutation to the offload lane with a task-shaped schema; and exits with
a failing test rather than with code. It halts and surfaces on a retirement collision instead of arguing
it back in.

## Test evidence

Eight cases added to `tests/shared/hook-trap-guards.test.mjs`. Red-green validated without mutating the
working tree: the pre-change guard was extracted with `git show HEAD:...` into the scratchpad and run
against the blocking payloads — it allowed all of them (red), and the new rule blocks them (green).
