import { conformanceReviewPaths } from "../../src/remediate/steps/dispatch/contractConformanceReview.js";
import { assertSuccessfulConformance, reopenStaleTriageSuccesses, triageEvidenceContext } from "../../src/remediate/phases/triageConformance.js";
import { runClosePhase, buildRemediationOutcomesReport, cleanupTempBranchesAndArtifacts } from "../../src/remediate/phases/close.js";
import { runTriagePhase } from "../../src/remediate/phases/triage.js";
import { StateStore, type RemediationState } from "../../src/remediate/state/store.js";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { runRequiredTest, type RequiredTestFailure } from "../../src/remediate/steps/dispatch/requiredTests.js";
import { afterEach, describe, expect, it } from "vitest";
import { type Fixture, cleanupHostHandoffFixtures, cleanupRoots, fixture, boundState, persistBoundState, resultFor, decisionFor, writeResult, landA } from "./helpers/hostHandoffCorroborationFixture.js";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ingestRemediationHostResults } from "../../src/remediate/steps/dispatch/hostHandoff.js";

import { REMEDIATION_HOST_RESULT_CONTRACT_VERSION as RESULT_VERSION } from "../../src/remediate/steps/types.js";
import { readSubmissionLedger } from "audit-tools/shared";

afterEach(cleanupHostHandoffFixtures);

// ── Obligation evidence-coverage floor (open-bugs "conformance check between
// received and accepted"): the work item BINDS the block's contract obligation
// ids, the result must cite evidence per bound obligation, and ingestion
// validates the coverage mechanically before any acceptance. ───────────────────
describe("obligation evidence-coverage floor", () => {
  function evidenceFor(
    value: Fixture,
    after: string,
    obligationEvidence: readonly Record<string, unknown>[],
  ): Record<string, unknown> {
    return {
      ...resultFor(value, after),
      contract_version: RESULT_VERSION,
      obligation_evidence: obligationEvidence,
    };
  }

  async function ingest(value: Fixture) {
    const ingested = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
    });
    if (ingested === "unsupported_retired_state") {
      throw new Error("fixture state unexpectedly rejected");
    }
    return ingested;
  }

  it("binds the block's contract obligation ids onto the work item, sorted and deduplicated", async () => {
    const value = await fixture({ contractOverlays: true });
    expect(value.item.obligation_ids).toEqual([
      "mod-a:invariant:1",
      "mod-a:output:2",
    ]);
  });

  it("binds stable requirements even without a full module contract", async () => {
    const value = await fixture();
    expect(value.item.obligation_ids).toEqual(["REQ-B1"]);
  });

  it("accepts a result whose obligation_evidence covers every bound obligation", async () => {
    const value = await fixture({ contractOverlays: true });
    const after = await landA(value);
    await writeResult(
      value,
      evidenceFor(value, after, [
        {
          obligation_id: "mod-a:invariant:1",
          evidence: ["src/a.ts:1 keeps the export named value"],
        },
        {
          obligation_id: "mod-a:output:2",
          evidence: ["src/a.ts:1 still exports value"],
        },
      ]),
    );
    const ingested = await ingest(value);
    expect(ingested.issues).toEqual([]);
    expect(ingested.accepted_count).toBe(1);
    expect(ingested.state.items.B1!.status).toBe("resolved");
  });

  it("refuses a result that omits evidence for a bound obligation, naming the uncovered id", async () => {
    const value = await fixture({ contractOverlays: true });
    const after = await landA(value);
    await writeResult(
      value,
      evidenceFor(value, after, [
        {
          obligation_id: "mod-a:invariant:1",
          evidence: ["src/a.ts:1 keeps the export named value"],
        },
      ]),
    );
    const refused = await ingest(value);
    expect(refused.accepted_count).toBe(0);
    expect(refused.issues).toHaveLength(1);
    expect(refused.issues[0]!.message).toContain("mod-a:output:2");
  });

  it("refuses evidence for an obligation the work item does not bind, naming the unknown id", async () => {
    const value = await fixture({ contractOverlays: true });
    const after = await landA(value);
    await writeResult(
      value,
      evidenceFor(value, after, [
        {
          obligation_id: "mod-a:invariant:1",
          evidence: ["src/a.ts:1 keeps the export named value"],
        },
        {
          obligation_id: "mod-a:output:2",
          evidence: ["src/a.ts:1 still exports value"],
        },
        {
          obligation_id: "mod-b:invariant:9",
          evidence: ["src/a.ts:1 unrelated claim"],
        },
      ]),
    );
    const refused = await ingest(value);
    expect(refused.accepted_count).toBe(0);
    expect(refused.issues).toHaveLength(1);
    expect(refused.issues[0]!.message).toContain("mod-b:invariant:9");
  });

  it("refuses an evidence entry with no non-empty citation strings", async () => {
    const value = await fixture({ contractOverlays: true });
    const after = await landA(value);
    await writeResult(
      value,
      evidenceFor(value, after, [
        { obligation_id: "mod-a:invariant:1", evidence: ["   "] },
        {
          obligation_id: "mod-a:output:2",
          evidence: ["src/a.ts:1 still exports value"],
        },
      ]),
    );
    const refused = await ingest(value);
    expect(refused.accepted_count).toBe(0);
    expect(refused.issues).toHaveLength(1);
    expect(refused.issues[0]!.message).toContain("mod-a:invariant:1");
  });

  it("refuses empty coverage for a unit even without a module contract", async () => {
    const value = await fixture();
    expect(value.item.obligation_ids).toEqual(["REQ-B1"]);
    const after = await landA(value);
    await writeResult(value, evidenceFor(value, after, []));
    const ingested = await ingest(value);
    expect(ingested.accepted_count).toBe(0);
    expect(ingested.state.items.B1?.status).toBe("pending");
    expect(ingested.issues).toHaveLength(1);
    expect(ingested.issues[0]).toMatchObject({
      code: "submission_contract_invalid",
      check: "obligation_evidence",
      work_item_id: "B1",
    });
    expect(ingested.issues[0]!.message).toContain("REQ-B1");
  });

  it("the dispatch prompt enumerates the bound obligation ids it demands evidence for", async () => {
    const value = await fixture({ contractOverlays: true });
    expect(value.item.prompt.text).toContain("obligation_evidence");
    expect(value.item.prompt.text).toContain("mod-a:invariant:1");
    expect(value.item.prompt.text).toContain("mod-a:output:2");
  });
});

