import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { scratchDir } from "../helpers/scratch.js";
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

// OFF-TREE, per invocation. This suite used to root its scratch tree at
// `join(dirname(fileURLToPath(import.meta.url)), ".test-friction-capture-closeout")`
// — inside tests/remediate/ — which is the exact hazard `nextStepHarness.ts`
// documents and every other suite in this directory already avoids: the INV-WH
// raw-spawn scanner (tests/shared/shared-tests-invariants.test.mjs) WALKS the
// tests/ tree, and this suite's per-test rm+mkdir churn raced that walk into a
// mid-scan ENOENT. `scratchDir` roots it under the per-invocation
// AUDIT_TOOLS_TEST_RUN_ROOT instead, so the churn is invisible to the scanner
// and two concurrent vitest invocations cannot share the directory.
const TEST_DIR = scratchDir(".test-friction-capture-closeout");

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

  // INV-SCC-04 (COR-6fd1702f) regression pin: triage/close-out must pass the
  // RAW run id — `frictionCapturePath` already sanitizes, and the encoding
  // escapes `_`, so a pre-sanitized input double-encodes (`/` → `_2f` → `_5f2f`)
  // and the close-out reads/writes a DIFFERENT record file than capture wrote —
  // captured events invisible to the close-out (false-clean walk). Invisible on
  // ids that sanitize to themselves, hence the non-idempotent id here.
  it("PATH-HANDLING: the close-out decider joins the SAME record file capture wrote (non-idempotent run id)", async () => {
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

// ---------------------------------------------------------------------------
// CP-NODE-24 (test-harness-hermeticity). The harness is a helper module with no
// suite of its own, so its contract assertions live here — beside the suite
// whose scratch root this module moved off-tree.
// ---------------------------------------------------------------------------

describe("CP-NODE-24 inv-1: this suite's scratch root is OFF the repo tree", () => {
  it("TEST_DIR does not resolve under tests/, and IS the per-invocation root", async () => {
    const { dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    // Locating the repo to assert against is NOT a scratch root: this joins to
    // "..", never to a `.test-*` name — exactly the distinction the structural
    // guard in tests/shared/test-scratch-root-guard.test.ts draws.
    const here = dirname(fileURLToPath(import.meta.url));
    const testsPrefix = join(here, "..");
    expect(
      TEST_DIR.startsWith(testsPrefix),
      `TEST_DIR (${TEST_DIR}) must not live under tests/ — a tree the INV-WH ` +
        "raw-spawn scanner walks while this suite rm -rf's it on every test",
    ).toBe(false);
    const { TEST_RUN_ROOT_ENV } = await import("../helpers/scratch.js");
    const runRoot = process.env[TEST_RUN_ROOT_ENV];
    expect(runRoot, "the per-invocation root must be set under vitest").toBeTruthy();
    expect(TEST_DIR.startsWith(runRoot!)).toBe(true);
  });
});

describe("CP-NODE-24 inv-4: the harness threads the injectable final-gate runner", () => {
  /** Make a scratch repo audit-tools-shaped, or the gate scopes out. */
  async function makeMonorepoShaped(root: string): Promise<void> {
    for (const dir of ["src/shared", "src/audit", "src/remediate"]) {
      await mkdir(join(root, dir), { recursive: true });
    }
    for (const file of ["audit-code.mjs", "remediate-code.mjs"]) {
      await writeFile(join(root, file), "// fixture\n", "utf8");
    }
    await mkdir(join(root, "scripts", "shared"), { recursive: true });
    await writeFile(
      join(root, "scripts", "shared", "run-vitest-gate.mjs"),
      "// fixture gate script\n",
      "utf8",
    );
  }

  it("exposes the runner as a member, so no suite needs the environment skip", async () => {
    const { createNextStepHarness, HARNESS_GATE_RUNNER } = await import(
      "./helpers/nextStepHarness.js"
    );
    const harness = createNextStepHarness(".test-thh-gate-runner-member");
    expect(typeof harness.finalGateRunner).toBe("function");
    expect(harness.finalGateRunner).toBe(HARNESS_GATE_RUNNER);
    expect(typeof harness.runFinalGate).toBe("function");
  });

  it("runFinalGate runs the REAL gate through the injected runner", async () => {
    const { createNextStepHarness } = await import("./helpers/nextStepHarness.js");
    const { toolOwnedFinalGateCommands } = await import(
      "../../src/remediate/steps/finalGate.js"
    );
    const harness = createNextStepHarness(".test-thh-run-final-gate");
    await harness.resetTestRepo();
    try {
      await makeMonorepoShaped(harness.REPO_DIR);
      let injectedCalls = 0;
      const gate = await harness.runFinalGate(harness.REPO_DIR, () => {
        injectedCalls += 1;
        return { status: 0 };
      });
      const expected = toolOwnedFinalGateCommands(harness.REPO_DIR).length;
      expect(expected).toBeGreaterThan(0);
      expect(gate.outcome, "a real gate outcome, not a skipped step").toBe("executed");
      expect(gate.scoped_out).toBe(false);
      expect(gate.passed).toBe(true);
      expect(gate.results).toHaveLength(expected);
      expect(injectedCalls, "the injected runner services every command").toBe(
        expected,
      );
    } finally {
      await harness.cleanupTestRepo();
    }
  });

  it("NEGATIVE: suppressing the gate records a NOT-RUN outcome, never one the run produced", async () => {
    // The contrast the invariant is about. `skipFinalGate` — single-sourced with
    // the environment skip — bypasses the gate entirely: the run still advances,
    // but nothing executed, so the recorded outcome carries NO verdict. Injecting
    // the harness runner lets the gate execute for real. That is why the harness
    // supplies a runner instead of a skip.
    const { createNextStepHarness } = await import("./helpers/nextStepHarness.js");
    const { decideNextStep } = await import("../../src/remediate/steps/nextStep.js");
    const { finalGateOutcomePath } = await import(
      "../../src/remediate/steps/finalGate.js"
    );
    const harness = createNextStepHarness(".test-thh-skip-vs-inject");

    const finding = (id: string, path: string) => ({
      id,
      title: `Finding ${id}`,
      category: "correctness",
      severity: "high",
      confidence: "high",
      lens: "correctness",
      summary: `Fix ${id}.`,
      affected_files: [{ path }],
      evidence: [`${path}:1 evidence`],
    });

    async function driveBoundaryRun(
      options: Record<string, unknown>,
    ): Promise<Record<string, unknown> | undefined> {
      await harness.resetTestRepo();
      await makeMonorepoShaped(harness.REPO_DIR);
      await harness.saveState({
        status: "implementing",
        plan: {
          plan_id: "PLAN-THH",
          findings: [finding("F-000", "src/a.ts"), finding("F-001", "src/b.ts")],
          blocks: [
            {
              block_id: "B-000",
              items: ["F-000"],
              parallel_safe: true,
              touched_files: ["src/a.ts"],
              dependencies: [],
              phase_ordinal: 0,
            },
            {
              block_id: "B-001",
              items: ["F-001"],
              parallel_safe: true,
              touched_files: ["src/b.ts"],
              dependencies: ["B-000"],
              phase_ordinal: 1,
            },
          ],
          project_type: "unknown",
          candidate_closing_actions: ["none"],
        },
        items: {
          "F-000": { finding_id: "F-000", status: "resolved", block_id: "B-000" },
          "F-001": { finding_id: "F-001", status: "pending", block_id: "B-001" },
        },
        closing_plan: { action: "none" },
      } as never);
      await harness.writeIntentCheckpoint();
      await harness.acknowledgeResume();
      await decideNextStep({ root: harness.REPO_DIR, ...options } as never);
      const recordPath = finalGateOutcomePath(harness.ARTIFACTS_DIR);
      return existsSync(recordPath)
        ? (JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>)
        : undefined;
    }

    try {
      const injected = await driveBoundaryRun({
        finalGateRunner: harness.finalGateRunner,
      });
      expect(injected?.outcome, "the harness runner lets the gate RUN").toBe(
        "executed",
      );
      expect(injected?.passed).toBe(true);
      expect(injected?.commands_run as number).toBeGreaterThan(0);

      const suppressed = await driveBoundaryRun({ skipFinalGate: true });
      expect(suppressed?.outcome).not.toBe("executed");
      expect(
        suppressed?.passed,
        "a suppressed gate produces no verdict — the whole cost of the skip",
      ).toBeNull();
      expect(suppressed?.commands_run).toBe(0);
    } finally {
      await harness.cleanupTestRepo();
    }
  });
});

// ---------------------------------------------------------------------------
// CP-NODE-24 inv-5: INV-COVERAGE — this module owns the terminal disposition of
// exactly 2 approved finding ids. The join reads the PERSISTED outcome-status
// layer, never a disposition-layer literal.
// ---------------------------------------------------------------------------

describe("CP-NODE-24 inv-5: INV-COVERAGE — this module's 2 owned ids", () => {
  const OWNED_IDS = ["MNT-03deb087", "MNT-03deb087-2"];
  const TERMINAL_PERSISTED = new Set([
    "resolved",
    "verified_no_change",
    "verified_already_fixed",
    "refuted",
  ]);
  const MODULE = "test-harness-hermeticity";
  const OWNED_FILE = "tests/remediate/helpers/nextStepHarness.ts";

  async function buildReport(items: Record<string, unknown>) {
    const { buildRemediationOutcomesReport } = await import(
      "../../src/remediate/phases/close.js"
    );
    return buildRemediationOutcomesReport(
      {
        status: "closing",
        plan: {
          plan_id: "PLAN-THH-COV",
          findings: OWNED_IDS.map((id) => ({
            id,
            title: `Finding ${id}`,
            category: "maintainability",
            severity: "medium",
            confidence: "high",
            lens: "maintainability",
            summary: `Fix ${id}.`,
            affected_files: [{ path: OWNED_FILE }],
            evidence: [`${OWNED_FILE}:1 evidence`],
          })),
          blocks: [
            {
              block_id: "B-1",
              items: OWNED_IDS,
              parallel_safe: true,
              touched_files: [],
            },
          ],
          project_type: "unknown",
          candidate_closing_actions: ["none"],
        },
        items,
      } as never,
      {
        contract_version: "remediate-code-closing-result/v1alpha1",
        action: "none",
        status: "skipped",
        commands: [],
      } as never,
    );
  }

  function coveredItem(id: string, index: number): Record<string, unknown> {
    const disposition = index === 0 ? "verified_already_fixed" : undefined;
    return {
      finding_id: id,
      status: "resolved_no_change",
      block_id: "B-1",
      ...(disposition ? { disposition_override: disposition } : {}),
      evidence: {
        file: OWNED_FILE,
        line: `${String(140 + index)}`,
        mechanism:
          disposition === "verified_already_fixed"
            ? "read_at_head_verification"
            : "red_green_test",
      },
      recorded_by_module: MODULE,
    };
  }

  it("POSITIVE: both owned ids under T, with complete evidence, join GREEN with attribution intact", async () => {
    const items: Record<string, unknown> = {};
    OWNED_IDS.forEach((id, index) => {
      items[id] = coveredItem(id, index);
    });
    const built = await buildReport(items);
    expect(built.outcomes).toHaveLength(OWNED_IDS.length);
    for (const id of OWNED_IDS) {
      const outcome = built.outcomes.find((o) => o.finding_id === id)!;
      expect(
        TERMINAL_PERSISTED.has(outcome.outcome),
        `${id} must persist a member of T, got '${outcome.outcome}'`,
      ).toBe(true);
      expect(outcome.evidence?.file.length).toBeGreaterThan(0);
      expect(outcome.evidence?.line.length).toBeGreaterThan(0);
      expect(outcome.evidence?.mechanism.length).toBeGreaterThan(0);
      expect(outcome.recorded_by_module).toBe(MODULE);
    }
  });

  it("NEGATIVE (condition 4): both ids blocked WITH a reason is still RED", async () => {
    const items: Record<string, unknown> = {};
    for (const id of OWNED_IDS) {
      items[id] = {
        finding_id: id,
        status: "blocked",
        block_id: "B-1",
        failure_reason: "still open",
      };
    }
    const built = await buildReport(items);
    for (const id of OWNED_IDS) {
      const outcome = built.outcomes.find((o) => o.finding_id === id)!;
      expect(
        TERMINAL_PERSISTED.has(outcome.outcome),
        `${id}: a non-empty reason does not make a non-terminal disposition terminal`,
      ).toBe(false);
    }
  });

  it("NEGATIVE (condition 5): stripping any ONE evidence part leaves the id uncovered", async () => {
    for (const part of ["file", "line", "mechanism"] as const) {
      const items: Record<string, unknown> = {};
      OWNED_IDS.forEach((id, index) => {
        const item = coveredItem(id, index) as Record<string, unknown> & {
          evidence: Record<string, unknown>;
        };
        if (id === OWNED_IDS[0]) item.evidence = { ...item.evidence, [part]: "" };
        items[id] = item;
      });
      const built = await buildReport(items);
      const outcome = built.outcomes.find((o) => o.finding_id === OWNED_IDS[0])!;
      const complete =
        outcome.evidence !== undefined &&
        outcome.evidence.file.length > 0 &&
        outcome.evidence.line.length > 0 &&
        outcome.evidence.mechanism.length > 0;
      expect(complete, `missing evidence.${part} must not read as covered`).toBe(false);
    }
  });
});
