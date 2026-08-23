/**
 * The friction record names the runs it relates to BY REFERENCE — the contract is stated
 * once on `FrictionRunLinks` (src/shared/io/frictionCapture.ts); these are its assertions.
 *
 *  1. ALWAYS PRESENT — both reference arrays exist on a first-touch record, empty.
 *  2. VERBATIM — each supplied id persists exactly as given, derived neither from the
 *     record's own `run_id` nor from its sibling reference (a provenance property of the
 *     substrate, not a claim that the ids differ in a real run).
 *  3. ACCUMULATING — every round's id stays present and queryable; a later write knowing
 *     nothing drops none of them.
 *  4. DISCOVERABLE — a record is found from a run id it references, not from its key.
 *  5. TOLERANT — the join reads SIBLING records (host-authorable files), so an unreadable
 *     one is skipped rather than wedging an unrelated run's close-out.
 */
import { test, expect } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { captureFrictionEvent } = await import(
  "../../src/shared/friction/captureFrictionEvent.js"
);
const { linkFrictionRunIds, findFrictionRecordsByRunLink } = await import(
  "../../src/shared/friction/frictionRecord.js"
);
const { decideFrictionTriage } = await import("../../src/shared/friction/triage.js");
const { frictionCaptureDir, frictionCapturePath } = await import(
  "../../src/shared/io/frictionCapture.js"
);

type FrictionRecord =
  import("../../src/shared/friction/frictionRecord.js").TriagedFrictionArtifact;

async function readRecord(dir: string, runId: string): Promise<FrictionRecord> {
  return JSON.parse(await readFile(frictionCapturePath(dir, runId), "utf8")) as FrictionRecord;
}

