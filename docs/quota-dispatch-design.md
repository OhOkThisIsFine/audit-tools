# Quota & dispatch design (canonical conceptual spec)

The single source of truth for *who tracks which quota and why*. Per-provider
mechanics — including the Claude credential-resolution specifics (§0) — live in
[`cross-provider-quota-matrix.md`](../spec/cross-provider-quota-matrix.md). This doc is the
model that matrix implements.

## 1. The frame: conversation-first, inside a host IDE

This project runs as a **conversation inside a host IDE/agent** — Claude Desktop,
Codex Desktop, an IDE extension, etc. The conversational agent IS the orchestrator's
primary worker: it reads the rendered step, does the bounded unit, calls back. The CLI
is a backend/fallback, not the product.

Everything about quota follows from this: there is no central server with a god's-eye
view of all providers. There is **one running instance, hosted by one IDE**, and that
instance reasons only about the quota *it itself* consumes.

## 2. The rule: track exactly what this run touches — nothing else

> The conversational agent tracks **all** quotas it interacts with, and **only** those.

Concretely, the quota-tracking scope of a run is:

    { the host provider }  ∪  { each subagent dispatch-target provider actually used this run }

Two roles a provider can play in a run:

### Role A — Host provider (self). ALWAYS tracked. The primary.
The provider backing the IDE that runs the conversation:
- Claude Desktop → **Claude**
- Codex Desktop → **Codex / OpenAI (ChatGPT subscription)**
- (any future host) → its own backing provider

The host provider's quota gates the **whole run** — every step, including the act of
dispatching, spends the host's budget through the conversational agent. So it is tracked
"above all": if the host is out of quota, nothing proceeds. **Each supported host must
have a way to discover its OWN quota** (see §4). This is a hard requirement of adding a
host, not an afterthought.

### Role B — Dispatch-target providers (subagent backends). Tracked ONLY when used.
If — and only if — a run fans work out to subagents on *other* providers, those
providers' quotas must also be tracked, each as its own pool:
NVIDIA NIM, Claude CLI, Ollama (local), OpenRouter, vLLM / any openai-compatible
endpoint, etc. A provider that isn't dispatched to this run is never probed.

## 3. The red lines (what an IDE must NOT do)

- **An IDE never tracks another IDE's host quota.** Codex Desktop does not, and cannot,
  track Claude Desktop's quota — it never dispatches to it. Each IDE instance is
  self-contained with respect to *its own* host quota. There is no cross-IDE quota
  sharing, federation, or peeking.
- **Never automate another IDE's GUI** (no keystrokes/clicks/screenshots/computer-use).
  Dispatch targets are headless backends (CLIs, HTTP endpoints, local servers) only.
- **Self-monitoring only.** A run touches a provider's quota endpoint *only* for a
  provider it is the host of, or is actively dispatching to. No speculative or
  inventory probing of providers not in play.
- **Read-only credential use; never break the host's auth.** A quota probe reuses a
  provider's own credential read-only. The one allowed exception is refreshing the
  provider's OWN rotating credential when it would otherwise go dark — and only
  atomically under a lock (see the Claude credential note). Never refresh-and-rewrite a
  *third-party* provider's cred store from a probe.

## 4. How "each IDE tracks its own quota" works mechanically

Each provider — whether playing host or dispatch-target role — has a `QuotaSource`
that conforms to one contract:

    queryCurrentUsage(providerModelKey) → QuotaUsageSnapshot { remaining_pct (0–1), reset_at, … }

Signal preference, always: **proactive endpoint > reactive headers on a completion >
reactive dated-limit (429) error > local consumption estimate**. How that signal turns
into a dispatch decision — admission control over the shared quota ledger — is a separate
mechanism documented in [`dispatch-admission-control.md`](../spec/audit/dispatch-admission-control.md)
(which folds in the per-pool token-budget substrate this signal feeds); this doc stays
scoped to *who tracks which quota*, not how dispatch is admitted.

