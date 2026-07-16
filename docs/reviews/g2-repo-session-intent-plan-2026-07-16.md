# G2 — split the persisted type into `RepoSessionIntent` (plan)

> Loop-core commit. Design of record: [`spec/unified-dispatch-worker-model.md`](../../spec/unified-dispatch-worker-model.md)
> → "Greenfield endpoint" + Decomposition G2. Owner steer (2026-07-16): **ideal code, backwards-compat
> doesn't matter** → the full atomic split, no compatibility shim, no broken intermediate. Builds on G1
> (`e7b593ac`, the single `--auditor <json>` `AuditorDescriptor`). Green-at-every-commit + independent
> review + attestation (touches `src/shared/loopCorePaths.ts` substrate).

> **REVISED after independent adversarial review (2026-07-16).** The review found two blockers in the
> first draft: (Q2) no deterministic component emits `sources[]` — the initial `--auditor` is hand-built by
> the host LLM from prose, so "the loader lifts it" named a component that does not exist, and an
> `AUDIT_TOOLS_SOURCES` env-file contradicts the design-of-record's mandated per-auditor home-dir
> identity-keyed `catalog-<auditor-id>.json` (spec:96-115); (Q4) "unrepresentable" was TS-write-only — the
> shared validator (`src/shared/validation/sessionConfig.ts:494-604`) still accepts dispatch fields and
> remediate reads the same JSON via `readValidatedSessionConfig`. Sections below are corrected; the one
> open sequencing fork (bundle the emitter into G2 vs seam-first per spec phasing) is at the end.

## Endpoint (what "done" means)

G2 delivers the **seam**: the persisted type the STORE reads/writes has **no dispatch INVENTORY fields**
(the 12 `DISPATCH_INVENTORY_FIELDS` + `dispatch.rolling_engine`), so persist-back of a resolved inventory is
unrepresentable. Every dispatch consumer reads an in-memory EFFECTIVE `SessionConfig` from
`resolve(intent, descriptor)`. **Honest scope caveat (review Q3):** `confirmed_provider_pool`, `quota`,
`block_quota`, `host_can_dispatch_subagents` are ALSO capability but are deferred to G3/G4/G5 — so after G2
the persisted type is a **half-type** (inventory removed, the other capability fields still present). The
"zero dispatch/capability fields" endpoint is reached only after G4/G5, NOT in G2. Do not claim it here.

```
RepoSessionIntent   // the ONLY thing the store reads/writes — audit intent + policy + budgeting
AuditorDescriptor   // rides every invocation (--auditor <json>): self{provider,…} + sources[]
EffectiveConfig     // = resolve(intent, descriptor) — in-memory only, SessionConfig-shaped, never persisted
```

## Scope boundary (what is G2 vs G3/G4)

G2 removes exactly the fields `applyDispatchInventory` already strips — the single-sourced
`DISPATCH_INVENTORY_FIELDS` (`provider`, `host_provider`, `subprocess_template`, `claude_code`, `codex`,
`opencode`, `openai_compatible`, `vscode_task`, `antigravity`, `agy`, `sources`, `parallel_workers`) **plus
`dispatch.rolling_engine`**. Making that strip *structural* is the endpoint of 2a-ii.

Deferred, left on the intent type for their own commits (they need the policy-vs-capability tease-apart):
- `confirmed_provider_pool` → **G3** (split into route-decision policy + re-resolved reach).
- `quota` / `block_quota` → **G4** (capability→descriptor, policy→intent, per-source quota→source).
- `host_can_dispatch_subagents` → capability, overlaps `descriptor.self.can_dispatch_subagents`; leave for
  **G5** (never-inherit enforcement) unless it falls out cleanly here. `agent_task_batch_size` = policy, stays.

The full nested `{audit, policy, budgeting}` reshape from the design panel sketch is the **G2+G3+G4
endpoint**; G2 delivers the flat intent type minus the dispatch inventory, not the nesting.

## Type design

1. **`SessionConfig` becomes the in-memory EFFECTIVE type** — unchanged shape; it retains the dispatch
   fields because it is what `resolve()` returns and what the ~110 downstream reads consume. No downstream
   read-site churn.
2. **`RepoSessionIntent`** (new, in `src/shared/types/sessionConfig.ts`) = `SessionConfig` minus the 12
   `DISPATCH_INVENTORY_FIELDS` minus `dispatch.rolling_engine` (keep the other `dispatch.*` intent fields).
   Express as a derived `Omit<…>` so the two can't drift, or a hand-listed interface with a compile-time
   `satisfies` cross-check against `DISPATCH_INVENTORY_FIELDS`. The store's read/write signatures accept
   **only** `RepoSessionIntent`.
