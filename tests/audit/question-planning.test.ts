import { describe, expect, it } from "vitest";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { buildReviewQuestionPlan, reviewSourceScope } from "../../src/audit/orchestrator/questionPlanning.js";
import { buildGraphBundle } from "../../src/audit/extractors/graph.js";
import { buildSurfaceManifest } from "../../src/audit/extractors/surfaces.js";
import { buildCriticalFlowManifest } from "../../src/audit/extractors/flows.js";
import { ReviewPlanSchema } from "../../src/shared/types/reviewQuestion.js";

function fixture(): ArtifactBundle {
  const paths = ["src/manual.ts", "src/scheduled.ts", "src/resume-store.ts", "test/resume.test.ts",
    "src/runtime-config.ts", ".github/workflows/release.yml", "docs/resume.md"];
  return {
    repo_manifest: { repository: { name: "resume-fixture" }, generated_at: "x",
      files: paths.map((path) => ({ path, language: "text", size_bytes: 100, hash: path })) },
    file_disposition: { files: paths.map((path) => ({ path, status: path.startsWith("docs/") ? "doc_only" : "included" })) },
    surface_manifest: { surfaces: [
      { id: "manual", kind: "interface", entrypoint: "src/manual.ts", exposure: "network" },
      { id: "scheduled", kind: "background", entrypoint: "src/scheduled.ts", exposure: "local" },
      { id: "dynamic", kind: "interface", entrypoint: "generated/registry.ts" },
    ] },
    critical_flows: { flows: [
      { id: "manual", name: "Manual resume", entrypoints: ["src/manual.ts"], paths: ["src/manual.ts", "src/resume-store.ts", "test/resume.test.ts"], concerns: [] },
      { id: "scheduled", name: "Scheduled resume", entrypoints: ["src/scheduled.ts"], paths: ["src/scheduled.ts", "src/resume-store.ts"], concerns: [] },
      { id: "state", name: "Shared history", entrypoints: ["src/resume-store.ts"], paths: ["src/resume-store.ts"], concerns: [] },
    ] },
    unit_manifest: { units: paths.slice(0, 3).map((path) => ({ unit_id: path, name: path, files: [path], required_lenses: [] })) },
    intent_checkpoint: { schema_version: "intent-checkpoint/v1", confirmed_at: "x", confirmed_by: "host", scope_summary: "fixture", intent_summary: "review" },
  };
}

