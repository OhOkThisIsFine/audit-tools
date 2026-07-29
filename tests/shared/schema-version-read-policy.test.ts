/**
 * Stamping a `schema_version` on WRITE and never comparing it on READ is not
 * versioning — it is an unchecked cast wearing a version field. State written
 * by an older tool version is then reinterpreted under the current version's
 * semantics, silently.
 *
 * Two readers did exactly that: `readTestPlanCarry` and `readReviewSnapshot`
 * each wrote their module's version constant into the payload and then cast the
 * parsed file straight to the payload type. Both are REGENERABLE state (a carry
 * of prior authored specs; a snapshot of prior review inputs) — the correct
 * policy for a stale version is "treat as absent and rebuild", which is already
 * each reader's own fail-shape when the file is missing.
 *
 * These tests pin the payload-level behaviour (a stale file is indistinguishable
 * from no file) rather than the call to the shared helper, so the property
 * survives any future refactor of how the comparison is spelled.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  SchemaVersionMismatchError,
  discardOnSchemaVersionMismatch,
  throwOnSchemaVersionMismatch,
} = await import("../../src/shared/io/schemaVersion.js");

const { readTestPlanCarry, captureTestPlanCarry, testPlanCarryPath } =
  await import("../../src/remediate/contractPipeline/testPlanCarry.js");
const { readReviewSnapshot, captureReviewSnapshot, reviewSnapshotPath } =
  await import("../../src/remediate/contractPipeline/reviewSnapshot.js");

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

// ── The shared pair: the two directions ────────────────────────────────────────

describe("schema-version read policy pair", () => {
  it("discardOnSchemaVersionMismatch returns the payload only on an exact match", () => {
    const payload = { schema_version: "thing/v1", data: 1 };
    expect(discardOnSchemaVersionMismatch(payload, "thing/v1")).toBe(payload);
    expect(discardOnSchemaVersionMismatch(payload, "thing/v2")).toBeUndefined();
  });

  it("discardOnSchemaVersionMismatch treats an unstamped or non-string version as stale", () => {
    expect(discardOnSchemaVersionMismatch({ data: 1 }, "thing/v1")).toBeUndefined();
    expect(
      discardOnSchemaVersionMismatch({ schema_version: 2 }, "thing/v1"),
    ).toBeUndefined();
  });

  it("discardOnSchemaVersionMismatch passes an absent payload through as absent", () => {
    expect(discardOnSchemaVersionMismatch(undefined, "thing/v1")).toBeUndefined();
    expect(discardOnSchemaVersionMismatch(null, "thing/v1")).toBeUndefined();
  });

  it("throwOnSchemaVersionMismatch throws naming the artifact and both versions", () => {
    let caught: InstanceType<typeof SchemaVersionMismatchError> | undefined;
    try {
      throwOnSchemaVersionMismatch(
        { schema_version: "thing/v0" },
        "thing.json",
        "thing/v1",
      );
    } catch (err) {
      caught = err as InstanceType<typeof SchemaVersionMismatchError>;
    }
    expect(caught).toBeInstanceOf(SchemaVersionMismatchError);
    expect(caught!.message).toMatch(/thing\.json/);
    expect(caught!.message).toMatch(/thing\/v0/);
    expect(caught!.message).toMatch(/thing\/v1/);
    expect(caught!.artifactName).toBe("thing.json");
    expect(caught!.expected).toBe("thing/v1");
    expect(caught!.actual).toBe("thing/v0");
  });

  it("throwOnSchemaVersionMismatch throws on a missing or non-string version", () => {
    expect(() =>
      throwOnSchemaVersionMismatch({}, "thing.json", "thing/v1"),
    ).toThrow(SchemaVersionMismatchError);
    expect(() =>
      throwOnSchemaVersionMismatch({ schema_version: 7 }, "thing.json", "thing/v1"),
    ).toThrow(SchemaVersionMismatchError);
  });

  it("throwOnSchemaVersionMismatch is silent for an absent payload (not yet produced)", () => {
    expect(() =>
      throwOnSchemaVersionMismatch(undefined, "thing.json", "thing/v1"),
    ).not.toThrow();
    expect(() =>
      throwOnSchemaVersionMismatch(null, "thing.json", "thing/v1"),
    ).not.toThrow();
  });
});

// ── Reader 1: the test-plan carry ─────────────────────────────────────────────

describe("readTestPlanCarry rejects a payload from another schema version", () => {
  it("returns the carried specs when the version matches what the module writes", async () => {
    await withTempDir("carry-version-ok-", async (dir) => {
      await captureTestPlanCarry(
        dir,
        {
          test_specs: [
            { obligation_id: "OB-1", name: "spec one", assertions: ["holds"] },
          ],
        },
        "2026-07-25T00:00:00.000Z",
      );
      const carry = await readTestPlanCarry(dir);
      expect(Object.keys(carry)).toEqual(["OB-1"]);
      expect(carry["OB-1"].assertions).toEqual(["holds"]);
    });
  });

  it("returns {} for a carry written under an older schema_version", async () => {
    await withTempDir("carry-version-stale-", async (dir) => {
      // Byte-for-byte the shape the module writes, except the version — i.e.
      // exactly what an older release left on disk.
      await writeJson(testPlanCarryPath(dir), {
        schema_version: "remediate-code-contract-pipeline/test-plan-carry/v0",
        captured_at: "2026-01-01T00:00:00.000Z",
        specs: {
          "OB-1": { name: "stale spec", scope_anchors: [], assertions: ["stale"] },
        },
      });
      expect(await readTestPlanCarry(dir)).toEqual({});
    });
  });

  it("returns {} for a carry with no schema_version at all", async () => {
    await withTempDir("carry-version-absent-", async (dir) => {
      await writeJson(testPlanCarryPath(dir), {
        captured_at: "2026-01-01T00:00:00.000Z",
        specs: {
          "OB-1": { name: "unstamped", scope_anchors: [], assertions: ["stale"] },
        },
      });
      expect(await readTestPlanCarry(dir)).toEqual({});
    });
  });

  it("a stale carry is indistinguishable from no carry (the module's own fail-shape)", async () => {
    await withTempDir("carry-version-absent-file-", async (dir) => {
      const missing = await readTestPlanCarry(dir);
      await writeJson(testPlanCarryPath(dir), {
        schema_version: "remediate-code-contract-pipeline/test-plan-carry/v0",
        captured_at: "2026-01-01T00:00:00.000Z",
        specs: { "OB-1": { name: "x", scope_anchors: [], assertions: ["y"] } },
      });
      expect(await readTestPlanCarry(dir)).toEqual(missing);
    });
  });
});

// ── Reader 2: the review snapshot ─────────────────────────────────────────────

describe("readReviewSnapshot rejects a payload from another schema version", () => {
  it("returns the snapshot when the version matches what the module writes", async () => {
    await withTempDir("snapshot-version-ok-", async (dir) => {
      await captureReviewSnapshot(
        dir,
        "judge_report",
        { verdict: "pass" },
        "2026-07-25T00:00:00.000Z",
      );
      const snapshot = await readReviewSnapshot(dir, "judge_report");
      expect(snapshot).not.toBeNull();
      expect(snapshot!.prior_payload).toEqual({ verdict: "pass" });
    });
  });

  it("returns null for a snapshot written under an older schema_version", async () => {
    await withTempDir("snapshot-version-stale-", async (dir) => {
      await writeJson(reviewSnapshotPath(dir, "judge_report"), {
        schema_version: "remediate-code-contract-pipeline/review-snapshot/v0",
        artifact_name: "judge_report",
        reviewed_at: "2026-01-01T00:00:00.000Z",
        prior_payload: { verdict: "stale" },
        reviewed_inputs: {},
      });
      expect(await readReviewSnapshot(dir, "judge_report")).toBeNull();
    });
  });

  it("returns null for a snapshot with no schema_version at all", async () => {
    await withTempDir("snapshot-version-absent-", async (dir) => {
      await writeJson(reviewSnapshotPath(dir, "judge_report"), {
        artifact_name: "judge_report",
        reviewed_at: "2026-01-01T00:00:00.000Z",
        prior_payload: { verdict: "stale" },
        reviewed_inputs: {},
      });
      expect(await readReviewSnapshot(dir, "judge_report")).toBeNull();
    });
  });

  it("does not confuse the sibling review-snapshot version with its own", async () => {
    await withTempDir("snapshot-version-sibling-", async (dir) => {
      // The audit-side design-review snapshot stamps a DIFFERENT constant with
      // the same field name; a reader keyed on presence rather than value would
      // accept it.
      await writeJson(reviewSnapshotPath(dir, "judge_report"), {
        schema_version: "audit-code/design-review-snapshot/v1alpha1",
        artifact_name: "judge_report",
        reviewed_at: "2026-01-01T00:00:00.000Z",
        prior_payload: { verdict: "wrong module" },
        reviewed_inputs: {},
      });
      expect(await readReviewSnapshot(dir, "judge_report")).toBeNull();
    });
  });
});
