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

const {
  evaluateCiGreenForSha,
  classifyCiInFlight,
  ensureCiGreenOnHeadSha,
  waitForReleaseRun,
  nextVersion,
  planReleaseResume,
} = await import("../../scripts/release-and-publish.mjs");

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

// ── resumption: the bump is destructive, the observation half is not ────────

test("nextVersion: computes the version `npm version <bump>` would produce", () => {
  expect(nextVersion("0.51.7", "patch")).toBe("0.51.8");
  expect(nextVersion("0.51.7", "minor")).toBe("0.52.0");
  expect(nextVersion("0.51.7", "major")).toBe("1.0.0");
  // A prerelease or build suffix is dropped, as `npm version` drops it.
  expect(nextVersion("1.2.3-rc.1", "patch")).toBe("1.2.4");
  expect(nextVersion("1.2.3+build.4", "minor")).toBe("1.3.0");
  // An unparseable version yields null, which the resume check reads as
  // "no resume" — the safe direction, since a resume skips the bump.
  expect(nextVersion("not-a-version", "patch")).toBeNull();
  expect(nextVersion("", "patch")).toBeNull();
});

test("planReleaseResume: resumes only on the SAME tag at the SAME commit", () => {
  const sha = "a".repeat(40);
  const journal = { tag: "v0.51.8", version: "0.51.8", commit: sha };

  expect(planReleaseResume(journal, { tag: "v0.51.8", headSha: sha })).toMatchObject({
    resume: true,
    tag: "v0.51.8",
  });
});

test("planReleaseResume: a STALE journal never resumes — resuming would skip the bump and re-tag an old commit", () => {
  const sha = "a".repeat(40);
  const other = "b".repeat(40);

  // The checkout has moved since the journal was written.
  expect(
    planReleaseResume({ tag: "v0.51.8", commit: sha }, { tag: "v0.51.8", headSha: other }),
  ).toMatchObject({ resume: false });
  // The journal belongs to a different release.
  expect(
    planReleaseResume({ tag: "v0.51.7", commit: sha }, { tag: "v0.51.8", headSha: sha }),
  ).toMatchObject({ resume: false });
  // No journal at all, or no resolvable HEAD.
  expect(planReleaseResume(null, { tag: "v0.51.8", headSha: sha })).toMatchObject({ resume: false });
  expect(planReleaseResume({ tag: "v0.51.8", commit: sha }, { tag: "v0.51.8", headSha: null })).toMatchObject(
    { resume: false },
  );
  expect(
    planReleaseResume({ tag: "v0.51.8", commit: undefined }, { tag: "v0.51.8", headSha: sha }),
  ).toMatchObject({ resume: false });
});

test("planReleaseResume: every refusal states WHY, so a resume decision is never silent", () => {
  const sha = "a".repeat(40);
  const cases = [
    planReleaseResume(null, { tag: "v1.0.0", headSha: sha }),
    planReleaseResume({ tag: "v1.0.0", commit: "b".repeat(40) }, { tag: "v1.0.0", headSha: sha }),
    planReleaseResume({ tag: "v9.9.9", commit: sha }, { tag: "v1.0.0", headSha: sha }),
  ];
  for (const verdict of cases) {
    expect(verdict.resume).toBe(false);
    expect(typeof verdict.reason).toBe("string");
    expect((verdict.reason ?? "").length).toBeGreaterThan(0);
  }
});

// ── classifyCiInFlight: the two not-yet-green states ────────────────────────

test("classifyCiInFlight: an in_progress run for this SHA is a WAIT, not an absence", () => {
  const sha = "6".repeat(40);
  const verdict = classifyCiInFlight(
    [
      { name: "ci", head_sha: sha, status: "in_progress", conclusion: null },
      { name: "audit-code-test-suite", head_sha: sha, status: "queued", conclusion: null },
    ],
    { headSha: sha },
  );
  expect(verdict.waiting).toBe(true);
  expect(verdict.workflows).toEqual(["audit-code-test-suite", "ci"]);
});

test("classifyCiInFlight: completed runs are not in flight, whichever way they concluded", () => {
  const sha = "7".repeat(40);
  const verdict = classifyCiInFlight(
    [
      { name: "ci", head_sha: sha, status: "completed", conclusion: "success" },
      { name: "audit-code-test-suite", head_sha: sha, status: "completed", conclusion: "failure" },
    ],
    { headSha: sha },
  );
  expect(verdict.waiting).toBe(false);
  expect(verdict.inFlight).toEqual([]);
});

