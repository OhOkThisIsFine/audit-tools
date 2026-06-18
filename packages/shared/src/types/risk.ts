import { z } from "zod";

export const RiskItemSchema = z
  .object({
    unit_id: z.string(),
    // Shared 0..10 audit-risk scale (planner-derived; builders cap additive
    // scores at 10). The bound lives here so the contract is single-sourced.
    risk_score: z.number().min(0).max(10),
    signals: z.array(z.string()),
    notes: z.array(z.string()).optional(),
  })
  .strict();
export type RiskItem = z.infer<typeof RiskItemSchema>;

export const RiskRegisterSchema = z
  .object({
    items: z.array(RiskItemSchema),
  })
  .strict();
export type RiskRegister = z.infer<typeof RiskRegisterSchema>;