describe("independent conformance admission and captured verification evidence", () => {
  it("opted-in contract conformance cannot accept mechanically valid work before independent review", async () => {
    const value = await fixture({ contractOverlays: true, beforePrepare: async root => {
      const artifactsDir = join(root, ".audit-tools", "remediation");
      await mkdir(artifactsDir, { recursive: true });
      await writeFile(join(artifactsDir, "intent_checkpoint.json"), JSON.stringify({
        schema_version: "intent-checkpoint/v1", confirmed_by: "host", confirmed_at: new Date().toISOString(),
        scope_summary: "fixture", intent_summary: "fix and independently verify contracts", conformance_review: true,
      }));
    } });
    const landed = await landA(value);
    await writeResult(value, {
      ...resultFor(value, landed),
      obligation_evidence: value.item.obligation_ids.map(obligation_id => ({ obligation_id, evidence: ["src/a.ts implements this obligation"] })),
    });
    const result = await ingestRemediationHostResults({ root: value.root, artifactsDir: value.artifactsDir, runId: value.runId, state: boundState(value) });
    if (result === "unsupported_retired_state") throw Error(result);
    expect(result.accepted_count).toBe(0);
    expect(result.issues.map(issue => issue.code)).toContain("conformance_review_required");
  });

  it('retains complete captured required-test output separately from the prompt excerpt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'required-output-log-'));
    cleanupRoots.push(root);
    const failure = await runRequiredTest(root, `node -e "process.stdout.write('BEGIN'+ 'x'.repeat(12000)+'END'); process.exit(1)"`);
    expect(failure).not.toBeNull();
    const path = (failure as RequiredTestFailure & { output_log?: string }).output_log;
    expect(path).toBeDefined();
    const log = JSON.parse(await readFile(path!, 'utf8'));
    expect(log.stdout).toBe('BEGIN' + 'x'.repeat(12000) + 'END');
    expect(failure!.stdout.length).toBeLessThan(2000);
  });


  async function conformanceFixture(requiredTest?: string, twoBlocks = false): Promise<Fixture> {
    return fixture({ contractOverlays: true, twoBlocks, ...(requiredTest ? { requiredTest } : {}), beforePrepare: async root => {
      const dir = join(root, ".audit-tools", "remediation");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "intent_checkpoint.json"), JSON.stringify({ schema_version: "intent-checkpoint/v1", confirmed_by: "host", confirmed_at: new Date().toISOString(), scope_summary: "fixture", intent_summary: "independent review", conformance_review: true }));
      if (twoBlocks) await writeFile(join(dir, "triage-counter.cjs"), "const fs = require('node:fs'); const p = '.audit-tools/remediation/triage-count'; const n = fs.existsSync(p) ? Number(fs.readFileSync(p)) : 0; fs.writeFileSync(p, String(n + 1)); process.exit(n === 0 ? 0 : 1);");
      if (requiredTest === "node .audit-tools/remediation/triage-mutate.cjs") await writeFile(join(dir, "triage-mutate.cjs"), "require('node:fs').appendFileSync('src/a.ts', '// changed\\n');");
      if (requiredTest === "node .audit-tools/remediation/triage-stable.cjs") await writeFile(join(dir, "triage-stable.cjs"), "process.exit(0);");
    } });
  }
  async function ingestConformance(value: Fixture) {
    const result = await ingestRemediationHostResults({ root: value.root, artifactsDir: value.artifactsDir, runId: value.runId, state: boundState(value) });
    if (result === "unsupported_retired_state") throw Error(result);
    return result;
  }
  async function writeConformanceResult(value: Fixture, evidence = "src/a.ts:1 preserves the required export") {
    const landed = await landA(value);
    const result = { ...resultFor(value, landed), obligation_evidence: value.item.obligation_ids.map(obligation_id => ({ obligation_id, evidence: [evidence] })) };
    await writeResult(value, result);
    return result;
  }
  async function answerConformance(value: Fixture, options: { mode?: string; verdict?: string; binding?: string } = {}) {
    const paths = conformanceReviewPaths(value.artifactsDir, value.runId, value.item.id);
    const request = JSON.parse(await readFile(paths.request, "utf8")) as { binding: string };
    await writeFile(paths.response, JSON.stringify({
      schema_version: "contract-conformance-review/v1", binding: options.binding ?? request.binding,
      declaration: { mode: options.mode ?? "independent", reason: "Fresh reviewer context with no shared authorship" },
      verdict: options.verdict ?? "pass", summary: "The cited export and test prove the required behavior",
      obligations: value.item.obligation_ids.map(obligation_id => ({ obligation_id, verdict: "satisfied", evidence: ["src/a.ts:1 exports the required name and value"] })),
    }));
  }
  describe("opt-in independent contract conformance lifecycle", () => {
    it("a bound independent pass allows ordinary mechanical acceptance", async () => {
      const value = await conformanceFixture(); await writeConformanceResult(value);
      expect((await ingestConformance(value)).accepted_count).toBe(0);
      await answerConformance(value);
      const accepted = await ingestConformance(value);
      expect(accepted.accepted_count).toBe(1);
      expect(accepted.state.items.B1?.status).toBe("resolved");
      expect(accepted.state.conformance_review?.enabled).toBe(true);
      expect(accepted.state.items.B1).toHaveProperty("conformance_review");
    });
    it("unavailable and degraded review pause instead of silently self-reviewing", async () => {
      const value = await conformanceFixture(); await writeConformanceResult(value); await ingestConformance(value);
      for (const mode of ["unavailable", "degraded"]) {
        await answerConformance(value, { mode });
        const outcome = await ingestConformance(value);
        expect(outcome.accepted_count).toBe(0);
        expect(outcome.issues.map(issue => issue.code)).toContain("conformance_review_unavailable");
      }
    });
    it("insufficient evidence can be corrected and reviewed without poisoning acceptance", async () => {
      const value = await conformanceFixture(); const result = await writeConformanceResult(value);
      await ingestConformance(value); await answerConformance(value, { verdict: "insufficient" });
      expect((await ingestConformance(value)).issues.map(issue => issue.code)).toContain("conformance_review_insufficient");
      await writeResult(value, { ...result, obligation_evidence: value.item.obligation_ids.map(obligation_id => ({ obligation_id, evidence: ["src/a.ts:1 corrected and tests checked"] })) });
      expect((await ingestConformance(value)).issues.map(issue => issue.code)).toContain("conformance_review_required");
      await answerConformance(value);
      expect((await ingestConformance(value)).accepted_count).toBe(1);
    });
    it("tampered binding and incomplete mechanical obligations never authorize acceptance", async () => {
      const value = await conformanceFixture(); const result = await writeConformanceResult(value);
      await ingestConformance(value); await answerConformance(value, { binding: "0".repeat(64) });
      expect((await ingestConformance(value)).accepted_count).toBe(0);
      await answerConformance(value);
      await writeResult(value, { ...result, obligation_evidence: [] });
      const bad = await ingestConformance(value);
      expect(bad.accepted_count).toBe(0);
      expect(bad.issues.some(issue => issue.check === "obligation_evidence")).toBe(true);
    });
    it("editing the checkpoint cannot switch off an already-bound run requirement", async () => {
      const value = await conformanceFixture(); await writeConformanceResult(value);
      const checkpointPath = join(value.artifactsDir, "intent_checkpoint.json");
      const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as Record<string, unknown>;
      await writeFile(checkpointPath, JSON.stringify({ ...checkpoint, conformance_review: false }));
      expect((await ingestConformance(value)).issues.map(issue => issue.code)).toContain("conformance_review_required");
    });
    it("the ordinary default-off run adds no review request", async () => {
      const value = await fixture({ contractOverlays: true }); await writeConformanceResult(value);
      expect((await ingestConformance(value)).accepted_count).toBe(1);
      await expect(readFile(conformanceReviewPaths(value.artifactsDir, value.runId, value.item.id).request)).rejects.toMatchObject({ code: "ENOENT" });
    });
    it("production next-step emits the independent review step before accepting work", async () => {
      const value = await conformanceFixture(); await writeConformanceResult(value); await persistBoundState(value);
      await writeFile(join(value.artifactsDir, "confirm_resume_ack.json"), JSON.stringify({ choice: "resume" }));
      const step = await decideNextStep({ root: value.root, artifactsDir: value.artifactsDir, finalGateRunner: () => ({ status: 0 }) });
      expect(step.step_kind).toBe("review_contract_conformance");
      expect(await readFile(step.prompt_path, "utf8")).toContain("context that did not author");
    });
  });

  it("opt-in no-change success also waits for independent conformance review", async () => {
    const value = await conformanceFixture();
    await writeResult(value, decisionFor(value, { status: "resolved_no_change", evidence: ["src/a.ts already preserves the required export and behavior"] }));
    const pending = await ingestConformance(value);
    expect(pending.accepted_count).toBe(0);
    expect(pending.issues.map(issue => issue.code)).toContain("conformance_review_required");
    await answerConformance(value);
    expect((await ingestConformance(value)).accepted_count).toBe(1);
  });
    it("blocked outcomes do not wait for success conformance review", async () => {
    const value = await conformanceFixture();
    await writeResult(value, decisionFor(value, { status: "blocked", failure_reason: "Missing owner decision" }));
    const outcome = await ingestConformance(value);
    expect(outcome.accepted_count).toBe(1);
    expect(outcome.state.items.B1?.status).toBe("blocked");
    await expect(readFile(conformanceReviewPaths(value.artifactsDir, value.runId, value.item.id).request)).rejects.toMatchObject({ code: "ENOENT" });
    });
    it("blocked ingestion reaches opted-in triage review and rejects changed uncommitted evidence", async () => {
      const value = await conformanceFixture();
      await writeResult(value, decisionFor(value, { status: "blocked", failure_reason: "Missing owner decision" }));
      const ingested = await ingestConformance(value);
      expect(ingested.accepted_count).toBe(1);
      expect(ingested.state.items.B1?.status).toBe("blocked");
      await persistBoundState(value, ingested.state);
      await writeFile(join(value.artifactsDir, "confirm_resume_ack.json"), JSON.stringify({ choice: "resume" }));
      const step = await decideNextStep({ root: value.root, artifactsDir: value.artifactsDir, finalGateRunner: () => ({ status: 0 }) });
      expect(step.step_kind).toBe("review_contract_conformance");
      const store = new StateStore(value.artifactsDir);
      const paused = (await store.loadState())!;
      expect(paused.items!.B1.status).toBe("blocked");
      const paths = conformanceReviewPaths(value.artifactsDir, value.runId, value.item.id);
      const requestB = JSON.parse(await readFile(paths.request, "utf8")) as { binding: string };
      expect((await decideNextStep({ root: value.root, artifactsDir: value.artifactsDir })).step_kind).toBe("review_contract_conformance");
      expect(JSON.parse(await readFile(paths.request, "utf8")).binding).toBe(requestB.binding);
      await answerConformance(value);
      await writeFile(join(value.root, "src/a.ts"), "export const value = 27;\n");
      const again = await decideNextStep({ root: value.root, artifactsDir: value.artifactsDir, finalGateRunner: () => ({ status: 0 }) });
      expect(again.step_kind).toBe("review_contract_conformance");
      const requestC = JSON.parse(await readFile(paths.request, "utf8")) as { binding: string };
      expect(requestC.binding).not.toBe(requestB.binding);
      const current = (await store.loadState())!;
      expect(current.items!.B1.status).toBe("blocked");
      for (const mode of ["unavailable", "degraded"]) {
        await answerConformance(value, { mode });
        expect((await decideNextStep({ root: value.root, artifactsDir: value.artifactsDir })).step_kind).toBe("review_contract_conformance");
      }
      await answerConformance(value, { verdict: "insufficient" });
      expect((await decideNextStep({ root: value.root, artifactsDir: value.artifactsDir })).step_kind).toBe("review_contract_conformance");
      await answerConformance(value);
      const accepted = await runTriagePhase((await store.loadState())!, { root: value.root, artifactsDir: value.artifactsDir });
      expect(accepted.items!.B1.status).toBe("resolved_no_change");
      expect(accepted.items!.B1.conformance_review?.binding).toBe(requestC.binding);
      expect(buildRemediationOutcomesReport(accepted, { contract_version: "remediate-code-closing-result/v1alpha1", action: "none", status: "skipped", commands: [] }).execution_outcomes[0]!.conformance_review?.binding).toBe(requestC.binding);
      await expect(assertSuccessfulConformance(value.root, value.artifactsDir, accepted)).resolves.toBeUndefined();
      const alteredPlan = structuredClone(accepted);
      alteredPlan.plan!.units[0]!.description += " changed obligation context";
      await expect(assertSuccessfulConformance(value.root, value.artifactsDir, alteredPlan)).rejects.toThrow("conformance_review_required");
      await writeFile(join(value.root, "src/a.ts"), "export const value = 28;\n");
      await expect(assertSuccessfulConformance(value.root, value.artifactsDir, accepted)).rejects.toThrow("conformance_review_required");
      const priorReceipt = accepted.items!.B1.conformance_review;
      await new StateStore(value.artifactsDir).saveState(structuredClone(accepted));
      expect((await decideNextStep({ root: value.root, artifactsDir: value.artifactsDir })).step_kind).toBe("review_contract_conformance");
      const reopened = (await new StateStore(value.artifactsDir).loadState())!;
      expect(reopened.items!.B1.status).toBe("blocked");
      expect(reopened.items!.B1.conformance_review).toEqual(priorReceipt);
      expect(await reopenStaleTriageSuccesses(value.root, value.artifactsDir, accepted)).toBe(true);
      expect(accepted.items!.B1.conformance_review).toEqual(priorReceipt);
      await new StateStore(value.artifactsDir).saveState(accepted);
      expect((await decideNextStep({ root: value.root, artifactsDir: value.artifactsDir })).step_kind).toBe("review_contract_conformance");
    });
    it("closing refuses successful units without required conformance receipts", async () => {
      const value = await conformanceFixture();
      const state: RemediationState = boundState(value);
      state.items!.B1!.status = "resolved_no_change";
      state.status = "closing";
      state.closing_plan = { action: "none" };
      await expect(runClosePhase(state, { root: value.root, artifactsDir: value.artifactsDir, skipFinalGate: true })).rejects.toThrow("conformance_review_required");
    });
    it("production triage keeps a different pending retry after reviewing a satisfied unit", async () => {
      const value = await conformanceFixture("node .audit-tools/remediation/triage-counter.cjs", true);
      const state = boundState(value);
      state.items.B1!.status = "blocked"; state.items.B2!.status = "blocked";
      delete state.host_handoff;
      await persistBoundState(value, state);
      await writeFile(join(value.artifactsDir, "confirm_resume_ack.json"), JSON.stringify({ choice: "resume" }));
      expect((await decideNextStep({ root: value.root, artifactsDir: value.artifactsDir })).step_kind).toBe("review_contract_conformance");
      const store = new StateStore(value.artifactsDir);
      expect((await store.loadState())!.items!.B2.status).toBe("pending");
      await answerConformance(value);
      const step = await decideNextStep({ root: value.root, artifactsDir: value.artifactsDir });
      expect(step.step_kind).toBe("dispatch_implement");
      const resumed = (await store.loadState())!;
      expect(resumed.items!.B1.status).toBe("resolved_no_change");
      expect(resumed.items!.B2.status).toBe("pending");
      expect(resumed.items!.B2.rework_count).toBe(1);
      expect(resumed.status).toBe("implementing");
      expect(await readFile(join(value.artifactsDir, "triage-count"), "utf8")).toBe("2");
    });
    it("a later unit landing preserves an immutable host no-change success receipt", async () => {
      const value = await conformanceFixture();
      await writeResult(value, decisionFor(value, { status: "resolved_no_change", evidence: ["src/a.ts preserves the export"] }));
      await ingestConformance(value); await answerConformance(value);
      const accepted = await ingestConformance(value);
      await writeFile(join(value.root, "src/b.ts"), "export const other = 29;\n");
      const { git } = await import("./helpers/hostHandoffCorroborationFixture.js");
      git(value.root, ["add", "src/b.ts"]); git(value.root, ["commit", "-m", "land other unit"]);
      await expect(assertSuccessfulConformance(value.root, value.artifactsDir, accepted.state)).resolves.toBeUndefined();
    });
    it("triage cannot review a green command that changed the tree during verification", async () => {
      const value = await conformanceFixture("node .audit-tools/remediation/triage-mutate.cjs");
      await writeResult(value, decisionFor(value, { status: "blocked", failure_reason: "Missing owner decision" }));
      const ingested = await ingestConformance(value);
      await persistBoundState(value, ingested.state);
      await writeFile(join(value.artifactsDir, "confirm_resume_ack.json"), JSON.stringify({ choice: "resume" }));
      const step = await decideNextStep({ root: value.root, artifactsDir: value.artifactsDir });
      expect(step.step_kind).toBe("review_contract_conformance");
      expect(await readFile(step.prompt_path, "utf8")).toContain("context is unavailable or changed");
      await answerConformance(value);
      expect((await decideNextStep({ root: value.root, artifactsDir: value.artifactsDir })).step_kind).toBe("review_contract_conformance");
      expect((await new StateStore(value.artifactsDir).loadState())!.items!.B1.status).toBe("blocked");
    });
    it("triage evidence binds an explicitly invoked ignored test script", async () => {
      const value = await conformanceFixture("node .audit-tools/remediation/triage-stable.cjs");
      const before = await triageEvidenceContext(value.root, boundState(value), value.item.id);
      expect(before).not.toBeNull();
      await writeFile(join(value.artifactsDir, "triage-stable.cjs"), "process.exit(1);");
      expect(await triageEvidenceContext(value.root, boundState(value), value.item.id)).not.toEqual(before);
    });
    it("triage evidence binds an ignored invoked script beneath an in-root dot-dot-prefixed directory", async () => {
      const value = await conformanceFixture("node ..cache/triage-stable.cjs");
      await mkdir(join(value.root, "..cache"));
      await writeFile(join(value.root, ".git", "info", "exclude"), "\n..cache/\n", { flag: "a" });
      const script = join(value.root, "..cache", "triage-stable.cjs");
      await writeFile(script, "process.exit(0);");
      const before = await triageEvidenceContext(value.root, boundState(value), value.item.id);
      expect(before).not.toBeNull();
      await writeFile(script, "process.exit(1);");
      expect(await triageEvidenceContext(value.root, boundState(value), value.item.id)).not.toEqual(before);
    });
    it("fully-green cleanup preserves the actual triage conformance subject with promoted evidence", async () => {
      const value = await conformanceFixture();
      const state: RemediationState = boundState(value);
      state.items!.B1.status = "blocked";
      delete state.host_handoff;
      await runTriagePhase(state, { root: value.root, artifactsDir: value.artifactsDir });
      await answerConformance(value);
      const accepted = await runTriagePhase(state, { root: value.root, artifactsDir: value.artifactsDir });
      accepted.status = "complete";
      const paths = conformanceReviewPaths(value.artifactsDir, value.runId, value.item.id);
      const subject = JSON.parse(await readFile(paths.request, "utf8"));
      const review = JSON.parse(await readFile(paths.response, "utf8"));
      const archiveDir = join(value.root, ".audit-tools", "remediation-conformance");
      await writeFile(archiveDir, "obstruct evidence archive");
      const obstructed = await cleanupTempBranchesAndArtifacts({ root: value.root, artifactsDir: value.artifactsDir }, accepted,
        { ran: true, passed: true, duration_ms: 0, output: "" }, { ran: false, passed: true, output: "" },
        { contract_version: "remediate-code-closing-result/v1alpha1", action: "none", status: "skipped", commands: [] });
      expect(obstructed.artifacts_residue).toBe(value.artifactsDir);
      expect(JSON.parse(await readFile(paths.request, "utf8"))).toEqual(subject);
      await rm(archiveDir);
      const cleanup = await cleanupTempBranchesAndArtifacts({ root: value.root, artifactsDir: value.artifactsDir }, accepted,
        { ran: true, passed: true, duration_ms: 0, output: "" }, { ran: false, passed: true, output: "" },
        { contract_version: "remediate-code-closing-result/v1alpha1", action: "none", status: "skipped", commands: [] });
      expect(cleanup.artifacts_residue).toBeUndefined();
      const archived = join(value.root, ".audit-tools", "remediation-conformance", `${subject.binding}.json`);
      expect(JSON.parse(await readFile(archived, "utf8"))).toEqual(subject);
      expect(JSON.parse(await readFile(join(archiveDir, `${subject.binding}.review.json`), "utf8"))).toEqual(review);
      expect(subject.content.observation.producer).toBe("triage_required_tests");
    });
  it("a changed carried contract invalidates the old mechanical workload and review", async () => {
    const value = await conformanceFixture(); await writeConformanceResult(value); await ingestConformance(value); await answerConformance(value);
    const state = structuredClone(boundState(value));
    state.plan.units[0]!.affected_interfaces.push({ name: "new-boundary", description: "must be independently reviewed" });
    const before = JSON.stringify(state);
    const ledgerBefore = await readSubmissionLedger(value.artifactsDir);
    await expect(ingestRemediationHostResults({ root: value.root, artifactsDir: value.artifactsDir, runId: value.runId, state }))
      .rejects.toMatchObject({ code: "plan_repair_required" });
    expect(JSON.stringify(state)).toBe(before);
    expect(state.items.B1?.status).toBe("pending");
    expect(await readSubmissionLedger(value.artifactsDir)).toEqual(ledgerBefore);
  });


  it("a required-review handoff cannot be accepted with its run snapshot dropped", async () => {
    const value = await conformanceFixture(); await writeConformanceResult(value);
    const state = boundState(value);
    delete state.conformance_review;
    const outcome = await ingestRemediationHostResults({ root: value.root, artifactsDir: value.artifactsDir, runId: value.runId, state });
    expect(outcome).toBe("unsupported_retired_state");
  });

});
