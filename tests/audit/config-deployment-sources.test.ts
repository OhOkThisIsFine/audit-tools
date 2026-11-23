import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { hashContent, RunLogger } from "audit-tools/shared";
import { questionWorkloadBindings } from "../../src/audit/cli/questionWorkloadBindings.js";
import { buildGraphBundle } from "../../src/audit/extractors/graph.js";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { EXECUTOR_RUNNERS } from "../../src/audit/orchestrator/executorRunners.js";
import { ReviewPlanSchema } from "../../src/shared/types/reviewQuestion.js";
import { scratchDir } from "../helpers/scratch.js";

const release = ".github/workflows/ship.yml";
const checks = ".github/workflows/checks.yml";
const workflow = `jobs:
  checks:
    uses: ./${checks}
  publish:
    defaults:
      run:
        working-directory: packages/widget
    steps:
      - run: |
          node scripts/verify.mjs
          npm run qualify
          npm publish --ignore-scripts
          node scripts/withheld.mjs
      - run: echo "npm run unrelated"
      - uses: example/qualify@v1
        with:
          policy: ops/widget.yml
      - working-directory: .
        run: npm publish ./packages/widget
`;
const contents = {
  [release]: workflow, [checks]: "jobs: {}",
  "package.json": "{}",
  "ops/widget.yml": "environment: release",
  "packages/widget/package.json": JSON.stringify({ scripts: {
    qualify: "node scripts/gate.mjs", prepublishOnly: "npm run qualify", unrelated: "node scripts/unused.mjs",
  } }),
  "packages/widget/scripts/verify.mjs": "", "packages/widget/scripts/gate.mjs": "",
  "packages/widget/scripts/unused.mjs": "", "packages/widget/scripts/withheld.mjs": "",
  "docs/runbooks/publish.md": "To release, dispatch `ship.yml`.",
  "docs/runbooks/other.md": "Deploy from another project.",
  ".env.example": "WORKER_MODE=private-example-value\n",
  "src/worker.ts": 'export const mode = process.env.WORKER_MODE ?? "local";',
  "src/unrelated.ts": 'export const unrelated = process.env.WORKER_MODE_EXTRA; // process.env.WORKER_MODE\nexport const example = "process.env.WORKER_MODE";',
  "src/worker.py": 'mode = os.getenv("WORKER_MODE", "local")',
};

async function issue(root: string) {
  const files = Object.entries(contents).map(([path, content]) => ({
    path, hash: hashContent(content), size_bytes: Buffer.byteLength(content), language: "text",
  }));
  for (const [path, content] of Object.entries(contents)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const bundle: ArtifactBundle = {
    repo_manifest: { repository: { name: "widget" }, generated_at: "x", files },
    file_disposition: { files: files.map(({ path }) => ({ path,
      status: path.endsWith("withheld.mjs") ? "excluded" : path.startsWith("docs/") ? "doc_only" : "included",
    })) },
  };
  bundle.graph_bundle = buildGraphBundle(bundle.repo_manifest!, bundle.file_disposition, { fileContents: contents });
  const { updated } = await EXECUTOR_RUNNERS.planning_executor!(bundle, {
    options: { root }, log: RunLogger.disabled(), correlationId: "fixture", obligation: null,
  });
  updated.review_plan = ReviewPlanSchema.parse(updated.review_plan);
  const bindings = await questionWorkloadBindings(updated, root, []);
  const rebound = await questionWorkloadBindings(updated, root, [], bindings[0]!.sourceFiles);
  expect(rebound).toEqual(bindings);
  return bindings;
}

test("release reviewers get the invoked package, local checks and linked runbook as optional starting points", async () => {
  const bindings = await issue(scratchDir("release-starting-sources"));
  const binding = bindings.find(({ question }) => question.source_dependencies.some(dep => dep.key === release))!;
  expect(binding.assignment.suggested_sources.map(ref => ref.path)).toEqual([
    release, ...[checks, "packages/widget/package.json", "packages/widget/scripts/gate.mjs",
      "ops/widget.yml", "packages/widget/scripts/verify.mjs", "docs/runbooks/publish.md"].sort(),
  ]);
  expect(binding.dependencies.map(dep => dep.key)).toEqual([release]);
  expect(binding.sourceFiles.map(file => file.path)).toContain("packages/widget/scripts/unused.mjs");
  expect(bindings.find(({ dependencies }) => dependencies.some(dep => dep.key === checks))!.assignment.suggested_sources)
    .toEqual([{ path: checks }]);
});

test("runtime reviewers can start at an exact declared setting reader without binding it or exposing its value", async () => {
  const bindings = await issue(scratchDir("runtime-starting-sources"));
  const binding = bindings.find(({ dependencies }) => dependencies.some(dep => dep.key === ".env.example"))!;
  expect(binding.assignment.suggested_sources.map(ref => ref.path)).toEqual([
    ".env.example", "package.json", "packages/widget/package.json", "src/worker.py", "src/worker.ts",
  ]);
  expect(binding.dependencies.map(dep => dep.key)).not.toContain("src/worker.ts");
  expect(JSON.stringify(binding)).not.toContain("private-example-value");
});
