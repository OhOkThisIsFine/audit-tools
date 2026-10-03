import { canonicalPlanFixture, canonicalUnitFixture, writeApprovedPlanFixture } from "./helpers/canonicalPlanFixture.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runClosePhase } from "../../src/remediate/phases/close.js";
import { verifyAnalyzerLeads } from "../../src/remediate/phases/closeVerifyAnalyzerLeads.js";
import { readFile, rm, mkdir } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSyncHidden as execSync } from "../helpers/spawn.mjs";
import type { RemediationState } from "../../src/remediate/state/store.js";
import type {
  ExternalAnalyzerCandidate,
  AnalyzerLeadProvenance,
  AcquisitionRunner,
} from "audit-tools/shared";
import { hashAnalyzerSnippet } from "../../src/shared/analyzers/provenance.js";
import { contentSha256 } from "../../src/shared/submission/hostHandoffCore.js";
import { makeState as makeBaseState } from "./test-helpers.js";
import { scratchDir } from "../helpers/scratch.js";

const REPO_DIR = scratchDir(".test-close-analyzer-verify");
const TEST_DIR = join(REPO_DIR, ".audit-tools", "remediation");
const OUTPUT_DIR = join(REPO_DIR, ".audit-tools");

const FLAGGED_SOURCE = ["function dup() {", "  return 1;", "}"].join("\n");
const FIXED_SOURCE = ["function dup() {", "  return 2;", "}"].join("\n");

function provenanceFor(source: string): AnalyzerLeadProvenance {
  return {
    analyzer_id: "fake-analyzer",
    rule: "fake-rule",
    path: "src/dup.ts",
    snippet_hash: hashAnalyzerSnippet(source, 1, 3)!,
  };
}

/**
 * A deterministic fake candidate: "re-runs" by reporting one lead at
 * src/dup.ts:1-3 — so the re-run's provenance is content-anchored against
 * whatever the repo file holds NOW, exactly like a real analyzer re-run.
 */
function fakeCandidate(): ExternalAnalyzerCandidate {
  return {
    id: "fake-analyzer",
    runner: "npx",
    spec: "fake-analyzer@1",
    safetyProfile: {
      config_execution: "none",
      network_egress: false,
      version_pinning: "pinned",
    },
    purpose: "test fake",
    buildArgv: (prefix) => [...prefix, "--scan"],
    parse: () => [
      {
        path: "src/dup.ts",
        line_start: 1,
        line_end: 3,
        summary: "duplicated block",
        rule: "fake-rule",
      },
    ],
    detect: () => true,
    defaultRun: true,
  };
}

/**
 * Spawn-free runner: probe and scan both "succeed" without any subprocess.
 * Async — the {@link AcquisitionRunner} seam is promise-returning
 * (`runTrackedAsync`), so an injected fake must match or the engine awaits a
 * non-promise and drifts from the real boundary.
 */
const fakeRun: AcquisitionRunner = async (argv: string[], cwd: string) => ({
  status: 0,
  stdout: "",
  stderr: "",
  argv,
  cwd,
  duration_ms: 1,
});

function makeState(provenance: AnalyzerLeadProvenance): RemediationState {
  return makeBaseState({
    status: "closing",
    plan: canonicalPlanFixture({
      plan_id: "P1",
      findings: [
        {
          id: "F1",
          title: "Analyzer-born finding",
          category: "maintainability",
          severity: "medium",
          confidence: "high",
          lens: "maintainability",
          summary: "born from an analyzer lead",
          affected_files: [{ path: "src/dup.ts" }],
          evidence: ["lead evidence"],
          analyzer_provenance: provenance,
        },
      ],
      units: [canonicalUnitFixture("F1", {source_finding_ids:["F1"]})],
      requirements:[{id:"REQ-F1",description:"Remove analyzer defect",source_finding_ids:["F1"],change_kind:"structural",assertions:[]}],
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    }),
    closing_plan: { action: "none" },
    items: {
      F1: {
        unit_id: "F1",
        status: "resolved",
      },
    },
  }) as RemediationState;
}

beforeEach(async () => {
  await rm(REPO_DIR, { recursive: true, force: true });
  await mkdir(join(REPO_DIR, "src"), { recursive: true });
  await mkdir(TEST_DIR, { recursive: true });
  execSync("git init", { cwd: REPO_DIR });
  execSync("git config user.email test@test.com", { cwd: REPO_DIR });
  execSync("git config user.name Test", { cwd: REPO_DIR });
  writeFileSync(join(REPO_DIR, "initial.txt"), "hello");
  execSync("git add . && git commit -m init", { cwd: REPO_DIR });
});

