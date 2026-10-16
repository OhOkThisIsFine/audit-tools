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
  forbidStatuses = false,
  failStatusPolls = 0,
  checkAnswers,
  statusAnswers,
}: {
  checkRuns: unknown[][];
  checkAnswers?: Answer[];
  statusAnswers?: Answer[];
  statuses?: unknown[][];
  protection?: Answer;
  openPr?: boolean;
  prStates?: string[];
  failCheckRunPolls?: number;
  alreadyLanded?: boolean;
  refuseFastForward?: boolean;
  forbidStatuses?: boolean;
  failStatusPolls?: number;
}) {
  const calls: Call[] = [];
  let checkPoll = 0;
  let statusPoll = 0;
  let prPoll = 0;
  let failures = failCheckRunPolls;
  let statusFailures = failStatusPolls;
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
      if (checkAnswers) return pick(checkAnswers, checkPoll++);
      const rows = pick(checkRuns, checkPoll++);
      return ok([{ total_count: rows.length, check_runs: rows }]);
    }
    if (command === "gh" && joined.includes("/status?per_page=100")) {
      if (forbidStatuses) throw new Error("unusable commit-status endpoint was invoked");
      if (statusFailures > 0) {
        statusFailures -= 1;
        return { status: 1, stdout: "", stderr: "gh: HTTP 502 Bad Gateway" };
      }
      if (statusAnswers) return pick(statusAnswers, statusPoll++);
      const rows = pick(statuses, statusPoll++);
      return ok([{ sha: SHA, total_count: rows.length, statuses: rows }]);
    }
    return ok("");
  };
  const pushedTo = (ref: string) =>
    calls.some((c) => c.command === "git" && c.args[0] === "push" && c.args.includes(`${SHA}:refs/heads/${ref}`));
  const deleted = () => calls.some((c) => c.command === "git" && c.args.includes("--delete"));
  return { calls, answer, pushedTo, deleted };
}

