/**
 * The shared emit-validate-repair seam (O3) — the SOLE definition of the
 * cheapest-first monotonic repair pipeline that every contract's worker result
 * passes through before it is accepted (OBL-emit-validate-repair-seam-o3-contract).
 *
 * The seam is EVERYTHING-AGNOSTIC: it hardcodes no contract id, no validator, no
 * field classification, no model, and no provider. A caller registers a
 * {@link RepairContract} — `{ validate, classifyError, identity }` — for a
 * contract id, then drives a payload through {@link runEmitValidateRepair}. A new
 * contract id therefore registers a validator + classification WITHOUT editing the
 * seam (INV-o3-3 / everything-agnostic).
 *
 * CHEAPEST-FIRST MONOTONIC STAGES (a stage runs only if the prior left a
 * REQUIRED-field error; no LLM call when coercion alone yields clean):
 *
 *   stage1 — deterministic coercion (INV-o3-1):
 *     - drops/empties OPTIONAL sub-objects ONLY (never touches a REQUIRED field);
 *     - backfills tool-owned identity that is RECOVERABLE PER ELEMENT (e.g. the
 *       coordinate is uniform across a single-element array);
 *     - a missing per-element `unit_id` (or any non-recoverable required identity)
 *       on a MULTI-element array escalates the whole payload to `unrepairable` —
 *       it is NEVER homogenized by copying a sibling's id (INV-o3-2, fail-2).
 *
 *   stage2 — bounded ~1-attempt errors-only LLM patch (INV-o3-4):
 *     - runs ONLY if stage1 left REQUIRED-field errors and a patcher is supplied;
 *     - the patch prompt carries ONLY the remaining errors + the payload, never
 *       the whole contract — cheapest viable LLM touch;
 *     - bounded to a single attempt (the caller may set `maxLlmAttempts`, default
 *       1); the validator re-runs after it.
 *     - The patcher MUST run OUTSIDE any held artifact-tree `withFileLock`: the
 *       seam holds no lock and performs no artifact-tree IO, so a caller that
 *       holds the lock must release it before invoking the seam (enforced by the
 *       lock-free contract of this module — it never imports the file lock).
 *
 *   stage3 — re-dispatch signal (INV-o3-5):
 *     - if REQUIRED-field errors remain after stage2, the seam returns
 *       `status: 'unrepairable'` with `stages_applied` ending in `redispatch`,
 *       the SIGNAL the caller turns into a fresh dispatch. The re-dispatched
 *       attempt carries a DISTINCT `result_content_discriminator` (the seam
 *       surfaces the next discriminator via {@link RepairOutcome.redispatch}),
 *       so its idempotencyKey differs from the attempt it replaces.
 *
 * ONE VALIDATOR (INV-o3-6): the seam re-runs the SAME injected canonical
 * `validate` after every stage — it never forks or re-implements validation.
 *
 * IDENTITY PRESERVATION (INV-o3-7): coercion only drops/backfills; it never
 * rewrites the emitted tool-owned identity coordinate, so identityKey /
 * idempotencyKey computed off the repaired payload are UNCHANGED. Only a stage3
 * re-dispatch changes identity, and only via a distinct discriminator.
 *
 * FRICTION (fail-1..7): every drop, backfill, escalation, LLM patch, and repeated
 * repair is recorded through the O1 `captureFrictionEvent` sink (best-effort,
 * never fatal). `warnings` is non-empty whenever `status !== 'clean'`.
 */
import { captureFrictionEvent } from '../friction/captureFrictionEvent.js';
import type { FrictionCaptureArtifact } from '../io/frictionCapture.js';

/** A normalized validation error the seam reasons over (validator-agnostic). */
export interface RepairValidationError {
  /** Dotted path to the offending field (validator's own path token). */
  path: string;
  /** Human-readable message. */
  message: string;
  /**
   * Whether this error sits on a REQUIRED field. Only REQUIRED errors gate stage
   * escalation; an OPTIONAL-field error is something stage1 coercion is allowed
   * to clear by dropping the sub-object.
   */
  required: boolean;
}

/** Outcome of running the canonical validator over a payload. */
export interface RepairValidationResult {
  /** All errors (required + optional). Empty ⟹ clean. */
  errors: RepairValidationError[];
}

/**
 * Classification + deterministic coercion for one contract. The seam asks the
 * contract to coerce its own OPTIONAL sub-objects and backfill its own
 * recoverable identity — the seam owns the staging policy, the contract owns the
 * field semantics.
 */
export interface RepairCoercion {
  /**
   * Deterministically coerce the payload in a NON-DESTRUCTIVE, OPTIONAL-only way:
   * drop/empty optional sub-objects that fail validation, and backfill tool-owned
   * identity that is RECOVERABLE PER ELEMENT. Must NEVER mutate a required
   * identity coordinate by homogenizing across elements.
   *
   * Returns the (possibly new) payload plus the structured record of what it did,
   * so the seam can emit one friction event per change and decide escalation.
   */
  coerce(payload: unknown): RepairCoercionResult;
}

