import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, expect, it } from "vitest";
import { spawnSyncHidden } from "../helpers/spawn.mjs";

const source = fileURLToPath(new URL("../../", import.meta.url));
const tools = ["audit-code", "remediate-code"] as const;
let scratch: string;
let pkg: string;
let home: string;
let repo: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "installer-compat-"));
  pkg = join(scratch, "package");
  home = join(scratch, "home");
  repo = join(scratch, "repo");
  await Promise.all([pkg, home, repo].map(path => mkdir(path)));
  for (const asset of ["wrapper", "skills", "scripts/shared/primitives.mjs", "scripts/shared/host-asset-plan.mjs",
    "scripts/shared/install-host-assets.mjs", "scripts/audit/postinstall.mjs", "scripts/remediate/postinstall.mjs",
    "package.json", "scripts/postinstall.mjs", "node_modules/smol-toml", ...tools.map(tool => tool + ".mjs")]) {
    await cp(join(source, asset), join(pkg, asset), { recursive: true, dereference: true });
  }
  // Build these two production leaves into this fixture. A concurrent wrapper
  // auto-build can replace the checkout's dist while a test is reading it.
  await mkdir(join(pkg, "fixture-shared"));
  await sharedBuild('export * from "../../fixture-shared/hostAssets.js"; export * from "../../fixture-shared/opencodePermissions.js";');
  for (const name of ["hostAssets", "opencodePermissions"]) {
    const bytes = await readFile(join(source, "src/shared", name + ".ts"), "utf8");
    const compiled = ts.transpileModule(bytes, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    await writeFile(join(pkg, "fixture-shared", name + ".js"), compiled.outputText);
  }
});
afterEach(() => rm(scratch, { recursive: true, force: true }));

function run(entry: string, ...args: string[]) {
  return spawnSyncHidden(process.execPath, [join(pkg, entry), ...args], {
    cwd: repo, encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home, INIT_CWD: repo, AUDIT_TOOLS_REPO_VISIBILITY: "ignore",
      APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"), XDG_CONFIG_HOME: join(home, ".config") },
  });
}

function successful(entry: string, ...args: string[]) {
  const result = run(entry, ...args);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

async function sharedBuild(exports: string) {
  const target = join(pkg, "dist/shared/index.js");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, exports);
}

it("installs CRLF remediation assets as LF and verifies and ensures the same bytes", async () => {
  const bin = "remediate-code.mjs";
  const prompt = join(pkg, "skills/remediate-code/remediate-code.prompt.md");
  const skill = join(dirname(prompt), "SKILL.md");
  for (const path of [prompt, skill]) await writeFile(path, (await readFile(path, "utf8")).replace(/\r?\n/g, "\r\n"));
  const flags = ["--host", "copilot", "--root", repo];
  const first = successful(bin, "install", ...flags);
  const verify = () => successful(bin, "verify-install", ...flags);
  for (const [path, sourcePath] of [[first.installed_prompt_path, prompt], [first.installed_skill_path, skill]]) {
    expect(await readFile(path, "utf8")).toBe((await readFile(sourcePath, "utf8")).replaceAll("\r\n", "\n"));
  }
  expect(verify().status).toBe("ok");
  expect(successful(bin, "ensure", ...flags)).toMatchObject({ action: "skipped", reason: null });
  successful(bin, "install", ...flags);
  expect(verify().status).toBe("ok");
  expect(successful(bin, "ensure", ...flags).action).toBe("skipped");
});

