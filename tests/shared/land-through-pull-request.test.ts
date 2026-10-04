// The one landing protocol (`scripts/shared/landThroughPullRequest.mjs`) and its
// lap CLI (`scripts/land.mjs`). Branch protection binds admins (owner decision
// 2026-10-04), so a commit reaches `main` only after its required checks ran on
// that exact commit. What must hold:
//   - the default branch is fast-forwarded to the SAME sha the checks judged,
//     and only after every required status concluded green — from the app
//     protection pins it to, or from a commit status;
//   - a red, still-pending or never-started required status leaves the default
//     branch untouched, and says which;
//   - a transient GitHub fault during the wait does not abort the landing;
//   - a commit the default branch already holds is reported landed, untouched;
//   - the landing branch is deleted only once GitHub reports the PR merged, and
//     that cleanup never fails a landing that happened;
//   - the CLI refuses before anything leaves the machine when the landed tree is
//     not what a full suite ran on.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSyncHidden } from "../helpers/spawn.mjs";
import {
  deleteLandingBranch,
  evaluateRequiredChecks,
  landThroughPullRequest,
  requiredStatusChecks,
} from "../../scripts/shared/landThroughPullRequest.mjs";

const SHA = "c".repeat(40);
const PR = "https://github.com/o/r/pull/7";
const APP = 15368;

type Call = { command: string; args: string[] };
type Answer = { status: number; stdout: string; stderr: string };
const ok = (value: unknown): Answer => ({ status: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });

/** A fake GitHub: records every call and answers each query from a script of poll answers. */
function fakeGitHub({
  checkRuns,
  statuses = [[]],
  protection,
  openPr = false,
  prStates = ["MERGED"],
  failCheckRunPolls = 0,
  alreadyLanded = false,
  refuseFastForward = false,
}: {
  checkRuns: unknown[][];
  statuses?: unknown[][];
  protection?: Answer;
  openPr?: boolean;
  prStates?: string[];
  failCheckRunPolls?: number;
  alreadyLanded?: boolean;
  refuseFastForward?: boolean;
}) {
  const calls: Call[] = [];
  let checkPoll = 0;
  let statusPoll = 0;
  let prPoll = 0;
  let failures = failCheckRunPolls;
  const pick = <T,>(list: T[], index: number) => list[Math.min(index, list.length - 1)];
  const answer = (command: string, args: string[]): Answer => {
    calls.push({ command, args });
    const joined = args.join(" ");
    if (command === "git" && args[0] === "merge-base") return { status: alreadyLanded ? 0 : 1, stdout: "", stderr: "" };
    if (command === "git" && refuseFastForward && joined === `push origin ${SHA}:refs/heads/main`) {
      return { status: 1, stdout: "", stderr: "! [rejected] main (non-fast-forward)" };
    }
    if (command === "gh" && joined.startsWith("pr list")) return ok(openPr ? [{ url: PR }] : []);
    if (command === "gh" && joined.startsWith("pr create")) return ok(`${PR}\n`);
    if (command === "gh" && joined.startsWith("pr view")) return ok({ state: pick(prStates, prPoll++) });
    if (command === "gh" && joined.includes("required_status_checks")) {
      return protection ?? ok({ checks: [{ context: "checks", app_id: APP }] });
    }
    if (command === "gh" && joined.includes("/check-runs")) {
      if (failures > 0) {
        failures -= 1;
        return { status: 1, stdout: "", stderr: "gh: HTTP 502 Bad Gateway" };
      }
      return ok({ check_runs: pick(checkRuns, checkPoll++) });
    }
    if (command === "gh" && joined.endsWith("/status")) return ok({ statuses: pick(statuses, statusPoll++) });
    return ok("");
  };
  const pushedTo = (ref: string) =>
    calls.some((c) => c.command === "git" && c.args[0] === "push" && c.args.includes(`${SHA}:refs/heads/${ref}`));
  const deleted = () => calls.some((c) => c.command === "git" && c.args.includes("--delete"));
  return { calls, answer, pushedTo, deleted };
}

