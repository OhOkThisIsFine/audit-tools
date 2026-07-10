import { z } from "zod";
import { ObligationSchema } from "audit-tools/shared";

export const AuditTopLevelStatusSchema = z.enum([
  "not_started",
  "active",
  "blocked",
  "complete",
]);
export type AuditTopLevelStatus = z.infer<typeof AuditTopLevelStatusSchema>;

// The obligation vocabulary is single-sourced in the shared obligation engine
// (A3). `ObligationState` is re-exported so audit-code call sites keep importing
// it from here; `AuditObligation` is the domain alias of the shared `Obligation`
// ({id, state, reason?}) — same shape, named for the audit context.
export type { ObligationState } from "audit-tools/shared";
export const AuditObligationSchema = ObligationSchema;
export type AuditObligation = z.infer<typeof AuditObligationSchema>;

export const AuditStateSchema = z
  .object({
    status: AuditTopLevelStatusSchema,
    last_executor: z.string().optional(),
    last_obligation: z.string().optional(),
    blockers: z.array(z.string()).optional(),
    obligations: z.array(AuditObligationSchema),
  })
  .strict();
export type AuditState = z.infer<typeof AuditStateSchema>;
