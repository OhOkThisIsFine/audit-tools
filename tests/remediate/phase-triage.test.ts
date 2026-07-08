import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runTriagePhase } from "../../src/remediate/phases/triage.js";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RemediationState } from "../../src/remediate/state/store.js";
import { makeState as makeBaseState } from "./test-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-triage");

const BASE_OPTIONS = { root: "/tmp", artifactsDir: TEST_DIR };

function makeState(items: Record<string, unknown>): RemediationState {
  return makeBaseState({ status: "triage", items });
}

function expectIsoTimestamp(value: unknown): void {
  expect(typeof value).toBe("string");
  expect(Date.parse(value as string)).not.toBeNaN();
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("runTriagePhase", () => {
  it("returns waiting_for_triage when blocked items have exhausted auto-retries and no resolution file", async () => {
    const state = makeState({
      F1: {
        finding_id: "F1",
        status: "blocked",
        failure_reason: "test",
        block_id: "B1",
        // Both retry budgets exhausted → auto-retry is skipped, so the run
        // escalates to human triage rather than re-attempting the item.
        rework_count: 99,
        infra_rework_count: 99,
        started_at: "2026-06-05T12:00:00.000Z",
        completed_at: "2026-06-05T12:01:00.000Z",
      },
    });

    const next = await runTriagePhase(state, BASE_OPTIONS);
    expect(next.status).toBe("waiting_for_triage");
  });

  it("returns closing when no blocked items", async () => {
    const state = makeState({
      F1: { finding_id: "F1", status: "resolved", block_id: "B1" },
    });

    const next = await runTriagePhase(state, BASE_OPTIONS);
    expect(next.status).toBe("closing");
  });

  it("applies ignore resolution and returns closing when no retries needed", async () => {
    const originalStartedAt = "2026-06-05T12:00:00.000Z";
    const state = makeState({
      F1: {
        finding_id: "F1",
        status: "blocked",
        failure_reason: "test",
        block_id: "B1",
        started_at: originalStartedAt,
      },
    });

    await writeFile(
      join(TEST_DIR, "triage_resolution.json"),
      JSON.stringify({
        items: [
          { finding_id: "F1", action: "ignore", rationale: "not worth fixing" },
        ],
      }),
      "utf8",
    );

    const next = await runTriagePhase(state, BASE_OPTIONS);
    expect(next.status).toBe("closing");
    expect(state.items!.F1.status).toBe("ignored");
    expect(state.items!.F1.started_at).toBe(originalStartedAt);
    expectIsoTimestamp(state.items!.F1.completed_at);
  });

  it("explicit action:ignore wins over retry-word rationale", async () => {
    // Fix: explicit `action` is authoritative; rationaleAsksForRetry is a
    // tie-breaker only when action is absent. An item with action='ignore' and
    // a deferred-sounding rationale must be ignored, not retried.
    const originalStartedAt = "2026-06-05T12:00:00.000Z";
    const state = makeState({
      F1: {
        finding_id: "F1",
        status: "blocked",
        failure_reason: "provider failed",
        block_id: "B1",
        rework_count: 2,
        started_at: originalStartedAt,
        completed_at: "2026-06-05T12:01:00.000Z",
      },
    });

    await writeFile(
      join(TEST_DIR, "triage_resolution.json"),
      JSON.stringify({
        items: [
          {
            finding_id: "F1",
            action: "ignore",
            rationale:
              "Deferred - should be retried in a dedicated pass after the prerequisite lands.",
          },
        ],
      }),
      "utf8",
    );

    const next = await runTriagePhase(state, BASE_OPTIONS);
    // action:'ignore' wins even though rationale contains retry-implying words.
    expect(next.status).toBe("closing");
    expect(state.items!.F1.status).toBe("ignored");
    // rework_count must NOT increment — item was not retried.
    expect(state.items!.F1.rework_count).toBe(2);
  });

  it("action:retry with retry-word rationale retries (action is authoritative)", async () => {
    const state = makeState({
      F1: {
        finding_id: "F1",
        status: "blocked",
        failure_reason: "test failure",
        block_id: "B1",
        started_at: "2026-06-05T12:00:00.000Z",
        completed_at: "2026-06-05T12:01:00.000Z",
      },
    });

    await writeFile(
      join(TEST_DIR, "triage_resolution.json"),
      JSON.stringify({
        items: [
          {
            finding_id: "F1",
            action: "retry",
            rationale: "deferred — will retry after prerequisite lands",
          },
        ],
      }),
      "utf8",
    );

    const next = await runTriagePhase(state, BASE_OPTIONS);
    expect(next.status).toBe("implementing");
    expect(state.items!.F1.status).toBe("pending");
    expect(state.items!.F1.rework_count).toBe(1);
  });

  it("action:retry wins over ignore-word rationale", async () => {
    const state = makeState({
      F1: {
        finding_id: "F1",
        status: "blocked",
        failure_reason: "test failure",
        block_id: "B1",
      },
    });

    await writeFile(
      join(TEST_DIR, "triage_resolution.json"),
      JSON.stringify({
        items: [
          { finding_id: "F1", action: "retry", rationale: "ignore this and move on" },
        ],
      }),
      "utf8",
    );

    const next = await runTriagePhase(state, BASE_OPTIONS);
    // action:'retry' wins even though rationale says 'ignore'.
    expect(next.status).toBe("implementing");
    expect(state.items!.F1.status).toBe("pending");
  });

  it("applies retry resolution and returns implementing", async () => {
    const originalStartedAt = "2026-06-05T12:00:00.000Z";
    const state = makeState({
      F1: {
        finding_id: "F1",
        status: "blocked",
        failure_reason: "test",
        block_id: "B1",
        started_at: originalStartedAt,
        completed_at: "2026-06-05T12:01:00.000Z",
      },
    });

    await writeFile(
      join(TEST_DIR, "triage_resolution.json"),
      JSON.stringify({
        items: [{ finding_id: "F1", action: "retry" }],
      }),
      "utf8",
    );

    const next = await runTriagePhase(state, BASE_OPTIONS);
    expect(next.status).toBe("implementing");
    expect(state.items!.F1.status).toBe("pending");
    expect(state.items!.F1.started_at).toBe(originalStartedAt);
    expect(state.items!.F1.completed_at).toBeUndefined();
  });

  it("routes through closing (not straight to complete) on halt", async () => {
    // Fix: halt must route through close so it produces a partial report with
    // user_halted marking, rather than skipping the close phase entirely.
    const state = makeState({
      F1: {
        finding_id: "F1",
        status: "blocked",
        failure_reason: "test",
        block_id: "B1",
      },
    });

    await writeFile(
      join(TEST_DIR, "triage_resolution.json"),
      JSON.stringify({
        items: [{ finding_id: "F1", action: "halt" }],
      }),
      "utf8",
    );

    const next = await runTriagePhase(state, BASE_OPTIONS);
    expect(next.status).toBe("closing");
    expect(next.closing_context).toBe("user_halted");
  });

  it("throws when items are missing from state", async () => {
    const state: RemediationState = { status: "triage" };
    await expect(runTriagePhase(state, BASE_OPTIONS)).rejects.toThrow(
      /items missing/,
    );
  });

  it("auto-retries blocked items within budget when no resolution file exists", async () => {
    const state = makeState({
      F1: {
        finding_id: "F1",
        status: "blocked",
        failure_reason: "test",
        block_id: "B1",
        started_at: "2026-06-05T12:00:00.000Z",
        completed_at: "2026-06-05T12:01:00.000Z",
      },
      F2: {
        finding_id: "F2",
        status: "blocked",
        failure_reason: "test",
        block_id: "B1",
        rework_count: 1,
        started_at: "2026-06-05T12:02:00.000Z",
        completed_at: "2026-06-05T12:03:00.000Z",
      },
    });

    // No triage_resolution.json: blocked items auto-retry within budget.
    const next = await runTriagePhase(state, BASE_OPTIONS);
    expect(next.status).toBe("implementing");
    // Every previously-blocked item is re-queued as pending.
    expect(state.items!.F1.status).toBe("pending");
    expect(state.items!.F2.status).toBe("pending");
    // rework_count is incremented (from undefined->1 and from 1->2).
    expect(state.items!.F1.rework_count).toBe(1);
    expect(state.items!.F2.rework_count).toBe(2);
    expect(state.items!.F1.started_at).toBe("2026-06-05T12:00:00.000Z");
    expect(state.items!.F2.started_at).toBe("2026-06-05T12:02:00.000Z");
    expect(state.items!.F1.completed_at).toBeUndefined();
    expect(state.items!.F2.completed_at).toBeUndefined();
  });

  it("retried items carry prior failure context", async () => {
    const state = makeState({
      F1: {
        finding_id: "F1",
        status: "blocked",
        failure_reason: "assertion failed in writeTests",
        last_successful_step: "Refactor Code",
        block_id: "B1",
      },
    });

    await writeFile(
      join(TEST_DIR, "triage_resolution.json"),
      JSON.stringify({
        items: [{ finding_id: "F1", action: "retry" }],
      }),
      "utf8",
    );

    await runTriagePhase(state, BASE_OPTIONS);
    const ctx = state.items!.F1.failure_context;
    expect(typeof ctx).toBe("string");
    expect(ctx).toContain("assertion failed in writeTests");
    expect(ctx).toContain("Refactor Code");
  });

  it("second retry overwrites failure_context with the most recent failure", async () => {
    const state = makeState({
      F1: {
        finding_id: "F1",
        status: "blocked",
        failure_reason: "second failure message",
        last_successful_step: "Write Tests",
        block_id: "B1",
        failure_context: "first failure context from prior retry",
        rework_count: 1,
      },
    });

    await writeFile(
      join(TEST_DIR, "triage_resolution.json"),
      JSON.stringify({
        items: [{ finding_id: "F1", action: "retry" }],
      }),
      "utf8",
    );

    await runTriagePhase(state, BASE_OPTIONS);
    expect(state.items!.F1.failure_context).toContain("second failure message");
    expect(state.items!.F1.failure_context).not.toBe("first failure context from prior retry");
  });

  it("infra failure increments infra_rework_count, not rework_count", async () => {
    const state = makeState({
      F1: {
        finding_id: "F1",
        status: "blocked",
        failure_reason: "quota exceeded — rate limit hit",
        block_id: "B1",
      },
    });

    await writeFile(
      join(TEST_DIR, "triage_resolution.json"),
      JSON.stringify({
        items: [{ finding_id: "F1", action: "retry" }],
      }),
      "utf8",
    );

    await runTriagePhase(state, BASE_OPTIONS);
    expect(state.items!.F1.infra_rework_count).toBe(1);
    expect(state.items!.F1.rework_count ?? 0).toBe(0);
  });

  it("contract failure increments rework_count, not infra_rework_count", async () => {
    const state = makeState({
      F1: {
        finding_id: "F1",
        status: "blocked",
        failure_reason: "test assertion failed",
        block_id: "B1",
      },
    });

    await writeFile(
      join(TEST_DIR, "triage_resolution.json"),
      JSON.stringify({
        items: [{ finding_id: "F1", action: "retry" }],
      }),
      "utf8",
    );

    await runTriagePhase(state, BASE_OPTIONS);
    expect(state.items!.F1.rework_count).toBe(1);
    expect(state.items!.F1.infra_rework_count ?? 0).toBe(0);
  });

  it("infra item below infra cap is auto-retried even when rework_count >= CONTRACT cap", async () => {
    const state = makeState({
      F1: {
        finding_id: "F1",
        status: "blocked",
        failure_reason: "EPERM: file locked by another process",
        block_id: "B1",
        rework_count: 2,      // at contract cap, but failure is infra
        infra_rework_count: 1, // below infra cap (5)
      },
    });

    const next = await runTriagePhase(state, BASE_OPTIONS);
    expect(next.status).toBe("implementing");
    expect(state.items!.F1.infra_rework_count).toBe(2);
    // rework_count must not change for an infra failure
    expect(state.items!.F1.rework_count).toBe(2);
  });

  it("infra item exhausting MAX_AUTO_RETRIES_INFRA routes to human triage", async () => {
    const state = makeState({
      F1: {
        finding_id: "F1",
        status: "blocked",
        failure_reason: "provider error — quota exceeded",
        block_id: "B1",
        infra_rework_count: 5,
      },
    });

    const next = await runTriagePhase(state, BASE_OPTIONS);
    expect(next.status).toBe("waiting_for_triage");
    expect(state.items!.F1.status).toBe("blocked");
  });

  it("logs cap exhaustion distinctly from auto-retry (OBS-df30208a)", async () => {
    const errors: string[] = [];
    const logs: string[] = [];
    const origError = console.error;
    const origLog = console.log;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      const state = makeState({
        // Exhausted contract budget → must log "budget exhausted", not retry.
        EXHAUSTED: {
          finding_id: "EXHAUSTED",
          status: "blocked",
          failure_reason: "test assertion failed",
          block_id: "B1",
          rework_count: 2,
        },
        // Below budget → must log an "auto-retrying" line instead.
        RETRYABLE: {
          finding_id: "RETRYABLE",
          status: "blocked",
          failure_reason: "test assertion failed",
          block_id: "B1",
          rework_count: 0,
        },
      });
      // A retryable item exists, so the run proceeds to implementing.
      const next = await runTriagePhase(state, BASE_OPTIONS);
      expect(next.status).toBe("implementing");

      // The exhausted item is surfaced as cap-exhausted (operator-visible), and
      // the retryable item is surfaced as an auto-retry — the two are NOT
      // conflated into a single silent skip.
      expect(
        errors.some(
          (line) =>
            line.includes("EXHAUSTED") &&
            /budget exhausted/i.test(line) &&
            /2\/2/.test(line),
        ),
        `expected a cap-exhaustion log for EXHAUSTED; got: ${errors.join(" | ")}`,
      ).toBe(true);
      expect(
        logs.some(
          (line) => line.includes("RETRYABLE") && /auto-retrying/i.test(line),
        ),
        `expected an auto-retry log for RETRYABLE; got: ${logs.join(" | ")}`,
      ).toBe(true);
      // The exhausted item must remain blocked (not retried).
      expect(state.items!.EXHAUSTED.status).toBe("blocked");
      expect(state.items!.RETRYABLE.status).toBe("pending");
    } finally {
      console.error = origError;
      console.log = origLog;
    }
  });

  it("triage-outcome.json is written after consuming resolution", async () => {
    const { readFile } = await import("node:fs/promises");
    const state = makeState({
      F1: {
        finding_id: "F1",
        status: "blocked",
        failure_reason: "test failure",
        block_id: "B1",
      },
      F2: {
        finding_id: "F2",
        status: "blocked",
        failure_reason: "other failure",
        block_id: "B1",
      },
    });

    await writeFile(
      join(TEST_DIR, "triage_resolution.json"),
      JSON.stringify({
        items: [
          { finding_id: "F1", action: "retry" },
          { finding_id: "F2", action: "ignore" },
        ],
      }),
      "utf8",
    );

    await runTriagePhase(state, BASE_OPTIONS);
    const raw = await readFile(join(TEST_DIR, "triage-outcome.json"), "utf8");
    const outcome = JSON.parse(raw) as { items: { finding_id: string; action: string }[] };
    expect(outcome.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ finding_id: "F1", action: "retried" }),
        expect.objectContaining({ finding_id: "F2", action: "ignored" }),
      ]),
    );
  });

  it("triage-outcome.json is written on halt with action=stranded_to_close", async () => {
    const { readFile } = await import("node:fs/promises");
    const state = makeState({
      F1: {
        finding_id: "F1",
        status: "blocked",
        failure_reason: "test",
        block_id: "B1",
      },
    });

    await writeFile(
      join(TEST_DIR, "triage_resolution.json"),
      JSON.stringify({
        items: [{ finding_id: "F1", action: "halt" }],
      }),
      "utf8",
    );

    await runTriagePhase(state, BASE_OPTIONS);
    const raw = await readFile(join(TEST_DIR, "triage-outcome.json"), "utf8");
    const outcome = JSON.parse(raw) as { items: { finding_id: string; action: string }[] };
    expect(outcome.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ finding_id: "F1", action: "halted" }),
      ]),
    );
  });

  it("auto-retry carries failure_context on blocked items", async () => {
    const state = makeState({
      F1: {
        finding_id: "F1",
        status: "blocked",
        failure_reason: "tool crash — unexpected exit",
        last_successful_step: "Write Tests",
        block_id: "B1",
      },
    });

    await runTriagePhase(state, BASE_OPTIONS);
    const ctx = state.items!.F1.failure_context;
    expect(typeof ctx).toBe("string");
    expect(ctx).toContain("tool crash");
  });

  it("throws when triage_resolution.json fails validation", async () => {
    const state = makeState({
      F1: {
        finding_id: "F1",
        status: "blocked",
        failure_reason: "test",
        block_id: "B1",
      },
    });

    await writeFile(
      join(TEST_DIR, "triage_resolution.json"),
      JSON.stringify({
        items: [{ finding_id: "F1", action: "" }],
      }),
      "utf8",
    );

    await expect(runTriagePhase(state, BASE_OPTIONS)).rejects.toThrow(
      /Invalid triage_resolution\.json/,
    );
  });

  // ── Re-verify-before-retry: reconcile a stale/already-satisfied run ─────────
  // A lean/hand lap (or a resumed obsolete run) leaves a blocked node whose fix
  // already landed in the tree. Before retrying, the node's own
  // `targeted_commands` are re-run against the current tree; if they pass the
  // node is reconciled to resolved_no_change instead of looping through retries
  // and human triage. `exit 0`/`exit 1` are shell builtins on both cmd.exe and
  // /bin/sh; root must exist for the spawn cwd, so use TEST_DIR.
  // The reverify-before-retry path only trusts a green tree as "already
  // satisfied" if an implement WORKER actually ran and left a result file (the
  // no-worker guard — a `worker-command` no-op leaves none, and a generic
  // `build && check` would then false-resolve an un-implemented node). Every
  // reconcile test below models a node whose worker DID run (and failed), so it
  // must seed the result file the merge would have written.
  async function seedImplementResult(
    blockId: string,
    planId = "P1",
  ): Promise<void> {
    const dir = join(TEST_DIR, "runs", planId, "implement");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `implement-${blockId}.result.json`),
      JSON.stringify({ item_results: [] }),
      "utf8",
    );
  }

  function planWithBlocks(
    blocks: {
      block_id: string;
      items: string[];
      targeted_commands?: string[];
      touched_files?: string[];
    }[],
  ) {
    return {
      plan_id: "P1",
      findings: [],
      project_type: "unknown",
      candidate_closing_actions: [],
      blocks: blocks.map((b) => ({
        block_id: b.block_id,
        items: b.items,
        parallel_safe: true,
        touched_files: b.touched_files ?? [],
        ...(b.targeted_commands ? { targeted_commands: b.targeted_commands } : {}),
      })),
    };
  }

  it("re-verifies a blocked item against the tree and reconciles to resolved_no_change when satisfied (takes precedence over the retry budget)", async () => {
    const state = makeBaseState({
      status: "triage",
      plan: planWithBlocks([
        { block_id: "B1", items: ["F1"], targeted_commands: ["exit 0"] },
      ]),
      items: {
        F1: {
          finding_id: "F1",
          status: "blocked",
          failure_reason: "test assertion failed",
          block_id: "B1",
          // Budget exhausted: without re-verify this would route to human triage.
          rework_count: 99,
          infra_rework_count: 99,
        },
      },
    }) as RemediationState;
    await seedImplementResult("B1");

    const next = await runTriagePhase(state, { root: TEST_DIR, artifactsDir: TEST_DIR });
    expect(next.status).toBe("closing");
    expect(state.items!.F1.status).toBe("resolved_no_change");
    expectIsoTimestamp(state.items!.F1.completed_at);
    // Not retried: the contract retry counter must not have advanced.
    expect(state.items!.F1.rework_count).toBe(99);
  });

  it("still retries when re-verify fails (finding genuinely unsatisfied in the tree)", async () => {
    const state = makeBaseState({
      status: "triage",
      plan: planWithBlocks([
        { block_id: "B1", items: ["F1"], targeted_commands: ["exit 1"] },
      ]),
      items: {
        F1: {
          finding_id: "F1",
          status: "blocked",
          failure_reason: "test assertion failed",
          block_id: "B1",
        },
      },
    }) as RemediationState;
    await seedImplementResult("B1");

    const next = await runTriagePhase(state, { root: TEST_DIR, artifactsDir: TEST_DIR });
    expect(next.status).toBe("implementing");
    expect(state.items!.F1.status).toBe("pending");
    expect(state.items!.F1.rework_count).toBe(1);
  });

  it("does NOT reconcile to resolved_no_change when a declared deliverable is missing from the tree (even if targeted_commands pass)", async () => {
    // Deliverable-existence guard (2026-07-03): a passing targeted_command can be
    // satisfied by a SIBLING's work while THIS node's declared new-file was never
    // created. `exit 0` would otherwise reconcile it to resolved_no_change and strand
    // the never-implemented node; the missing touched_file must force a retry instead.
    const state = makeBaseState({
      status: "triage",
      plan: planWithBlocks([
        {
          block_id: "B1",
          items: ["F1"],
          targeted_commands: ["exit 0"],
          touched_files: ["scripts/remediate/never-created.mjs"],
        },
      ]),
      items: {
        F1: {
          finding_id: "F1",
          status: "blocked",
          failure_reason: "test assertion failed",
          block_id: "B1",
        },
      },
    }) as RemediationState;
    // Seed the worker result so the no-worker guard passes and the test actually
    // exercises the deliverable-existence guard (the missing touched_file), not
    // the missing result.
    await seedImplementResult("B1");

    const next = await runTriagePhase(state, { root: TEST_DIR, artifactsDir: TEST_DIR });
    expect(next.status).toBe("implementing");
    expect(state.items!.F1.status).toBe("pending");
    expect(state.items!.F1.rework_count).toBe(1);
  });

  it("does NOT reconcile to resolved_no_change when NO worker result exists, even if a generic targeted_command passes (no-worker guard)", async () => {
    // No-worker guard (2026-07-06): the 2026-07-06 max-sweep run had a
    // `worker-command` provider produce no worker results; the nodes edited
    // pre-existing files (backlog.md, dispatch.ts…) so the deliverable-existence
    // guard couldn't catch them, and their generic `build && check` verify passed
    // on the green tree → un-implemented nodes false-resolved to
    // resolved_no_change. A blocked node with NO result file on disk must route to
    // retry, never reconcile. Note: NO seedImplementResult call here — that is the
    // whole point.
    const state = makeBaseState({
      status: "triage",
      plan: planWithBlocks([
        {
          block_id: "B1",
          items: ["F1"],
          // Generic verify that passes on any green tree (the real-run culprit).
          targeted_commands: ["exit 0"],
          // Edit-node: touched path pre-exists, so the deliverable guard is inert.
          touched_files: ["docs/backlog.md"],
        },
      ]),
      items: {
        F1: {
          finding_id: "F1",
          status: "blocked",
          failure_reason:
            "Implementation worker did not produce a result file: implement-B1.result.json",
          block_id: "B1",
          rework_count: 99,
          infra_rework_count: 99,
        },
      },
    }) as RemediationState;
    // Make the touched path EXIST so the deliverable-existence guard passes —
    // isolating the no-worker guard as the only thing that can catch this node.
    await mkdir(join(TEST_DIR, "docs"), { recursive: true });
    await writeFile(join(TEST_DIR, "docs", "backlog.md"), "x", "utf8");

    const next = await runTriagePhase(state, { root: TEST_DIR, artifactsDir: TEST_DIR });
    // Budget exhausted + genuinely un-implemented → human triage, NOT closing.
    expect(next.status).toBe("waiting_for_triage");
    expect(state.items!.F1.status).toBe("blocked");
    expect(state.items!.F1.status).not.toBe("resolved_no_change");
  });

  it("reconciles only the satisfied node and routes the rest to human triage (no whole-run abandonment)", async () => {
    const state = makeBaseState({
      status: "triage",
      plan: planWithBlocks([
        { block_id: "B1", items: ["F1"], targeted_commands: ["exit 0"] },
        { block_id: "B2", items: ["F2"], targeted_commands: ["exit 1"] },
      ]),
      items: {
        // Already satisfied in the tree → reconciled, not retried.
        F1: {
          finding_id: "F1",
          status: "blocked",
          failure_reason: "test assertion failed",
          block_id: "B1",
          rework_count: 99,
        },
        // Genuinely open AND budget-exhausted → stays blocked, routes to triage.
        F2: {
          finding_id: "F2",
          status: "blocked",
          failure_reason: "test assertion failed",
          block_id: "B2",
          rework_count: 99,
        },
      },
    }) as RemediationState;
    // B1's worker ran (and failed) → its result exists, so it can reconcile.
    // B2 stays genuinely open (exit 1) and routes to triage.
    await seedImplementResult("B1");
    await seedImplementResult("B2");

    const next = await runTriagePhase(state, { root: TEST_DIR, artifactsDir: TEST_DIR });
    expect(next.status).toBe("waiting_for_triage");
    expect(state.items!.F1.status).toBe("resolved_no_change");
    expect(state.items!.F2.status).toBe("blocked");

    // The triage batch covers only the still-blocked node, not the reconciled one.
    const { readFile } = await import("node:fs/promises");
    const batch = JSON.parse(
      await readFile(join(TEST_DIR, "triage_batch.json"), "utf8"),
    ) as { items: { finding_id: string }[] };
    expect(batch.items.map((i) => i.finding_id)).toEqual(["F2"]);
  });

  it("stops auto-retrying an item that has hit the rework cap and routes to human triage", async () => {
    // Regression: a dependency-stranded item (marked blocked by handleDocumenting)
    // must not be auto-retried forever — past the cap it routes to a real triage
    // prompt instead of looping implementing->triage->implementing.
    const state = makeState({
      F1: {
        finding_id: "F1",
        status: "blocked",
        failure_reason: "dependency not satisfied",
        block_id: "B1",
        rework_count: 2,
      },
    });

    const next = await runTriagePhase(state, BASE_OPTIONS);
    expect(next.status).toBe("waiting_for_triage");
    expect(state.items!.F1.status).toBe("blocked");
  });
});
