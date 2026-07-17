import type { FrictionItem } from "../io/frictionCapture.js";
import type { FrictionCaptureArtifact } from "../io/frictionCapture.js";
import { captureFrictionEvent, type FrictionEvent } from "./captureFrictionEvent.js";
import type { FrictionCategory } from "./frictionRecord.js";

/**
 * CE-005 — the SINGLE shared backend-observed step-boundary chokepoint.
 *
 * EVERY backend-observed friction fact flows through `captureStepBoundaryFriction`
 * (single-sourced here, consumed by BOTH orchestrators) so the fact list is
 * structural/extensible, not a snapshot a sixth fact can silently bypass. The
 * backend already computes each of these facts at its own step boundary — phase
 * re-emit counts, artifact rejection, repair rounds, post-repair re-derive,
 * no-change merge, the intent-gate lock-across-judge fallback, and any quota
 * escalation. Routing them all through one chokepoint with ZERO host discretion
 * (INV-O1-1 / OBL-m-friction-inv-1) means a new backend fact is added by routing
 * it through this same emitter, never by extending a closed enum elsewhere.
 *
 * CE-006 — the event id is a STRUCTURED, collision-free key. Its components
 * {event_type, runId, discriminator} are individually percent-encoded and joined
 * with a delimiter (`:`) that CANNOT appear in any encoded component, so a
 * `:`-bearing reused discriminator (e.g. an M-IDEMPOTENCY split key) can never
 * make the de-dup key ambiguous: two distinct facts never flatten to one key, and
 * one fact never expands to two (OBL-m-friction-inv-6 / fail-2). The encoding is
 * deterministic, so re-recording the same fact is a guaranteed no-op (INV-O1-6).
 *
 * The capture itself rides `captureFrictionEvent` — best-effort, non-fatal,
 * de-duped, OS/path-agnostic (INV-O1-5 / fail-5). A contended or failed capture
 * never throws into the in-flight obligation.
 */

/**
 * The backend-observed step-boundary fact kinds. OPEN/EXTENSIBLE — this union is
 * the documented catalogue, but the chokepoint accepts any string `event_type`
 * so a new backend fact routes through the SAME emitter without forking a closed
 * enum (CE-005). The named members below are the seven facts the contract pins:
 *
 *  - `phase_reemit`       — a phase re-emitting the SAME gate errors / leftovers.
 *  - `artifact_rejected`  — an artifact rejected / archived (referential-integrity
 *                           reject, deemed_inappropriate, archive-consumed-inputs).
 *  - `repair_round`       — one runEmitValidateRepair stage firing.
 *  - `post_repair_rederive` — a staleness re-derive after a repair / redispatch.
 *  - `no_change_merge`    — a resolved_no_change node merged with no diff.
 *  - `intent_gate_fallback` — intent_checkpoint gate lock-across-judge fallback.
 *  - `quota_escalation`   — a bounded quota re-limit escalation surfaced as friction.
 *  - `coverage_total_lines_mismatch` — an AuditResult whose
 *                           `file_coverage[].total_lines` disagrees with the
 *                           file's actual line count (discriminator: the result
 *                           index + the mismatching path).
 *  - `node_quarantine`    — an implement node that committed edits but hard-failed
 *                           the tool's verify/scope/merge; work preserved under a
 *                           quarantine ref, NOT landed (discriminator: the node id).
 *  - `declared_cost_drift` — a dispatch pool DECLARED free (`cost_per_mtok:0`)
 *                           reported a positive cost on a completion (lapsed free
 *                           tier); the tool demoted it out of free-first and the
 *                           operator should reconcile the declared cost
 *                           (discriminator: the pool id).
 *  - `credit_exhausted`    — a dispatch pool reported a non-resettable
 *                           out-of-prepaid-usage-credits condition (distinct from
 *                           a rate limit, which resets); the tool permanently
 *                           excluded it from this run's admissible set and the
 *                           operator should top up credits (discriminator: the
 *                           pool id).
 *  - `quota_unclassified`  — a dispatch pool death whose text was quota-
 *                           SUSPICIOUS (a deliberately broad pre-filter matched)
 *                           but classified as NEITHER `credit_exhausted` nor
 *                           `rate_limited`; the tool degraded it conservatively
 *                           (re-queued, reversible cooldown, pool NEVER
 *                           permanently excluded) and harvested the verbatim
 *                           (secret-scrubbed) message so the operator can
 *                           classify it and improve the pattern set
 *                           (discriminator: the pool id).
 */