for (const tool of tools) {
  const bin = tool + ".mjs";
  it(`${tool} validates host and root flags before writing and uses their first values`, async () => {
    for (const [args, cause] of [
      [["install-host"], "--host requires a value"],
      [["install-host", "--host", "codex"], 'supports only "copilot"'],
      [["install", "--root", "--quiet"], "--root requires a value"],
      [["ensure", "--host", "--quiet"], "--host requires a value"],
    ] as const) {
      const result = run(bin, ...args);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(cause);
    }
    expect(await readdir(repo)).toEqual([]);
    await mkdir(join(repo, "--target"));
    const install = successful(bin, "install-host", "--host=copilot", "--host", "codex", "--root=--target", "--root", repo);
    expect(install.repo_root).toBe(join(repo, "--target"));
    expect(install.host).toBe("copilot");
    expect(await readdir(repo)).toEqual(["--target"]);
    expect(await readdir(home)).toEqual([]);
  });

  it(`${tool} verifies VS Code prompt content and removes only recognized legacy Codex metadata`, async () => {
    const agents = join(repo, ".codex/skills", tool, "agents");
    await mkdir(agents, { recursive: true });
    await writeFile(join(agents, "managed.yaml"), `display_name: ${tool}\ndefault_prompt: Start /${tool}\n`);
    await writeFile(join(agents, "user.yaml"), "display_name: My workflow\n");
    const flags = ["--host", "copilot", "--root", repo];
    const installed = successful(bin, "install-host", ...flags);
    expect(await readdir(agents)).toEqual(["user.yaml"]);
    const prompt = installed.slash_command_surfaces.vscode_prompt;
    const rendered = await readFile(prompt, "utf8");
    expect(rendered).toContain("name: " + tool);
    expect(successful(bin, "verify-install", ...flags).status).toBe("ok");
    await writeFile(prompt, rendered + "\nUnexpected change\n");
    const result = run(bin, "verify-install", ...flags);
    expect(result.status).toBe(1);
    const verify = JSON.parse(result.stdout);
    expect(verify.hosts[0].checks).toContainEqual(expect.objectContaining({
      id: "vscode_prompt", status: "error", summary: expect.stringContaining("out of sync"),
    }));
    expect(await readdir(home)).toEqual([]);
  });

  it(`${tool} handles a clean checkout and a shared build missing permission capabilities`, async () => {
    const config = join(repo, "opencode.json");
    const user = '{"agent":{"mine":{"description":"leave me"}}}\n';
    await writeFile(config, user);
    await rm(join(pkg, "dist"), { recursive: true });
    for (const revision of ["prebuild", "older-shared"]) {
      if (revision === "older-shared") await sharedBuild('export { renderHostAsset } from "../../fixture-shared/hostAssets.js"; export { mergeOpenCodeAgentPermissionRule } from "../../fixture-shared/opencodePermissions.js";');
      const result = run(bin, "install", "--root", repo, "--host", "opencode");
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      if (revision === "older-shared") expect(result.stderr).toContain('Run "npm run build" before deploying OpenCode config');
      else expect(result.stderr).toMatch(/dist[\\/]shared[\\/]index\.js/);
      expect(await readFile(config, "utf8")).toBe(user);
      if (revision === "older-shared") expect(successful(bin, "install", "--host", "copilot", "--root", repo).host).toBe("copilot");
      const deployer = tool === "audit-code" ? "scripts/audit/postinstall.mjs" : "scripts/remediate/postinstall.mjs";
      const postinstall = run(deployer);
      expect(postinstall.status, postinstall.stderr).toBe(0);
      expect(postinstall.stderr).toContain('run "npm run build" from the audit-tools package root');
      expect(postinstall.stderr).toContain("skipping OpenCode config deployment");
      await expect(readFile(join(home, ".config/opencode/opencode.json"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
}

it("migrates the pre-hardening remediation project and agent permissions while preserving user rules", async () => {
  // The frozen JSON is the actual renderOpenCodeProjectConfig output at f8961e97,
  // the parent of the project permission hardening. Add only user-authored keys.
  const historical = JSON.parse(await readFile(new URL("./fixtures/opencode-remediation-project-f8961e97.json", import.meta.url), "utf8"));
  for (const permission of [historical.permission, historical.agent.remediator.permission]) {
    permission.bash["mine --*"] = "deny";
    permission.edit["private/**"] = "deny";
  }
  historical.agent.mine = { permission: { external_directory: { "../user/**": "ask" } } };
  const path = join(repo, "opencode.json");
  await writeFile(path, JSON.stringify(historical));
  const flags = ["--root", repo, "--host", "opencode"];
  successful("remediate-code.mjs", "install", ...flags);
  const bytes = await readFile(path, "utf8");
  const config = JSON.parse(bytes);
  expect(config.agent.mine).toEqual(historical.agent.mine);
  for (const permission of [config.permission, config.agent.remediator.permission]) {
    expect(permission.external_directory).toBeUndefined();
    expect(permission.bash).toMatchObject({ "*": "ask", "mine --*": "deny", "remediate-code validate*": "allow" });
    expect(permission.edit["private/**"]).toBe("deny");
  }
  expect(successful("remediate-code.mjs", "ensure", ...flags).action).toBe("skipped");
  successful("remediate-code.mjs", "install", ...flags);
  expect(await readFile(path, "utf8")).toBe(bytes);
});

it("retains visibility override fallback with an older shared build", async () => {
  // This historical API predates parseVisibilityOverride. Observe the value
  // the real umbrella postinstall passes to ensureArtifactGitignore.
  await sharedBuild(`import { writeFileSync } from "node:fs";
import { join } from "node:path";
export function ensureArtifactGitignore({ repoRoot, override }) {
  writeFileSync(join(repoRoot, "observed.json"), JSON.stringify({ override }));
  return { changed: false };
}`);
  const result = run("scripts/postinstall.mjs");
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(await readFile(join(repo, "observed.json"), "utf8"))).toEqual({ override: "public" });
  expect(result.stderr.match(/skipping OpenCode config deployment/g)).toHaveLength(2);
});