/** What stage1 coercion did to a payload. */
export interface RepairCoercionResult {
  /** The coerced payload (same reference allowed if nothing changed). */
  payload: unknown;
  /** OPTIONAL sub-objects dropped/emptied, by path. */
  drops: string[];
  /** Tool-owned identity fields backfilled per element, by path. */
  backfills: string[];
  /**
   * Set true when a REQUIRED identity field is missing on a MULTI-element array
   * and is NOT recoverable per element — the payload must escalate straight to
   * `unrepairable` rather than be homogenized (INV-o3-2, fail-2).
   */
  unrecoverableIdentity: boolean;
}

/**
 * The errors-only bounded LLM patcher (stage2). Everything-agnostic: the caller
 * wires whatever provider/model it likes. Receives ONLY the current payload and
 * the remaining errors; returns a patched payload (or the same payload if it
 * could not help). MUST be invoked outside any held artifact-tree lock — the seam
 * holds none and does no artifact-tree IO.
 */
export type RepairPatcher = (
  payload: unknown,
  errors: RepairValidationError[],
) => Promise<unknown>;

/** A registered contract: one validator, one classification/coercion policy. */
export interface RepairContract {
  /** Stable contract id (e.g. 'audit_results', 'implement_worker_result'). */
  contractId: string;
  /** The ONE canonical validator, re-run after every stage. Never forked. */
  validate(payload: unknown): RepairValidationResult;
  /** Deterministic OPTIONAL-only coercion + recoverable-identity backfill. */
  coercion: RepairCoercion;
}

export type RepairStatus = 'clean' | 'coerced' | 'patched' | 'unrepairable';

/** A repair stage actually applied, in order. */
export type RepairStage = 'validate' | 'coerce' | 'llm_patch' | 'redispatch';

/** Re-dispatch signal surfaced when the seam exhausts cheaper stages. */
export interface RepairRedispatch {
  /**
   * The 1-based attempt counter for the NEXT dispatch. The caller feeds this to
   * `buildResultContentDiscriminator({ source: 'redispatch', attempt })` so the
   * re-dispatched result carries a distinct discriminator (and idempotencyKey).
   */
  attempt: number;
}

/** The single result shape of the seam (OBL-...-o3-contract). */
export interface RepairOutcome {
  /** The repaired payload (identity-preserving for clean/coerced/patched). */
  repaired_payload: unknown;
  /** Terminal status. */
  status: RepairStatus;
  /** Non-empty whenever status !== 'clean'. */
  warnings: string[];
  /** Remaining REQUIRED-field errors after the last stage (empty unless unrepairable). */
  remaining_errors: RepairValidationError[];
  /** Stages applied, in order. Always begins with 'validate'. */
  stages_applied: RepairStage[];
  /** Present only when status === 'unrepairable': the re-dispatch signal. */
  redispatch?: RepairRedispatch;
}

/** Options for one repair run. */
export interface RunEmitValidateRepairOptions {
  /** The registered contract (validator + coercion). */
  contract: RepairContract;
  /** The worker payload to repair. */
  payload: unknown;
  /** Artifacts dir for friction capture (best-effort). */
  artifactsDir: string;
  /** Per-run id for friction capture keying. */
  runId: string;
  /** Which orchestrator is calling (friction record `tool` field). */
  tool?: FrictionCaptureArtifact['tool'];
  /** Optional bounded LLM patcher (stage2). Omitted ⟹ stage2 is skipped. */
  patcher?: RepairPatcher;
  /** Max bounded LLM attempts (default 1). */
  maxLlmAttempts?: number;
  /**
   * 1-based current attempt counter (default 1). The re-dispatch signal advances
   * it by one so the next attempt carries a distinct discriminator.
   */
  attempt?: number;
}

function requiredErrors(result: RepairValidationResult): RepairValidationError[] {
  return result.errors.filter((e) => e.required);
}

/** Emit one best-effort, de-duped friction event for a repair action. */
async function captureRepair(
  opts: RunEmitValidateRepairOptions,
  idSuffix: string,
  note: string,
  severity: 'info' | 'low' | 'medium' | 'high',
): Promise<void> {
  await captureFrictionEvent(
    opts.artifactsDir,
    opts.runId,
    {
      id: `repair:${opts.contract.contractId}:attempt-${opts.attempt ?? 1}:${idSuffix}`,
      note,
      severity,
      category: 'trap',
      area: opts.contract.contractId,
    },
    opts.tool ?? 'remediate-code',
  );
}

/**
 * Run the cheapest-first monotonic emit-validate-repair pipeline over one
 * payload. See the module header for the full stage contract.
 */
