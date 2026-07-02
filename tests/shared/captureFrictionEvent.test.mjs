import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { captureFrictionEvent } = await import(
  "../../src/shared/friction/captureFrictionEvent.ts"
);
const { frictionCapturePath } = await import(
  "../../src/shared/io/frictionCapture.ts"
);

// ── captureFrictionEvent: best-effort, no-op-safe, per-event de-duped sink ──────

test("captureFrictionEvent appends an event to the per-run record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friction-sink-"));
  try {
    await captureFrictionEvent(dir, "run-1", { id: "e1", note: "first" });
    const raw = JSON.parse(
      await readFile(frictionCapturePath(dir, "run-1"), "utf8"),
    );
    expect(raw.run_id).toBe("run-1");
    expect(raw.frictions.length).toBe(1);
    expect(raw.frictions[0]).toEqual({ id: "e1", note: "first" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("captureFrictionEvent de-dups by event id across re-entrant passes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friction-sink-"));
  try {
    await captureFrictionEvent(dir, "run-1", { id: "e1", note: "first" });
    await captureFrictionEvent(dir, "run-1", { id: "e1", note: "duplicate" });
    await captureFrictionEvent(dir, "run-1", { id: "e2", note: "second" });
    const raw = JSON.parse(
      await readFile(frictionCapturePath(dir, "run-1"), "utf8"),
    );
    expect(raw.frictions.length, "the duplicate id must be dropped").toBe(2);
    expect(raw.frictions.map((f) => f.id)).toEqual(["e1", "e2"]);
    // First-write-wins on the de-duped id.
    expect(raw.frictions[0].note).toBe("first");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("captureFrictionEvent is best-effort: a bad artifacts dir is swallowed, never throws", async () => {
  // A NUL byte makes the path unwritable on every OS; the sink must swallow it.
  await assert.doesNotReject(
    captureFrictionEvent("\0not-a-dir", "run-1", { id: "e1", note: "x" }),
  );
});

test("captureFrictionEvent tolerates a malformed existing record (degrades to fresh)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friction-sink-"));
  try {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const path = frictionCapturePath(dir, "run-1");
    await mkdir(join(dir, "friction"), { recursive: true });
    await writeFile(path, "{not json", "utf8");
    // Malformed JSON → readOptionalJsonFile throws → swallowed; nothing leaks.
    await assert.doesNotReject(
      captureFrictionEvent(dir, "run-1", { id: "e1", note: "x" }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("captureFrictionEvent paths are OS-agnostic + run-id sanitized", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friction-sink-"));
  try {
    // A run id with path separators must not escape the friction dir.
    await captureFrictionEvent(dir, "a/b\\c", { id: "e1", note: "x" });
    const path = frictionCapturePath(dir, "a/b\\c");
    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw.frictions.length).toBe(1);
    expect(path.startsWith(join(dir, "friction")), "record must stay under <artifactsDir>/friction").toBeTruthy();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
