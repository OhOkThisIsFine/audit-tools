import { designReviewInputRevision } from "../../src/audit/orchestrator/designReviewProjection.js";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { renderContractReviewPrompt } from "../../src/audit/orchestrator/designReviewPrompt.js";
import * as fileLock from "../../src/shared/io/fileLock.js";
import { artifactTreeLockPath } from "../../src/shared/io/auditToolsPaths.js";
import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeFanoutLanes } from "../../src/audit/cli/fanoutLanes.js";
import { AUDIT_GATE_SUBMISSION_SCOPE, GATE_LANES } from "../../src/audit/cli/laneSubmissions.js";
import { tryConsumeSubmission } from "../../src/audit/cli/nextStepHelpers.js";
import { readSubmissionLedger } from "../../src/shared/submission/submissionLedger.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("required review lanes refuse raw/self/stale output and accept only their bound independent declaration", async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "review-submission-")); roots.push(artifactsDir);
  const lane = GATE_LANES.design_review_contract;
  const fanout = await materializeFanoutLanes({ artifactsDir, runId: AUDIT_GATE_SUBMISSION_SCOPE, lanes: [{ id: lane, label: "Contract reviewer", promptFilename: "review.md", promptText: "Review the approved contract.", fileCount: 1, riskScore: 0.8, semanticComplexity: "deep" }] });
  const path = fanout.lanes[0]!.resultPath;
  await writeFile(path, JSON.stringify({ findings: [] }));
  expect((await tryConsumeSubmission(artifactsDir, lane)).status).toBe("malformed");
  const binding = (await readSubmissionLedger(artifactsDir)).find(event => event.kind === "prompt_bound") as unknown as { prompt_sha256: string };
  expect(binding.prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
  const envelope = { contract_version: "review-submission/v1", prompt_sha256: binding.prompt_sha256, review: { mode: "independent", reason: "This reviewer did not author the contract." }, result: { findings: [] } };
  for (const bad of [{ ...envelope, prompt_sha256: "0".repeat(64) }, { ...envelope, review: { mode: "degraded", reason: "Same author" } }, { ...envelope, review: { mode: "unavailable", reason: "No independent context" } }]) {
    await writeFile(path, JSON.stringify(bad));
    if (bad.review.mode === "independent") expect((await tryConsumeSubmission(artifactsDir, lane)).status).toBe("malformed");
    else await expect(tryConsumeSubmission(artifactsDir, lane)).rejects.toThrow(/unavailable|independent/);
  }
  await writeFile(path, JSON.stringify(envelope));
  const accepted = await tryConsumeSubmission(artifactsDir, lane);
  expect(accepted.status).toBe("ok");
  if (accepted.status === "ok") expect(accepted.value).toEqual({ findings: [] });
  await tryConsumeSubmission(artifactsDir, lane);
  expect((await readSubmissionLedger(artifactsDir)).filter(event => String(event.kind) === "review_declared" && event.review_mode === "independent")).toHaveLength(1);
});

test("A to B to A re-emission restores the current binding without duplicating lane counts", async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "review-rebind-")); roots.push(artifactsDir);
  const lane = GATE_LANES.design_review_contract;
  const emit = (promptText: string) => materializeFanoutLanes({ artifactsDir, runId: AUDIT_GATE_SUBMISSION_SCOPE, lanes: [{ id: lane, label: "Review", promptFilename: "review.md", promptText, fileCount: 1, riskScore: 0.8 }] });
  await emit("A");
  const first = (await readSubmissionLedger(artifactsDir)).filter(event => event.kind === "prompt_bound").at(-1)!;
  await emit("B");
  const final = await emit("A");
  const rebound = (await readSubmissionLedger(artifactsDir)).filter(event => event.kind === "prompt_bound");
  expect(rebound.at(-1)!.prompt_sha256).toBe(first.prompt_sha256);
  expect(rebound).toHaveLength(3);
  await emit("A");
  expect((await readSubmissionLedger(artifactsDir)).filter(event => event.kind === "prompt_bound")).toHaveLength(3);
  expect((await readSubmissionLedger(artifactsDir)).filter(event => event.kind === "dispatched")).toHaveLength(1);
  await writeFile(final.lanes[0]!.resultPath, JSON.stringify({ contract_version: "review-submission/v1", prompt_sha256: first.prompt_sha256, review: { mode: "independent", reason: "Separate author context" }, result: { findings: [] } }));
  expect((await tryConsumeSubmission(artifactsDir, lane)).status).toBe("ok");
});

