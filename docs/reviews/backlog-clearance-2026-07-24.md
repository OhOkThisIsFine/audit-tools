# Backlog clearance lap — 2026-07-24

Working record for the "deal with everything we can from the backlog" lap. Base `eb48ae37`, v0.34.27,
CI green on both workflows at base.

## Entries CLOSED (each verified against HEAD, then deleted from `open-bugs.md`)

| Entry | Verified by |
|---|---|
| Offload lane's default schema unfit; needs `--schema` | `~/.claude/llm-call.mjs` parses `--schema <file\|json>` (argv loop, lines 13–18) and was used for every offload call this lap |
| Full vitest run exits 1 while reporting 0 failed | `scripts/shared/run-vitest-gate.mjs:73-90` appeals a nonzero exit to a fresh-token ledger via `isReporterTransportFault`; wired into `test`, `test:single`, `verify:guards`, `verify:release`, `test:doc-contract` and both CI workflows; tested in `tests/shared/vitest-gate-false-red.test.mjs` |
| `[analyzerDeps] npm install typescript@5.8.0 E404` | Refuted + fixed in `7c760461` — no test shells out to npm; it was a stub-log leak |
| `linux-cycle-regression.test.mjs` times out under load | `tests/audit/linux-cycle-regression.test.mjs:75` declares `HEAVY_AUDIT_TEST_TIMEOUT_MS` |
| `linux-cycle-regression.test.mjs` load-sensitivity (**duplicate** of the above) | same |
| Add `check:doc-manifest` to the pre-commit hook | `.claude/hooks/pre-commit-gate.mjs:387-408` runs it and blocks on failure |

Also **merged one duplicate pair**: the two `quota-command.test.mjs` hermeticity entries (2026-07-18 and
2026-07-21) described one defect; the surviving entry carries both properties.

## Fixes landed this lap

**1. `top_k` truncation is no longer a silent alphabetical cut** (`src/shared/providers/proxyCatalog.ts`).
With every `score` null the comparator's first term is `NaN` (`-Infinity - -Infinity`), so the sort
degenerated to `localeCompare` and `top_k` kept the alphabetically-first models — which once kept a
*flash* model and dropped every frontier one. The order stays deterministic (a content-derived array
order is an artifact invariant, so a different cut was the wrong fix); what changed is that every model
`top_k` discards now reaches the operator through the **same `dropped[]` channel** as an unreachable
model, stating which basis chose it: all-unranked (`ALPHABETICAL, not by capability`), all-ranked, or
partially ranked. `expandSources` returns `{sources, dropped}`; the populate path concatenates.
Tests: `tests/shared/proxy-catalog.test.mjs` — the pre-existing `expect(result.dropped).toEqual([])`
pinned the silent behaviour and was rewritten, plus two new cases (unranked, partially ranked). 27/27 green.

**2. `quota-command.test.mjs` no longer asserts on the real repo root** (`tests/audit/quota-command.test.mjs`).
The guard asserted `!existsSync(<repoRoot>/.audit-tools/audit/session-config.json)` — but a dogfood run
legitimately creates that file, so the test was a function of whether a self-audit had ever run in the
checkout. That false red once fanned out into 29 real dispatched deepening tasks (RTV-TST-001). It now
fingerprints the path (`mtimeMs:size`, or `absent`) **before** the command and asserts the fingerprint is
unchanged after — which is what the guard always meant: cmdQuota did not create or modify it.
⚠ Verification of this one was interrupted by a harness outage — see *Pending* below.

## Verified real, NOT yet fixed (mechanism confirmed at HEAD this lap)

- **Remediate node-claim leak — loop-core, the twin of FLW-COR-003.** Confirmed. `rollingSession.ts`
  claims at `:442`, releases at `:601-604`, and persists the session at `:623`. The stray-worktree
  `throw` at `:580` sits **between** the outcome record and the release, so that path frees nothing and
  never persists `accept_failed` — the claim then holds for the full 20-minute lease. A throw out of
  `acceptNodeWorktree` (`:547`) leaks identically. This is exactly the audit-side shape `fab36e0e`
  fixed ("the real leak was merge throwing before its own release").
  ⚠ **A blanket `try/finally` is the wrong fix** and would break the documented retry path: on a throw
  the session is never written, so a re-run re-reads the *stale* token from disk and the ownership
  heartbeat inside `acceptNodeWorktree` would fail against a released claim. The audit-side pattern —
  release at the moment the outcome becomes terminal, i.e. right after `recordNodeAcceptOutcome` and
  before the stray throw, with the session persisted first — is the shape to mirror. Needs independent
  review + attestation.
- **`withinRoot` duplication** is real but the entry's line refs have drifted. Only `src/audit/cli/dispatch/paths.ts:10`
  still defines the named symbol; `src/shared/providers/openAiCompatibleProvider.ts:849-850` reimplements
  the same `relative`/`startsWith("..")`/`isAbsolute` containment inline. The two **disagree**: one throws,
  the other returns `null`, and they differ on whether the root itself counts as within. Single-sourcing
  needs both a throwing and a nullable form, not a straight extraction.
- **`src/audit/quota/headerExtraction.ts` + `headerExtractors/` dead code** — confirmed: consumers are the
  `src/audit/quota/index.ts` re-export barrel and two test files only.

## Environment state (affects what "we can" means)

- **Codex dispatch is unavailable** — `codex exec` returns "You've hit your usage limit… try again at
  Jul 30th, 2026". Not a config problem; the lane is simply out of credits this lap.
- **agy works** headless (`agy -p "<prompt>" --model gemini-3.6-flash --effort low` → clean output), but
  remains prompt-inlined only (the `permissions.allow` entry is still open).
- **NIM/LiteLLM is healthy for small calls** (~10s round trip) but **unreliable for large analytical
  ones**: a 105KB three-file trace died with `ECONNRESET`, and two ~40KB / 48K-max-token classification
  calls ran past 28 minutes with no first byte. Chunking helps; the practical ceiling this lap was well
  under the documented 30-minute helper timeout.
- **Two harness limits hit:** the Bash tool caps `timeout` at 600000ms (a larger value is silently
  clamped, killing a background-worthy call at 10 minutes), and the command-safety classifier was
  intermittently unavailable, blocking all Bash/PowerShell for stretches.

## Pending / next

1. **Verify the `quota-command.test.mjs` change** — `npx vitest run tests/audit/quota-command.test.mjs`,
   then `npm run build && npm run check`. Edited during a classifier outage, so it is the one change in
   this lap that has not been run.
2. **Finish the triage of the remaining ~100 entries.** The mechanical partition is in
   `scratchpad/chunk{1..4}.md` (27 entries each, entry-aligned with line numbers). Every offload attempt
   at classifying them either timed out or was killed; the fallback is to read each chunk directly.
3. The three verified-real items above, in the order listed (the claim leak is the valuable one and the
   only loop-core one).
