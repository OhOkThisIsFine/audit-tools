import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const workflowPath = new URL("../../.github/workflows/publish-package.yml", import.meta.url);
const workflow = () => parse(readFileSync(workflowPath, "utf8"));

test("source validation binds gate, every shard and publish to one immutable SHA", () => {
  const doc = workflow();
  const source = doc.jobs["validate-source"];
  expect(source).toBeDefined();
  expect(doc.permissions).toEqual({ contents: "read" });
  expect(source.outputs.commit).toBe("${{ steps.source.outputs.commit }}");
  const checkout = source.steps.find((step: { uses?: string }) => step.uses?.startsWith("actions/checkout@"));
  expect(checkout.with).toMatchObject({ ref: "${{ github.sha }}", "fetch-depth": 0 });
  for (const name of ["gate", "test", "publish"]) {
    const job = doc.jobs[name];
    expect(job.needs).toContain("validate-source");
    const checkouts = job.steps.filter((step: { uses?: string }) => step.uses?.startsWith("actions/checkout@"));
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0].with.ref).toBe("${{ needs.validate-source.outputs.commit }}");
  }
  expect(doc.jobs.publish.needs).toEqual(["validate-source", "gate", "test"]);
  expect(doc.jobs.test.strategy.matrix.shard).toEqual([1, 2, 3, 4]);
});

test("OIDC publish rechecks the source before any install/build; no floating metadata gate", () => {
  const doc = workflow();
  const steps = doc.jobs.publish.steps;
  const recheck = steps.findIndex((step: { name: string }) => step.name === "Recheck verified release source");
  expect(recheck).toBeGreaterThan(0);
  expect(steps[recheck].run).toBe("node scripts/shared/verify-release-source.mjs\n");
  expect(steps[recheck].env.VERIFIED_RELEASE_SHA).toBe("${{ needs.validate-source.outputs.commit }}");
  expect(steps.findIndex((step: { run?: string }) => /npm (?:ci|install)|npm run build/.test(step.run ?? ""))).toBeGreaterThan(recheck);
  expect(steps[0].with["fetch-depth"]).toBe(0);
  for (const [name, job] of Object.entries(doc.jobs) as [string, { permissions?: Record<string, string> }][]) {
    expect(job.permissions?.["id-token"]).toBe(name === "publish" ? "write" : undefined);
  }
  for (const step of [doc.jobs["validate-source"].steps.find((s: { id?: string }) => s.id === "source"), steps[recheck]]) {
    expect(step.run).not.toMatch(/\$\{\{|\|\|\s*true|target_commitish/);
    expect(step.env.RELEASE_EVENT_SHA).toBe("${{ github.sha }}");
    expect(step.env.RELEASE_DEFAULT_BRANCH).toBe("${{ github.event.repository.default_branch }}");
    expect(step.env.RELEASE_TAG).toBe("${{ github.event.release.tag_name }}");
    expect(step.env.RELEASE_REF).toBe("${{ github.ref }}");
    expect(step.env.RELEASE_EVENT_NAME).toBe("${{ github.event_name }}");
    expect(step.env.RELEASE_DRY_RUN).toBe("${{ inputs.dry_run }}");
  }
  expect(readFileSync(workflowPath, "utf8")).not.toContain("target_commitish");
  const upload = steps.find((step: { name: string }) => step.name.startsWith("Publish to npm"));
  expect(upload.if).toBe("${{ github.event_name != 'workflow_dispatch' || inputs.dry_run == 'false' }}");
  const dry = steps.find((step: { name: string }) => step.name === "Dry run publish (no upload)");
  expect(dry.if).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.dry_run == 'true' }}");
  expect(dry.run).toContain("npm publish --dry-run");
});