test("unavailable review pauses without consuming or quarantining the bound response", async () => {
  const { readFile } = await import("node:fs/promises");
  const { createFoldTransaction, commitFold } = await import("../../src/audit/cli/foldTransaction.js");
  const artifactsDir = await mkdtemp(join(tmpdir(), "review-paused-")); roots.push(artifactsDir);
  const lane = GATE_LANES.design_review_contract;
  const fanout = await materializeFanoutLanes({ artifactsDir, runId: AUDIT_GATE_SUBMISSION_SCOPE, lanes: [{ id: lane, label: "Review", promptFilename: "review.md", promptText: "Review", fileCount: 1, riskScore: 0.8 }] });
  const binding = (await readSubmissionLedger(artifactsDir)).filter(event => event.kind === "prompt_bound").at(-1)!;
  const bytes = JSON.stringify({ contract_version: "review-submission/v1", prompt_sha256: binding.prompt_sha256, review: { mode: "unavailable", reason: "No independent context is currently available" }, result: null });
  const path = fanout.lanes[0]!.resultPath;
  await writeFile(path, bytes);
  const tx = createFoldTransaction();
  await expect(tryConsumeSubmission(artifactsDir, lane, tx)).rejects.toThrow("unavailable");
  expect(tx.staged.every(entry => !entry.applied)).toBe(true);
  await commitFold(artifactsDir, {}, tx);
  expect(await readFile(path, "utf8")).toBe(bytes);
  expect((await readSubmissionLedger(artifactsDir)).some(event => event.kind === "accepted")).toBe(false);
});

test("corrupt active bindings cannot resurrect a historical ledger authority", async () => {
  const { laneAssetsDir } = await import("../../src/shared/index.js");
  const artifactsDir = await mkdtemp(join(tmpdir(), "review-corrupt-binding-")); roots.push(artifactsDir);
  const lane = GATE_LANES.design_review_contract;
  const fanout = await materializeFanoutLanes({ artifactsDir, runId: AUDIT_GATE_SUBMISSION_SCOPE, lanes: [{ id: lane, label: "Review", promptFilename: "review.md", promptText: "Review", fileCount: 1, riskScore: 0.8 }] });
  const binding = (await readSubmissionLedger(artifactsDir)).filter(event => event.kind === "prompt_bound").at(-1)!;
  await writeFile(join(laneAssetsDir(artifactsDir), "review-bindings.json"), '{"version":"corrupt"}');
  await writeFile(fanout.lanes[0]!.resultPath, JSON.stringify({ contract_version: "review-submission/v1", prompt_sha256: binding.prompt_sha256, review: { mode: "independent", reason: "Separate author context" }, result: { findings: [] } }));
  expect((await tryConsumeSubmission(artifactsDir, lane)).status).toBe("malformed");
});

