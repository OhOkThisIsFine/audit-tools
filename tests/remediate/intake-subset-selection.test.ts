// tests/remediate/intake-subset-selection.test.ts
//
// M09 — Native subset intake: verifies severity and finding-ID selection at
// intake via `intakeSeverities` / `intakeFindingIds` on `decideNextStep`.
//
// Acceptance coverage (spec line 597 of backlog-implementation-2026-09-19.md):
//  - Severity selection produces a valid narrowed subset
//  - ID selection produces a valid narrowed subset
//  - Union of both criteria (severity OR ID) is applied before normalization
//  - Unknown IDs refuse with a named `blocked` step
//  - Empty union (no matching findings) produces `zero_documentable_findings`
//  - Coherence components, work blocks, and top-risk references are preserved
//    through the actual `--input` path (via `decideNextStep` with a structured
//    audit intake, NOT by mocking internal helpers)
//
// These tests enter through the public `--input` intake path: intake artifacts
// are seeded with `writeReadyStructuredAuditIntake`, `approveReviewGate` is
// called for tests that proceed past the review gate, and the seed file written
// by `writePathASeedFromFindings` is checked for the projected subset shape.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { intakePaths } from "../../src/remediate/intake.js";
import { pathASeedFilePath } from "../../src/remediate/contractPipeline/artifactStore.js";
import {
  createNextStepHarness,
  HARNESS_GATE_RUNNER,
} from "./helpers/nextStepHarness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path to the multi-severity audit fixture (4 findings: critical/high/medium/low). */
const MULTI_SEVERITY_FIXTURE = join(
  __dirname,
  "fixtures",
  "audit-findings-multi-severity.json",
);

const h = createNextStepHarness(".test-intake-subset-selection");

/** Read the path-A seed file written by the subset pass. */
async function readSeedReport(): Promise<unknown> {
  const seed = JSON.parse(await readFile(pathASeedFilePath(h.ARTIFACTS_DIR), "utf8")) as {
    audit_findings_path: string;
  };
  return JSON.parse(await readFile(seed.audit_findings_path, "utf8")) as unknown;
}

beforeEach(async () => {
  await h.resetTestRepo();
  await h.writeReadyStructuredAuditIntake(MULTI_SEVERITY_FIXTURE);
});

afterAll(async () => {
  await h.cleanupTestRepo();
});

// ---------------------------------------------------------------------------
// Guard: unknown IDs refuse before any projection occurs
// ---------------------------------------------------------------------------

describe("unknown finding IDs", () => {
  it("emits a blocked step naming each unknown ID", async () => {
    const step = await decideNextStep({
      root: h.REPO_DIR,
      intakeFindingIds: ["F-DOES-NOT-EXIST", "ALSO-UNKNOWN"],
      skipFinalGate: true,
      finalGateRunner: HARNESS_GATE_RUNNER,
    });

    expect(step).toMatchObject({
      step_kind: "blocked",
      status: "blocked",
    });
    const prompt = await readFile(step.prompt_path, "utf8");
    expect(prompt).toContain("F-DOES-NOT-EXIST");
    expect(prompt).toContain("ALSO-UNKNOWN");
    expect(prompt).toContain("--intake-finding-id");
  });

  it("refuses even when some IDs are valid", async () => {
    const step = await decideNextStep({
      root: h.REPO_DIR,
      intakeFindingIds: ["F-HIGH", "F-NONEXISTENT"],
      skipFinalGate: true,
      finalGateRunner: HARNESS_GATE_RUNNER,
    });

    expect(step).toMatchObject({ step_kind: "blocked" });
    const prompt = await readFile(step.prompt_path, "utf8");
    expect(prompt).toContain("F-NONEXISTENT");
    // Known ID must not be listed as unknown
    expect(prompt).not.toContain("F-HIGH`\n");
  });

  it("refuses an unknown ID even when the report is empty", async () => {
    const report = JSON.parse(await readFile(MULTI_SEVERITY_FIXTURE, "utf8")) as Record<string, unknown>;
    report.findings = [];
    report.work_blocks = [];
    report.coherence_trace = { normalized_items: [], components: [] };
    const summary = report.summary as Record<string, unknown>;
    summary.finding_count = 0;
    summary.work_block_count = 0;
    summary.severity_breakdown = { critical: 0, high: 0, medium: 0, low: 0 };
    const emptyPath = join(h.REPO_DIR, "empty-report.json");
    await writeFile(emptyPath, JSON.stringify(report));
    await h.writeReadyStructuredAuditIntake(emptyPath);
    const step = await decideNextStep({ root: h.REPO_DIR, intakeFindingIds: ["F-MISSING"] });
    expect(step.step_kind).toBe("blocked");
    expect(await readFile(step.prompt_path, "utf8")).toContain("F-MISSING");
  });
});

