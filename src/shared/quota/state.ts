import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { ObservedWaveOutcome, QuotaState, QuotaStateEntry } from "./types.js";
import { withFileLock } from "./fileLock.js";
import { writeJsonFile } from "../io/json.js";
import {
  hasWindowScope,
  windowSlopeKey,
  type QuotaUsageSnapshot,
  type WindowSlopeKey,
} from "./quotaSource.js";

let _statePath: string | undefined;

export function setQuotaStateDir(dir: string): void {
  _statePath = join(dir, "quota-state.json");
}

export function getQuotaStatePath(): string {
  if (!_statePath) throw new Error("Quota state dir not set — call setQuotaStateDir() first.");
  return _statePath;
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
  const entries: Record<string, QuotaStateEntry> = {};
  for (const [key, entry] of Object.entries(state.entries)) {
    entries[key] = normalizeEntry(entry);
  }
  await writeJsonFile(getQuotaStatePath(), { version: 2, entries } satisfies QuotaState);
}

/**
 * Project an entry onto the v2 field set. A file written by an older build carries
 * a `buckets` blob from the deleted concurrency learner; reading it round-trips
 * harmlessly, but persisting it back under a `version: 2` stamp — which is
 * supposed to mean "no bucket learner" — would keep the dead field alive forever.
 * Writing is the migration.
 */
