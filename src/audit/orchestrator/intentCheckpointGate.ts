/**
 * O2 — the intent_checkpoint semantic-equivalence gate.
 *
 * The ONE place that decides whether a re-confirmed intent_checkpoint value is
 * semantically EQUIVALENT to the prior one (so dependents need not re-stale) or
 * CHANGED (so the `intent_checkpoint_current` obligation must re-fire and
 * downstream artifacts re-derive). A raw byte/JSON compare over-stales: a host
 * re-confirming the same intent with reordered keys, whitespace, or a benign
 * rephrase would needlessly invalidate the whole planning tree. A pure structural
 * compare under-stales: a genuine intent change phrased to hash-collide on the
 * normalized form would be silently dropped. So the gate is
 * normalize-then-bounded-LLM-judge:
 *
 *  1. NORMALIZE both values deterministically (`normalizeCheckpointValue`). Equal
 *     normal forms ⟹ `unchanged` with no judge call (the common, free case).
 *  2. Otherwise a BOUNDED LLM judge decides semantic equivalence. The judge is
 *     FAIL-SAFE: any uncertain / errored / malformed verdict resolves to
 *     `'changed'` (INV-O2-fail-3) — the gate never silently treats an
 *     unverified pair as equivalent.
 *
 * VERSION-KEYED VERDICT CACHE (INV-O2-inv-5): a judge verdict is cached on
 * `(priorValue, newValue, gate_version)`. `gate_version` is a LOCALLY-resolved
 * token — `hash(normalizeConfig) + judge-id token + prompt-template version` —
 * computed with NO network/API probe (INV-O2-inv-6). Bumping the normalize
 * config, swapping the locally-resolved judge, or revising the prompt template
 * invalidates every cached verdict deterministically; an unchanged trio is a
 * cache hit so a re-confirm never re-pays the judge.
 *
 * LOCK INTERLEAVE DISCIPLINE (INV-O2-inv-7 / inv-8, the O2 lock contract): the
 * judge is SLOW and MUST run OUTSIDE the artifact-tree lock. `runIntentCheckpointGate`
 * therefore: reads a ledger/version token under the lock, releases, runs the
 * judge unlocked, then RE-ACQUIRES the lock and compares the token captured at
 * read against the token now. Any interleaved append (token moved) forces a
 * re-derive — bounded to N attempts. On exhaustion it falls back to taking the
 * lock ACROSS the judge for one final guaranteed-committing derivation, and
 * records that fallback firing through the best-effort friction sink (CE-010
 * residual: a contended friction append under the held non-reentrant lock is
 * swallowed best-effort, never blocking the commit).
 */
import { captureFrictionEvent, hashContent, stableStringify } from 'audit-tools/shared';
import type { IntentCheckpoint } from 'audit-tools/shared';

/** A gate verdict over a (prior, new) intent_checkpoint pair. */
export type IntentCheckpointVerdict = 'unchanged' | 'changed';

/**
 * The bounded LLM judge. Returns `true` iff the two normalized intent values are
 * semantically EQUIVALENT. A judge that is uncertain, errors, or returns a
 * non-boolean is treated as `changed` by the caller (fail-safe) — the judge
 * itself need not encode that policy. Provider-agnostic: the host supplies the
 * actual LLM call; the gate never reaches for a specific backend.
 */
export type SemanticEquivalenceJudge = (input: {
  priorNormalized: string;
  newNormalized: string;
}) => Promise<boolean> | boolean;

/**
 * Deterministic normalization config. Bumping any field bumps `gate_version` and
 * invalidates every cached verdict. Kept as data (not code) so the version hash
 * captures the active policy, not the module's source text.
 */
export interface NormalizeConfig {
  /** Schema/recipe version of the normalization itself. Bump on any change. */
  readonly version: string;
  /**
   * Checkpoint fields that carry SEMANTIC intent and participate in the normal
   * form. Volatile/provenance fields (timestamps, confirmed_by, schema_version)
   * are excluded so a benign re-confirm normalizes identically.
   */
  readonly semanticFields: readonly (keyof IntentCheckpoint)[];
}

/** The single active normalization config (INV-O2-inv-5 input). */
export const DEFAULT_NORMALIZE_CONFIG: NormalizeConfig = {
  version: 'intent-checkpoint-normalize/v1',
  semanticFields: ['scope_summary', 'intent_summary', 'free_form_intent', 'constraint_clauses'],
};

/** Static prompt-template version — bump on any judge-prompt change. */
export const INTENT_GATE_PROMPT_TEMPLATE_VERSION = 'intent-checkpoint-judge-prompt/v1';

