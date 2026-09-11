import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  StateStore,
  RemediationState,
  LOCK_TIMEOUT_MS,
  REMEDIATION_STATE_CONTRACT_VERSION,
} from "../../src/remediate/state/store.js";
import { SKIP_WRITE, STALE_LOCK_MS, SchemaVersionMismatchError } from "audit-tools/shared";
import { rm, mkdir, writeFile, utimes, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scratchDir } from "../helpers/scratch.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = scratchDir(".test-artifacts");

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

    // The store stamps the contract version on every write, so the round trip
    // returns what was SAVED plus that one field. Asserted as an explicit shape
    // rather than a superset match: the point is that the store adds exactly
    // this and nothing else, and that a state written before the field existed
    // still loads (see the version-policy block below).
    expect(loadedState).toEqual({
      status: "planning",
      contract_version: REMEDIATION_STATE_CONTRACT_VERSION,
    });
    expect(loadedState!.status).toBe(mockState.status);
  });

  it("concurrent saves serialize correctly — last write wins", async () => {
    const store = new StateStore(TEST_DIR);

    // Fire 10 concurrent saves with distinct statuses. This exercises LOCK
    // serialization, so the fixtures use only completeness-FREE statuses —
    // implementing/triage/closing states now require a persisted plan/items
    // (INV-RSM-STATE-COMPLETE) and would fail load validation as bare shells.
    const statuses: RemediationState["status"][] = [
      "pending",
      "planning",
      "waiting_for_clarification",
      "waiting_for_clarification",
      "complete",
      "planning",
      "waiting_for_clarification",
      "planning",
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
    await store.saveState({ status: "waiting_for_clarification" });
    const loaded = await store.loadState();
    expect(loaded?.status).toBe("waiting_for_clarification");
  });

  it("leaves no .tmp residue after a successful save", async () => {
    // The durable write now routes through the shared atomic writer
    // (writeJsonFile: temp + atomic rename, cleaned up in its own finally), so
    // the store carries no inline writer/fileOps seam. The temp-cleanup-on-write-
    // failure guarantee is asserted at its single source in
    // shared/tests/io-json-retry.test.mjs. Here we just confirm the store leaves
    // no temp residue behind on the happy path.
    const store = new StateStore(TEST_DIR);
    await store.saveState({ status: "pending" });
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
    await store.saveState({ status: "waiting_for_clarification" });
    const loaded = await store.loadState();
    expect(loaded?.status).toBe("waiting_for_clarification");
  });
});

// ---------------------------------------------------------------------------
// INV-remediate-state-01, the WRITE half: the store's own hook refuses a state
// the read gate would reject.
//
// Before this, validation ran on ONE side of the round trip. `loadState`
// validated; `saveState`/`mutate` wrote whatever they were handed. A state
// constructed in memory — which is every transition — therefore reached disk
// unvalidated, and the failure surfaced on the NEXT read as a refusal to load a
// file the tool itself had just written. The gate and the writer now share one
// validator, so an inadmissible state cannot get to disk in the first place.
// ---------------------------------------------------------------------------

