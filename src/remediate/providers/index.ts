import {
  createFreshSessionProvider as createSharedFreshSessionProvider,
  resolveFreshSessionProviderName as resolveSharedFreshSessionProviderName,
} from "audit-tools/shared";
import type {
  FreshSessionProvider,
  ResolvedProviderName,
  SessionConfig,
} from "audit-tools/shared";
import { createClaudeCodeProvider } from "./claudeCodeProvider.js";
import { createClaudeWorkerProvider } from "./claudeWorkerProvider.js";
import { createOpenCodeProvider } from "./opencodeProvider.js";
import { createAgyProvider } from "./agyProvider.js";

/**
 * Auto-resolution and provider wiring are single-sourced in `audit-tools/shared`.
 * The claude-code / opencode provider classes are shared too; this module only
 * injects remediate-code's bound factories (the sole delta is the claude-code
 * skip-permissions default — on, since the remediator runs unattended — and the
 * nested-session guard message) and attributes the auto-fallback warning to
 * `remediate-code`.
 */

export function resolveFreshSessionProviderName(
  name: string | undefined,
  sessionConfig: SessionConfig = {},
  options: {
    env?: NodeJS.ProcessEnv;
    commandExists?: (command: string) => boolean;
  } = {},
): ResolvedProviderName {
  return resolveSharedFreshSessionProviderName(name, sessionConfig, options);
}

export function createFreshSessionProvider(
  name: string | undefined,
  sessionConfig: SessionConfig = {},
): FreshSessionProvider {
  return createSharedFreshSessionProvider(name, sessionConfig, {
    orchestratorName: "remediate-code",
    createClaudeCodeProvider: (config) => createClaudeCodeProvider(config),
    createClaudeWorkerProvider: (config) => createClaudeWorkerProvider(config),
    createOpenCodeProvider: (config) => createOpenCodeProvider(config),
    createAgyProvider: (config) => createAgyProvider(config),
  });
}

