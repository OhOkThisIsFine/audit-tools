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

  it("applies retry resolution and returns documenting", async () => {
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
    expect(next.status).toBe("documenting");
    expect(state.items!.F1.status).toBe("documented");
    expect(state.items!.F1.started_at).toBe(originalStartedAt);
    expect(state.items!.F1.completed_at).toBeUndefined();
  });

  it("returns complete instead of exiting the process on halt", async () => {
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
    expect(next.status).toBe("complete");
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
    expect(next.status).toBe("documenting");
    // Every previously-blocked item is re-queued as documented.
    expect(state.items!.F1.status).toBe("documented");
    expect(state.items!.F2.status).toBe("documented");
    // rework_count is incremented (from undefined->1 and from 1->2).
    expect(state.items!.F1.rework_count).toBe(1);
    expect(state.items!.F2.rework_count).toBe(2);
    expect(state.items!.F1.started_at).toBe("2026-06-05T12:00:00.000Z");
    expect(state.items!.F2.started_at).toBe("2026-06-05T12:02:00.000Z");
    expect(state.items!.F1.completed_at).toBeUndefined();
    expect(state.items!.F2.completed_at).toBeUndefined();
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
    // prompt instead of looping documenting->implement->triage.
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