describe("StateStore — the write hook refuses what the read gate would reject", () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("saveState refuses a state whose status is outside the vocabulary", async () => {
    const store = new StateStore(TEST_DIR);
    await expect(
      // Through `unknown`: the point is a value the TYPE cannot express but a
      // hand-edited or older file can, which is precisely what the runtime gate
      // exists for. A direct cast no longer overlaps the discriminated union.
      store.saveState({
        status: "a_status_no_release_declares",
      } as unknown as RemediationState),
    ).rejects.toThrow(/refusing to write state\.json.*Unknown status/is);

    // ...and nothing landed: the refusal is before the write, not a rollback.
    await expect(stat(join(TEST_DIR, "state.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("saveState refuses a status-conditional state missing what its decision path reads", async () => {
    // INV-RSM-STATE-COMPLETE, enforced at the WRITE too: an `implementing`
    // state with no plan/items is exactly the shell the load gate rejects.
    const store = new StateStore(TEST_DIR);
    await expect(
      store.saveState({ status: "implementing" }),
    ).rejects.toThrow(/refusing to write state\.json.*requires a persisted plan/is);
  });

  it("mutate refuses an inadmissible transition and leaves the prior state intact", async () => {
    const store = new StateStore(TEST_DIR);
    await store.saveState({ status: "planning" });

    await expect(
      store.mutate(
        async () =>
          ({ status: "not_a_status" }) as unknown as RemediationState,
      ),
    ).rejects.toThrow(/refusing to write state\.json/is);

    const loaded = await store.loadState();
    expect(loaded?.status, "the refused transition did not disturb the file").toBe(
      "planning",
    );
  });
});

// ---------------------------------------------------------------------------
// The state's contract version, and how an in-flight state without one reads.
//
// State is COSTLY / AUTHORED (shared/io/schemaVersion.ts): a run's plan, item
// ledger and recorded acceptances cannot be rebuilt from anything else on disk,
// so the policy for a mismatch is THROW. ABSENT is deliberately not a mismatch
// — every run already in flight when the field was introduced has a state.json
// without it, and refusing those would destroy exactly the runs the field
// exists to protect.
// ---------------------------------------------------------------------------

describe("StateStore — the state contract version", () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("stamps the current version on every state it writes", async () => {
    const store = new StateStore(TEST_DIR);
    await store.saveState({ status: "pending" });

    const onDisk = JSON.parse(
      await readFile(join(TEST_DIR, "state.json"), "utf8"),
    ) as { contract_version?: string };
    expect(onDisk.contract_version).toBe(REMEDIATION_STATE_CONTRACT_VERSION);
  });

  it("loads an in-flight state that carries NO version (written before the field existed)", async () => {
    // Byte-for-byte what an older release left behind: a valid state with no
    // `contract_version` key at all.
    await writeFile(
      join(TEST_DIR, "state.json"),
      JSON.stringify({ status: "planning", step_count: 4 }),
      "utf8",
    );

    const store = new StateStore(TEST_DIR);
    const loaded = await store.loadState();
    expect(loaded?.status).toBe("planning");
    expect(loaded?.step_count).toBe(4);
    // Read back as the file says it — no field conjured at read time, so
    // `loadState` stays byte-faithful and the round trip compares equal.
    expect(loaded?.contract_version).toBeUndefined();
  });

  it("brings an unstamped in-flight state under the contract on its next write", async () => {
    await writeFile(
      join(TEST_DIR, "state.json"),
      JSON.stringify({ status: "planning", step_count: 4 }),
      "utf8",
    );
    const store = new StateStore(TEST_DIR);

    await store.mutate(async (current) => ({ ...current!, step_count: 5 }));

    const onDisk = JSON.parse(
      await readFile(join(TEST_DIR, "state.json"), "utf8"),
    ) as { contract_version?: string; step_count?: number };
    expect(onDisk.contract_version).toBe(REMEDIATION_STATE_CONTRACT_VERSION);
    expect(onDisk.step_count).toBe(5);
  });

  it("REFUSES to load a state stamped with another release's version", async () => {
    // The positive-mismatch case, and the one the policy is written for: the
    // file claims other semantics, so its fields must not be read under these.
    await writeFile(
      join(TEST_DIR, "state.json"),
      JSON.stringify({
        contract_version: "remediate-code-state/v0",
        status: "planning",
      }),
      "utf8",
    );

    const store = new StateStore(TEST_DIR);
    await expect(store.loadState()).rejects.toThrow(SchemaVersionMismatchError);
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
      return { status: "waiting_for_clarification" };
    });
    const loaded = await store.loadState();
    expect(loaded?.status).toBe("waiting_for_clarification");
  });

  it("sequential mutate calls each observe the prior transition's result", async () => {
    const store = new StateStore(TEST_DIR);
    const transitions: string[] = [];

    await store.mutate(async (current) => {
      transitions.push(`${String(current?.status)} -> planning`);
      return { status: "planning" };
    });
    await store.mutate(async (current) => {
      transitions.push(`${String(current?.status)} -> waiting_for_clarification`);
      return { status: "waiting_for_clarification" };
    });
    await store.mutate(async (current) => {
      transitions.push(`${String(current?.status)} -> complete`);
      return { status: "complete" };
    });

    expect(transitions[0]).toBe("undefined -> planning");
    expect(transitions[1]).toBe("planning -> waiting_for_clarification");
    expect(transitions[2]).toBe("waiting_for_clarification -> complete");

    const loaded = await store.loadState();
    expect(loaded?.status).toBe("complete");
  });

  // ── SKIP_WRITE: a no-op mutation writes nothing ──────────────────────────

  it("mutate returning SKIP_WRITE resolves with the read state and leaves the file byte-identical", async () => {
    const store = new StateStore(TEST_DIR);
    // A completeness-FREE status: implementing/triage/closing now require a
    // persisted plan/items (INV-RSM-STATE-COMPLETE) and would fail load
    // validation as a bare shell.
    await store.saveState({ status: "planning", step_count: 3 });
    const statePath = join(TEST_DIR, "state.json");
    const before = await readFile(statePath, "utf8");
    const mtimeBefore = (await stat(statePath)).mtimeMs;

    const seen: Array<RemediationState | null> = [];
    const result = await store.mutate(async (current) => {
      seen.push(current);
      return SKIP_WRITE;
    });

    // The callback still OBSERVED the current state (the skip is decided under
    // the same held lock as the write it avoids, never by a lockless pre-read).
    expect(seen[0]?.status).toBe("planning");
    // ...and the caller gets that state back, so a skip is indistinguishable
    // from a write of the same value at every call site.
    expect(result.status).toBe("planning");
    expect(result.step_count).toBe(3);
    // Nothing was written: same bytes, same mtime.
    expect(await readFile(statePath, "utf8")).toBe(before);
    expect((await stat(statePath)).mtimeMs).toBe(mtimeBefore);
  });

  it("mutate returning SKIP_WRITE on an absent file refuses rather than inventing a state", async () => {
    const store = new StateStore(TEST_DIR);
    // There is no state to resolve with, and the caller asked for no write — a
    // silent `null` here would hand the state machine a state that does not
    // exist on disk, so it is a loud refusal instead.
    await expect(
      store.mutate(async () => SKIP_WRITE),
    ).rejects.toThrow(/SKIP_WRITE/i);
    await expect(stat(join(TEST_DIR, "state.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
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