`buildQuotaSource` registers ALL known proactive sources in one composite, but this is
NOT "track everything" — it is the opposite. Each source **gates on the provider name**
(`handlesProvider`) and returns null with **zero I/O / zero credential reads** for a key
it doesn't own. The caller passes only the provider/model keys actually in play — the
host's key, plus each active dispatch target's key. So:

- A **Claude-host** run only ever probes Claude (and whatever targets it chose to use).
  It never touches Codex/Copilot/Gemini endpoints or creds.
- A **Codex-host** run only ever probes Codex (+ its chosen targets). Same property,
  different host. The identical registered composite "self-monitors whichever IDE hosts
  the run" purely because the caller only ever feeds it own-provider + active-target keys.

**Adding support for a new host = providing that host's own-quota tracking.** If a host
has a discoverable proactive own-quota endpoint, build a `QuotaSource` for it (Claude →
`oauth/usage`; Codex → `wham/usage`). If it has none, the host degrades to the **reactive
host-session source** (parse "you hit your session limit · resets …" from the worker
channel) — still own-quota, just lower-fidelity. Either way the host is tracked.

### 4a. Unsupported environment is LOUD, not silent — `quota_coverage`

The goal is progressively wider out-of-the-box coverage. Until a host provider is
wired, the orchestrator must **see** the gap rather than silently degrading to
reactive 429. Each host pool carries a `quota_coverage` status (in the dispatch-quota
contract's `capacity_pools[]`), classified from the pure no-creds capability check
(`QuotaSource.coversProvider`):

- **`established`** — a proactive source in code covers this provider (live-vs-missing-
  creds is the orthogonal `quota_signal_degraded` flag).
- **`reactive_only`** — the provider has no proactive surface BY NATURE (static API
  key / local model: NIM, vLLM, Ollama, worker-command, generic openai-compatible).
  Not a gap — reactive 429 is correct; no nudge.
- **`unestablished`** — no source covers this provider. The environment isn't supported
  yet.

On `unestablished`, the dispatch step prompt emits a **host-agent nudge, once per
environment** (per-provider marker in the artifact dir; terse status thereafter),
with two conversation-first paths: (1) if the host has built-in access to its own
usage, report it so the run can pace from it and it can be wired in; (2) else OFFER to
research the provider's quota endpoint / a third-party tool that solved it, and on the
user's consent report the findings (endpoint, credential location, response shape) so a
new `QuotaSource` is added — the progressive-coverage flywheel. `coverage.ts` and
`quotaCoverageNudge.ts` realize this, surfaced by `apiPool.ts` + both orchestrators'
dispatch prompts.

### 4b. Dev-side coverage routine (scheduled)

Coverage widens on two tracks: the runtime nudge above (driven by real unsupported
environments users hit) and a **scheduled dev agent** that proactively, on a regular
cadence: (1) scans online for additional providers worth supporting (IDEs / CLIs /
other), (2) researches how to read each candidate's quota (proactive endpoint, creds
location, response shape — the `cross-provider-quota-matrix.md` recipe form), and (3)
**re-verifies existing sources' methodologies** for drift or newly-exposed capabilities
(endpoints, headers, response fields change). Findings land as matrix/backlog updates
proposing new `QuotaSource`s or fixes to existing ones.

## 5. Quota is account-level — pools key on (provider, account), not provider alone

Quota is billed and reset **per account**, not per provider and not per surface. The
quota pool identity is therefore the pair **(provider, account)** — refined further by
model where a provider exposes per-model windows: **(provider, account, model)**. Two
runs/surfaces share a pool **iff** they resolve to the same `(provider, account)`.

### 5a. Same provider, SAME account → ONE pool
The common case. Claude Desktop (host) + Claude CLI subagents that are logged into the
*same* Claude account resolve to one `(claude, acct-A)` pool — a single `/usage` reading
governs both, and consumption on either surface draws down the same windows. Probing both
credentials would just return the same numbers; collapse to one source.

