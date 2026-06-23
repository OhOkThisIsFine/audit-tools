import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  FRICTION_CAPTURE_SCHEMA_VERSION,
  frictionCaptured,
  frictionCapturePath,
  persistFrictionCapture,
  type FrictionCaptureArtifact,
} from "audit-tools/shared";
import { decideAuditFrictionCloseout } from "../../src/audit/orchestrator/nextStep.js";
import { decideRemediateFrictionCloseout } from "../../src/remediate/steps/nextStep.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(HERE, ".test-friction-capture-closeout");

async function readArtifact(path: string): Promise<FrictionCaptureArtifact> {
  return JSON.parse(await readFile(path, "utf8")) as FrictionCaptureArtifact;
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("end-of-run friction-capture close-out (both orchestrators)", () => {
  it("fires when uncaptured at the AUDIT terminal and writes a run_id-keyed, schema-versioned artifact", async () => {
    const artifactsDir = join(TEST_DIR, "audit");
    await mkdir(artifactsDir, { recursive: true });
    const runId = "AUDIT-RUN-1";

    expect(await frictionCaptured(artifactsDir, runId)).toBe(false);

    const decision = await decideAuditFrictionCloseout(artifactsDir, runId);
    expect(decision.action).toBe("capture");

    const path = frictionCapturePath(artifactsDir, runId);
    expect(decision.recordPath).toBe(path);
    expect(existsSync(path)).toBe(true);
    // run_id-keyed: the filename derives from the run id.
    expect(path).toMatch(/AUDIT-RUN-1\.json$/);

    const artifact = await readArtifact(path);
    expect(artifact.schema_version).toBe(FRICTION_CAPTURE_SCHEMA_VERSION);
    expect(artifact.tool).toBe("audit-code");
    expect(artifact.run_id).toBe(runId);
    expect(typeof artifact.captured_at).toBe("string");
  });

  it("fires when uncaptured at the REMEDIATE terminal and writes a run_id-keyed, schema-versioned artifact", async () => {
    const artifactsDir = join(TEST_DIR, "remediation");
    await mkdir(artifactsDir, { recursive: true });
    const state = { status: "complete" as const, plan: { plan_id: "REM-RUN-1", findings: [], blocks: [] } } as never;

    const decision = await decideRemediateFrictionCloseout(artifactsDir, state);
    expect(decision.action).toBe("captured_now");

    const path = frictionCapturePath(artifactsDir, "REM-RUN-1");
    expect(decision.recordPath).toBe(path);
    expect(existsSync(path)).toBe(true);
    expect(path).toMatch(/REM-RUN-1\.json$/);

    const artifact = await readArtifact(path);
    expect(artifact.schema_version).toBe(FRICTION_CAPTURE_SCHEMA_VERSION);
    expect(artifact.tool).toBe("remediate-code");
    expect(artifact.run_id).toBe("REM-RUN-1");
  });

  it("does not re-emit once captured (idempotent short-circuit) at both terminals", async () => {
    const auditDir = join(TEST_DIR, "audit");
    const remDir = join(TEST_DIR, "remediation");
    await mkdir(auditDir, { recursive: true });
    await mkdir(remDir, { recursive: true });
    const state = { status: "complete" as const, plan: { plan_id: "R2", findings: [], blocks: [] } } as never;

    expect((await decideAuditFrictionCloseout(auditDir, "A2")).action).toBe("capture");
    expect((await decideAuditFrictionCloseout(auditDir, "A2")).action).toBe("captured");

    expect((await decideRemediateFrictionCloseout(remDir, state)).action).toBe("captured_now");
    expect((await decideRemediateFrictionCloseout(remDir, state)).action).toBe("captured");
  });

  it("degrades cleanly on zero friction: a valid record with frictions:[] still satisfies the close-out", async () => {
    const artifactsDir = join(TEST_DIR, "audit");
    await mkdir(artifactsDir, { recursive: true });

    await decideAuditFrictionCloseout(artifactsDir, "A3");
    const artifact = await readArtifact(frictionCapturePath(artifactsDir, "A3"));
    expect(artifact.frictions).toEqual([]);
    // Zero friction still counts as captured → never blocks completion / never re-loops.
    expect(await frictionCaptured(artifactsDir, "A3")).toBe(true);
  });

  it("host-supplied friction content round-trips through the shared persist helper", async () => {
    const artifactsDir = join(TEST_DIR, "remediation");
    await mkdir(artifactsDir, { recursive: true });
    const written = await persistFrictionCapture({
      artifactsDir,
      runId: "R4",
      tool: "remediate-code",
      frictions: [{ note: "lock contention on Windows", severity: "low", category: "trap" }],
    });
    expect(written.frictions).toHaveLength(1);
    const artifact = await readArtifact(frictionCapturePath(artifactsDir, "R4"));
    expect(artifact.frictions[0]?.note).toBe("lock contention on Windows");
  });

  it("PARITY: both halves use the SAME shared shape + persist helper (single-sourced, cannot drift)", async () => {
    const auditDir = join(TEST_DIR, "audit");
    const remDir = join(TEST_DIR, "remediation");
    await mkdir(auditDir, { recursive: true });
    await mkdir(remDir, { recursive: true });
    const state = { status: "complete" as const, plan: { plan_id: "P", findings: [], blocks: [] } } as never;

    await decideAuditFrictionCloseout(auditDir, "P");
    await decideRemediateFrictionCloseout(remDir, state);

    const auditArtifact = await readArtifact(frictionCapturePath(auditDir, "P"));
    const remArtifact = await readArtifact(frictionCapturePath(remDir, "P"));

    // Same schema_version + identical field set — only `tool` differs.
    expect(auditArtifact.schema_version).toBe(remArtifact.schema_version);
    expect(Object.keys(auditArtifact).sort()).toEqual(Object.keys(remArtifact).sort());
    expect(auditArtifact.tool).toBe("audit-code");
    expect(remArtifact.tool).toBe("remediate-code");
  });
});
