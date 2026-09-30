// sites-pinned: tests/audit/review-submission.test.ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { laneAssetsDir } from "../../shared/io/auditToolsPaths.js";
import { createLockedJsonStore, siblingLockPath } from "../../shared/io/lockedJsonStore.js";
import { hashContent } from "../../shared/hash.js";
import { ReviewRequirementSchema } from "../../shared/types/reviewIndependence.js";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const AuditReviewBindingSchema = z.object({
  requirement: ReviewRequirementSchema,
  promptSha256: Sha256Schema,
  semanticInputRevision: z.string().min(1).optional(),
  promptContentSha256: Sha256Schema,
  promptPath: z.string().min(1),
  runId: z.string().min(1),
  submissionId: z.string().min(1),
  inputs: z.array(z.object({ path: z.string().min(1), sha256: Sha256Schema }).strict()),
}).strict();
export type AuditReviewBinding = z.infer<typeof AuditReviewBindingSchema>;
const BindingsSchema = z.object({
  version: z.literal("audit-review-bindings/v1"),
  bindings: z.record(AuditReviewBindingSchema),
}).strict();

function bindingStore(artifactsDir: string) {
  const path = join(laneAssetsDir(artifactsDir), "review-bindings.json");
  return createLockedJsonStore({
    path, lockPath: siblingLockPath(path),
    // Missing/corrupt authority never falls back to reporting history. An empty
    // map refuses every required result until emission mints a fresh binding.
    tolerateCorruptRead: true,
    parse(raw) {
      const parsed = BindingsSchema.safeParse(raw);
      return parsed.success ? parsed.data : { version: "audit-review-bindings/v1" as const, bindings: {} as Record<string, AuditReviewBinding> };
    },
    validate: value => { BindingsSchema.parse(value); },
  });
}

/** Immutable prompt assets are fully published before this atomic authority update. */
export async function publishAuditReviewBindings(artifactsDir: string, bindings: ReadonlyMap<string, AuditReviewBinding>): Promise<void> {
  await bindingStore(artifactsDir).mutate(current => ({ ...current, bindings: { ...current.bindings, ...Object.fromEntries(bindings) } }));
}

export async function readAuditReviewBinding(artifactsDir: string, lane: string): Promise<AuditReviewBinding | undefined> {
  const binding = (await bindingStore(artifactsDir).read()).bindings[lane];
  if (!binding) return undefined;
  for (const input of [{ path: binding.promptPath, sha256: binding.promptContentSha256 }, ...binding.inputs]) {
    let bytes: Buffer;
    try { bytes = await readFile(input.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (hashContent(bytes) !== input.sha256) return undefined;
  }
  return binding;
}
