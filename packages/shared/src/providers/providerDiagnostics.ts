import type {
  LaunchFreshSessionInput,
  LaunchFreshSessionResult,
} from "./types.js";

/**
 * Structured provider launch/done diagnostics, emitted as single JSON lines on
 * stderr (the FINDING-012 one-line-JSON convention). Single-sourced here so the
 * shared ClaudeCode / OpenCode providers emit byte-identical `provider_launch` /
 * `provider_done` records instead of each re-building the object inline (the
 * accidental-drift source the per-orchestrator copies suffered from).
 */
export function emitProviderLaunchDiagnostic(
  provider: string,
  input: LaunchFreshSessionInput,
): void {
  process.stderr.write(
    JSON.stringify({
      event: "provider_launch",
      provider,
      runId: input.runId,
      obligationId: input.obligationId,
      promptPath: input.promptPath,
      taskPath: input.taskPath,
    }) + "\n",
  );
}

export function emitProviderDoneDiagnostic(
  provider: string,
  input: LaunchFreshSessionInput,
  result: LaunchFreshSessionResult,
): void {
  process.stderr.write(
    JSON.stringify({
      event: "provider_done",
      provider,
      runId: input.runId,
      obligationId: input.obligationId,
      accepted: result.accepted,
      exitCode: result.exitCode ?? null,
    }) + "\n",
  );
}
