import { test, expect, vi, beforeEach } from "vitest";

// This file needs a FULLY MOCKED `node:child_process` (see
// tests/shared/allowlisted-exec-runner-internals.test.ts for the same pattern)
// so ensureCiGreenOnHeadSha / waitForReleaseRun can be driven deterministically
// instead of hitting a real `git`/`gh`. `vi.mock` is file-scoped and hoisted, so
// the module under test must be imported dynamically AFTER it is registered —
// static imports elsewhere (release-run-selector.test.ts, release-branch-gate.test.ts)
// stay real-spawn-free because they never touch this file's module registry.

type SpawnCall = { command: string; args: string[] };
type SpawnSyncResult = { error?: Error; status: number | null; stdout: string; stderr: string };

const spawnCalls: SpawnCall[] = [];
let spawnSyncHandler: (command: string, args: string[]) => SpawnSyncResult = () => ({
  status: 0,
  stdout: "",
  stderr: "",
});

vi.mock("node:child_process", () => ({
  spawnSync: (command: string, args: string[]) => {
    spawnCalls.push({ command, args });
    return spawnSyncHandler(command, args);
  },
}));

const { evaluateCiGreenForSha, ensureCiGreenOnHeadSha, waitForReleaseRun } = await import(
  "../../scripts/release-and-publish.mjs"
);

function textResult(text: string): SpawnSyncResult {
  return { status: 0, stdout: text, stderr: "" };
}

function jsonResult(payload: unknown): SpawnSyncResult {
  return { status: 0, stdout: JSON.stringify(payload), stderr: "" };
}

beforeEach(() => {
  spawnCalls.length = 0;
  spawnSyncHandler = () => ({ status: 0, stdout: "", stderr: "" });
});

// ── evaluateCiGreenForSha: pure verdict ─────────────────────────────────────

test("evaluateCiGreenForSha: green when a completed successful run exists on this SHA", () => {
  const sha = "1".repeat(40);
  const verdict = evaluateCiGreenForSha(
    [
      {
        name: "ci",
        head_sha: sha,
        status: "completed",
        conclusion: "success",
        created_at: "2026-01-01T00:00:00Z",
        html_url: "https://github.com/o/r/actions/runs/1",
      },
    ],
    { headSha: sha },
  );
  expect(verdict.ok).toBe(true);
  expect(verdict.successfulRuns).toHaveLength(1);
});

test("evaluateCiGreenForSha: red when ANY workflow's latest run on this SHA failed, even with another workflow green (reading one workflow is not reading CI)", () => {
  // Guards the exact failure mode scripts/shared/ciRedWorkflows.mjs was built
  // for (2026-07-25): `ci` green while `audit-code-test-suite` — the only
  // workflow that runs vitest — was red on the same commit.
  const sha = "2".repeat(40);
  const verdict = evaluateCiGreenForSha(
    [
      {
        name: "ci",
        head_sha: sha,
        status: "completed",
        conclusion: "success",
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        name: "audit-code-test-suite",
        head_sha: sha,
        status: "completed",
        conclusion: "failure",
        created_at: "2026-01-01T00:00:01Z",
        html_url: "https://github.com/o/r/actions/runs/2",
      },
    ],
    { headSha: sha },
  );
  expect(verdict.ok).toBe(false);
  expect(verdict.reason).toBe("red_workflows");
  expect(verdict.redWorkflows).toEqual(["audit-code-test-suite"]);
});

test("evaluateCiGreenForSha: not green when no run exists for this SHA at all", () => {
  const verdict = evaluateCiGreenForSha([], { headSha: "3".repeat(40) });
  expect(verdict.ok).toBe(false);
  expect(verdict.reason).toBe("no_successful_run");
});

test("evaluateCiGreenForSha: runs for a different SHA are ignored (defensive filter, not just the query param)", () => {
  const verdict = evaluateCiGreenForSha(
    [
      {
        name: "ci",
        head_sha: "some-other-sha",
        status: "completed",
        conclusion: "success",
        created_at: "2026-01-01T00:00:00Z",
      },
    ],
    { headSha: "4".repeat(40) },
  );
  expect(verdict.ok).toBe(false);
  expect(verdict.reason).toBe("no_successful_run");
});

test("evaluateCiGreenForSha: a cancelled-only run is neither red nor a satisfying success", () => {
  const sha = "5".repeat(40);
  const verdict = evaluateCiGreenForSha(
    [
      {
        name: "ci",
        head_sha: sha,
        status: "completed",
        conclusion: "cancelled",
        created_at: "2026-01-01T00:00:00Z",
      },
    ],
    { headSha: sha },
  );
  expect(verdict.ok).toBe(false);
  expect(verdict.reason).toBe("no_successful_run");
});

// ── ensureCiGreenOnHeadSha: the gh/git-calling wrapper ──────────────────────

test("ensureCiGreenOnHeadSha: passes on a green SHA and reports the run", async () => {
  const sha = "a".repeat(40);
  spawnSyncHandler = (command, args) => {
    if (command === "git" && args[0] === "rev-parse") return textResult(`${sha}\n`);
    if (command === "gh" && args[0] === "api") {
      expect(args[1]).toBe(`repos/o/r/actions/runs?head_sha=${sha}&per_page=100`);
      return jsonResult({
        workflow_runs: [
          {
            name: "ci",
            head_sha: sha,
            status: "completed",
            conclusion: "success",
            created_at: "2026-01-01T00:00:00Z",
            html_url: "https://github.com/o/r/actions/runs/10",
          },
        ],
      });
    }
    throw new Error(`unexpected spawnSync(${command}, ${JSON.stringify(args)})`);
  };
  const result = await ensureCiGreenOnHeadSha("o/r");
  expect(result.headSha).toBe(sha);
  expect(result.successfulRuns).toHaveLength(1);
});