test("pointer-only input changes invalidate old reviews and re-emission mints a fresh immutable prompt", async () => {
  const { readFile } = await import("node:fs/promises");
  const { auditReviewBinding } = await import("../../src/audit/cli/reviewSubmission.js");
  const artifactsDir = await mkdtemp(join(tmpdir(), "review-context-binding-")); roots.push(artifactsDir);
  const packet = join(artifactsDir, "packet.json");
  await writeFile(packet, '{"version":1}');
  const lane = GATE_LANES.design_review_contract;
  const emit = () => materializeFanoutLanes({ artifactsDir, runId: AUDIT_GATE_SUBMISSION_SCOPE, lanes: [{ id: lane, label: "Review", promptFilename: "review.md", promptText: `Read ${packet}`, contextPaths: [packet], fileCount: 1, riskScore: 0.8 }] });
  const first = await emit();
  const oldPrompt = await readFile(first.lanes[0]!.promptPath, "utf8");
  const oldBinding = await auditReviewBinding(artifactsDir, lane);
  await writeFile(packet, '{"version":2}');
  expect((await auditReviewBinding(artifactsDir, lane)).promptSha256).toBeUndefined();
  const second = await emit();
  expect((await auditReviewBinding(artifactsDir, lane)).promptSha256).not.toBe(oldBinding.promptSha256);
  expect(second.lanes[0]!.promptPath).not.toBe(first.lanes[0]!.promptPath);
  expect(await readFile(first.lanes[0]!.promptPath, "utf8")).toBe(oldPrompt);
  await writeFile(second.lanes[0]!.resultPath, JSON.stringify({ contract_version: "review-submission/v1", prompt_sha256: oldBinding.promptSha256, review: { mode: "independent", reason: "Separate author" }, result: {} }));
  expect((await tryConsumeSubmission(artifactsDir, lane)).status).toBe("malformed");
});

test("concurrent emission publishes only complete matching prompt bindings and malformed maps recover by emission", async () => {
  const { readFile } = await import("node:fs/promises");
  const { readAuditReviewBinding } = await import("../../src/audit/cli/auditReviewBindings.js");
  const { laneAssetsDir } = await import("../../src/shared/io/auditToolsPaths.js");
  const { hashContent } = await import("../../src/shared/hash.js");
  const artifactsDir = await mkdtemp(join(tmpdir(), "review-concurrent-binding-")); roots.push(artifactsDir);
  const lane = GATE_LANES.design_review_contract;
  const emit = (promptText: string) => materializeFanoutLanes({ artifactsDir, runId: AUDIT_GATE_SUBMISSION_SCOPE, lanes: [{ id: lane, label: "Review", promptFilename: "review.md", promptText, fileCount: 1, riskScore: 0.8 }] });
  await Promise.all([emit("A"), emit("B")]);
  let binding = await readAuditReviewBinding(artifactsDir, lane);
  expect(binding).toBeDefined();
  expect(hashContent(await readFile(binding!.promptPath))).toBe(binding!.promptContentSha256);
  await writeFile(join(laneAssetsDir(artifactsDir), "review-bindings.json"), "{bad json");
  expect(await readAuditReviewBinding(artifactsDir, lane)).toBeUndefined();
  await emit("C");
  binding = await readAuditReviewBinding(artifactsDir, lane);
  expect(await readFile(binding!.promptPath, "utf8")).toContain("C");
});

test("re-emission repairs a tampered required prompt even when its result already exists", async () => {
  const { readAuditReviewBinding } = await import("../../src/audit/cli/auditReviewBindings.js");
  const artifactsDir = await mkdtemp(join(tmpdir(), "review-repair-prompt-")); roots.push(artifactsDir);
  const lane = GATE_LANES.design_review_contract;
  const emit = () => materializeFanoutLanes({ artifactsDir, runId: AUDIT_GATE_SUBMISSION_SCOPE, lanes: [{ id: lane, label: "Review", promptFilename: "review.md", promptText: "Review", fileCount: 1, riskScore: 0.8 }] });
  const first = await emit();
  await writeFile(first.lanes[0]!.resultPath, "{}");
  await writeFile(first.lanes[0]!.promptPath, "tampered");
  expect(await readAuditReviewBinding(artifactsDir, lane)).toBeUndefined();
  await emit();
  expect(await readAuditReviewBinding(artifactsDir, lane)).toBeDefined();
});

