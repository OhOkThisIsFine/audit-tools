// sites-pinned: tests/audit/analyzer-run-consent.test.ts, tests/audit/analyzer-consent-offer.test.ts, tests/audit/cli-fixture-analyzer-acquisition.test.ts
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readOptionalJsonFile, writeJsonFile } from "./io/json.js";

export const AnalyzerRunConsentDecisionSchema = z.enum(["granted", "declined"]);
export type AnalyzerRunConsentDecision = z.infer<typeof AnalyzerRunConsentDecisionSchema>;

const RunConsentSchema = z.object({
  schema_version: z.literal("audit-run-consent/v1"),
  run_id: z.string().uuid(),
  repository_root: z.string(),
  decisions: z.record(z.string(), AnalyzerRunConsentDecisionSchema),
  auto_fix: z.boolean().default(false),
  dry_run: z.boolean().default(false),
}).strict();
export type AuditRunConsent = z.infer<typeof RunConsentSchema>;
export const auditRunConsentPath = (artifactsDir: string): string => join(artifactsDir, "run-consent.json");

/** Caller holds the artifact-tree lock. Cleanup/new-run removes this record with the run. */
export async function readRunConsentUnlocked(root: string, artifactsDir: string): Promise<AuditRunConsent> {
  const repository_root = await realpath(root);
  const raw = await readOptionalJsonFile<unknown>(auditRunConsentPath(artifactsDir));
  if (raw !== undefined && raw !== null) {
    const record = RunConsentSchema.parse(raw);
    if (record.repository_root !== repository_root) throw new Error("Audit run consent belongs to another repository");
    return record;
  }
  const record: AuditRunConsent = {
    schema_version: "audit-run-consent/v1", run_id: randomUUID(), repository_root, decisions: {}, auto_fix: false, dry_run: false,
  };
  await writeJsonFile(auditRunConsentPath(artifactsDir), record);
  return record;
}

/** No nested lock: the fold already serializes submissions and the consent write. */
export async function updateRunConsentUnlocked(
  root: string, artifactsDir: string,
  decisions: Readonly<Record<string, AnalyzerRunConsentDecision>>,
  autoFix?: boolean,
  dryRun?: boolean,
): Promise<AuditRunConsent> {
  const record = await readRunConsentUnlocked(root, artifactsDir);
  const next = RunConsentSchema.parse({ ...record, decisions: { ...record.decisions, ...decisions },
    ...(autoFix === undefined ? {} : { auto_fix: autoFix }),
    dry_run: record.dry_run || dryRun === true });
  await writeJsonFile(auditRunConsentPath(artifactsDir), next);
  return next;
}
