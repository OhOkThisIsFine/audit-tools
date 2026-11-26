import { readAuditReviewBinding } from "../../src/audit/cli/auditReviewBindings.js";
import { StepArtifactSchema } from "../../src/audit/cli/steps.js";
import { captureCompletedDesignReviews, persistDesignReviewSnapshots } from "./helpers/designReviewSnapshotFixture.js";
import { writeBoundReviewFixture } from "./helpers/reviewSubmissionFixture.js";
import { EMPTY_REGISTER_BODY, REGISTER_V4_AFFIRMATION } from "../helpers/charterRegisterFixture.js";
import { CHARTER_REGISTER_SCHEMA_VERSION } from "../../src/audit/types/charterRegister.js";
import { prepareFixtureRun } from "../helpers/functionalPreflightFixture.js";
/**
 * The deep conceptual pass's perspective lanes are ROUND-scoped, and the tool is
 * owed nothing on them.
 *
 * Routing the perspectives through the shared lane materializer gave them two
 * properties that are right for every other lane and wrong for these:
 *
 *   1. K-of-N RESUME. A lane whose submission already sits at its bound path is
 *      complete — prompt not rewritten, lane not re-instructed. Keyed on the
 *      perspective INDEX alone, a re-review triggered by upstream staleness
 *      found the PREVIOUS round's findings there, skipped the lane, and handed
 *      the judge stale opinions of artifacts that had since changed.
 *   2. EXPECTED-SUBMISSION membership. The tool never reads a perspective's
 *      findings (the judge does), so an expectation recorded against one can
 *      never be satisfied or dropped — it accumulates in the expected set and
 *      the ledger as a permanent, false shortfall.
 *
 * Both are fixed at identity: the lane id carries a digest of what the round
 * asks, and a perspective declares itself un-expected. What must NOT change is
 * resume WITHIN a round (an id that churned per call would re-ask for work the
 * host already delivered) or the judge lane, whose submission the tool does
 * ingest.
 */
import { describe, expect, it, afterEach } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { execFileSyncHidden } from "../helpers/spawn.mjs";
import { fileURLToPath } from "node:url";
import { toPromptPathToken } from "../../src/shared/tooling/exec.js";

import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";

const { prepareConceptualDispatch } = await import(
  "../../src/audit/cli/conceptualDispatch.js"
);
const { cmdNextStep } = await import("../../src/audit/cli/nextStepCommand.js");
const { writeCoreArtifacts } = await import("../../src/audit/io/artifacts.js");
const { expectedSubmissionsPath } = await import(
  "../../src/shared/io/auditToolsPaths.js"
);
const { readOptionalJsonFile } = await import("../../src/shared/io/json.js");
const { readSubmissionLedger } = await import(
  "../../src/shared/submission/submissionLedger.js"
);

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await rm(cleanups.pop()!, { recursive: true, force: true });
  }
});

async function artifactsDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "p25-perspective-round-"));
  cleanups.push(root);
  const dir = join(root, ".audit-tools", "audit");
  await mkdir(dir, { recursive: true });
  return dir;
}

const SETTINGS = { conceptual_depth: "deep", perspectives: 2 } as const;

/** The perspective lanes' bound paths, in emission order (the judge is last). */
function perspectivePaths(writePaths: readonly string[]): readonly string[] {
  return writePaths.slice(0, -1);
}

