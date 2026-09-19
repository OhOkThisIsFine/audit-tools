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
    else if (cmd === "npm root -g") stdout = "/global";
    else if (cmd === "npm install -g --allow-scripts=audit-tools audit-tools") stdout = "";
    else if (/^(audit-code|remediate-code) --version$/.test(cmd)) stdout = "0.52.1";
    else throw new Error(`unexpected external action: ${cmd}`);
    return { status: 0, stdout, stderr: "" };
  },
}));

const { main } = await import("../../scripts/release-and-publish.mjs");
beforeEach(() => {
  fixture.calls.length = 0;
  fixture.head = fixture.tagHead = "a".repeat(40);
  fixture.registryMisses = 0;
  fixture.journal = {
    schema: "release-journal/v1alpha1", tag: "v0.52.1", version: "0.52.1", commit: fixture.head,
    phases: { "bump+tag": {}, "push-branch": {}, "tag+release": { tagPushedAtMs: 1 }, "await-ci-complete": { conclusion: "success" } },
  };
});
afterEach(() => vi.useRealTimers());

test("main resumes a post-bump registry timeout without another version, tag, push or release", async () => {
  await main();
  expect(fixture.calls).toContain("npm view audit-tools@0.52.1 version");
  expect(fixture.calls).toContain("remediate-code --version");
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

test.each(["missing", "mismatched", "unfinished creation"])("main refuses a %s release identity without starting another release", async (kind) => {
  if (kind === "missing") fixture.tagHead = "";
  else if (kind === "mismatched") fixture.tagHead = "b".repeat(40);
  else fixture.journal.phases = { "bump+tag": {}, "push-branch": {} };
  await expect(main()).rejects.toThrow(/Cannot resume/);
  expect(fixture.calls.some((cmd) => /npm version|git (tag|push|commit)|gh release create|verify:checks|npm view/.test(cmd))).toBe(false);
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
