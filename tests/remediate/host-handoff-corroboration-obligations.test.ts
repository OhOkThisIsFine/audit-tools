import { checkConformanceSubject, conformanceReviewPaths } from "../../src/remediate/steps/dispatch/contractConformanceReview.js";
import { submitRemediationGateResult } from "../../src/remediate/steps/submitGateResult.js";
import { assertSuccessfulConformance, checkTriageConformance, triageEvidenceContext } from "../../src/remediate/phases/triageConformance.js";
import { runClosePhase, buildRemediationOutcomesReport, cleanupTempBranchesAndArtifacts } from "../../src/remediate/phases/close.js";
import { runTriagePhase } from "../../src/remediate/phases/triage.js";
import { StateStore, type RemediationState } from "../../src/remediate/state/store.js";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { runRequiredTest, type RequiredTestFailure } from "../../src/remediate/steps/dispatch/requiredTests.js";
import { afterEach, describe, expect, it } from "vitest";
import { type Fixture, cleanupHostHandoffFixtures, cleanupRoots, fixture, boundState, persistBoundState, resultFor, decisionFor, writeResult, landA, git } from "./helpers/hostHandoffCorroborationFixture.js";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hasBoundRemediationSubmission, ingestRemediationHostResults, submitRemediationHostResult } from "../../src/remediate/steps/dispatch/hostHandoff.js";

