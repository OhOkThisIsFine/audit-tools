import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  FRICTION_CAPTURE_SCHEMA_VERSION,
  frictionCapturePath,
  captureFrictionEvent,
  recordFrictionDisposition,
  collectTriageSubjects,
  AGENT_FEEDBACK_FILENAME,
  type FrictionCaptureArtifact,
  type TriagedFrictionArtifact,
} from "audit-tools/shared";
import { decideAuditFrictionCloseout } from "../../src/audit/orchestrator/nextStep.js";
import { decideRemediateFrictionCloseout } from "../../src/remediate/steps/nextStep.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(HERE, ".test-friction-capture-closeout");

async function readArtifact(path: string): Promise<TriagedFrictionArtifact> {
  return JSON.parse(await readFile(path, "utf8")) as TriagedFrictionArtifact;
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("end-of-run friction TRIAGE close-out (both orchestrators)", () => {
  it("empty set (zero events AND zero reflections) is trivially disposed at the AUDIT terminal", async () => {
    const artifactsDir = join(TEST_DIR, "audit");
    await mkdir(artifactsDir, { recursive: true });
    const runId = "AUDIT-RUN-1";

    const decision = await decideAuditFrictionCloseout(artifactsDir, runId);
    expect(decision.action).toBe("disposed");
    expect(decision.pending).toEqual([]);

    const path = frictionCapturePath(artifactsDir, runId);
    expect(decision.recordPath).toBe(path);
    // A disposed record is persisted once so it never re-loops.
    expect(existsSync(path)).toBe(true);
    expect(path).toMatch(/AUDIT-RUN-1\.json$/);

    const artifact = await readArtifact(path);
    expect(artifact.schema_version).toBe(FRICTION_CAPTURE_SCHEMA_VERSION);
    expect(artifact.tool).toBe("audit-code");
    expect(artifact.run_id).toBe(runId);
  });

  it("empty set is trivially disposed at the REMEDIATE terminal", async () => {
    const artifactsDir = join(TEST_DIR, "remediation");
    await mkdir(artifactsDir, { recursive: true });
    const state = { status: "complete" as const, plan: { plan_id: "REM-RUN-1", findings: [], blocks: [] } } as never;

    const decision = await decideRemediateFrictionCloseout(artifactsDir, state);
    expect(decision.action).toBe("disposed");
    expect(decision.recordPath).toMatch(/REM-RUN-1\.json$/);
  });

  it("DROPS FALSE-GREEN: a captured mechanical event BLOCKS the close-out until disposed", async () => {
    const artifactsDir = join(TEST_DIR, "audit");
    await mkdir(artifactsDir, { recursive: true });
    const runId = "A-EVT";

    await captureFrictionEvent(
      artifactsDir,
      runId,
      { id: "evt-1", note: "validator coerced a field" },
      "audit-code",
    );

    const blocked = await decideAuditFrictionCloseout(artifactsDir, runId);
    expect(blocked.action).toBe("dispose");
    expect(blocked.pending.map((s) => s.id)).toContain("evt-1");

    // Once disposed, the close-out is satisfied.
    await recordFrictionDisposition(
      artifactsDir,
      runId,
      { target_id: "evt-1", disposition: "keep" },
      "audit-code",
    );
    const disposed = await decideAuditFrictionCloseout(artifactsDir, runId);
    expect(disposed.action).toBe("disposed");
    expect(disposed.pending).toEqual([]);
  });

  it("UNION: a surfaced agent-feedback reflection blocks the close-out alongside events", async () => {
    const artifactsDir = join(TEST_DIR, "remediation");
    await mkdir(artifactsDir, { recursive: true });
    const runId = "R-REF";
    const state = { status: "complete" as const, plan: { plan_id: runId, findings: [], blocks: [] } } as never;

    await writeFile(
      join(artifactsDir, AGENT_FEEDBACK_FILENAME),
      JSON.stringify({ task_id: "T-1", instruction_clarity: "ambiguous", severity: "low", tool_friction: ["flaky lock"] }) + "\n",
      "utf8",
    );

    const subjects = await collectTriageSubjects(artifactsDir, runId);
    expect(subjects.some((s) => s.source === "reflection")).toBe(true);

    const blocked = await decideRemediateFrictionCloseout(artifactsDir, state);
    expect(blocked.action).toBe("dispose");
    const reflId = blocked.pending.find((s) => s.source === "reflection")!.id;

    await recordFrictionDisposition(
      artifactsDir,
      runId,
      { target_id: reflId, disposition: "annotate", annotation: "tracked in backlog" },
      "remediate-code",
    );
    const disposed = await decideRemediateFrictionCloseout(artifactsDir, state);
    expect(disposed.action).toBe("disposed");
  });

  it("host disposition round-trips into dispositions[] under the shared lock", async () => {
    const artifactsDir = join(TEST_DIR, "remediation");
    await mkdir(artifactsDir, { recursive: true });
    const runId = "R-DISP";
    await captureFrictionEvent(artifactsDir, runId, { id: "e1", note: "n1" }, "remediate-code");
    await recordFrictionDisposition(
      artifactsDir,
      runId,
      { target_id: "e1", disposition: "discard" },
      "remediate-code",
    );
    const artifact = await readArtifact(frictionCapturePath(artifactsDir, runId));
    expect(artifact.dispositions?.[0]).toMatchObject({ target_id: "e1", disposition: "discard" });
    // Original mechanical event survives the disposition append.
    expect(artifact.frictions.some((f) => (f as { id: string }).id === "e1")).toBe(true);
  });

  it("PARITY: both halves use the SAME single-sourced triage decider (only `tool` differs)", async () => {
    const auditDir = join(TEST_DIR, "audit");
    const remDir = join(TEST_DIR, "remediation");
    await mkdir(auditDir, { recursive: true });
    await mkdir(remDir, { recursive: true });
    const state = { status: "complete" as const, plan: { plan_id: "P", findings: [], blocks: [] } } as never;

    await decideAuditFrictionCloseout(auditDir, "P");
    await decideRemediateFrictionCloseout(remDir, state);

    const auditArtifact = await readArtifact(frictionCapturePath(auditDir, "P"));
    const remArtifact = await readArtifact(frictionCapturePath(remDir, "P"));

    expect(auditArtifact.schema_version).toBe(remArtifact.schema_version);
    expect(auditArtifact.tool).toBe("audit-code");
    expect(remArtifact.tool).toBe("remediate-code");
  });
});
