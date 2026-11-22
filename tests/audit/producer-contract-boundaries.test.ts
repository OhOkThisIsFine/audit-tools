import { test, expect } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCoreArtifacts, loadArtifactBundle, type ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { buildQuestionPlanArtifacts } from "../../src/audit/orchestrator/questionPlanExecutor.js";
import { runQuestionSynthesisExecutor } from "../../src/audit/orchestrator/synthesisExecutors.js";

function producedPlan() {
  const bundle: ArtifactBundle = {
    repo_manifest: { repository: { name: "fixture" }, generated_at: "2026-01-01", files: [
      { path: "src/a.ts", size_bytes: 10, language: "typescript", hash: "a".repeat(64) },
    ] },
    file_disposition: { files: [{ path: "src/a.ts", status: "included" }] },
    surface_manifest: { surfaces: [
      { id: "a", kind: "interface", entrypoint: "src/a.ts", exposure: "local" },
    ] },
  };
  const produced = buildQuestionPlanArtifacts(bundle, {
    mode: "full", since: null, seed_files: [], expanded_files: [], budget: { max_files: 1 },
  });
  expect(produced.artifacts_written).toEqual(["scope.json", "review_plan.json"]);
  expect(produced.updated.review_plan!.questions.length).toBeGreaterThan(0);
  return produced.updated;
}

function producedReport(plan: ArtifactBundle) {
  return runQuestionSynthesisExecutor(plan, {
    auditRead: null,
    questionReview: { accepted: [], evidence: [], dependenciesByQuestion: new Map() },
  }).updated.audit_findings!;
}

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "producer-contract-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("real planner and synthesis outputs survive the canonical persistence boundary", async () => {
  const plan = producedPlan();
  const { scope, review_plan } = plan;
  const report = producedReport(plan);
  await withRoot(async (root) => {
    await writeCoreArtifacts(root, { scope, review_plan, audit_findings: report });
    const loaded = await loadArtifactBundle(root);
    expect(loaded.scope).toEqual(scope);
    expect(loaded.review_plan).toEqual(review_plan);
    expect(loaded.audit_findings).toEqual(JSON.parse(JSON.stringify(report)));
  });
});

for (const kind of ["review_plan", "audit_findings"] as const) {
  test(`${kind} malformed producer output is refused before any artifact is persisted`, async () => {
    const produced = producedPlan();
    const plan = structuredClone(produced.review_plan!);
    Reflect.deleteProperty(plan.questions[0], "expected_outcome");
    const report = { ...producedReport(produced) } as Record<string, unknown>;
    delete report.audit_read;
    const bad = kind === "review_plan" ? plan : report;
    await withRoot(async (root) => {
      const bundle = { repo_manifest: { repository: { name: "fixture" }, generated_at: "2026-01-01", files: [] }, [kind]: bad } as ArtifactBundle;
      await expect(writeCoreArtifacts(root, bundle)).rejects.toThrow();
      expect(await readdir(root)).toEqual([]);
    });
  });
}

test("current plan and report persistence neither reads nor repopulates retired result bytes", async () => {
  const produced = producedPlan();
  const bundle = { ...produced, audit_findings: producedReport(produced) };
  await withRoot(async (root) => {
    const path = join(root, "audit_results.jsonl");
    const historical = Buffer.from([0xff, 0x0d, 0x0a]);
    await writeFile(path, historical);
    expect(await loadArtifactBundle(root)).not.toHaveProperty("audit_results");
    await writeCoreArtifacts(root, bundle, { prune: true });
    expect(await readFile(path)).toEqual(historical);
    const loaded = await loadArtifactBundle(root);
    expect(loaded.audit_findings).toEqual(JSON.parse(JSON.stringify(bundle.audit_findings)));
    expect(loaded).not.toHaveProperty("audit_results");
    await rm(path);
    await writeCoreArtifacts(root, loaded, { prune: true });
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});


test("malformed question plan cannot replace the persisted plan or scope", async () => {
  const { scope, review_plan } = producedPlan();
  await withRoot(async (root) => {
    await writeCoreArtifacts(root, { scope, review_plan });
    const originalPlan = await readFile(join(root, "review_plan.json"), "utf8");
    const originalScope = await readFile(join(root, "scope.json"), "utf8");
    const invalid = structuredClone(review_plan!);
    invalid.questions[0].requested_parts = [];
    await expect(writeCoreArtifacts(root, {
      scope: { ...scope!, budget: { max_files: 2 } },
      review_plan: invalid,
    })).rejects.toThrow();
    expect(await readFile(join(root, "review_plan.json"), "utf8")).toBe(originalPlan);
    expect(await readFile(join(root, "scope.json"), "utf8")).toBe(originalScope);
  });
});

test("a malformed question report cannot replace the last persisted report", async () => {
  const report = producedReport(producedPlan());
  await withRoot(async (root) => {
    await writeCoreArtifacts(root, { audit_findings: report });
    const path = join(root, "audit-findings.json");
    const original = await readFile(path, "utf8");
    const malformed = { ...report } as Record<string, unknown>;
    delete malformed.question_review;
    await expect(writeCoreArtifacts(root, { audit_findings: malformed } as ArtifactBundle)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(original);
  });
});