test("a first-touch friction record carries both reference arrays, empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friction-links-"));
  try {
    await captureFrictionEvent(dir, "run", { id: "e1", note: "x" }, "audit-code");
    const record = await readRecord(dir, "run");
    // Presence, not truthiness: an absent key and an empty array are different answers
    // to "which runs does this record relate to?".
    expect(Object.keys(record)).toContain("step_run_ids");
    expect(Object.keys(record)).toContain("dispatch_run_ids");
    expect(record.step_run_ids).toEqual([]);
    expect(record.dispatch_run_ids).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("supplied run references persist verbatim and never derive from the record's own key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friction-links-"));
  try {
    await captureFrictionEvent(dir, "run", { id: "e1", note: "x" }, "audit-code");
    await linkFrictionRunIds(
      dir,
      "run",
      { step_run_id: "STEP-7", dispatch_run_id: "DISP-9" },
      "audit-code",
    );
    const record = await readRecord(dir, "run");
    expect(record.run_id).toBe("run");
    expect(record.step_run_ids).toEqual(["STEP-7"]);
    expect(record.dispatch_run_ids).toEqual(["DISP-9"]);
    // Substrate provenance: three DISTINCT ids went in, three came back out unchanged —
    // the store collapsed neither reference onto `run_id` nor onto its sibling. It does
    // NOT assert the three differ in a real run; they coincide on both draws today.
    expect(
      new Set([record.run_id, ...record.step_run_ids, ...record.dispatch_run_ids]).size,
    ).toBe(3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("every round's run reference is retained, deduped, and content-ordered", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friction-links-"));
  try {
    await captureFrictionEvent(dir, "run", { id: "e1", note: "x" }, "audit-code");
    // Round 1, then round 2 — a fresh review/dispatch run id is minted per round while
    // the record's own key stays fixed, so a first-writer-wins scalar would hide round 2.
    await linkFrictionRunIds(
      dir,
      "run",
      { step_run_id: "STEP-9", dispatch_run_id: "DISP-9" },
      "audit-code",
    );
    await linkFrictionRunIds(
      dir,
      "run",
      { step_run_id: "STEP-1", dispatch_run_id: "DISP-1" },
      "audit-code",
    );
    // Round 3 re-links round 2's ids: the same relation recorded twice is one entry.
    await linkFrictionRunIds(
      dir,
      "run",
      { step_run_id: "STEP-1", dispatch_run_id: "DISP-1" },
      "audit-code",
    );
    const record = await readRecord(dir, "run");
    // Code-unit order on the ids themselves, NOT write order — the array is content-ordered.
    expect(record.step_run_ids).toEqual(["STEP-1", "STEP-9"]);
    expect(record.dispatch_run_ids).toEqual(["DISP-1", "DISP-9"]);

    // Both rounds remain queryable: a reader holding EITHER round's id finds the record.
    for (const id of ["DISP-1", "DISP-9"]) {
      const found = await findFrictionRecordsByRunLink(dir, { dispatch_run_ids: [id] });
      expect(found.map((entry) => entry.run_id)).toEqual(["run"]);
    }
    const byStep = await findFrictionRecordsByRunLink(dir, { step_run_ids: ["STEP-9"] });
    expect(byStep.map((entry) => entry.run_id)).toEqual(["run"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a recorded reference survives every later write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friction-links-"));
  try {
    // 1 — first touch, before any dispatch run exists.
    await captureFrictionEvent(dir, "run", { id: "e1", note: "x" }, "audit-code");
    expect((await readRecord(dir, "run")).dispatch_run_ids).toEqual([]);

    // 2 — the dispatch run becomes known.
    await linkFrictionRunIds(dir, "run", { dispatch_run_id: "DISP-9" }, "audit-code");
    expect((await readRecord(dir, "run")).dispatch_run_ids).toEqual(["DISP-9"]);

    // 3 — a later write knowing nothing must not drop it, and the re-entrant duplicate-event
    // capture (whose mutate returns the record unchanged) must not lose it either.
    await captureFrictionEvent(dir, "run", { id: "e2", note: "y" }, "audit-code");
    await captureFrictionEvent(dir, "run", { id: "e1", note: "duplicate" }, "audit-code");
    await linkFrictionRunIds(dir, "run", { dispatch_run_id: null }, "audit-code");
    const record = await readRecord(dir, "run");
    expect(record.dispatch_run_ids).toEqual(["DISP-9"]);
    expect(record.step_run_ids).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a friction record is discoverable by reference, and the close-out names its relations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friction-links-"));
  try {
    await captureFrictionEvent(dir, "run", { id: "e1", note: "x" }, "audit-code");
    await linkFrictionRunIds(dir, "run", { dispatch_run_id: "DISP-9" }, "audit-code");
    // A second record, filed under the substrate's own timestamped key — the shape
    // that was invisible to the close-out walk keyed on "run".
    await captureFrictionEvent(dir, "dispatch-2026-01-01", { id: "e2", note: "y" }, "audit-code");
    await linkFrictionRunIds(
      dir,
      "dispatch-2026-01-01",
      { dispatch_run_id: "DISP-9" },
      "audit-code",
    );
    // …and one unrelated record, to prove the join is by reference and not "everything".
    await captureFrictionEvent(dir, "other", { id: "e3", note: "z" }, "audit-code");

    const found = await findFrictionRecordsByRunLink(dir, { dispatch_run_ids: ["DISP-9"] });
    expect(found.map((entry) => entry.run_id)).toEqual(["dispatch-2026-01-01", "run"]);

    const decision = await decideFrictionTriage(dir, "run", "audit-code");
    expect(decision.dispatch_run_ids).toEqual(["DISP-9"]);
    expect(decision.step_run_ids).toEqual([]);
    expect(decision.related_record_keys).toEqual(["dispatch-2026-01-01"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unreadable sibling record is skipped by the join, never fatal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friction-links-"));
  try {
    await captureFrictionEvent(dir, "run", { id: "e1", note: "x" }, "audit-code");
    await linkFrictionRunIds(dir, "run", { dispatch_run_id: "DISP-9" }, "audit-code");
    // The friction dir holds host-authored files (the triage block tells the host to write
    // one), so a malformed sibling is reachable — and it must cost only its own record's
    // visibility, never the close-out of the run doing the join.
    await writeFile(join(frictionCaptureDir(dir), "hand-written.json"), "{ not json", "utf8");

    const found = await findFrictionRecordsByRunLink(dir, { dispatch_run_ids: ["DISP-9"] });
    expect(found.map((entry) => entry.run_id)).toEqual(["run"]);

    const decision = await decideFrictionTriage(dir, "run", "audit-code");
    expect(decision.dispatch_run_ids).toEqual(["DISP-9"]);
    expect(decision.related_record_keys).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
