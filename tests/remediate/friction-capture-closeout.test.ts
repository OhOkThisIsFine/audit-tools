import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  FRICTION_CAPTURE_SCHEMA_VERSION,
  FRICTION_CATEGORIES,
  frictionCapturePath,
  captureFrictionEvent,
  recordFrictionDisposition,
  collectTriageSubjects,
  appendFrictionUnderLock,
  captureStepBoundaryFriction,
  stepBoundaryEventId,
  sanitizeRunId,
  AGENT_FEEDBACK_FILENAME,
  type FrictionCaptureArtifact,
  type TriagedFrictionArtifact,
  type StepBoundaryEventType,
} from "audit-tools/shared";

/** Cover all required friction categories on a record (attest each clean). */
function coverAllCategories(record: TriagedFrictionArtifact): void {
  record.category_attestations = FRICTION_CATEGORIES.map((category) => ({
    category,
    note: "none this run",
  }));
}
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
  it("empty set (zero events AND zero reflections) blocks at AUDIT terminal until host covers all friction categories", async () => {
    const artifactsDir = join(TEST_DIR, "audit");
    await mkdir(artifactsDir, { recursive: true });
    const runId = "AUDIT-RUN-1";

    // First call: materializes the record, no subjects, but all categories missing.
    const pending = await decideAuditFrictionCloseout(artifactsDir, runId);
    expect(pending.action).toBe("dispose");
    expect(pending.pending).toEqual([]);
    expect(pending.needs_open_observations).toBe(true);
    expect(pending.missing_categories).toEqual([...FRICTION_CATEGORIES]);

    const path = frictionCapturePath(artifactsDir, runId);
    expect(pending.recordPath).toBe(path);
    expect(existsSync(path)).toBe(true);
    expect(path).toMatch(/AUDIT-RUN-1\.json$/);

    const artifact = await readArtifact(path);
    expect(artifact.schema_version).toBe(FRICTION_CAPTURE_SCHEMA_VERSION);
    expect(artifact.tool).toBe("audit-code");
    expect(artifact.run_id).toBe(runId);

    // Host walks all three categories (attest each clean for an empty run).
    const record = await readArtifact(path);
    coverAllCategories(record);
    await writeFile(path, JSON.stringify(record) + "\n", "utf8");

    const disposed = await decideAuditFrictionCloseout(artifactsDir, runId);
    expect(disposed.action).toBe("disposed");
    expect(disposed.needs_open_observations).toBe(false);
    expect(disposed.missing_categories).toEqual([]);
  });

  it("empty set blocks at REMEDIATE terminal until host covers all friction categories", async () => {
    const artifactsDir = join(TEST_DIR, "remediation");
    await mkdir(artifactsDir, { recursive: true });
    const state = { status: "complete" as const, plan: { plan_id: "REM-RUN-1", findings: [], blocks: [] } } as never;

    const pending = await decideRemediateFrictionCloseout(artifactsDir, state);
    expect(pending.action).toBe("dispose");
    expect(pending.needs_open_observations).toBe(true);
    expect(pending.recordPath).toMatch(/REM-RUN-1\.json$/);

    // Cover all three categories.
    const record = await readArtifact(pending.recordPath);
    coverAllCategories(record);
    await writeFile(pending.recordPath, JSON.stringify(record) + "\n", "utf8");

    const disposed = await decideRemediateFrictionCloseout(artifactsDir, state);
    expect(disposed.action).toBe("disposed");
  });

  it("PER-CATEGORY: one covered category still blocks (the other two are owed); a free_form_note round-trips", async () => {
    const artifactsDir = join(TEST_DIR, "audit");
    await mkdir(artifactsDir, { recursive: true });
    const runId = "A-CAT";

    const first = await decideAuditFrictionCloseout(artifactsDir, runId);
    expect(first.missing_categories).toEqual([...FRICTION_CATEGORIES]);

    // Cover ONLY one category via a real observation; add a free-form note.
    const record = await readArtifact(first.recordPath);
    record.open_observations = [
      { category: "tool_should_decide", note: "verify ran node:test not vitest" },
    ];
    record.free_form_notes = "cwd drift produced a nested artifact tree";
    await writeFile(first.recordPath, JSON.stringify(record) + "\n", "utf8");

    const stillPending = await decideAuditFrictionCloseout(artifactsDir, runId);
    expect(stillPending.action).toBe("dispose");
    expect(stillPending.missing_categories).toEqual([
      "ambiguous_direction",
      "inefficient_feeding",
    ]);
    expect(stillPending.free_form_notes).toBe("cwd drift produced a nested artifact tree");

    // Attest the remaining two clean → satisfied.
    const record2 = await readArtifact(first.recordPath);
    record2.category_attestations = [
      { category: "ambiguous_direction", note: "none" },
      { category: "inefficient_feeding", note: "none" },
    ];
    await writeFile(first.recordPath, JSON.stringify(record2) + "\n", "utf8");

    const disposed = await decideAuditFrictionCloseout(artifactsDir, runId);
    expect(disposed.action).toBe("disposed");
    expect(disposed.free_form_notes).toBe("cwd drift produced a nested artifact tree");
  });

  it("DROPS FALSE-GREEN: a captured mechanical event BLOCKS the close-out until disposed AND ≥1 observation written", async () => {
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

    // Dispose the subject.
    await recordFrictionDisposition(
      artifactsDir,
      runId,
      { target_id: "evt-1", disposition: "keep" },
      "audit-code",
    );

    // Subjects disposed but still needs the per-category walk.
    const stillPending = await decideAuditFrictionCloseout(artifactsDir, runId);
    expect(stillPending.action).toBe("dispose");
    expect(stillPending.pending).toEqual([]);
    expect(stillPending.needs_open_observations).toBe(true);

    // Cover all categories → fully disposed.
    const record = await readArtifact(stillPending.recordPath);
    coverAllCategories(record);
    await writeFile(stillPending.recordPath, JSON.stringify(record) + "\n", "utf8");

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

    // Dispose the reflection.
    await recordFrictionDisposition(
      artifactsDir,
      runId,
      { target_id: reflId, disposition: "annotate", annotation: "tracked in backlog" },
      "remediate-code",
    );

    // Subjects disposed but still needs the per-category walk.
    const stillPending = await decideRemediateFrictionCloseout(artifactsDir, state);
    expect(stillPending.action).toBe("dispose");
    expect(stillPending.needs_open_observations).toBe(true);

    // Cover all categories → fully disposed.
    const record = await readArtifact(stillPending.recordPath);
    coverAllCategories(record);
    await writeFile(stillPending.recordPath, JSON.stringify(record) + "\n", "utf8");

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

  it("CE-010: a host disposition + open_observation SURVIVE a concurrent late mechanical emit", async () => {
    const artifactsDir = join(TEST_DIR, "remediation");
    await mkdir(artifactsDir, { recursive: true });
    const runId = "R-MERGE";

    // An early mechanical event is captured.
    await captureFrictionEvent(artifactsDir, runId, { id: "evt-early", note: "early" }, "remediate-code");

    // The host disposes of it and writes an open observation (both under the lock).
    await recordFrictionDisposition(
      artifactsDir,
      runId,
      { target_id: "evt-early", disposition: "keep", annotation: "known ok" },
      "remediate-code",
    );
    await appendFrictionUnderLock(
      artifactsDir,
      runId,
      (record) => ({
        ...record,
        open_observations: [{ dimension: "surprises", note: "host reflected" }],
      }),
      "remediate-code",
    );

    // A LATE mechanical emit arrives (e.g. a re-dispatched seam) — under the old
    // unlocked rebuild this clobbered dispositions[]/open_observations[].
    await captureFrictionEvent(artifactsDir, runId, { id: "evt-late", note: "late" }, "remediate-code");

    const artifact = await readArtifact(frictionCapturePath(artifactsDir, runId));
    // The late event accreted...
    expect(artifact.frictions.map((f) => (f as { id: string }).id).sort()).toEqual([
      "evt-early",
      "evt-late",
    ]);
    // ...and the host's disposition + open observation are PRESERVED.
    expect(artifact.dispositions?.find((d) => d.target_id === "evt-early")).toMatchObject({
      disposition: "keep",
      annotation: "known ok",
    });
    expect(artifact.open_observations).toEqual([
      { dimension: "surprises", note: "host reflected" },
    ]);
  });

  it("registers the documented `coverage_total_lines_mismatch` step-boundary member (result_index+path discriminator)", async () => {
    const artifactsDir = join(TEST_DIR, "audit");
    await mkdir(artifactsDir, { recursive: true });
    const runId = "A-COV";
    const eventType: StepBoundaryEventType = "coverage_total_lines_mismatch";
    const discriminator = "3:src/foo.ts";

    await captureStepBoundaryFriction(
      artifactsDir,
      runId,
      { eventType, discriminator, note: "total_lines 10 != actual 12", severity: "medium" },
      "audit-code",
    );

    const artifact = await readArtifact(frictionCapturePath(artifactsDir, runId));
    const expectedId = stepBoundaryEventId(eventType, runId, discriminator);
    expect(artifact.frictions.map((f) => (f as { id: string }).id)).toContain(expectedId);

    // Re-emitting the same fact is a no-op (de-dup on the structured id).
    await captureStepBoundaryFriction(
      artifactsDir,
      runId,
      { eventType, discriminator, note: "total_lines 10 != actual 12", severity: "medium" },
      "audit-code",
    );
    const after = await readArtifact(frictionCapturePath(artifactsDir, runId));
    expect(after.frictions.filter((f) => (f as { id: string }).id === expectedId)).toHaveLength(1);
  });

  it("PATH-HANDLING: a run id that sanitizeRunId actually CHANGES stays on the canonical capture path", async () => {
    // TST-c0e7b3b3: every other test uses run ids that sanitize to themselves,
    // so the sanitization path was never exercised (idempotent inputs prove
    // nothing). This id carries a path separator, a colon, a space, and an
    // underscore — all characters the encoder must transform.
    const artifactsDir = join(TEST_DIR, "audit");
    await mkdir(artifactsDir, { recursive: true });
    const runId = "AUDIT/RUN:2026 07_22";

    // Premise: the input is genuinely non-idempotent, and the token is filename-safe.
    const token = sanitizeRunId(runId);
    expect(token).not.toBe(runId);
    expect(token).toMatch(/^[A-Za-z0-9._-]+$/);
    // Injectivity spot-pin: a naive many-to-one collapse would fuse these.
    expect(sanitizeRunId("a/b")).not.toBe(sanitizeRunId("a-b"));

    // Capture writes to the canonical sanitized path, inside the friction dir.
    await captureFrictionEvent(artifactsDir, runId, { id: "evt-x", note: "n" }, "audit-code");
    const expectedPath = frictionCapturePath(artifactsDir, runId);
    expect(existsSync(expectedPath)).toBe(true);
    expect(expectedPath).toContain(token);
    expect(existsSync(join(artifactsDir, "friction", "AUDIT")), "the raw path separator must not create a nested dir").toBe(false);

    // Disposition joins the same record file, and the artifact carries the
    // ORIGINAL run id (the token is a filename encoding, not an identity rewrite).
    await recordFrictionDisposition(
      artifactsDir,
      runId,
      { target_id: "evt-x", disposition: "keep" },
      "audit-code",
    );
    const record = await readArtifact(expectedPath);
    expect(record.run_id).toBe(runId);
    expect(record.frictions.some((f) => (f as { id: string }).id === "evt-x")).toBe(true);
  });

  // ESCALATED PRODUCTION DEFECT (friction close-out double-sanitize) —
  // expected-fail until the owning node fixes src/shared/friction/triage.ts
  // (lines ~391 and ~446 at v0.34.10): `frictionCapturePath(artifactsDir,
  // sanitizeRunId(runId))` sanitizes an input that frictionCapturePath ALREADY
  // sanitizes. Because the encoding escapes `_`, double-encoding yields a
  // DIFFERENT filename (`/` → `_2f` → `_5f2f`), so for any run id the encoder
  // actually changes, the triage/close-out reads-writes a DIFFERENT record file
  // than capture — captured events are invisible to the close-out (false-clean
  // walk). Invisible on ids that sanitize to themselves, which is what every
  // pre-existing test used. `it.fails` flips loudly when the fix lands; remove
  // the marker then.
  it.fails("PATH-HANDLING: the close-out decider joins the SAME record file capture wrote (non-idempotent run id)", async () => {
    const artifactsDir = join(TEST_DIR, "audit");
    await mkdir(artifactsDir, { recursive: true });
    const runId = "AUDIT/RUN:2026 07_22";
    await captureFrictionEvent(artifactsDir, runId, { id: "evt-x", note: "n" }, "audit-code");

    const pending = await decideAuditFrictionCloseout(artifactsDir, runId);
    // Same file as the canonical capture path...
    expect(pending.recordPath).toBe(frictionCapturePath(artifactsDir, runId));
    // ...and the captured event is therefore VISIBLE to the close-out walk.
    expect(pending.pending.map((s) => s.id)).toContain("evt-x");
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