/**
 * Deterministically normalize an intent_checkpoint value to its semantic normal
 * form. Only `config.semanticFields` participate; values are canonically
 * serialized (stable key order) so reordering/whitespace is invisible. An absent
 * checkpoint normalizes to a stable empty marker so present-vs-absent is a real
 * difference, not a crash.
 */
export function normalizeCheckpointValue(
  checkpoint: IntentCheckpoint | undefined,
  config: NormalizeConfig = DEFAULT_NORMALIZE_CONFIG,
): string {
  if (!checkpoint) return stableStringify({ __absent: true });
  const projection: Record<string, unknown> = {};
  for (const field of config.semanticFields) {
    const value = checkpoint[field];
    if (value !== undefined) {
      // free_form_intent is whitespace-insensitive at the edges; clauses/objects
      // are compared structurally via the stable serializer.
      projection[field as string] =
        typeof value === 'string' ? value.trim() : value;
    }
  }
  return stableStringify(projection);
}

/**
 * Compute the LOCALLY-resolved `gate_version` cache key component:
 * `hash(normalizeConfig) + judge-id token + prompt-template version`.
 *
 * NO network/API probe (INV-O2-inv-6): the judge id is a caller-supplied LOCAL
 * token (e.g. a configured model id string already known to the host, or a
 * sentinel like `'host'`), never a live capability query. Bumping the normalize
 * config, the judge id, or the prompt template deterministically invalidates the
 * verdict cache.
 */
export function computeGateVersion(input: {
  normalizeConfig?: NormalizeConfig;
  /** Locally-resolved judge id token. No probe; supplied by the host. */
  judgeId: string;
  promptTemplateVersion?: string;
}): string {
  const normalizeConfig = input.normalizeConfig ?? DEFAULT_NORMALIZE_CONFIG;
  const promptTemplateVersion =
    input.promptTemplateVersion ?? INTENT_GATE_PROMPT_TEMPLATE_VERSION;
  const configHash = hashContent(stableStringify(normalizeConfig), { length: 16 });
  return `${configHash}:${input.judgeId}:${promptTemplateVersion}`;
}

/** A cached verdict keyed on (priorNormalized, newNormalized, gate_version). */
export interface VerdictCache {
  get(key: string): IntentCheckpointVerdict | undefined;
  set(key: string, verdict: IntentCheckpointVerdict): void;
}

/** Build the deterministic verdict-cache key from the version-keyed trio. */
export function verdictCacheKey(
  priorNormalized: string,
  newNormalized: string,
  gateVersion: string,
): string {
  return hashContent(
    stableStringify([priorNormalized, newNormalized, gateVersion]),
  );
}

/**
 * The normalize-then-bounded-LLM-judge equivalence gate.
 *
 * 1. Normalize both values; equal normal forms ⟹ `unchanged`, no judge call.
 * 2. Cache hit on (priorNormalized, newNormalized, gate_version) ⟹ cached verdict.
 * 3. Otherwise run the bounded judge; FAIL-SAFE — uncertain/errored/non-boolean
 *    ⟹ `'changed'`. Cache and return.
 *
 * Pure decision: holds no lock and does no artifact IO. The lock-interleave
 * discipline lives in `runIntentCheckpointGate`.
 */
export async function intentCheckpointEquivalenceGate(input: {
  prior: IntentCheckpoint | undefined;
  next: IntentCheckpoint | undefined;
  judge: SemanticEquivalenceJudge;
  judgeId: string;
  normalizeConfig?: NormalizeConfig;
  promptTemplateVersion?: string;
  cache?: VerdictCache;
}): Promise<{ verdict: IntentCheckpointVerdict; gateVersion: string; judged: boolean }> {
  const config = input.normalizeConfig ?? DEFAULT_NORMALIZE_CONFIG;
  const priorNormalized = normalizeCheckpointValue(input.prior, config);
  const newNormalized = normalizeCheckpointValue(input.next, config);
  const gateVersion = computeGateVersion({
    normalizeConfig: config,
    judgeId: input.judgeId,
    promptTemplateVersion: input.promptTemplateVersion,
  });

  if (priorNormalized === newNormalized) {
    return { verdict: 'unchanged', gateVersion, judged: false };
  }

  const cacheKey = verdictCacheKey(priorNormalized, newNormalized, gateVersion);
  const cached = input.cache?.get(cacheKey);
  if (cached !== undefined) {
    return { verdict: cached, gateVersion, judged: false };
  }

  let verdict: IntentCheckpointVerdict;
  try {
    const equivalent = await input.judge({ priorNormalized, newNormalized });
    // FAIL-SAFE: only an explicit `true` resolves to unchanged; anything else
    // (false, non-boolean, undefined) is treated as changed.
    verdict = equivalent === true ? 'unchanged' : 'changed';
  } catch {
    // FAIL-SAFE: a judge error never silently passes as equivalent.
    verdict = 'changed';
  }
  input.cache?.set(cacheKey, verdict);
  return { verdict, gateVersion, judged: true };
}

