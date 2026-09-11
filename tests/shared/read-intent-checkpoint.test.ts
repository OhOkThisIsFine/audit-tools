/**
 * `readIntentCheckpoint` — the ONE reader for `intent_checkpoint.json`, and the
 * two modes it has to offer.
 *
 * Before this reader the file was read with
 * `readOptionalJsonFile<IntentCheckpoint>(path)` at every remediate-side site:
 * a generic TYPE PARAMETER, which is an assertion the compiler erases. The
 * schema that defines the file (`IntentCheckpointSchema`) existed and was
 * exercised only by tests, so nothing on the read path checked it.
 *
 * The two modes are not a convenience — they are the two things callers
 * genuinely do with a bad field: ACT on it (strict, which throws) or REPORT it
 * (lenient, which yields a schema-VALID value plus the offending top-level
 * fields carried separately, so the gate can quote the refused value by name).
 *
 * The line this file draws is the one the lenient parse used to cross: the
 * value a caller ACTS on is always `IntentCheckpointSchema`-valid, and a key
 * that failed validation is ABSENT from it. Quoting a refused value is a
 * different consumer with a different input (`rejected`), never a key
 * re-attached to the parsed value.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  IntentCheckpointInvalidError,
  IntentCheckpointSchema,
  readIntentCheckpoint,
  readIntentCheckpointLenient,
} from "../../src/shared/types/intentCheckpoint.js";

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await rm(cleanups.pop()!, { recursive: true, force: true });
  }
});

async function checkpointAt(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "intent-checkpoint-"));
  cleanups.push(dir);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "intent_checkpoint.json");
  await writeFile(path, contents, "utf8");
  return path;
}

/** A checkpoint that satisfies `IntentCheckpointSchema` exactly. */
function validCheckpoint(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-01-01T00:00:00.000Z",
    confirmed_by: "host",
    scope_summary: "Test scope",
    intent_summary: "Test intent",
    ...extra,
  });
}

describe("readIntentCheckpoint", () => {
  it("returns undefined for an absent file — the fresh-run case, not an error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intent-checkpoint-"));
    cleanups.push(dir);
    expect(await readIntentCheckpoint(join(dir, "intent_checkpoint.json"))).toBeUndefined();
  });

  it("returns the checkpoint when it satisfies the schema", async () => {
    const path = await checkpointAt(validCheckpoint());
    const checkpoint = await readIntentCheckpoint(path);
    expect(checkpoint?.confirmed_by).toBe("host");
    expect(checkpoint?.scope_summary).toBe("Test scope");
  });

  it("THROWS on a present-but-invalid checkpoint, naming every offending path", async () => {
    // A cast would have returned this object typed as a checkpoint, and every
    // downstream `confirmed_by` / `closing_action` read would have been an
    // unchecked property access. The refusal quotes the zod paths so the message
    // says WHICH field is wrong, not merely that something is.
    const path = await checkpointAt(
      JSON.stringify({ schema_version: "intent-checkpoint/v1", confirmed_at: "x" }),
    );
    await expect(readIntentCheckpoint(path)).rejects.toThrow(
      IntentCheckpointInvalidError,
    );
    await expect(readIntentCheckpoint(path)).rejects.toThrow(/confirmed_by/);
  });

  it("LENIENT mode still returns a value, so a presence question is still answerable", async () => {
    // The confirm-intent gate's first question is "is this checkpoint confirmed
    // by the host?" — a question about `confirmed_by`, asked while a DIFFERENT
    // field is out of vocabulary. A whole-file rejection would lose the answer.
    // The offending field is gone; the valid ones survive.
    const path = await checkpointAt(validCheckpoint({ closing_action: "deploy" }));
    const checkpoint = await readIntentCheckpoint(path, { lenient: true });
    expect(checkpoint?.confirmed_by, "the valid fields survive").toBe("host");
    expect(
      IntentCheckpointSchema.safeParse(checkpoint).success,
      "the value a caller ACTS on is schema-valid — the offending key is ABSENT, not re-attached",
    ).toBe(true);
  });

  it("LENIENT mode still refuses a file that is not a checkpoint at all", async () => {
    const path = await checkpointAt(JSON.stringify({ hello: "world" }));
    expect(await readIntentCheckpoint(path, { lenient: true })).toBeUndefined();
  });
});