function normalizeEntry(entry: QuotaStateEntry): QuotaStateEntry {
  const normalized: QuotaStateEntry = {
    updated_at: entry.updated_at,
    cooldown_until: entry.cooldown_until,
    last_429_at: entry.last_429_at,
  };
  if (entry.consecutive_429_count !== undefined) {
    normalized.consecutive_429_count = entry.consecutive_429_count;
  }
  if (entry.tokens_per_pct !== undefined) normalized.tokens_per_pct = entry.tokens_per_pct;
  if (entry.output_per_input !== undefined) normalized.output_per_input = entry.output_per_input;
  return normalized;
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
  slopeKey: WindowSlopeKey,
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
  const previous = base[slopeKey];
  const blended =
    typeof previous === "number" && Number.isFinite(previous) && previous > 0
      ? previous * (1 - TOKENS_PER_PCT_EWMA_ALPHA) + sampleSlope * TOKENS_PER_PCT_EWMA_ALPHA
      : sampleSlope;
  return { ...base, [slopeKey]: blended };
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
  slopeKey: WindowSlopeKey,
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
      slopeKey,
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

/**
 * One window's remaining-percent reading paired with the `reset_at` identity
 * it was read against, so two readings of the "same" label taken at different
 * times can be checked for a window ROLLOVER (see the P1 guard in
 * {@link foldSlopeObservationFromPctMaps}) before their percents are diffed.
 */
export interface QuotaWindowPctReading {
  remainingPct: number;
  /** The window's `reset_at` at the time of this reading, or null when the source didn't report one (rollover detection is then skipped for this reading — an unknown reset identity never blocks a fold it can't judge). */
  resetAt: string | null;
}

/**
 * Build a {@link windowSlopeKey} → {@link QuotaWindowPctReading} map from a quota
 * usage snapshot. Falls back to a single account-scoped `"default"` window when the
 * source has no per-window breakdown (single-window providers — matching the
 * synthetic window the scheduler derives for the same case). Returns an empty map
 * for a null/absent snapshot or one with no usable percent reading.
 *
 * Keyed by `(scope, label)` so a slope sample is attributed to the same partition
 * the budget will later be metered against — keying by bare label would blend an
 * account-wide and a model-scoped window that happen to share a group name.
 *
 * Single-sourced so the in-process rolling dispatcher and the host-dispatch
 * merge path attribute a slope sample against the SAME window semantics —
 * see {@link foldSlopeObservationFromSnapshots}.
 *
 * ⚠ A window with no usable `scope` is SKIPPED (loudly), never keyed. This path is
 * fed PERSISTED snapshots — `dispatch-quota.json` written before scope existed, read
 * back raw with no schema parse — so scope-less windows are real on disk, not a
 * hypothetical. Two rejected alternatives: keying them anyway produces
 * `"undefined:<label>"`, which no reader ever looks up, so the slope is silently
 * orphaned; and THROWING would break {@link foldSlopeObservationFromSnapshots}'s
 * documented "never throws" contract and kill slope learning on any run resumed
 * across the upgrade. Skipping costs one window's slope sample, says so, and lets
 * the rest of the fold proceed.
 */
export function quotaSnapshotWindowPctMap(
  snapshot: QuotaUsageSnapshot | null | undefined,
): Map<WindowSlopeKey, QuotaWindowPctReading> {
  const map = new Map<WindowSlopeKey, QuotaWindowPctReading>();
  if (!snapshot) return map;
  if (snapshot.windows && snapshot.windows.length > 0) {
    for (const w of snapshot.windows) {
      if (!hasWindowScope(w)) {
        process.stderr.write(
          `[quota] window "${w.label}" from ${snapshot.source} carries no metering scope; ` +
            `skipping its slope sample (a pre-scope persisted snapshot re-learns on the next probe)\n`,
        );
        continue;
      }
      if (w.remaining_pct != null && Number.isFinite(w.remaining_pct)) {
        map.set(windowSlopeKey(w.scope, w.label), {
          remainingPct: w.remaining_pct,
          resetAt: w.reset_at ?? null,
        });
      }
    }
  } else if (snapshot.remaining_pct != null && Number.isFinite(snapshot.remaining_pct)) {
    map.set(windowSlopeKey("account", "default"), {
      remainingPct: snapshot.remaining_pct,
      resetAt: snapshot.reset_at ?? null,
    });
  }
  return map;
}

/**
 * Attribute tokens dispatched between a PRE and POST window-pct reading (as
 * produced by {@link quotaSnapshotWindowPctMap}) to whichever windows moved
 * past {@link MIN_SLOPE_DELTA_PERCENT}, folding one
 * {@link recordTokensPerPctObservation} sample per moved window.
 *
 * This is the single-sourced fold CORE behind both slope-learning call sites:
 * the in-process rolling dispatcher (`rollingDispatch.ts`'s `observeSlope`,
 * which baselines a live-polled snapshot per pool across a run) and the
 * host-dispatch merge path (`mergeAndIngestCommand.ts` via
 * {@link foldSlopeObservationFromSnapshots}, which has only a pre-grant
 * snapshot and a post-merge re-probe — one pair per wave, not a continuous
 * poll). Both feed the same math so the two engines cannot drift on how a
 * sample is attributed.
 *
 * No-op (never throws) when `tokensDispatched` is non-positive/non-finite, or
 * when no window appears in both maps with a meaningful Δpercent — mirroring
 * {@link foldTokensPerPctObservation}'s own degrade-safe floor so the
 * pre-check here is an optimization (skip the locked write), not a second
 * source of truth for the threshold. A per-window
 * `recordTokensPerPctObservation` failure is swallowed: slope learning must
 * never abort the caller — but (C2) the label is only reported as FOLDED once
 * the write actually SUCCEEDS, so a swallowed throw never falsely reports
 * "slope updated" to the caller.
 *
 * P1 window-identity guard: a label present on both sides is only diffed when
 * neither reading's `reset_at` is known to differ from the other's. A window
 * ROLLOVER between the PRE and POST reading (e.g. remaining_pct=0.5 in the old
 * window resets to 1.0, then drains to 0.3 in the new one) would otherwise
 * compute a slope against a fake ~20-point drop instead of the real ~70-point
 * one — worse, in a case where the new window's drop is SMALLER than the old
 * window's remaining budget, the "delta" can even look like an increase and get
 * caught by the zero/negative-delta floor below, or look like a small dip and
 * silently understate the slope. Either way it is not a same-window
 * measurement, so it is skipped rather than folded.
 *
 * Returns the window labels actually folded, so a caller that re-baselines on
 * any fold (the in-process dispatcher) can tell whether one occurred without
 * re-deriving the same comparison.
 */
export async function foldSlopeObservationFromPctMaps(
  providerModelKey: string,
  priorPctByKey: Map<WindowSlopeKey, QuotaWindowPctReading>,
  currentPctByKey: Map<WindowSlopeKey, QuotaWindowPctReading>,
  tokensDispatched: number,
): Promise<string[]> {
  const folded: string[] = [];
  if (!Number.isFinite(tokensDispatched) || tokensDispatched <= 0) return folded;
  for (const [slopeKey, prior] of priorPctByKey) {
    const current = currentPctByKey.get(slopeKey);
    if (current == null) continue;
    if (prior.resetAt != null && current.resetAt != null && prior.resetAt !== current.resetAt) {
      // P1: same label, different window instance — a rollover, not consumption.
      continue;
    }
    // Zero/negative-delta guard: post_pct >= pre_pct (no consumption, or an
    // increase — e.g. a window that reopened) must never fold. This is also
    // enforced inside foldTokensPerPctObservation/recordTokensPerPctObservation
    // itself via MIN_SLOPE_DELTA_PERCENT, but checking it here too means a
    // non-positive delta never even reaches the locked write.
    if ((prior.remainingPct - current.remainingPct) * 100 < MIN_SLOPE_DELTA_PERCENT) continue;
    try {
      await recordTokensPerPctObservation(
        providerModelKey,
        slopeKey,
        prior.remainingPct,
        current.remainingPct,
        tokensDispatched,
      );
      // C2: push only AFTER a successful write — a throw below is caught and
      // swallowed (slope learning must never abort the caller) WITHOUT this
      // label being reported as folded.
      folded.push(slopeKey);
    } catch {
      // Non-fatal: slope learning must never abort the caller.
    }
  }
  return folded;
}

/**
 * Snapshot-based convenience wrapper over {@link foldSlopeObservationFromPctMaps}:
 * maps a PRE and POST {@link QuotaUsageSnapshot} through
 * {@link quotaSnapshotWindowPctMap} and folds the result. The natural entry
 * point for a caller (the host-dispatch merge path) that holds two whole
 * snapshots rather than pre-extracted per-window maps.
 */
export async function foldSlopeObservationFromSnapshots(
  providerModelKey: string,
  priorSnapshot: QuotaUsageSnapshot | null | undefined,
  currentSnapshot: QuotaUsageSnapshot | null | undefined,
  tokensDispatched: number,
): Promise<string[]> {
  return foldSlopeObservationFromPctMaps(
    providerModelKey,
    quotaSnapshotWindowPctMap(priorSnapshot),
    quotaSnapshotWindowPctMap(currentSnapshot),
    tokensDispatched,
  );
}

function blankEntry(): QuotaStateEntry {
  return { updated_at: new Date().toISOString(), cooldown_until: null, last_429_at: null };
}

export const BASE_COOLDOWN_MS = 60_000;
export const MAX_COOLDOWN_MS = 15 * 60_000;

export function computeBackoffCooldownMs(consecutive429Count: number): number {
  const ms = BASE_COOLDOWN_MS * Math.pow(2, Math.max(0, consecutive429Count - 1));
  return Math.min(ms, MAX_COOLDOWN_MS);
}

/**
 * Record the outcome of a dispatched wave against a pool's quota entry: a success
 * clears the cooldown and the 429 streak; a 429 extends both.
 *
 * It records no concurrency evidence. Concurrency is DECLARED by the provider
 * (`source.quota.max_concurrent` → `CapacityPool.concurrencyCap`) or ABSENT, in
 * which case quota headroom and rate limits are the only throttle. Inferring a
 * safe concurrency from an outcome stream is a category error — see
 * `spec/audit/dispatch-admission-control.md`.
 */
export async function recordWaveOutcome(
  providerModelKey: string,
  outcome: ObservedWaveOutcome,
): Promise<void> {
  const lockPath = getQuotaStatePath() + ".lock";
  await withFileLock(lockPath, () => recordWaveOutcomeUnsafe(providerModelKey, outcome));
}

async function recordWaveOutcomeUnsafe(
  providerModelKey: string,
  outcome: ObservedWaveOutcome,
): Promise<void> {
  const state = await readQuotaStateForUpdate("recordWaveOutcome");
  const entry = state.entries[providerModelKey] ?? blankEntry();

  if (outcome.outcome === "success") {
    // A success does NOT cancel a live cooldown. Packets run concurrently, so a
    // success completing at T+2s was almost certainly dispatched BEFORE the 429
    // at T — it is not evidence the rate limit is over. Clearing the cooldown
    // here would let the very next invocation schedule a full-width wave into a
    // still-throttled pool AND restart the exponential backoff from its base.
    // Only an already-expired cooldown is cleared (which also self-heals an
    // unparseable timestamp, since NaN > now is false).
    const cooldownActive =
      entry.cooldown_until != null && new Date(entry.cooldown_until).getTime() > Date.now();
    if (!cooldownActive) {
      entry.consecutive_429_count = 0;
      entry.cooldown_until = null;
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
  }

  entry.updated_at = new Date().toISOString();
  state.entries[providerModelKey] = entry;
  await writeQuotaState(state);
}
