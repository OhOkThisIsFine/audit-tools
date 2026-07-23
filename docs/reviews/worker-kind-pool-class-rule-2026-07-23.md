# Worker-kind × pool-class compatibility rule (burst-limited lanes) — 2026-07-23

Closes the backlog HIGH-adjacent routing defect from the 2026-07-22 re-dogfood: the agentic
claude-worker lane proxied onto NIM `glm-5.2` stormed the per-model burst limiter to 136→143
consecutive 429s, cooling the pool for every consumer. Dispatch pacing is structurally blind to the
storm — the calls happen inside the spawned worker's own tool loop, so no reactive/learned signal
exists at the dispatch layer. Part (b) of the same backlog entry (roster-level fallbacks belong in
the LiteLLM config, not caller retry loops) shipped the same day as `router_settings.fallbacks`
(same-tier chains, `num_retries: 2`) in `~/.audit-code/litellm-config.yaml`.

## Mechanism

- **`DispatchableSource.burst_limited?: boolean`** — operator-DECLARED fact: this backend enforces
  a per-model burst limiter. Never inferred from a service name (backend-agnostic), never learned
  (the storm is invisible to dispatch — see above). Absent ⇒ unrestricted. The `proxy` declaration
  block takes the same knob.
- **One predicate, `laneWorkerKindConflict`** (`src/shared/types/sessionConfig.ts`): agentic
  worker-kind × `burst_limited: true` ⇒ operator-facing refusal reason; anything else ⇒ `null`.
- **Enforcement site 1 — `resolveAmbientSources`**: one compatibility pass over the assembled set
  (declared + proxy-expanded), per-lane drop into `dropped[]` with the reason — surfaced by
  `resolveSessionConfig`'s existing loud-drop channel. Per-lane, so one incompatible lane never
  costs the rest of the pool.
- **Enforcement site 2 — `collectDispatchableSources`** (the inner no-bypass chokepoint, beside the
  `service` normalize, for the same exported-wrapper reason): filters descriptor-supplied sources
  the ambient path never sees — the `--auditor sources[]` escape hatch can force a lane the process
  cannot prove REACH for, but not a structurally storm-prone lane. Deduped once-per-process stderr
  line per filtered lane.
- **Proxy expansion stamping** (`resolveProxyLane`): `burst_limited` is stamped onto expanded lanes
  from the CURRENT declaration at resolve time, both directions (`true` adds, explicit `false`
  strips) — a stale populate cache can neither launder the flag off nor pin it on. No re-populate
  needed to flip the knob.
- **`deriveWorkerKind` contract corrected** (review-driven, see below): for fixed-kind transports
  (`openai-compatible` = single_shot; `claude-worker`/`codex`/`agy`/`opencode` = agentic) the
  TRANSPORT is authoritative and a contradicting `worker_kind` declaration is ignored; the
  declaration decides only for the genuinely-ambiguous command-shaped transports
  (`worker-command`/`subprocess-template`, default agentic). This was always the documented intent
  ("declare it only where genuinely ambiguous"); enforcing it closes the one-word-config-edit
  bypass. No other production consumer of `deriveWorkerKind` existed, so the blast radius is the
  predicate + validator.
- **Validator**: `burst_limited` boolean shape check (error) + two `warning`-severity semantic
  checks (agentic×burst-limited will-be-refused; worker_kind contradicting a fixed-kind transport).
  Deliberately NOT errors: an error-severity issue makes `readSourceDeclaration` degrade the WHOLE
  declaration file to empty — one questionable lane must not cost the operator every lane.

## Review history (independent lanes; Codex CLI quota-walled until 2026-07-30)

- **Recon**: NIM deepseek-v4-pro (3 calls: capacity/provider types, scheduler/hybrid, coordinator/
  admission) + AGY gemini-3.6-flash (spec read). AGY's spec read killed the blanket
  "agentic never rides NIM" framing — the proxy overlay onto non-Claude backends is first-class in
  `spec/unified-dispatch-worker-model.md`; only *burst-limited* backends are incompatible, hence a
  declared pool-class flag rather than a transport rule.
- **AGY gemini-3.6-flash (adversarial, effort high)** — two CONFIRMED findings, both fixed before
  commit: (1) `worker_kind: "single_shot"` declared on a `claude-worker` source bypassed the rule
  while changing nothing about how the transport executes — fixed by making fixed-kind transports
  authoritative in `deriveWorkerKind` (the test that had locked the bypass in was inverted to pin
  the fix); (2) the expansion stamp only added `true` and could never strip a cache-carried flag —
  fixed to boolean-authoritative stamping. One finding accepted as a warning gap and fixed
  (validator silent on the conflict → warning-severity issues). Refuted: "ambient drops are
  silent" (the `dropped[]` channel is the existing loud path in `resolveSessionConfig`);
  "unbounded warn-set growth" (bounded by lanes×reasons in CLI-lifetime processes).
- **NIM nemotron-3-ultra-550b (adversarial)** — zero refuting findings; its open questions were
  verified (gather delegates to collect — no bypass) and its test-gap list drove added cases:
  explicit `burst_limited: false`, cache-flag stripping, mixed reach+compat drop accounting,
  service-name-never-implies-flag.
- **Red-green**: predicate mutation (inverted kind check) turned 6+ tests red across three suites;
  restored by inverting, never checkout.

## Residuals / leads (backlog)

- **Populate conversion (LEAD)**: a `burst_limited` proxy currently contributes NOTHING (expanded
  agentic lanes all drop with reasons). The productive endpoint is for populate/expansion to emit
  single-shot `openai-compatible` lanes onto the proxy instead — same capacity, safe class. Until
  then operators declare single-shot lanes by hand (done for the live box:
  `nim-{glm,deepseek,minimax}-single-shot` in `~/.audit-code/sources-declared.json`).
- Single-shot lanes on a burst-limited backend still rely on declared `quota`
  (rpm/max_concurrent) for pacing — `burst_limited` does not yet feed the scheduler as a pacing
  input (nemotron/AGY both raised it; existing declared-quota pacing covers the observed failure
  mode, revisit on live evidence).
- `collectDispatchableSources` reports filtered lanes on stderr only (no programmatic dropped
  list); the ambient path — every real config today — has the structured `dropped[]`.
