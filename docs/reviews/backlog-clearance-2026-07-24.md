# Backlog clearance lap — 2026-07-24

Working record. Base `eb48ae37`, v0.34.27, CI green on both workflows at base.

## Triage of the whole file

All 101 entries were classified by the free NIM roster, **one entry per call**. Batching 27 entries
into one call failed every time (`ECONNRESET`, or 28+ minutes with no first byte); a single entry is
1–3KB and returns in ~10s, so the reliable unit is one entry per request, pooled six-wide across
`glm-5.2` / `deepseek-v4-pro` / `minimax-m3` / `qwen3.5-397b` / `deepseek-v4-flash` /
`nemotron-3-super-120b` with retry across a DIFFERENT alias on failure. Runner:
`scratchpad/nim-triage.mjs`. First pass returned 101/101 failures — the proxy had died; see the
friction entry. Second pass: 94/101, the 7 misses all `finish_reason=length` at `max_tokens: 1200`,
which a re-run at 4000 cleared.

Rough shape: ~44 actionable, ~24 owner-decision, ~20 accepted-residual-or-lesson, ~14 live/env-blocked.
The classification is a LEAD, not a verdict — every entry acted on below was re-verified against HEAD
first, and two were verified and then rejected.

## Landed

**1. `top_k` truncation is no longer a silent alphabetical cut** (`d52948cd`,
`src/shared/providers/proxyCatalog.ts`). With every `score` null the comparator's first term is `NaN`
(`-Infinity - -Infinity`), so the sort degenerated to `localeCompare` and `top_k` kept the
alphabetically-first models — which once kept a *flash* model and dropped every frontier one. The order
is deliberately unchanged (a content-derived array order is an artifact invariant); what changed is that
every model `top_k` discards now reaches the operator through the same `dropped[]` channel as an
unreachable model, naming which basis chose it.

**2. `quota-command.test.mjs` stopped asserting on the real repo root** (`d52948cd`). It asserted
`!existsSync(<repoRoot>/.audit-tools/audit/session-config.json)`, but a dogfood run legitimately creates
that file, so the test was a function of whether a self-audit had ever run in the checkout — a false red
that once fanned out into 29 dispatched deepening tasks (RTV-TST-001). Now fingerprints the path before
the command and asserts it unchanged after. Red-green validated by inverting a mid-run write mutation.

**3. Docs-only pushes no longer skip the test suite** (`548380df`). `audit-code-test-suite.yml` did not
trigger on `docs/**` or `spec/**`, but the suite INSPECTS both. The backlog proposed hand-listing the
doc-derived tests into the cheap chain; widening the TRIGGER is preferred because a curated list decays
invisibly the moment someone adds a test that reads a doc, and `ci.yml` already states the governing rule.
This is also what made the suite run on the pricing commit at all — i.e. it caught the revert below.

**4. Per-invocation fixture roots are enforced, not just performed** (`d71f6815`). The 605fe61e migration
moved 53 sites onto `scratchDir()`; two had survived it, one hidden by the `.gitignore` stopgap and one
found only when the new guard first ran. `INV-shared-tests-08` now scans the test tree for a fixture dir
anchored at the test file's own location. Its regex is assembled from two fragments because, spelled out
whole, the file would match its own guard — and self-exempting a lint is how a lint starts lying.

**5. The header-extraction island is deleted** (`3d199269`, −612 lines). Six exported symbols, zero
production consumers; only the quota barrel and two tests referenced them — the tested-but-unwired class
default-mode knip cannot catch, because it counts the barrel export as a consumer. Three independent
adversaries re-checked it; one simulated the whole deletion in a scratch `git archive` of HEAD and ran
tsc, knip and the affected suites before agreeing.

## Attempted and REVERTED — the one that matters

**Regenerating the price snapshot inverts host tier cost order** (`548380df` → `6df9100e`).

