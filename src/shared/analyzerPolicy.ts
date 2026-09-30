// sites-pinned: tests/audit/analyzer-run-consent.test.ts, tests/audit/analyzer-consent-offer.test.ts
import { withArtifactTreeHold } from "./io/artifactTreeHold.js";
import { AnalyzerRunConsentDecisionSchema, updateRunConsentUnlocked } from "./analyzerRunConsent.js";
import { join, isAbsolute } from "node:path";
import { z } from "zod";
import { createLockedJsonStore, type LockedJsonStore } from "./io/lockedJsonStore.js";
import { assertWithinRoot } from "./io/pathContainment.js";
import { formatSchemaFailure } from "./validation/schemaFailure.js";

/** Per-analyzer resolution policy, independent of any execution backend. */
export const ANALYZER_SETTINGS = [
  "repo",
  "ephemeral",
  "permanent",
  "skip",
  "auto",
] as const;
export const AnalyzerSettingSchema = z.enum(ANALYZER_SETTINGS);
export type AnalyzerSetting = z.infer<typeof AnalyzerSettingSchema>;

export const ANALYZER_POLICY_RELATIVE_PATH =
  ".audit-tools/audit/analyzer-policy.json" as const;

const ANALYZER_POLICY_LOCK_RELATIVE_PATH =
  ".audit-tools/audit/analyzer-policy.lock" as const;

/** A current-run decline used by the shared admission boundary. Never standing consent. */
export const AnalyzerConsentDecisionSchema = AnalyzerRunConsentDecisionSchema.exclude(["granted"]);
export type AnalyzerConsentDecision = z.infer<
  typeof AnalyzerConsentDecisionSchema
>;

/**
 * Durable analyzer choices live apart from the canonical repository session
 * intent. The strict top-level shape deliberately has no place for an
 * acquisition consent token: tokens authorize one run and must never become a
 * persisted capability.
 */
export const AnalyzerPolicySchema = z
  .object({
    analyzers: z.record(z.string(), AnalyzerSettingSchema).optional(),
    analyzer_consent: z
      .record(z.string(), AnalyzerConsentDecisionSchema)
      .optional(),
  })
  .strict();

export type AnalyzerPolicy = z.infer<typeof AnalyzerPolicySchema>;

function resolvePolicyPath(repositoryRoot: string, relativePath: string): string {
  if (!isAbsolute(repositoryRoot)) {
    throw new Error(
      `Repository root must be absolute: ${JSON.stringify(repositoryRoot)}`,
    );
  }
  return assertWithinRoot(repositoryRoot, relativePath, { allowRoot: false });
}

/** The one canonical analyzer-policy artifact for a repository. */
export function getAnalyzerPolicyPath(repositoryRoot: string): string {
  return resolvePolicyPath(repositoryRoot, ANALYZER_POLICY_RELATIVE_PATH);
}

function getAnalyzerPolicyLockPath(repositoryRoot: string): string {
  return resolvePolicyPath(repositoryRoot, ANALYZER_POLICY_LOCK_RELATIVE_PATH);
}

function parseAnalyzerPolicy(
  raw: unknown | undefined,
  policyPath: string,
): AnalyzerPolicy {
  const input = raw && typeof raw === "object" && !Array.isArray(raw)
    ? Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "analyzer_consent"))
    : raw;
  const parsed = AnalyzerPolicySchema.safeParse(input ?? {});
  if (!parsed.success) {
    throw new Error(
      `Invalid ${policyPath}: ${formatSchemaFailure(parsed.error)}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function analyzerPolicyStore(
  repositoryRoot: string,
): LockedJsonStore<AnalyzerPolicy> {
  const policyPath = getAnalyzerPolicyPath(repositoryRoot);
  return createLockedJsonStore<AnalyzerPolicy>({
    path: policyPath,
    lockPath: getAnalyzerPolicyLockPath(repositoryRoot),
    parse: (raw) => parseAnalyzerPolicy(raw, policyPath),
    validate: (next) => {
      parseAnalyzerPolicy(next, policyPath);
    },
  });
}

/** Load the strict durable analyzer policy; an absent artifact means no choices. */
export async function loadAnalyzerPolicy(
  repositoryRoot: string,
): Promise<AnalyzerPolicy> {
  const policy = await analyzerPolicyStore(repositoryRoot).read();
  // Legacy decisions are neither permission nor a veto in a new run.
  const { analyzer_consent: _legacyConsent, ...settings } = policy;
  return settings;
}

/**
 * Durably merge per-analyzer resolution choices without losing concurrent
 * writers or changing the repository's canonical session-intent bytes.
 */
export async function persistAnalyzerSettings(
  repositoryRoot: string,
  settings: Readonly<Record<string, AnalyzerSetting>>,
): Promise<AnalyzerPolicy> {
  return await analyzerPolicyStore(repositoryRoot).mutate((current) => ({
    ...current,
    analyzers: { ...current.analyzers, ...settings },
  }));
}

/** Record a decline for the active audit only. Kept for existing library callers. */
export async function persistAnalyzerConsent(
  repositoryRoot: string,
  decisions: Readonly<Record<string, AnalyzerConsentDecision>>,
): Promise<AnalyzerPolicy> {
  getAnalyzerPolicyPath(repositoryRoot); // Validate the root before any current-run write.
  const parsed = z.record(z.string(), AnalyzerConsentDecisionSchema).parse(decisions);
  const artifactsDir = join(repositoryRoot, ".audit-tools", "audit");
  await withArtifactTreeHold(artifactsDir, undefined, async () => {
    await updateRunConsentUnlocked(repositoryRoot, artifactsDir, parsed);
  });
  return await loadAnalyzerPolicy(repositoryRoot);
}