afterEach(async () => {
  await rm(REPO_DIR, { recursive: true, force: true });
});

describe("verifyAnalyzerLeads (unit)", () => {
  it("is a no-op when no resolved item carries provenance", async () => {
    const state = makeState(provenanceFor(FLAGGED_SOURCE));
    state.items!.F1.status = "resolved_no_change";
    const outcome = await verifyAnalyzerLeads({ state, root: REPO_DIR });
    expect(outcome.ran).toBe(false);
  });

  it("skips (recorded, never silently verified) when the analyzer id has no candidate", async () => {
    const state = makeState(provenanceFor(FLAGGED_SOURCE));
    const outcome = await verifyAnalyzerLeads({
      state,
      root: REPO_DIR,
      overrides: { candidates: [], run: fakeRun },
    });
    expect(outcome.ran).toBe(true);
    expect(outcome.verdicts.F1).toMatchObject({
      status: "skipped",
      analyzer_id: "fake-analyzer",
    });
    expect(outcome.persisting).toEqual([]);
  });
});

describe("runClosePhase — item C mechanical re-verify leg", () => {
  it("routes a persisting lead to triage, re-blocking only its item with the evidence", async () => {
    // The flagged content is still on disk — the re-run re-derives the SAME
    // snippet hash, so the lead identity persists.
    writeFileSync(join(REPO_DIR, "src", "dup.ts"), FLAGGED_SOURCE);
    const state = makeState(provenanceFor(FLAGGED_SOURCE));
    await writeApprovedPlanFixture(TEST_DIR, state, REPO_DIR);
    const next = await runClosePhase(state, { skipFinalGate: true,
      root: REPO_DIR,
      artifactsDir: TEST_DIR,
      analyzerLeadVerifyOverrides: { candidates: [fakeCandidate()], run: fakeRun },
    });
    expect(next.status).toBe("triage");
    expect(next.items!.F1.status).toBe("blocked");
    expect(next.source_verifications?.F1?.mechanical_verification).toEqual({
      status: "lead_persists",
      analyzer_id: "fake-analyzer",
    });
    expect(next.items!.F1.failure_reason).toMatch(/Mechanical re-verify/);
  });

  it("records verified_mechanically in the outcomes contract when the lead is gone", async () => {
    // The fix changed the flagged content — the re-run hashes a DIFFERENT
    // snippet, so the recorded identity no longer fires.
    writeFileSync(join(REPO_DIR, "src", "dup.ts"), FIXED_SOURCE);
    const state = makeState(provenanceFor(FLAGGED_SOURCE));
    await writeApprovedPlanFixture(TEST_DIR, state, REPO_DIR);
    const next = await runClosePhase(state, { skipFinalGate: true,
      root: REPO_DIR,
      artifactsDir: TEST_DIR,
      analyzerLeadVerifyOverrides: { candidates: [fakeCandidate()], run: fakeRun },
    });
    expect(next.status).toBe("complete");
    const outcomes = JSON.parse(
      await readFile(join(OUTPUT_DIR, "remediation-outcomes.json"), "utf8"),
    );
    const f1 = outcomes.outcomes.find(
      (o: { finding_id: string }) => o.finding_id === "F1",
    );
    expect(f1.mechanical_verification).toEqual({
      status: "verified_mechanically",
      analyzer_id: "fake-analyzer",
    });
    expect(f1.outcome).toBe("resolved");
    const report = await readFile(join(OUTPUT_DIR, "remediation-report.md"), "utf8");
    expect(report).toMatch(/Mechanical re-verify/);
  });

  // A replan carries `source_verifications` forward, and the outcomes writer
  // trusts an entry only when both of its hashes match the CURRENT plan. The
  // re-verify leg must stamp those hashes over its own verdict only — never
  // over a source determination an earlier plan revision recorded.
  it("never re-binds a source determination from an earlier plan revision to the current one", async () => {
    writeFileSync(join(REPO_DIR, "src", "dup.ts"), FIXED_SOURCE);
    const state = makeState(provenanceFor(FLAGGED_SOURCE));
    state.source_verifications = {F1:{
      disposition_override:"refuted",
      evidence:{file:"src/dup.ts",line:"1",mechanism:"read_at_head_refutation"},
      recorded_by_module:"closeVerifyHeadEvidence",
      review_revision_sha256:"0".repeat(64), source_sha256:"0".repeat(64), head_commit:"1".repeat(40),
    }};
    await writeApprovedPlanFixture(TEST_DIR, state, REPO_DIR);
    const next = await runClosePhase(state, { skipFinalGate: true,
      root: REPO_DIR,
      artifactsDir: TEST_DIR,
      analyzerLeadVerifyOverrides: { candidates: [fakeCandidate()], run: fakeRun },
    });
    expect(next.status).toBe("complete");
    const outcomes = JSON.parse(
      await readFile(join(OUTPUT_DIR, "remediation-outcomes.json"), "utf8"),
    );
    const f1 = outcomes.outcomes.find((o: { finding_id: string }) => o.finding_id === "F1");
    expect(f1.outcome).toBe("resolved");
    expect(f1.evidence).toBeUndefined();
    expect(next.source_verifications?.F1).toEqual({
      mechanical_verification: { status: "verified_mechanically", analyzer_id: "fake-analyzer" },
      review_revision_sha256: next.plan!.review_revision_sha256,
      source_sha256: contentSha256(next.plan!.findings[0]),
    });
  });

  // A persisting lead returns to triage BEFORE the read-at-HEAD leg runs, so
  // nothing later in the pass clears what this leg wrote: the persisted entry
  // itself must not bind the earlier revision's determination.
  it("persists no earlier-revision determination when a lead routes to triage", async () => {
    writeFileSync(join(REPO_DIR, "src", "dup.ts"), FLAGGED_SOURCE);
    const state = makeState(provenanceFor(FLAGGED_SOURCE));
    state.source_verifications = {F1:{
      disposition_override:"refuted",
      evidence:{file:"src/dup.ts",line:"1",mechanism:"read_at_head_refutation"},
      recorded_by_module:"closeVerifyHeadEvidence",
      review_revision_sha256:"0".repeat(64), source_sha256:"0".repeat(64), head_commit:"1".repeat(40),
    }};
    await writeApprovedPlanFixture(TEST_DIR, state, REPO_DIR);
    const next = await runClosePhase(state, { skipFinalGate: true,
      root: REPO_DIR,
      artifactsDir: TEST_DIR,
      analyzerLeadVerifyOverrides: { candidates: [fakeCandidate()], run: fakeRun },
    });
    expect(next.status).toBe("triage");
    expect(next.source_verifications?.F1).toEqual({
      mechanical_verification: { status: "lead_persists", analyzer_id: "fake-analyzer" },
      review_revision_sha256: next.plan!.review_revision_sha256,
      source_sha256: contentSha256(next.plan!.findings[0]),
    });
  });
});