// ---------------------------------------------------------------------------
// Guard: empty union emits zero_documentable_findings
// ---------------------------------------------------------------------------

describe("empty union selection", () => {
  it("emits zero_documentable_findings when severity matches nothing", async () => {
    // The fixture has no `info` findings — severity filter produces empty set.
    const step = await decideNextStep({
      root: h.REPO_DIR,
      intakeSeverities: ["info"],
      skipFinalGate: true,
      finalGateRunner: HARNESS_GATE_RUNNER,
    });

    expect(step).toMatchObject({
      step_kind: "zero_documentable_findings",
      status: "blocked",
    });
    const prompt = await readFile(step.prompt_path, "utf8");
    expect(prompt).toContain("info");
  });

  it("refuses an unsupported severity by name", async () => {
    const step = await decideNextStep({
      root: h.REPO_DIR,
      intakeSeverities: ["nonexistent-severity"],
      skipFinalGate: true,
      finalGateRunner: HARNESS_GATE_RUNNER,
    });

    expect(step).toMatchObject({ step_kind: "blocked" });
    expect(await readFile(step.prompt_path, "utf8")).toContain("nonexistent-severity");
  });
});

// ---------------------------------------------------------------------------
// Severity-only selection
// ---------------------------------------------------------------------------

describe("severity-only subset selection", () => {
  it("projects the report to critical+high findings only, preserving coherence + work blocks", async () => {
    await h.approveReviewGate();

    const step = await decideNextStep({
      root: h.REPO_DIR,
      intakeSeverities: ["critical", "high"],
      skipFinalGate: true,
      finalGateRunner: HARNESS_GATE_RUNNER,
    });

    // Should enter contract pipeline (next step is contract_pipeline or
    // similar — definitely NOT blocked/zero_documentable_findings).
    expect(step.step_kind).not.toBe("zero_documentable_findings");
    expect(step.step_kind).not.toBe("blocked");

    // The seed report reflects the projected subset.
    const seed = await readSeedReport() as Record<string, unknown>;
    const findings = seed.findings as Array<{ id: string; severity: string }>;
    const ids = findings.map((f) => f.id);

    // Only critical and high findings survive.
    expect(ids).toContain("F-CRIT");
    expect(ids).toContain("F-HIGH");
    expect(ids).not.toContain("F-MED");
    expect(ids).not.toContain("F-LOW");

    // Coherence components must be preserved: only surviving IDs appear.
    const trace = seed.coherence_trace as { components: string[][] };
    const componentIds = trace.components.flat();
    expect(componentIds).toContain("F-CRIT");
    expect(componentIds).toContain("F-HIGH");
    expect(componentIds).not.toContain("F-MED");
    expect(componentIds).not.toContain("F-LOW");

    // Work blocks must map correctly to surviving findings.
    const blocks = seed.work_blocks as Array<{ finding_ids: string[] }>;
    const blockedFindingIds = blocks.flatMap((b) => b.finding_ids);
    expect(blockedFindingIds).toContain("F-CRIT");
    expect(blockedFindingIds).toContain("F-HIGH");
    expect(blockedFindingIds).not.toContain("F-MED");
    expect(blockedFindingIds).not.toContain("F-LOW");
    expect(seed.top_risks).toEqual(["Review the selected security findings."]);
  });

  it("single-severity selection produces valid narrowed report", async () => {
    await h.approveReviewGate();

    const step = await decideNextStep({
      root: h.REPO_DIR,
      intakeSeverities: ["medium"],
      skipFinalGate: true,
      finalGateRunner: HARNESS_GATE_RUNNER,
    });

    expect(step.step_kind).not.toBe("blocked");
    expect(step.step_kind).not.toBe("zero_documentable_findings");

    const seed = await readSeedReport() as Record<string, unknown>;
    const findings = seed.findings as Array<{ id: string }>;
    expect(findings.map((f) => f.id)).toEqual(["F-MED"]);

    const summary = seed.summary as { finding_count: number };
    expect(summary.finding_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ID-only selection
// ---------------------------------------------------------------------------

describe("finding-ID-only subset selection", () => {
  it("selects exactly the named findings, preserving work blocks and coherence", async () => {
    await h.approveReviewGate();

    const step = await decideNextStep({
      root: h.REPO_DIR,
      intakeFindingIds: ["F-LOW"],
      skipFinalGate: true,
      finalGateRunner: HARNESS_GATE_RUNNER,
    });

    expect(step.step_kind).not.toBe("blocked");
    expect(step.step_kind).not.toBe("zero_documentable_findings");

    const seed = await readSeedReport() as Record<string, unknown>;
    const findings = seed.findings as Array<{ id: string }>;
    expect(findings.map((f) => f.id)).toEqual(["F-LOW"]);

    const blocks = seed.work_blocks as Array<{ id: string; finding_ids: string[] }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].finding_ids).toEqual(["F-LOW"]);

    const trace = seed.coherence_trace as { components: string[][] };
    expect(trace.components).toHaveLength(1);
    expect(trace.components[0]).toEqual(["F-LOW"]);
  });
});

// ---------------------------------------------------------------------------
// Union: severity OR ID
// ---------------------------------------------------------------------------

describe("union of severity and finding IDs", () => {
  it("includes findings matching EITHER severity OR ID (union, not intersection)", async () => {
    await h.approveReviewGate();

    // Severity: medium — matches F-MED
    // ID: F-LOW — matches F-LOW
    // Union should be [F-MED, F-LOW]
    const step = await decideNextStep({
      root: h.REPO_DIR,
      intakeSeverities: ["medium"],
      intakeFindingIds: ["F-LOW"],
      skipFinalGate: true,
      finalGateRunner: HARNESS_GATE_RUNNER,
    });

    expect(step.step_kind).not.toBe("blocked");
    expect(step.step_kind).not.toBe("zero_documentable_findings");

    const seed = await readSeedReport() as Record<string, unknown>;
    const findings = seed.findings as Array<{ id: string }>;
    const ids = findings.map((f) => f.id).sort();

    expect(ids).toContain("F-MED");
    expect(ids).toContain("F-LOW");
    expect(ids).not.toContain("F-CRIT");
    expect(ids).not.toContain("F-HIGH");
  });

  it("ID already matched by severity is included once (no duplicate in union)", async () => {
    await h.approveReviewGate();

    // Severity: high → matches F-HIGH; ID: F-HIGH → also matches F-HIGH
    const step = await decideNextStep({
      root: h.REPO_DIR,
      intakeSeverities: ["high"],
      intakeFindingIds: ["F-HIGH"],
      skipFinalGate: true,
      finalGateRunner: HARNESS_GATE_RUNNER,
    });

    expect(step.step_kind).not.toBe("blocked");
    const seed = await readSeedReport() as Record<string, unknown>;
    const findings = seed.findings as Array<{ id: string }>;
    const highFindings = findings.filter((f) => f.id === "F-HIGH");
    // Exactly one F-HIGH, not duplicated.
    expect(highFindings).toHaveLength(1);
    expect(findings).toHaveLength(1);
  });
});

describe("durable selection and source binding", () => {
  it("retains the selection from the first --input call through bare resumption", async () => {
    await h.resetTestRepo();
    const initial = await decideNextStep({
      root: h.REPO_DIR,
      input: MULTI_SEVERITY_FIXTURE,
      intakeFindingIds: ["F-HIGH"],
    });
    expect(initial.step_kind).toBe("synthesize_intake");
    const sidecar = JSON.parse(await readFile(join(intakePaths(h.ARTIFACTS_DIR).dir, "subset-selection.json"), "utf8")) as {
      source_sha256: string;
      finding_ids: string[];
    };
    expect(sidecar.source_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(sidecar.finding_ids).toEqual(["F-HIGH"]);
    await h.writeReadyStructuredAuditIntake(MULTI_SEVERITY_FIXTURE);
    await h.approveReviewGate();
    const resumed = await decideNextStep({ root: h.REPO_DIR });
    expect(resumed.step_kind).not.toBe("blocked");
    const report = await readSeedReport() as { findings: Array<{ id: string }> };
    expect(report.findings.map((finding) => finding.id)).toEqual(["F-HIGH"]);
    const seed = JSON.parse(await readFile(pathASeedFilePath(h.ARTIFACTS_DIR), "utf8")) as {
      audit_findings_path: string;
    };
    expect(seed.audit_findings_path).not.toBe(MULTI_SEVERITY_FIXTURE);
  });

  it("fails closed if the bound source bytes change before resumption", async () => {
    const sourcePath = join(h.REPO_DIR, "mutable-report.json");
    await writeFile(sourcePath, await readFile(MULTI_SEVERITY_FIXTURE));
    await h.writeReadyStructuredAuditIntake(sourcePath);
    const first = await decideNextStep({ root: h.REPO_DIR, intakeSeverities: ["high"] });
    expect(first.step_kind).toBe("collect_review_approval");
    await writeFile(sourcePath, `${await readFile(sourcePath, "utf8")}\n`);
    const resumed = await decideNextStep({ root: h.REPO_DIR });
    expect(resumed.step_kind).toBe("blocked");
    expect(await readFile(resumed.prompt_path, "utf8")).toContain("source bytes changed");
  });

  it("fails closed on an invalid sidecar during bare resumption", async () => {
    const first = await decideNextStep({ root: h.REPO_DIR, intakeFindingIds: ["F-HIGH"] });
    expect(first.step_kind).toBe("collect_review_approval");
    await writeFile(join(intakePaths(h.ARTIFACTS_DIR).dir, "subset-selection.json"), "{}\n");
    const resumed = await decideNextStep({ root: h.REPO_DIR, input: [] });
    expect(resumed.step_kind).toBe("blocked");
    expect(await readFile(resumed.prompt_path, "utf8")).toContain("saved intake subset selection");
  });

  it("resets selectors when an explicit different source starts a new intake", async () => {
    const first = await decideNextStep({ root: h.REPO_DIR, intakeFindingIds: ["F-HIGH"] });
    expect(first.step_kind).toBe("collect_review_approval");
    const otherSource = join(h.REPO_DIR, "other-report.json");
    await writeFile(otherSource, await readFile(MULTI_SEVERITY_FIXTURE));
    const restarted = await decideNextStep({ root: h.REPO_DIR, input: otherSource });
    expect(restarted.step_kind).toBe("synthesize_intake");
    const sidecar = JSON.parse(await readFile(join(intakePaths(h.ARTIFACTS_DIR).dir, "subset-selection.json"), "utf8")) as {
      source_path: string;
      finding_ids: string[];
      severities: string[];
    };
    expect(sidecar.source_path).toBe(otherSource);
    expect(sidecar.finding_ids).toEqual([]);
    expect(sidecar.severities).toEqual([]);
  });
});

describe("intersection with confirmed scope", () => {
  it("applies checkpoint filters after the native union", async () => {
    const checkpointPath = join(h.ARTIFACTS_DIR, "intent_checkpoint.json");
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as Record<string, unknown>;
    checkpoint.filters = { severity: ["critical"] };
    await writeFile(checkpointPath, JSON.stringify(checkpoint));
    await h.approveReviewGate();
    const step = await decideNextStep({
      root: h.REPO_DIR,
      intakeSeverities: ["medium"],
      intakeFindingIds: ["F-CRIT"],
    });
    expect(step.step_kind).not.toBe("blocked");
    const report = await readSeedReport() as { findings: Array<{ id: string }> };
    expect(report.findings.map((finding) => finding.id)).toEqual(["F-CRIT"]);
  });
});

// ---------------------------------------------------------------------------
// No-selection: existing behavior unchanged
// ---------------------------------------------------------------------------

describe("no subset selection (no intakeSeverities or intakeFindingIds)", () => {
  it("proceeds with all findings when no subset selection is supplied", async () => {
    await h.approveReviewGate();

    const step = await decideNextStep({
      root: h.REPO_DIR,
      skipFinalGate: true,
      finalGateRunner: HARNESS_GATE_RUNNER,
    });

    expect(step.step_kind).not.toBe("blocked");
    expect(step.step_kind).not.toBe("zero_documentable_findings");

    const seed = await readSeedReport() as Record<string, unknown>;
    const findings = seed.findings as Array<{ id: string }>;
    const ids = findings.map((f) => f.id).sort();
    // All four findings survive (all have evidence and real paths).
    expect(ids).toContain("F-CRIT");
    expect(ids).toContain("F-HIGH");
    expect(ids).toContain("F-MED");
    expect(ids).toContain("F-LOW");
  });
});
