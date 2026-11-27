// Tests the same graph reader used by audit reviewers with an executable planning prompt.
import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { auditArtifactsDir, auditReportPath, hashContent, remediationArtifactsDir, writeTextFile } from "audit-tools/shared";
import { buildRepoManifestFromFs } from "../../src/audit/extractors/fsIntake.js";
import { buildReviewerGraph, queryReviewerGraph } from "../../src/audit/cli/reviewGraphCommand.js";
import { auditNavigationGraphPath, navigationSourceDigest } from "../../src/audit/io/navigationGraph.js";
import { isWorkingDirFullyPromoted, promoteFinalAuditReport, readWorkingAuditNavigationGraph, writeCoreArtifacts } from "../../src/audit/io/artifacts.js";
import { computeArtifactMetadata } from "../../src/audit/orchestrator/artifactMetadata.js";
import { buildNextContractPipelineStep } from "../../src/remediate/steps/contractPipeline.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "remediate-graph-"));
  roots.push(root);
  await writeFile(join(root, "entry.ts"), 'import { useful } from "./dep"; export const result = useful();\n');
  await writeFile(join(root, "dep.ts"), "export const useful = () => 1;\n");
  const artifactsDir = remediationArtifactsDir(root);
  const auditDir = auditArtifactsDir(root);
  const index = join(artifactsDir, "planning-graph.json");
  const plan = async () => {
    const step = await buildNextContractPipelineStep({ root, artifactsDir, runId: "TEST-GRAPH" });
    expect(await readFile(step!.prompt_path, "utf8")).toMatch(/review-graph.+planning-graph\.json.+--graph-sha256/);
    const snapshot = await readFile(index, "utf8");
    const result = await queryReviewerGraph(index, hashContent(snapshot), { path: "entry.ts" });
    if (!("edges" in result)) throw new Error("Expected file-level graph edges.");
    return { snapshot, edges: result.edges };
  };
  return { root, auditDir, plan };
}
const graph = { graphs: { references: [{ from: "entry.ts", to: "dep.ts", kind: "auditor-evidence" }] } };

test.each(["file_disposition.json", "external_analyzer_results.json"])(
  "falls back to native links when %s changes before metadata catches up", async name => {
    const { root, auditDir, plan } = await fixture();
    const repo = await buildRepoManifestFromFs({ root, hash_files: true });
    const bundle = { repo_manifest: repo, graph_bundle: graph, file_disposition: { files: [] }, external_analyzer_results: [] };
    const stamps = computeArtifactMetadata(bundle, undefined,
      ["repo_manifest.json", "file_disposition.json", "external_analyzer_results.json", "graph_bundle.json"]);
    await writeCoreArtifacts(auditDir, { ...bundle, artifact_metadata: stamps });
    expect(await readWorkingAuditNavigationGraph(auditDir)).toBeDefined();
    const changed = name === "file_disposition.json" ? { files: [{ path: "dep.ts", status: "excluded" }] }
      : [{ tool: "fixture", results: [] }];
    await writeFile(join(auditDir, name), JSON.stringify(changed));
    expect(await readWorkingAuditNavigationGraph(auditDir)).toBeUndefined();
    const { edges } = await plan();
    expect(edges).toContainEqual(expect.objectContaining({ relation: "imports", to: "dep.ts" }));
    expect(edges).not.toContainEqual(expect.objectContaining({ kind: "auditor-evidence" }));
  },
);

test("malformed optional graph input does not prevent promotion or verification", async () => {
  const { auditDir } = await fixture();
  await mkdir(auditDir, { recursive: true });
  await writeFile(join(auditDir, "graph_bundle.json"), "{");
  await writeTextFile(auditReportPath(auditDir), "Audit report fixture");
  expect(await promoteFinalAuditReport({ artifactsDir: auditDir }, { warn: () => {} })).toMatchObject({ archived: true });
  expect(await isWorkingDirFullyPromoted(auditDir)).toBe(true);
  await expect(readFile(auditNavigationGraphPath(dirname(auditDir)))).rejects.toMatchObject({ code: "ENOENT" });
});

test("uses the working auditor graph and uses its portable form after audit cleanup", async () => {
  const { root, auditDir, plan } = await fixture();
  const repo = await buildRepoManifestFromFs({ root, hash_files: true });
  const bundle = { repo_manifest: repo, graph_bundle: graph };
  const stamps = computeArtifactMetadata(bundle, undefined, ["repo_manifest.json", "graph_bundle.json"]);
  await writeCoreArtifacts(auditDir, { ...bundle, artifact_metadata: stamps });
  const portable = await readWorkingAuditNavigationGraph(auditDir);
  expect(portable).toBeDefined();
  expect((await plan()).edges).toEqual([{ relation: "references", from: "entry.ts", to: "dep.ts", kind: "auditor-evidence" }]);
  await writeTextFile(auditReportPath(auditDir), "Audit report fixture");
  expect(await promoteFinalAuditReport({ artifactsDir: auditDir }, { warn: () => {} })).toMatchObject({ archived: true });
  expect(await isWorkingDirFullyPromoted(auditDir)).toBe(true);
  expect(await readFile(auditNavigationGraphPath(dirname(auditDir)), "utf8")).toBe(portable);
  await rm(auditDir, { recursive: true, force: true });
  expect((await plan()).snapshot).toBe(portable);
});

test("builds native links for a missing or stale auditor graph, and refreshes when source changes", async () => {
  const { root, auditDir, plan } = await fixture();
  const first = await plan();
  expect(first.edges).toContainEqual(expect.objectContaining({ relation: "imports", to: "dep.ts" }));
  const manifest = await buildRepoManifestFromFs({ root, hash_files: true });
  const stale = buildReviewerGraph(graph, manifest.files.map(f => f.path), undefined, navigationSourceDigest(manifest.files));
  await writeTextFile(auditNavigationGraphPath(dirname(auditDir)), stale);
  await writeFile(join(root, "alt.ts"), "export const useful = () => 2;\n");
  await writeFile(join(root, "entry.ts"), 'import { useful } from "./alt"; export const result = useful();\n');
  const refreshed = await plan();
  expect(refreshed.edges).toContainEqual(expect.objectContaining({ relation: "imports", to: "alt.ts" }));
  expect(refreshed.edges).not.toContainEqual(expect.objectContaining({ to: "dep.ts" }));
  expect(refreshed.snapshot).not.toBe(stale);
});
