// sites-pinned: none
// The per-result contract conformance review (O39 / packet 17): the opt-in
// sufficiency half of the owner decision, beside the mechanical obligation-
// coverage floor `parseResult` already enforces.
//
// Two halves: the PURE engine (mint / bind / parse / decide) and the INGEST
// integration (default-off, pass, insufficient, unavailable, stale, correction-
// then-accept, and that the review cannot bypass mechanical coverage).
import { dirname, join } from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { execFileHidden } from "../helpers/spawn.mjs";

import type {
  ConformanceReviewRequest,
} from "../../src/remediate/steps/dispatch/conformanceReview.js";
import {
  CONFORMANCE_REVIEW_CONTRACT_VERSION,
  mintConformanceReview,
  parseConformanceVerdict,
  renderUnavailableVerdict,
} from "../../src/remediate/steps/dispatch/conformanceReview.js";
import type { RemediationHostWorkItem } from "../../src/remediate/steps/dispatch/hostHandoff.js";
import { REMEDIATION_HOST_RESULT_CONTRACT_VERSION as RESULT_VERSION } from "../../src/remediate/steps/types.js";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { recoverIngestHostResults } from "../../src/remediate/steps/recovery.js";
import { StateStore, REMEDIATION_STATE_CONTRACT_VERSION, type RemediationState } from "../../src/remediate/state/store.js";
import { deriveResultId } from "../../src/shared/index.js";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";
import { intakeSummaryFixture } from "./helpers/intakeSummaryFixture.js";

// ── Pure engine ──────────────────────────────────────────────────────────────

const CONTRACT = {
  module: "auth-module",
  contract: { invariants: ["a token is never logged"], inputs: ["credentials"] },
};

function review(
  overrides: Partial<Parameters<typeof mintConformanceReview>[0]> = {},
): ConformanceReviewRequest {
  return mintConformanceReview({
    resultId: "result-1",
    workItemId: "block-a",
    obligationIds: ["OBL-1"],
    moduleContracts: [CONTRACT],
    obligationEvidence: [{ obligation_id: "OBL-1", evidence: ["src/a.ts:42"] }],
    ...overrides,
  });
}

describe("conformance review engine", () => {
  it("binds the review to result, obligation set, and contract content", () => {
    const a = review();
    const same = review();
    expect(a.review_id).toBe(same.review_id);

    const changedResult = review({ resultId: "result-2" });
    const changedWorkItem = review({ workItemId: "block-b" });
    expect(changedResult.review_id).not.toBe(a.review_id);
    expect(changedWorkItem.review_id).not.toBe(a.review_id);
    const priorVerdict = JSON.stringify({
      contract_version: CONFORMANCE_REVIEW_CONTRACT_VERSION,
      review_id: a.review_id,
      status: "conforms",
    });
    expect(parseConformanceVerdict(priorVerdict, changedResult)).toEqual({ kind: "stale" });
    expect(parseConformanceVerdict(priorVerdict, changedWorkItem)).toEqual({ kind: "stale" });

    const changedEvidence = review({
      obligationEvidence: [{ obligation_id: "OBL-1", evidence: ["src/a.ts:43"] }],
    });
    expect(changedEvidence.review_id).not.toBe(a.review_id);

    const changedContracts = mintConformanceReview({
      resultId: "result-1",
      workItemId: "block-a",
      obligationIds: ["OBL-1"],
      moduleContracts: [{ module: "auth-module", contract: { invariants: ["changed"] } }],
      obligationEvidence: [{ obligation_id: "OBL-1", evidence: ["src/a.ts:42"] }],
    });
    expect(changedContracts.review_id).not.toBe(a.review_id);

    // Obligation set is bound: a different obligation id is a different review.
    const changedObligations = mintConformanceReview({
      resultId: "result-1",
      workItemId: "block-a",
      obligationIds: ["OBL-2"],
      moduleContracts: [CONTRACT],
      obligationEvidence: [{ obligation_id: "OBL-2", evidence: ["src/a.ts:42"] }],
    });
    expect(changedObligations.review_id).not.toBe(a.review_id);

    // Obligation evidence ordering is canonicalized:
    const multi1 = mintConformanceReview({
      resultId: "result-1",
      workItemId: "block-a",
      obligationIds: ["OBL-1", "OBL-2"],
      moduleContracts: [CONTRACT],
      obligationEvidence: [
        { obligation_id: "OBL-1", evidence: ["src/a.ts:1"] },
        { obligation_id: "OBL-2", evidence: ["src/b.ts:2"] },
      ],
    });
    const multi2 = mintConformanceReview({
      resultId: "result-1",
      workItemId: "block-a",
      obligationIds: ["OBL-1", "OBL-2"],
      moduleContracts: [CONTRACT],
      obligationEvidence: [
        { obligation_id: "OBL-2", evidence: ["src/b.ts:2"] },
        { obligation_id: "OBL-1", evidence: ["src/a.ts:1"] },
      ],
    });
    expect(multi1.review_id).toBe(multi2.review_id);
  });

  it("parses a passing, insufficient, and unavailable verdict", () => {
    const req = review();
    const pass = JSON.stringify({
      contract_version: CONFORMANCE_REVIEW_CONTRACT_VERSION,
      review_id: req.review_id,
      status: "conforms",
    });
    expect(parseConformanceVerdict(pass, req)).toEqual({ kind: "pass" });

    const insufficient = JSON.stringify({
      contract_version: CONFORMANCE_REVIEW_CONTRACT_VERSION,
      review_id: req.review_id,
      status: "insufficient_evidence",
      rationale: "no test demonstrates the invariant",
    });
    expect(parseConformanceVerdict(insufficient, req)).toEqual({
      kind: "insufficient",
      rationale: "no test demonstrates the invariant",
    });

    const unavailable = JSON.stringify({
      contract_version: CONFORMANCE_REVIEW_CONTRACT_VERSION,
      review_id: req.review_id,
      status: "unavailable",
      rationale: "no reviewer",
    });
    expect(parseConformanceVerdict(unavailable, req)).toEqual({
      kind: "unavailable",
      rationale: "no reviewer",
    });
  });

  it("refuses malformed verdicts and never treats them as a pass", () => {
    const req = review();
    expect(parseConformanceVerdict("{broken", req).kind).toBe("refused");
    expect(parseConformanceVerdict("null", req).kind).toBe("refused");
    expect(
      parseConformanceVerdict(
        JSON.stringify({ contract_version: "retired/v0", review_id: req.review_id, status: "conforms" }),
        req,
      ).kind,
    ).toBe("refused");
    expect(
      parseConformanceVerdict(
        JSON.stringify({ contract_version: CONFORMANCE_REVIEW_CONTRACT_VERSION, review_id: req.review_id, status: "nonsense" }),
        req,
      ).kind,
    ).toBe("refused");
    expect(
      parseConformanceVerdict(
        JSON.stringify({ contract_version: CONFORMANCE_REVIEW_CONTRACT_VERSION, status: "conforms" }),
        req,
      ).kind,
    ).toBe("refused");
    expect(
      parseConformanceVerdict(
        JSON.stringify({ contract_version: CONFORMANCE_REVIEW_CONTRACT_VERSION, review_id: "", status: "conforms" }),
        req,
      ).kind,
    ).toBe("refused");
  });

  it("detects a stale verdict whose binding no longer matches", () => {
    const req = review();
    const other = review({ obligationEvidence: [{ obligation_id: "OBL-1", evidence: ["src/a.ts:99"] }] });
    const stale = JSON.stringify({
      contract_version: CONFORMANCE_REVIEW_CONTRACT_VERSION,
      review_id: other.review_id,
      status: "conforms",
    });
    expect(parseConformanceVerdict(stale, req)).toEqual({ kind: "stale" });
  });

  it("renders an unavailable pause marker bound to the request", () => {
    const req = review();
    const rendered = JSON.parse(renderUnavailableVerdict(req)) as {
      review_id: string;
      status: string;
    };
    expect(rendered.status).toBe("unavailable");
    expect(rendered.review_id).toBe(req.review_id);
    expect(parseConformanceVerdict(renderUnavailableVerdict(req), req)).toEqual({
      kind: "unavailable",
      rationale: "no independent reviewer was available to judge this result",
    });
  });
});