function land(fake: ReturnType<typeof fakeGitHub>["answer"], { waitMs = 60_000, sha = SHA } = {}) {
  let clock = 0;
  return landThroughPullRequest({
    cwd: ".",
    repoSlug: "o/r",
    remote: "origin",
    sha,
    branch: "release/v1.2.3",
    defaultBranch: "main",
    title: "release: v1.2.3",
    body: "bump",
    waitMs,
    pollMs: 1_000,
    runCommand: fake,
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    log: () => {},
  });
}

function cleanUp(fake: ReturnType<typeof fakeGitHub>["answer"]) {
  return deleteLandingBranch({
    cwd: ".",
    repoSlug: "o/r",
    remote: "origin",
    branch: "release/v1.2.3",
    prUrl: PR,
    pollMs: 1_000,
    runCommand: fake,
    sleep: async () => {},
    log: () => {},
  });
}

const run = (name: string, status: string, conclusion: string | null, id = 1, appId = APP) => ({
  id,
  name,
  status,
  conclusion,
  app: { id: appId },
});
const CHECKS = [{ context: "checks", appId: APP }];
const LEGACY = [{ context: "ci/legacy", appId: null }];

describe("required statuses and their verdict", () => {
  it("reads both protection spellings with the pinned app, sorted and de-duplicated", () => {
    expect(
      requiredStatusChecks({ checks: [{ context: "b", app_id: 7 }, { context: "a", app_id: null }], contexts: ["b", "c"] }),
    ).toEqual([
      { context: "a", appId: null },
      { context: "b", appId: 7 },
      { context: "c", appId: null },
    ]);
    expect(requiredStatusChecks(null)).toEqual([]);
  });

  it("is green only when every required context concluded passing, judged by its latest run", () => {
    expect(evaluateRequiredChecks([run("checks", "completed", "failure", 1), run("checks", "completed", "success", 2)], [], CHECKS).state).toBe("green");
    expect(evaluateRequiredChecks([run("checks", "completed", "skipped")], [], CHECKS).state).toBe("green");
    expect(evaluateRequiredChecks([run("checks", "in_progress", null)], [], CHECKS).state).toBe("pending");
    expect(evaluateRequiredChecks([run("checks", "completed", "failure")], [], CHECKS).state).toBe("red");
    expect(evaluateRequiredChecks([], [], CHECKS)).toMatchObject({ state: "pending", unlisted: ["checks"] });
  });

  it("counts only the pinned app's runs for a pinned context", () => {
    const impostor = run("checks", "completed", "failure", 9, 1);
    expect(evaluateRequiredChecks([run("checks", "completed", "success", 1), impostor], [], CHECKS).state).toBe("green");
    expect(evaluateRequiredChecks([run("checks", "completed", "success", 9, 1)], [], CHECKS).state).toBe("pending");
  });

  it("reads a commit status for a context no app is pinned to", () => {
    expect(evaluateRequiredChecks([], [{ context: "ci/legacy", state: "success" }], LEGACY).state).toBe("green");
    expect(evaluateRequiredChecks([], [{ context: "ci/legacy", state: "pending" }], LEGACY).state).toBe("pending");
    expect(evaluateRequiredChecks([], [{ context: "ci/legacy", state: "error" }], LEGACY).failed).toEqual(["ci/legacy (error)"]);
  });
});

