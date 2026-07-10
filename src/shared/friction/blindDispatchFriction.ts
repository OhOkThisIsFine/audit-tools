import { captureStepBoundaryFriction } from "./stepBoundaryCapture.js";
import type { WaveSchedule } from "../quota/types.js";

/**
 * Fail LOUD when self-quota monitoring is blind on a host-dispatch wave.
 *
 * A null `quota_source_snapshot` means the Claude `/usage` (and host-session) source
 * returned nothing — absent quota config or a dark credential — so the wave is UNPACED
 * (no token-budget gate; uncapped per the no-invented-ceiling invariant unless a host
 * concurrency cap was declared). This is the single visible signal that the fan-out is
 * running without a live remaining-quota reading: both a stderr line AND a run-ledger
 * friction entry, so a silently-inert quota subsystem can never look like a healthy run.
 *
 * Single-sourced so audit and remediate emit the IDENTICAL signal (parity) — the
 * uncapped-but-LOUD half of the always-on quota track. Returns whether it fired.
 */
export async function emitBlindDispatchFrictionIfBlind(params: {
  artifactsDir: string;
  runId: string;
  schedule: Pick<WaveSchedule, "quota_source_snapshot" | "host_concurrency_limit">;
  /** Number of packets/items in the wave being handed to the host. */
  itemCount: number;
  /** The wave kind, for the message + friction discriminator (e.g. "implement", "review"). */
  waveKind: string;
  /** Emitting tool. */
  toolName: "audit-code" | "remediate-code";
}): Promise<boolean> {
  if (params.schedule.quota_source_snapshot != null) return false;
  const declaredCap = params.schedule.host_concurrency_limit?.active_subagents ?? null;
  process.stderr.write(
    `[${params.toolName}] WARNING: host self-quota monitoring is BLIND — no live ` +
      `quota snapshot (no /usage reading: absent quota config or dark credential). ` +
      `This ${params.itemCount}-item ${params.waveKind} wave is UNPACED` +
      (declaredCap == null
        ? ` and UNCAPPED (declare a host concurrency limit to bound it).`
        : ` and bounded only by the declared host cap of ${declaredCap}.`) +
      `\n`,
  );
  await captureStepBoundaryFriction(
    params.artifactsDir,
    params.runId,
    {
      eventType: "quota_blind_dispatch",
      discriminator: `${params.waveKind}:${params.itemCount}`,
      note:
        `Dispatched a ${params.itemCount}-item ${params.waveKind} wave with no live quota ` +
        `snapshot (self-quota monitoring blind: absent config or dark /usage credential). ` +
        `Wave unpaced; ` +
        (declaredCap == null
          ? `uncapped (no declared host concurrency limit).`
          : `bounded only by declared host cap ${declaredCap}.`),
      severity: "high",
      category: "trap",
      area: "dispatch/quota",
    },
    params.toolName,
  );
  return true;
}