// ── Ingest integration ──────────────────────────────────────────────────────

const CURRENT_STATE_VERSION = REMEDIATION_STATE_CONTRACT_VERSION;
const FIXTURE_RUN_ID = "remediation-run-conformance";

interface HostBoundary {
  prepareRemediationHostHandoff(input: {
    root: string;
    artifactsDir: string;
    runId: string;
    baselineCommit: string;
    state: unknown;
  }): Promise<unknown>;
  ingestRemediationHostResults(input: {
    root: string;
    artifactsDir: string;
    runId: string;
    state: unknown;
  }): Promise<unknown>;
}

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function loadBoundary(): Promise<HostBoundary> {
  return (await import(
    "../../src/remediate/steps/dispatch/hostHandoff.js"
  )) as unknown as HostBoundary;
}

function git(root: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileHidden(
      "git",
      [...args],
      { cwd: root, encoding: "utf8" },
      (error: Error | null, stdout: string) => {
        if (error) reject(error);
        else resolve(String(stdout).trim());
      },
    );
  });
}

async function headOf(root: string): Promise<string> {
  return git(root, ["rev-parse", "HEAD"]);
}

async function initGitRoot(root: string): Promise<string> {
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "review@example.invalid"]);
  await git(root, ["config", "user.name", "Review Fixture"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), 'export const value = "a";\n', "utf8");
  await git(root, ["add", "src/a.ts"]);
  await git(root, ["commit", "-m", "baseline"]);
  return headOf(root);
}

let landedCounter = 0;
async function landCommit(root: string, file: string): Promise<string> {
  const marker = ++landedCounter;
  writeFileSync(join(root, file), `export const value = ${marker};\n`, "utf8");
  await git(root, ["add", file]);
  await git(root, ["commit", "-m", `land ${marker}`]);
  return headOf(root);
}

/** A plan carrying ONE block that binds an obligation and a module contract. */
function conformanceState(): unknown {
  const block = {
    block_id: "block-a",
    items: ["finding-a"],
    parallel_safe: true,
    dependencies: [],
    targeted_commands: ['node -e "process.exit(0)"'],
    touched_files: ["src/a.ts"],
    module_contracts: [
      { module: "auth-module", contract: { invariants: ["no token logged"] } },
    ],
    phase_ordinal: 0,
    token_estimate: 1800,
  };
  const finding = {
    id: "finding-a",
    title: "Fix auth",
    category: "correctness",
    severity: "high",
    confidence: "high",
    lens: "correctness",
    summary: "Repair src/a.ts",
    affected_files: [{ path: "src/a.ts" }],
    evidence: ["src/a.ts:1"],
    contract_obligation_ids: ["OBL-1"],
  };
  return {
    contract_version: CURRENT_STATE_VERSION,
    status: "implementing",
    conformance_review_policy: {
      plan_id: FIXTURE_RUN_ID,
      choice: "on",
      first_dispatch_recorded: true,
    },
    plan: {
      plan_id: FIXTURE_RUN_ID,
      findings: [finding],
      blocks: [block],
      project_type: "typescript",
      candidate_closing_actions: ["none"],
    },
    items: {
      "finding-a": { finding_id: "finding-a", block_id: "block-a", status: "pending" },
    },
  };
}

function resultShape(item: RemediationHostWorkItem, landedCommit: string): Record<string, unknown> {
  return {
    contract_version: RESULT_VERSION,
    result_id: deriveResultId(item.id, item.prompt.sha256),
    run_id: FIXTURE_RUN_ID,
    work_item_id: item.id,
    prompt_sha256: item.prompt.sha256,
    landed_commit: landedCommit,
    obligation_evidence: [{ obligation_id: "OBL-1", evidence: ["src/a.ts:42"] }],
  };
}

interface PreparedHandoff {
  workload: { work_items: readonly RemediationHostWorkItem[] };
  handoff_record: unknown;
}

interface IngestSummary {
  accepted_count: number;
  completed_work_item_ids: readonly string[];
  issues: readonly { code: string; work_item_id?: string; message: string }[];
  state: { items: Record<string, { status: string }> };
}

async function fixture(): Promise<{
  boundary: HostBoundary;
  root: string;
  artifactsDir: string;
  handoff: PreparedHandoff;
  state: unknown;
}> {
  const boundary = await loadBoundary();
  const root = await mkdtemp(join(tmpdir(), "remediation-conformance-"));
  cleanupRoots.push(root);
  const artifactsDir = join(root, ".audit-tools", "remediation");
  const baselineCommit = await initGitRoot(root);
  const base = conformanceState();
  const handoff = (await boundary.prepareRemediationHostHandoff({
    root,
    artifactsDir,
    runId: FIXTURE_RUN_ID,
    baselineCommit,
    state: base,
  })) as PreparedHandoff;
  const state = { ...(base as Record<string, unknown>), host_handoff: handoff.handoff_record };
  return { boundary, root, artifactsDir, handoff, state };
}

function requireIngested(value: unknown): IngestSummary {
  expect(value).not.toBe("unsupported_retired_state");
  return value as IngestSummary;
}

