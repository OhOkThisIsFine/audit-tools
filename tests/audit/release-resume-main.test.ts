import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// Run the caller, not just planReleaseResume: package.json already holds the
// bumped version when registry observation times out. All external IO is fake.
const fixture = vi.hoisted(() => ({
  version: "0.52.1",
  head: "a".repeat(40),
  tagHead: "a".repeat(40),
  journal: {} as Record<string, unknown>,
  calls: [] as string[],
  registryMisses: 0,
  badBin: "",
  badFlag: "",
  badOutput: "",
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (path: string, ...args: unknown[]) => {
      if (String(path).endsWith("release-journal.json")) return JSON.stringify(fixture.journal);
      if (String(path).endsWith("package.json")) return JSON.stringify({ name: "audit-tools", version: fixture.version });
      return Reflect.apply(actual.readFileSync, actual, [path, ...args]);
    },
    mkdirSync: vi.fn(),
    writeFileSync: (path: string, text: string) => {
      if (!String(path).endsWith("release-journal.json")) throw new Error(`unexpected write: ${path}`);
      fixture.journal = JSON.parse(text);
    },
    existsSync: () => true,
  };
});
vi.mock("../../scripts/shared/profile.mjs", () => ({
  toSeconds: (ms: number) => ms / 1000,
  writeProfileLedger: vi.fn(),
}));
vi.mock("../../scripts/shared/spawn-shell.mjs", () => ({
  resolveSpawn: (command: string, args: string[]) => ({ command, args }),
}));
vi.mock("node:child_process", () => ({
  spawnSync: (command: string, args: string[]) => {
    const cmd = `${command.replace(/\.cmd$/, "")} ${args.join(" ")}`;
    fixture.calls.push(cmd);
    let stdout = "";
    if (cmd === "git remote") stdout = "origin";
    else if (cmd === "git remote get-url origin") stdout = "https://github.com/test/repo.git";
    else if (cmd.startsWith("git status ")) stdout = "";
    else if (cmd === "git branch --show-current") stdout = "main";
    else if (cmd === "git symbolic-ref refs/remotes/origin/HEAD") stdout = "refs/remotes/origin/main";
    else if (/^git rev-parse (?:--verify --quiet )?HEAD$/.test(cmd)) stdout = fixture.head;
    else if (/^git rev-parse (?:--verify --quiet )?v0.52.1\^\{commit\}$/.test(cmd)) stdout = fixture.tagHead;
    // The landing protocol (a resume of an unfinished landing re-enters it).
    else if (cmd === "git fetch --quiet origin main") stdout = "";
    else if (cmd.startsWith("git merge-base --is-ancestor ")) return { status: 1, stdout: "", stderr: "" };
    else if (cmd.startsWith("git push origin ")) stdout = "";
    else if (cmd.startsWith("gh pr list ")) stdout = "[]";
    else if (cmd.startsWith("gh pr create ")) stdout = "https://github.com/test/repo/pull/9";
    else if (cmd.endsWith("protection/required_status_checks")) stdout = JSON.stringify({ checks: [{ context: "checks", app_id: 15368 }] });
    else if (cmd.includes("/check-runs?")) stdout = JSON.stringify({ check_runs: [{ id: 1, name: "checks", status: "completed", conclusion: "success", app: { id: 15368 } }] });
    else if (cmd.endsWith(`commits/${fixture.head}/status`)) stdout = JSON.stringify({ statuses: [] });
    else if (cmd.startsWith("gh pr view ")) stdout = JSON.stringify({ state: "MERGED" });
    else if (cmd.startsWith("gh release view ")) return { status: 1, stdout: "", stderr: "release not found" };
    else if (cmd.startsWith("gh release create ")) stdout = "";
    else if (cmd === "gh workflow view publish-package.yml") stdout = "";
    else if (cmd.includes("actions/workflows/publish-package.yml/runs?")) stdout = JSON.stringify({
      workflow_runs: [{ id: 17, head_sha: fixture.head, head_branch: "v0.52.1", created_at: "2026-09-19T00:00:00Z", html_url: "https://github.com/test/repo/actions/runs/17" }],
    });
    else if (cmd.endsWith("actions/runs/17")) stdout = JSON.stringify({ status: "completed", conclusion: "success", html_url: "https://github.com/test/repo/actions/runs/17" });
    else if (cmd.includes("/jobs?")) stdout = JSON.stringify({ jobs: [] });
    else if (cmd === "npm view audit-tools@0.52.1 version") {
      if (fixture.registryMisses-- > 0) return { status: 1, stdout: "", stderr: "E404 propagation pending" };
      stdout = "0.52.1";
    }
    else if (cmd === "npm root -g") stdout = "/global/lib/node_modules";
    else if (cmd === "npm prefix -g") stdout = "/global";
    else if (cmd === "npm install -g --allow-scripts=audit-tools audit-tools@0.52.1") stdout = "";
    else if (["audit-code", "remediate-code"].some((bin) => command === globalBin(bin))) {
      const bin = command.replace(/\\/g, "/").split("/").at(-1)?.replace(/\.cmd$/, "");
      stdout = args[0] === "--version" ? "0.52.1" : `Usage: ${bin} [options] [command]`;
      if (bin === fixture.badBin && args[0] === fixture.badFlag) stdout = fixture.badOutput;
    }
    else if (/^(audit-code|remediate-code) --(?:version|help)$/.test(cmd)) {
      // Healthy PATH shadows must not mask a broken just-installed global bin.
      stdout = args[0] === "--version" ? "0.52.1" : `Usage: ${command} [options]`;
    }
    else throw new Error(`unexpected external action: ${cmd}`);
    return { status: 0, stdout, stderr: "" };
  },
}));

