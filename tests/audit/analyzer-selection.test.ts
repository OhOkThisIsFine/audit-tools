import { expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzerSelectionRequest, currentAnalyzerSelection } from "../../src/audit/orchestrator/analyzerSelection.js";
import { GATE_LANES, laneSubmissionPath } from "../../src/audit/cli/laneSubmissions.js";
import { runDeterministicForNextStep } from "../../src/audit/cli/nextStepHelpers.js";
import { withTempRepo } from "./helpers/next-step-harness.js";

test("selection is tied to the frozen scope and names each applicable tool once", async () => {
  await withTempRepo(async root => {
    await writeFile(join(root, "package.json"), '{"name":"fixture"}');
    const bundle = { repo_manifest: { repository: { name: "fixture" }, generated_at: "fixture",
      files: [{ path: "package.json", language: "json", size_bytes: 18 }] } };
    const request = analyzerSelectionRequest(bundle, root);
    const decisions = request.candidates.map(({ id }) => ({ tool: id, action: "run", reason: "Checks the fixture" }));
    const answer = { input_sha256: request.input_sha256, decisions,
      additional_checks: [{ tool: "repo-lint", scope: "src", reason: "Declared in CI" }], gaps: [] };
    expect(currentAnalyzerSelection(answer, request)).toEqual(answer);
    expect(currentAnalyzerSelection({ ...answer, decisions: [...decisions, { tool: "unknown", action: "run", reason: "not offered" }] }, request)).toBeUndefined();
    const changed = analyzerSelectionRequest({ repo_manifest: { ...bundle.repo_manifest,
      files: [{ ...bundle.repo_manifest.files[0]!, size_bytes: 19 }] } }, root);
    expect(currentAnalyzerSelection(answer, changed)).toBeUndefined();
  });
});

test("ordinary fold pauses before any external invocation and respects selection omissions", async () => {
  await withTempRepo(async root => {
    await writeFile(join(root, "package.json"), '{"name":"fixture"}');
    const artifactsDir = join(root, ".audit-tools", "audit");
    let executions = 0;
    const options = { root, artifactsDir, selfCliPath: "audit-code", timeoutMs: 10000,
      externalAcquisition: { enabled: true, hostSelection: true,
        run: async () => { executions++; throw new Error("An omitted analyzer must not run"); },
        fetch: async () => { executions++; throw new Error("An omitted analyzer must not download"); },
      } };
    const result = await runDeterministicForNextStep(options);
    expect(result.kind).toBe("analyzer_selection");
    expect(executions).toBe(0);
    if (result.kind !== "analyzer_selection") throw new Error("Missing selection");
    expect(result.request.candidates.length).toBeGreaterThan(0);
    const path = laneSubmissionPath(artifactsDir, GATE_LANES.analyzer_selection);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify({ input_sha256: result.request.input_sha256,
      decisions: result.request.candidates.map(({ id }) => ({ tool: id, action: "omit", reason: "Synthetic fixture" })),
      additional_checks: [], gaps: ["No external analyzer run in this test"],
    }));
    const continued = await runDeterministicForNextStep(options);
    expect(continued.kind).not.toBe("analyzer_selection");
    expect(continued.bundle.external_analyzer_acquisition?.tool_statuses.every(status => status.status === "skipped")).toBe(true);
    expect(executions).toBe(0);
  });
});