async function writeResult(root: string, item: RemediationHostWorkItem, overrides: Record<string, unknown> = {}): Promise<string> {
  const landed = await landCommit(root, item.allowed_files[0]!);
  const resultPath = join(root, item.result_path);
  const body = { ...resultShape(item, landed), ...overrides };
  await writeFile(resultPath, JSON.stringify(body), "utf8");
  return resultPath;
}

describe("conformance review ingest", () => {
  it("is default-off: without the option, a corroborated result is accepted with no review", async () => {
    const { boundary, root, artifactsDir, handoff, state } = await fixture();
    const item = handoff.workload.work_items[0]!;
    await writeResult(root, item);
    const summary = requireIngested(
      await boundary.ingestRemediationHostResults({
        root, artifactsDir, runId: FIXTURE_RUN_ID,
        state: {
          ...(state as RemediationState),
          conformance_review_policy: {
            plan_id: FIXTURE_RUN_ID, choice: "off", first_dispatch_recorded: true,
          },
        },
      }),
    );
    expect(summary.accepted_count).toBe(1);
    expect(summary.completed_work_item_ids).toContain(item.id);
    expect(summary.issues.some((i) => i.code === "conformance_review")).toBe(false);
  });

  it("holds a result pending review when the option is on and no verdict exists (unavailable)", async () => {
    const { boundary, root, artifactsDir, handoff, state } = await fixture();
    const item = handoff.workload.work_items[0]!;
    await writeResult(root, item);
    const summary = requireIngested(
      await boundary.ingestRemediationHostResults({
        root,
        artifactsDir,
        runId: FIXTURE_RUN_ID,
        state,
      }),
    );
    expect(summary.accepted_count).toBe(0);
    const issue = summary.issues.find((i) => i.code === "conformance_review")!;
    expect(issue).toBeDefined();
    expect(issue.work_item_id).toBe(item.id);
  });

  it("accepts after a passing review, then corrects-and-accepts after an insufficient one", async () => {
    const { boundary, root, artifactsDir, handoff, state } = await fixture();
    const item = handoff.workload.work_items[0]!;
    const resultPath = await writeResult(root, item);

    // No verdict → held.
    const held = requireIngested(
      await boundary.ingestRemediationHostResults({
        root, artifactsDir, runId: FIXTURE_RUN_ID, state,
      }),
    );
    expect(held.accepted_count).toBe(0);

    // Read the persisted request to bind a verdict.
    const requestPath = join(root, ".audit-tools", "remediation", "runs", FIXTURE_RUN_ID, "implement", "conformance-review", `${item.id}.request.json`);
    const request = JSON.parse(await readFile(requestPath, "utf8")) as { review_id: string };
    const verdictPath = join(root, ".audit-tools", "remediation", "runs", FIXTURE_RUN_ID, "implement", "conformance-review", `${item.id}.verdict.json`);

    // Insufficient first → still not accepted.
    await writeFile(verdictPath, JSON.stringify({
      contract_version: CONFORMANCE_REVIEW_CONTRACT_VERSION,
      review_id: request.review_id,
      status: "insufficient_evidence",
      rationale: "no test shows the invariant",
    }), "utf8");
    const insufficient = requireIngested(
      await boundary.ingestRemediationHostResults({
        root, artifactsDir, runId: FIXTURE_RUN_ID, state,
      }),
    );
    expect(insufficient.accepted_count).toBe(0);
    expect(insufficient.issues.find((i) => i.code === "conformance_review")?.message).toContain("insufficient");

    // Correction → pass → accepted.
    await writeFile(verdictPath, JSON.stringify({
      contract_version: CONFORMANCE_REVIEW_CONTRACT_VERSION,
      review_id: request.review_id,
      status: "conforms",
    }), "utf8");
    const accepted = requireIngested(
      await boundary.ingestRemediationHostResults({
        root, artifactsDir, runId: FIXTURE_RUN_ID, state,
      }),
    );
    expect(accepted.accepted_count).toBe(1);
    expect(accepted.completed_work_item_ids).toContain(item.id);
    void resultPath;
  });

  it("rejects a stale verdict bound to a changed result (changed content invalidates the review)", async () => {
    const { boundary, root, artifactsDir, handoff, state } = await fixture();
    const item = handoff.workload.work_items[0]!;

    // First result (evidence [42]) → mint request A.
    await writeResult(root, item);
    await boundary.ingestRemediationHostResults({
      root, artifactsDir, runId: FIXTURE_RUN_ID, state,
    });
    const requestPath = join(root, ".audit-tools", "remediation", "runs", FIXTURE_RUN_ID, "implement", "conformance-review", `${item.id}.request.json`);
    const requestA = JSON.parse(await readFile(requestPath, "utf8")) as { review_id: string };
    const verdictPath = join(root, ".audit-tools", "remediation", "runs", FIXTURE_RUN_ID, "implement", "conformance-review", `${item.id}.verdict.json`);

    // A verdict bound to request A, written now — but the result content will
    // differ, so minting the request again yields a DIFFERENT id → stale.
    // Simulate the change by writing a result with different evidence, which the
    // next ingest re-mints into request B.
    await writeResult(root, item, { obligation_evidence: [{ obligation_id: "OBL-1", evidence: ["src/a.ts:99"] }] });
    // The verdict still names request A's id.
    await writeFile(verdictPath, JSON.stringify({
      contract_version: CONFORMANCE_REVIEW_CONTRACT_VERSION,
      review_id: requestA.review_id,
      status: "conforms",
    }), "utf8");
    const stale = requireIngested(
      await boundary.ingestRemediationHostResults({
        root, artifactsDir, runId: FIXTURE_RUN_ID, state,
      }),
    );
    expect(stale.accepted_count).toBe(0);
    expect(stale.issues.find((i) => i.code === "conformance_review")?.message).toContain("changed");
  });

  it("accepts a mechanically corroborated result after a successful conformance review", async () => {
    const { boundary, root, artifactsDir, handoff, state } = await fixture();
    const item = handoff.workload.work_items[0]!;
    await writeResult(root, item);

    // Initial ingest mints request
    await boundary.ingestRemediationHostResults({
      root, artifactsDir, runId: FIXTURE_RUN_ID, state,
    });
    const requestPath = join(root, ".audit-tools", "remediation", "runs", FIXTURE_RUN_ID, "implement", "conformance-review", `${item.id}.request.json`);
    const request = JSON.parse(await readFile(requestPath, "utf8")) as { review_id: string };
    const verdictPath = join(root, ".audit-tools", "remediation", "runs", FIXTURE_RUN_ID, "implement", "conformance-review", `${item.id}.verdict.json`);

    // Write passing verdict
    await writeFile(verdictPath, JSON.stringify({
      contract_version: CONFORMANCE_REVIEW_CONTRACT_VERSION,
      review_id: request.review_id,
      status: "conforms",
    }), "utf8");

    const accepted = requireIngested(
      await boundary.ingestRemediationHostResults({
        root, artifactsDir, runId: FIXTURE_RUN_ID, state,
      }),
    );
    expect(accepted.accepted_count).toBe(1);
    expect(accepted.completed_work_item_ids).toContain(item.id);
    expect(accepted.issues.some((i) => i.code === "conformance_review")).toBe(false);
  });

  it("holds a result when an independent reviewer returns an unavailable verdict", async () => {
    const { boundary, root, artifactsDir, handoff, state } = await fixture();
    const item = handoff.workload.work_items[0]!;
    await writeResult(root, item);

    // Initial ingest mints request
    await boundary.ingestRemediationHostResults({
      root, artifactsDir, runId: FIXTURE_RUN_ID, state,
    });
    const requestPath = join(root, ".audit-tools", "remediation", "runs", FIXTURE_RUN_ID, "implement", "conformance-review", `${item.id}.request.json`);
    const request = JSON.parse(await readFile(requestPath, "utf8")) as { review_id: string };
    const verdictPath = join(root, ".audit-tools", "remediation", "runs", FIXTURE_RUN_ID, "implement", "conformance-review", `${item.id}.verdict.json`);

    await writeFile(verdictPath, JSON.stringify({
      contract_version: CONFORMANCE_REVIEW_CONTRACT_VERSION,
      review_id: request.review_id,
      status: "unavailable",
      rationale: "independent reviewer pool exhausted",
    }), "utf8");

    const summary = requireIngested(
      await boundary.ingestRemediationHostResults({
        root, artifactsDir, runId: FIXTURE_RUN_ID, state,
      }),
    );
    expect(summary.accepted_count).toBe(0);
    const issue = summary.issues.find((i) => i.code === "conformance_review")!;
    expect(issue).toBeDefined();
    expect(issue.message).toContain("independent reviewer pool exhausted");
    expect(issue.message).toContain("the result is held, not accepted");
  });

  it("rejects a stale verdict when carried module contracts change (changed contract invalidates review)", async () => {
    const { boundary, root, artifactsDir, handoff, state } = await fixture();
    const item = handoff.workload.work_items[0]!;
    await writeResult(root, item);

    // Initial ingest mints request against original contract
    await boundary.ingestRemediationHostResults({
      root, artifactsDir, runId: FIXTURE_RUN_ID, state,
    });
    const requestPath = join(root, ".audit-tools", "remediation", "runs", FIXTURE_RUN_ID, "implement", "conformance-review", `${item.id}.request.json`);
    const requestA = JSON.parse(await readFile(requestPath, "utf8")) as { review_id: string };
    const verdictPath = join(root, ".audit-tools", "remediation", "runs", FIXTURE_RUN_ID, "implement", "conformance-review", `${item.id}.verdict.json`);

    // Write a verdict matching request A
    await writeFile(verdictPath, JSON.stringify({
      contract_version: CONFORMANCE_REVIEW_CONTRACT_VERSION,
      review_id: requestA.review_id,
      status: "conforms",
    }), "utf8");

    // Mutate module contracts in state
    const modifiedState = JSON.parse(JSON.stringify(state)) as {
      plan: { blocks: { block_id: string; module_contracts: { module: string; contract: unknown }[] }[] };
    };
    modifiedState.plan.blocks[0]!.module_contracts = [
      { module: "auth-module", contract: { invariants: ["changed contract invariant"] } },
    ];

    // Re-prepare handoff so workload matches new contract
    const rePrepared = (await boundary.prepareRemediationHostHandoff({
      root,
      artifactsDir,
      runId: FIXTURE_RUN_ID,
      baselineCommit: await headOf(root),
      state: modifiedState,
    })) as PreparedHandoff;
    const rePreparedState = { ...modifiedState, host_handoff: rePrepared.handoff_record };
    // Write mechanically corroborated result for the new work item, but keep old verdict
    await writeResult(root, rePrepared.workload.work_items[0]!);

    const stale = requireIngested(
      await boundary.ingestRemediationHostResults({
        root, artifactsDir, runId: FIXTURE_RUN_ID, state: rePreparedState,
      }),
    );
    expect(stale.accepted_count).toBe(0);
    expect(stale.issues.find((i) => i.code === "conformance_review")?.message).toContain("changed");
  });

  it("cannot bypass the mechanical obligation-coverage floor even with a conforming verdict", async () => {
    const { boundary, root, artifactsDir, handoff, state } = await fixture();
    const item = handoff.workload.work_items[0]!;
    // A result that does NOT cover the bound obligation — mechanical parseResult
    // refuses it BEFORE any review is considered, even with the option on.
    await writeResult(root, item, { obligation_evidence: [] });

    // Place a conforming verdict on disk attempting to bypass the floor
    const verdictPath = join(root, ".audit-tools", "remediation", "runs", FIXTURE_RUN_ID, "implement", "conformance-review", `${item.id}.verdict.json`);
    await mkdir(dirname(verdictPath), { recursive: true });
    await writeFile(verdictPath, JSON.stringify({
      contract_version: CONFORMANCE_REVIEW_CONTRACT_VERSION,
      review_id: "any-id",
      status: "conforms",
    }), "utf8");

    const summary = requireIngested(
      await boundary.ingestRemediationHostResults({
        root, artifactsDir, runId: FIXTURE_RUN_ID, state,
      }),
    );
    expect(summary.accepted_count).toBe(0);
    // The refusal is the mechanical obligation-coverage floor (a contract-invalid
    // submission that fails the obligation_evidence check), NOT conformance_review.
    expect(summary.issues.some((i) => i.code === "submission_contract_invalid")).toBe(true);
    expect(summary.issues.some((i) => i.code === "conformance_review")).toBe(false);
  });
});