function globalBin(bin: string) {
  return join("/global", ...(process.platform === "win32" ? [] : ["bin"]), `${bin}${process.platform === "win32" ? ".cmd" : ""}`);
}

const { main } = await import("../../scripts/release-and-publish.mjs");
beforeEach(() => {
  fixture.calls.length = 0;
  fixture.head = fixture.tagHead = "a".repeat(40);
  fixture.registryMisses = 0;
  fixture.badBin = fixture.badFlag = fixture.badOutput = "";
  fixture.journal = {
    schema: "release-journal/v1alpha1", tag: "v0.52.1", version: "0.52.1", commit: fixture.head,
    phases: { "bump+tag": {}, "push-branch": {}, "tag+release": { tagPushedAtMs: 1 }, "await-ci-complete": { conclusion: "success" } },
  };
});
afterEach(() => vi.useRealTimers());

test("main resumes a post-bump registry timeout without another version, tag, push or release", async () => {
  await main();
  expect(fixture.calls).toContain("npm view audit-tools@0.52.1 version");
  expect(fixture.calls).toContain(`${globalBin("remediate-code").replace(/\.cmd$/, "")} --version`);
  expect(fixture.calls).not.toContain("remediate-code --version");
  expect(fixture.calls).not.toContain("audit-code --version");
  expect(fixture.calls.some((cmd) => /npm version|git (tag|push|commit)|gh release create|verify:checks/.test(cmd))).toBe(false);
  expect(fixture.journal.phases).toHaveProperty("reinstall+smoke");
});

test("main keeps observing the same version beyond the old two-minute propagation deadline", async () => {
  vi.useFakeTimers();
  fixture.registryMisses = 30;
  const outcome = main().then(() => null, (error: unknown) => error);
  await vi.runAllTimersAsync();
  expect(await outcome).toBeNull();
  expect(fixture.calls.filter((cmd) => cmd === "npm view audit-tools@0.52.1 version")).toHaveLength(31);
});

test.each(["missing", "mismatched"])("main refuses a %s release identity without starting another release", async (kind) => {
  if (kind === "missing") fixture.tagHead = "";
  else fixture.tagHead = "b".repeat(40);
  await expect(main()).rejects.toThrow(/Cannot resume/);
  expect(fixture.calls.some((cmd) => /npm version|git (tag|push|commit)|gh release create|verify:checks|npm view/.test(cmd))).toBe(false);
});

