import { describe, expect, it } from "vitest";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { buildReviewQuestionPlan, reviewSourceScope } from "../../src/audit/orchestrator/questionPlanning.js";
import { buildGraphBundle } from "../../src/audit/extractors/graph.js";
import { buildSurfaceManifest } from "../../src/audit/extractors/surfaces.js";
import { buildCriticalFlowManifest } from "../../src/audit/extractors/flows.js";
import { ReviewPlanSchema } from "../../src/shared/types/reviewQuestion.js";
import type { Finding } from "../../src/shared/types/finding.js";
import { questionWorkloadBindings } from "../../src/audit/cli/questionWorkloadBindings.js";
import { CHARTER_REGISTER_SCHEMA_VERSION } from "../../src/audit/types/charterRegister.js";
import { EMPTY_REGISTER_BODY } from "../helpers/charterRegisterFixture.js";

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
  it("carries accepted claims, distinguishes material charter gaps, and accounts for every structural signal", async () => {
    const bundle = fixture();
    const related = { path: "src/manual-detail.ts", language: "text", size_bytes: 100, hash: "manual-detail" };
    const transitive = { path: "src/transitive-detail.ts", language: "text", size_bytes: 100, hash: "transitive-detail" };
    bundle.repo_manifest!.files.push(related, transitive);
    bundle.file_disposition!.files.push(...[related, transitive].map(({ path }) => ({ path, status: "included" as const })));
    bundle.critical_flows!.flows[0]!.paths.push(related.path, transitive.path);
    bundle.graph_bundle = buildGraphBundle(bundle.repo_manifest!);
    bundle.graph_bundle.graphs.calls = [{ from: "src/manual.ts", to: related.path, kind: "resolved-call" }];
    bundle.graph_bundle.graphs.imports = [{ from: "test/resume.test.ts", to: "src/manual.ts" }];
    const claim = (id: string, category: string, affected_files: Finding["affected_files"]): Finding =>
      ({ id, title: category, category, severity: "medium", confidence: "high", lens: "architecture",
        summary: `Check the observed decision ${category}.`, affected_files });
    const site = [{ path: "src/manual.ts", line_start: 3, line_end: 6 }];
    const seam = [{ path: "src/manual.ts" }, { path: "src/resume-store.ts" }];
    bundle.design_assessment = {
      generated_at: "x", contract_reviewed: true, conceptual_reviewed: true,
      contract_findings: [{ ...claim("DR-001", "contract gap", site), severity: "low" }],
      conceptual_findings: [claim("DR-001", "design simplification", site)],
      findings: [
        claim("seam-a", "architectural_seam", seam),
        claim("seam-b", "architectural_seam", [...seam].reverse()),
        claim("other-seam", "architectural_seam", [{ path: "src/scheduled.ts" }, seam[1]!]),
        claim("site-a", "complexity_hotspot", site),
        claim("site-b", "complexity_hotspot", [{ ...site[0]!, line_start: 12, line_end: 20 }]),
        claim("same-routine-dup", "code_duplication", [
          { path: site[0]!.path, line_start: 13, line_end: 14 },
          { path: site[0]!.path, line_start: 17, line_end: 18 },
        ]),
        claim("cross-routine-dup", "code_duplication", [
          { path: site[0]!.path, line_start: 4, line_end: 5 },
          { path: site[0]!.path, line_start: 17, line_end: 18 },
        ]),
        claim("file-count", "complexity_hotspot", [{ path: site[0]!.path }]),
        claim("workflow-fixture-count", "complexity_hotspot", [{ path: related.path }]),
        claim("transitive-only", "complexity_hotspot", [{ path: transitive.path }]),
        claim("test-import-only", "complexity_hotspot", [{ path: "test/resume.test.ts" }]),
        claim("need-locator", "complexity_hotspot", [{ path: "src/runtime-config.ts" }]),
        claim("unbound", "architectural_seam", [{ path: "not-frozen" }, seam[1]!]),
      ],
    };
    bundle.systemic_challenge = { generated_at: "x", target: "systemic_challenge", ceiling: { rung: "deep" },
      rounds: [], converged: true, findings: [claim("DR-001", "systemic cost", site)], validation_issues: [] };
    type Difference = NonNullable<ArtifactBundle["charter_register"]>["differences"][number];
    const difference = (id: string, relation: Difference["relation"], ref: string): Difference =>
      ({ difference_id: id, correspondence_id: `corr-${id}`, relation, dimension: "purpose",
        routed_to: relation === "incompatible" ? "human" : "none", finding_candidate: relation === "incompatible",
        gap: "Older changes are missed.",
        accounts: [
          { kind: "stated", claim: "Older changes are included.", provenance: [{ kind: "doc", ref: "docs/resume.md:1" }] },
          { kind: "revealed", claim: "Only a recent window is considered.", provenance: [{ kind: "code", ref }] },
        ] });
    bundle.charter_register = { schema_version: CHARTER_REGISTER_SCHEMA_VERSION, generated_at: "x", target: "charter",
      ceiling: { rung: "deep" }, ...EMPTY_REGISTER_BODY,
      differences: [
      difference("equivalent", "equivalent", "src/manual.ts:3-6"),
      difference("complement", "complementary", "src/manual.ts:3-6"),
      { ...difference("material", "incompatible", "src/manual.ts:3-6"),
        fidelity: { verdict: "interpretation", rationale: "The stated source may have been over-read.", decided_by: "lane" } },
      difference("missing", "incompatible", "not-frozen"),
    ] };

    const plan = buildReviewQuestionPlan(bundle, { snapshotId: "snapshot-a" });
    expect(ReviewPlanSchema.safeParse(plan).success).toBe(true);
    const bySignal = new Map(plan.signal_dispositions!.map(row => [row.signal_id, row]));
    expect(bySignal.size).toBe(20);
    function target(key: string) {
      return plan.questions.find(q => q.question_id === bySignal.get(key)?.question_id)!;
    }
    for (const key of ["charter:equivalent", "charter:complement", "charter:missing", "design-lead:need-locator", "design-lead:unbound", "design-lead:transitive-only", "design-lead:test-import-only"]) {
      expect(bySignal.get(key)).toMatchObject({ outcome: "not_promoted" });
      expect(bySignal.get(key)).not.toHaveProperty("question_id");
    }
    expect(target("charter:material").expected_outcome).toContain("stated: Older changes are included.");
    expect(target("charter:material").expected_outcome).toContain("Prior fidelity review (interpretation)");
    expect(bySignal.get("design-lead:seam-b")).toMatchObject({ outcome: "grouped" });
    const group = target("design-lead:seam-a");
    expect(target("design-lead:seam-b")).toBe(group);
    expect(target("design-lead:other-seam")).not.toBe(group);
    expect(group.evidence_dependencies.map(d => d.key)).toEqual(["design-lead:seam-a", "design-lead:seam-b"]);
    expect(target("design-lead:site-a")).not.toBe(target("design-lead:site-b"));
    expect(target("design-lead:same-routine-dup")).toBe(target("design-lead:site-b"));
    expect(target("design-lead:cross-routine-dup")).not.toBe(target("design-lead:site-b"));
    expect(target("design-lead:file-count")).not.toBe(target("design-lead:workflow-fixture-count"));
    expect(target("design-lead:site-b").requested_parts.map(part => part.part_id))
      .toEqual(["design-lead:same-routine-dup", "design-lead:site-b"]);
    expect(target("design-lead:site-b").expected_outcome).toContain("src/manual.ts:12-20");
    const behavior = plan.questions.find(q => q.lens === "behavior" &&
      q.source_dependencies.some(dep => dep.key === "src/manual.ts") && q.expected_outcome.includes("Manual resume"));
    expect(behavior?.expected_outcome).toContain("Start at src/manual.ts");
    const accepted = ["design-contract:DR-001", "design-conceptual:DR-001", "design-systemic:DR-001"].map(target);
    expect(new Set(accepted.map(q => q.question_id)).size).toBe(3);
    for (const q of accepted) expect(plan.inventory.find(i => i.inventory_item_id === q.inventory_item_ids[0])?.source_refs)
      .toEqual([{ path: "src/manual.ts", start_line: 3, end_line: 6 }]);
    bundle.review_plan = plan;
    const bindings = await questionWorkloadBindings(bundle, "frozen-fixture", [], bundle.repo_manifest!.files.map(file =>
      ({ path: file.path, fingerprint: file.hash!, line_count: 10 })));
    expect(bindings.slice(0, 4).map(b => b.question.question_id))
      .toEqual(expect.arrayContaining([...accepted, target("charter:material")].map(q => q.question_id)));
    const behaviorBinding = bindings.find(binding => binding.question === behavior)!;
    expect(behaviorBinding.assignment.suggested_sources[0]).toEqual({ path: "src/manual.ts" });
    expect(behaviorBinding.assignment.suggested_sources).toContainEqual({ path: related.path });
    const issued = bindings.find(b => b.question.question_id === accepted[0]!.question_id)!;
    expect(issued.assignment.suggested_sources).toEqual([{ path: "src/manual.ts", start_line: 3, end_line: 6 }]);
    expect(issued.dependencies).toContainEqual(expect.objectContaining({ key: "design-contract:DR-001", kind: "evidence" }));
    bundle.design_assessment.findings[1]!.summary = "Updated evidence for the same seam.";
    const revised = buildReviewQuestionPlan(bundle, { snapshotId: "snapshot-b" });
    expect(revised.questions.find(q => q.question_id === group.question_id)?.revision_id).not.toBe(group.revision_id);
  });

  it("assigns fully bound file-wide complexity in full scope without treating unbound cues as reviewable", () => {
    const bundle = fixture();
    const ref = (path: string) => ({ path });
    const claim = (id: string, paths: string[], category = "complexity_hotspot"): Finding => ({
      id, title: id, category, severity: "low", confidence: "medium", lens: "architecture",
      summary: `Check the structural cue ${id}.`, affected_files: paths.map(ref),
    });
    const config = "src/runtime-config.ts", fallback = "src/importer.ts";
    bundle.repo_manifest!.files.push({ path: fallback, size_bytes: 100, language: "typescript", hash: "importer" });
    bundle.file_disposition!.files.push({ path: fallback, status: "included" });
    bundle.design_assessment = {
      generated_at: "x", contract_reviewed: false, conceptual_reviewed: false,
      findings: [claim("config-a", [config]), { ...claim("config-a", [config]), id: "config-b" }, claim("other-file", [fallback]),
        claim("missing", ["src/not-in-snapshot.ts"]), claim("partially-bound", [config, "src/not-in-snapshot.ts"]),
        claim("test", ["test/resume.test.ts"]), claim("docs", ["docs/resume.md"]),
        claim("representative", [config], "orphan_units"), claim("unbound-seam", [config, "src"], "architectural_seam")],
    };
    const scope = { mode: "full" as const, since: null, seed_files: [], expanded_files: [], budget: { max_files: 20 } };
    const plan = buildReviewQuestionPlan(bundle, { snapshotId: "a", scope });
    expect(ReviewPlanSchema.safeParse(plan).success).toBe(true);
    const disposition = (id: string, source = plan) => source.signal_dispositions!.find(item => item.signal_id === `design-lead:${id}`)!;
    const first = disposition("config-a"), grouped = disposition("config-b");
    expect(first).toMatchObject({ outcome: "promoted", source_refs: [ref(config)] });
    expect(grouped).toMatchObject({ outcome: "grouped", question_id: first.question_id });
    expect(disposition("other-file").question_id).not.toBe(first.question_id);
    const question = plan.questions.find(q => q.question_id === first.question_id)!;
    expect(question.expected_outcome).toContain("metric is a cue, not a finding");
    expect(question.requested_parts.map(p => p.part_id)).toEqual(["design-lead:config-a", "design-lead:config-b"]);
    expect(question.evidence_dependencies.map(dep => dep.key)).toEqual(["design-lead:config-a", "design-lead:config-b"]);
    for (const id of ["missing", "partially-bound", "test", "docs", "representative", "unbound-seam"]) {
      expect(disposition(id)).toMatchObject({ outcome: "not_promoted" });
      expect(disposition(id)).not.toHaveProperty("question_id");
    }
    expect(disposition("representative").reason).toContain("representative file");
    const delta = buildReviewQuestionPlan(bundle, { snapshotId: "a", scope: { ...scope,
      mode: "delta", since: "baseline", seed_files: [config] } });
    expect(disposition("config-a", delta)).toMatchObject({ outcome: "not_promoted" });
  });

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

  it("keeps path-only CLI files provisional without erasing registered or unknown entrypoints", () => {
    const contents = {
      "package.json": JSON.stringify({ name: "fixture", bin: { resume: "./src/cli/main.ts" } }),
      "src/cli/main.ts": "import { args } from './args'; console.log(args());",
      "src/cli/args.ts": "import { parse } from './argumentContract'; import { store } from '../models/state'; export const args = () => store(parse());",
      "src/cli/argumentContract.ts": "import { store } from '../models/state'; export const parse = () => store('ok');",
      "src/models/state.ts": "export const store = (value: string) => value;",
      "legacy/commands/export.py": "print('report')",
    };
    const bundle = fixture();
    bundle.repo_manifest!.files = Object.entries(contents).map(([path, text]) => ({
      path, language: "text", size_bytes: text.length, hash: path,
    }));
    bundle.file_disposition!.files = bundle.repo_manifest!.files.map(({ path }) => ({ path, status: "included" }));
    bundle.graph_bundle = buildGraphBundle(bundle.repo_manifest!, bundle.file_disposition, { fileContents: contents });
    bundle.surface_manifest = buildSurfaceManifest(bundle.repo_manifest!, bundle.file_disposition, { graphBundle: bundle.graph_bundle });
    bundle.critical_flows = buildCriticalFlowManifest(bundle.repo_manifest!, bundle.surface_manifest, bundle.file_disposition, { graphBundle: bundle.graph_bundle });
    const lead = "args-duplication";
    bundle.design_assessment = {
      generated_at: "x", findings: [{
        id: lead, title: "Possible duplicated parser", category: "code_duplication",
        lens: "architecture", severity: "medium", confidence: "high",
        summary: "Verify whether the parser duplicates argument validation.",
        affected_files: [{ path: "src/cli/args.ts" }],
      }],
    };
    const plan = buildReviewQuestionPlan(bundle, { snapshotId: "provisional" });
    expect(ReviewPlanSchema.safeParse(plan).success).toBe(true);
    const operations = plan.inventory.filter(({ kind, scope }) => kind === "operation" && scope === "in_scope");
    expect(operations.map(({ title }) => title)).toEqual(["package:package.json:bin.resume"]);
    for (const [directory, candidates] of [
      ["src/cli/", ["src/cli/args.ts", "src/cli/argumentContract.ts"]],
      ["legacy/commands/", ["legacy/commands/export.py"]],
    ] as const) {
      const title = `Local interface candidates in ${directory}`;
      const items = plan.inventory.filter((item) => item.title === title);
      expect(items.find(({ kind }) => kind === "invariant")?.source_refs).toEqual(
        expect.arrayContaining(candidates.map((path) => ({ path }))),
      );
      const questionIds = items.map(({ inventory_item_id }) => inventory_item_id);
      const questions = plan.questions.filter(({ inventory_item_ids }) => questionIds.includes(inventory_item_ids[0]!));
      expect(questions.map(({ lens }) => lens).sort()).toEqual(["behavior", "operability", "tests"]);
      expect(questions.every((q) => q.source_dependencies.some(({ kind }) => kind === "membership"))).toBe(true);
    }

    // Grouping the generic assignments must not discard their more specific
    // bindings: the two candidates still share state, and a directly bound
    // structural lead still gets independent verification.
    const shared = plan.questions.find(({ expected_outcome }) =>
      expected_outcome.includes("Shared invariant at src/models/state.ts"));
    expect(shared?.requested_parts.map(({ part_id }) => part_id)).toEqual([
      "surface:src/cli/args.ts", "surface:src/cli/argumentContract.ts",
    ]);
    expect(plan.signal_dispositions).toContainEqual(expect.objectContaining({
      signal_id: `design-lead:${lead}`, outcome: "promoted", question_id: expect.any(String),
    }));

    // A host-supplied workflow is independent evidence, even if its entry was
    // also nominated by filenames in an ecosystem without native extraction.
    bundle.critical_flows!.flows.push({ id: "known-export", name: "Operator exports report",
      entrypoints: ["legacy/commands/export.py"], paths: ["legacy/commands/export.py"], concerns: [] });
    const corroborated = buildReviewQuestionPlan(bundle, { snapshotId: "corroborated" });
    expect(corroborated.inventory.find(({ kind, title }) => kind === "operation" && title.includes("export.py"))).toBeDefined();
    expect(corroborated.inventory.some(({ title }) => title === "Local interface candidates in legacy/commands/")).toBe(false);
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