async function setupImplementingRun(artifactsDir: string, state: unknown): Promise<void> {
  const store = new StateStore(artifactsDir);
  await store.saveState({
    ...(state as RemediationState),
    conformance_review_policy: {
      plan_id: (state as RemediationState).plan!.plan_id,
      choice: "undecided",
      first_dispatch_recorded: false,
    },
  });
  await writeFile(
    join(artifactsDir, "intent_checkpoint.json"),
    JSON.stringify({
      schema_version: "intent-checkpoint/v1",
      confirmed_at: new Date().toISOString(),
      scope_summary: "Test scope",
      intent_summary: "Test intent",
      confirmed_by: "host",
      closing_action: "none",
    }),
    "utf8",
  );
  await writeFile(
    join(artifactsDir, "confirm_resume_ack.json"),
    JSON.stringify({ choice: "resume" }),
    "utf8",
  );
}

describe("conformance review end-to-end via decideNextStep", () => {
  it("stamps a fresh pending state undecided so later pre-dispatch opt-in remains possible", async () => {
    const { artifactsDir } = await fixture();
    const store = new StateStore(artifactsDir);
    await store.saveState({ status: "pending" });
    expect((await store.loadState())?.conformance_review_policy).toMatchObject({
      choice: "undecided", first_dispatch_recorded: false,
    });
  });

  it("leaves an ordinary fresh plan undecided until its first dispatch", async () => {
    const harness = createNextStepHarness(".test-conformance-fresh-default");
    const { REPO_DIR, ARTIFACTS_DIR } = harness;
    await harness.resetTestRepo();
    try {
      const inputPath = join(REPO_DIR, "feedback.md");
      const intakeDir = join(ARTIFACTS_DIR, "intake");
      await mkdir(intakeDir, { recursive: true });
      await writeFile(inputPath, "# Notes\n\nPlease clean up the auth flow.\n", "utf8");
      await writeFile(join(intakeDir, "source-manifest.json"), JSON.stringify({
        schema_version: "remediate-code-intake-source-manifest/v1alpha1",
        created_from: "input",
        sources: [{ type: "document", path: inputPath }],
      }));
      await writeFile(join(intakeDir, "intake-summary.json"), JSON.stringify(
        intakeSummaryFixture({
          goals: ["Clean up the auth flow."],
          affected_files: [{ path: "src/auth.ts" }],
        }),
      ));
      await harness.writeIntentCheckpoint();
      await harness.acknowledgeResume();
      await harness.writeCompleteContractPipelineDag();

      const review = await decideNextStep({ root: REPO_DIR });
      expect(review.step_kind).not.toBe("dispatch_implement");
      const before = await new StateStore(ARTIFACTS_DIR).loadState();
      expect(before?.plan?.plan_id).toEqual(expect.any(String));
      expect(before?.conformance_review_policy).toMatchObject({
        plan_id: before?.plan?.plan_id,
        choice: "undecided",
        first_dispatch_recorded: false,
      });
      expect(before?.host_handoff).toBeUndefined();

      await harness.approveReviewGate();
      const dispatch = await decideNextStep({ root: REPO_DIR });
      expect(dispatch.step_kind).toBe("dispatch_implement");
      expect((await new StateStore(ARTIFACTS_DIR).loadState())?.conformance_review_policy)
        .toMatchObject({ choice: "off", first_dispatch_recorded: true });
    } finally {
      await harness.cleanupTestRepo();
    }
  });

  it("accepts a fresh opt-in before intake and keeps it in primary state", async () => {
    const root = await mkdtemp(join(tmpdir(), "remediation-conformance-fresh-"));
    cleanupRoots.push(root);
    await initGitRoot(root);
    const artifactsDir = join(root, ".audit-tools", "remediation");
    const input = join(root, "brief.md");
    await writeFile(input, "# Repair the auth module\n", "utf8");

    const first = await decideNextStep({
      root, artifactsDir, input, conformanceReview: true, skipFinalGate: true,
    });
    expect(first.step_kind).not.toBe("blocked");
    expect((await new StateStore(artifactsDir).loadState())?.conformance_review_policy?.choice).toBe("on");
  });

  it("rejects a policy-aware state whose primary review policy was deleted", async () => {
    const { artifactsDir, state } = await fixture();
    const store = new StateStore(artifactsDir);
    await store.saveState({
      ...(state as RemediationState),
      conformance_review_policy: {
        plan_id: FIXTURE_RUN_ID,
        choice: "on",
        first_dispatch_recorded: true,
      },
    } as RemediationState);
    const path = join(artifactsDir, "state.json");
    const tampered = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    delete tampered.conformance_review_policy;
    await writeFile(path, JSON.stringify(tampered), "utf8");

    await expect(store.loadState()).rejects.toThrow(/conformance_review_policy/);
  });

  it("projects a legacy planned run to conservative off and refuses an old opt-in sidecar", async () => {
    const { artifactsDir, state } = await fixture();
    const legacy = { ...(state as RemediationState) } as Record<string, unknown>;
    legacy.contract_version = "remediate-code-state/v1alpha1";
    delete legacy.conformance_review_policy;
    await writeFile(join(artifactsDir, "state.json"), JSON.stringify(legacy));
    const store = new StateStore(artifactsDir);
    expect((await store.loadState())?.conformance_review_policy).toMatchObject({
      plan_id: FIXTURE_RUN_ID, choice: "off", first_dispatch_recorded: true,
    });

    const selectionPath = join(artifactsDir, "runs", FIXTURE_RUN_ID, "implement", "conformance-review", "selection.json");
    await mkdir(dirname(selectionPath), { recursive: true });
    await writeFile(selectionPath, JSON.stringify({
      schema_version: "remediate-code-conformance-review-selection/v1alpha1",
      run_id: FIXTURE_RUN_ID,
      enabled: true,
    }));
    await expect(store.loadState()).rejects.toThrow(/fresh artifacts directory/);
  });

  it("keeps review mandatory in recovery after the selection sidecar is deleted", async () => {
    const { root, artifactsDir, handoff, state } = await fixture();
    await setupImplementingRun(artifactsDir, state);
    const dispatch = await decideNextStep({
      root, artifactsDir, conformanceReview: true, skipFinalGate: true,
    });
    expect(dispatch.step_kind).toBe("dispatch_implement");
    // The legacy sidecar is absent; primary state still requires review.
    await expect(readFile(join(artifactsDir, "runs", FIXTURE_RUN_ID, "implement", "conformance-review", "selection.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await writeResult(root, handoff.workload.work_items[0]!);

    const recovered = await recoverIngestHostResults({ root, artifactsDir, runId: FIXTURE_RUN_ID });
    expect(recovered.accepted_count).toBe(0);
    expect(recovered.issues.some((issue) => issue.code === "conformance_review")).toBe(true);
    expect((await new StateStore(artifactsDir).loadState())?.items?.["finding-a"]?.status).toBe("pending");
  });

  it("refuses late opt-in after the step is overwritten and the handoff is cleared", async () => {
    const { root, artifactsDir, state } = await fixture();
    await setupImplementingRun(artifactsDir, state);
    const first = await decideNextStep({ root, artifactsDir, skipFinalGate: true });
    expect(first.step_kind).toBe("dispatch_implement");
    const store = new StateStore(artifactsDir);
    const saved = (await store.loadState())!;
    expect(saved.items?.["finding-a"]?.status).toBe("pending");
    await store.saveState({ ...saved, host_handoff: undefined });
    await rm(join(artifactsDir, "steps", "current-step.json"));

    const late = await decideNextStep({
      root, artifactsDir, conformanceReview: true, skipFinalGate: true,
    });
    expect(late.step_kind).toBe("blocked");
    expect(await readFile(late.prompt_path, "utf8")).toContain("already emitted implementation work");
  });

  it("refuses a late plan-only flag instead of dispatching implementation", async () => {
    const { root, artifactsDir, state } = await fixture();
    await setupImplementingRun(artifactsDir, state);
    expect((await decideNextStep({ root, artifactsDir, skipFinalGate: true })).step_kind)
      .toBe("dispatch_implement");
    const late = await decideNextStep({ root, artifactsDir, planOnly: true, skipFinalGate: true });
    expect(late.step_kind).toBe("blocked");
    expect(await readFile(late.prompt_path, "utf8")).toContain("Plan-only request is late");
    expect((await new StateStore(artifactsDir).loadState())?.plan_only_request).toBeUndefined();
  });

  it("retains the run-bound review when recover-ingest handles a pending result", async () => {
    const { root, artifactsDir, handoff, state } = await fixture();
    const item = handoff.workload.work_items[0]!;
    await setupImplementingRun(artifactsDir, state);
    await decideNextStep({ root, artifactsDir, conformanceReview: true, skipFinalGate: true });
    await writeResult(root, item);

    const recovered = await recoverIngestHostResults({ root, artifactsDir, runId: FIXTURE_RUN_ID });
    expect(recovered.accepted_count).toBe(0);
    expect(recovered.issues.some((issue) => issue.code === "conformance_review")).toBe(true);
    expect((await new StateStore(artifactsDir).loadState())?.items?.["finding-a"]?.status).toBe("pending");
  });

  it("refuses recover-ingest when the primary policy binding is malformed", async () => {
    const { root, artifactsDir, handoff, state } = await fixture();
    await setupImplementingRun(artifactsDir, state);
    await decideNextStep({ root, artifactsDir, conformanceReview: true, skipFinalGate: true });
    const statePath = join(artifactsDir, "state.json");
    const malformed = JSON.parse(await readFile(statePath, "utf8")) as RemediationState;
    malformed.conformance_review_policy = {
      plan_id: "wrong-run", choice: "on", first_dispatch_recorded: true,
    };
    await writeFile(statePath, JSON.stringify(malformed));
    await writeResult(root, handoff.workload.work_items[0]!);
    await expect(recoverIngestHostResults({ root, artifactsDir, runId: FIXTURE_RUN_ID }))
      .rejects.toThrow(/conformance_review_policy/);
  });

  it("latches an opt-in before implementation rather than forgetting it across intake", async () => {
    const { root, artifactsDir } = await fixture();
    const input = join(root, "brief.md");
    await writeFile(input, "# Repair the auth module\n", "utf8");
    const early = await decideNextStep({
      root, artifactsDir, input, conformanceReview: true, skipFinalGate: true,
    });
    expect(early.step_kind).not.toBe("blocked");
    expect((await new StateStore(artifactsDir).loadState())?.conformance_review_policy?.choice).toBe("on");
  });

  it("latches the choice before a resume question pauses an implementing run", async () => {
    const { root, artifactsDir, handoff, state } = await fixture();
    await setupImplementingRun(artifactsDir, state);
    await rm(join(artifactsDir, "confirm_resume_ack.json"));
    const paused = await decideNextStep({
      root, artifactsDir, conformanceReview: true, skipFinalGate: true,
    });
    expect(paused.step_kind).toBe("confirm_resume_or_restart");
    expect((await new StateStore(artifactsDir).loadState())?.conformance_review_policy).toMatchObject({
      plan_id: FIXTURE_RUN_ID, choice: "on", first_dispatch_recorded: false,
    });
    await writeFile(join(artifactsDir, "confirm_resume_ack.json"), JSON.stringify({ choice: "resume" }));
    await writeResult(root, handoff.workload.work_items[0]!);
    const continued = await decideNextStep({ root, artifactsDir, skipFinalGate: true });
    expect(continued.step_kind).toBe("dispatch_implement");
    expect((await new StateStore(artifactsDir).loadState())?.items?.["finding-a"]?.status).toBe("pending");
  });

  it("refuses an opt-in after the run already emitted its first unreviewed dispatch", async () => {
    const { root, artifactsDir, state } = await fixture();
    await setupImplementingRun(artifactsDir, state);
    const first = await decideNextStep({ root, artifactsDir, skipFinalGate: true });
    expect(first.step_kind).toBe("dispatch_implement");

    for (let attempt = 0; attempt < 2; attempt++) {
      const late = await decideNextStep({
        root, artifactsDir, conformanceReview: true, skipFinalGate: true,
      });
      expect(late.step_kind).toBe("blocked");
      expect(await readFile(late.prompt_path, "utf8")).toContain("already emitted implementation work");
    }
    expect((await new StateStore(artifactsDir).loadState())?.conformance_review_policy).toMatchObject({
      choice: "off", first_dispatch_recorded: true,
    });
  });

  it("keeps an opted-in dispatch under review across bare next-step calls", async () => {
    const { root, artifactsDir, handoff, state } = await fixture();
    const item = handoff.workload.work_items[0]!;
    await setupImplementingRun(artifactsDir, state);

    // The option is supplied for dispatch, before the worker result exists.
    const dispatch = await decideNextStep({
      root, artifactsDir, conformanceReview: true, skipFinalGate: true,
    });
    expect(dispatch.step_kind).toBe("dispatch_implement");
    expect((await new StateStore(artifactsDir).loadState())?.conformance_review_policy).toMatchObject({
      plan_id: FIXTURE_RUN_ID, choice: "on", first_dispatch_recorded: true,
    });

    await writeResult(root, item);
    const pending = await decideNextStep({ root, artifactsDir, skipFinalGate: true });
    expect(pending.step_kind).toBe("dispatch_implement");
    const store = new StateStore(artifactsDir);
    expect((await store.loadState())?.items?.["finding-a"]?.status).toBe("pending");
    const requestPath = join(artifactsDir, "runs", FIXTURE_RUN_ID, "implement", "conformance-review", `${item.id}.request.json`);
    const request = JSON.parse(await readFile(requestPath, "utf8")) as { review_id: string };

    const verdictPath = join(artifactsDir, "runs", FIXTURE_RUN_ID, "implement", "conformance-review", `${item.id}.verdict.json`);
    await writeFile(verdictPath, JSON.stringify({
      contract_version: CONFORMANCE_REVIEW_CONTRACT_VERSION,
      review_id: request.review_id,
      status: "conforms",
    }));
    await decideNextStep({ root, artifactsDir, skipFinalGate: true });
    expect((await store.loadState())?.items?.["finding-a"]?.status).toBe("resolved");
  });

  it("refuses a malformed primary run binding before ingesting a result", async () => {
    const { root, artifactsDir, handoff, state } = await fixture();
    await setupImplementingRun(artifactsDir, state);
    await decideNextStep({ root, artifactsDir, conformanceReview: true, skipFinalGate: true });
    const statePath = join(artifactsDir, "state.json");
    const malformed = JSON.parse(await readFile(statePath, "utf8")) as RemediationState;
    malformed.conformance_review_policy = {
      plan_id: "another-run", choice: "on", first_dispatch_recorded: true,
    };
    await writeFile(statePath, JSON.stringify(malformed));
    await writeResult(root, handoff.workload.work_items[0]!);
    await expect(decideNextStep({ root, artifactsDir, skipFinalGate: true }))
      .rejects.toThrow(/conformance_review_policy/);
  });

  it("does not enable review for a distinct plan run in the same artifact root", async () => {
    const { boundary, root, artifactsDir, state } = await fixture();
    await setupImplementingRun(artifactsDir, state);
    await decideNextStep({ root, artifactsDir, conformanceReview: true, skipFinalGate: true });

    const nextRunId = "remediation-run-conformance-next";
    const nextState = conformanceState() as RemediationState;
    nextState.plan!.plan_id = nextRunId;
    nextState.conformance_review_policy = {
      plan_id: nextRunId, choice: "off", first_dispatch_recorded: true,
    };
    const nextHandoff = await boundary.prepareRemediationHostHandoff({
      root,
      artifactsDir,
      runId: nextRunId,
      baselineCommit: await headOf(root),
      state: nextState,
    }) as PreparedHandoff;
    await new StateStore(artifactsDir).saveState({
      ...nextState,
      host_handoff: nextHandoff.handoff_record as RemediationState["host_handoff"],
    });
    await writeResult(root, nextHandoff.workload.work_items[0]!, { run_id: nextRunId });
    await decideNextStep({ root, artifactsDir, skipFinalGate: true });
    await decideNextStep({ root, artifactsDir, skipFinalGate: true });
    expect((await new StateStore(artifactsDir).loadState())?.items?.["finding-a"]?.status).toBe("resolved");
  });

  it("is default-off: mechanically corroborated result is accepted without requiring conformance review", async () => {
    const { root, artifactsDir, handoff, state } = await fixture();
    const item = handoff.workload.work_items[0]!;
    await writeResult(root, item);
    await setupImplementingRun(artifactsDir, state);

    await decideNextStep({
      root,
      artifactsDir,
      skipFinalGate: true,
    });
    await decideNextStep({ root, artifactsDir, skipFinalGate: true });
    // With default-off, the corroborated result was accepted, advancing past implementing
    const store = new StateStore(artifactsDir);
    const saved = await store.loadState();
    expect(saved?.items?.["finding-a"]?.status).toBe("resolved");
  });

  it("emits a repair step when conformance review finds insufficient evidence", async () => {
    const { root, artifactsDir, handoff, state } = await fixture();
    const item = handoff.workload.work_items[0]!;
    await writeResult(root, item);
    await setupImplementingRun(artifactsDir, state);

    // Run decideNextStep once to mint the review request and emit initial step
    await decideNextStep({
      root,
      artifactsDir,
      conformanceReview: true,
      skipFinalGate: true,
    });
    await decideNextStep({ root, artifactsDir, skipFinalGate: true });

    const requestPath = join(root, ".audit-tools", "remediation", "runs", FIXTURE_RUN_ID, "implement", "conformance-review", `${item.id}.request.json`);
    const request = JSON.parse(await readFile(requestPath, "utf8")) as { review_id: string };
    const verdictPath = join(root, ".audit-tools", "remediation", "runs", FIXTURE_RUN_ID, "implement", "conformance-review", `${item.id}.verdict.json`);

    // Write insufficient evidence verdict
    await writeFile(verdictPath, JSON.stringify({
      contract_version: CONFORMANCE_REVIEW_CONTRACT_VERSION,
      review_id: request.review_id,
      status: "insufficient_evidence",
      rationale: "evidence does not demonstrate invariants",
    }), "utf8");

    const repairStep = await decideNextStep({
      root,
      artifactsDir,
      conformanceReview: true,
      skipFinalGate: true,
    });

    expect(repairStep.step_kind).toBe("dispatch_implement");
    const promptText = await readFile(repairStep.prompt_path, "utf8");
    expect(promptText).toContain("Results to repair and write again");
    expect(promptText).toContain("insufficient");
    // Not resolved
    const store = new StateStore(artifactsDir);
    const saved = await store.loadState();
    expect(saved?.items?.["finding-a"]?.status).toBe("pending");
  });

  it("advances and accepts the work item when conformance review passes", async () => {
    const { root, artifactsDir, handoff, state } = await fixture();
    const item = handoff.workload.work_items[0]!;
    await writeResult(root, item);
    await setupImplementingRun(artifactsDir, state);

    // First emit the dispatch, then ingest the already-written result.
    await decideNextStep({
      root,
      artifactsDir,
      conformanceReview: true,
      skipFinalGate: true,
    });
    await decideNextStep({ root, artifactsDir, skipFinalGate: true });

    const requestPath = join(root, ".audit-tools", "remediation", "runs", FIXTURE_RUN_ID, "implement", "conformance-review", `${item.id}.request.json`);
    const request = JSON.parse(await readFile(requestPath, "utf8")) as { review_id: string };
    const verdictPath = join(root, ".audit-tools", "remediation", "runs", FIXTURE_RUN_ID, "implement", "conformance-review", `${item.id}.verdict.json`);

    // Write passing verdict
    await writeFile(verdictPath, JSON.stringify({
      contract_version: CONFORMANCE_REVIEW_CONTRACT_VERSION,
      review_id: request.review_id,
      status: "conforms",
    }), "utf8");

    await decideNextStep({
      root,
      artifactsDir,
      conformanceReview: true,
      skipFinalGate: true,
    });

    const store = new StateStore(artifactsDir);
    const saved = await store.loadState();
    expect(saved?.items?.["finding-a"]?.status).toBe("resolved");
  });

  it("holds work item and emits step when reviewer is unavailable", async () => {
    const { root, artifactsDir, handoff, state } = await fixture();
    const item = handoff.workload.work_items[0]!;
    await writeResult(root, item);
    await setupImplementingRun(artifactsDir, state);

    // First emit the dispatch, then ingest the already-written result.
    await decideNextStep({
      root,
      artifactsDir,
      conformanceReview: true,
      skipFinalGate: true,
    });
    await decideNextStep({ root, artifactsDir, skipFinalGate: true });

    const requestPath = join(root, ".audit-tools", "remediation", "runs", FIXTURE_RUN_ID, "implement", "conformance-review", `${item.id}.request.json`);
    const request = JSON.parse(await readFile(requestPath, "utf8")) as { review_id: string };
    const verdictPath = join(root, ".audit-tools", "remediation", "runs", FIXTURE_RUN_ID, "implement", "conformance-review", `${item.id}.verdict.json`);

    await writeFile(verdictPath, JSON.stringify({
      contract_version: CONFORMANCE_REVIEW_CONTRACT_VERSION,
      review_id: request.review_id,
      status: "unavailable",
      rationale: "no reviewer available",
    }), "utf8");

    const step = await decideNextStep({
      root,
      artifactsDir,
      conformanceReview: true,
      skipFinalGate: true,
    });

    expect(step.step_kind).toBe("dispatch_implement");
    const promptText = await readFile(step.prompt_path, "utf8");
    expect(promptText).toContain("no reviewer available");
    const store = new StateStore(artifactsDir);
    const saved = await store.loadState();
    expect(saved?.items?.["finding-a"]?.status).toBe("pending");
  });

  it("holds work item and emits step when verdict is stale due to changed result evidence", async () => {
    const { root, artifactsDir, handoff, state } = await fixture();
    const item = handoff.workload.work_items[0]!;
    await writeResult(root, item);
    await setupImplementingRun(artifactsDir, state);

    // First emit the dispatch, then ingest the already-written result.
    await decideNextStep({
      root,
      artifactsDir,
      conformanceReview: true,
      skipFinalGate: true,
    });
    await decideNextStep({ root, artifactsDir, skipFinalGate: true });

    const requestPath = join(root, ".audit-tools", "remediation", "runs", FIXTURE_RUN_ID, "implement", "conformance-review", `${item.id}.request.json`);
    const requestA = JSON.parse(await readFile(requestPath, "utf8")) as { review_id: string };
    const verdictPath = join(root, ".audit-tools", "remediation", "runs", FIXTURE_RUN_ID, "implement", "conformance-review", `${item.id}.verdict.json`);

    // Write a verdict matching request A
    await writeFile(verdictPath, JSON.stringify({
      contract_version: CONFORMANCE_REVIEW_CONTRACT_VERSION,
      review_id: requestA.review_id,
      status: "conforms",
    }), "utf8");

    // Change result evidence so request B has a different review_id
    await writeResult(root, item, {
      obligation_evidence: [{ obligation_id: "OBL-1", evidence: ["src/a.ts:999"] }],
    });

    const step = await decideNextStep({
      root,
      artifactsDir,
      conformanceReview: true,
      skipFinalGate: true,
    });

    expect(step.step_kind).toBe("dispatch_implement");
    const promptText = await readFile(step.prompt_path, "utf8");
    expect(promptText).toContain("changed");
    const store = new StateStore(artifactsDir);
    const saved = await store.loadState();
    expect(saved?.items?.["finding-a"]?.status).toBe("pending");
  });

  it("corrects and accepts end-to-end after an insufficient evidence verdict", async () => {
    const { root, artifactsDir, handoff, state } = await fixture();
    const item = handoff.workload.work_items[0]!;
    await writeResult(root, item);
    await setupImplementingRun(artifactsDir, state);

    // First emit the dispatch, then ingest the already-written result.
    await decideNextStep({
      root,
      artifactsDir,
      conformanceReview: true,
      skipFinalGate: true,
    });
    await decideNextStep({ root, artifactsDir, skipFinalGate: true });

    const requestPath = join(root, ".audit-tools", "remediation", "runs", FIXTURE_RUN_ID, "implement", "conformance-review", `${item.id}.request.json`);
    const request = JSON.parse(await readFile(requestPath, "utf8")) as { review_id: string };
    const verdictPath = join(root, ".audit-tools", "remediation", "runs", FIXTURE_RUN_ID, "implement", "conformance-review", `${item.id}.verdict.json`);

    // Insufficient evidence verdict
    await writeFile(verdictPath, JSON.stringify({
      contract_version: CONFORMANCE_REVIEW_CONTRACT_VERSION,
      review_id: request.review_id,
      status: "insufficient_evidence",
      rationale: "evidence lacks invariant proof",
    }), "utf8");

    const repairStep = await decideNextStep({
      root,
      artifactsDir,
      conformanceReview: true,
      skipFinalGate: true,
    });
    expect(repairStep.step_kind).toBe("dispatch_implement");

    // Corrected to passing verdict
    await writeFile(verdictPath, JSON.stringify({
      contract_version: CONFORMANCE_REVIEW_CONTRACT_VERSION,
      review_id: request.review_id,
      status: "conforms",
    }), "utf8");

    await decideNextStep({
      root,
      artifactsDir,
      conformanceReview: true,
      skipFinalGate: true,
    });

    const store = new StateStore(artifactsDir);
    const saved = await store.loadState();
    expect(saved?.items?.["finding-a"]?.status).toBe("resolved");
  });

  it("cannot bypass mechanical obligation coverage in decideNextStep even with conforming verdict", async () => {
    const { root, artifactsDir, handoff, state } = await fixture();
    const item = handoff.workload.work_items[0]!;
    // Result missing obligation evidence entirely
    await writeResult(root, item, { obligation_evidence: [] });
    await setupImplementingRun(artifactsDir, state);

    const verdictPath = join(root, ".audit-tools", "remediation", "runs", FIXTURE_RUN_ID, "implement", "conformance-review", `${item.id}.verdict.json`);
    await mkdir(dirname(verdictPath), { recursive: true });
    await writeFile(verdictPath, JSON.stringify({
      contract_version: CONFORMANCE_REVIEW_CONTRACT_VERSION,
      review_id: "fake-id",
      status: "conforms",
    }), "utf8");

    const step = await decideNextStep({
      root,
      artifactsDir,
      conformanceReview: true,
      skipFinalGate: true,
    });

    expect(step.step_kind).toBe("dispatch_implement");
    const ingested = await decideNextStep({ root, artifactsDir, skipFinalGate: true });
    const promptText = await readFile(ingested.prompt_path, "utf8");
    expect(promptText).toContain("submission_contract_invalid");
    const store = new StateStore(artifactsDir);
    const saved = await store.loadState();
    expect(saved?.items?.["finding-a"]?.status).toBe("pending");
  });
});
