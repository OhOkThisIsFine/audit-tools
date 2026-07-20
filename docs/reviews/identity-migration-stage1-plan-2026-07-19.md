# Backend-identity migration — stage 1 plan and classification (2026-07-19)

Dated plan artifact for stage 1 of the migration in `docs/backlog.md` → *Forward tracks*
("Backend-identity axes"). Design of record: [`spec/backend-identity-axes.md`](../../spec/backend-identity-axes.md).
Durable direction lives in the spec + backlog; this is a one-off record of what stage 1 touches
and what was verified before touching it.

Stage 1 is: `DispatchableSource.provider` → `transport`, `backend_provider` → `service`, and
normalize `service = declared ?? transport` once at the source-gather chokepoint.

## What was verified before starting

A classification pass over every read site, with two claims it could not settle offloaded to the
LiteLLM/NIM lane and then re-verified against source here. Three results changed the plan.

### 1. The chokepoint is sound, but the wrapper is the wrong place to normalize

`gatherDispatchableSources` (`src/shared/quota/apiPool.ts:555`) is a two-line async wrapper; the
real work is `collectDispatchableSources` (`:519`). **Both are exported** (`src/shared/index.ts:1135-1136`),
so a caller can reach the inner one and skip the wrapper — today only tests do, but a public export
that bypasses an invariant is the latent failure mode the *Auditor-agnostic robustness* rule names.

→ **Normalize inside `collectDispatchableSources`.** Costs nothing, closes the hole.

All six `DispatchableSource` construction paths were traced and **none bypasses the chokepoint**
(declared `sources[]`, `primaryInProcessSource`, `openAiCompatibleSource`, `expandProxyCatalogSources`,
`resolveAmbientSources`/`readSourceDeclaration`, and the `--auditor` descriptor). The normalization
is sound.

### 2. ⚠ The subtlest hazard: normalization silently kills a branch in `dispatchableSourceId`

`src/shared/quota/apiPool.ts:43-63` reads:

```ts
if (source.backend_provider) { return buildProviderModelKey(source.backend_provider, …); }
if (source.id) return account ? `${source.id}#${account}` : source.id;
return buildProviderModelKey(source.provider, …);
```

Once `service` is always populated, the first branch is **always taken** — so the explicit
`source.id` branch and the transport branch become unreachable. An operator-declared `source.id`
currently wins for a source with no declared backend, and after normalization it never would.
`source.id` is documented in the spec as *an operator OVERRIDE, not an axis* — silently retiring it
inside a rename would be exactly the "one defect, two faces" pattern the spec's opening section warns
about.

→ **Gate on the RAW DECLARED service, not the normalized one.** This is the single place where
stage 1's normalization is not behavior-preserving, and it must be handled deliberately.

### 3. Price binds to service — real, but currently INERT (this corrects the backlog entry)

`providerConfirmation.ts:427` and `:460` passed `source.provider` (transport) into the price lookup.
Per the spec's table, cost binds to *model, disambiguated by service*. `resolveModelStatics`
(`src/shared/quota/modelStatics.ts:139-149`) looks up `snapshot.byProvider[provider]` and, on a miss,
falls through to the flat default table — documented as the *cheapest-collision* entry. So a proxied
lane (`transport: claude-worker`, `service: nim`) was scoped to a provider string the table has never
heard of.

**But the vendored snapshot carries no provider index at all.** `src/shared/data/model-statics.generated.json`
has 2630 model entries and **no `__by_provider` key**. The generator (`scripts/shared/update-models.mjs:160-162`)
emits that index *only when a cross-provider collision actually populated it*, and the current
snapshot records zero. With no provider tables, `resolveModelStatics` returns the same default entry
for **every** provider string — so transport-vs-service makes no observable difference to any price
at HEAD.

→ The fix is **correct-axis, zero-behavior-change today**, and becomes load-bearing the moment the
snapshot gains a provider index. `docs/backlog.md` and the spec both describe this as "a live defect";
that is **overstated at HEAD** and is corrected here.

→ **Consequence for testing:** no red-green regression test is available without a snapshot-injection
seam, because the defect cannot be made to fail with the real snapshot. A test written anyway would
be decorative. Landed without one, deliberately, and recorded as such.

→ **New lead (not chased here):** a 2630-model snapshot with *zero* cross-provider collisions is
surprising — `claude-sonnet-4`-class ids appear on multiple vendors upstream. Either the collision
detection in the generator is not firing, or models.dev's shape changed under it. Logged to backlog;
this is a lead, not a verdict.

### 4. Two claims offloaded to the NIM lane, both re-verified here

| Claim | Verdict | Mechanism |
|---|---|---|
| **`accountId.ts:68` namespaces the explicit-account key on TRANSPORT**, so one vendor credential under two transports splits into two budget partitions (`claude-worker#work` vs `openai-compatible#work`) | **CONFIRMED** (both passes; verified by reading, *not* by execution) | `deriveAccountKey` takes the `if (source.account)` branch first and splices `source.provider` in unconditionally. The derived branch (`deriveCredentialIdentity`) is endpoint+credential-keyed and carries no transport, so it is genuinely immune — the asymmetry between the two branches is itself the smell. |
| **`CapacityPool.providerName` is the transport but reaches `resolveLimits`**, where rate limits are a service question | **REFUTED as a behavior defect** | `resolveLimits` (`src/shared/quota/limits.ts:184-190`) ends `const providerType = hostClassFor(providerName); if (providerType !== "unknown") return { limits: defaults, source: "provider_default" … }; return { limits: defaults, source: "default" … }`. **Both arms return the same `defaults` object** — `providerName` selects only a provenance *label*, never a limit value. No vendor's limits can be misattributed to another. |