// Disposable repositories exercise the SAME helper invoked by the workflow.
// All remotes are file URLs; no release, registry, or credential is involved.
import { beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { scratchDir } from "../helpers/scratch.js";

type GitResult = { status: number | null; stdout: string; stderr: string; error?: Error };
type Git = (args: string[]) => GitResult;
const root = scratchDir("publish-source-contract");
let remote: string;
let checkout: string;
let ancestor: string;
let tip: string;
let merged: string;
let divergent: string;
let orphan: string;
let git: Git;
const env = () => ({ ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "no-global-config"), GIT_TERMINAL_PROMPT: "0" });
function command(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: env() });
  if (result.error || result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.error ?? result.stderr}`);
  return result.stdout.trim();
}
function commit(name: string) {
  writeFileSync(join(remote, `${name}.txt`), name);
  command(remote, ["add", "."]);
  command(remote, ["commit", "-m", name]);
  return command(remote, ["rev-parse", "HEAD"]);
}
function input(sha = ancestor) {
  return { eventSha: sha, eventName: "release", defaultBranch: "main", ref: "refs/tags/v1.0.0", releaseTag: "v1.0.0", dryRun: false };
}
async function verify(options = input(), seam = git) {
  const { verifyReleaseSource } = await import("../../scripts/shared/verify-release-source.mjs");
  return verifyReleaseSource(options, seam);
}

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  remote = join(root, "origin");
  checkout = join(root, "checkout");
  mkdirSync(remote);
  command(remote, ["init", "-b", "main"]);
  command(remote, ["config", "user.name", "Release fixture"]);
  command(remote, ["config", "user.email", "fixture@example.invalid"]);
  ancestor = commit("ancestor");
  command(remote, ["checkout", "-b", "feature"]);
  merged = commit("merged");
  command(remote, ["checkout", "main"]);
  commit("advance");
  command(remote, ["merge", "--no-ff", "feature", "-m", "merge feature"]);
  tip = commit("tip");
  command(remote, ["checkout", "-b", "divergent", ancestor]);
  divergent = commit("divergent");
  command(remote, ["checkout", "--orphan", "unrelated"]);
  command(remote, ["rm", "-rf", "."]);
  orphan = commit("orphan");
  command(remote, ["checkout", "main"]);
  command(remote, ["tag", "v1.0.0", ancestor]);
  command(root, ["clone", "--no-local", pathToFileURL(remote).href, checkout]);
  command(checkout, ["checkout", "--detach", ancestor]);
  git = (args) => spawnSync("git", args, { cwd: checkout, encoding: "utf8", env: env() });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test.each(["ancestor", "tip", "merged"])("release accepts %s via real ancestry, including a merged side branch", async (kind) => {
  const sha = kind === "ancestor" ? ancestor : kind === "tip" ? tip : merged;
  command(remote, ["tag", "-f", "v1.0.0", sha]);
  command(checkout, ["checkout", "--detach", sha]);
  expect(await verify(input(sha))).toBe(sha);
});

test.each([false, true])("release peels annotated=%s tags", async (annotated) => {
  command(remote, ["tag", "-d", "v1.0.0"]);
  command(remote, annotated ? ["tag", "-a", "v1.0.0", ancestor, "-m", "release"] : ["tag", "v1.0.0", ancestor]);
  expect(await verify()).toBe(ancestor);
});

test.each(["divergent", "orphan"])("metadata claiming main cannot admit %s source", async (kind) => {
  const sha = kind === "divergent" ? divergent : orphan;
  command(remote, ["tag", "-f", "v1.0.0", sha]);
  command(checkout, ["checkout", "--detach", sha]);
  const misleading = { ...input(sha), target_commitish: "main" };
  await expect(verify(misleading)).rejects.toThrow(/ancestor/);
});

test("fresh tag resolution refuses a moved tag instead of changing qualification source", async () => {
  command(remote, ["tag", "-f", "v1.0.0", tip]);
  await expect(verify()).rejects.toThrow(/tag.*captured/i);
});

test("deleted remote tag refuses even when the checkout still has a stale local tag", async () => {
  command(remote, ["tag", "-d", "v1.0.0"]);
  await expect(verify()).rejects.toThrow(/fetch/);
});

test("live manual dispatch is default-branch only; off-default dry run captures its own SHA", async () => {
  command(checkout, ["checkout", "--detach", divergent]);
  const options = { ...input(divergent), eventName: "workflow_dispatch", ref: "refs/heads/divergent", releaseTag: "" };
  await expect(verify(options)).rejects.toThrow(/default branch/);
  expect(await verify({ ...options, dryRun: true })).toBe(divergent);
  await expect(verify({ ...options, ref: "refs/heads/main" })).rejects.toThrow(/ancestor/);
  await expect(verify({ ...options, ref: "refs/tags/main" })).rejects.toThrow(/default branch/);
});

test("live default dispatch admits an older main commit after advancement", async () => {
  expect(await verify({ ...input(), eventName: "workflow_dispatch", ref: "refs/heads/main", releaseTag: "" })).toBe(ancestor);
});

test("publish recheck refuses rewritten default history and a different checkout", async () => {
  const { verifyReleaseSource } = await import("../../scripts/shared/verify-release-source.mjs");
  const validated = await verify();
  expect(() => verifyReleaseSource({ ...input(), expectedSha: tip }, git)).toThrow(/validated/);
  command(checkout, ["checkout", "--detach", tip]);
  expect(() => verifyReleaseSource({ ...input(), expectedSha: validated }, git)).toThrow(/HEAD/);
  command(checkout, ["checkout", "--detach", ancestor]);
  command(remote, ["update-ref", "refs/heads/main", orphan]);
  expect(() => verifyReleaseSource({ ...input(), expectedSha: validated }, git)).toThrow(/ancestor/);
});

test("shallow history refuses even a trivially matching tip", async () => {
  const shallow = join(root, "shallow");
  command(root, ["clone", "--depth=1", pathToFileURL(remote).href, shallow]);
  const shallowGit: Git = (args) => spawnSync("git", args, { cwd: shallow, encoding: "utf8", env: env() });
  await expect(verify({ ...input(tip), eventName: "workflow_dispatch", ref: "refs/heads/main" }, shallowGit)).rejects.toThrow(/shallow/);
});

test.each(["fetch", "rev-list", "merge-base", "throw", "spawn-error"])("%s failure cannot admit a release", async (failure) => {
  const seam: Git = (args) => {
    if (args.includes(failure) || (args.includes("fetch") && ["throw", "spawn-error"].includes(failure))) {
      if (failure === "throw") throw new Error("fixture transport threw");
      return { status: failure === "spawn-error" ? 0 : 128, stdout: "", stderr: "fixture transport failure", ...(failure === "spawn-error" ? { error: new Error("fixture spawn failure") } : {}) };
    }
    return git(args);
  };
  await expect(verify(input(), seam)).rejects.toThrow();
});

test("missing commit and invalid object IDs fail closed", async () => {
  await expect(verify(input("0".repeat(40)))).rejects.toThrow();
  for (const invalid of ["main", "HEAD", "abc123", "-HEAD", `${ancestor}\nother`]) {
    await expect(verify(input(invalid))).rejects.toThrow(/full object ID/);
  }
  await expect(verify(input(), (args) => args.includes(`${ancestor}^{commit}`) ? { status: 0, stdout: "not-a-sha", stderr: "" } : git(args))).rejects.toThrow(/full object ID/);
});

test.each(["../main", "-main", "main:evil", "main\nother", "main~1"])("invalid ref spelling %j never reaches fetch", async (name) => {
  let fetched = false;
  const seam: Git = (args) => { fetched ||= args.includes("fetch"); return git(args); };
  await expect(verify({ ...input(), defaultBranch: name }, seam)).rejects.toThrow();
  await expect(verify({ ...input(), releaseTag: name }, seam)).rejects.toThrow();
  expect(fetched).toBe(false);
});

test("helper import is side-effect-free; CLI emits only its resolved immutable output", () => {
  const helper = new URL("../../scripts/shared/verify-release-source.mjs", import.meta.url);
  const output = join(root, "github-output");
  const invalidEnv = { ...env(), GITHUB_OUTPUT: output, RELEASE_EVENT_SHA: "invalid" };
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(helper.href)})`], { cwd: root, env: invalidEnv, encoding: "utf8" });
  expect(imported.status).toBe(0);
  expect(imported.stdout).toBe("");
  expect(existsSync(output)).toBe(false);
  const result = spawnSync(process.execPath, [fileURLToPath(helper)], { cwd: checkout, encoding: "utf8", env: { ...env(), GITHUB_OUTPUT: output, RELEASE_EVENT_SHA: ancestor, RELEASE_DEFAULT_BRANCH: "main", RELEASE_REF: "refs/tags/v1.0.0", RELEASE_TAG: "v1.0.0", RELEASE_EVENT_NAME: "release", RELEASE_DRY_RUN: "" } });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(readFileSync(output, "utf8")).toBe(`commit=${ancestor}\n`);
});