describe("question-led audit planning", () => {
  it("assigns all applicable playbooks and retains an unmapped registered surface", () => {
    const plan = buildReviewQuestionPlan(fixture(), { snapshotId: "snapshot-a" });
    expect(ReviewPlanSchema.safeParse(plan).success).toBe(true);
    expect(plan.questions.map((question) => question.lens)).toEqual(expect.arrayContaining([
      "behavior", "security", "architecture", "performance", "operability", "config_deployment", "tests",
    ]));
    expect(plan.omissions).toContainEqual(expect.objectContaining({ surface_id: "dynamic" }));
    expect(plan.questions.find((question) => question.lens === "behavior" &&
      question.requested_parts.length === 2)).toMatchObject({
      requested_parts: [
        { part_id: expect.stringContaining("manual"), expectation: expect.any(String) },
        { part_id: expect.stringContaining("scheduled"), expectation: expect.any(String) },
      ],
    });
  });

  it("reopens a membership-bound invariant, not an unrelated answer, and records targeted omissions", () => {
    const base = fixture();
    const before = buildReviewQuestionPlan(base, { snapshotId: "snapshot-a" });
    const stateQuestion = before.questions.find((question) => question.lens === "behavior" && question.requested_parts.length > 1)!;
    const unrelated = before.questions.find((question) => question.lens === "tests")!;
    const added = "src/operator-retry.ts";
    base.repo_manifest!.files.push({ path: added, language: "text", size_bytes: 100, hash: added });
    base.file_disposition!.files.push({ path: added, status: "included" });
    base.surface_manifest!.surfaces.push({ id: "operator-retry", kind: "interface", entrypoint: added });
    base.critical_flows!.flows.push({ id: "retry", name: "Operator retry", entrypoints: [added], paths: [added, "src/resume-store.ts"], concerns: [] });
    const after = buildReviewQuestionPlan(base, { snapshotId: "snapshot-b" });
    const revised = after.questions.find((question) => question.question_id === stateQuestion.question_id)!;
    expect(revised.revision_id).not.toBe(stateQuestion.revision_id);
    expect(revised.requested_parts).toHaveLength(3);
    expect(after.questions.find((question) => question.question_id === unrelated.question_id)?.revision_id).toBe(unrelated.revision_id);
    base.intent_checkpoint!.lens_selection = { include: ["behavior"], omission_reasons: { security: "retry behavior only" } };
    const targeted = buildReviewQuestionPlan(base, { snapshotId: "snapshot-b" });
    expect(targeted.questions.every(({ lens }) => lens === "behavior")).toBe(true);
    expect(targeted.lens_decisions).toContainEqual({ lens: "security", decision: "excluded", reason: "retry behavior only" });
    expect(targeted.omissions).toContainEqual(expect.objectContaining({ surface_id: "dynamic" }));
  });

  it("uses native route wiring and package registrations, not path heuristics alone", () => {
    const contents = {
      "package.json": JSON.stringify({ name: "fixture", exports: { "./resume": "./src/engine.ts" } }),
      "src/routes/dispatch.ts": "import { resume } from '../engine';\nrouter.post('/resume', resume);",
      "src/engine.ts": "export const resume = () => 'ok';",
    };
    const bundle = fixture();
    bundle.repo_manifest!.files = Object.entries(contents).map(([path, text]) => ({ path, language: "typescript", size_bytes: text.length, hash: path }));
    bundle.file_disposition!.files = bundle.repo_manifest!.files.map(({ path }) => ({ path, status: "included" }));
    bundle.graph_bundle = buildGraphBundle(bundle.repo_manifest!, bundle.file_disposition, { fileContents: contents });
    bundle.surface_manifest = buildSurfaceManifest(bundle.repo_manifest!, bundle.file_disposition, { graphBundle: bundle.graph_bundle });
    bundle.critical_flows = buildCriticalFlowManifest(bundle.repo_manifest!, bundle.surface_manifest, bundle.file_disposition, { graphBundle: bundle.graph_bundle });
    expect(bundle.graph_bundle.graphs.routes).toContainEqual({ path: "/resume", method: "POST", handler: "src/engine.ts" });
    const plan = buildReviewQuestionPlan(bundle, { snapshotId: "snapshot-native" });
    const behavior = plan.questions.filter(({ lens }) => lens === "behavior");
    expect(behavior).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_dependencies: expect.arrayContaining([
        expect.objectContaining({ kind: "source", key: "package.json" }),
        expect.objectContaining({ kind: "source", key: "src/engine.ts" }),
        expect.objectContaining({ kind: "membership" }),
      ]) }),
      expect.objectContaining({ source_dependencies: expect.arrayContaining([
        expect.objectContaining({ kind: "source", key: "src/routes/dispatch.ts" }),
        expect.objectContaining({ kind: "source", key: "src/engine.ts" }),
        expect.objectContaining({ kind: "membership" }),
      ]) }),
    ]));
  });

  it("keeps context, source, scope exclusions and declared custom questions distinct", () => {
    const bundle = fixture();
    bundle.intent_checkpoint!.excluded_scope = [{ path: "src/scheduled.ts", reason: "schedule is not part of this review" }];
    bundle.intent_checkpoint!.lens_selection = { include: ["custom:budget-policy"] };
    const scope = reviewSourceScope(bundle);
    expect(scope.allowedSourcePaths).not.toContain("docs/resume.md");
    expect(scope.allowedContractPaths).toContain("docs/resume.md");
    expect(scope.allowedSourcePaths).not.toContain("src/scheduled.ts");
    const plan = buildReviewQuestionPlan(bundle, { snapshotId: "snapshot-a", declaredQuestions: [{
      key: "manual-budget", lens: "custom:budget-policy", kind: "invariant", title: "Resume budget",
      expectation: "No additional authorization is needed to inspect a canceled run.",
      source_refs: [{ path: "src/manual.ts" }], contract_refs: [{ path: "docs/resume.md" }],
    }] });
    expect(ReviewPlanSchema.parse(plan).questions).toMatchObject([{ lens: "custom:budget-policy", source_dependencies: [
      { kind: "source", key: "docs/resume.md" }, { kind: "source", key: "src/manual.ts" },
    ] }]);
    expect(plan.omissions).toContainEqual(expect.objectContaining({ surface_id: "scheduled", reason: "schedule is not part of this review" }));
  });
});
