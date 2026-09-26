// sites-pinned: tests/shared/analyzer-provenance.test.ts
import { isAbsolute } from "node:path";
import { z } from "zod";
import { createLockedJsonStore, type LockedJsonStore } from "./io/lockedJsonStore.js";
import { assertWithinRoot } from "./io/pathContainment.js";
import { formatSchemaFailure } from "./validation/schemaFailure.js";
import { isRecord } from "./validation/basic.js";

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
 * Durable analyzer choices live apart from the canonical repository session
 * intent. The strict top-level shape holds ONLY per-analyzer resolution policy
 * (`analyzers`): analyzer consent — grants AND declines — is strictly per-run
 * (packet 5 / O07) and is never a persisted capability, so there is no consent
 * shape here at all. A legacy `analyzer_consent` key written by an older
 * release is stripped on load: it can neither authorize nor veto the new run.
 */
export const AnalyzerPolicySchema = z
  .object({
    analyzers: z.record(z.string(), AnalyzerSettingSchema).optional(),
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
  // Legacy tolerance, one key only: releases before packet 5 persisted
  // `analyzer_consent` (grants and/or declines). The new run must neither be
  // authorized nor vetoed by it, so it is dropped BEFORE validation — the
  // strict schema below still rejects every other unknown key (including any
  // token-shaped field). Stripping rather than rejecting keeps the unrelated
  // `analyzers` resolution choices in the same file loadable.
  const tolerated =
    isRecord(raw) && "analyzer_consent" in raw
      ? (({ analyzer_consent: _dropped, ...rest }) => rest)(
          raw as Record<string, unknown>,
        )
      : raw;
  const parsed = AnalyzerPolicySchema.safeParse(tolerated ?? {});
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
 *
 * <!-- comment-symbol-exempt: names deliberately-retired symbols; this block records that history -->
 *
 * This is the ONLY durable analyzer-policy write (packet 5 / O07): consent
 * decisions — grants and declines alike — are strictly per-run and are never
 * written here. The retired `persistAnalyzerConsent` is gone; there is no
 * durable consent shape to write into.
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
