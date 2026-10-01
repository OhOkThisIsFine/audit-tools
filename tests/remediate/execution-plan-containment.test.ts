import { afterEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureExecutionContext, executionPlanContextIssues, ingestExecutionPlan, readCanonicalPlan } from "../../src/remediate/contractPipeline/executionPlan.js";
import { writeJsonFile } from "../../src/shared/io/json.js";
import { createExecutablePlanFixture } from "./helpers/executablePlanFixture.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile), readdir: vi.fn(actual.readdir) };
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.clearAllMocks();
});
async function fixture() {
  const f = await createExecutablePlanFixture();
  const outside = await mkdtemp(join(tmpdir(), "execution-plan-outside-"));
  roots.push(f.root, outside);
  await writeFile(join(outside, "secret.ts"), "Do not read external source");
  return { ...f, outside };
}
async function directoryLink(target: string, link: string) {
  await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}
function expectNoContentReadThrough(path: string) {
  const reads = [...vi.mocked(readFile).mock.calls, ...vi.mocked(readdir).mock.calls];
  expect(reads.filter(([candidate]) => String(candidate).startsWith(path))).toEqual([]);
}

test.each([
  { grant: "read_paths", path: "linked/secret.ts" },
  { grant: "allowed_files", path: "linked/secret.ts" },
  { grant: "allowed_files", path: "linked/missing/new.ts" },
] as const)("refuses symlink ancestors in $grant for $path before external content reads", async ({ grant, path }) => {
  const f = await fixture();
  const link = join(f.root, "linked");
  await directoryLink(f.outside, link);
  const before = await readFile(f.paths.canonical, "utf8");
  const prior = (await readCanonicalPlan(f.artifactsDir))!;
  f.plan.units[0]![grant] = [path];
  await writeJsonFile(f.paths.submission, { base_revision_sha256: prior.revision_sha256, plan: f.plan, retired_requirements: [] });
  vi.clearAllMocks();
  const result = await ingestExecutionPlan(f.options);
  expect(result.issues.join(" ")).toMatch(/symbolic link|symlink|contained/i);
  expect(result.changed).toBe(false);
  expectNoContentReadThrough(link);
  expect(await readFile(f.paths.canonical, "utf8")).toBe(before);
});

test("a replaced ancestor returns a repair issue at fresh context capture before reading its target", async () => {
  const f = await fixture();
  const directory = join(f.root, "source");
  await mkdir(directory);
  await writeFile(join(directory, "secret.ts"), "Reviewed source");
  const prior = (await readCanonicalPlan(f.artifactsDir))!;
  f.plan.units[0]!.read_paths = ["source/secret.ts"];
  f.plan.units[0]!.allowed_files = ["source/secret.ts"];
  await writeJsonFile(f.paths.submission, { base_revision_sha256: prior.revision_sha256, plan: f.plan, retired_requirements: [] });
  expect((await ingestExecutionPlan(f.options)).issues).toEqual([]);
  const canonical = (await readCanonicalPlan(f.artifactsDir))!;
  await rm(directory, { recursive: true });
  await directoryLink(f.outside, directory);
  vi.clearAllMocks();
  await expect(executionPlanContextIssues(f.root, canonical)).resolves.toEqual([
    expect.stringMatching(/symbolic link|symlink|contained/i),
  ]);
  expectNoContentReadThrough(directory);
});

test("safe missing descendants remain valid write grants and the selected root may be a symlink", async () => {
  const f = await fixture();
  const prior = (await readCanonicalPlan(f.artifactsDir))!;
  f.plan.units[0]!.allowed_files = ["new/deep/file.ts"];
  await writeJsonFile(f.paths.submission, { base_revision_sha256: prior.revision_sha256, plan: f.plan, retired_requirements: [] });
  expect((await ingestExecutionPlan(f.options)).issues).toEqual([]);
  const alias = join(f.outside, "selected-root");
  await directoryLink(f.root, alias);
  expect(await captureExecutionContext(alias, f.plan)).toEqual(await captureExecutionContext(f.root, f.plan));
});
