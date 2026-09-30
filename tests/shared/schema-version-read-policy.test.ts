import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  SchemaVersionMismatchError,
  discardOnSchemaVersionMismatch,
  throwOnSchemaVersionMismatch,
} = await import("../../src/shared/io/schemaVersion.js");

import { executionPlanPaths, readCanonicalPlan } from "../../src/remediate/contractPipeline/executionPlan.js";
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

  // Both spellings of the version key are read, because the repo stamps both:
  // `schema_version` on artifacts, `contract_version` on contracts. A helper
  // that knew only one would return undefined for EVERY payload of the other —
  // discarding a current file as though it had never been written, which is
  // indistinguishable from a working guard until a run silently loses its
  // bookkeeping.
  it("reads contract_version when that is how the payload stamps its version", () => {
    const payload = { contract_version: "thing/v1", data: 1 };
    expect(discardOnSchemaVersionMismatch(payload, "thing/v1")).toBe(payload);
    expect(discardOnSchemaVersionMismatch(payload, "thing/v2")).toBeUndefined();
    expect(() =>
      throwOnSchemaVersionMismatch({ contract_version: "thing/v1" }, "thing.json", "thing/v1"),
    ).not.toThrow();
    expect(() =>
      throwOnSchemaVersionMismatch({ contract_version: "thing/v0" }, "thing.json", "thing/v1"),
    ).toThrow(SchemaVersionMismatchError);
  });

  it("prefers schema_version when a payload carries both keys", () => {
    expect(
      discardOnSchemaVersionMismatch(
        { schema_version: "thing/v1", contract_version: "thing/v0" },
        "thing/v1",
      ),
    ).toBeTruthy();
    expect(
      discardOnSchemaVersionMismatch(
        { schema_version: "thing/v0", contract_version: "thing/v1" },
        "thing/v1",
      ),
    ).toBeUndefined();
  });

  // The contract-pipeline's own file family: every artifact on disk is a
  // content-hash ENVELOPE whose `payload` is the contract, and the contract's
  // version key is one level DOWN. A helper that read only the top level
  // returned `undefined` for every envelope — reporting a version mismatch on
  // files that were current, which is the always-discard failure the two
  // spellings above exist to prevent, one level deeper.
  it("reads a version stamped on the payload of a content-hash envelope", () => {
    const envelope = {
      artifact_name: "goal_spec",
      content_hash: "abc123",
      dependency_hashes: {},
      payload: { contract_version: "thing/v1", objective: "x" },
    };
    expect(discardOnSchemaVersionMismatch(envelope, "thing/v1")).toBe(envelope);
    expect(discardOnSchemaVersionMismatch(envelope, "thing/v2")).toBeUndefined();
    expect(() =>
      throwOnSchemaVersionMismatch(envelope, "goal_spec.json", "thing/v1"),
    ).not.toThrow();
    expect(() =>
      throwOnSchemaVersionMismatch(envelope, "goal_spec.json", "thing/v2"),
    ).toThrow(SchemaVersionMismatchError);
  });

  it("an envelope's OWN version wins over its payload's", () => {
    // An envelope that stamps a version of its own is judged by that one; the
    // payload arm is the fallback for a payload that carries no envelope, never
    // an override.
    const envelope = {
      contract_version: "envelope/v2",
      payload: { contract_version: "thing/v1" },
    };
    expect(discardOnSchemaVersionMismatch(envelope, "envelope/v2")).toBeTruthy();
    expect(discardOnSchemaVersionMismatch(envelope, "thing/v1")).toBeUndefined();
  });

  it("a payload that is not an object carries no version", () => {
    // The arm narrows to a plain object; an array or a primitive payload is
    // unstamped, exactly as a non-object top level is.
    expect(
      discardOnSchemaVersionMismatch({ payload: ["thing/v1"] }, "thing/v1"),
    ).toBeUndefined();
    expect(
      discardOnSchemaVersionMismatch({ payload: "thing/v1" }, "thing/v1"),
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

describe("canonical accepted plan version policy", () => {
  it("refuses an unsupported accepted contract without overwriting evidence", async () => {
    await withTempDir("canonical-version-", async dir => {
      const path = executionPlanPaths(dir).canonical;
      const old = { contract_version: "remediate-code-executable-plan/retired", saved_evidence: "retain this" };
      await writeJson(path, old);
      const before = await readFile(path, "utf8");
      await expect(readCanonicalPlan(dir)).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(before);
    });
  });
});