describe("shared-unit analyzer outcomes", () => {
  it("a persisting source reblocks the shared unit and cannot leave its sibling source resolved", async () => {
    writeFileSync(join(REPO_DIR, "src", "dup.ts"), FLAGGED_SOURCE);
    const state = makeState(provenanceFor(FLAGGED_SOURCE));
    state.plan!.findings.push({...state.plan!.findings[0]!,id:"F2",analyzer_provenance:undefined});
    state.plan!.units[0]!.source_finding_ids.push("F2");
    await writeApprovedPlanFixture(TEST_DIR, state, REPO_DIR);
    const next = await runClosePhase(state,{root:REPO_DIR,artifactsDir:TEST_DIR,skipFinalGate:true,
      analyzerLeadVerifyOverrides:{candidates:[fakeCandidate()],run:fakeRun}});
    expect(next.items!.F1.status).toBe("blocked");
    const {buildRemediationOutcomesReport}=await import("../../src/remediate/phases/close.js");
    const report=buildRemediationOutcomesReport(next,{contract_version:"remediate-code-closing-result/v1alpha1",action:"none",status:"skipped",commands:[]});
    expect(report.outcomes.map(outcome=>[outcome.finding_id,outcome.outcome])).toEqual([["F1","blocked"],["F2","blocked"]]);
  });

  it("an owner-disposed source cannot reblock the unit shared with active work", async () => {
    writeFileSync(join(REPO_DIR, "src", "dup.ts"), FLAGGED_SOURCE);
    const state = makeState(provenanceFor(FLAGGED_SOURCE));
    state.plan!.findings.push({...state.plan!.findings[0]!,id:"F2",analyzer_provenance:undefined});
    state.plan!.units[0]!.source_finding_ids.push("F2");
    state.finding_dispositions={F1:{status:"ignored",reason:"Owner excluded this source"}};
    const outcome=await verifyAnalyzerLeads({state,root:REPO_DIR,overrides:{candidates:[fakeCandidate()],run:fakeRun}});
    expect(outcome.ran).toBe(false);
    expect(state.items!.F1.status).toBe("resolved");
  });
});