export async function runEmitValidateRepair(
  opts: RunEmitValidateRepairOptions,
): Promise<RepairOutcome> {
  const { contract } = opts;
  const attempt = opts.attempt ?? 1;
  const maxLlmAttempts = Math.max(0, opts.maxLlmAttempts ?? 1);
  const stages_applied: RepairStage[] = ['validate'];
  const warnings: string[] = [];

  // A repeated repair (attempt > 1) is itself friction worth recording (fail-7).
  if (attempt > 1) {
    await captureRepair(
      opts,
      'repeated',
      `Repeated repair pass (attempt ${attempt}) for ${contract.contractId}.`,
      'low',
    );
  }

  // --- stage0: validate as emitted. Clean ⟹ no work, identity untouched. ---
  let payload = opts.payload;
  let validation = contract.validate(payload);
  if (requiredErrors(validation).length === 0 && validation.errors.length === 0) {
    return {
      repaired_payload: payload,
      status: 'clean',
      warnings,
      remaining_errors: [],
      stages_applied,
    };
  }

  // --- stage1: deterministic OPTIONAL-only coercion + recoverable backfill. ---
  const coerced = contract.coercion.coerce(payload);
  stages_applied.push('coerce');

  if (coerced.unrecoverableIdentity) {
    // Multi-element missing required identity → escalate; never homogenize.
    await captureRepair(
      opts,
      'unrecoverable-identity',
      `Unrecoverable per-element identity in ${contract.contractId}; escalating to re-dispatch rather than homogenizing.`,
      'high',
    );
    warnings.push(
      'Required per-element identity missing on a multi-element payload; cannot be recovered deterministically.',
    );
    const remaining = requiredErrors(contract.validate(coerced.payload));
    stages_applied.push('redispatch');
    return {
      repaired_payload: coerced.payload,
      status: 'unrepairable',
      warnings,
      remaining_errors: remaining,
      stages_applied,
      redispatch: { attempt: attempt + 1 },
    };
  }

  payload = coerced.payload;
  for (const drop of coerced.drops) {
    warnings.push(`Dropped invalid OPTIONAL sub-object at ${drop}.`);
    await captureRepair(opts, `drop:${drop}`, `Dropped invalid OPTIONAL sub-object at ${drop} in ${contract.contractId}.`, 'low');
  }
  for (const backfill of coerced.backfills) {
    warnings.push(`Backfilled recoverable tool-owned identity at ${backfill}.`);
    await captureRepair(opts, `backfill:${backfill}`, `Backfilled recoverable tool-owned identity at ${backfill} in ${contract.contractId}.`, 'info');
  }

  validation = contract.validate(payload);
  let remaining = requiredErrors(validation);
  if (remaining.length === 0) {
    // Coercion alone cleared every REQUIRED error → NO LLM call (cheapest-first).
    return {
      repaired_payload: payload,
      status: 'coerced',
      warnings:
        warnings.length > 0
          ? warnings
          : ['Payload required deterministic coercion to validate.'],
      remaining_errors: [],
      stages_applied,
    };
  }

  // --- stage2: bounded errors-only LLM patch (lock-free). ---
  if (opts.patcher && maxLlmAttempts > 0) {
    let llmRound = 0;
    while (llmRound < maxLlmAttempts && remaining.length > 0) {
      llmRound += 1;
      stages_applied.push('llm_patch');
      await captureRepair(
        opts,
        `llm-patch-${llmRound}`,
        `Bounded errors-only LLM patch (round ${llmRound}) for ${contract.contractId}.`,
        'medium',
      );
      let patched: unknown;
      try {
        patched = await opts.patcher(payload, remaining);
      } catch {
        // A failed patch leaves the payload as-is; fall through to re-dispatch.
        break;
      }
      payload = patched;
      validation = contract.validate(payload);
      remaining = requiredErrors(validation);
    }
    if (remaining.length === 0) {
      warnings.push('Payload required a bounded LLM patch to validate.');
      return {
        repaired_payload: payload,
        status: 'patched',
        warnings,
        remaining_errors: [],
        stages_applied,
      };
    }
  }

  // --- stage3: re-dispatch signal. ---
  stages_applied.push('redispatch');
  warnings.push(
    `Repair exhausted coercion${opts.patcher ? ' and bounded LLM patch' : ''}; ${remaining.length} required error(s) remain — re-dispatch required.`,
  );
  await captureRepair(
    opts,
    'redispatch',
    `Repair exhausted cheaper stages for ${contract.contractId}; signalling re-dispatch (next attempt ${attempt + 1}).`,
    'high',
  );
  return {
    repaired_payload: payload,
    status: 'unrepairable',
    warnings,
    remaining_errors: remaining,
    stages_applied,
    redispatch: { attempt: attempt + 1 },
  };
}