describe("landThroughPullRequest", () => {
  it("fast-forwards the default branch to the judged sha only after the required checks turn green", async () => {
    const github = fakeGitHub({ checkRuns: [[], [run("checks", "in_progress", null)], [run("checks", "completed", "success")]] });
    const { prUrl } = await land(github.answer);
    expect(prUrl).toBe(PR);
    const mainPush = github.calls.findIndex((c) => c.args.includes(`${SHA}:refs/heads/main`));
    const lastPoll = github.calls.map((c) => c.args.join(" ")).lastIndexOf(`api repos/o/r/commits/${SHA}/check-runs?per_page=100`);
    expect(github.pushedTo("release/v1.2.3")).toBe(true);
    expect(github.calls.some((c) => c.args.slice(0, 2).join(" ") === "pr create")).toBe(true);
    expect(github.calls.find((c) => c.args.slice(0, 2).join(" ") === "pr list")?.args).toContain("--base");
    expect(mainPush).toBeGreaterThan(lastPoll);
    // The landing ends at the fast-forward; the branch cleanup is its own step.
    expect(github.calls.at(-1)?.args).toEqual(["push", "origin", `${SHA}:refs/heads/main`]);
    expect(github.deleted()).toBe(false);
  });

  it("reports a commit the default branch already holds as landed and pushes nothing", async () => {
    const github = fakeGitHub({ checkRuns: [[]], alreadyLanded: true });
    expect(await land(github.answer)).toEqual({ prUrl: "", alreadyLanded: true });
    expect(github.calls.some((c) => c.args[0] === "push")).toBe(false);
    expect(github.calls.some((c) => c.command === "gh")).toBe(false);
  });

  it("refuses anything but a full commit id before any command runs", async () => {
    for (const sha of ["", "abc123", `${SHA}x`]) {
      const github = fakeGitHub({ checkRuns: [[]] });
      await expect(land(github.answer, { sha })).rejects.toThrow(/not a full commit id/);
      expect(github.calls).toEqual([]);
    }
  });

  it("says how to recover when the default branch moved and the fast-forward is refused", async () => {
    const github = fakeGitHub({ checkRuns: [[run("checks", "completed", "success")]], refuseFastForward: true });
    await expect(land(github.answer)).rejects.toThrow(/can never fast-forward it: rebase it[\s\S]*release again/);
  });

  it("reuses an open pull request for the same landing branch instead of opening a second", async () => {
    const github = fakeGitHub({ checkRuns: [[run("checks", "completed", "success")]], openPr: true });
    await land(github.answer);
    expect(github.calls.some((c) => c.args.slice(0, 2).join(" ") === "pr create")).toBe(false);
    expect(github.pushedTo("main")).toBe(true);
  });

  it("refuses on a red required check and never touches the default branch", async () => {
    const github = fakeGitHub({ checkRuns: [[run("checks", "completed", "failure")]] });
    await expect(land(github.answer)).rejects.toThrow(/checks \(failure\)[\s\S]*Nothing reached main/);
    expect(github.pushedTo("main")).toBe(false);
  });

  it("refuses when a required check does not conclude within the bound and names it", async () => {
    const github = fakeGitHub({ checkRuns: [[run("checks", "queued", null)]] });
    await expect(land(github.answer, { waitMs: 3_000 })).rejects.toThrow(/checks did not conclude[\s\S]*Nothing reached main/);
    expect(github.pushedTo("main")).toBe(false);
  });

  it("names a required check that never started, instead of a slow one", async () => {
    const github = fakeGitHub({ checkRuns: [[]] });
    await expect(land(github.answer, { waitMs: 3_000 })).rejects.toThrow(/No run of checks was ever listed/);
    expect(github.pushedTo("main")).toBe(false);
  });

  it("rides out transient GitHub faults during the wait", async () => {
    const github = fakeGitHub({ checkRuns: [[run("checks", "completed", "success")]], failCheckRunPolls: 3 });
    await land(github.answer);
    expect(github.pushedTo("main")).toBe(true);
  });

  it("lands at once when GitHub answers that the branch is not protected", async () => {
    const github = fakeGitHub({ checkRuns: [[]], protection: { status: 1, stdout: "", stderr: "gh: Branch not protected (HTTP 404)" } });
    await land(github.answer);
    expect(github.pushedTo("main")).toBe(true);
  });

  it("refuses a protection read that fails for any other reason, a bare 404 included", async () => {
    for (const stderr of ["gh: Bad credentials (HTTP 401)", "gh: Not Found (HTTP 404)"]) {
      const github = fakeGitHub({ checkRuns: [[]], protection: { status: 1, stdout: "", stderr } });
      await expect(land(github.answer)).rejects.toThrow(/cannot read the required status checks/);
      expect(github.pushedTo("main")).toBe(false);
    }
  });

});

