// F3 — schema-enforced worker generation.
//
// This is the emit-time half of the F3 ↔ F4 ↔ O3 seam set. At emit, a worker
// result is enforced against the canonical worker-facing zod schema
// (`workerSchemas.ts`). The strongest available enforcement is chosen ONCE from
// the provider's discovered `OutputConstraintCapability` (F3 ↔ F4: the descriptor
// is read here, never recomputed):
//
//   - `forced_tool_call` / `json_schema_constrained` / `structured_output` — the
//     backend already constrained its output, so the emitted payload is expected
//     to validate; we still re-run the canonical zod validate as the single
//     authority (defence-in-depth, no second validator).
//   - `none` — no structural guarantee from the backend; the payload MUST go
//     through the O3 emit-validate-repair seam to be salvaged.
//
// On capability `none` OR a validation failure under any mode, the payload is
// degraded through O3's `runEmitValidateRepair`. Its bounded stage-2 LLM patch is
// routed through F4's shared `BrokeredRepairDispatch` seam — the emit path NEVER
// spawns a re-dispatch directly; every LLM touch flows through the single gated
// broker chokepoint (broker-handle edge O3 ↔ F4).

import type { z } from "zod";
import {
  runEmitValidateRepair,
  type BrokeredRepairDispatch,
  type BrokerDispatchInput,
  type RepairContract,
  type RepairOutcome,
  type RepairPatcher,
  type RepairValidationError,
  type RepairValidationResult,
} from "audit-tools/shared";
import type {
  FreshSessionProvider,
  OutputConstraintCapability,
  OutputConstraintMode,
} from "audit-tools/shared";

/**
 * Build a {@link RepairContract} from a worker-facing zod schema. The zod schema
 * is the ONE canonical validator (re-run after every repair stage). Errors on a
 * field that is `optional()` in the schema map to `required: false`, so O3's
 * stage-1 coercion is allowed to clear them by dropping the optional sub-object;
 * everything else is `required: true`.
 *
 * Coercion here is intentionally a NO-OP (the schema-of-record owns no
 * deterministic drop/backfill policy beyond zod's own parse): O3 will fall
 * straight to its bounded LLM patch / re-dispatch stages when a REQUIRED error
 * remains. A contract that wants deterministic coercion supplies its own.
 */
export function buildWorkerRepairContract(
  contractId: string,
  schema: z.ZodTypeAny,
): RepairContract {
  return {
    contractId,
    validate(payload: unknown): RepairValidationResult {
      const parsed = schema.safeParse(payload);
      if (parsed.success) return { errors: [] };
      const errors: RepairValidationError[] = parsed.error.issues.map(
        (issue) => ({
          path: issue.path.join("."),
          message: issue.message,
          // A missing required key is reported by zod as `invalid_type` with
          // `received: "undefined"`; an `unrecognized_keys` issue is a strict()
          // violation. Both gate escalation. Optional fields never produce a
          // "Required" issue, so any issue zod emits here sits on a constraint
          // the worker must satisfy → required.
          required: true,
        }),
      );
      return { errors };
    },
    coercion: {
      coerce(payload: unknown) {
        return {
          payload,
          drops: [],
          backfills: [],
          unrecoverableIdentity: false,
        };
      },
    },
  };
}