// A failed landing (a red check, a timeout, a moved main) left the bump commit
// and its local tag, and nothing published. Re-running resumes at the landing:
// the same commit lands through its pull request, then the tag and the release
// follow — with no second bump, version or pre-tag gate.
test("main resumes an unfinished landing: the recorded bump commit lands, then the tag and the release", async () => {
  fixture.journal.phases = { "bump+tag": {} };
  await main();
  const sha = fixture.head;
  const landMain = fixture.calls.indexOf(`git push origin ${sha}:refs/heads/main`);
  const tagPush = fixture.calls.indexOf("git push origin v0.52.1");
  expect(fixture.calls).toContain(`git push origin ${sha}:refs/heads/release/v0.52.1`);
  expect(landMain).toBeGreaterThan(-1);
  expect(tagPush).toBeGreaterThan(landMain);
  expect(fixture.calls.some((cmd) => cmd.startsWith("gh release create v0.52.1"))).toBe(true);
  expect(fixture.calls.some((cmd) => /npm version|git (tag|commit)|verify:checks|actions\/runs\?head_sha=/.test(cmd))).toBe(false);
  expect(fixture.journal.phases).toHaveProperty("land");
  expect(fixture.journal.phases).toHaveProperty("tag+release");
  expect(fixture.journal.phases).toHaveProperty("reinstall+smoke");
  // The landing branch goes last, after GitHub reports its pull request merged.
  expect(fixture.calls.indexOf("git push origin --delete release/v0.52.1")).toBeGreaterThan(tagPush);
});

// The landing succeeded and the tag push or the release then failed: a resume
// must not land again (the merged pull request and its deleted branch would make
// `gh pr create` refuse) — it goes straight to the tag and the release.
test("main resumes after a recorded landing without landing again", async () => {
  fixture.journal.phases = { "bump+tag": {}, land: { pullRequest: "https://github.com/test/repo/pull/9" } };
  await main();
  expect(fixture.calls.some((cmd) => /refs\/heads\/(main|release\/)|gh pr create|gh pr list|check-runs/.test(cmd))).toBe(false);
  expect(fixture.calls).toContain("git push origin v0.52.1");
  expect(fixture.journal.phases).toHaveProperty("tag+release");
});

test.each(["completed", "stale"])("main sends a %s journal through the pre-tag gate for a new release", async (kind) => {
  if (kind === "completed") {
    (fixture.journal.phases as Record<string, unknown>)["reinstall+smoke"] = {};
  } else fixture.journal.commit = "b".repeat(40);
  // The fixture deliberately refuses this external query: reaching it proves
  // a new release must pass the pre-tag gate rather than bypass it via resume.
  await expect(main()).rejects.toThrow(/Pre-tag CI-green gate/);
  expect(fixture.calls.some((cmd) => cmd.includes("actions/runs?head_sha="))).toBe(true);
  expect(fixture.calls.some((cmd) => cmd.startsWith("npm view"))).toBe(false);
});

// A zero exit code is not proof that a globally installed shim executed its CLI.
test.each(["audit-code", "remediate-code"])("main refuses silent or stale %s global bins", async (bin) => {
  fixture.badBin = bin;
  fixture.badFlag = "--version";
  for (const output of ["", "0.52.0", "version unavailable"]) {
    fixture.badOutput = output;
    await expect(main()).rejects.toThrow(/--version/);
    expect(fixture.journal.phases).not.toHaveProperty("reinstall+smoke");
  }
});

test.each(["audit-code", "remediate-code"])("main refuses empty or unrelated %s help", async (bin) => {
  fixture.badBin = bin;
  fixture.badFlag = "--help";
  for (const output of ["", "not CLI help", "Usage: another-tool [options]"]) {
    fixture.badOutput = output;
    await expect(main()).rejects.toThrow(/--help/);
    expect(fixture.journal.phases).not.toHaveProperty("reinstall+smoke");
  }
});

test("healthy PATH shadows cannot certify a silent installed global bin", async () => {
  fixture.badBin = "remediate-code";
  fixture.badFlag = "--version";
  fixture.badOutput = "";
  await expect(main()).rejects.toThrow(/remediate-code --version.*unexpected output/);
  expect(fixture.calls).not.toContain("remediate-code --version");
  expect(fixture.calls).not.toContain("audit-code --version");
  expect(fixture.journal.phases).not.toHaveProperty("reinstall+smoke");
});
