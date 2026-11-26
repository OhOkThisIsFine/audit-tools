import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { RunLogger, AuditFindingsReportSchema } from "audit-tools/shared";
import type { AuditFindingsReport, AuditRead } from "audit-tools/shared";
import { deriveQuestionCycleUnlocked } from "../../src/audit/cli/questionReviewCycle.js";
import { buildQuestionPlanArtifacts } from "../../src/audit/orchestrator/questionPlanExecutor.js";
import { fullAuditScope } from "../../src/audit/orchestrator/scope.js";
import { analyzerCalibrationRequest } from "../../src/audit/orchestrator/analyzerCalibration.js";
import { EXECUTOR_RUNNERS } from "../../src/audit/orchestrator/executorRunners.js";
import {
  runQuestionSynthesisExecutor,
  runQuestionSynthesisNarrativeExecutor,
} from "../../src/audit/orchestrator/synthesisExecutors.js";
import {
  buildAuditFindingsReport,
  buildAuditReportModel,
  normalizeExistingFindingsReport,
} from "../../src/audit/reporting/synthesis.js";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { execSyncHidden as execSync } from "../helpers/spawn.mjs";
import { scratchDir } from "../helpers/scratch.js";

// The audit half of the `audit_read` contract: WHO writes it (the runner, never
// the pure executors), that every later writer CARRIES it rather than
// re-stamping it, and that the one writer with no audit-side source states
// `null` instead of the commit current at the time.

const RECORDED: AuditRead = {
  commit: "a".repeat(40),
  dirty_paths: ["src/dirty.ts"],
};
const LATER: AuditRead = { commit: "b".repeat(40), dirty_paths: [] };

function emptyQuestionPlan(): ArtifactBundle {
  return buildQuestionPlanArtifacts({
    repo_manifest: { repository: { name: "fixture" }, generated_at: "2026-01-01", files: [] },
  }, fullAuditScope()).updated;
}

const emptyQuestionReview = { accepted: [], evidence: [], dependenciesByQuestion: new Map() };

describe("the pure writers state exactly what they are handed", () => {
  it("buildAuditFindingsReport stamps the supplied value, and a schema-valid null", () => {
    const model = buildAuditReportModel({ results: [] });

    expect(buildAuditFindingsReport(model, RECORDED).audit_read).toEqual(RECORDED);
    const stated = buildAuditFindingsReport(model, null);
    expect(stated.audit_read).toBeNull();
    expect(AuditFindingsReportSchema.safeParse(stated).success).toBe(true);
  });

  it("the schema REFUSES a report with no audit_read key: absence is not a statement", () => {
    const { audit_read: _dropped, ...withoutKey } = buildAuditFindingsReport(
      buildAuditReportModel({ results: [] }),
      null,
    );

    expect(AuditFindingsReportSchema.safeParse(withoutKey).success).toBe(false);
  });

  it("the schema refuses a commit that is not a full object id", () => {
    const report = {
      ...buildAuditFindingsReport(buildAuditReportModel({ results: [] }), null),
      audit_read: { commit: "HEAD", dirty_paths: [] },
    };

    expect(AuditFindingsReportSchema.safeParse(report).success).toBe(false);
  });

  it("runQuestionSynthesisExecutor carries options.auditRead onto the report it writes", () => {
    const run = runQuestionSynthesisExecutor(emptyQuestionPlan(), { auditRead: RECORDED, questionReview: emptyQuestionReview });

    expect(run.updated.audit_findings?.audit_read).toEqual(RECORDED);
  });
});

describe("a later writer CARRIES the value, never re-stamps it", () => {
  it("the narrative pass carries recorded audit_read and refuses a restamped baseline", () => {
    const synthesisOptions = { auditRead: RECORDED, questionReview: emptyQuestionReview };
    const synth = runQuestionSynthesisExecutor(emptyQuestionPlan(), synthesisOptions);
    const narrative = { executive_summary: "A summary.", themes: [], top_risks: [] };
    const omitted = runQuestionSynthesisNarrativeExecutor(synth.updated, undefined, synthesisOptions);
    const applied = runQuestionSynthesisNarrativeExecutor(synth.updated, narrative, synthesisOptions);

    expect(omitted.updated.audit_findings?.audit_read).toEqual(RECORDED);
    expect(applied.updated.audit_findings?.audit_read).toEqual(RECORDED);
    expect(() => runQuestionSynthesisNarrativeExecutor(synth.updated, narrative, { ...synthesisOptions, auditRead: LATER }))
      .toThrow(/stale question evidence/);
  });

  it("resynthesize's normalizer carries a recorded value through a version upgrade", () => {
    const report = buildAuditFindingsReport(buildAuditReportModel({ results: [] }), RECORDED);

    expect(normalizeExistingFindingsReport(report).audit_read).toEqual(RECORDED);
  });

  it("resynthesize's normalizer states null for a record from before the field existed, and for a malformed one", () => {
    const { audit_read: _dropped, ...legacy } = buildAuditFindingsReport(
      buildAuditReportModel({ results: [] }),
      null,
    );
    const malformed = { ...legacy, audit_read: { commit: "not-a-sha", dirty_paths: [] } };

    // Never the commit current NOW: those findings were read against some
    // earlier tree this function knows nothing about.
    expect(
      normalizeExistingFindingsReport(legacy as AuditFindingsReport).audit_read,
    ).toBeNull();
    expect(
      normalizeExistingFindingsReport(malformed as AuditFindingsReport).audit_read,
    ).toBeNull();
  });
});

