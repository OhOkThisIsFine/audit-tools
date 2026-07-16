# G2.5 — deterministic source resolution (Path A feeder) — plan (v2)

Spec: [`spec/unified-dispatch-worker-model.md`](../../spec/unified-dispatch-worker-model.md) → Decomposition G2.5.
Predecessors: G1 (`e7b593ac`, `--auditor` descriptor), G2 (`59116fe2`, `RepoSessionIntent` type-split).

**v2 supersedes v1** after an independent adversarial review returned REWORK (all three load-bearing
choices refuted) and an owner discussion reframed the problem. v1's errors are recorded under
*Corrections* below rather than deleted — they are the reason the design changed.

## The problem, restated from the owner's framing

Dispatch subagents down every path the operator has resources for. Four paths, which fall into **two
buckets by WHO LAUNCHES**:

| Path | Launcher | Rides |
|---|---|---|
| Claude Desktop's own subagents | host | `self` |
| Subagents pretending to be Claude (repair-proxy redirects `ANTHROPIC_BASE_URL`) | host | `self` + `can_proxy` |
| CLI tools (codex / agy / opencode) | **audit-tools process** (subprocess) | `sources[]` |
| Local/remote LLMs (NIM / vLLM / LM Studio) | **audit-tools process** (HTTP POST) | `sources[]` |

The type system already encodes this: `DISPATCHABLE_SOURCE_PROVIDERS` excludes exactly
`claude-code`/`vscode-task`/`antigravity` because those "are driven through their host/IDE, not an
endpoint+parameters source" (`src/shared/types/auditorDescriptor.ts:52-58`). The boundary is **who
launches**, not cost tier or provider family.

Second requirement: everything-agnostic + parallelizable — Claude Desktop and Codex Desktop may drive
the SAME repo simultaneously with DIFFERENT reachable resources. The two must not contaminate.

## The cut

- **`self` = what only the host can know** — can_dispatch_subagents, `can_proxy`, roster, subagent
  ceiling, launch transports. No amount of tool-side probing discovers whether a host can redirect its
  subagents' harness. **Irreducibly handshake-reported** (`--auditor`, unchanged from G1).
- **`sources[]` = what the LAUNCHING PROCESS can verify about its own environment** — resolved
  **in-process**, never routed through the host.

### Why in-process (the correctness argument, not the cost one)

`openAiCompatibleProvider` reads its key from `this.env = deps.env ?? process.env` **at launch**
(`src/shared/providers/openAiCompatibleProvider.ts:117,132-136`). If the host reports "NIM reachable"
but the audit-tools process lacks `NVIDIA_API_KEY`, dispatch fails at launch and the run silently loses
a lane. Resolving in-process makes **the reach check and the launch read the same env object** — they
cannot disagree. A host relay opens a gap between what was promised and what is true at the moment of
use. Per CLAUDE.md *Auditor-agnostic robustness*, that gap is a latent failure mode to design out, not
to instruct the host around.

### Why this needs no auditor identity