The second result is why `CapacityPool` does **not** need to carry both axes for stage 1 or stage 2.
The NIM lane's first pass answered REFUTED for the wrong reason (it had not been given `limits.ts`);
given the file it reversed to INDETERMINATE with the correct mechanism, and the final verdict above
was settled by reading the file directly. Offload output is advisory — this is a worked example of
why ([[offload-lane-failures-are-usually-the-caller]]).

### 5. The spec's claim about `gate0-proxy-fold.test.mjs` is imprecise

The spec (and `docs/HANDOFF.md`) say two adjacent tests there "assert opposite verdicts on the same
mechanism." All six tests were read: **there is no contradiction.** What is there is a deliberate,
documented two-axis split — each test binds the *same source* to *both* axes, asserting
`key === "${service}:${model}"` and `exclusion_pattern === "claude-worker:${model}"` a few lines
apart. Two adjacent *assertions* bind opposite axes; two adjacent *tests* do not disagree. That is
"co-locate and name, do not unify" working as designed, and it is an argument *for* stage 1: after
the rename those assertions read as `service:model` key vs `transport:model` rule.

## Commit split

1. ✅ **BEHAVIOR (landed)** — `providerConfirmation.ts:427,460` price against `sourceService(source)`.
   Zero behavior change at HEAD per §3; no regression test, deliberately.
2. **BEHAVIOR** — `accountId.ts:68` keys the account namespace on service. **Gate on execution
   first:** build pools for `{claude-worker, nim, account:"work"}` and `{openai-compatible, nim,
   account:"work"}` and assert `accountKey` equality. Drop the commit if it does not reproduce.
3. **RENAME** — the two fields + 8 structural mirrors + validator + `ClaudeWorkerConfig`, atomically.
   Gated on the open decision below.
4. **NORMALIZE** — inside `collectDispatchableSources`; simplify the three dead `??` sites; **preserve
   `dispatchableSourceId`'s explicit-`id` branch** per §2.
5. **MIGRATE** — persisted artifacts, one-shot, no dual parser.

### The 8 structural mirrors (compile-time breakage, must move with commit 3)

`ExcludableBackend` (`sharedProviderConfirmation.ts:156`) · `sourceService` param
(`providerConfirmation.ts:255`) · `deriveAccountKey` param (`accountId.ts:61`) ·
`deriveLocalAccountId` param (`accountId.ts:101`) · `buildAccountScopedQuotaSource` param
(`compositeQuotaSource.ts:154`) · `deriveWorkerKind` param (`sessionConfig.ts:352`) ·
`sourceByPoolId` param (`apiPool.ts:297`) · `SourcePoolDisplayEntry.provider`
(`providerConfirmation.ts:512`).

`ExcludableBackend` is the sharpest: rename one side only and `apiPool.ts:601` fails to typecheck —
which is the *good* outcome.

### Three `??` sites that go dead under normalization, two that must stay

Dead → simplify: `apiPool.ts:98`, `providerConfirmation.ts:259` (keep the *function*, it is the
spec's named projection), `sharedProviderConfirmation.ts:651`.
Must stay: `auditorSources.ts:613` and `:616` — both inside `resolveProxyLane`, which runs
**upstream** of the chokepoint. So "service is never optional downstream" is true only *downstream of
the gather*, and the field's doc comment should say exactly that.

## ⚠ Open decision — the persisted-artifact blast radius (commit 3 is gated on this)

`SourcePoolCostEntry` (`src/shared/types/providerConfirmation.ts:143-176`) carries `provider` +
`backend_provider` and is **persisted** to `<root>/.audit-tools/provider-confirmation.json` — the
operator's confirmation decisions. `confirmedBackendKeys` (`sharedProviderConfirmation.ts:561`)
rebuilds the gate key from `entry.backend_provider ?? entry.provider`.

Rename the reader without migrating old files and every previously-confirmed source stops matching →
it deltas → the operator confirms → it still does not match → **the exact v0.33.11 livelock the spec's
opening section describes.**

Four other persisted artifacts also carry the names: `~/.audit-code/sources-declared.json`
(operator-authored), `~/.audit-code/catalog-cache.json` (tool-written, regenerable — cheapest to
degrade-to-absent), `session-config.json` `sources[]` (operator-authored), and
`examples/catalog/sources-declared.json` (repo example, pinned by a test).

There is **no zod or JSON Schema** mirroring `DispatchableSource` — validation is entirely the
hand-written `src/shared/validation/sessionConfig.ts`. That meaningfully shrinks the surface.