export type StepBoundaryEventType =
  | "phase_reemit"
  | "artifact_rejected"
  | "repair_round"
  | "post_repair_rederive"
  | "no_change_merge"
  | "intent_gate_fallback"
  | "quota_escalation"
  | "coverage_total_lines_mismatch"
  | "node_quarantine"
  | "declared_cost_drift"
  | "credit_exhausted"
  | "model_unavailable"
  | "packet_too_large"
  | "quota_unclassified"
  | "newly_reachable_backend"
  | (string & {});

/**
 * Deterministic map from a backend step-boundary fact kind to the REAL close-out
 * friction CATEGORY (one of `FRICTION_CATEGORIES`) it belongs to. This is what
 * lets the auto-captured event feed the per-category friction walk directly:
 * every backend fact is redundant/wasteful re-work or a something-the-tool-had-to
 * -be-reminded-of, never the coarse `trap` bucket the sink used to stamp.
 *
 *  - `inefficient_feeding` — redundant / wasteful re-work: phase re-emits, repair
 *    rounds, post-repair re-derives, no-change merges, quota escalations, and the
 *    coverage-line mismatch (a re-round-trip to fix a mechanical mismatch).
 *  - `tool_should_decide`  — a fact where the tool fell back to host discretion or
 *    quarantined work the host must now shepherd: artifact rejection, the
 *    intent-gate lock-across-judge fallback, and a node quarantine.
 *
 * The named members are pinned; any UNKNOWN `event_type` degrades to
 * `inefficient_feeding` (the safe "this was avoidable re-work" default) so a new
 * backend fact always lands in a real category — never `trap`, never uncovered.
 */
const STEP_BOUNDARY_CATEGORY: Record<string, FrictionCategory> = {
  phase_reemit: "inefficient_feeding",
  repair_round: "inefficient_feeding",
  post_repair_rederive: "inefficient_feeding",
  no_change_merge: "inefficient_feeding",
  quota_escalation: "inefficient_feeding",
  coverage_total_lines_mismatch: "inefficient_feeding",
  artifact_rejected: "tool_should_decide",
  intent_gate_fallback: "tool_should_decide",
  node_quarantine: "tool_should_decide",
  // A declared-free pool that started charging is a stale operator config the tool
  // surfaced and demoted around — the operator must reconcile the declared cost.
  declared_cost_drift: "tool_should_decide",
  // A credit-exhausted pool needs an operator action (top up credits) before it
  // can ever serve again — same "operator must reconcile" shape as a cost drift.
  credit_exhausted: "tool_should_decide",
  // A model-unavailable (404) pool is not served by this provider — operator must
  // either remove it from declared backends or investigate provider availability.
  model_unavailable: "tool_should_decide",
  // A packet-too-large (413) fault is a per-packet sizing issue (this packet/pool pair).
  // Operator should investigate packet content size or pool limits.
  packet_too_large: "tool_should_decide",
  // A quota-unclassified death is exactly "the host had to remember/notice
  // something the tool should guarantee" — the tool COULD NOT confidently
  // classify it, so the operator must review the verbatim text and (if it's a
  // real quota/billing death) teach the tool a new precise pattern.
  quota_unclassified: "tool_should_decide",
  // An autonomous run reached a backend the operator never confirmed and, with no
  // human to ask, fail-closed-excluded it. Same "operator must reconcile" shape as
  // a cost drift: only they can say whether that backend should route.
  newly_reachable_backend: "tool_should_decide",
};

/**
 * The REAL close-out friction category for a step-boundary fact kind. Total: an
 * unknown event type degrades to `inefficient_feeding` so the mapping is never
 * undefined and a captured event is ALWAYS tagged with a real category.
 */
export function stepBoundaryFrictionCategory(
  eventType: StepBoundaryEventType,
): FrictionCategory {
  return STEP_BOUNDARY_CATEGORY[eventType] ?? "inefficient_feeding";
}

/**
 * Percent-encode a single id component so the join delimiter (`:`) cannot appear
 * inside it. `encodeURIComponent` already escapes `:` (and `/`, `\`, `%`, etc.),
 * but it leaves a handful of safe sub-delimiters (`!'()*-._~`) unescaped — none of
 * which is `:`, so the delimiter remains unambiguous. We additionally escape `*`
 * and `!` defensively to keep the keyspace tight and fully reversible.
 */
