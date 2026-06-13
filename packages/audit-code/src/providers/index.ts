import {
  createFreshSessionProvider as createSharedFreshSessionProvider,
  resolveFreshSessionProviderName as resolveSharedFreshSessionProviderName,
} from "@audit-tools/shared";
import type {
  FreshSessionProvider,
  ResolvedProviderName,
  SessionConfig,
} from "@audit-tools/shared";
import { ClaudeCodeProvider } from "./claudeCodeProvider.js";
import { OpenCodeProvider } from "./opencodeProvider.js";

/**
 * Auto-resolution and provider wiring are single-sourced in `@audit-tools/shared`.
 * This module is a thin audit-code-specific adapter: it injects audit-code's own
 * `ClaudeCodeProvider`/`OpenCodeProvider` (whose prompt delivery and
 * skip-permissions semantics differ from the remediator's) and attributes the
 * auto-fallback warning to `audit-code`.
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
    orchestratorName: "audit-code",
    createClaudeCodeProvider: (config) =>
      new ClaudeCodeProvider(config),
    createOpenCodeProvider: (config) =>
      new OpenCodeProvider(config),
  });
}