3. **`AuditorSelf.provider?: ProviderName`** — fold the host/primary provider onto `self`. The descriptor's
   `inventory.provider` / `inventory.host_provider` collapse into `self.provider` (the conversation-host
   identity / quota-attribution key). Reslice the per-backend inventory blocks + `sources` into a uniform
   `sources: DispatchableSource[]` on the descriptor (the design's `self{…}+sources[]` shape). `resolve()`
   expands `sources[]` back into the effective `SessionConfig`'s per-backend fields for the unchanged
   downstream consumers.
4. **`resolve(intent: RepoSessionIntent, descriptor: AuditorDescriptor | null): SessionConfig`** replaces
   `applyDispatchInventory`. Since intent has no dispatch fields, `resolve` = spread intent + expand the
   descriptor's `self.provider` + `sources[]` into effective dispatch fields. **Null/absent descriptor fails
   closed to driver-self-only single-lane** (the driver is definitionally reachable) — NOT to a stored value
   (there is none). This is the deliberate behavior change from today's `applyDispatchInventory(cfg,null)⇒cfg`.

## Operator-source channel — the emitter must be DETERMINISTIC (review Q2, corrected)

Sources are per-auditor CAPABILITY (off-repo, ambient-verified) — so operator NIM/opencode declarations must
NOT persist on `RepoSessionIntent`. **The blocker the review found:** nothing turns an off-repo declaration
into `--auditor sources[]` today. The initial `--auditor` is hand-authored by the host LLM from the
slash-command prose (`skills/audit-code/audit-code.prompt.md:27-64` — describes only `self`). Two ways to
fill `sources[]`, and only one is allowed:

- ❌ **Host LLM reads the file + hand-assembles `sources[]`** — this is the BANNED host-discretion
  anti-pattern (`CLAUDE.md`: never rely on the host remembering/reasoning). The `declared ∩
  ambient-verifiable` reach intersection (never-inherit mechanism #3) CANNOT be tool-enforced by an LLM.
- ✅ **A deterministic emitter** audit-tools ships (a `audit-code`/wrapper subcommand the slash command
  shells out to BEFORE `next-step`, whose stdout is spliced into the `--auditor` arg): it reads the
  per-auditor declaration, performs the `declared ∩ ambient-verifiable` intersection (key env present /
  launcher on PATH / cred readable), and prints the `--auditor` JSON. A real deliverable, not a doc update.

**Channel = the spec's mandated shape, NOT an env-file (review Q2b).** The design-of-record explicitly
rejects env vars ("too rich/dynamic for flat scalars", spec:96-100) and mandates a **per-auditor home-dir,
identity-keyed `catalog-<auditor-id>.json`** — which is also what makes never-inherit mechanism #2
(auditor-id stamping) coherent. The first draft's `AUDIT_TOOLS_SOURCES` env-file recommendation is
WITHDRAWN. Use the home-dir identity-keyed declaration the spec names.

The rich auto-discovery catalog (query-all-providers → cost/quota → identity-keyed cache) is the follow-on
feeder the spec defers (spec:121-125); G2's emitter is the **minimum viable** declared-sources→verify→emit,
not the auto-query catalog.

## Migration surface (atomic — one replace)

- **Store** (`src/audit/supervisor/sessionConfig.ts`): `loadSessionConfig` / `mutateSessionConfigLocked` /
  `persistAnalyzerSettings` retype to `RepoSessionIntent`; validator swaps to `validateRepoSessionIntent`
  (intent fields only — the dispatch-field validation moves to descriptor validation).
- **Two overlay sites** become `resolve(intent, descriptor)`: `nextStepCommand.ts:317`,
  `semanticReviewStep.ts:107`.
- **Four non-overlaying `loadSessionConfig` sites** read dispatch fields WITHOUT overlaying today
  (`prepareDispatchCommand.ts:17`, `quotaCommand.ts:25`, `advanceAuditCommand.ts:29`, `dispatch.ts:226`) —
  route each through `resolve()` with the invocation's descriptor. (`nextStepCommand`/`semanticReviewStep`
  already overlay = the two overlay sites above; total six `loadSessionConfig` callers.)
- **Shared validator (review Q4 — REQUIRED for the invariant to be real):** `validateSessionConfig`
  (`src/shared/validation/sessionConfig.ts:494-604`) still accepts `provider`/`sources`/`openai_compatible`/
  backend blocks — so a hand-authored `session-config.json` with dispatch fields is still "valid" on disk and
  gets consumed. Add `validateRepoSessionIntent` (or a store-level reject) that REJECTS dispatch keys, and
  point the store at it. Without this, "unrepresentable" is TS-write-only, not a real guarantee.
- **Retire `persistHostProvider`** (`sessionConfig.ts:140`, call at `nextStepCommand.ts:251`): the
  host/primary provider rides `descriptor.self.provider`; `semanticReviewStep` resolves from the descriptor
  it is passed instead of re-reading disk → the disk-seam that motivated `persistHostProvider` is gone. Drop
  its concurrency test (`supervisor-remediation.test.mjs:396`).
- **`resolveHostDispatchProviderName` / `resolveHostProviderName` / `resolveConversationHostProvider`** read
  provider off the effective config / descriptor — mechanical retarget, signatures unchanged (they already
  take `SessionConfig`).
- **~110 downstream reads UNCHANGED** — they consume the effective `SessionConfig` from `resolve()`.
- **Remediate (review Q5 — silent auto-degrade, needs an explicit seam):** remediate has NO
  `loadSessionConfig` — it reads via `readValidatedSessionConfig` → `validateSessionConfig`
  (`plan.ts:537`, `contractPipeline.ts:1652`, `nextStep.ts:1789/3219/4132`) returning a full `SessionConfig`.
  So it COMPILES unchanged, but a disk-configured remediate NIM run silently degrades to `claude-code`
  self-only (`waveScheduling.ts:152` fallback on `provider=undefined`) once the validator rejects/strips
  dispatch fields. Give remediate an EXPLICIT `resolve(intent, null)` seam (not an invisible `undefined`),
  and BEFORE commit verify the disk-written-provider/sources tests: `nim-rolling-e2e`, `hybrid-nim-e2e`,
  `rolling-provider-dispatch`, `a8`, `providers` (most inject `options.sessionConfig` programmatically and
  pass; the risk is any that write `session-config.json` to disk and assert it honored). Also confirm
  remediate's C1 "persist the delta" path (`nextStep.ts:1806+`) doesn't write `provider`/`host_provider`
  back to its own `session-config.json` (untouched persist-back; full remediate round-trip is G6).

## Tests

- `tests/audit/host-descriptor-roundtrip.test.mjs` — add `self.provider` + `sources[]` reslice round-trip.
- Delete `supervisor-remediation.test.mjs` persistHostProvider concurrency test (seam retired).
- `tests/remediate/cli-host-capability-flags.test.ts` (drift guard) — retarget to assert no dispatch field
  is representable on the persisted type.
- New: `resolve(intent, null)` ⇒ driver-self-only; `resolve(intent, descriptor-with-sources)` ⇒ effective
  config with expanded per-backend fields; persisted `RepoSessionIntent` round-trips with zero dispatch
  fields (a written config can't carry `sources`/`provider`).
- Full-suite green (all three areas) before commit.

## Atomic-commit checklist

- [ ] `RepoSessionIntent` + `resolve()` + `self.provider`/`sources[]` reslice + operator-source lift +
      store retype + all consumer retargets + `persistHostProvider` retirement + tests — **one commit**.
- [ ] `npm run build && npm run check` green; touched suites green on a clean tree.
- [ ] Independent review (loop-core substrate) → attestation
      (`node .claude/hooks/attest-loop-core-review.mjs --reviewed-by <id> --checked "…"`).
- [ ] NO release (inert transport-shape change like G1 until host loaders emit inventory + the source
      declaration is documented); update HANDOFF launch recipe + `[[unified-dispatch-worker-model]]`.

## Sequencing — RESOLVED: Path A (owner, 2026-07-16)

**Path A chosen:** bundle the deterministic emitter into G2 as one atomic commit. Multi-pool never goes
dark. G2 = type-split + `resolve()` + validator/remediate enforcement + minimum-viable deterministic
source-emitter (home-dir identity-keyed declaration → `declared ∩ ambient-verifiable` → `--auditor
sources[]`) + slash-loader wiring, all green-at-every-commit + one attestation.

## THE open sequencing fork (owner call — gates commit shape) — see RESOLVED above

The review's Q2 exposes that deleting the working repo `sources`/`openai_compatible` channel WITHOUT a
deterministic emitter dark-pools operator multi-pool (NIM/opencode). The spec says "seam first, feeder
follows" (spec:121-125) — but that was written when the seam was the *additive* 2a-ii overlay; G2's deletion
makes the seam *subtractive*, so "seam first" now means "delete a working feature and ship the replacement
later." Two honest paths:

- **Path A — bundle the emitter into G2.** G2 = type-split + `resolve()` + validator/remediate enforcement +
  the deterministic minimum-viable source-emitter (home-dir identity-keyed declaration → ambient-verify →
  `--auditor sources[]`, spliced by the slash loader). Multi-pool NEVER goes dark; honors atomic-keep-working
  literally. Bigger commit, adds a new deliverable + slash-loader wiring.
- **Path B — seam-first per spec phasing.** G2 = type-split + `resolve()` + validator/remediate enforcement,
  fail-closed to driver-self-only; the deterministic emitter is the very next commit (G2.5). Matches the
  spec's stated phasing, smaller/cleaner commits — BUT operator multi-pool is temporarily unavailable
  between commits (self-only always works, so it's a capability regression, not a broken state), and the
  maximal-coverage live-validation recipe can't register NIM/opencode until G2.5.

Recommend **Path A** under the owner's "ideal code, effort-is-not-a-cost" steer + the atomic-replace
invariant (new mechanism + deletion in one commit). Path B is defensible only if the temporary multi-pool
regression is explicitly acceptable.

## Remaining sub-decisions (resolve in build, not blocking)

1. `host_can_dispatch_subagents` — fold to descriptor now or leave for G5 (lean: leave for G5; it's the
   never-inherit-enforcement commit and this field is capability like the others deferred there).
2. `RepoSessionIntent` as derived `Omit<…>` vs hand-listed interface + `satisfies` cross-check against
   `DISPATCH_INVENTORY_FIELDS` (lean: derived `Omit` so it cannot drift).
