import { isAbsolute } from "node:path";
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

/**
 * The DURABLE analyzer decision. Deliberately a one-member enum: a decline is
 * the only analyzer answer that outlives the run that was asked.
 *
 * An operator's grant binds THE RUN THAT WAS ASKED and nothing else (owner
 * directive, 2026-08-21). A durable grant silently keeps granting itself to
 * later runs whose operator never saw the offer — and for a network-egress
 * analyzer that converts one consent into standing consent. A grant therefore
 * travels on the per-run consent TOKEN, which the strict schema below cannot
 * hold; there is no shape here for it to be written into, so the rule is
 * enforced by the type rather than remembered.
 */
export const AnalyzerConsentDecisionSchema = z.enum(["declined"]);
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
  const parsed = AnalyzerPolicySchema.safeParse(raw ?? {});
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
  return await analyzerPolicyStore(repositoryRoot).read();
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

/**
 * Durably merge consent DECLINES. Neither a grant nor a per-run consent token is
 * accepted or representable here — see {@link AnalyzerConsentDecisionSchema}.
 */
export async function persistAnalyzerConsent(
  repositoryRoot: string,
  decisions: Readonly<Record<string, AnalyzerConsentDecision>>,
): Promise<AnalyzerPolicy> {
  return await analyzerPolicyStore(repositoryRoot).mutate((current) => ({
    ...current,
    analyzer_consent: { ...current.analyzer_consent, ...decisions },
  }));
}
