import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runTriagePhase } from "../src/phases/triage.js";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RemediationState } from "../src/state/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-triage");

const BASE_OPTIONS = { root: "/tmp", artifactsDir: TEST_DIR };

function makeState(items: Record<string, any>): RemediationState {
  return {
    status: "triage",
    plan: {
      plan_id: "P1",
      findings: [],
      blocks: [],
      project_type: "unknown",
      candidate_closing_actions: [],
    },
    items,
  } as any;
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
        items: [
          { finding_id: "F1", action: "ignore", rationale: "not worth fixing" },
        ],
      }),
      "utf8",
    );

    const next = await runTriagePhase(state, BASE_OPTIONS);
    expect(next.status).toBe("closing");
    expect(state.items!.F1.status).toBe("ignored");
  });

  it("applies retry resolution and returns documenting", async () => {
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
        items: [{ finding_id: "F1", action: "retry" }],
      }),
      "utf8",
    );

    const next = await runTriagePhase(state, BASE_OPTIONS);
    expect(next.status).toBe("documenting");
    expect(state.items!.F1.status).toBe("documented");
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
      },
      F2: {
        finding_id: "F2",
        status: "blocked",
        failure_reason: "test",
        block_id: "B1",
        rework_count: 1,
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
  });
});
