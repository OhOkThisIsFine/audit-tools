import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { ConcurrencyBucket, ObservedWaveOutcome, QuotaState, QuotaStateEntry } from "./types.js";
import { withFileLock } from "./fileLock.js";
import { writeJsonFile } from "../io/json.js";

const MIN_EVIDENCE_WEIGHT = 0.5;
// A failure at concurrency N is evidence against N and the few levels above it
// (a failure at 5 makes 6, 7, 8, 9 suspect too), so failure weight spreads over
// this many buckets past the observed concurrency.
const FAILURE_SPREAD_BUCKETS = 4;
// computeMaxSafeConcurrency (and computeRampUpConcurrency) scans up to this many
// levels. Bucket writes are capped at this ceiling so quota-state.json does not
// grow indefinitely with entries that will never be read back.
export const MAX_BUCKET_LEVEL = 32;

let _statePath: string | undefined;

export function setQuotaStateDir(dir: string): void {
  _statePath = join(dir, "quota-state.json");
}

export function getQuotaStatePath(): string {
  if (!_statePath) throw new Error("Quota state dir not set — call setQuotaStateDir() first.");
  return _statePath;
}

export function decayWeight(
  weight: number,
  elapsedHours: number,
  halfLifeHours: number,
): number {
  if (halfLifeHours <= 0 || weight <= 0) return 0;
  return weight * Math.pow(0.5, elapsedHours / halfLifeHours);
}

export function applyDecayToEntry(
  entry: QuotaStateEntry,
  halfLifeHours: number,
): QuotaStateEntry {
  const elapsedHours = (Date.now() - new Date(entry.updated_at).getTime()) / (1000 * 60 * 60);
  if (elapsedHours < 0.001) return entry;
  const decayed: Record<string, ConcurrencyBucket> = {};
  for (const [key, bucket] of Object.entries(entry.buckets)) {
    decayed[key] = {
      success_weight: decayWeight(bucket.success_weight, elapsedHours, halfLifeHours),
      failure_weight: decayWeight(bucket.failure_weight, elapsedHours, halfLifeHours),
    };
  }
  return { ...entry, buckets: decayed };
}

function isQuotaState(value: unknown): value is QuotaState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  const version = obj["version"];
  return (version === 1 || version === 2) && typeof obj["entries"] === "object";
}

/**
 * The cold-start quota state. This is the ONLY value that legitimately means
 * "nothing learned yet" — it must never be manufactured from a read failure.
 * An empty state carries no `cooldown_until`, no learned limits, and no
 * concurrency evidence, so silently substituting it for an unreadable file
 * degrades the engine in the **fail-open** direction (unbounded dispatch).
 */
export function emptyQuotaState(): QuotaState {
  return { version: 2, entries: {} };
}

/**
 * The quota state file exists but could not be read or is not a valid
 * {@link QuotaState}. Distinct from "absent" (cold start → {@link emptyQuotaState}).
 *
 * Thrown rather than degraded-to-empty for two reasons: a reader that swallows
 * it dispatches with no throttle at all, and a read-modify-write path that
 * swallows it overwrites the file with an empty state, destroying every learned
 * limit and live cooldown. Callers that genuinely want a degrade must opt in
 * explicitly and say so (see `learnedQuotaSource.probeUsage`, which reports
 * `degraded`, and the read-only reporting commands).
 */
export class QuotaStateUnavailableError extends Error {
  constructor(
    readonly statePath: string,
    /**
     * `corrupt` — the bytes are there but are not a valid QuotaState. Terminal
     * for that file: re-reading will fail identically, so a write-path may
     * quarantine it (see {@link readQuotaStateForUpdate}).
     * `unreadable` — the file could not be opened (EACCES, EBUSY, EIO). Possibly
     * transient, and the content may be perfectly good — NEVER destroy it.
     */
    readonly kind: "corrupt" | "unreadable",
    readonly reason: string,
  ) {
    super(`Quota state at ${statePath} is unusable (${kind}): ${reason}`);
    this.name = "QuotaStateUnavailableError";
  }
}

