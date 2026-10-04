import { REQUIRED_TEST_MESSAGE_LIMIT, runRequiredTest, type RequiredTestFailure } from "../../src/remediate/steps/dispatch/requiredTests.js";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupHostHandoffFixtures, fixture, boundState, resultFor, writeResult, landA, HANG_SCRIPT, HANG_TEST, HANG_SCRIPT_SOURCE, VERBOSE_RED_SCRIPT, VERBOSE_RED_TEST, VERBOSE_RED_SCRIPT_SOURCE, OVERFLOW_SCRIPT, OVERFLOW_TEST, OVERFLOW_SCRIPT_SOURCE, recoveryOptions, orphanBaselineAndLand } from "./helpers/hostHandoffCorroborationFixture.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ingestRemediationHostResults } from "../../src/remediate/steps/dispatch/hostHandoff.js";


afterEach(cleanupHostHandoffFixtures);

describe("remediation host handoff repository corroboration", () => {
  // ── A HUNG REQUIRED TEST IS ITS OWN OUTCOME, NOT AN UNLABELLED RED ────────

  /**
   * An isolated cwd for the runner tests, deliberately NOT registered for
   * cleanup: a timed-out or buffer-killed child holds its cwd open until Windows
   * releases the handle, so deleting the directory is a race (EBUSY). Isolated
   * per test rather than the shared `tmpdir()` so two runner tests cannot
   * interact through a directory every process on the box also uses.
   */
  async function runnerCwd(): Promise<string> {
    return mkdtemp(join(tmpdir(), "remediation-required-test-"));
  }

  it("classifies a required test that exceeds its deadline, with its output captured", async () => {
    const cwd = await runnerCwd();
    // The deadline is a parameter for exactly this reason: an outcome only
    // reachable by waiting ten real minutes is an outcome nothing ever tests.
    // The margin is generous on purpose — the assertion below needs the child to
    // have STARTED and printed, and a node cold start on a loaded Windows box is
    // not a fixed cost. The child hangs for a minute, so the deadline is the only
    // thing that ends it and the test still finishes in seconds.
    const hanging = `node -e "console.log('starting'); setTimeout(function () {}, 60000)"`;
    const timedOut = await runRequiredTest(cwd, hanging, 5_000);
    expect(timedOut).not.toBeNull();
    expect(timedOut!.outcome).toBe("timed_out");
    expect(timedOut!.command).toBe(hanging);
    // Captured, not discarded: the old path ran with stdio "ignore" and
    // returned a joined string, so an operator had nothing to read.
    expect(timedOut!.stdout).toContain("starting");

    const failed = await runRequiredTest(
      cwd,
      `node -e "console.error('boom'); process.exit(3)"`,
    );
    expect(failed).not.toBeNull();
    expect(failed!.outcome).toBe("failed");
    expect(failed!.exit_code).toBe(3);
    expect(failed!.stderr).toContain("boom");

    expect(await runRequiredTest(cwd, `node -e "process.exit(0)"`)).toBeNull();
  });

  it("classifies a command that outran the capture buffer as overflow, never as a hang", async () => {
    const cwd = await runnerCwd();
    // A child that INTENDS a clean exit after printing more than the 8MiB capture
    // buffer holds — the kill lands first. node terminates it with SIGTERM and
    // reports ENOBUFS, and a discriminator that read `signal !== null` as "the
    // deadline fired" called that a timeout, i.e. an environment hang, for a
    // command whose only sin was being verbose.
    //
    // NO `process.exit(0)`, deliberately: on linux a pipe write is ASYNCHRONOUS
    // and `process.exit` truncates whatever is still pending, so the child emitted
    // far less than the cap and exited 0 for real — green was the correct reading
    // of what it actually did, and the fixture never overflowed there at all. Left
    // to exit naturally, node stays alive until the stream drains, so all 9MiB
    // must cross the pipe and the cap is hit on every platform. (win32 never
    // showed this: its pipe writes are synchronous, so the full 9MiB landed either
    // way.)
    const overflowing =
      `node -e "process.stdout.write('x'.repeat(9 * 1024 * 1024))"`;
    const overflowed = await runRequiredTest(cwd, overflowing);
    expect(overflowed).not.toBeNull();
    expect(overflowed!.outcome).toBe("output_overflow");
    expect(overflowed!.exit_code).toBeNull();
    expect(overflowed!.command).toBe(overflowing);
  });

  // ── OBL-impl-block-1296-inv-2: A REQUIRED TEST MUST NOT STARVE LIVENESS ───

  it("lets timers fire while a required test runs, so a held lock's heartbeat survives it", async () => {
    // Ingestion runs with the remediation state lock HELD, and every liveness
    // heartbeat in the process — the advance heartbeat, each held lock's mtime
    // heartbeat — is a timer on this event loop. A synchronous child blocks
    // that loop for the whole suite, so a LIVE lock stops being refreshed,
    // reads as stale, and is stolen mid-ingest. Awaiting is what prevents it.
    //
    // Cheapest honest pin: count timer ticks across a ~1s child. Revert
    // `runRequiredTest` to `spawnSync` and the count is 0.
    const cwd = await runnerCwd();
    let ticks = 0;
    const heartbeat = setInterval(() => {
      ticks += 1;
    }, 50);
    let failure: RequiredTestFailure | null;
    try {
      failure = await runRequiredTest(
        cwd,
        `node -e "setTimeout(function () {}, 1000)"`,
      );
    } finally {
      clearInterval(heartbeat);
    }
    // The child really ran and really passed, so the tick count is about a real
    // ~1s spawn rather than an early refusal.
    expect(failure).toBeNull();
    expect(ticks).toBeGreaterThan(0);
  });

  it("reports a hung required test under its own issue code, distinguishable without parsing prose", async () => {
    // The timeout verdict is produced by the MINTER, not hand-built: the table
    // is the minter's brand, so the only way to get one is to actually run a
    // command that outlives a deadline. That is also why the runner takes a
    // deadline — this test would otherwise wait ten real minutes. The child
    // prints before hanging, so the captured output is asserted too.
    const value = await fixture({ requiredTest: HANG_TEST });
    await writeFile(join(value.root, HANG_SCRIPT), HANG_SCRIPT_SOURCE, "utf8");
    const landed = await orphanBaselineAndLand(value);
    await writeResult(value, resultFor(value, landed));

    const refused = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
      recovery: await recoveryOptions(value, boundState(value), 5_000),
    });
    if (refused === "unsupported_retired_state") throw new Error("state rejected");
    expect(refused.accepted_count).toBe(0);
    // The OUTCOME FIELD alone tells a hang from a genuine red.
    expect(refused.issues.map((issue) => issue.code)).toEqual([
      "required_test_timed_out",
    ]);
    expect(refused.issues[0]!.message).toContain("timed out");
    expect(refused.issues[0]!.message).toContain("partial suite output");
  }, 60_000);

  it("reports a genuine red under required_test_failed, not the timeout code", async () => {
    const value = await fixture({ requiredTest: 'node -e "process.exit(1)"' });
    const after = await landA(value);
    await writeResult(value, resultFor(value, after));

    const refused = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
    });
    if (refused === "unsupported_retired_state") throw new Error("state rejected");
    expect(refused.issues.map((issue) => issue.code)).toEqual([
      "required_test_failed",
    ]);
    expect(refused.issues[0]!.message).toContain("exit 1");
  });

  it("bounds the inline excerpt in a required-test failure message", async () => {
    // The issue message is a HOST-FACING delivery: it is rendered into the step
    // prompt an operator reads. `tail` bounds each STREAM, but the excerpt is
    // bounded only per-stream — the message joins every failing command, and a
    // suite that prints near the capture limit on many commands makes the
    // message grow with the number of failures. The bound must hold for the
    // MESSAGE, so a long run cannot push the rest of the step out of view.
    const value = await fixture({
      // THREE verbose failing commands on ONE block: `required_tests` is the
      // block's `targeted_commands`, so the count is a property of the plan and
      // the joined message is ~3x one excerpt — past the bound, while a single
      // excerpt (4071 chars) sits comfortably under it.
      requiredTests: [VERBOSE_RED_TEST, VERBOSE_RED_TEST, VERBOSE_RED_TEST],
    });
    await writeFile(
      join(value.root, VERBOSE_RED_SCRIPT),
      VERBOSE_RED_SCRIPT_SOURCE,
      "utf8",
    );
    const after = await landA(value);
    await writeResult(value, resultFor(value, after));

    const refused = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
    });
    if (refused === "unsupported_retired_state") throw new Error("state rejected");
    const issue = refused.issues.find(
      (entry) => entry.code === "required_test_failed",
    );
    expect(issue, `expected a required_test_failed issue: ${JSON.stringify(refused.issues.map((i) => i.code))}`).toBeDefined();
    const message = issue!.message;
    expect(
      message.length,
      "the failure message must be bounded even when several suites print to the capture cap",
    ).toBeLessThanOrEqual(REQUIRED_TEST_MESSAGE_LIMIT);
    // Bounded by TRUNCATION, never by dropping the verdict: the operator must
    // still be able to tell WHICH command failed and that output was elided.
    expect(message).toContain("exit 1");
    expect(message).toMatch(/excerpt truncated/iu);
    expect(
      message.endsWith("]"),
      "the marker replaces the tail rather than overrunning the bound",
    ).toBe(true);
    // Bounded by TRUNCATION, never by dropping the verdict: the operator must
    // still be able to tell WHICH command failed and that it printed more.
    expect(message).toContain("exit 1");
    expect(message).toMatch(/excerpt truncated/iu);
    expect(
      message.endsWith("]"),
      "the marker replaces the tail rather than overrunning it",
    ).toBe(true);
  });

  it("reports a buffer-killed required test under its own code, calling the verdict unknown", async () => {
    // A child that INTENDS a clean exit after printing more than the capture
    // buffer holds, so node kills it and reports ENOBUFS. The verdict is
    // produced by the real minter (the table is its brand), so this is the
    // runner's own classification rather than a hand-written record — which is
    // the property that makes the `output_overflow` arm trustworthy at all.
    const value = await fixture({ requiredTest: OVERFLOW_TEST });
    await writeFile(
      join(value.root, OVERFLOW_SCRIPT),
      OVERFLOW_SCRIPT_SOURCE,
      "utf8",
    );
    const landed = await orphanBaselineAndLand(value);
    await writeResult(value, resultFor(value, landed));

    const refused = await ingestRemediationHostResults({
      root: value.root,
      artifactsDir: value.artifactsDir,
      runId: value.runId,
      state: boundState(value),
      recovery: await recoveryOptions(value),
    });
    if (refused === "unsupported_retired_state") throw new Error("state rejected");
    expect(refused.accepted_count).toBe(0);
    // Its OWN code — under required_test_failed the operator would read a
    // capture-cap kill as the work being wrong. And the message claims UNKNOWN,
    // not innocence: a child killed mid-stream may equally have been heading for
    // a non-zero exit, so the honest report is that the run never found out.
    expect(refused.issues.map((issue) => issue.code)).toEqual([
      "required_test_output_overflow",
    ]);
    expect(refused.issues[0]!.message).toMatch(/UNKNOWN/u);
  });
});