test("classifyCiInFlight: runs for a different SHA do not count as in flight for this one", () => {
  const verdict = classifyCiInFlight(
    [{ name: "ci", head_sha: "other", status: "in_progress" }],
    { headSha: "8".repeat(40) },
  );
  expect(verdict.waiting).toBe(false);
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

test("ensureCiGreenOnHeadSha: an ABSENT run refuses after exactly one query — it does not wait for a run that will never appear", async () => {
  const sha = "1".repeat(40).replace(/1/g, "9");
  let apiCalls = 0;
  spawnSyncHandler = (command, args) => {
    if (command === "git" && args[0] === "rev-parse") return textResult(`${sha}\n`);
    if (command === "gh" && args[0] === "api") {
      apiCalls += 1;
      return jsonResult({ workflow_runs: [] });
    }
    throw new Error(`unexpected spawnSync(${command}, ${JSON.stringify(args)})`);
  };
  await expect(ensureCiGreenOnHeadSha("o/r", { waitMs: 60_000, pollMs: 1 })).rejects.toThrow(
    /no completed run with conclusion=success/,
  );
  expect(apiCalls, "no run at all is not a wait state").toBe(1);
});

test("ensureCiGreenOnHeadSha: watches an IN-FLIGHT run to its green conclusion instead of refusing (2026-08-29 friction)", async () => {
  const sha = "e".repeat(40);
  let apiCalls = 0;
  spawnSyncHandler = (command, args) => {
    if (command === "git" && args[0] === "rev-parse") return textResult(`${sha}\n`);
    if (command === "gh" && args[0] === "api") {
      apiCalls += 1;
      if (apiCalls < 3) {
        return jsonResult({
          workflow_runs: [
            { name: "ci", head_sha: sha, status: "in_progress", conclusion: null },
          ],
        });
      }
      return jsonResult({
        workflow_runs: [
          {
            name: "ci",
            head_sha: sha,
            status: "completed",
            conclusion: "success",
            html_url: "https://github.com/o/r/actions/runs/77",
          },
        ],
      });
    }
    throw new Error(`unexpected spawnSync(${command}, ${JSON.stringify(args)})`);
  };
  const result = await ensureCiGreenOnHeadSha("o/r", { waitMs: 60_000, pollMs: 1 });
  expect(apiCalls, "the gate must re-poll rather than refuse").toBeGreaterThanOrEqual(3);
  expect(result.headSha).toBe(sha);
  expect(result.successfulRuns).toHaveLength(1);
  expect(spawnCalls.some((c) => c.args.includes("workflow_dispatch"))).toBe(false);
});

test("ensureCiGreenOnHeadSha: an in-flight run that concludes RED refuses with the workflow named", async () => {
  const sha = "f".repeat(40).replace(/f/g, "a");
  let apiCalls = 0;
  spawnSyncHandler = (command, args) => {
    if (command === "git" && args[0] === "rev-parse") return textResult(`${sha}\n`);
    if (command === "gh" && args[0] === "api") {
      apiCalls += 1;
      if (apiCalls < 2) {
        return jsonResult({
          workflow_runs: [{ name: "ci", head_sha: sha, status: "in_progress", conclusion: null }],
        });
      }
      return jsonResult({
        workflow_runs: [
          {
            name: "audit-code-test-suite",
            head_sha: sha,
            status: "completed",
            conclusion: "failure",
            // A completed run carries no signal without a parseable created_at
            // (latestFailedWorkflows skips it), so this is part of the fixture,
            // not decoration — without it the row reads as "no run".
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      });
    }
    throw new Error(`unexpected spawnSync(${command}, ${JSON.stringify(args)})`);
  };
  await expect(ensureCiGreenOnHeadSha("o/r", { waitMs: 60_000, pollMs: 1 })).rejects.toThrow(
    /audit-code-test-suite/,
  );
});

test("ensureCiGreenOnHeadSha: an in-flight run that never concludes is a WAIT TIMEOUT, never reported as a missing run", async () => {
  const sha = "d".repeat(40).replace(/d/g, "b");
  spawnSyncHandler = (command, args) => {
    if (command === "git" && args[0] === "rev-parse") return textResult(`${sha}\n`);
    if (command === "gh" && args[0] === "api") {
      return jsonResult({
        workflow_runs: [{ name: "ci", head_sha: sha, status: "in_progress", conclusion: null }],
      });
    }
    throw new Error(`unexpected spawnSync(${command}, ${JSON.stringify(args)})`);
  };
  const promise = ensureCiGreenOnHeadSha("o/r", { waitMs: 0, pollMs: 1 });
  await expect(promise).rejects.toThrow(/still in flight/);
  await expect(promise).rejects.not.toThrow(/no completed run with conclusion=success/);
  await expect(promise).rejects.toThrow(/nothing has been tagged or pushed yet/);
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

test("watchdog: the default detection window outlasts a GitHub release-event delivery delay (~13 min for v0.49.0), and the do-not-re-dispatch note is said up front", async () => {
  // The 2026-08-26 defect: a 10-minute timeout was SHORTER than a delivery delay
  // the script then misread as "no run matched", so the operator dispatched
  // recovery runs by hand — and the delayed canonical run arrived and published,
  // parking each duplicate as a permanent red that had to be deleted. A slow
  // event must read as slow for the WHOLE window, not only in the exit message.
  vi.useFakeTimers();
  try {
    const tag = "v9.9.10";
    const logged: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    try {
      spawnSyncHandler = (command, args) => {
        if (command === "gh" && args[0] === "workflow") return textResult("");
        if (command === "gh" && args[0] === "api") return jsonResult({ workflow_runs: [] });
        throw new Error(`unexpected spawnSync(${command}, ${JSON.stringify(args)})`);
      };
      let settled = false;
      const promise = waitForReleaseRun("o/r", tag, {
        tagPushedAtMs: Date.now(),
        headSha: "1".repeat(40),
      });
      // The settle flag is the DISCRIMINATING half: a heartbeat line is printed
      // inside the first minute under any window, so asserting on the log alone
      // would pass with a 60s watchdog too.
      promise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const assertion = expect(promise).rejects.toThrow(/did not trigger/i);

      // 15 minutes in — past the ~13-minute v0.49.0 delay — the watchdog must
      // still be WAITING, not already refused.
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      expect(settled, "a 15-minute delay must still be a wait, not a timeout").toBe(false);
      expect(
        logged.some((line) => /still waiting for the publish run/.test(line)),
        "the heartbeat must say it is still waiting, not that it found nothing",
      ).toBe(true);
      expect(logged.some((line) => /Do NOT re-dispatch a publish run by hand/.test(line))).toBe(true);

      // It does still terminate: the wait is bounded, not unbounded.
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
      await assertion;
      expect(settled).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  } finally {
    vi.useRealTimers();
  }
});
