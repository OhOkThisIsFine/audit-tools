/**
 * audit-step-ownership-gate.test.mjs (D-66/67 slice-1, Part S) — the EXISTING
 * OD3 layer-2 gate in `runAuditStep` (`src/audit/cli/auditStep.ts:216-239`) had
 * zero coverage of its `persisted:false` branch: a peer reclaiming the
 * bundle-mutation claim mid-step must discard the in-flight result rather than
 * land it. This is the template `partitionByOwnership` (audit merge gate) and
 * `acceptNodeWorktree` (remediate accept gate) mirror.
 */
import { test, expect, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFixtureRepo, advanceFixtureToPlanning, buildSyntheticResults } from "./helpers/fixture.mjs";

const { writeCoreArtifacts, loadArtifactBundle } = await import("../../src/audit/io/artifacts.ts");
const { runAuditStep } = await import("../../src/audit/cli/auditStep.ts");
const { ClaimRegistry } = await import("../../src/shared/quota/claimRegistry.ts");

test("runAuditStep discards the result (persisted:false) when a peer reclaims the bundle-mutation lease mid-step", async () => {
  const root = await mkdtemp(join(tmpdir(), "auditstep-ownership-"));
  try {
    await writeFixtureRepo(root);
    const { planning, lineIndex } = await advanceFixtureToPlanning(root);
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeCoreArtifacts(artifactsDir, planning.updated_bundle);

    const auditResults = buildSyntheticResults(planning.updated_bundle.audit_tasks, lineIndex);
    const auditResultsPath = join(artifactsDir, "results.json");
    await writeFile(auditResultsPath, JSON.stringify(auditResults), "utf8");

    // Force the bundle-mutating path (needsClaim=true) and simulate the peer
    // reclaim by making heartbeat() observe loss-of-ownership. The ONLY
    // heartbeat() call reached in a fast (<10s) unit run is the persist-time
    // re-validation at auditStep.ts:221 — withClaimHeartbeat's own periodic
    // timer (CLAIM_HEARTBEAT_MS = 10s) never fires before executeAdvance
    // resolves, so this is a clean, non-DI-seamed way to hit that one branch
    // without adding a seam to auditStep.ts (out of this change's boundary).
    const heartbeatSpy = vi.spyOn(ClaimRegistry.prototype, "heartbeat").mockResolvedValue(false);
    let step;
    let heartbeatCallCount;
    try {
      step = await runAuditStep({
        root,
        artifactsDir,
        preferredExecutor: "result_ingestion_executor",
        auditResultsPath,
        runLog: false,
      });
    } finally {
      // Capture the call count before mockRestore(), which resets it.
      heartbeatCallCount = heartbeatSpy.mock.calls.length;
      heartbeatSpy.mockRestore();
    }

    expect(heartbeatCallCount, "the persist-time heartbeat gate must have run").toBeGreaterThan(0);
    expect(step.progress_made, "a peer-reclaimed lease must never land the result").toBe(false);
    expect(step.progress_summary).toMatch(/claim on the audit was revoked by a peer/i);
    expect(step.selected_executor).toBe("result_ingestion_executor");

    // The bundle on disk must be untouched — the ingest was computed but never
    // persisted, so audit_results stays empty.
    const bundle = await loadArtifactBundle(artifactsDir);
    expect((bundle.audit_results ?? []).length, "ingestion must not have persisted").toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
