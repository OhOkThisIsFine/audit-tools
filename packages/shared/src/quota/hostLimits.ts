import type { SessionConfig } from "../types/sessionConfig.js";
import type { HostConcurrencyLimit } from "./types.js";

/**
 * Codex Desktop does not report its concurrency via env, so we apply this known
 * fixed active-subagent ceiling when the Codex Desktop originator override is
 * present. Exported so tests assert against the constant rather than a literal.
 */
export const CODEX_DESKTOP_ACTIVE_SUBAGENT_LIMIT = 6;

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function detectHostActiveSubagentLimit(
  envPrefix: string,
  env: NodeJS.ProcessEnv = process.env,
): HostConcurrencyLimit | null {
  const explicitEnvLimit = parsePositiveInteger(
    env[`${envPrefix}_HOST_MAX_ACTIVE_SUBAGENTS`] ??
      env.CODEX_MAX_ACTIVE_SUBAGENTS,
  );
  if (explicitEnvLimit !== null) {
    return {
      active_subagents: explicitEnvLimit,
      source: "environment",
      description: "Host active subagent limit from environment.",
    };
  }

  if (env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE === "Codex Desktop") {
    return {
      active_subagents: CODEX_DESKTOP_ACTIVE_SUBAGENT_LIMIT,
      source: "environment",
      description: "Codex Desktop active subagent limit.",
    };
  }

  return null;
}

export function resolveHostActiveSubagentLimit(options: {
  envPrefix: string;
  explicitLimit?: number | null;
  sessionConfig: SessionConfig;
  env?: NodeJS.ProcessEnv;
}): HostConcurrencyLimit | null {
  if (options.explicitLimit !== undefined && options.explicitLimit !== null) {
    return {
      active_subagents: options.explicitLimit,
      source: "cli_flags",
      description: "Host active subagent limit reported by the conversation host.",
    };
  }

  const configuredLimit = parsePositiveInteger(
    options.sessionConfig.quota?.host_active_subagent_limit ??
      options.sessionConfig.parallel_workers,
  );
  if (configuredLimit !== null) {
    return {
      active_subagents: configuredLimit,
      source: "session_config",
      description: "Host active subagent limit from session-config.",
    };
  }

  return detectHostActiveSubagentLimit(options.envPrefix, options.env);
}
