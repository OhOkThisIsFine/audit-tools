import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runTriagePhase } from "../src/phases/triage.js";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RemediationState } from "../src/state/store.js";
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
  it("returns waiting_for_triage when blocked items exist and no resolution file", async () => {
    const state = makeState({
      F1: {
        finding_id: "F1",
        status: "blocked",
        failure_reason: "test",
        block_id: "B1",
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

  it("auto-retries blocked items when impl_preview_acknowledged.json exists and no resolution file", async () => {
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

    // No triage_resolution.json; the user approved at preview time instead.
    await writeFile(
      join(TEST_DIR, "impl_preview_acknowledged.json"),
      JSON.stringify({ acknowledged: true }),
      "utf8",
    );

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

    await writeFile(
      join(TEST_DIR, "impl_preview_acknowledged.json"),
      JSON.stringify({ acknowledged: true }),
      "utf8",
    );

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

    await writeFile(
      join(TEST_DIR, "impl_preview_acknowledged.json"),
      JSON.stringify({ acknowledged: true }),
      "utf8",
    );

    const next = await runTriagePhase(state, BASE_OPTIONS);
    expect(next.status).toBe("waiting_for_triage");
    expect(state.items!.F1.status).toBe("blocked");
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

    await writeFile(
      join(TEST_DIR, "impl_preview_acknowledged.json"),
      JSON.stringify({ acknowledged: true }),
      "utf8",
    );

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

    await writeFile(
      join(TEST_DIR, "impl_preview_acknowledged.json"),
      JSON.stringify({ status: "confirmed" }),
      "utf8",
    );

    const next = await runTriagePhase(state, BASE_OPTIONS);
    expect(next.status).toBe("waiting_for_triage");
    expect(state.items!.F1.status).toBe("blocked");
  });
});