test("review rebinding waits for the artifact hold that owns acceptance and commit", async () => {
  const { withArtifactTreeHold } = await import("../../src/shared/io/artifactTreeHold.js");
  const { auditReviewBinding } = await import("../../src/audit/cli/reviewSubmission.js");
  const artifactsDir = await mkdtemp(join(tmpdir(), "review-acceptance-hold-")); roots.push(artifactsDir);
  const lane = GATE_LANES.design_review_contract;
  const emit = (promptText: string) => materializeFanoutLanes({ artifactsDir, runId: AUDIT_GATE_SUBMISSION_SCOPE, lanes: [{ id: lane, label: "Review", promptFilename: "review.md", promptText, fileCount: 1, riskScore: 0.8 }] });
  const initial = await emit("A");
  const prior = await auditReviewBinding(artifactsDir, lane);
  await writeFile(initial.lanes[0]!.resultPath, JSON.stringify({ contract_version: "review-submission/v1", prompt_sha256: prior.promptSha256, review: { mode: "independent", reason: "Separate reviewer" }, result: { findings: [] } }));
  let emitting!: ReturnType<typeof emit>;
  let completed = false;
  let observed!: { completed: boolean; digest?: string };
  await withArtifactTreeHold(artifactsDir, undefined, async () => {
    expect((await tryConsumeSubmission(artifactsDir, lane)).status).toBe("ok");
    let requested!: () => void;
    const lockRequested = new Promise<void>(resolve => { requested = resolve; });
    const actualWithFileLock = fileLock.withFileLock;
    const observer = vi.spyOn(fileLock, "withFileLock").mockImplementation((...args) => {
      if (args[0] === artifactTreeLockPath(artifactsDir)) requested();
      return actualWithFileLock(...args);
    });
    try {
      emitting = emit("B").then(value => { completed = true; return value; });
      const reached = await Promise.race([lockRequested.then(() => "lock"), emitting.then(() => "completed")]);
      expect(reached).toBe("lock");
      observed = { completed, digest: (await auditReviewBinding(artifactsDir, lane)).promptSha256 };
    } finally {
      observer.mockRestore();
    }
  });
  await emitting;
  expect(observed.completed).toBe(false);
  expect(observed.digest).toBe(prior.promptSha256);
  expect((await auditReviewBinding(artifactsDir, lane)).promptSha256).not.toBe(prior.promptSha256);
});

test("conceptual judge reads perspective findings from the actual review envelope", async () => {
  const { renderConceptualJudgePrompt } = await import("../../src/audit/orchestrator/designReviewPrompt.js");
  const prompt = renderConceptualJudgePrompt({}, [{ name: "Pragmatist", path: "/tmp/perspective.json", contributor_id: "perspective-a" }], "round-a");
  expect(prompt).toContain("review-submission/v1");
  expect(prompt).toContain("`result.findings`");
  expect(prompt).toContain("unavailable");
});

function cappedReviewInput(): ArtifactBundle {
  return {
    repo_manifest: { repository: { name: "capped-review" }, generated_at: "2026-01-01T00:00:00Z", files: [] },
    surface_manifest: { surfaces: Array.from({ length: 21 }, (_, index) => ({
      id: `surface-${index}`, kind: "interface" as const, entrypoint: `/entry-${index}`,
    })) },
  };
}

test("a hidden structural input changes the real review binding while cosmetic provenance does not", async () => {
  const { auditReviewBinding } = await import("../../src/audit/cli/reviewSubmission.js");
  const artifactsDir = await mkdtemp(join(tmpdir(), "review-complete-input-")); roots.push(artifactsDir);
  const lane = GATE_LANES.design_review_contract;
  const emit = (bundle: ArtifactBundle) => materializeFanoutLanes({
    artifactsDir, runId: AUDIT_GATE_SUBMISSION_SCOPE,
    lanes: [{ id: lane, label: "Contract review", promptFilename: "contract.md",
      promptText: renderContractReviewPrompt(bundle), semanticInputRevision: designReviewInputRevision(bundle), fileCount: 0, riskScore: 0.8 }],
  });
  const original = cappedReviewInput();
  expect(renderContractReviewPrompt(original)).not.toContain("/entry-20");
  const first = await emit(original);
  const prior = (await auditReviewBinding(artifactsDir, lane)).promptSha256;
  expect(prior).toMatch(/^[0-9a-f]{64}$/u);
  const cosmetic = structuredClone(original);
  cosmetic.repo_manifest!.generated_at = "2026-02-01T00:00:00Z";
  await emit(cosmetic);
  expect((await auditReviewBinding(artifactsDir, lane)).promptSha256).toBe(prior);

  const changed = structuredClone(cosmetic);
  changed.surface_manifest!.surfaces[20]!.entrypoint = "/changed-hidden-entry";
  expect(renderContractReviewPrompt(changed)).not.toContain("/changed-hidden-entry");
  await emit(changed);
  const current = (await auditReviewBinding(artifactsDir, lane)).promptSha256;
  expect(current).not.toBe(prior);
  const submission = { contract_version: "review-submission/v1", prompt_sha256: prior,
    review: { mode: "independent", reason: "Separate review context" }, result: { findings: [] } };
  await writeFile(first.lanes[0]!.resultPath, JSON.stringify(submission));
  expect((await tryConsumeSubmission(artifactsDir, lane)).status).toBe("malformed");
  await writeFile(first.lanes[0]!.resultPath, JSON.stringify({ ...submission, prompt_sha256: current }));
  expect((await tryConsumeSubmission(artifactsDir, lane)).status).toBe("ok");
});