test("ensureCiGreenOnHeadSha: aborts before tagging when no run exists for HEAD's SHA", async () => {
  const sha = "b".repeat(40);
  spawnSyncHandler = (command, args) => {
    if (command === "git" && args[0] === "rev-parse") return textResult(`${sha}\n`);
    if (command === "gh" && args[0] === "api") return jsonResult({ workflow_runs: [] });
    throw new Error(`unexpected spawnSync(${command}, ${JSON.stringify(args)})`);
  };
  await expect(ensureCiGreenOnHeadSha("o/r")).rejects.toThrow(/Pre-tag CI-green gate FAILED/);
});

test("ensureCiGreenOnHeadSha: aborts before tagging when the workflow's latest run on HEAD's SHA failed", async () => {
  const sha = "c".repeat(40);
  spawnSyncHandler = (command, args) => {
    if (command === "git" && args[0] === "rev-parse") return textResult(`${sha}\n`);
    if (command === "gh" && args[0] === "api") {
      return jsonResult({
        workflow_runs: [
          {
            name: "audit-code-test-suite",
            head_sha: sha,
            status: "completed",
            conclusion: "failure",
            created_at: "2026-01-01T00:00:00Z",
            html_url: "https://github.com/o/r/actions/runs/11",
          },
        ],
      });
    }
    throw new Error(`unexpected spawnSync(${command}, ${JSON.stringify(args)})`);
  };
  await expect(ensureCiGreenOnHeadSha("o/r")).rejects.toThrow(/audit-code-test-suite/);
});

test("ensureCiGreenOnHeadSha: --skip-ci-green (skip: true) bypasses the gate without querying GitHub Actions", async () => {
  const sha = "d".repeat(40);
  spawnSyncHandler = (command, args) => {
    if (command === "git" && args[0] === "rev-parse") return textResult(`${sha}\n`);
    throw new Error(`must not query GitHub when skipped: ${command} ${JSON.stringify(args)}`);
  };
  const result = await ensureCiGreenOnHeadSha("o/r", { skip: true });
  expect(result.headSha).toBe(sha);
  expect(result.skipped).toBe(true);
  expect(spawnCalls.some((c) => c.command === "gh")).toBe(false);
});

// ── waitForReleaseRun: the tag-trigger watchdog ─────────────────────────────

test("watchdog: no publish run detected within the window aborts with a trigger-failure message and never dispatches manually", async () => {
  vi.useFakeTimers();
  try {
    const tag = "v9.9.8";
    const pushedAt = Date.now();
    spawnSyncHandler = (command, args) => {
      if (command === "gh" && args[0] === "workflow") return textResult("");
      if (command === "gh" && args[0] === "api") return jsonResult({ workflow_runs: [] });
      // Any other call (e.g. `gh workflow run ...`, a manual dispatch) must never happen.
      throw new Error(`unexpected spawnSync(${command}, ${JSON.stringify(args)})`);
    };
    const promise = waitForReleaseRun("o/r", tag, {
      tagPushedAtMs: pushedAt,
      headSha: "e".repeat(40),
      detectionTimeoutMs: 60_000,
    });
    const assertion = expect(promise).rejects.toThrow(/did not trigger/i);
    await vi.advanceTimersByTimeAsync(65_000);
    await assertion;
    expect(spawnCalls.some((c) => c.args.includes("workflow_dispatch"))).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("watchdog: a publish run detected within the window resolves with the match (continues to the existing 10-minute watch)", async () => {
  vi.useFakeTimers();
  try {
    const tag = "v9.9.9";
    const sha = "f".repeat(40);
    const pushedAt = Date.now();
    let apiCalls = 0;
    spawnSyncHandler = (command, args) => {
      if (command === "gh" && args[0] === "workflow") return textResult("");
      if (command === "gh" && args[0] === "api") {
        apiCalls += 1;
        if (apiCalls < 3) return jsonResult({ workflow_runs: [] });
        return jsonResult({
          workflow_runs: [
            {
              id: 42,
              run_number: 1,
              head_branch: tag,
              display_title: tag,
              head_sha: sha,
              created_at: new Date(pushedAt + 1_000).toISOString(),
              html_url: "https://github.com/o/r/actions/runs/42",
            },
          ],
        });
      }
      throw new Error(`unexpected spawnSync(${command}, ${JSON.stringify(args)})`);
    };
    const promise = waitForReleaseRun("o/r", tag, {
      tagPushedAtMs: pushedAt,
      headSha: sha,
      detectionTimeoutMs: 60_000,
    });
    // Two 5s poll intervals elapse between the 1st (empty) and 3rd (matching) call —
    // well inside the 60s window.
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await promise;
    expect(result.id).toBe(42);
    expect(result.html_url).toBe("https://github.com/o/r/actions/runs/42");
  } finally {
    vi.useRealTimers();
  }
});