`model-statics.generated.json` predates `__by_provider`, so provider-scoped price lookups were inert and
fell through to the flat table. Regenerating populates the index (2794 models, 2945 collisions, 146
providers) and does fix the scoped path — but it also rewrites the flat table, whose entry for a
colliding id is the CHEAPEST across providers by construction:

| model | flat (no provider) | `anthropic`-scoped |
|---|---|---|
| `claude-haiku-4-5` | 2.00 | 2.00 |
| `claude-sonnet-5` | 2.88 | 4.00 |
| `claude-opus-4-8` | **0.85** | 10.00 |

A refreshed snapshot ranks **opus cheapest in the roster, below haiku**, and cost-first routing at λ=0
would send every packet to it. `cost-rank.test.mjs` went red with 11 failures on CI shard 1, both Node
versions. The stale snapshot looked correct only by accident — the pre-collision `flatten()` happened to
keep anthropic's own prices.

The lesson is an ordering correction to the backlog entry, which said to settle the second-order mismatch
*after* refreshing: `byProvider` is keyed by models.dev VENDOR ids while both pricing sites pass
`sourceService(source)`, so any lane whose service string is not a models.dev provider id misses the index
and lands on the cheapest-reseller price. **The mapping is a prerequisite, not a follow-up.** Entry
reopened carrying the measured table and an explicit warning not to "fix" it by editing the cost-rank
expectations — those encode real list prices and are what caught it.

## Verified real, NOT fixed — each blocked on a specific finding

- **Remediate node-claim leak (loop-core).** Confirmed: `rollingSession.ts` claims at `:442`, releases at
  `:601-604`, persists at `:623`, and the stray-worktree `throw` at `:580` sits between the outcome record
  and the release. Adversarial review corrected TWO of this lap's own premises: the lease is 30s
  (`STALE_LOCK_MS`), not the audit side's 20 minutes; and the claimed blocker — that releasing would break
  the `reverify-node` retry via the ownership heartbeat — is FALSE, because `reverifyQuarantinedNode`
  passes no `ownership` at all (`rollingSession.ts:790-792`, "a quarantine re-drive takes NO claim
  anywhere"). The real consequence is worse than a stall: `writeSessionFile` never runs on that throw, so
  `terminal` never counts the node and `inFlight` stays ≥1 — a permanent hang.
  ⚠ The obvious fix is ALSO wrong: routing a stray into `accept_failed` makes the host directive
  (`nextStep.ts:2264-2269`) assert a falsehood — it promises the work is "preserved under a quarantine
  ref" and names `reverify-node`, but a stray never committed, so no ref exists and the command returns
  `no_quarantine`. That converts a hard stop into a confidently-wrong instruction. The stray needs its own
  terminal class carrying its diagnostic, plus a pinned intra-block order. Full correction in the workflow
  journal.
- **`withinRoot` duplication.** Six sites, not five; the entry's line numbers have drifted. Plan drew a
  FATAL objection — do not apply as designed.
- **Keyless `openai-compatible` endpoints.** Coupled to the endpoint-probe SPEC, not independent: an
  operator-choosable `no_auth: true` with no probe re-opens the always-passes hole that the inline
  `api_key` refusal exists to close. Ship the two together.

## Environment

- **Codex dispatch unavailable** — usage limit, resets Jul 30. Not a config problem.
- **agy** works headless, prompt-inlined only.
- **NIM** is excellent per-entry, unreliable in bulk. The proxy died mid-lap and had to be restarted
  (`PYTHONIOENCODING=utf-8 litellm --config ~/.audit-code/litellm-config.yaml --port 4000`).
- Two harness limits: the Bash tool silently clamps `timeout` to 600000ms, and the command-safety
  classifier was unavailable for stretches, blocking all shell use.

## Next

1. The remediate claim leak, using the adversary's corrected design (loop-core → attestation).
2. The service→vendor-id mapping, which unblocks the price refresh.
3. The remaining actionable queue in `open-bugs.md`.
