import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateStore, RemediationState, LOCK_TIMEOUT_MS } from "../src/state/store.js";
import { STALE_LOCK_MS } from "@audit-tools/shared";
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

  it("LOCK_TIMEOUT_MS stays below the shared stale-lock threshold (no boundary race)", () => {
    // Derived programmatically as STALE_LOCK_MS - margin. A held-but-fresh lock must
    // time out before it could be reclaimed as stale, otherwise the timeout is a
    // load-sensitive race. This guards the relationship if either value changes.
    expect(LOCK_TIMEOUT_MS).toBeGreaterThan(0);
    expect(LOCK_TIMEOUT_MS).toBeLessThan(STALE_LOCK_MS);
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
      "implementing",
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

  it("times out and throws when lock file is fresh and never released", async () => {
    // Write a fresh lock with a valid token (shared fileLock uses mtime-based staleness)
    const lockFile = join(TEST_DIR, "state.lock");
    await writeFile(lockFile, "some-token-that-will-not-be-released", "utf8");

    const store = new StateStore(TEST_DIR);
    await expect(store.saveState({ status: "pending" })).rejects.toThrow(
      /Timed out acquiring lock/i,
    );
  }, 35_000);

  it("reclaims a stale lock file (mtime-based staleness)", async () => {
    const lockFile = join(TEST_DIR, "state.lock");
    await writeFile(lockFile, "stale-token", "utf8");
    const staleDate = new Date(Date.now() - 60_000);
    await utimes(lockFile, staleDate, staleDate);

    const store = new StateStore(TEST_DIR);
    await store.saveState({ status: "pending" });

    const loaded = await store.loadState();
    expect(loaded?.status).toBe("pending");
  });

  it("second save succeeds after first save releases lock", async () => {
    const store = new StateStore(TEST_DIR);
    await store.saveState({ status: "planning" });
    await store.saveState({ status: "implementing" });
    const loaded = await store.loadState();
    expect(loaded?.status).toBe("implementing");
  });

  it("cleans up temp files when temp write fails", async () => {
    const store = new StateStore(TEST_DIR, {
      writeFile: async () => {
        throw new Error("simulated write failure");
      },
    });

    await expect(store.saveState({ status: "pending" })).rejects.toThrow(
      /simulated write failure/,
    );

    const files = await readdir(TEST_DIR);
    expect(files.filter((file) => file.endsWith(".tmp"))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// INV-remediate-state-01: loadState schema validation
// ---------------------------------------------------------------------------

describe("StateStore.loadState — INV-remediate-state-01: schema validation", () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("throws on corrupt JSON (not parseable)", async () => {
    await writeFile(join(TEST_DIR, "state.json"), "NOT JSON {{{", "utf8");
    const store = new StateStore(TEST_DIR);
    await expect(store.loadState()).rejects.toThrow();
  });

  it("throws when status field is missing", async () => {
    await writeFile(
      join(TEST_DIR, "state.json"),
      JSON.stringify({ plan: null }),
      "utf8",
    );
    const store = new StateStore(TEST_DIR);
    await expect(store.loadState()).rejects.toThrow(/schema validation/i);
  });

  it("throws when status is an unknown value", async () => {
    await writeFile(
      join(TEST_DIR, "state.json"),
      JSON.stringify({ status: "unknown_future_state" }),
      "utf8",
    );
    const store = new StateStore(TEST_DIR);
    await expect(store.loadState()).rejects.toThrow(/schema validation/i);
  });

  it("succeeds for a valid state", async () => {
    const store = new StateStore(TEST_DIR);
    await store.saveState({ status: "implementing" });
    const loaded = await store.loadState();
    expect(loaded?.status).toBe("implementing");
  });
});

// ---------------------------------------------------------------------------
// INV-remediate-state-02: mutate() — TOCTOU-safe read-modify-write
// ---------------------------------------------------------------------------

describe("StateStore.mutate — INV-remediate-state-02: no lost updates under concurrent transitions", () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("mutate on empty store receives null and saves first state", async () => {
    const store = new StateStore(TEST_DIR);
    const next = await store.mutate(async (current) => {
      expect(current).toBeNull();
      return { status: "planning" };
    });
    expect(next.status).toBe("planning");
    const loaded = await store.loadState();
    expect(loaded?.status).toBe("planning");
  });

  it("mutate receives the current state written by saveState", async () => {
    const store = new StateStore(TEST_DIR);
    await store.saveState({ status: "planning" });
    await store.mutate(async (current) => {
      expect(current?.status).toBe("planning");
      return { status: "implementing" };
    });
    const loaded = await store.loadState();
    expect(loaded?.status).toBe("implementing");
  });

  it("sequential mutate calls each observe the prior transition's result", async () => {
    const store = new StateStore(TEST_DIR);
    const transitions: string[] = [];

    await store.mutate(async (current) => {
      transitions.push(`${String(current?.status)} -> planning`);
      return { status: "planning" };
    });
    await store.mutate(async (current) => {
      transitions.push(`${String(current?.status)} -> implementing`);
      return { status: "implementing" };
    });
    await store.mutate(async (current) => {
      transitions.push(`${String(current?.status)} -> closing`);
      return { status: "closing" };
    });

    expect(transitions[0]).toBe("undefined -> planning");
    expect(transitions[1]).toBe("planning -> implementing");
    expect(transitions[2]).toBe("implementing -> closing");

    const loaded = await store.loadState();
    expect(loaded?.status).toBe("closing");
  });

  it("concurrent mutate calls serialize — second observes first's write (no lost update)", async () => {
    const store = new StateStore(TEST_DIR);
    // Seed initial state
    await store.saveState({ status: "pending", step_count: 0 });

    // Fire 5 concurrent mutations that each increment step_count
    const concurrency = 5;
    const seen: Array<number | undefined> = [];
    await Promise.all(
      Array.from({ length: concurrency }, () =>
        store.mutate(async (current) => {
          const prev = current?.step_count ?? 0;
          seen.push(prev);
          return { ...(current ?? { status: "pending" }), step_count: prev + 1 };
        }),
      ),
    );

    const loaded = await store.loadState();
    // All 5 mutations ran; final step_count must equal concurrency (no lost update)
    expect(loaded?.step_count).toBe(concurrency);
    // Every observed value should be distinct (each transition saw the prior's result)
    expect(new Set(seen).size).toBe(concurrency);
  });
});
