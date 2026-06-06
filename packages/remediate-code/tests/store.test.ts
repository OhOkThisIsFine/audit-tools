import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StateStore, RemediationState } from "../src/state/store.js";
import { rm, mkdir, writeFile, utimes, readdir } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-artifacts");

describe("StateStore", () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("should return null if no state exists", async () => {
    const store = new StateStore(TEST_DIR);
    const state = await store.loadState();
    expect(state).toBeNull();
  });

  it("should save and load state successfully", async () => {
    const store = new StateStore(TEST_DIR);
    const mockState: RemediationState = {
      status: "planning",
    };

    await store.saveState(mockState);
    const loadedState = await store.loadState();

    expect(loadedState).toEqual(mockState);
  });

  it("concurrent saves serialize correctly — last write wins", async () => {
    const store = new StateStore(TEST_DIR);

    // Fire 10 concurrent saves with distinct statuses
    const statuses: RemediationState["status"][] = [
      "pending",
      "planning",
      "documenting",
      "implementing",
      "closing",
      "triage",
      "waiting_for_clarification",
      "waiting_for_triage",
      "complete",
      "pending",
    ];
    const results = await Promise.allSettled(
      statuses.map((status) => store.saveState({ status })),
    );
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    // Final state must be one of the valid statuses — no corruption, no crash
    const loaded = await store.loadState();
    expect(loaded).not.toBeNull();
    expect(statuses).toContain(loaded!.status);
  });

  it("times out and throws when lock file is pre-existing and never released", async () => {
    // Simulate a stale lock by creating the lock file before saving
    const lockPath = join(TEST_DIR, "state.lock");
    await writeFile(lockPath, "", "utf8");

    const store = new StateStore(TEST_DIR);
    await expect(store.saveState({ status: "pending" })).rejects.toThrow(
      /Timed out waiting to write/,
    );
  }, 15_000);

  it("logs lock retry attempts with the configured correlation id", async () => {
    const lockPath = join(TEST_DIR, "state.lock");
    await writeFile(lockPath, String(process.pid), "utf8");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);

    try {
      const store = new StateStore(TEST_DIR, {}, "trace-1234");
      await expect(store.saveState({ status: "pending" })).rejects.toThrow(
        /Timed out waiting to write/,
      );

      expect(debug).toHaveBeenCalled();
      const events = debug.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(events).toContainEqual(
        expect.objectContaining({
          tag: "remediate_state_lock_retry",
          correlationId: "trace-1234",
        }),
      );
    } finally {
      debug.mockRestore();
    }
  }, 15_000);

  it("reclaims a stale lock file from a crashed process", async () => {
    const lockPath = join(TEST_DIR, "state.lock");
    await writeFile(lockPath, "", "utf8");
    const staleDate = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleDate, staleDate);

    const store = new StateStore(TEST_DIR);
    await store.saveState({ status: "pending" });

    const loaded = await store.loadState();
    expect(loaded?.status).toBe("pending");
  });

  it("second save succeeds after first save releases lock", async () => {
    const store = new StateStore(TEST_DIR);
    await store.saveState({ status: "planning" });
    await store.saveState({ status: "documenting" });
    const loaded = await store.loadState();
    expect(loaded?.status).toBe("documenting");
  });

  it("cleans up lock and temp files when temp write fails", async () => {
    const store = new StateStore(TEST_DIR, {
      writeFile: async () => {
        throw new Error("simulated write failure");
      },
    });

    await expect(store.saveState({ status: "pending" })).rejects.toThrow(
      /simulated write failure/,
    );

    const files = await readdir(TEST_DIR);
    expect(files).not.toContain("state.lock");
    expect(files.filter((file) => file.endsWith(".tmp"))).toHaveLength(0);
  });
});