test("deep conceptual rounds rotate for hidden structural changes but preserve cosmetic re-emissions", async () => {
  const { prepareConceptualDispatch } = await import("../../src/audit/cli/conceptualDispatch.js");
  const { readConceptualReviewRoundManifest } = await import("../../src/audit/types/conceptualAdjudication.js");
  const artifactsDir = await mkdtemp(join(tmpdir(), "review-complete-round-")); roots.push(artifactsDir);
  const emit = async (bundle: ArtifactBundle) => {
    await prepareConceptualDispatch({ artifactsDir, bundle,
      settings: { conceptual_depth: "deep", perspectives: 1 } });
    return (await readConceptualReviewRoundManifest(artifactsDir))!.round_id;
  };
  const original = cappedReviewInput();
  const prior = await emit(original);
  const cosmetic = structuredClone(original);
  cosmetic.repo_manifest!.generated_at = "2026-02-01T00:00:00Z";
  expect(await emit(cosmetic)).toBe(prior);
  cosmetic.surface_manifest!.surfaces[20]!.entrypoint = "/changed-hidden-entry";
  expect(await emit(cosmetic)).not.toBe(prior);
});

for (const kind of ["contract", "shallow", "deep"] as const) {
  for (const changedBeforeConsumption of [false, true]) {
    test(`${kind} review ${changedBeforeConsumption ? "refuses changed carried inputs before any re-emission" : "accepts unchanged carried inputs"}`, async () => {
      const { prepareConceptualDispatch } = await import("../../src/audit/cli/conceptualDispatch.js");
      const { readConceptualReviewRoundManifest } = await import("../../src/audit/types/conceptualAdjudication.js");
      const { writeBoundReviewFixture } = await import("./helpers/reviewSubmissionFixture.js");
      const { handleDesignReviewBranch } = await import("../../src/audit/cli/nextStepHelpers.js");
      const { createFoldTransaction } = await import("../../src/audit/cli/foldTransaction.js");
      const { withArtifactTreeHold } = await import("../../src/shared/io/artifactTreeHold.js");
      const { isDesignReviewStale } = await import("../../src/audit/orchestrator/designReviewSnapshot.js");
      const artifactsDir = await mkdtemp(join(tmpdir(), "review-carried-input-")); roots.push(artifactsDir);
      const original: ArtifactBundle = { ...cappedReviewInput(), design_assessment: {
        generated_at: "2026-01-01T00:00:00Z", findings: [], contract_reviewed: false, conceptual_reviewed: false,
      } };
      if (kind !== "contract") original.intent_checkpoint = reviewCheckpoint(kind);
      const lane = kind === "contract" ? GATE_LANES.design_review_contract : GATE_LANES.design_review_conceptual;
      if (kind === "contract") {
        await materializeFanoutLanes({ artifactsDir, runId: AUDIT_GATE_SUBMISSION_SCOPE,
          lanes: [{ id: lane, label: "Contract review", promptFilename: "contract.md",
            promptText: renderContractReviewPrompt(original), semanticInputRevision: designReviewInputRevision(original), fileCount: 0, riskScore: 0.8 }],
        });
        await writeBoundReviewFixture(artifactsDir, lane, { findings: [] });
      } else {
        await prepareConceptualDispatch({ artifactsDir, bundle: original,
          settings: { conceptual_depth: kind, perspectives: 1 } });
        if (kind === "deep") {
          const manifest = (await readConceptualReviewRoundManifest(artifactsDir))!;
          for (const perspective of manifest.perspectives) {
            await writeBoundReviewFixture(artifactsDir, perspective.lane_id, { findings: [] });
          }
          await writeBoundReviewFixture(artifactsDir, lane, {
            round_id: manifest.round_id, findings: [], candidate_dispositions: [], final_finding_shares: [],
          });
        } else await writeBoundReviewFixture(artifactsDir, lane, { findings: [] });
      }
      const carried = structuredClone(original);
      if (changedBeforeConsumption) carried.surface_manifest!.surfaces[20]!.entrypoint = "/changed-while-review-in-flight";
      // No re-emission: this is the actual fold ordering, with an A response
      // arriving while the current immutable carry has already advanced to B.
      const tx = createFoldTransaction();
      const branch = await withArtifactTreeHold(artifactsDir, undefined, () =>
        handleDesignReviewBranch({ artifactsDir }, carried, { status: "active", obligations: [] }, tx));
      const result = branch.action === "continue" ? branch.bundle : branch.result.bundle;
      const flag = kind === "contract" ? "contract_reviewed" : "conceptual_reviewed";
      if (changedBeforeConsumption) {
        expect(result.design_assessment?.[flag]).not.toBe(true);
        expect(tx.pendingSnapshots).toHaveLength(0);
        expect(tx.staged.every(entry => !entry.applied)).toBe(true);
      } else {
        expect(result.design_assessment?.[flag]).toBe(true);
        expect(tx.pendingSnapshots).toHaveLength(1);
        expect(isDesignReviewStale(tx.pendingSnapshots[0]!, carried)).toBe(false);
      }
    });
  }
}