describe("the RUNNER is the writer: synthesis_executor records the repository it audits", () => {
  const REPO_DIR = scratchDir(".test-audit-read-synthesis");
  // Keep test artifacts under the authorized root but outside the source inventory.
  const ARTIFACTS_DIR = join(REPO_DIR, ".audit-tools", "audit");
  async function readyBundle(): Promise<ArtifactBundle> {
    const bundle = emptyQuestionPlan();
    const question_cycle = await deriveQuestionCycleUnlocked({
      root: REPO_DIR, sourceRoot: REPO_DIR, artifactsDir: ARTIFACTS_DIR, bundle,
    });
    expect(question_cycle.pending).toEqual([]);
    return { ...bundle, question_cycle };
  }
  const git = (command: string): string =>
    String(execSync(`git ${command}`, { cwd: REPO_DIR })).trim();
  const ctx = (root: string | undefined) => ({
    options: { root },
    log: new RunLogger(join(REPO_DIR, "run.log.jsonl"), { enabled: false }),
    correlationId: "test",
    obligation: null,
  });

  beforeEach(async () => {
    await rm(REPO_DIR, { recursive: true, force: true });
    await mkdir(join(REPO_DIR, "src"), { recursive: true });
    git("init");
    git("config user.email test@test.com");
    git("config user.name Test");
    writeFileSync(join(REPO_DIR, "src", "a.ts"), "export const a = 1;\n");
    git("add .");
    git("commit -m init");
  });

  afterEach(async () => {
    await rm(REPO_DIR, { recursive: true, force: true });
  });

  it("stamps HEAD and the uncommitted paths of the audited root", async () => {
    writeFileSync(join(REPO_DIR, "src", "a.ts"), "export const a = 2;\n");

    const run = await EXECUTOR_RUNNERS.synthesis_executor!(await readyBundle(), ctx(REPO_DIR) as never);

    expect(run.updated.audit_findings?.audit_read).toEqual({
      commit: git("rev-parse HEAD"),
      dirty_paths: ["src/a.ts"],
    });
  });

  it("a re-synthesis after a commit that changed nothing keeps the report's audit_read byte-identical", async () => {
    const first = await EXECUTOR_RUNNERS.synthesis_executor!(await readyBundle(), ctx(REPO_DIR) as never);
    git("commit --allow-empty -m unrelated");

    const second = await EXECUTOR_RUNNERS.synthesis_executor!(first.updated, ctx(REPO_DIR) as never);

    expect(second.updated.audit_findings?.audit_read).toEqual(
      first.updated.audit_findings?.audit_read,
    );
  });

  it("keeps current analyzer gaps in the report and ignores a stale receipt", async () => {
    const bundle = await readyBundle();
    bundle.external_analyzer_acquisition = { enabled: true, tool_statuses: [
      { tool: "fixture", status: "failed", resolved: true },
    ] };
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    const binding = analyzerCalibrationRequest(bundle, undefined);
    writeFileSync(join(ARTIFACTS_DIR, "analyzer-calibration.json"), JSON.stringify({
      input_sha256: binding.input_sha256,
      decisions: [{ tool: "fixture", action: "limited", reason: "Runner unavailable", coverage: "generated files not scanned" }],
      unresolved: ["one fixture check could not run"],
    }));
    const context = { ...ctx(REPO_DIR), options: { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR } };
    const first = await EXECUTOR_RUNNERS.synthesis_executor!(bundle, context as never);
    expect(first.updated.audit_report).toContain("## Unresolved analyzer coverage");
    expect(first.updated.audit_report).toContain("fixture: generated files not scanned");
    expect(first.updated.audit_findings).toMatchObject({ question_review: { analyzer_coverage_gaps: [
      "one fixture check could not run", "fixture: generated files not scanned",
    ] } });
    const revised = await EXECUTOR_RUNNERS.synthesis_executor!({ ...bundle, external_analyzer_results: [] }, context as never);
    expect(revised.updated.audit_report).not.toContain("## Unresolved analyzer coverage");
  });

  it("states null when the run has no root to read", async () => {
    const run = await EXECUTOR_RUNNERS.synthesis_executor!(await readyBundle(), ctx(undefined) as never);

    expect(run.updated.audit_findings?.audit_read).toBeNull();
  });
});