/** Inputs for one schema-enforced emit. */
export interface SchemaEnforcedEmitInput {
  /** Stable contract id (e.g. 'audit_results'). */
  contractId: string;
  /** The canonical worker-facing zod schema to enforce. */
  schema: z.ZodTypeAny;
  /** The raw worker payload emitted by the backend. */
  payload: unknown;
  /**
   * The dispatching provider. Its discovered {@link OutputConstraintCapability} is
   * READ here (never recomputed) to decide whether the emit had any structural
   * guarantee. A provider whose descriptor is absent is treated as `none`.
   */
  provider: Pick<FreshSessionProvider, "outputConstraint">;
  /** The shared F4 broker — the SOLE route for any repair LLM touch. */
  broker: BrokeredRepairDispatch;
  /**
   * The broker dispatch context (provider/session/host) for the repair slot,
   * minus the `slots` array (the emit path supplies its own single repair slot).
   * The broker's admission decision gates whether the bounded LLM patch runs at
   * all — an over-budget / cooled-down pool means no LLM touch.
   */
  brokerContext: Omit<BrokerDispatchInput, "slots">;
  /** Artifacts dir for O3 friction capture (best-effort). */
  artifactsDir: string;
  /** Per-run id for friction capture keying. */
  runId: string;
  /** Which orchestrator is emitting (friction record `tool` field). */
  tool?: "audit-code" | "remediate-code";
  /**
   * Bounded errors-only LLM patch (O3 stage-2). The PATCH ITSELF is the caller's
   * provider call, but it is invoked from inside `runEmitValidateRepair` only
   * after the broker has admitted the repair slot (see {@link enforceSchemaAtEmit}).
   * Omit to skip stage-2 (coercion + re-dispatch only).
   */
  patcher?: RepairPatcher;
  /** 1-based current attempt counter (default 1). */
  attempt?: number;
}

/** The single result of a schema-enforced emit. */
export interface SchemaEnforcedEmitResult {
  /** The constraint mode actually in force for this emit (read from the provider). */
  mode: OutputConstraintMode;
  /** The O3 repair outcome (status, repaired payload, warnings, re-dispatch signal). */
  repair: RepairOutcome;
}

/** Resolve the emit's constraint mode from the provider descriptor (absent ⟹ none). */
export function resolveEmitConstraint(
  provider: Pick<FreshSessionProvider, "outputConstraint">,
): OutputConstraintCapability {
  return (
    provider.outputConstraint ?? {
      mode: "none",
      reason: "provider exposes no discovered output-constraint capability",
    }
  );
}

/**
 * Enforce the canonical worker schema at emit time, degrading through the O3
 * emit-validate-repair seam when there is no structural guarantee or the payload
 * fails to validate. The stage-2 LLM patch is gated by F4's broker: a single
 * repair slot is offered to `broker.broker`, and the bounded patcher only runs if
 * the broker admits it. A refused/cooled-down broker means no LLM touch — O3 then
 * falls to its deterministic coercion + re-dispatch signal. The seam NEVER spawns
 * a dispatch itself.
 */
export async function enforceSchemaAtEmit(
  input: SchemaEnforcedEmitInput,
): Promise<SchemaEnforcedEmitResult> {
  const constraint = resolveEmitConstraint(input.provider);
  const contract = buildWorkerRepairContract(input.contractId, input.schema);

  // Gate the bounded LLM patch through the single F4 broker chokepoint. We offer
  // exactly one repair slot sized from the payload's byte length; the patcher runs
  // ONLY if the broker admits the slot. `awaitNextCompletion` passes the raw
  // patched result straight back to O3's canonical validator (broker-handle edge).
  let brokeredPatcher: RepairPatcher | undefined;
  if (input.patcher) {
    const slotId = `${input.contractId}:repair:${input.runId}`;
    brokeredPatcher = async (payload, errors) => {
      const payloadBytes = Buffer.byteLength(safeStringify(payload), "utf8");
      const decision = input.broker.broker({
        ...input.brokerContext,
        slots: [{ slotId, payloadBytes }],
      });
      if (decision.admitted < 1 || !decision.admittedSlotIds.includes(slotId)) {
        // Broker refused (over budget / cooldown) → no LLM touch. Return the
        // payload unchanged so O3 falls to its deterministic re-dispatch signal.
        return payload;
      }
      const patched = await input.patcher!(payload, errors);
      const { rawResult } = input.broker.awaitNextCompletion({
        slotId,
        rawResult: patched,
      });
      return rawResult;
    };
  }

  const repair = await runEmitValidateRepair({
    contract,
    payload: input.payload,
    artifactsDir: input.artifactsDir,
    runId: input.runId,
    tool: input.tool,
    // Capability `none` keeps the patcher available (degrade path); a constrained
    // mode still validates and only patches if the constrained output drifted.
    patcher: brokeredPatcher,
    attempt: input.attempt,
  });

  return { mode: constraint.mode, repair };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
