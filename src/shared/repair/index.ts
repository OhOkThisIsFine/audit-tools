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
