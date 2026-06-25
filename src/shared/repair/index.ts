/**
 * `audit-tools/shared/repair` — the single-sourced emit-validate-repair seam (O3).
 * Both orchestrators import the seam from here so the staged repair policy cannot
 * drift between the two halves of the pipeline.
 */
export type {
  RepairValidationError,
  RepairValidationResult,
  RepairCoercion,
  RepairCoercionResult,
  RepairPatcher,
  RepairContract,
  RepairStatus,
  RepairStage,
  RepairRedispatch,
  RepairOutcome,
  RunEmitValidateRepairOptions,
} from './emitValidateRepair.js';
export { runEmitValidateRepair } from './emitValidateRepair.js';

// F4 dispatch-broker seam: the single gated F3<->F4 / O3<->F4 chokepoint.
export type {
  BrokeredDispatchSlot,
  BrokerAdmission,
  BrokeredDispatchDecision,
  BrokeredCompletion,
  BrokerDispatchInput,
  BrokeredRepairDispatch,
} from './brokeredDispatch.js';
export {
  createBrokeredRepairDispatch,
  estimateSlotTokens,
  classifyCapableHost,
} from './brokeredDispatch.js';