The two-IDEs-at-once case works with **zero identity machinery**: each IDE spawns its own audit-tools
process, which inherits that IDE's env, so each intersects the same machine-level declaration against
its own real reach and gets its own answer. The declaration is a **machine-level** operator fact ("these
are the backends I own"); what differs per-auditor is ambient reach, computed live per-process. Nothing
is shared, so nothing can contaminate.

⇒ **No `auditor_id` in G2.5**, and no `catalog-<auditor-id>.json`. The id remains needed for G5's
never-inherit STAMP on transient run-state (where it is actually enforced) and, later, for caching the
expensive rich-catalog population. Deriving it here would bake a premise into a filename for no benefit.

### Verified: no host-exclusive credential case exists

The whole shell-out shape only earns its keep if the host can reach a dispatchable backend the child
cannot. Traced; it cannot:

| Provider | Credential at launch | Child-readable? |
|---|---|---|
| `openai-compatible` | inline `api_key` or `process.env[api_key_env]` (`openAiCompatibleProvider.ts:132`) | yes |
| `codex` / `opencode` / `agy` | none passed — CLI self-authenticates from its own home-dir file | yes |
| `worker-command` | none — inherits parent env | yes |
| `subprocess-template` | inline config `env` map | yes |

`stripClaudeCodeEnv` (`src/shared/tooling/exec.ts:306-316`) strips only `CLAUDECODE` + `/^CLAUDE_CODE/`
— cannot break any of the six. Repo-wide grep for keychain / SecretStorage / CredentialManager /
libsecret: **two comments, zero implementation**; `copilotQuotaSource.ts:18-32` explicitly documents
routing AROUND VS Code's encrypted store. Copilot + Antigravity — the two that touch host-exclusive
stores — are both excluded from `DISPATCHABLE_SOURCE_PROVIDERS` by design.

## Deviation from the approved spec (recorded, not silent)

The spec's G2.5 is "a subcommand the slash loader shells out to BEFORE `next-step`", printing `sources[]`
for the host to merge into `--auditor`. **This plan does not build that**, for two reasons the spec
predates:

1. **The host merge is the banned anti-pattern in a new costume.** An LLM hand-composing `{self, sources}`
   JSON is exactly the host-discretion the commit exists to kill. A fumbled merge → empty `sources[]` →
   fail-closed to driver-self-only → **zero dispatch**: the 2026-07-15 dogfood failure (430 planned, 0
   dispatched) reintroduced one layer up, and silently — an empty `sources[]` is indistinguishable from a
   legitimately-unreachable machine.
2. **The spec conflates POPULATE with RESOLVE.** *Populate* (query models.dev / live quota / repair-proxy
   `/registry` → the rich catalog) is expensive, network-bound, and genuinely wants to be an occasional
   separate step behind a cache — that is what the spec's "speed optimization behind the handshake" is
   for. *Resolve* (intersect declaration with right-now ambient reach) is local, cheap, and must run at
   the moment of use to be correct. Bundling them forces resolve onto populate's schedule and out through
   the host.

**G2.5 builds RESOLVE only.** POPULATE stays the named seam for the rich feeder — it can land later as a
subcommand writing the cache, and resolve reads it identically. The spec's G2.5 bullet + rationale are
amended in this commit to record the populate/resolve split.

## Design

### Ambient-verifiability rule (per declaration shape)

| Declaration asserts | Verified when |
|---|---|
| `api_key_env` | env var present AND non-empty |
| CLI provider (`codex` / `opencode` / `agy`) | launcher on PATH — reuse `CLI_PROBES` + `commandExists` |
| `credentials_path` | file readable |
| **inline `api_key`** | **NOT verifiable → dropped** (see below) |
| none of the above | not verified → dropped |

Unverified ⇒ dropped **with a recorded reason**. `declared ∩ ambient`, never `declared ∪ stored`.

**Inline `api_key` is dropped (owner-decided).** v1 called it "reachable-by-construction"; the reviewer
correctly refuted that — possessing a credential proves nothing about *reach*, and the spec's rule is
"a declared lane enters a pool only if this process **proves reach**." It is also the one shape an
operator can always choose, so admitting it makes the whole rule opt-out by construction. Worse, it is
an always-passes lane whose only catcher — the reactive `lies reachably` quarantine — is G5, not yet
built: a stale free-tier declaration would be emitted as reachable, and cost-first routing (λ=0) sends
*every* packet to a free pool first. A public constant lives in an env var fine.

⚠ This introduces the repo's **first ambient credential probe**, deliberately inverting the stated policy
at `providerFactory.ts:46-50` ("env presence is intentionally not probed here"). That policy governs
*launch-time resolution*; this is *reach declaration*. Called out, and the factory comment gets a pointer
so the two don't read as a contradiction.

### Placement

- `src/shared/providers/auditorSources.ts` — pure core: `readSourceDeclaration`, `verifySourceReach`,
  `resolveAmbientSources`. Sits on the reuse it needs (`providerConfirmation.CLI_PROBES`,
  `providerPathGuard.commandExists`). **Justified by cohesion**, not by gate position.
- Wired into `resolveSessionConfig(intent, descriptor)` (`src/shared/config/`) — the existing seam every
  consumer already reads. Effective `sources` = `descriptor.sources ?? resolveAmbientSources(env)`; an
  explicit hand-authored `--auditor sources[]` still wins (the escape hatch stays).
- Not loop-core per `src/shared/loopCorePaths.ts` (verified: `src/shared/providers/` and
  `src/shared/config/` are absent from `LOOP_CORE_PATTERNS`) ⇒ no attestation. It would become loop-core
  if placed under `src/shared/quota/`; it is not, because the reuse lives in `providers/`.

### Declaration file

`~/.audit-code/sources-declared.json`, shape `{ "sources": DispatchableSource[] }`. Machine-level, not
id-keyed. Named `sources-declared.json` — **not** `catalog-<id>.json`, which the spec reserves for the
populate cache; squatting that name would make a later `readDeclaration` a direct cache read and violate
never-inherit by filename collision.

`~/.audit-code/` is the established precedent (`src/audit/cli.ts:63` already puts quota state there).
Absent / malformed → **empty**, never a throw (two-tier dependency policy: degrade, don't fail).

A **declaration is not a cache**: operator intent (like `session-config.json`), not a prior auditor's
resolved state. Reading it and intersecting with live ambient reach does not violate never-inherit.

### Field validation (the validator is weaker than v1 claimed)

`validateDispatchableSources` (`src/shared/validation/sessionConfig.ts:126-160`) checks **only**
`provider ∈ DISPATCHABLE_SOURCE_PROVIDERS` and `quota` shape. `endpoint` / `model` / `api_key_env` /
`api_key` / `id` are **entirely unvalidated**. So `{"api_key_env": {"a":1}}` passes today, and a naive
`process.env[{...}]` coerces to `"[object Object]"` → nonsense.

⇒ **Strengthen `validateDispatchableSources` once, in shared** (string-or-absent for `endpoint` / `model`
/ `api_key_env` / `api_key` / `id`). Both boundaries — disk-load and the `getAuditorDescriptor` parse
boundary — gain it for free. Fixing it in the emitter only would leave the hand-authored `--auditor`
path unguarded.

## Migration (this commit owes it)

`examples/session-config/opencode-free.json` is **already dead** — it carries `provider` + `sources`,
both in `DISPATCH_INVENTORY_FIELDS`, so G2's `validateRepoSessionIntent` rejects it at load. v1 cited it
as live precedent; it is a G2 leftover. Move → `examples/catalog/sources-declared.json`, rewritten to
`api_key_env` (per the inline-key rule) and dropping the `provider` key. That is both G2's owed cleanup
and this plan's worked example.

The HANDOFF's maximal-coverage launch recipe references it → update in the same commit.

## Tests

- Reach rule — one case per shape: `api_key_env` present / present-but-empty / absent; CLI on PATH /
  off PATH; `credentials_path` readable / not; inline `api_key` → dropped-with-reason; no assertion →
  dropped. `setCommandExistsForTesting` for PATH probes (process-global → restore in `finally`).
- Declaration read — absent / malformed / valid → empty, empty, parsed.
- `resolveSessionConfig` — ambient sources fold in; explicit `descriptor.sources` still wins; empty
  declaration ⇒ byte-identical to today (the inert-window guarantee).
- Validator — the new string-or-absent rejections, at BOTH boundaries.
- Two-env isolation — same declaration + two different env objects ⇒ two different resolved pools (the
  multi-IDE property, tested directly rather than assumed).

## Out of scope (named, not silently dropped)

- **POPULATE** — the rich catalog (query-all-providers → capability/quota/cost → cache). The spec's
  explicit follow-on feeder; lands behind the same resolve seam.
- **G5** — the `auditor_id` stamp on transient run-state + the reactive `lies-reachably` quarantine.
  G2.5 deliberately derives no id.
- **repair-proxy as a kind-1 launch transport** — commit 3. It is a transport for HOST-launched
  subagents (`self.can_proxy`), not a tool-spawned pool, so it is orthogonal to `sources[]`.
- **Declaration authoring UX** — no `init` subcommand; hand-authored, like `session-config.json`.
- **remediate registration** — the core is in `src/shared/`, so remediate picks it up via
  `resolveSessionConfig`; no separate wiring. G6 owns the descriptor round-trip.

## Corrections to v1 (why the design changed)

1. **`auditor_id` derivation rested on a false premise.** v1: "two IDEs on one box → different host
   provider → different id." `resolveConversationHostProvider` (`providerPathGuard.ts:130-143`)
   discriminates only codex / claude-code / agy and **defaults to `claude-code`** — Claude Desktop, VS
   Code, Cursor and Antigravity all collapse to one id. G5 keys never-inherit on this id, so a coarse id
   would make G5's check silently never fire. v2 needs no id at all.
2. **The `sources[]`-only output contract handed composition back to an LLM** — the banned anti-pattern
   in a new costume. v2 never routes sources through the host.
3. **Inline `api_key` "reachable-by-construction" was a lie with no catcher** (see above).
4. **"Emitted sources cannot fail `getAuditorDescriptor`" was overstated** — the validator checks two
   fields. v2 strengthens it.
5. **`opencode-free.json` was cited as live precedent; G2 had already made it unloadable.** v2 migrates it.
6. **"None of `sources[]` is host-launched" ignored the repair-proxy path** — a host-launched subagent
   with a non-Claude backend. True that it doesn't move `sources[]` (it's a transport on `self`), but the
   reasoning was wrong and it is why the handshake must exist at all.