describe("deleteLandingBranch", () => {
  it("deletes the landing branch only after GitHub reports the pull request merged", async () => {
    const github = fakeGitHub({ checkRuns: [[]], prStates: ["OPEN", "OPEN", "MERGED"] });
    expect(await cleanUp(github.answer)).toBe(true);
    expect(github.calls.filter((c) => c.args.slice(0, 2).join(" ") === "pr view")).toHaveLength(3);
    expect(github.calls.at(-1)?.args).toEqual(["push", "origin", "--delete", "release/v1.2.3"]);
  });

  it("reports success when GitHub already deleted the merged branch, and failure when it still exists", async () => {
    const withBranch = (lsRemoteStatus: number) => {
      const github = fakeGitHub({ checkRuns: [[]], prStates: ["MERGED"] });
      return (command: string, args: string[]): Answer => {
        if (args[0] === "push" && args.includes("--delete")) {
          return { status: 1, stdout: "", stderr: "error: unable to delete: remote ref does not exist" };
        }
        if (args[0] === "ls-remote") return { status: lsRemoteStatus, stdout: "", stderr: "" };
        return github.answer(command, args);
      };
    };
    expect(await cleanUp(withBranch(2))).toBe(true);
    expect(await cleanUp(withBranch(0))).toBe(false);
  });

  it("leaves the branch of a pull request closed without a merge", async () => {
    const github = fakeGitHub({ checkRuns: [[]], prStates: ["CLOSED"] });
    expect(await cleanUp(github.answer)).toBe(false);
    expect(github.deleted()).toBe(false);
  });

  it("never throws when GitHub cannot be read, and leaves the branch", async () => {
    const calls: Call[] = [];
    const failing = (command: string, args: string[]): Answer => {
      calls.push({ command, args });
      return { status: 1, stdout: "", stderr: "gh: HTTP 502" };
    };
    expect(await cleanUp(failing)).toBe(false);
    expect(calls.some((c) => c.args.includes("--delete"))).toBe(false);
  });
});

// The CLI's refusals all come before any push or `gh` call, so a local bare
// repository whose path contains `github.com/<owner>/<repo>.git` is a complete
// remote for them.
describe("npm run land refuses before anything leaves the machine", () => {
  let base: string;
  let clone: string;
  const LAND = resolve(import.meta.dirname, "..", "..", "scripts", "land.mjs");
  const git = (cwd: string, ...args: string[]) =>
    spawnSyncHidden("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 60_000 });
  const landIn = () =>
    spawnSyncHidden(process.execPath, [LAND], { cwd: clone, encoding: "utf8", windowsHide: true, timeout: 60_000 });

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "land-cli-"));
    const remote = join(base, "github.com", "o", "r.git");
    mkdirSync(remote, { recursive: true });
    git(remote, "init", "-q", "--bare", "-b", "main");
    clone = join(base, "clone");
    git(base, "init", "-q", "-b", "main", clone);
    for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"]]) git(clone, "config", k, v);
    writeFileSync(join(clone, "a.txt"), "one\n");
    git(clone, "add", "a.txt");
    git(clone, "commit", "-qm", "initial");
    git(clone, "remote", "add", "origin", remote.replace(/\\/g, "/"));
    git(clone, "push", "-q", "origin", "main");
    git(clone, "remote", "set-head", "origin", "main");
  });

  afterAll(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
      /* windows lock — leave it to the temp cleaner */
    }
  });

  it("refuses when HEAD already equals the remote default branch", () => {
    const r = landIn();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/nothing to land/);
  });

  it("refuses when no full-suite stamp covers HEAD's tree", () => {
    git(clone, "checkout", "-q", "-b", "claude/lap");
    writeFileSync(join(clone, "b.txt"), "two\n");
    git(clone, "add", "b.txt");
    git(clone, "commit", "-qm", "lap work");
    const r = landIn();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no full-suite green stamp/);
    expect(git(clone, "ls-remote", "origin", "refs/heads/claude/lap").stdout.trim()).toBe("");
  });

  it("refuses when the worktree has uncommitted changes", () => {
    writeFileSync(join(clone, "a.txt"), "changed\n");
    const r = landIn();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/uncommitted changes/);
    git(clone, "checkout", "--", "a.txt");
  });

  it("refuses an unknown argument instead of landing", () => {
    const r = spawnSyncHidden(process.execPath, [LAND, "--force"], { cwd: clone, encoding: "utf8", windowsHide: true, timeout: 60_000 });
    expect(r.status).toBe(2);
  });
});
