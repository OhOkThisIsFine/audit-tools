import { getArtifactsDir, getAuditorDescriptor, getExplicitProvider, getFlag, getHostModel, getRootDir } from "./args.js";
import {
  createFreshSessionProvider,
  resolveFreshSessionProviderName,
} from "../providers/index.js";
import { loadSessionConfig } from "../supervisor/sessionConfig.js";
import { prepareDispatchArtifacts } from "./dispatch.js";
import { packageRoot } from "./paths.js";
import {
  resolveHostModel,
  resolveSessionConfig,
  type AuditorDescriptor,
  type ResolvedProviderName,
  type SessionConfig,
} from "audit-tools/shared";

/**
 * Who is DRIVING this dispatch invocation: the effective session config, the
 * provider the fan-out is keyed to and charged against, and the host model that
 * forms the quota key's model segment.
 */
export interface DispatchDriverIdentity {
  /** The parsed `--auditor` handshake, or null when the flag is absent. */
  descriptor: AuditorDescriptor | null;
  sessionConfig: SessionConfig;
  providerName: ResolvedProviderName;
  hostModel: string | null;
}

/**
 * The ONE driver resolution both audit dispatch entry points use — `prepare-dispatch`
 * and its read-only preview `quota`. They previously each spelled it out, and drifted:
 * the preview keyed on the `--host-model` flag alone, so a repo-configured
 * `block_quota.host_model` made it report `provider/*` while the pool it was previewing
 * keyed `provider/<model>` — a preview of a different driver than the run.
 *
 * Fail closed: an invalid/tampered `session-config.json` aborts the invocation rather
 * than degrading to an empty (permissive) default. Both entry points used to swallow the
 * validation error and continue "using defaults", which sized and charged dispatch
 * against an attacker-influenced config while every sibling caller
 * (advanceAuditCommand / nextStepCommand / dispatch / semanticReviewStep) failed closed.
 *
 * The host model resolves through the shared `resolveHostModel` — the same precedence
 * (`--host-model` → `block_quota.host_model` → `AUDIT_CODE_HOST_MODEL`) that
 * `buildHostPoolPreamble` applies when it actually builds the pool, so the reported key
 * and the built pool's key cannot disagree.
 */
export async function resolveDispatchDriverIdentity(
  argv: string[],
): Promise<DispatchDriverIdentity> {
  const intent = await loadSessionConfig(getArtifactsDir(argv));
  // G2: the driver handshake arrives as one `--auditor <json>`; resolve it over the repo
  // INTENT so the dispatch pool/provider come from the descriptor, not the repo config.
  const descriptor = getAuditorDescriptor(argv);
  const sessionConfig: SessionConfig = resolveSessionConfig(intent, descriptor);
  const providerName = resolveFreshSessionProviderName(
    getExplicitProvider(argv) ??
      (sessionConfig.provider === undefined ? "auto" : undefined),
    sessionConfig,
  );
  return {
    descriptor,
    sessionConfig,
    providerName,
    hostModel: resolveHostModel({
      providerName,
      sessionConfig,
      explicitModel: getHostModel(argv),
      envVar: "AUDIT_CODE_HOST_MODEL",
    }),
  };
}

export async function cmdPrepareDispatch(argv: string[]): Promise<void> {
  const runId = getFlag(argv, "--run-id");
  if (!runId) throw new Error("prepare-dispatch requires --run-id <run_id>");
  const { descriptor, sessionConfig, providerName, hostModel } =
    await resolveDispatchDriverIdentity(argv);
  const provider = createFreshSessionProvider(providerName, sessionConfig);
  const self = descriptor?.self ?? {};
  const result = await prepareDispatchArtifacts({
    packageRoot,
    runId,
    artifactsDir: getArtifactsDir(argv),
    root: getFlag(argv, "--root") ? getRootDir(argv) : undefined,
    sessionConfig,
    providerName,
    hostModel,
    queryLimits: provider.queryLimits?.bind(provider),
    hostActiveSubagentLimit: self.max_active_subagents ?? null,
    hostContextTokens: self.context_tokens ?? null,
    hostOutputTokens: self.output_tokens ?? null,
    hostModelRoster: self.roster ?? null,
    hostModelId: self.model_id ?? null,
  });
  console.log(JSON.stringify(result, null, 2));
}