describe("readIntentCheckpointLenient — the reporting reader", () => {
  it("carries the refused TOP-LEVEL value beside the parsed checkpoint", async () => {
    // The one consumer that must NAME an offending value. `closing_action` is a
    // top-level scalar, so the refusal quotes it verbatim.
    const path = await checkpointAt(validCheckpoint({ closing_action: "deploy" }));
    const { checkpoint, rejected } = await readIntentCheckpointLenient(path);

    expect(checkpoint?.confirmed_by).toBe("host");
    expect(
      rejected,
      "the raw refusal is what the gate quotes — the parsed value cannot carry it",
    ).toEqual([{ key: "closing_action", value: "deploy" }]);
    expect(
      (checkpoint as Record<string, unknown> | undefined)?.closing_action,
      "and it is ABSENT from the parsed value, never re-attached",
    ).toBeUndefined();
  });

  it("reports nothing for a checkpoint that validates", async () => {
    const path = await checkpointAt(validCheckpoint());
    const { checkpoint, rejected } = await readIntentCheckpointLenient(path);
    expect(checkpoint?.confirmed_by).toBe("host");
    expect(rejected).toEqual([]);
  });

  it("a NESTED defect in `filters` yields a schema-valid value with the key absent", async () => {
    // The unsoundness this replaces, stated as the input that produced it.
    // `IntentCheckpointSchema` is `.strict()` at every level, so the second
    // parse refuses the whole `filters` record; the old code then re-attached
    // `record.filters` VERBATIM, so `filters.bogus === 1` came back on a value
    // the schema REJECTS. A consumer reading `filters` as a value was reading
    // unvalidated data through a function whose contract said otherwise.
    const path = await checkpointAt(
      validCheckpoint({ filters: { severity: ["high"], bogus: 1 } }),
    );
    const { checkpoint, rejected } = await readIntentCheckpointLenient(path);

    expect(
      IntentCheckpointSchema.safeParse(checkpoint).success,
      "the returned checkpoint must satisfy the schema that defines the file",
    ).toBe(true);
    expect(
      (checkpoint as Record<string, unknown> | undefined)?.filters,
      "a nested defect takes its whole top-level record — the record is what the schema refused",
    ).toBeUndefined();
    expect(
      rejected,
      "…and the refused record still travels, so a gate can quote it",
    ).toEqual([{ key: "filters", value: { severity: ["high"], bogus: 1 } }]);
  });

  it("a NESTED defect in `design_review` yields a schema-valid value with the key absent", async () => {
    // The other nested record a host writes. Same property, different shape:
    // the correctness of the fix cannot depend on which nested record is hit.
    const path = await checkpointAt(
      validCheckpoint({
        design_review: { required: true, bogus: "nope" },
      }),
    );
    const { checkpoint, rejected } = await readIntentCheckpointLenient(path);

    expect(IntentCheckpointSchema.safeParse(checkpoint).success).toBe(true);
    expect(
      (checkpoint as Record<string, unknown> | undefined)?.design_review,
    ).toBeUndefined();
    expect(rejected).toEqual([
      { key: "design_review", value: { required: true, bogus: "nope" } },
    ]);
  });

  it("`excluded_scope` — the third nested record — is dropped the same way", async () => {
    // Swept rather than sampled: the property is about nesting, not about the
    // two records someone happened to think of.
    const path = await checkpointAt(
      validCheckpoint({ excluded_scope: { paths: ["./x"], bogus: true } }),
    );
    const { checkpoint, rejected } = await readIntentCheckpointLenient(path);

    expect(IntentCheckpointSchema.safeParse(checkpoint).success).toBe(true);
    expect(
      (checkpoint as Record<string, unknown> | undefined)?.excluded_scope,
    ).toBeUndefined();
    expect(rejected.map((field) => field.key)).toEqual(["excluded_scope"]);
  });
});