test("dry-run input cannot bypass release-event ancestry", async () => {
  command(remote, ["tag", "-f", "v1.0.0", divergent]);
  command(checkout, ["checkout", "--detach", divergent]);
  await expect(verify({ ...input(divergent), dryRun: true })).rejects.toThrow(/ancestor/);
});

test("a deleted default branch cannot reuse a stale fetched default ref", async () => {
  expect(await verify()).toBe(ancestor);
  command(remote, ["update-ref", "-d", "refs/heads/main"]);
  await expect(verify()).rejects.toThrow(/fetch/);
});

test("unknown event and mismatched event ref fail closed", async () => {
  await expect(verify({ ...input(), eventName: "push" })).rejects.toThrow(/event/);
  await expect(verify({ ...input(), ref: "refs/tags/something-else" })).rejects.toThrow(/ref/);
});

test("missing ancestor objects refuse even when captured source equals default tip", async () => {
  const broken = join(root, "incomplete");
  command(root, ["clone", "--local", "--no-hardlinks", remote, broken]);
  const ancestorObject = join(broken, ".git", "objects", ancestor.slice(0, 2), ancestor.slice(2));
  expect(existsSync(ancestorObject)).toBe(true);
  rmSync(ancestorObject);
  expect(command(broken, ["rev-parse", "HEAD"])).toBe(tip);
  const incompleteGit: Git = (args) => spawnSync("git", args, { cwd: broken, encoding: "utf8", env: env() });
  await expect(verify({ ...input(tip), eventName: "workflow_dispatch", ref: "refs/heads/main" }, incompleteGit)).rejects.toThrow(/rev-list|fetch/);
});

test.each(["--help", "-h", "--unknown", "unexpected"])("CLI %s exits before source validation or output writes", (arg) => {
  const helper = fileURLToPath(new URL("../../scripts/shared/verify-release-source.mjs", import.meta.url));
  const output = join(root, "guarded-output");
  const result = spawnSync(process.execPath, [helper, arg], {
    cwd: root, encoding: "utf8",
    env: { ...env(), GITHUB_OUTPUT: output, RELEASE_EVENT_SHA: "invalid" },
  });
  expect(result.status).toBe(arg === "--help" || arg === "-h" ? 0 : 2);
  expect(`${result.stdout}${result.stderr}`).toContain("node scripts/shared/verify-release-source.mjs");
  expect(`${result.stdout}${result.stderr}`).not.toContain("full object ID");
  expect(existsSync(output)).toBe(false);
});
