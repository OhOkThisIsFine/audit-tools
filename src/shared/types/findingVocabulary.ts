// sites-pinned: tests/audit/lens-selection.test.ts, tests/shared/review-question-contract.test.ts, tests/audit/worker-schema-generation.test.ts
import { z } from "zod";

/** Canonical finding severity vocabulary (most-severe-first). */
export const FindingSeveritySchema = z.enum([
  "critical",
  "high",
  "medium",
  "low",
  "info",
]);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

/** Canonical finding confidence vocabulary (most-confident-first). */
export const FindingConfidenceSchema = z.enum(["high", "medium", "low"]);
export type FindingConfidence = z.infer<typeof FindingConfidenceSchema>;