describe("deep conceptual perspectives are round-scoped and never expected submissions", () => {
  it("a fresh round mints fresh perspective paths while the judge lane keeps its identity", async () => {
    const dir = await artifactsDir();
    const bundle = {} as ArtifactBundle;

    const first = await prepareConceptualDispatch({
      artifactsDir: dir,
      sourceRoot: dir,
      bundle,
      settings: { ...SETTINGS },
    });
    // A perspective delivers its findings in the first round.
    const delivered = perspectivePaths(first.writePaths)[0]!;
    const manifest = JSON.parse(await readFile(first.artifactPaths.conceptual_round_manifest!, "utf8"));
    await writeBoundReviewFixture(dir, manifest.perspectives[0].lane_id, []);

    // Same round, re-emitted: identical bound paths, so an already-delivered
    // perspective is NOT re-asked.
    const reEmit = await prepareConceptualDispatch({
      artifactsDir: dir,
      sourceRoot: dir,
      bundle,
      settings: { ...SETTINGS },
    });
    expect(
      perspectivePaths(reEmit.writePaths),
      "re-emitting an unchanged round must re-declare the identical bound paths",
    ).toEqual(perspectivePaths(first.writePaths));

    expect(reEmit.instructionLines.join("\n")).not.toContain("- **Perspective 1 (");
    expect(JSON.parse(await readFile(delivered, "utf8")).review.mode).toBe("independent");

    // A genuine re-review (diff section present) is a NEW round.
    const second = await prepareConceptualDispatch({
      artifactsDir: dir,
      sourceRoot: dir,
      bundle,
      settings: { ...SETTINGS },
      reReviewSection: "## Diff-based re-review\n\nupstream changed",
    });
    for (const path of perspectivePaths(second.writePaths)) {
      expect(
        perspectivePaths(first.writePaths),
        "a re-review must not reuse the prior round's perspective submission",
      ).not.toContain(path);
    }
    expect(
      second.conceptualResultsPath,
      "the JUDGE lane is the ingested submission and keeps its resume semantics",
    ).toBe(first.conceptualResultsPath);
  });

  it("records an expectation for the judge lane only — never for a perspective", async () => {
    const dir = await artifactsDir();
    await prepareConceptualDispatch({
      artifactsDir: dir,
      sourceRoot: dir,
      bundle: {} as ArtifactBundle,
      settings: { ...SETTINGS },
    });

    const set = await readOptionalJsonFile<{
      entries?: { lane: string }[];
    }>(expectedSubmissionsPath(dir));
    expect(
      (set?.entries ?? []).map((entry) => entry.lane),
      "only the lane the tool itself ingests is owed a submission",
    ).toEqual(["design_review_conceptual"]);

    const ledger = await readSubmissionLedger(dir);
    expect(
      ledger.filter((event) => event.kind === "expected").map((e) => e.lane),
      "a perspective must not appear on the ledger as an unsatisfiable expectation",
    ).toEqual(["design_review_conceptual"]);

    // The retirement and the RECORD are different things. Expecting an artifact
    // is a claim the tool will be owed something and will re-ask until it
    // arrives — that is what P25 removed for perspectives, and the assertion
    // above still pins it. Recording that a lane was dispatched is a statement
    // about the past: it re-asks nothing, accumulates in no set, and can never
    // become a shortfall (shortfall is a diff over the expected SET, which
    // never reads ledger events). Without it, a perspective that exited 0
    // having written nothing left no trace in any artifact.
    expect(
      new Set(
        ledger.filter((e) => e.kind === "dispatched").map((e) => e.lane),
      ).size,
      "every dispatched lane, expected or not, leaves a dispatch row",
    ).toBe(3); // 2 perspectives + the judge
  });

  async function prepareRetryFixture(viaCli = false, perspectives: number | string[] = 3, unitMarker?: string) {
    const dir = await artifactsDir();
    const root = dirname(dirname(dir));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "app.ts"), "export const app = true;\n");
    const completed = captureCompletedDesignReviews({
      repo_manifest: {
        repository: { name: "retry-fixture" },
        generated_at: "2026-01-01T00:00:00.000Z",
        files: [{ path: "src/app.ts", language: "typescript", size_bytes: 25 }],
      },
      file_disposition: { files: [{ path: "src/app.ts", status: "included" }] },
      auto_fixes_applied: {},
      syntax_resolution_status: {},
      external_analyzer_acquisition: { enabled: false, tool_statuses: [] },
      external_analyzer_results: [{ tool: "eslint", results: [] }],
      unit_manifest: { units: unitMarker ? [
        { unit_id: unitMarker, name: "Implementation marker", files: ["src/app.ts"], required_lenses: [] },
      ] : [] },
      surface_manifest: { surfaces: [] },
      graph_bundle: { graphs: {} },
      critical_flows: { flows: [], fallback_required: false },
      risk_register: { items: [] },
      analyzer_capability: { coverage: "not_applicable", analyzers: [] },
      // This fixture starts after charter work. A new charter submission would invalidate the seeded review inputs.
      charter_register: {
        schema_version: CHARTER_REGISTER_SCHEMA_VERSION,
        generated_at: "2026-01-01T00:00:00.000Z",
        target: "charter",
        ceiling: { rung: "deep" },
        ...EMPTY_REGISTER_BODY,
      },
      charter_clarification: {
        generated_at: "2026-01-01T00:00:00.000Z",
        target: "charter_clarification",
        ceiling: { rung: "deep" },
        attention: 0,
        status: "omitted",
        asked: [],
        banked: [],
        findings: [],
        validation_issues: [],
        ...REGISTER_V4_AFFIRMATION,
      },
      design_assessment: {
        generated_at: "2026-01-01T00:00:00.000Z",
        findings: [],
        contract_findings: [],
        contract_reviewed: true,
      },
      docs_digest: { generated_at: "2026-01-01T00:00:00.000Z", docs: [] },
      structure_decomposition: {
        generated_at: "2026-01-01T00:00:00.000Z",
        target: "structure",
        node_universe_size: 1,
        source_ids: ["fixture"],
        consensus: [],
        contested: [],
        findings: [],
      },
      intent_checkpoint: {
        schema_version: "intent-checkpoint/v1",
        confirmed_at: "2026-01-01T00:00:00.000Z",
        confirmed_by: "host",
        scope_summary: "whole repository",
        intent_summary: "review the repository",
        // Bound to THIS confirmation: the depth dials are per-run, so an
        // unbound block is read as unanswered and falls back to shallow.
        design_review: {
          answered_at: "2026-01-01T00:00:00.000Z",
          conceptual_depth: "deep",
          perspectives,
        },
      },
    } as ArtifactBundle);
    await writeCoreArtifacts(dir, completed);
    await persistDesignReviewSnapshots(dir, completed);
    await prepareFixtureRun(root, { artifactsDir: dir, declinedAnalyzerIds: ["semgrep", "eslint", "knip", "jscpd", "osv-scanner"], preflight: true });
    if (viaCli) {
      const cli = fileURLToPath(new URL("../../audit-code.mjs", import.meta.url));
      execFileSyncHidden(process.execPath, [cli, "next-step", "--root", root, "--artifacts-dir", dir], { cwd: root, encoding: "utf8" });
    } else {
      await cmdNextStep(["--root", root, "--artifacts-dir", dir]);
    }
    const firstStep = JSON.parse(
      await readFile(join(dir, "steps", "current-step.json"), "utf8"),
    );

    expect(firstStep.step_kind).toBe("design_review_conceptual");
    const firstManifest = JSON.parse(await readFile(firstStep.artifact_paths.conceptual_round_manifest, "utf8"));
    const firstPerspectivePaths = firstManifest.perspectives.map((p: { result_path: string }) => p.result_path) as string[];
    return { dir, root, firstStep, firstPerspectivePaths, firstManifest };
  }

  it("stages and fingerprints one shared evidence file, not a copy in every prompt", async () => {
    const { dir, firstStep, firstManifest } = await prepareRetryFixture(true);
    const [inventory, evidence] = ["design-review-file-inventory.json", "design-review-shared-evidence.md"].map(name => {
      const paths = firstStep.access.read_paths.filter((path: string) => basename(path) === name);
      expect(paths).toHaveLength(1);
      expect(firstStep.access.write_paths).not.toContain(paths[0]);
      return paths[0] as string;
    });
    expect(JSON.parse(await readFile(inventory!, "utf8"))).toHaveProperty("units");
    const artifact = await readFile(evidence!, "utf8");
    expect(artifact).toContain("### Unit structure");
    expect(artifact).toContain("### Deterministic structural findings");
    const digest = createHash("sha256").update(artifact).digest("hex");
    const prompts = await Promise.all(firstManifest.perspectives.map(async (lane: { prompt_path: string }) => (
      readFile(lane.prompt_path, "utf8")
    ))) as string[];
    const judge = await readFile(firstManifest.judge.prompt_path, "utf8");
    for (const prompt of [...prompts, judge]) {
      expect(prompt).toContain(toPromptPathToken(inventory!));
      expect(prompt).toContain(`${toPromptPathToken(evidence!)}: ${digest}`);
      expect(prompt).toContain("Read **Unit structure**");
      expect(prompt).toContain("### Starting points");
      expect(prompt).not.toContain("### Deterministic structural findings");
    }
    const shared = prompts[0]!.split("## Your perspective:")[0];
    for (const prompt of prompts) {
      expect(prompt.split("## Your perspective:")[0]).toBe(shared);
      expect(prompt).toContain("You will NOT see the other reviewers' output");
    }
    expect(new Set(prompts).size).toBe(prompts.length);
    expect(judge).toContain("## Perspective result files");
    const lane = firstManifest.perspectives[0].lane_id;
    expect((await readAuditReviewBinding(dir, lane))?.inputs).toContainEqual({ path: evidence, sha256: digest });
    await chmod(evidence!, 0o644);
    await writeFile(evidence!, artifact + "changed evidence\n");
    expect(await readAuditReviewBinding(dir, lane)).toBeUndefined();
    expect(await readAuditReviewBinding(dir, firstManifest.judge.lane_id)).toBeUndefined();
  });

  it("issues the outside-in method on an unseeded frozen fixture and preserves design options at the judge", async () => {
    const marker = "implementation-only-unit-7f9";
    const { firstManifest, firstStep } = await prepareRetryFixture(true, ["Novelty-seeker", "Pragmatist"], marker);
    expect(firstManifest.perspectives).toHaveLength(2);
    const [outsideIn, pragmatist] = await Promise.all(
      firstManifest.perspectives.map((lane: { prompt_path: string }) => readFile(lane.prompt_path, "utf8")),
    );
    const purpose = outsideIn!.indexOf("State the problem without inheriting the solution");
    const outside = outsideIn!.indexOf("Look outside before reading implementation details");
    const frozen = outsideIn!.indexOf("Then verify fit in frozen source");
    expect(purpose).toBeGreaterThan(-1);
    expect(purpose).toBeLessThan(outside);
    expect(outside).toBeLessThan(frozen);
    expect(outsideIn).not.toContain("### Starting points");
    expect(outsideIn).not.toContain("## Project context");
    expect(outsideIn).not.toContain(marker);
    expect(pragmatist).toContain(marker);
    expect(outsideIn).toContain("keeping, deleting, simplifying, or replacing");
    expect(outsideIn).toContain("label alternatives as unverified hypotheses");
    expect(outsideIn).toContain("Do not expose private identifiers, source, or project data");
    expect(outsideIn).toContain("[in scope]");
    expect(outsideIn).toContain("design option, not a defect");
    expect(pragmatist).not.toContain("Look outside before reading implementation details");
    const judge = await readFile(firstManifest.judge.prompt_path, "utf8");
    expect(judge).toContain("A well-grounded alternative to working code can survive on its merits");
    expect(judge).toContain("relevant local and external evidence, main trade-off and deciding check");
    const evidencePath = firstStep.access.read_paths.find((path: string) => basename(path) === "design-review-shared-evidence.md");
    expect(evidencePath).toBeDefined();
    expect(await readFile(evidencePath!, "utf8")).toContain(marker);
    expect(outsideIn).toContain(toPromptPathToken(evidencePath!));
    expect(outsideIn).toContain("After the alternatives are written down, read Unit structure");
    expect([outsideIn, judge].join("\n")).not.toMatch(/codebase.memory|github\.com|npmjs\.com/i);
  });

  it("reissues unavailable and invalid perspective results before the judge has submitted", async () => {
    const { dir, root, firstStep, firstPerspectivePaths, firstManifest } = await prepareRetryFixture();
    await writeBoundReviewFixture(dir, firstManifest.perspectives[0].lane_id, []);
    const independent = await readFile(firstPerspectivePaths[0]!, "utf8");
    await writeBoundReviewFixture(dir, firstManifest.perspectives[1].lane_id, {});
    const unavailable = JSON.parse(await readFile(firstPerspectivePaths[1]!, "utf8"));
    unavailable.review = { mode: "unavailable", reason: "No independent context is available." };
    await writeFile(firstPerspectivePaths[1]!, JSON.stringify(unavailable));
    await writeBoundReviewFixture(dir, firstManifest.perspectives[2].lane_id, {});
    await cmdNextStep(["--root", root, "--artifacts-dir", dir]);
    const retry = JSON.parse(await readFile(join(dir, "steps", "current-step.json"), "utf8"));
    expect(retry.step_kind).toBe("design_review_conceptual");
    expect(retry.access.write_paths).toEqual(firstStep.access.write_paths);
    const instructions = await readFile(retry.artifact_paths.current_prompt, "utf8");
    expect(instructions).not.toContain("- **Perspective 1 (");
    expect(instructions).toContain("- **Perspective 2 (");
    expect(instructions).toContain("- **Perspective 3 (");
    expect(await readFile(firstPerspectivePaths[0]!, "utf8")).toBe(independent);
    const binding = ({ lane_id, prompt_path, result_path }: {
      lane_id: string; prompt_path: string; result_path: string;
    }) => ({
      lane_id,
      prompt_path: toPromptPathToken(prompt_path),
      result_path: toPromptPathToken(result_path),
    });
    expect(firstStep.conceptual_workload).toEqual({
      pending_perspectives: firstManifest.perspectives.map(binding),
      judge: { ...binding(firstManifest.judge), ready: false },
    });
    expect(StepArtifactSchema.parse(retry).conceptual_workload).toEqual({
      pending_perspectives: firstManifest.perspectives.slice(1).map(binding),
      judge: { ...binding(firstManifest.judge), ready: false },
    });
    for (const perspective of firstManifest.perspectives.slice(1)) {
      await writeBoundReviewFixture(dir, perspective.lane_id, []);
    }
    await cmdNextStep(["--root", root, "--artifacts-dir", dir]);
    const judgeOnly = JSON.parse(await readFile(join(dir, "steps", "current-step.json"), "utf8"));
    expect(judgeOnly.conceptual_workload).toEqual({
      pending_perspectives: [],
      judge: { ...binding(firstManifest.judge), ready: true },
    });
    expect(await readFile(firstPerspectivePaths[0]!, "utf8")).toBe(independent);

  });

  it("unavailable deep review pauses and retains completed independent perspectives on unchanged resume", async () => {
    const { dir, root, firstStep, firstPerspectivePaths, firstManifest } = await prepareRetryFixture();
    await writeBoundReviewFixture(dir, firstManifest.perspectives[0].lane_id, []);
    const completedBytes = await readFile(firstPerspectivePaths[0]!, "utf8");
    for (const lane of [firstManifest.perspectives[1].lane_id, firstManifest.judge.lane_id]) {
      await writeBoundReviewFixture(dir, lane, {});
      const path = lane === firstManifest.judge.lane_id ? firstStep.artifact_paths.conceptual_results : firstPerspectivePaths[1]!;
      const envelope = JSON.parse(await readFile(path, "utf8"));
      envelope.review = { mode: "unavailable", reason: "No independent context is available." };
      await writeFile(path, JSON.stringify(envelope), "utf8");
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      await cmdNextStep(["--root", root, "--artifacts-dir", dir]);
      const step = JSON.parse(await readFile(join(dir, "steps", "current-step.json"), "utf8"));
      expect(step.step_kind).toBe("blocked");
      expect(await readFile(step.artifact_paths.current_prompt, "utf8")).toMatch(/independent|unavailable/i);
      expect(await readFile(firstPerspectivePaths[0]!, "utf8")).toBe(completedBytes);
      expect(step.access.write_paths).not.toContain(firstPerspectivePaths[0]);
      const assessment = JSON.parse(await readFile(join(dir, "design_assessment.json"), "utf8"));
      expect(assessment.conceptual_reviewed).not.toBe(true);
    }
  });

  it("keeps perspective paths stable after next-step rejects a malformed judge", async () => {
    const { dir, root, firstStep, firstPerspectivePaths, firstManifest } = await prepareRetryFixture();
    for (const path of firstPerspectivePaths) await writeBoundReviewFixture(dir, firstManifest.perspectives.find((entry: { result_path: string }) => entry.result_path === path)!.lane_id, []);
    await writeBoundReviewFixture(dir, firstManifest.judge.lane_id, {});
    const perspectiveBytes = await Promise.all(firstPerspectivePaths.map(path => readFile(path, "utf8")));
    await cmdNextStep(["--root", root, "--artifacts-dir", dir]);
    const retryStep = JSON.parse(await readFile(join(dir, "steps", "current-step.json"), "utf8"));
    expect(retryStep.access.write_paths).toEqual(firstStep.access.write_paths);
    expect(await readFile(retryStep.artifact_paths.conceptual_judge_prompt, "utf8")).toMatch(/prior submission rejected|expected shape/i);
    expect(await readFile(retryStep.artifact_paths.current_prompt, "utf8")).toContain("All 3 perspective lanes have already delivered");
    for (const [index, path] of firstPerspectivePaths.entries()) expect(await readFile(path, "utf8")).toBe(perspectiveBytes[index]);
  });

  it("reopens every malformed perspective while preserving valid current-round work", async () => {
    const { dir, root, firstStep, firstPerspectivePaths, firstManifest } = await prepareRetryFixture();
    await mkdir(dirname(firstPerspectivePaths[0]!), { recursive: true });
    await writeBoundReviewFixture(dir, firstManifest.perspectives[0].lane_id, []);
    const validPerspectiveBytes = await readFile(firstPerspectivePaths[0]!, "utf8");
    await mkdir(dirname(firstPerspectivePaths[1]!), { recursive: true });
    await writeBoundReviewFixture(dir, firstManifest.perspectives[1].lane_id, {});
    await mkdir(dirname(firstPerspectivePaths[2]!), { recursive: true });
    await writeFile(firstPerspectivePaths[2]!, "{\n", "utf8");
    await mkdir(dirname(firstStep.artifact_paths.conceptual_results), {
      recursive: true,
    });
    const manifest = JSON.parse(
      await readFile(firstStep.artifact_paths.conceptual_round_manifest, "utf8"),
    );
    await writeBoundReviewFixture(dir, firstManifest.judge.lane_id, {
        round_id: manifest.round_id,
        findings: [],
        candidate_dispositions: [],
        final_finding_shares: [],
      });

    await cmdNextStep(["--root", root, "--artifacts-dir", dir]);
    const retryStep = JSON.parse(
      await readFile(join(dir, "steps", "current-step.json"), "utf8"),
    );
    expect(retryStep.step_kind).toBe("design_review_conceptual");
    expect(retryStep.access.write_paths).toEqual(firstStep.access.write_paths);
    expect(await readFile(firstPerspectivePaths[0]!, "utf8")).toBe(validPerspectiveBytes);
    for (const path of firstPerspectivePaths.slice(1)) {
      await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
    const retryPrompt = await readFile(retryStep.artifact_paths.current_prompt, "utf8");
    expect(retryPrompt).not.toContain("- **Perspective 1 (");
    expect(retryPrompt).toContain("- **Perspective 2 (");
    expect(retryPrompt).toContain("- **Perspective 3 (");
    for (const ordinal of [2, 3]) {
      const lanePrompt = await readFile(retryStep.artifact_paths[`conceptual_perspective_${ordinal}_prompt`], "utf8");
      expect(lanePrompt).toContain("Previous submission rejected");
      expect(lanePrompt).toContain("quarantine");
    }
    expect(
      await readFile(retryStep.artifact_paths.conceptual_judge_prompt, "utf8"),
    ).toMatch(/prior submission rejected|expected shape|findings/i);
    expect(
      (await readSubmissionLedger(dir)).some(
        (event) =>
          event.kind === "rejected" &&
          event.lane === "design_review_conceptual",
      ),
    ).toBe(true);
    for (const path of firstPerspectivePaths.slice(1)) await writeBoundReviewFixture(dir, firstManifest.perspectives.find((entry: { result_path: string }) => entry.result_path === path)!.lane_id, []);
    await writeBoundReviewFixture(dir, firstManifest.judge.lane_id, {
      round_id: manifest.round_id, findings: [], candidate_dispositions: [], final_finding_shares: [],
    });
    await cmdNextStep(["--root", root, "--artifacts-dir", dir]);
    const repairedLedger = await readSubmissionLedger(dir);
    for (const contributor of manifest.perspectives.slice(1)) {
      expect(repairedLedger.filter((event) => event.lane === contributor.lane_id && ["rejected", "accepted"].includes(event.kind)).map((event) => event.kind)).toEqual(["rejected", "accepted"]);
    }
    const repairedStep = JSON.parse(await readFile(join(dir, "steps", "current-step.json"), "utf8"));
    expect(repairedStep.step_kind, repairedStep.prompt).not.toBe("blocked");
    const assessment = JSON.parse(await readFile(join(dir, "design_assessment.json"), "utf8"));
    const metadata = JSON.parse(await readFile(join(dir, "artifact_metadata.json"), "utf8"));
    const { hashArtifactValue } = await import("../../src/shared/artifactFreshness.js");
    expect(metadata.artifacts["design_assessment.json"].content_hash).toBe(hashArtifactValue("design_assessment.json", assessment));
    expect(assessment.conceptual_reviewed).toBe(true);
    expect(JSON.parse(await readFile(join(dir, "conceptual_review_adjudication.json"), "utf8")).round_id).toBe(manifest.round_id);
  });

  it("never quarantines a manifest path outside its tool-computed lane binding", async () => {
    const { dir, root, firstStep, firstPerspectivePaths, firstManifest } = await prepareRetryFixture();
    for (const path of firstPerspectivePaths) await writeBoundReviewFixture(dir, firstManifest.perspectives.find((entry: { result_path: string }) => entry.result_path === path)!.lane_id, []);
    const unrelated = join(root, "unrelated.json");
    await writeFile(unrelated, "{}\n", "utf8");
    const manifest = JSON.parse(await readFile(firstStep.artifact_paths.conceptual_round_manifest, "utf8"));
    manifest.perspectives[1].result_path = unrelated;
    await writeFile(firstStep.artifact_paths.conceptual_round_manifest, JSON.stringify(manifest));
    await writeBoundReviewFixture(dir, firstManifest.judge.lane_id, {
      round_id: manifest.round_id, findings: [], candidate_dispositions: [], final_finding_shares: [],
    });
    await expect(cmdNextStep(["--root", root, "--artifacts-dir", dir])).rejects.toThrow(/bound.*path|path.*bound/i);
    expect(await readFile(unrelated, "utf8")).toBe("{}\n");
  });
});
