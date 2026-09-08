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
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";

const { prepareConceptualDispatch } = await import(
  "../../src/audit/cli/conceptualDispatch.js"
);
const { cmdNextStep } = await import("../../src/audit/cli/nextStepCommand.js");
const { writeCoreArtifacts } = await import("../../src/audit/io/artifacts.js");
const { persistAnalyzerConsent } = await import(
  "../../src/shared/analyzerPolicy.js"
);
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
      bundle,
      settings: { ...SETTINGS },
    });
    // A perspective delivers its findings in the first round.
    const delivered = perspectivePaths(first.writePaths)[0]!;
    await mkdir(dirname(delivered), { recursive: true });
    await writeFile(delivered, "[]", "utf8");

    // Same round, re-emitted: identical bound paths, so an already-delivered
    // perspective is NOT re-asked.
    const reEmit = await prepareConceptualDispatch({
      artifactsDir: dir,
      bundle,
      settings: { ...SETTINGS },
    });
    expect(
      perspectivePaths(reEmit.writePaths),
      "re-emitting an unchanged round must re-declare the identical bound paths",
    ).toEqual(perspectivePaths(first.writePaths));

    // A genuine re-review (diff section present) is a NEW round.
    const second = await prepareConceptualDispatch({
      artifactsDir: dir,
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

  async function prepareRetryFixture() {
    const dir = await artifactsDir();
    const root = dirname(dirname(dir));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "app.ts"), "export const app = true;\n");
    await writeCoreArtifacts(dir, {
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
      unit_manifest: { units: [] },
      surface_manifest: { surfaces: [] },
      graph_bundle: { graphs: {} },
      critical_flows: { flows: [], fallback_required: false },
      risk_register: { items: [] },
      analyzer_capability: { coverage: "not_applicable", analyzers: [] },
      design_assessment: {
        generated_at: "2026-01-01T00:00:00.000Z",
        findings: [],
        contract_findings: [],
        conceptual_findings: [],
        contract_reviewed: true,
        conceptual_reviewed: false,
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
        design_review: { conceptual_depth: "deep", perspectives: 3 },
      },
    } as ArtifactBundle);
    await persistAnalyzerConsent(root, {
      semgrep: "declined",
      eslint: "declined",
      knip: "declined",
      jscpd: "declined",
      "osv-scanner": "declined",
    });

    await cmdNextStep(["--root", root, "--artifacts-dir", dir]);
    const firstStep = JSON.parse(
      await readFile(join(dir, "steps", "current-step.json"), "utf8"),
    );
    if (firstStep.step_kind === "charter_extraction") {
      for (const path of firstStep.access.write_paths as string[]) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, "{\"nodes\":[]}\n", "utf8");
      }
      await cmdNextStep(["--root", root, "--artifacts-dir", dir]);
      Object.assign(
        firstStep,
        JSON.parse(
          await readFile(join(dir, "steps", "current-step.json"), "utf8"),
        ),
      );
    }
    expect(firstStep.step_kind).toBe("design_review_conceptual");
    const firstManifest = JSON.parse(await readFile(firstStep.artifact_paths.conceptual_round_manifest, "utf8"));
    const firstPerspectivePaths = firstManifest.perspectives.map((p: { result_path: string }) => p.result_path) as string[];
    return { dir, root, firstStep, firstPerspectivePaths };
  }

  it("keeps perspective paths stable after next-step rejects a malformed judge", async () => {
    const { dir, root, firstStep, firstPerspectivePaths } = await prepareRetryFixture();
    for (const path of firstPerspectivePaths) await writeFile(path, "[]\n", "utf8");
    await writeFile(firstStep.artifact_paths.conceptual_results, "{}\n", "utf8");
    await cmdNextStep(["--root", root, "--artifacts-dir", dir]);
    const retryStep = JSON.parse(await readFile(join(dir, "steps", "current-step.json"), "utf8"));
    expect(retryStep.access.write_paths).toEqual(firstStep.access.write_paths);
    expect(await readFile(retryStep.artifact_paths.conceptual_judge_prompt, "utf8")).toMatch(/prior submission rejected|expected shape/i);
    expect(await readFile(retryStep.artifact_paths.current_prompt, "utf8")).toContain("All 3 perspective lanes have already delivered");
    for (const path of firstPerspectivePaths) expect(await readFile(path, "utf8")).toBe("[]\n");
  });

  it("reopens every malformed perspective while preserving valid current-round work", async () => {
    const { dir, root, firstStep, firstPerspectivePaths } = await prepareRetryFixture();
    await mkdir(dirname(firstPerspectivePaths[0]!), { recursive: true });
    await writeFile(firstPerspectivePaths[0]!, "[]\n", "utf8");
    await mkdir(dirname(firstPerspectivePaths[1]!), { recursive: true });
    await writeFile(firstPerspectivePaths[1]!, "{}\n", "utf8");
    await mkdir(dirname(firstPerspectivePaths[2]!), { recursive: true });
    await writeFile(firstPerspectivePaths[2]!, "{\n", "utf8");
    await mkdir(dirname(firstStep.artifact_paths.conceptual_results), {
      recursive: true,
    });
    const manifest = JSON.parse(
      await readFile(firstStep.artifact_paths.conceptual_round_manifest, "utf8"),
    );
    await writeFile(
      firstStep.artifact_paths.conceptual_results,
      JSON.stringify({
        round_id: manifest.round_id,
        findings: [],
        candidate_dispositions: [],
        final_finding_shares: [],
      }) + "\n",
      "utf8",
    );

    await cmdNextStep(["--root", root, "--artifacts-dir", dir]);
    const retryStep = JSON.parse(
      await readFile(join(dir, "steps", "current-step.json"), "utf8"),
    );
    expect(retryStep.step_kind).toBe("design_review_conceptual");
    expect(retryStep.access.write_paths).toEqual(firstStep.access.write_paths);
    expect(await readFile(firstPerspectivePaths[0]!, "utf8")).toBe("[]\n");
    for (const path of firstPerspectivePaths.slice(1)) {
      await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
    const retryPrompt = await readFile(retryStep.artifact_paths.current_prompt, "utf8");
    expect(retryPrompt).not.toContain("- Perspective 1 (");
    expect(retryPrompt).toContain("- Perspective 2 (");
    expect(retryPrompt).toContain("- Perspective 3 (");
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
    for (const path of firstPerspectivePaths.slice(1)) await writeFile(path, "[]\n", "utf8");
    await writeFile(firstStep.artifact_paths.conceptual_results, JSON.stringify({
      round_id: manifest.round_id, findings: [], candidate_dispositions: [], final_finding_shares: [],
    }));
    await cmdNextStep(["--root", root, "--artifacts-dir", dir]);
    const repairedLedger = await readSubmissionLedger(dir);
    for (const contributor of manifest.perspectives.slice(1)) {
      expect(repairedLedger.filter((event) => event.lane === contributor.lane_id && ["rejected", "accepted"].includes(event.kind)).map((event) => event.kind)).toEqual(["rejected", "accepted"]);
    }
  });

  it("never quarantines a manifest path outside its tool-computed lane binding", async () => {
    const { dir, root, firstStep, firstPerspectivePaths } = await prepareRetryFixture();
    for (const path of firstPerspectivePaths) await writeFile(path, "[]\n", "utf8");
    const unrelated = join(root, "unrelated.json");
    await writeFile(unrelated, "{}\n", "utf8");
    const manifest = JSON.parse(await readFile(firstStep.artifact_paths.conceptual_round_manifest, "utf8"));
    manifest.perspectives[1].result_path = unrelated;
    await writeFile(firstStep.artifact_paths.conceptual_round_manifest, JSON.stringify(manifest));
    await writeFile(firstStep.artifact_paths.conceptual_results, JSON.stringify({
      round_id: manifest.round_id, findings: [], candidate_dispositions: [], final_finding_shares: [],
    }));
    await expect(cmdNextStep(["--root", root, "--artifacts-dir", dir])).rejects.toThrow(/bound.*path|path.*bound/i);
    expect(await readFile(unrelated, "utf8")).toBe("{}\n");
  });
});