import { REMEDIATION_HOST_RESULT_CONTRACT_VERSION as RESULT_VERSION } from "../../src/remediate/steps/types.js";
import { readSubmissionLedger } from "audit-tools/shared";
import { canonicalPlanFixture, canonicalUnitFixture } from "./helpers/canonicalPlanFixture.js";

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

  it("binds and prompts for sorted obligation ids, then accepts complete coverage", async () => {
    const value = await fixture({ contractOverlays: true });
    expect(value.item.obligation_ids).toEqual(["mod-a:invariant:1", "mod-a:output:2"]);
    expect(value.item.prompt.text).toContain("obligation_evidence");
    for (const id of value.item.obligation_ids) expect(value.item.prompt.text).toContain(id);
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

  it("refuses missing, unbound, and blank evidence at the submission boundary without writing a result", async () => {
    const value = await fixture({ contractOverlays: true });
    const complete = value.item.obligation_ids.map(obligation_id => ({
      obligation_id, evidence: ["src/a.ts:1 preserves the export"],
    }));
    const cases = [
      { evidence: complete.slice(0, 1), diagnostic: "mod-a:output:2" },
      { evidence: [...complete, { obligation_id: "mod-b:invariant:9", evidence: ["unbound evidence"] }], diagnostic: "mod-b:invariant:9" },
      { evidence: [{ ...complete[0]!, evidence: ["   "] }, complete[1]!], diagnostic: "non-empty evidence string" },
    ];
    for (const { evidence, diagnostic } of cases) {
      const refused = await submitRemediationHostResult({
        root: value.root, artifactsDir: value.artifactsDir, runId: value.runId,
        state: boundState(value), workItemId: value.item.id,
        source: JSON.stringify(evidenceFor(value, value.baseline, evidence)),
      });
      expect(refused.written, diagnostic).toBe(false);
      expect(refused.issues, diagnostic).toHaveLength(1);
      expect(refused.issues[0]).toMatchObject({ code: "submission_contract_invalid", check: "obligation_evidence" });
      expect(refused.issues[0]!.message).toContain(diagnostic);
    }
    await expect(readFile(join(value.root, value.item.result_path))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("binds the fallback requirement without a module contract and refuses empty coverage", async () => {
    const value = await fixture();
    expect(value.item.obligation_ids).toEqual(["REQ-B1"]);
    await writeResult(value, evidenceFor(value, value.baseline, []));
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

});

describe("independent conformance admission and captured verification evidence", () => {
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
      if (requiredTest === "node .audit-tools/remediation/record-test.cjs") {
        await writeFile(join(dir, "record-test.cjs"),
          "const fs = require('node:fs'); fs.appendFileSync('.audit-tools/remediation/test-count', 'run\\n'); process.exit(fs.existsSync('.audit-tools/remediation/test-red') ? 1 : 0);");
      }
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
  type ConformanceTarget = Pick<Fixture, "artifactsDir" | "runId"> & {
    item: Pick<Fixture["item"], "id" | "obligation_ids">;
  };

  async function planOnlyConformance({ withGit = true, requiredTests = ['node -e "process.exit(0)"'] } = {}) {
    const root = await mkdtemp(join(tmpdir(), "triage-conformance-plan-"));
    cleanupRoots.push(root);
    const artifactsDir = join(root, ".audit-tools", "remediation");
    await mkdir(artifactsDir, { recursive: true });
    if (withGit) {
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "a.ts"), "export const value = 1;\n");
      git(root, ["init"]);
      git(root, ["add", "src/a.ts"]);
      git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "baseline"]);
    }
    const unit = canonicalUnitFixture("B1", { required_tests: requiredTests });
    const plan = canonicalPlanFixture({ units: [unit] });
    const state: RemediationState = {
      status: "triage", plan, items: { B1: { unit_id: "B1", status: "blocked" } },
      run_start_dirty: [], run_start_dirty_encoding: "git-z/v1",
      conformance_review: { run_id: plan.plan_id, enabled: true },
    };
    return { root, artifactsDir, state, runId: plan.plan_id, item: { id: unit.id, obligation_ids: unit.requirement_ids } };
  }

  async function answerConformance(value: ConformanceTarget, options: { mode?: string; verdict?: string; binding?: string } = {}) {
    const paths = conformanceReviewPaths(value.artifactsDir, value.runId, value.item.id);
    const request = JSON.parse(await readFile(paths.request, "utf8")) as { binding: string };
    await writeFile(paths.response, JSON.stringify({
      schema_version: "contract-conformance-review/v1", binding: options.binding ?? request.binding,
      declaration: { mode: options.mode ?? "independent", reason: "Fresh reviewer context with no shared authorship" },
      verdict: options.verdict ?? "pass", summary: "The cited export and test prove the required behavior",
      obligations: value.item.obligation_ids.map(obligation_id => ({ obligation_id, verdict: "satisfied", evidence: ["src/a.ts:1 exports the required name and value"] })),
    }));
  }
  it("rejects non-independent and insufficient reviews at the shared file-based verdict boundary", async () => {
    const value = await planOnlyConformance({ withGit: false });
    const check = () => checkConformanceSubject({
      artifactsDir: value.artifactsDir, runId: value.runId, itemId: value.item.id,
      obligationIds: value.item.obligation_ids, content: { verified: "stable subject" },
      evidenceInstruction: "Check the bound test evidence",
    });
    await expect(check()).resolves.toMatchObject({
      ok: false, issue: { code: "conformance_review_required" },
    });
    for (const [answer, code] of [
      [{ mode: "unavailable" }, "conformance_review_unavailable"],
      [{ mode: "degraded" }, "conformance_review_unavailable"],
      [{ verdict: "insufficient" }, "conformance_review_insufficient"],
    ] as const) {
      await answerConformance(value, answer);
      await expect(check()).resolves.toMatchObject({ ok: false, issue: { code } });
    }
  });

  describe("opt-in independent contract conformance lifecycle", () => {
    it.each(["landed", "no-change"] as const)(
      "does not spawn required tests until the exact %s result is independently reviewed",
      async mode => {
        const value = await conformanceFixture("node .audit-tools/remediation/record-test.cjs");
        if (mode === "landed") await writeConformanceResult(value);
        else await writeResult(value, decisionFor(value, {
          status: "resolved_no_change",
          evidence: ["src/a.ts already preserves the required export and behavior"],
        }));
        const count = join(value.artifactsDir, "test-count");
        const first = await ingestConformance(value);
        expect(first.accepted_count).toBe(0);
        expect(first.issues.map(issue => issue.code)).toContain("conformance_review_required");
        await expect(readFile(count, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

        await answerConformance(value);
        const redFlag = join(value.artifactsDir, "test-red");
        if (mode === "landed") {
          await writeFile(redFlag, "red");
          const red = await ingestConformance(value);
          expect(red.accepted_count).toBe(0);
          expect(red.issues.map(issue => issue.code)).toContain("required_test_failed");
          expect(await readFile(count, "utf8")).toBe("run\n");
          await rm(redFlag);
        }
        const accepted = await ingestConformance(value);
        expect(accepted.accepted_count).toBe(1);
        expect(accepted.state.items.B1?.status).toBe(mode === "landed" ? "resolved" : "resolved_no_change");
        expect(accepted.state.conformance_review?.enabled).toBe(true);
        expect(accepted.state.items.B1?.conformance_review?.requirement).toBe("independent");
        expect(await readFile(count, "utf8")).toBe(mode === "landed" ? "run\nrun\n" : "run\n");
      },
    );
    it.each(["implementation", "triage"])("structured admission feeds the actual %s conformance consumer", async source => {
      const value = await conformanceFixture();
      const state: RemediationState = boundState(value);
      if (source === "triage") {
        state.items!.B1.status = "blocked";
        delete state.host_handoff;
        await runTriagePhase(state, { root: value.root, artifactsDir: value.artifactsDir });
      } else {
        await writeConformanceResult(value);
        expect((await ingestConformance(value)).accepted_count).toBe(0);
      }
      await new StateStore(value.artifactsDir).saveState(state);
      const paths = conformanceReviewPaths(value.artifactsDir, value.runId, value.item.id);
      const request = JSON.parse(await readFile(paths.request, "utf8"));
      const response = { ...request.response_template, summary: "Independent source and test review",
        declaration: { mode: "independent", reason: "Separate context without author reasoning" } };
      expect(await submitRemediationGateResult({ artifactsDir: value.artifactsDir,
        lane: "conformance_review", workItemId: value.item.id, source: JSON.stringify(response) })).toMatchObject({ written: true, path: paths.response });
      if (source === "triage") {
        const accepted = await runTriagePhase(state, { root: value.root, artifactsDir: value.artifactsDir });
        expect(accepted.items!.B1.status).toBe("resolved_no_change");
        expect(accepted.items!.B1.conformance_review).toBeDefined();
      } else expect((await ingestConformance(value)).accepted_count).toBe(1);
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
    it("production next-step continues bound returned work without a resume acknowledgment, retaining independent review", async () => {
      const value = await conformanceFixture(); await writeConformanceResult(value); await persistBoundState(value);
      const step = await decideNextStep({ root: value.root, artifactsDir: value.artifactsDir, finalGateRunner: () => ({ status: 0 }) });
      expect(step.step_kind).toBe("review_contract_conformance");
      expect(await readFile(step.prompt_path, "utf8")).toContain("context that did not author");
      expect((await new StateStore(value.artifactsDir).loadState())!.items![value.item.id]!.status).toBe("pending");
      await expect(readFile(join(value.artifactsDir, "confirm_resume_ack.json"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  describe("bound returned work only removes the redundant resume acknowledgment", () => {
    it("recognizes only a current bound submission for a pending item without requiring a landing", async () => {
      const value = await conformanceFixture();
      const result = resultFor(value, value.baseline);
      const probe = (state = boundState(value)) => hasBoundRemediationSubmission({
        root: value.root, artifactsDir: value.artifactsDir, runId: value.runId, state,
      });
      await writeResult(value, result);
      expect(await probe()).toBe(true);
      const withoutBinding = boundState(value);
      delete withoutBinding.host_handoff;
      expect(await probe(withoutBinding), "missing binding").toBe(false);
      const changedWorkload = boundState(value);
      changedWorkload.host_handoff = { ...changedWorkload.host_handoff!, workload_sha256: "0".repeat(64) };
      expect(await probe(changedWorkload), "changed workload").toBe(false);
      const settled = structuredClone(boundState(value));
      settled.items[value.item.id]!.status = "resolved";
      expect(await probe(settled), "already settled").toBe(false);

      for (const [key, replacement] of [
        ["run_id", "another-run"], ["work_item_id", "another-item"], ["prompt_sha256", "0".repeat(64)],
      ] as const) {
        await writeResult(value, { ...result, [key]: replacement });
        expect(await probe(), key).toBe(false);
      }
      const path = join(value.root, value.item.result_path);
      await writeFile(path, "{");
      expect(await probe(), "malformed result").toBe(false);
      await rm(path);
      expect(await probe(), "missing result").toBe(false);
    });

    it("an explicit restart still prompts even if ordinary continuation would accept the binding", async () => {
      const value = await conformanceFixture();
      await writeResult(value, resultFor(value, value.baseline));
      await writeFile(join(value.artifactsDir, "confirm_resume_ack.json"), JSON.stringify({ choice: "restart" }));
      await persistBoundState(value);
      const step = await decideNextStep({ root: value.root, artifactsDir: value.artifactsDir });
      expect(step.step_kind).toBe("confirm_resume_or_restart");
    });
    it("new guidance still requires the source-conflict choice", async () => {
      const value = await conformanceFixture();
      await writeResult(value, resultFor(value, value.baseline));
      await persistBoundState(value);
      const step = await decideNextStep({ root: value.root, artifactsDir: value.artifactsDir, guidanceText: "Use a different scope" });
      expect(step.step_kind).toBe("input_conflict");
      expect((await new StateStore(value.artifactsDir).loadState())!.items![value.item.id]!.status).toBe("pending");
    });

    it.each(["pause", "cancel"] as const)("%s still stops before returned work is ingested", async (action) => {
      const value = await conformanceFixture();
      await writeResult(value, resultFor(value, value.baseline));
      await persistBoundState(value);
      const store = new StateStore(value.artifactsDir);
      await store.withActiveOperator(() => store.setOperatorLifecycleUnderPhaseLock(action));
      const step = await decideNextStep({ root: value.root, artifactsDir: value.artifactsDir });
      expect(step.step_kind).toBe(action === "pause" ? "operator_paused" : "operator_cancelled");
      expect((await store.loadState())!.items![value.item.id]!.status).toBe("pending");
      await expect(readFile(conformanceReviewPaths(value.artifactsDir, value.runId, value.item.id).request)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

    it("blocked ingestion reaches opted-in triage review and rejects changed uncommitted evidence", async () => {
      const value = await conformanceFixture();
      await writeResult(value, decisionFor(value, { status: "blocked", failure_reason: "Missing owner decision" }));
      const ingested = await ingestConformance(value);
      expect(ingested.accepted_count).toBe(1);
      expect(ingested.state.items.B1?.status).toBe("blocked");
      const paths = conformanceReviewPaths(value.artifactsDir, value.runId, value.item.id);
      await expect(readFile(paths.request)).rejects.toMatchObject({ code: "ENOENT" });
      await persistBoundState(value, ingested.state);
      await writeFile(join(value.artifactsDir, "confirm_resume_ack.json"), JSON.stringify({ choice: "resume" }));
      const step = await decideNextStep({ root: value.root, artifactsDir: value.artifactsDir, finalGateRunner: () => ({ status: 0 }) });
      expect(step.step_kind).toBe("review_contract_conformance");
      const store = new StateStore(value.artifactsDir);
      const paused = (await store.loadState())!;
      expect(paused.items!.B1.status).toBe("blocked");
      const requestB = JSON.parse(await readFile(paths.request, "utf8")) as { binding: string };
      const checkReview = async (state: RemediationState) =>
        checkTriageConformance(value.root, value.artifactsDir, state, value.item.id,
          await triageEvidenceContext(value.root, state, value.item.id));
      await expect(checkReview(paused)).resolves.toMatchObject({
        ok: false, issue: { code: "conformance_review_required" },
      });
      expect(JSON.parse(await readFile(paths.request, "utf8")).binding).toBe(requestB.binding);
      await answerConformance(value);
      await writeFile(join(value.root, "src/a.ts"), "export const value = 27;\n");
      const again = await decideNextStep({ root: value.root, artifactsDir: value.artifactsDir, finalGateRunner: () => ({ status: 0 }) });
      expect(again.step_kind).toBe("review_contract_conformance");
      const requestC = JSON.parse(await readFile(paths.request, "utf8")) as { binding: string };
      expect(requestC.binding).not.toBe(requestB.binding);
      expect((await store.loadState())!.items!.B1.status).toBe("blocked");
      expect(JSON.parse(await readFile(paths.request, "utf8")).binding).toBe(requestC.binding);
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
    });
    it("closing refuses successful units without required conformance receipts", async () => {
      const value = await planOnlyConformance({ withGit: false });
      const state = value.state;
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
    it("triage evidence binds explicitly invoked scripts in otherwise ignored locations", async () => {
      const scripts = [".audit-tools/remediation/triage-stable.cjs", "..cache/triage-stable.cjs"];
      const value = await planOnlyConformance({ requiredTests: scripts.map(script => "node " + script) });
      await mkdir(join(value.root, "..cache"));
      await writeFile(join(value.root, ".git", "info", "exclude"), "\n..cache/\n", { flag: "a" });
      for (const path of scripts) await writeFile(join(value.root, path), "process.exit(0);");
      let before = await triageEvidenceContext(value.root, value.state, value.item.id);
      expect(before).not.toBeNull();
      for (const path of scripts) {
        await writeFile(join(value.root, path), "process.exit(1);");
        const after = await triageEvidenceContext(value.root, value.state, value.item.id);
        expect(after, path).not.toBeNull();
        expect(after, path).not.toEqual(before);
        before = after;
      }
    });
    it("fully-green cleanup preserves the actual triage conformance subject with promoted evidence", async () => {
      const value = await planOnlyConformance();
      await runTriagePhase(value.state, { root: value.root, artifactsDir: value.artifactsDir });
      await answerConformance(value);
      const accepted = await runTriagePhase(value.state, { root: value.root, artifactsDir: value.artifactsDir });
      expect(accepted.items!.B1!.status).toBe("resolved_no_change");
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
    const value = await conformanceFixture();
    await writeResult(value, resultFor(value, value.baseline));
    const state = boundState(value);
    delete state.conformance_review;
    const outcome = await ingestRemediationHostResults({ root: value.root, artifactsDir: value.artifactsDir, runId: value.runId, state });
    expect(outcome).toBe("unsupported_retired_state");
  });

});
