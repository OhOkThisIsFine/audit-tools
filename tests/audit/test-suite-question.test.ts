import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { hashContent } from "../../src/shared/hash.js";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { AuditScopeManifest } from "../../src/audit/types/auditScope.js";
import { buildQuestionPlanArtifacts } from "../../src/audit/orchestrator/questionPlanExecutor.js";
import { deriveCurrentQuestionBindings } from "../../src/audit/cli/questionReviewCycle.js";
import { prepareAuditQuestionReview, publishAuditQuestionWorkload } from "../../src/audit/cli/dispatch/hostHandoff.js";

const scope: AuditScopeManifest = {
  mode: "full", since: null, seed_files: [], expanded_files: [], budget: { max_files: 100 },
};
const content = {
  "pyproject.toml": "[tool.pytest.ini_options]\ntestpaths = ['tests']\n",
  "tests/conftest.py": "import pytest\n",
  "tests/test_a.py": "def test_a():\n    assert True\n",
  "tests/test_b.py": "def test_b():\n    assert True\n",
  "tests/test_z.py": "def test_z():\n    assert True\n",
  "tests/helpers/scenario.py": "case = 'fixture'\n",
  "tests/test_excluded.py": "def test_excluded():\n    assert True\n",
  "src/app.py": "def handler():\n    return 1\n",
  "src/unrelated.py": "value = 42\n",
  ".github/workflows/python-tests.yml": "name: Python tests\n",
  ".github/workflows/deploy.yml": "name: Deploy\n",
};
const files = Object.entries(content);
function makeBundle(entries: Array<[string, string]> = files): ArtifactBundle {
  return {
    repo_manifest: { repository: { name: "suite-fixture" }, generated_at: "2026-01-01",
      files: entries.map(([path, text]) => ({ path, hash: hashContent(text), size_bytes: Buffer.byteLength(text), language: "text" })),
    },
    file_disposition: { files: entries.map(([path]) => ({ path, status: "included" })) },
    surface_manifest: { surfaces: [{ id: "app", kind: "interface", entrypoint: "src/app.py", exposure: "network" }] },
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1", confirmed_at: "2026-01-01", confirmed_by: "host",
      scope_summary: "synthetic test suite", intent_summary: "audit",
      disposition_overrides: [{ path: "tests/test_excluded.py", status: "excluded", reason: "explicitly out of scope" }],
    },
  };
}
const plan = (bundle: ArtifactBundle, selectedScope = scope) => buildQuestionPlanArtifacts(bundle, selectedScope).updated;
const suiteQuestions = (bundle: ArtifactBundle) => bundle.review_plan!.questions.filter(
  ({ lens, requested_parts }) => lens === "tests" && requested_parts[0]?.part_id === "assertions-coverage",
);

test("the planning executor issues a suite review alongside separate operation and deployment questions", () => {
  const first = plan(makeBundle());
  const suites = suiteQuestions(first);
  expect(suites).toHaveLength(1);
  const [suite] = suites;
  expect(suite).toMatchObject({ lens: "tests", requested_parts: [
    { part_id: "assertions-coverage" }, { part_id: "harness-fixtures" }, { part_id: "speed-sharding" }, { part_id: "framework-fit" },
  ] });
  expect(first.review_plan!.questions.some(q => q.lens === "tests" && q.question_id !== suite!.question_id)).toBe(true);
  expect(first.review_plan!.questions.some(q => q.lens === "config_deployment")).toBe(true);

  const reversed = suiteQuestions(plan(makeBundle([...files].reverse())));
  expect(reversed).toEqual(suites);
  const withEdit = (target: string) => suiteQuestions(plan(makeBundle(files.map(([path, text]) =>
    [path, path === target ? text + "\n# material change\n" : text],
  ))))[0]!.revision_id;
  expect(withEdit("tests/test_z.py")).not.toBe(suite!.revision_id);
  expect(withEdit("tests/test_excluded.py")).toBe(suite!.revision_id);
  expect(withEdit("src/unrelated.py")).toBe(suite!.revision_id);

  const narrow = makeBundle();
  narrow.intent_checkpoint!.lens_selection = { include: ["behavior"] };
  expect(suiteQuestions(plan(narrow))).toEqual([]);
  expect(suiteQuestions(plan(makeBundle(), { ...scope, mode: "delta", since: "HEAD", seed_files: ["src/app.py"] }))).toEqual([]);
  const delta = suiteQuestions(plan(makeBundle(), { ...scope, mode: "delta", since: "HEAD", seed_files: ["tests/test_a.py"] }));
  expect(delta[0]?.expected_outcome).toContain("The runner is unverified");

  const multi = plan(makeBundle([...files,
    ["packages/go/go.mod", "module example.org/go"],
    ["packages/go/engine_test.go", "package engine"],
    ["scripts/shared/vitest-shard-duration-baseline.json", "{}"],
    ["tests/fixtures/sample/vitest.config.ts", "export default {}"],
  ]));
  const multiSuites = suiteQuestions(multi);
  expect(multiSuites).toHaveLength(2);
  expect(multiSuites.find(q => q.expected_outcome.includes("packages/go/"))!.expected_outcome)
    .toContain("Start at packages/go/go.mod.");
  const repoSuite = multiSuites.find(q => q.expected_outcome.includes("repository root"))!;
  expect(repoSuite.source_dependencies.map(({ key }) => key)).toContain("scripts/shared/vitest-shard-duration-baseline.json");
  expect(repoSuite.source_dependencies.map(({ key }) => key)).not.toContain("packages/go/engine_test.go");
});

test("the issued Python suite reviewer receives scoped pointers without invented timing or coverage evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "audit-suite-question-"));
  try {
    for (const [file, text] of files) {
      const path = join(root, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, "utf8");
    }
    const boundary = { root, artifactsDir: join(root, ".audit-tools", "audit"), runId: "suite-review" };
    const bundle = plan(makeBundle());
    const [suite] = suiteQuestions(bundle);
    const { bindings } = await deriveCurrentQuestionBindings(bundle, root);
    const binding = bindings.find(({ question }) => question.question_id === suite?.question_id)!;
    expect(binding.assignment.suggested_sources.map(({ path }) => path)).toEqual([
      "pyproject.toml", ".github/workflows/python-tests.yml", "tests/conftest.py", "tests/helpers/scenario.py",
      "tests/test_a.py", "tests/test_b.py",
    ]);
    expect(binding.sourceFiles.map(({ path }) => path)).not.toContain("tests/test_excluded.py");
    expect(binding.evidence).toEqual([]);
    const publication = await publishAuditQuestionWorkload({ ...boundary, sourceRoot: root, bindings });
    const routing = JSON.parse(await readFile(publication.routing_path, "utf8"));
    const handle = await prepareAuditQuestionReview({
      ...boundary, assignmentId: binding.assignment.assignment_id, workloadSha256: routing.workload_sha256,
    });
    const prompt = await readFile(handle.prompt_path, "utf8");
    expect(prompt).toContain("Review this suite as a whole");
    expect(prompt).toContain("do not invent timings, coverage or savings");
    expect(prompt).toContain("No test execution is required");
    expect(prompt).not.toContain("tests/test_z.py");
    expect(prompt).not.toContain("deploy.yml");
    expect(prompt).not.toContain("src/unrelated.py");
    expect(handle.read_paths).not.toHaveProperty("graph_index");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
