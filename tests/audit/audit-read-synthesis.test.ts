import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { RunLogger, AuditFindingsReportSchema } from "audit-tools/shared";
import type { AuditFindingsReport, AuditRead } from "audit-tools/shared";
import { EXECUTOR_RUNNERS } from "../../src/audit/orchestrator/executorRunners.js";
import {
  runSynthesisExecutor,
  runSynthesisNarrativeExecutor,
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

const EMPTY_BUNDLE = { audit_results: [] } as unknown as ArtifactBundle;

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

  it("runSynthesisExecutor carries options.auditRead onto the report it writes", () => {
    const run = runSynthesisExecutor(EMPTY_BUNDLE, undefined, { auditRead: RECORDED });

    expect(run.updated.audit_findings?.audit_read).toEqual(RECORDED);
  });
});

describe("a later writer CARRIES the value, never re-stamps it", () => {
  it("the narrative pass keeps the persisted report's audit_read even when handed a later one", () => {
    const synth = runSynthesisExecutor(EMPTY_BUNDLE, undefined, { auditRead: RECORDED });

    const omitted = runSynthesisNarrativeExecutor(synth.updated, undefined, {
      auditRead: LATER,
    });
    const applied = runSynthesisNarrativeExecutor(
      synth.updated,
      { executive_summary: "A summary.", themes: [], top_risks: [] },
      { auditRead: LATER },
    );

    expect(omitted.updated.audit_findings?.audit_read).toEqual(RECORDED);
    expect(applied.updated.audit_findings?.audit_read).toEqual(RECORDED);
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

    const run = await EXECUTOR_RUNNERS.synthesis_executor!(EMPTY_BUNDLE, ctx(REPO_DIR) as never);

    expect(run.updated.audit_findings?.audit_read).toEqual({
      commit: git("rev-parse HEAD"),
      dirty_paths: ["src/a.ts"],
    });
  });

  it("a re-synthesis after a commit that changed nothing keeps the report's audit_read byte-identical", async () => {
    const first = await EXECUTOR_RUNNERS.synthesis_executor!(EMPTY_BUNDLE, ctx(REPO_DIR) as never);
    git("commit --allow-empty -m unrelated");

    const second = await EXECUTOR_RUNNERS.synthesis_executor!(first.updated, ctx(REPO_DIR) as never);

    expect(second.updated.audit_findings?.audit_read).toEqual(
      first.updated.audit_findings?.audit_read,
    );
  });

  it("states null when the run has no root to read", async () => {
    const run = await EXECUTOR_RUNNERS.synthesis_executor!(EMPTY_BUNDLE, ctx(undefined) as never);

    expect(run.updated.audit_findings?.audit_read).toBeNull();
  });
});