// ---------------------------------------------------------------------------
// Lock-interleave discipline (INV-O2-inv-7 / inv-8)
// ---------------------------------------------------------------------------

/**
 * A monotonic ledger/version token capturing the artifact-tree state at read.
 * Any interleaved append moves it; comparing the read-time token to the
 * post-judge token detects an interleave that must force a re-derive.
 */
export type LedgerVersionToken = string;

/**
 * Run the intent_checkpoint gate under the O2 lock-interleave discipline.
 *
 * The judge is SLOW and runs OUTSIDE the held lock. Sequence per attempt:
 *  1. Acquire the lock; read the current ledger/version token; release.
 *  2. Run the bounded equivalence gate (judge) UNLOCKED.
 *  3. Re-acquire the lock; read the token again. If unchanged, COMMIT the verdict
 *     under the lock and return. If an interleaved append moved the token,
 *     release and re-derive (bounded to `maxAttempts`).
 *  4. On attempt exhaustion, take the lock ACROSS the judge for one final
 *     guaranteed-committing derivation, recording the fallback firing through the
 *     best-effort friction sink (CE-010 residual — never blocks the commit).
 *
 * `withLock` is the artifact-tree lock wrapper (e.g. `withFileLock` bound to the
 * artifact-tree lock path); `commit` persists the decided verdict under the held
 * lock and is the single mutation point.
 */
export async function runIntentCheckpointGate<T>(deps: {
  withLock: <R>(fn: () => Promise<R>) => Promise<R>;
  readLedgerToken: () => Promise<LedgerVersionToken>;
  gate: () => Promise<{ verdict: IntentCheckpointVerdict; gateVersion: string }>;
  commit: (verdict: IntentCheckpointVerdict) => Promise<T>;
  /** Best-effort friction recording of the lock-across-judge fallback firing. */
  artifactsDir?: string;
  runId?: string;
  maxAttempts?: number;
}): Promise<{ verdict: IntentCheckpointVerdict; committed: T; usedFallback: boolean }> {
  const maxAttempts = deps.maxAttempts ?? 3;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // (1) Capture the read-time token under the lock, then release.
    const readToken = await deps.withLock(() => deps.readLedgerToken());

    // (2) Run the slow judge UNLOCKED.
    const { verdict } = await deps.gate();

    // (3) Re-acquire; if no interleave, commit under the lock.
    const outcome = await deps.withLock(async () => {
      const nowToken = await deps.readLedgerToken();
      if (nowToken !== readToken) {
        // Interleaved append — bail out of this attempt and re-derive.
        return { committed: undefined as T | undefined, interleaved: true };
      }
      const committed = await deps.commit(verdict);
      return { committed, interleaved: false };
    });

    if (!outcome.interleaved) {
      return { verdict, committed: outcome.committed as T, usedFallback: false };
    }
    // else: token moved during the unlocked judge — loop and re-derive.
  }

  // (4) Attempts exhausted under repeated contention: take the lock ACROSS the
  // judge for one final guaranteed-committing derivation. Record the fallback
  // firing best-effort (CE-010 residual: a contended friction append under the
  // held non-reentrant lock is swallowed best-effort, never blocking the commit).
  return deps.withLock(async () => {
    if (deps.artifactsDir && deps.runId) {
      // Fire-and-forget but awaited: captureFrictionEvent is itself best-effort
      // and never throws, so it can never block the commit below.
      await captureFrictionEvent(
        deps.artifactsDir,
        deps.runId,
        {
          id: `intent-gate-lock-across-judge-fallback:${deps.runId}`,
          category: 'trap',
          severity: 'low',
          area: 'intent_checkpoint gate',
          note:
            'intent_checkpoint gate fell back to taking the lock across the LLM judge after ' +
            `${maxAttempts} interleaved re-derive attempts; one guaranteed-committing derivation ran under the held lock.`,
        },
        'audit-code',
      );
    }
    const { verdict } = await deps.gate();
    const committed = await deps.commit(verdict);
    return { verdict, committed, usedFallback: true };
  });
}