export async function readQuotaState(): Promise<QuotaState> {
  const statePath = getQuotaStatePath();
  let raw: string;
  try {
    raw = await readFile(statePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyQuotaState();
    }
    throw new QuotaStateUnavailableError(
      statePath,
      "unreadable",
      error instanceof Error ? error.message : String(error),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new QuotaStateUnavailableError(
      statePath,
      "corrupt",
      `not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!isQuotaState(parsed)) {
    throw new QuotaStateUnavailableError(
      statePath,
      "corrupt",
      "expected { version: 1|2, entries: object }",
    );
  }
  if (parsed.version === 1) {
    for (const entry of Object.values(parsed.entries)) {
      entry.consecutive_429_count ??= 0;
    }
  }
  return parsed;
}

/**
 * The ONE opt-in degrade for {@link readQuotaState}: return the cold-start state
 * when the file is unusable, after saying so on stderr. Use only where losing
 * every cooldown and learned limit is survivable (pool construction, read-only
 * reporting) — never on a path that would then WRITE the degraded state back.
 * The degrade is loud by construction so a corrupt file cannot look like a cold
 * start.
 */
export async function readQuotaStateOrDegrade(context: string): Promise<QuotaState> {
  try {
    return await readQuotaState();
  } catch (error) {
    process.stderr.write(
      `[quota] ${context}: ${
        error instanceof Error ? error.message : String(error)
      }; degrading to no learned quota state (no cooldowns, no learned limits)\n`,
    );
    return emptyQuotaState();
  }
}

/**
 * Read quota state for a read-modify-write whose caller ALREADY HOLDS
 * `quota-state.json.lock`. Every RMW helper in this module goes through it.
 *
 * A `corrupt` file is terminal — every future read fails the same way — so
 * without a repair path the first bad byte would permanently disable cooldown
 * persistence and limit learning for the life of that file, with nothing but one
 * stderr line to show for it. So: quarantine the bad bytes aside (evidence is
 * preserved, never deleted), say so loudly, and continue from cold state, which
 * the caller's write then re-establishes. Safe to do here precisely because the
 * lock is held.
 *
 * An `unreadable` file (EACCES/EBUSY/EIO) is NOT quarantined and NOT swallowed —
 * the content may be perfectly good and the failure transient, so the rejection
 * propagates and the caller leaves the file untouched.
 */
export async function readQuotaStateForUpdate(context: string): Promise<QuotaState> {
  try {
    return await readQuotaState();
  } catch (error) {
    if (!(error instanceof QuotaStateUnavailableError) || error.kind !== "corrupt") {
      throw error;
    }
    const statePath = getQuotaStatePath();
    const quarantinePath = `${statePath}.corrupt-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}`;
    let quarantined = true;
    try {
      await rename(statePath, quarantinePath);
    } catch {
      // A peer healed it first, or the rename itself is blocked. Either way the
      // caller's write recreates a valid file; don't fail the run over it.
      quarantined = false;
    }
    process.stderr.write(
      `[quota] ${context}: ${error.message}; ${
        quarantined ? `quarantined to ${quarantinePath}` : "could not quarantine it"
      }, continuing from cold state (learned limits and cooldowns are lost)\n`,
    );
    return emptyQuotaState();
  }
}

/**
 * Persist quota state atomically (temp file + rename, via the shared
 * `writeJsonFile`). Atomicity is load-bearing: `refreshQuotaStateIfNeeded`
 * reads this file WITHOUT taking `quota-state.json.lock`, so a truncating
 * in-place write would expose a torn file to a co-located peer. With
 * rename-over-destination a reader observes either the whole old file or the
 * whole new one, never a prefix.
 */
export async function writeQuotaState(state: QuotaState): Promise<void> {
  const normalized: QuotaState = { ...state, version: 2 };
  await writeJsonFile(getQuotaStatePath(), normalized);
}

export function computeMaxSafeConcurrency(
  entry: QuotaStateEntry,
  halfLifeHours: number,
  maxToCheck = MAX_BUCKET_LEVEL,
): number {
  const decayed = applyDecayToEntry(entry, halfLifeHours);
  let maxSafe = 1;
  for (let n = 1; n <= maxToCheck; n++) {
    const bucket = decayed.buckets[String(n)];
    if (!bucket) break;
    if (
      bucket.success_weight >= MIN_EVIDENCE_WEIGHT &&
      bucket.failure_weight < MIN_EVIDENCE_WEIGHT
    ) {
      maxSafe = n;
    } else {
      break;
    }
  }
  return maxSafe;
}

const RAMP_UP_MIN_SUCCESSES = 2;

export function computeRampUpConcurrency(
  entry: QuotaStateEntry,
  halfLifeHours: number,
  maxToCheck = MAX_BUCKET_LEVEL,
): number {
  const maxSafe = computeMaxSafeConcurrency(entry, halfLifeHours, maxToCheck);
  const decayed = applyDecayToEntry(entry, halfLifeHours);
  const bucket = decayed.buckets[String(maxSafe)];
  if (
    bucket &&
    bucket.success_weight >= RAMP_UP_MIN_SUCCESSES &&
    bucket.failure_weight < MIN_EVIDENCE_WEIGHT
  ) {
    return maxSafe + 1;
  }
  return maxSafe;
}

// EWMA weight for a new tokens_per_pct observation folded into the running
// slope. 0.3 = responsive but not jumpy; a run flipping between windows still
// converges each window's own slope within a few observations.
export const TOKENS_PER_PCT_EWMA_ALPHA = 0.3;
// Minimum meaningful Δpercent (percent = remaining_pct*100) before we trust a
// slope sample. Below this the denominator is noise (rounding / a snapshot that
// barely moved) and Δtokens/Δpercent explodes — skip it.
export const MIN_SLOPE_DELTA_PERCENT = 0.5;

/**
 * Fold one tokens→percent slope observation into a window's learned EWMA slope,
 * returning the updated map (pure — never mutates the input). Given a prior and
 * new remaining_pct (0–1 fractions) for the SAME window label plus the tokens
 * dispatched between the two readings, computes `slope = Δtokens / Δpercent`
 * (percent = remaining_pct*100) and blends it into the label's EWMA.
 *
 * Degrade-safe: returns the prior map unchanged when Δpercent is not meaningfully
 * positive (≥ {@link MIN_SLOPE_DELTA_PERCENT}), when tokens are non-positive, or
 * when any input is non-finite. Never throws.
 */
export function foldTokensPerPctObservation(
  prior: Record<string, number> | undefined,
  windowLabel: string,
  priorRemainingPct: number,
  newRemainingPct: number,
  tokensDispatched: number,
): Record<string, number> {
  const base = prior ?? {};
  if (
    !Number.isFinite(priorRemainingPct) ||
    !Number.isFinite(newRemainingPct) ||
    !Number.isFinite(tokensDispatched) ||
    tokensDispatched <= 0
  ) {
    return base;
  }
  // Percent DROP as quota is consumed: prior − new, on the 0–100 scale.
  const deltaPercent = (priorRemainingPct - newRemainingPct) * 100;
  if (deltaPercent < MIN_SLOPE_DELTA_PERCENT) return base;
  const sampleSlope = tokensDispatched / deltaPercent;
  if (!Number.isFinite(sampleSlope) || sampleSlope <= 0) return base;
  const previous = base[windowLabel];
  const blended =
    typeof previous === "number" && Number.isFinite(previous) && previous > 0
      ? previous * (1 - TOKENS_PER_PCT_EWMA_ALPHA) + sampleSlope * TOKENS_PER_PCT_EWMA_ALPHA
      : sampleSlope;
  return { ...base, [windowLabel]: blended };
}

// EWMA weight for a new output/input ratio observation. Shares the responsive-but-
// not-jumpy 0.3 of the tokens_per_pct slope — a lens's output ratio is at least as
// stable as its consumption slope, so the same blend converges within a few packets.
export const OUTPUT_RATIO_EWMA_ALPHA = 0.3;

/**
 * Fold one output/input token-ratio observation into a lens's learned EWMA ratio,
 * returning the updated map (pure — never mutates the input). `ratio =
 * actualOutputTokens / actualInputTokens`, blended into the lens's EWMA so the
 * next reservation's output envelope tracks measured reality.
 *
 * Degrade-safe: returns the prior map unchanged when either token count is
 * non-finite or non-positive (a packet that produced no measurable output/input
 * carries no ratio signal). Never throws.
 */
export function foldOutputRatioObservation(
  prior: Record<string, number> | undefined,
  lens: string,
  actualInputTokens: number,
  actualOutputTokens: number,
): Record<string, number> {
  const base = prior ?? {};
  if (
    !Number.isFinite(actualInputTokens) ||
    !Number.isFinite(actualOutputTokens) ||
    actualInputTokens <= 0 ||
    actualOutputTokens <= 0
  ) {
    return base;
  }
  const sampleRatio = actualOutputTokens / actualInputTokens;
  if (!Number.isFinite(sampleRatio) || sampleRatio <= 0) return base;
  const previous = base[lens];
  const blended =
    typeof previous === "number" && Number.isFinite(previous) && previous > 0
      ? previous * (1 - OUTPUT_RATIO_EWMA_ALPHA) + sampleRatio * OUTPUT_RATIO_EWMA_ALPHA
      : sampleRatio;
  return { ...base, [lens]: blended };
}

/**
 * Persist a folded output/input ratio observation for a pool's quota-state entry,
 * under the shared quota-state file lock. Reads the current entry (or a blank one),
 * folds the observation via {@link foldOutputRatioObservation}, and writes back.
 * A missing state file is cold start; a CORRUPT one is quarantined and rebuilt
 * ({@link readQuotaStateForUpdate}); a transient-unreadable one rejects. An
 * observation carrying no ratio signal leaves the file untouched-in-value.
 */
export async function recordOutputRatioObservation(
  providerModelKey: string,
  lens: string,
  actualInputTokens: number,
  actualOutputTokens: number,
): Promise<void> {
  const lockPath = getQuotaStatePath() + ".lock";
  await withFileLock(lockPath, async () => {
    const state = await readQuotaStateForUpdate("recordOutputRatioObservation");
    const entry = state.entries[providerModelKey] ?? blankEntry();
    const updated = foldOutputRatioObservation(
      entry.output_per_input,
      lens,
      actualInputTokens,
      actualOutputTokens,
    );
    entry.output_per_input = updated;
    entry.updated_at = new Date().toISOString();
    state.entries[providerModelKey] = entry;
    await writeQuotaState(state);
  });
}

/**
 * Persist a folded tokens_per_pct observation for a pool's quota-state entry,
 * under the shared quota-state file lock. Reads the current entry (or a blank
 * one), folds the observation via {@link foldTokensPerPctObservation}, and writes
 * back. A missing state file is cold start; a CORRUPT one is quarantined and
 * rebuilt ({@link readQuotaStateForUpdate}); a transient-unreadable one rejects.
 * An observation that doesn't move the slope leaves the file untouched-in-value.
 */
export async function recordTokensPerPctObservation(
  providerModelKey: string,
  windowLabel: string,
  priorRemainingPct: number,
  newRemainingPct: number,
  tokensDispatched: number,
): Promise<void> {
  const lockPath = getQuotaStatePath() + ".lock";
  await withFileLock(lockPath, async () => {
    const state = await readQuotaStateForUpdate("recordTokensPerPctObservation");
    const entry = state.entries[providerModelKey] ?? blankEntry();
    const updated = foldTokensPerPctObservation(
      entry.tokens_per_pct,
      windowLabel,
      priorRemainingPct,
      newRemainingPct,
      tokensDispatched,
    );
    entry.tokens_per_pct = updated;
    entry.updated_at = new Date().toISOString();
    state.entries[providerModelKey] = entry;
    await writeQuotaState(state);
  });
}

function blankEntry(): QuotaStateEntry {
  return { updated_at: new Date().toISOString(), buckets: {}, cooldown_until: null, last_429_at: null };
}

export const BASE_COOLDOWN_MS = 60_000;
export const MAX_COOLDOWN_MS = 15 * 60_000;

export function computeBackoffCooldownMs(consecutive429Count: number): number {
  const ms = BASE_COOLDOWN_MS * Math.pow(2, Math.max(0, consecutive429Count - 1));
  return Math.min(ms, MAX_COOLDOWN_MS);
}

export function computeBackoffFailureWeight(consecutive429Count: number): number {
  return 1.0 + 0.5 * Math.max(0, consecutive429Count - 1);
}

export async function recordWaveOutcome(
  providerModelKey: string,
  outcome: ObservedWaveOutcome,
  halfLifeHours: number,
): Promise<void> {
  const lockPath = getQuotaStatePath() + ".lock";
  await withFileLock(lockPath, () => recordWaveOutcomeUnsafe(providerModelKey, outcome, halfLifeHours));
}

/**
 * Targeted recovery: zero out the failure_weight on a single concurrency bucket
 * for a given provider-model key. Use this when a sparse or stale failure entry
 * at level `concurrency` is permanently capping the inferred safe concurrency —
 * the scan in computeMaxSafeConcurrency breaks at the first bucket whose
 * failure_weight dominates, so clearing one bad entry unblocks all higher levels.
 *
 * This is faster than waiting for the 24-hour decay half-life to clear bad entries.
 * success_weight is preserved; only the failure evidence is removed.
 */
export async function clearBucketFailureEvidence(
  providerModelKey: string,
  concurrency: number,
): Promise<void> {
  const lockPath = getQuotaStatePath() + ".lock";
  await withFileLock(lockPath, async () => {
    const state = await readQuotaStateForUpdate("clearBucketFailureEvidence");
    const entry = state.entries[providerModelKey];
    if (!entry) return;
    const bucket = entry.buckets[String(concurrency)];
    if (!bucket) return;
    bucket.failure_weight = 0;
    entry.updated_at = new Date().toISOString();
    state.entries[providerModelKey] = entry;
    await writeQuotaState(state);
  });
}

async function recordWaveOutcomeUnsafe(
  providerModelKey: string,
  outcome: ObservedWaveOutcome,
  halfLifeHours: number,
): Promise<void> {
  const state = await readQuotaStateForUpdate("recordWaveOutcome");
  const entry = applyDecayToEntry(state.entries[providerModelKey] ?? blankEntry(), halfLifeHours);

  if (outcome.outcome === "success") {
    entry.consecutive_429_count = 0;
    entry.cooldown_until = null;
    // Cap at MAX_BUCKET_LEVEL: levels above this are never read back by
    // computeMaxSafeConcurrency, so writing them would grow the state file
    // indefinitely without ever influencing scheduling decisions.
    const successCeiling = Math.min(outcome.concurrency, MAX_BUCKET_LEVEL);
    for (let n = 1; n <= successCeiling; n++) {
      const bucket = entry.buckets[String(n)] ?? { success_weight: 0, failure_weight: 0 };
      bucket.success_weight += 1.0;
      entry.buckets[String(n)] = bucket;
    }
  } else {
    const prev429Count = entry.consecutive_429_count ?? 0;
    const new429Count = outcome.outcome === "rate_limited" ? prev429Count + 1 : prev429Count;
    entry.consecutive_429_count = new429Count;
    // last_429_at records a rate-limit/quota signal only. A 'timeout' or generic
    // 'error' outcome is explicitly distinguished from 'rate_limited' by the
    // ObservedWaveOutcome contract and must NOT stamp a 429 timestamp, or the
    // field's meaning (and any consumer keying off it) is corrupted.
    if (outcome.outcome === "rate_limited") {
      entry.last_429_at = new Date().toISOString();
    }

    if (outcome.outcome === "rate_limited" && new429Count > 0) {
      const backoffMs = computeBackoffCooldownMs(new429Count);
      entry.cooldown_until = new Date(Date.now() + backoffMs).toISOString();
    } else if (outcome.cooldown_until) {
      entry.cooldown_until = outcome.cooldown_until;
    }

    const failureWeight = outcome.outcome === "rate_limited"
      ? computeBackoffFailureWeight(new429Count)
      : 1.0;
    // Spread failure evidence from outcome.concurrency through
    // outcome.concurrency + FAILURE_SPREAD_BUCKETS, but cap at
    // MAX_BUCKET_LEVEL + FAILURE_SPREAD_BUCKETS — beyond this ceiling the
    // scan loop in computeMaxSafeConcurrency will never reach, so additional
    // entries only bloat the file.
    const failureCeiling = Math.min(
      outcome.concurrency + FAILURE_SPREAD_BUCKETS,
      MAX_BUCKET_LEVEL + FAILURE_SPREAD_BUCKETS,
    );
    for (let n = outcome.concurrency; n <= failureCeiling; n++) {
      const bucket = entry.buckets[String(n)] ?? { success_weight: 0, failure_weight: 0 };
      bucket.failure_weight += failureWeight;
      entry.buckets[String(n)] = bucket;
    }
  }

  entry.updated_at = new Date().toISOString();
  state.entries[providerModelKey] = entry;
  await writeQuotaState(state);
}