function reviewCheckpoint(depth: "shallow" | "deep"): NonNullable<ArtifactBundle["intent_checkpoint"]> {
  return {
    schema_version: "intent-checkpoint/v1", confirmed_at: "2026-01-01T00:00:00Z",
    confirmed_by: "host", scope_summary: "whole repository", intent_summary: "review the repository",
    design_review: { answered_at: "2026-01-01T00:00:00Z", conceptual_depth: depth, perspectives: 1 },
  };
}

for (const change of ["depth", "perspectives", "lenses", "charter purpose", "charter confidence", "analyzer degradation", "confirmation timestamp"] as const) {
  test(`conceptual review checks current ${change} before accepting an earlier response`, async () => {
    const { prepareConceptualDispatch, resolveConceptualReviewSettings } = await import("../../src/audit/cli/conceptualDispatch.js");
    const { readConceptualReviewRoundManifest } = await import("../../src/audit/types/conceptualAdjudication.js");
    const { writeBoundReviewFixture } = await import("./helpers/reviewSubmissionFixture.js");
    const { handleDesignReviewBranch } = await import("../../src/audit/cli/nextStepHelpers.js");
    const { createFoldTransaction } = await import("../../src/audit/cli/foldTransaction.js");
    const { withArtifactTreeHold } = await import("../../src/shared/io/artifactTreeHold.js");
    const { EMPTY_REGISTER_BODY } = await import("../helpers/charterRegisterFixture.js");
    const { CHARTER_REGISTER_SCHEMA_VERSION } = await import("../../src/audit/types/charterRegister.js");
    const artifactsDir = await mkdtemp(join(tmpdir(), "review-current-task-")); roots.push(artifactsDir);
    const original: ArtifactBundle = { ...cappedReviewInput(),
      design_assessment: { generated_at: "2026-01-01T00:00:00Z", findings: [], contract_reviewed: true, conceptual_reviewed: false },
      intent_checkpoint: reviewCheckpoint(change === "perspectives" ? "deep" : "shallow"),
      charter_register: {
        schema_version: CHARTER_REGISTER_SCHEMA_VERSION, generated_at: "2026-01-01T00:00:00Z",
        target: "charter", ceiling: { rung: "deep" }, ...EMPTY_REGISTER_BODY,
        lanes: [{ kind: "stated", nodes: [{ node_id: "purpose-1", purpose: "Protect shared budgets",
          premise_height: 0, files: ["src/budget.ts"], provenance: [], confidence: "high" }], edges: [] }],
        correspondences: [{ correspondence_id: "budget", members: [{ kind: "stated", node_ids: ["purpose-1"] }], basis: "tool", evidence: [] }],
      },
    };
    await prepareConceptualDispatch({ artifactsDir, bundle: original, settings: resolveConceptualReviewSettings(original) });
    const manifest = await readConceptualReviewRoundManifest(artifactsDir);
    if (manifest) {
      for (const perspective of manifest.perspectives) await writeBoundReviewFixture(artifactsDir, perspective.lane_id, { findings: [] });
      await writeBoundReviewFixture(artifactsDir, GATE_LANES.design_review_conceptual, {
        round_id: manifest.round_id, findings: [], candidate_dispositions: [], final_finding_shares: [],
      });
    } else await writeBoundReviewFixture(artifactsDir, GATE_LANES.design_review_conceptual, { findings: [] });
    const current = structuredClone(original);
    switch (change) {
      case "depth": current.intent_checkpoint!.design_review!.conceptual_depth = "deep"; break;
      case "perspectives": current.intent_checkpoint!.design_review!.perspectives = 3; break;
      case "lenses": current.intent_checkpoint!.lens_selection = { include: ["security"] }; break;
      case "charter purpose": current.charter_register!.lanes[0]!.nodes[0]!.purpose = "Favor single-user throughput"; break;
      case "charter confidence": current.charter_register!.lanes[0]!.nodes[0]!.confidence = "low"; break;
      case "analyzer degradation":
        current.analyzer_capability = { coverage: "degraded", analyzers: [{
          id: "html", resolution: "absent", setting: "ephemeral", edges_added: 0, routes_added: 0,
          note: "Parser could not run",
        }] };
        break;
      case "confirmation timestamp":
        current.intent_checkpoint!.confirmed_at = "2026-02-01T00:00:00Z";
        current.intent_checkpoint!.design_review!.answered_at = "2026-02-01T00:00:00Z";
        break;
    }
    const { buildDesignReviewSnapshot, isDesignReviewStale } = await import("../../src/audit/orchestrator/designReviewSnapshot.js");
    const conceptualSnapshot = buildDesignReviewSnapshot("conceptual", [], original, "2026-01-02T00:00:00Z");
    const contractSnapshot = buildDesignReviewSnapshot("contract", [], original, "2026-01-02T00:00:00Z");
    expect(isDesignReviewStale(conceptualSnapshot, current)).toBe(change !== "confirmation timestamp");
    // A conceptual-only obligation must not force an unrelated contract review.
    expect(isDesignReviewStale(contractSnapshot, current)).toBe(change === "lenses" || change === "analyzer degradation");
    const tx = createFoldTransaction();
    const branch = await withArtifactTreeHold(artifactsDir, undefined, () =>
      handleDesignReviewBranch({ artifactsDir }, current, { status: "active", obligations: [] }, tx));
    const result = branch.action === "continue" ? branch.bundle : branch.result.bundle;
    if (change === "confirmation timestamp") {
      expect(result.design_assessment?.conceptual_reviewed).toBe(true);
      expect(tx.pendingSnapshots).toHaveLength(1);
    } else {
      expect(result.design_assessment?.conceptual_reviewed).not.toBe(true);
      expect(tx.pendingSnapshots).toHaveLength(0);
      expect(tx.staged.every(entry => !entry.applied)).toBe(true);
    }
  });
}