function land(fake: ReturnType<typeof fakeGitHub>["answer"], { waitMs = 60_000, sha = SHA, pollMs = 1_000 } = {}) {
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
    pollMs,
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
  const statusCalls = (github: ReturnType<typeof fakeGitHub>) =>
    github.calls.filter((call) => call.command === "gh" && call.args[1]?.includes("/status?per_page=100"));
  const checkCalls = (github: ReturnType<typeof fakeGitHub>) =>
    github.calls.filter((call) => call.command === "gh" && call.args[1]?.includes("/check-runs"));

  it.each([
    { name: "green", runs: [run("checks", "completed", "success")], error: null },
    { name: "red", runs: [run("checks", "completed", "failure")], error: /checks \(failure\)/ },
    { name: "pending", runs: [run("checks", "in_progress", null)], error: /did not conclude/ },
    { name: "missing", runs: [], error: /No run of checks was ever listed/ },
    { name: "wrong app", runs: [run("checks", "completed", "success", 1, APP + 1)], error: /No run of checks was ever listed/ },
  ])("never queries unusable statuses for app-pinned $name checks", async ({ runs, error }) => {
    const github = fakeGitHub({ checkRuns: [runs], forbidStatuses: true });
    const landing = land(github.answer, { waitMs: 2_000 });
    if (error) await expect(landing).rejects.toThrow(error);
    else await landing;
    expect(statusCalls(github)).toHaveLength(0);
    expect(checkCalls(github).length).toBeGreaterThan(0);
    expect(github.pushedTo("main")).toBe(error === null);
  });

  it("keeps every check-run observation across a 30-minute app-pinned pending wait", async () => {
    const github = fakeGitHub({ checkRuns: [[run("checks", "queued", null)]], forbidStatuses: true });
    await expect(land(github.answer, { waitMs: 30 * 60_000, pollMs: 5_000 })).rejects.toThrow(/did not conclude/);
    expect(checkCalls(github)).toHaveLength(361);
    expect(statusCalls(github)).toHaveLength(0);
    expect(github.pushedTo("main")).toBe(false);
    expect(checkCalls(github).every((call) => call.args[1] === `repos/o/r/commits/${SHA}/check-runs?per_page=100`)).toBe(true);
  });

  it.each([
    { name: "legacy contexts", protection: { contexts: ["ci/legacy"] }, runs: [] },
    { name: "explicitly unpinned", protection: { checks: [{ context: "ci/legacy", app_id: null }] }, runs: [] },
    { name: "mixed", protection: { checks: [{ context: "checks", app_id: APP }], contexts: ["ci/legacy"] }, runs: [run("checks", "completed", "success")] },
  ])("still polls statuses for $name requirements", async ({ protection, runs }) => {
    const github = fakeGitHub({
      protection: ok(protection), checkRuns: [runs],
      statuses: [[{ context: "ci/legacy", state: "pending" }], [{ context: "ci/legacy", state: "success" }]],
    });
    await land(github.answer);
    expect(statusCalls(github)).toHaveLength(2);
    expect(checkCalls(github)).toHaveLength(2);
    expect(statusCalls(github).every((call) => call.args[1] === `repos/o/r/commits/${SHA}/status?per_page=100`)).toBe(true);
    expect(github.pushedTo("main")).toBe(true);
  });

  it("keeps the legacy status fallback on later polls after a matching check run disappears", async () => {
    const github = fakeGitHub({
      protection: ok({ contexts: ["ci/legacy"] }),
      checkRuns: [[run("ci/legacy", "in_progress", null)], []],
      statuses: [[{ context: "ci/legacy", state: "success" }]],
    });
    await land(github.answer);
    expect(statusCalls(github)).toHaveLength(2);
    expect(checkCalls(github)).toHaveLength(2);
    expect(github.pushedTo("main")).toBe(true);
  });

  it("retries needed status queries and refuses a red legacy status", async () => {
    const github = fakeGitHub({
      protection: ok({ contexts: ["ci/legacy"] }), checkRuns: [[]], failStatusPolls: 3,
      statuses: [[{ context: "ci/legacy", state: "error" }]],
    });
    await expect(land(github.answer)).rejects.toThrow(/ci\/legacy \(error\)/);
    expect(statusCalls(github)).toHaveLength(4);
    expect(github.pushedTo("main")).toBe(false);
  });

  it.each(["check-run", "commit-status"])("retains the consecutive failure bound for needed %s queries", async (endpoint) => {
    const github = fakeGitHub({
      protection: ok({ contexts: ["ci/legacy"] }), checkRuns: [[]],
      failCheckRunPolls: endpoint === "check-run" ? 10 : 0,
      failStatusPolls: endpoint === "commit-status" ? 10 : 0,
    });
    await expect(land(github.answer)).rejects.toThrow(/collection[\s\S]*failed 10 times in a row/);
    expect(endpoint === "check-run" ? checkCalls(github) : statusCalls(github)).toHaveLength(10);
    expect(github.pushedTo("main")).toBe(false);
  });

  it("skips statuses but retains check-run polling with no requirements", async () => {
    const github = fakeGitHub({ protection: ok({ checks: [], contexts: [] }), checkRuns: [[]], forbidStatuses: true });
    await land(github.answer);
    expect(statusCalls(github)).toHaveLength(0);
    expect(checkCalls(github)).toHaveLength(1);
    expect(github.pushedTo("main")).toBe(true);
  });

  it("fast-forwards the default branch to the judged sha only after the required checks turn green", async () => {
    const github = fakeGitHub({ checkRuns: [[], [run("checks", "in_progress", null)], [run("checks", "completed", "success")]] });
    const { prUrl } = await land(github.answer);
    expect(prUrl).toBe(PR);
    const mainPush = github.calls.findIndex((c) => c.args.includes(`${SHA}:refs/heads/main`));
    const lastPoll = github.calls.map((c) => c.args.join(" ")).lastIndexOf(`api repos/o/r/commits/${SHA}/check-runs?per_page=100 --paginate --slurp`);
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

describe("complete paginated evidence", () => {
  const pages = (field: "check_runs" | "statuses", chunks: unknown[][]) => chunks.map((rows) => ({
    total_count: chunks.reduce((n, chunk) => n + chunk.length, 0), [field]: rows,
    ...(field === "statuses" ? { sha: SHA } : {}),
  }));
  const checkCalls = (github: ReturnType<typeof fakeGitHub>) => github.calls.filter((c) => c.args[1]?.includes("/check-runs"));
  const noise = (n: number) => Array.from({ length: n }, (_, i) => run(`other-${i}`, "completed", "success", 1000 + i));
  const green = run("checks", "completed", "success");
  const partial: Answer = { status: 1, stdout: JSON.stringify(pages("check_runs", [[green]])), stderr: "later page failed" };

  it("requests every page and lands a required check beyond 100 unrelated runs", async () => {
    const firstPage = noise(100);
    const envelopes = pages("check_runs", [firstPage, [green]]);
    const github = fakeGitHub({ checkRuns: [], checkAnswers: [ok(envelopes)] });
    const transport = (command: string, args: string[]): Answer => {
      const answer = github.answer(command, args);
      // Baseline receives its original object response, with only page one.
      // The red proves missing evidence, rather than changed envelope syntax.
      if (command === "gh" && args[1]?.includes("/check-runs") &&
          (!args.includes("--paginate") || !args.includes("--slurp"))) {
        return ok({ total_count: 101, check_runs: firstPage });
      }
      return answer;
    };
    await land(transport, { waitMs: 0 });
    expect(checkCalls(github)[0]?.args).toEqual(["api", `repos/o/r/commits/${SHA}/check-runs?per_page=100`, "--paginate", "--slurp"]);
    expect(github.pushedTo("main")).toBe(true);
  });

  it("collects a required legacy context beyond 100 statuses", async () => {
    const github = fakeGitHub({ checkRuns: [[]], protection: ok({ contexts: ["ci/legacy"] }), statusAnswers: [ok(pages("statuses", [
      Array.from({ length: 100 }, (_, i) => ({ context: `other-${i}`, state: "success" })), [{ context: "ci/legacy", state: "success" }],
    ]))] });
    await land(github.answer);
    expect(github.calls.find((c) => c.args[1]?.includes("/status?"))?.args).toEqual(["api", `repos/o/r/commits/${SHA}/status?per_page=100`, "--paginate", "--slurp"]);
    expect(github.pushedTo("main")).toBe(true);
  });

  // The oracle deliberately flattens fixture pages itself; it does not use the
  // production collector. Vary placement, boundaries, app identity and reruns.
  for (const size of [0, 99, 100, 101]) {
    for (const reverse of [false, true]) {
      for (const outcome of ["success", "failure", null]) {
        it(`matches the all-page oracle at ${size}, reverse=${reverse}, outcome=${outcome}`, async () => {
          const newer = run("checks", outcome === null ? "in_progress" : "completed", outcome, 3);
          const chunks = [[...noise(size), green], [newer, run("checks", "completed", "success", 999, APP + 1)]];
          if (reverse) chunks.reverse();
          const expected = evaluateRequiredChecks(chunks.flat(), [], CHECKS).state;
          const github = fakeGitHub({ checkRuns: [], checkAnswers: [ok(pages("check_runs", chunks))], forbidStatuses: true });
          if (expected === "green") await land(github.answer, { waitMs: 0 });
          else await expect(land(github.answer, { waitMs: 0 })).rejects.toThrow(expected === "red" ? /checks \(failure\)/ : /did not conclude/);
          expect(github.pushedTo("main")).toBe(expected === "green");
        });
      }
    }
  }

  it.each([false, true])("accepts newer success over older failure across pages, reversed=%s", async (reverse) => {
    const chunks = [[run("checks", "completed", "failure", 1)], [run("checks", "completed", "success", 2)]];
    if (reverse) chunks.reverse();
    const github = fakeGitHub({ checkRuns: [], checkAnswers: [ok(pages("check_runs", chunks))] });
    expect(evaluateRequiredChecks(chunks.flat(), [], CHECKS).state).toBe("green");
    await land(github.answer);
    expect(github.pushedTo("main")).toBe(true);
  });

  it("keeps a valid pinned page-two result despite a higher-ID wrong-app failure", async () => {
    const github = fakeGitHub({ checkRuns: [], checkAnswers: [ok(pages("check_runs", [[run("checks", "completed", "failure", 99, APP + 1)], [green]]))] });
    await land(github.answer);
    expect(github.pushedTo("main")).toBe(true);
  });

  it.each(["success", "failure", null])("preserves an unpinned check with a valid null app: %s", async (conclusion) => {
    const check = { ...run("checks", conclusion === null ? "in_progress" : "completed", conclusion), app: null };
    const github = fakeGitHub({ checkRuns: [[check]], statuses: [[{ context: "checks", state: "success" }]],
      protection: ok({ contexts: ["checks"] }) });
    if (conclusion === "success") await land(github.answer, { waitMs: 0 });
    else await expect(land(github.answer, { waitMs: 0 })).rejects.toThrow(conclusion === "failure" ? /checks \(failure\)/ : /did not conclude/);
    expect(github.pushedTo("main")).toBe(conclusion === "success");
  });

  it("a valid null app on an unrelated check does not block pinned evidence", async () => {
    const unrelated = { ...run("unrelated", "completed", "success", 2), app: null };
    const github = fakeGitHub({ checkRuns: [[unrelated, green]], forbidStatuses: true });
    await land(github.answer, { waitMs: 0 });
    expect(github.pushedTo("main")).toBe(true);
  });

  it("a valid null app cannot satisfy a pinned requirement or trigger status queries", async () => {
    const github = fakeGitHub({ checkRuns: [[{ ...green, app: null }]], forbidStatuses: true });
    await expect(land(github.answer, { waitMs: 0 })).rejects.toThrow(/did not conclude/);
    expect(github.calls.filter((call) => call.args[1]?.includes("/status?"))).toHaveLength(0);
    expect(github.pushedTo("main")).toBe(false);
  });

  it("gives a page-two check precedence over green legacy status with mixed requirements", async () => {
    const checks = [[green], [run("ci/legacy", "completed", "failure", 2)]];
    const statuses = [[{ context: "ci/legacy", state: "success" }]];
    const required = [...CHECKS, ...LEGACY];
    expect(evaluateRequiredChecks(checks.flat(), statuses.flat(), required).state).toBe("red");
    const github = fakeGitHub({ checkRuns: [], checkAnswers: [ok(pages("check_runs", checks))], statuses,
      protection: ok({ checks: [{ context: "checks", app_id: APP }], contexts: ["ci/legacy"] }) });
    await expect(land(github.answer)).rejects.toThrow(/ci\/legacy \(failure\)/);
    expect(github.pushedTo("main")).toBe(false);
  });

  for (const size of [99, 100, 101]) {
    for (const reverse of [false, true]) {
      for (const state of ["success", "failure", "pending"]) {
        it(`matches mixed legacy fallback oracle at ${size}, reverse=${reverse}, state=${state}`, async () => {
          const checkPages = [[green, run("checks", "completed", "failure", 99, APP + 1)]];
          const statusPages = [
            Array.from({ length: size }, (_, i) => ({ context: `other-${i}`, state: "success" })),
            [{ context: "ci/legacy", state }],
          ];
          if (reverse) statusPages.reverse();
          const expected = evaluateRequiredChecks(checkPages.flat(), statusPages.flat(), [...CHECKS, ...LEGACY]).state;
          const github = fakeGitHub({ checkRuns: [], checkAnswers: [ok(pages("check_runs", checkPages))],
            statusAnswers: [ok(pages("statuses", statusPages))],
            protection: ok({ checks: [{ context: "checks", app_id: APP }], contexts: ["ci/legacy"] }) });
          if (expected === "green") await land(github.answer, { waitMs: 0 });
          else await expect(land(github.answer, { waitMs: 0 })).rejects.toThrow(expected === "red" ? /ci\/legacy \(failure\)/ : /did not conclude/);
          expect(checkCalls(github)).toHaveLength(1);
          expect(github.calls.filter((call) => call.args[1]?.includes("/status?"))).toHaveLength(1);
          expect(github.pushedTo("main")).toBe(expected === "green");
        });
      }
    }
  }

  it.each(["success", "failure"])("uses legacy %s when its matching check disappears in a later complete round", async (state) => {
    const github = fakeGitHub({
      protection: ok({ checks: [{ context: "checks", app_id: APP }, { context: "other", app_id: APP }], contexts: ["ci/legacy"] }),
      checkRuns: [
        [green, run("ci/legacy", "completed", "success", 2), run("other", "in_progress", null, 3)],
        [green, run("other", "completed", "success", 4)],
      ],
      statuses: [[{ context: "ci/legacy", state: "failure" }], [{ context: "ci/legacy", state }]],
    });
    if (state === "success") await land(github.answer);
    else await expect(land(github.answer)).rejects.toThrow(/ci\/legacy \(failure\)/);
    expect(checkCalls(github)).toHaveLength(2);
    expect(github.calls.filter((call) => call.args[1]?.includes("/status?"))).toHaveLength(2);
    expect(github.pushedTo("main")).toBe(state === "success");
  });

  it("discards failed partial stdout, retries the collection and can recover", async () => {
    const github = fakeGitHub({ checkRuns: [], checkAnswers: [partial, ok(pages("check_runs", [[green]]))] });
    await land(github.answer);
    expect(checkCalls(github)).toHaveLength(2);
    expect(github.pushedTo("main")).toBe(true);
  });

  it.each(["checks", "statuses"])("bounds whole-round failures and preserves backoff for %s", async (endpoint) => {
    const github = fakeGitHub({ checkRuns: [[green]],
      ...(endpoint === "checks" ? { checkAnswers: [partial] } : { protection: ok({ contexts: ["checks"] }), statusAnswers: [partial] }) });
    const sleeps: number[] = [];
    await expect(landThroughPullRequest({ cwd: ".", repoSlug: "o/r", remote: "origin", sha: SHA, branch: "land/test", defaultBranch: "main", title: "test", body: "test", waitMs: 60_000, pollMs: 1000,
      runCommand: (command: string, args: string[]) => {
        if (checkCalls(github).length > 10) throw new Error("test: collection budget exceeded");
        return github.answer(command, args);
      }, sleep: async (ms: number) => { sleeps.push(ms); }, now: () => 0, log: () => {},
    })).rejects.toThrow(/failed 10 times in a row/);
    expect(checkCalls(github)).toHaveLength(10);
    expect(sleeps).toEqual([5000, 10000, 15000, 20000, 25000, 30000, 30000, 30000, 30000]);
    expect(github.pushedTo("main")).toBe(false);
  });

  it("restarts checks after failed statuses and observes the newer failure", async () => {
    const github = fakeGitHub({ checkRuns: [[green], [run("checks", "completed", "failure", 2)]],
      protection: ok({ contexts: ["checks"] }), statusAnswers: [partial, ok(pages("statuses", [[]]))] });
    await expect(land(github.answer)).rejects.toThrow(/checks \(failure\)/);
    expect(checkCalls(github)).toHaveLength(2);
    expect(github.pushedTo("main")).toBe(false);
  });

  it.each(["disappears", "fails"])("does not retain a prior green when it %s while another context was pending", async (change) => {
    const done = run("other", "completed", "success", 4);
    const github = fakeGitHub({ protection: ok({ checks: [{ context: "checks", app_id: APP }, { context: "other", app_id: APP }] }),
      checkRuns: [[green, run("other", "in_progress", null, 2)], change === "fails" ? [run("checks", "completed", "failure", 3), done] : [done]] });
    await expect(land(github.answer, { waitMs: 1000 })).rejects.toThrow(change === "fails" ? /checks \(failure\)/ : /did not conclude/);
    expect(github.pushedTo("main")).toBe(false);
  });

  const malformed: [string, unknown][] = [
    ["truncated JSON", "[{"], ["null", null], ["empty outer", []], ["absent arrays", [{ total_count: 0 }]],
    ["larger total", [{ total_count: 2, check_runs: [green] }]], ["smaller total", [{ total_count: 0, check_runs: [green] }]],
    ["negative total", [{ total_count: -1, check_runs: [] }]], ["fractional total", [{ total_count: 0.5, check_runs: [] }]],
    ["duplicate pages", [{ total_count: 2, check_runs: [green] }, { total_count: 2, check_runs: [green] }]],
    ["changing totals", [{ total_count: 1, check_runs: [green] }, { total_count: 2, check_runs: [] }]],
    ["malformed later array", [{ total_count: 1, check_runs: [green] }, { total_count: 1, check_runs: null }]],
    ["malformed later record", [{ total_count: 2, check_runs: [green] }, { total_count: 2, check_runs: [null] }]],
    ["missing run identity", [{ total_count: 1, check_runs: [{ ...green, id: undefined }] }]],
    ["missing app identity", [{ total_count: 1, check_runs: [{ ...green, app: undefined }] }]],
    ["missing conclusion", [{ total_count: 1, check_runs: [{ ...green, conclusion: null }] }]],
  ];
  it.each(malformed)("refuses %s without touching main", async (_name, value) => {
    const github = fakeGitHub({ checkRuns: [], checkAnswers: [ok(value)] });
    await expect(land(github.answer)).rejects.toThrow(/collection[\s\S]*failed 10 times in a row[\s\S]*pull\/7/);
    expect(github.pushedTo("main")).toBe(false);
  });

  it.each([
    [{ total_count: 0, sha: "d".repeat(40), statuses: [] }],
    [{ total_count: 1, sha: SHA, statuses: [{ context: "checks" }] }],
    [{ total_count: 2, sha: SHA, statuses: [{ context: "checks", state: "success" }] }, { total_count: 2, sha: SHA, statuses: [{ context: "checks", state: "failure" }] }],
  ])("refuses malformed or conflicting status collections", async (...envelopes) => {
    const github = fakeGitHub({ checkRuns: [[green]], protection: ok({ contexts: ["checks"] }), statusAnswers: [ok(envelopes)] });
    await expect(land(github.answer)).rejects.toThrow(/failed 10 times in a row/);
    expect(github.pushedTo("main")).toBe(false);
  });

  it.each([0, 100])("accepts a complete terminal collection of %s records", async (size) => {
    const github = fakeGitHub({ checkRuns: [], checkAnswers: [ok(pages("check_runs", [noise(size)]))], protection: ok({ contexts: [] }) });
    await land(github.answer);
    expect(checkCalls(github)).toHaveLength(1);
    expect(github.pushedTo("main")).toBe(true);
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