function encodeIdComponent(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * Build the STRUCTURED, collision-free de-dup id for a step-boundary fact.
 * Components are individually percent-encoded then joined with `:` — a delimiter
 * that cannot survive the encoding inside any component, so the mapping
 * {event_type, runId, discriminator} → id is injective (CE-006).
 */
export function stepBoundaryEventId(
  eventType: StepBoundaryEventType,
  runId: string,
  discriminator: string,
): string {
  return [eventType, runId, discriminator]
    .map((part) => encodeIdComponent(part))
    .join(":");
}

/** The structured fact a caller routes through the chokepoint. */
export interface StepBoundaryFriction {
  /** Backend-observed fact kind (one of the named members, or a new string). */
  eventType: StepBoundaryEventType;
  /**
   * A stable discriminator distinguishing this fact instance within the run
   * (e.g. the phase id + attempt, the artifact id, the node id). May contain any
   * characters — it is percent-encoded before flattening, so `:` is safe.
   */
  discriminator: string;
  /** Human-readable summary for the triage prompt. */
  note: string;
  severity?: FrictionItem["severity"];
  category?: FrictionItem["category"];
  area?: string;
  /**
   * Optional artifact/subject key this fact concerns (e.g. the node id, the
   * contract id). The aggregation axis for the derived per-category observation:
   * N facts on the SAME artifact collapse to one `inefficient_feeding` line.
   * Falls back to `area`, then the discriminator, when unset.
   */
  artifact?: string;
}

/**
 * Route ONE backend-observed step-boundary fact through the single chokepoint.
 *
 * Best-effort and non-fatal: delegates to `captureFrictionEvent`, which swallows
 * every failure so the in-flight obligation is never broken (INV-O1-5). De-duped
 * on the structured collision-free id, so re-entrant boundary passes (re-dispatch,
 * retry, re-derive) never double-count the same fact (INV-O1-6).
 */
export async function captureStepBoundaryFriction(
  artifactsDir: string,
  runId: string,
  fact: StepBoundaryFriction,
  tool: FrictionCaptureArtifact["tool"],
): Promise<void> {
  const event: FrictionEvent = {
    id: stepBoundaryEventId(fact.eventType, runId, fact.discriminator),
    note: fact.note,
    severity: fact.severity,
    // The inherited `FrictionItem.category` (`bug|trap|suggestion`) is only a
    // coarse ORIGIN hint. It is NEVER the close-out category — the close-out keys
    // on `frictionCategory` below. Default the origin hint to `trap` (a standing
    // tooling fact) but ALWAYS stamp a REAL close-out category so the event feeds
    // the per-category walk instead of the dead `trap` bucket it used to land in.
    category: fact.category ?? "trap",
    frictionCategory: stepBoundaryFrictionCategory(fact.eventType),
    // The aggregation axis: N same-artifact backend facts collapse to ONE derived
    // observation. Prefer the caller's explicit `artifact`, then the fact's area,
    // then the discriminator (which is per-instance but still a stable subject key).
    artifact: fact.artifact ?? fact.area ?? fact.discriminator,
    area: fact.area,
  };
  await captureFrictionEvent(artifactsDir, runId, event, tool);
}

/** Reactive cost-drift facts routed through {@link captureCostDriftFriction}. */
export interface CostDriftInfo {
  poolId: string;
  observedCostUsd: number;
  declaredCostPerMtok: number;
}

/**
 * Route a reactive cost-drift demotion (a dispatch pool declared free —
 * `cost_per_mtok:0` — that started reporting a positive cost, so the rolling
 * engine demoted it out of free-first ordering) through the step-boundary
 * chokepoint as a `declared_cost_drift` fact. Both orchestrators' rolling
 * dispatch wiring (`onCostDrift`) is byte-identical apart from the trailing
 * `source` tool tag; this single-sources the eventType/note/severity/area
 * template so they cannot drift. Fire-and-forget, like the call sites it
 * replaces — never awaited by the caller.
 */
export function captureCostDriftFriction(
  artifactsDir: string,
  runId: string,
  info: CostDriftInfo,
  source: FrictionCaptureArtifact["tool"],
): void {
  void captureStepBoundaryFriction(
    artifactsDir,
    runId,
    {
      eventType: "declared_cost_drift",
      discriminator: info.poolId,
      note:
        `pool "${info.poolId}" was declared free (cost_per_mtok=${info.declaredCostPerMtok}) ` +
        `but reported cost=${info.observedCostUsd} — demoted out of free-first ordering; ` +
        `reconcile the source's declared cost.`,
      severity: "medium",
      area: "dispatch/cost",
    },
    source,
  );
}

/**
 * Route an autonomous fail-closed exclusion of a newly-reachable backend (the G3
 * reconciliation gate: this auditor can reach a backend the operator's Gate-0
 * decision never mentions, and no human is present to confirm it) through the
 * step-boundary chokepoint as a `newly_reachable_backend` fact.
 *
 * This is what keeps the autonomous branch LOUD rather than silent. The gate's
 * whole point is that the operator confirms model choices; when autonomy rules a
 * backend out on their behalf, they must be able to find out and re-include it at
 * the next attended gate. One fact per backend, discriminated by its gate key, so
 * re-derives never double-count and each backend is individually triageable.
 *
 * AWAITED, unlike the other reactive captures — deliberately. They fire mid-dispatch,
 * with a long-running engine still alive to flush them; this one fires at Gate-0, and
 * the CLI can emit its step and exit immediately after. A dropped write here would
 * mean the exclusion happened SILENTLY — precisely the failure the gate exists to
 * prevent — so the caller waits for it. Awaiting is safe: `captureFrictionEvent`
 * swallows every failure internally, so this can never break the in-flight obligation
 * (INV-O1-5), which is the property the fire-and-forget style was protecting.
 */
export async function captureNewlyReachableBackendFriction(
  artifactsDir: string,
  runId: string,
  backendKeys: readonly string[],
  source: FrictionCaptureArtifact["tool"],
): Promise<void> {
  // Sequential, not Promise.all: the capture merges the whole record under a file
  // lock, so concurrent appends would contend on the same lock for no gain.
  for (const key of backendKeys) {
    await captureStepBoundaryFriction(
      artifactsDir,
      runId,
      {
        eventType: "newly_reachable_backend",
        discriminator: key,
        note:
          `backend "${key}" is reachable but absent from the operator's confirmed ` +
          `route decision; this run is autonomous, so it was fail-closed-excluded ` +
          `rather than dispatched unconfirmed. Confirm or exclude it at the next ` +
          `attended provider-confirmation gate.`,
        severity: "medium",
        area: "dispatch/provider-confirmation",
      },
      source,
    );
  }
}

/** Credit-exhaustion facts routed through {@link captureCreditExhaustionFriction}. */
export interface CreditExhaustionInfo {
  poolId: string;
  rawMatch: string | null;
}

/**
 * Route a credit-exhaustion exclusion (a dispatch pool reported a non-
 * resettable out-of-prepaid-usage-credits condition — distinct from a rate
 * limit, which resets — and the rolling engine permanently excluded it from
 * this run's admissible set) through the step-boundary chokepoint as a
 * `credit_exhausted` fact. Both orchestrators' rolling dispatch wiring
 * (`onCreditExhausted`) is byte-identical apart from the trailing `source` tool
 * tag; this single-sources the eventType/note/severity/area template so they
 * cannot drift. Fire-and-forget, like {@link captureCostDriftFriction} — never
 * awaited by the caller.
 */
export function captureCreditExhaustionFriction(
  artifactsDir: string,
  runId: string,
  info: CreditExhaustionInfo,
  source: FrictionCaptureArtifact["tool"],
): void {
  void captureStepBoundaryFriction(
    artifactsDir,
    runId,
    {
      eventType: "credit_exhausted",
      discriminator: info.poolId,
      note:
        `pool "${info.poolId}" is out of prepaid usage credits` +
        (info.rawMatch ? ` (matched: "${info.rawMatch}")` : "") +
        ` — excluded from this run's admissible set for the remainder of the run ` +
        `(no reset timer); top up credits to restore it.`,
      severity: "high",
      area: "dispatch/quota",
    },
    source,
  );
}

/**
 * Minimal, single-sourced redaction of secret-shaped VALUES from a captured
 * verbatim provider message before it is persisted to the friction record.
 *
 * Recon for Slice A2b found no existing helper for this: `stripClaudeCodeEnv`
 * (`../tooling/exec.js`) filters env-var NAMES out of a subprocess env object —
 * a different concern from redacting secret VALUES embedded in arbitrary text.
 * The backlog's noted `consent_token` strip-before-persist is a planned, not yet
 * implemented, forward constraint (see `docs/backlog.md`). So this is a new,
 * deliberately minimal, narrowly-scoped function — NOT a general secret-
 * detection framework — used only at this one sink:
 *  (a) the literal value of any CURRENTLY-SET env var whose NAME looks like a
 *      credential (`/API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i`) — this
 *      catches the exact provider keys the tool is configured with
 *      (`openai_compatible.api_key_env`, `ANTHROPIC_API_KEY`, etc.), the same
 *      "known-secret-env-var-NAME" signal `stripClaudeCodeEnv` uses, applied to
 *      redacting values instead of dropping entries;
 *  (b) generic secret-shaped substrings as a backstop (`Bearer <token>`, an
 *      `sk-…`-style API-key prefix) for a key the text carries that is not (or
 *      is no longer) present in this process's env.
 * Over-redaction here is safe (the harvest note still names the pool and
 * retains surrounding context for pattern authoring); under-redaction is the
 * risk this function exists to bound, so it errs broad.
 */
export function scrubSecretValuesFromText(text: string): string {
  let scrubbed = text;
  // Layer (a): redact the literal VALUE of any currently-set env var whose NAME
  // looks secret-ish. Segment-matched (underscore/boundary delimited) so a name
  // like MONKEY or KEYBOARD does not trip, but NVIDIA_API_KEY / NIM_KEY /
  // GITHUB_TOKEN / AWS_SECRET_ACCESS_KEY / *_PAT all do. Best-effort: only
  // catches secrets that live in THIS process's env — layer (b) is the backstop
  // for everything else.
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 6) continue;
    if (
      !/(?:^|_)(?:API_?KEY|APIKEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH|PAT)(?:$|_)/i.test(
        name,
      )
    ) {
      continue;
    }
    scrubbed = scrubbed.split(value).join("[REDACTED]");
  }
  // Layer (b): shape-based backstop for secrets NOT in this process's env —
  // vendor key prefixes (OpenAI/Anthropic sk-, NVIDIA nvapi-, GitHub gh?_, Slack
  // xox?-, AWS AKIA, Google AIza), Bearer/JWT, key=value assignments, and
  // query-string credentials. Over-redaction is safe here; under-redaction is the
  // risk. Ordered value-first so an assignment's value is caught even when its
  // key word isn't in the list.
  return scrubbed
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/gi, "[REDACTED]")
    .replace(/\bnvapi-[A-Za-z0-9_-]{16,}/gi, "[REDACTED]")
    .replace(/\bgh[posru]_[A-Za-z0-9]{20,}/g, "[REDACTED]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/gi, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "[REDACTED]")
    .replace(
      /\b(api[_-]?key|apikey|token|secret|password|passwd|access[_-]?token|access[_-]?key|credentials?)\b(\s*[:=]\s*)["']?[A-Za-z0-9._~+/=-]{6,}["']?/gi,
      "$1$2[REDACTED]",
    )
    .replace(
      /([?&](?:api[_-]?key|apikey|token|key|secret|access_token|password)=)[^&\s"']+/gi,
      "$1[REDACTED]",
    );
}

/** Quota-unclassified harvest facts routed through {@link captureQuotaUnclassifiedFriction}. */
export interface QuotaUnclassifiedInfo {
  poolId: string;
  /**
   * The verbatim worker ERROR/STATUS channel text that tripped the broad
   * `detectQuotaSuspicious` pre-filter but matched neither `credit_exhausted`
   * nor `rate_limited`. Scrubbed of secret-shaped values by
   * {@link captureQuotaUnclassifiedFriction} before it is embedded in the
   * persisted note — callers must pass the RAW text, never pre-scrub it (single
   * scrub point, so it can never be forgotten at a second call site).
   */
  text: string;
}

/**
 * Route a Slice A2b quota-unclassified degrade (TIER 2 — the broad
 * `detectQuotaSuspicious` pre-filter matched a worker death's text, but neither
 * precise class did, so the engine degraded conservatively: re-queued with a
 * reversible cooldown, the pool NEVER added to the permanent exclusion set)
 * through the step-boundary chokepoint as a `quota_unclassified` fact. This is
 * the TOOL AUTO-CAPTURE harvest mechanism: it persists the VERBATIM (secret-
 * scrubbed) provider message so an operator can classify it and consider
 * teaching `errorParsing.ts` a new precise pattern. Mirrors
 * {@link captureCreditExhaustionFriction}'s single-source-the-template shape;
 * fire-and-forget, never awaited by the caller. The text is scrubbed via
 * {@link scrubSecretValuesFromText} and bounded to 2000 chars before it is
 * embedded in the persisted note, so a pathologically large stderr capture
 * never bloats the friction record.
 */
export function captureQuotaUnclassifiedFriction(
  artifactsDir: string,
  runId: string,
  info: QuotaUnclassifiedInfo,
  source: FrictionCaptureArtifact["tool"],
): void {
  const verbatim = scrubSecretValuesFromText(info.text).trim().slice(0, 2000);
  void captureStepBoundaryFriction(
    artifactsDir,
    runId,
    {
      eventType: "quota_unclassified",
      discriminator: info.poolId,
      note:
        `pool "${info.poolId}" reported a quota-suspicious provider message that matched NO known pattern ` +
        `(neither credit_exhausted nor rate_limited) — re-queued conservatively (reversible cooldown; the ` +
        `pool was NOT permanently excluded). Classify it and consider adding a pattern to errorParsing.ts. ` +
        `Verbatim (secret-scrubbed): "${verbatim}"`,
      severity: "high",
      area: "dispatch/quota",
    },
    source,
  );
}

/** Model-unavailable facts routed through {@link captureModelUnavailableFriction}. */
export interface ModelUnavailableInfo {
  poolId: string;
  rawMatch: string | null;
}

/**
 * Route a model-unavailable exclusion (HTTP 404, model not found — the model is not
 * served by this provider and the pool is permanently excluded from this run's
 * admissible set) through the step-boundary chokepoint as a `model_unavailable` fact.
 * Both orchestrators' rolling dispatch wiring (`onModelUnavailable`) is byte-identical
 * apart from the trailing `source` tool tag; this single-sources the
 * eventType/note/severity/area template so they cannot drift. Fire-and-forget, like
 * {@link captureCreditExhaustionFriction} — never awaited by the caller.
 */
export function captureModelUnavailableFriction(
  artifactsDir: string,
  runId: string,
  info: ModelUnavailableInfo,
  source: FrictionCaptureArtifact["tool"],
): void {
  void captureStepBoundaryFriction(
    artifactsDir,
    runId,
    {
      eventType: "model_unavailable",
      discriminator: info.poolId,
      note:
        `pool "${info.poolId}" reported model not found (HTTP 404)` +
        (info.rawMatch ? ` (matched: "${info.rawMatch}")` : "") +
        ` — the model is not served by this provider and the pool is permanently ` +
        `excluded from this run's admissible set. Verify the provider serves this model or remove it from declared backends.`,
      severity: "high",
      area: "dispatch/quota",
    },
    source,
  );
}

/** Packet-too-large facts routed through {@link capturePacketTooLargeFriction}. */
export interface PacketTooLargeInfo {
  poolId: string;
  packetId: string;
  rawMatch: string | null;
}

/**
 * Route a packet-too-large failure (HTTP 413, payload/request too large — a per-packet
 * sizing fault for this particular pool) through the step-boundary chokepoint as a
 * `packet_too_large` fact. Unlike model_unavailable, the pool is NOT permanently
 * excluded (only THIS PACKET skips THIS POOL on re-selection). Mirrors
 * {@link captureCreditExhaustionFriction}'s single-source-the-template shape but fires
 * EVERY time (each (packet,pool) pair is distinct signal), never awaited by the caller.
 */
export function capturePacketTooLargeFriction(
  artifactsDir: string,
  runId: string,
  info: PacketTooLargeInfo,
  source: FrictionCaptureArtifact["tool"],
): void {
  void captureStepBoundaryFriction(
    artifactsDir,
    runId,
    {
      eventType: "packet_too_large",
      discriminator: `${info.packetId}:${info.poolId}`,
      note:
        `packet "${info.packetId}" rejected as too large (HTTP 413) by pool "${info.poolId}"` +
        (info.rawMatch ? ` (matched: "${info.rawMatch}")` : "") +
        ` — this pool is skipped for THIS PACKET only; the packet will retry on other pools. ` +
        `Investigate packet content size or pool request-size limits.`,
      severity: "medium",
      area: "dispatch/quota",
    },
    source,
  );
}
