import { z } from "zod";

export const EXECUTION_RECORD_CONTRACT_VERSION =
  "execution-record/v1alpha1" as const;

export const ExecutionRecordOutcomeSchema = z.enum(["accepted", "rejected"]);
export type ExecutionRecordOutcome = z.infer<
  typeof ExecutionRecordOutcomeSchema
>;

export const ExecutorReportedStatementSchema = z
  .object({
    label: z.string().min(1),
    statement: z.string().min(1),
  })
  .strict();
export type ExecutorReportedStatement = z.infer<
  typeof ExecutorReportedStatementSchema
>;

/**
 * Provider-agnostic acknowledgement of externally executed work.
 *
 * audit-tools binds the record to its work item and accepts or rejects it; the
 * host may identify itself in prose, but backend, model, routing, and transport
 * details are deliberately outside this contract.
 */
export const ExecutionRecordV1Alpha1Schema = z
  .object({
    contract_version: z.literal(EXECUTION_RECORD_CONTRACT_VERSION),
    record_id: z.string().min(1),
    work_item_id: z.string().min(1),
    outcome: ExecutionRecordOutcomeSchema,
    executor_reported: ExecutorReportedStatementSchema,
  })
  .strict();
export type ExecutionRecordV1Alpha1 = z.infer<
  typeof ExecutionRecordV1Alpha1Schema
>;
