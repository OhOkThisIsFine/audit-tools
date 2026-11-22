import { expect, test } from "vitest";
import { hashContent } from "audit-tools/shared";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { interpretFreeFormIntentForAudit } from "../../src/audit/orchestrator/intentInterpreter.js";
import { buildQuestionPlanArtifacts } from "../../src/audit/orchestrator/questionPlanExecutor.js";
import { reviewSourceScope } from "../../src/audit/orchestrator/questionPlanning.js";
import { fullAuditScope } from "../../src/audit/orchestrator/scope.js";

const admitted = "src/auth.ts";
const exact = "src/exact.ts";
const nested = "src/omit/a.ts";
const paths = [admitted, exact, nested];

function fixture(): ArtifactBundle {
  return {
    repo_manifest: {
      repository: { name: "intent-fixture" }, generated_at: "2026-01-01T00:00:00Z",
      files: paths.map(path => ({ path, language: "typescript", size_bytes: 1, hash: hashContent(path) })),
    },
    file_disposition: { files: paths.map(path => ({ path, status: "included" })) },
    critical_flows: { flows: paths.map(path => ({
      id: path, name: path, entrypoints: [path], paths: [path], concerns: ["security"],
    })) },
    surface_manifest: { surfaces: paths.map(path => ({ id: path, kind: "interface", entrypoint: path })) },
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1", confirmed_at: "2026-01-01T00:00:00Z", confirmed_by: "host",
      scope_summary: "source", intent_summary: "check operation",
    },
  };
}

function plan(bundle: ArtifactBundle, scope = fullAuditScope()) {
  return buildQuestionPlanArtifacts(bundle, scope).updated.review_plan!;
}

test("the question planner requires a frozen repository manifest", () => {
  expect(() => plan({})).toThrow(/frozen repository manifest/);
});

test("a source without a content fingerprint is omitted, not handed to a reviewer", () => {
  const bundle = fixture();
  delete bundle.repo_manifest!.files.find(file => file.path === exact)!.hash;
  const result = plan(bundle);
  expect(reviewSourceScope(bundle).allowedSourcePaths).not.toContain(exact);
  expect(result.omissions.some(row => row.reason.includes("fingerprint"))).toBe(true);
  expect(result.questions.length).toBeGreaterThan(0);
  expect(result.questions.flatMap(row => row.source_dependencies.map(dep => dep.key))).not.toContain(exact);
});

test("structured disposition overrides remove exact paths and directory prefixes from question scope", () => {
  const bundle = fixture();
  const original = plan(bundle);
  expect(reviewSourceScope(bundle).allowedSourcePaths).toEqual([...paths].sort());
  bundle.intent_checkpoint!.disposition_overrides = [
    { path: exact, status: "excluded", reason: "Exact path withheld." },
    { path: "src/omit", status: "excluded", reason: "Directory withheld." },
  ];
  const narrowed = plan(bundle);
  expect(reviewSourceScope(bundle).allowedSourcePaths).toEqual([admitted]);
  expect(narrowed.omissions.map(row => row.reason)).toEqual(expect.arrayContaining(["Exact path withheld.", "Directory withheld."]));
  const dependencies = narrowed.questions.flatMap(row => row.source_dependencies.map(dep => dep.key));
  expect(dependencies).toContain(admitted);
  expect(dependencies).not.toContain(exact);
  expect(dependencies).not.toContain(nested);
  expect(narrowed.questions.length).toBeLessThan(original.questions.length);
});

test("absent and empty disposition overrides leave the question plan unchanged", () => {
  const bundle = fixture();
  const result = plan(bundle);
  bundle.intent_checkpoint!.disposition_overrides = [];
  expect(plan(bundle)).toEqual(result);
});

test.each([
  ["focus on security and auth", "security"],
  ["focus on data integrity", "data_integrity"],
  ["focus on performance", "performance"],
])("the active interpreter encodes %s without blocking", (input, lens) => {
  const result = interpretFreeFormIntentForAudit(input);
  expect(result.has_unencodable).toBe(false);
  expect(result.encoded_clauses).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "lens_weight", lens })]));
});

test.each(["", "   "])("blank intent %j does not add interpretation or checkpoint questions", input => {
  expect(interpretFreeFormIntentForAudit(input)).toMatchObject({
    encoded_clauses: [], checkpoint_questions: [], has_unencodable: false,
  });
});

test("free-form security prose does not expand the confirmed question lens list", () => {
  const bundle = fixture();
  const broad = plan(bundle);
  expect(broad.questions.some(question => question.lens === "security")).toBe(true);
  bundle.intent_checkpoint!.lens_selection = { include: ["behavior"] };
  const scoped = plan(bundle);
  bundle.intent_checkpoint!.free_form_intent = "security audit";
  const prompted = plan(bundle);
  expect(prompted.questions).toEqual(scoped.questions);
  expect(prompted.questions.length).toBeGreaterThan(0);
  expect([...new Set(prompted.questions.map(question => question.lens))]).toEqual(["behavior"]);
  expect(prompted.lens_decisions).toEqual(expect.arrayContaining([expect.objectContaining({ lens: "security", decision: "excluded" })]));
});

test("question snapshots and revisions react to changed frozen inputs without generating legacy executor artifacts", () => {
  const bundle = fixture();
  const initial = buildQuestionPlanArtifacts(bundle, fullAuditScope());
  expect(initial.artifacts_written).toEqual(["scope.json", "review_plan.json"]);
  expect(initial.updated.audit_tasks).toBeUndefined();
  expect(initial.updated.review_plan!.questions.length).toBeGreaterThan(0);
  bundle.repo_manifest!.files.find(file => file.path === admitted)!.hash = hashContent("changed");
  const changed = plan(bundle);
  const prior = initial.updated.review_plan!.questions.find(row => row.source_dependencies.some(dep => dep.key === admitted))!;
  const next = changed.questions.find(row => row.question_id === prior.question_id)!;
  expect(next.snapshot_id).not.toBe(prior.snapshot_id);
  expect(next.revision_id).not.toBe(prior.revision_id);
});


test("delta scope keeps the seed and dependency neighbor and explains omitted sources", () => {
  const bundle = fixture();
  const scope = { ...fullAuditScope(), mode: "delta" as const, since: "fixture-base",
    seed_files: [admitted], expanded_files: [nested] };
  const result = plan(bundle, scope);
  expect(reviewSourceScope(bundle, scope).allowedSourcePaths).toEqual([admitted, nested]);
  expect(result.omissions.some(item => item.reason.includes("Outside the confirmed changed scope"))).toBe(true);
  expect(result.questions.flatMap(row => row.source_dependencies.map(dep => dep.key)))
    .toEqual(expect.arrayContaining([admitted, nested]));
});