### 5b. Same provider, DIFFERENT accounts → TWO independent pools
If the host and a dispatch target are the same provider but **different accounts** — e.g.
Claude Desktop signed into account A while the Claude CLI used for subagents is signed into
account B — they are **two distinct pools**, `(claude, acct-A)` and `(claude, acct-B)`,
each with its own `/usage` reading, its own remaining-% and reset, sized and throttled
independently. They do **not** share budget: exhausting A's 5-hour window does not touch B,
and vice-versa. This is the intended way to get more aggregate Claude throughput — fan
subagents out to a second account's CLI — so the design must keep the two readings separate
rather than letting one credential's snapshot masquerade as both.

The key + resolution + stamping is realized across `providers/identity.ts` `quotaPoolKey`,
`httpQuotaSource.ts` `parseProviderModelKey`, `quotaSource.ts` `resolveAccountIdSafe`,
`apiPool.ts` `buildHostModelPools`/`buildSourcePool`, `accountId.ts` `deriveLocalAccountId`,
and `compositeQuotaSource.ts` `buildAccountScopedQuotaSource`:
- The quota key carries an **account discriminator**, not just provider/model. A bare
  `provider/model` key is only sufficient when there is exactly one account for that
  provider in the run; once a second same-provider account is a dispatch target, the
  account segment is mandatory so the two pools never alias.
- **Account identity is read from the credential, never guessed** — each provider's cred
  already carries it (Claude OAuth: the account/org on the token; Codex: `account_id` in
  `~/.codex/auth.json`; etc.). The host pool's account comes from the host credential; each
  target pool's from that target's credential. Same provider + equal account id → merge to
  one pool (§5a); differing ids → keep separate (§5b). Exception: `openai-compatible`
  bare-API-key sources have no credential to read identity from, so `accountId.ts`
  `deriveLocalAccountId` derives a LOCAL, credential-value-free id from `(endpoint,
  api_key_env)` instead — a third, deterministic mechanism that is neither "read from the
  credential" nor "guessed."
- The §4 self-gating still holds per pool: a source answers for `(provider, account)` it
  owns and is null-with-no-I/O otherwise — so account B's CLI source never probes account
  A's endpoint with A's token.

### 5c. Different providers → independent pools (always)
Claude host + NIM targets, Codex host + OpenRouter, etc. are independent pools by
construction (different providers, hence different `(provider, account)`), sized and
throttled separately, then combined into one dispatch-capacity figure.

## 6. Worked examples

| Host IDE | Dispatch targets this run | Quotas tracked |
|---|---|---|
| Claude Desktop | none (all work in-conversation) | Claude (host) only |
| Claude Desktop (acct A) | Claude CLI subagents (acct A) | Claude only — same account → ONE pool |
| Claude Desktop (acct A) | Claude CLI subagents (acct B) | TWO Claude pools — `(claude,A)` host + `(claude,B)` target, separate budgets |
| Claude Desktop | NVIDIA NIM + Ollama | Claude (host) + NIM (reactive) + Ollama (unbounded-local) |
| Codex Desktop | none | Codex (host) only |
| Codex Desktop | OpenRouter | Codex (host) + OpenRouter |
| Codex Desktop | — | NEVER Claude Desktop's quota |

## 7. Why it's built this way (rationale)

- **No central authority exists** in a conversation-first product, so quota reasoning
  must be local to the running instance. A run can only honestly account for budget it
  itself spends.
- **Self-monitoring is the safety boundary.** Probing only own + chosen-target providers
  keeps us off endpoints/creds we have no business touching, and makes the
  all-sources-registered composite safe (it's inert for unused providers).
- **Host-first because the host gates everything.** Even a run that offloads heavily to
  cheap subagents still pays host tokens per orchestration step; exhausting the host
  stops the run regardless of target headroom.

See also: [[quota-dispatch-vision]] (north star incl. heterogeneous simultaneous
dispatch), [[cross-provider-quota-matrix]].
