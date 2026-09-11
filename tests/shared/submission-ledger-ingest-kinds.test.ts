/**
 * Which ledger kinds mean "the TOOL ingested this submission", stated as data.
 *
 * Every last-event-per-submission reader used to ask the question as
 * `kind !== "expected"` — a partition that silently absorbs every future kind.
 * Two new kinds (`dispatched`, `lane_outcome`) are facts about DISPATCH, not
 * about ingestion, and under the old partition a `dispatched` row appended when
 * a refused-and-therefore-still-pending lane was re-materialized would have
 * become that submission's trailing event: the refusal would vanish from
 * `lastRefusals` (so the host is told it "submitted nothing", which is false and
 * points it at the wrong repair) and the report would claim the refusal "was
 * later accepted or re-landed by hand" when nothing had accepted it.
 *
 * The classification is an exhaustive `Record`, so this test cannot be the only
 * guard — a new kind is a compile error first. What it pins is the ANSWER: that
 * the dispatch kinds are excluded and that every kind recording a decision about
 * a received submission is included, `removed_by_operator` among them (a
 * withdrawal ends a refusal's trailing state exactly as an acceptance does).
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  INGEST_EVENT_KINDS,
  SUBMISSION_EVENT_KINDS,
  SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION,
  isIngestEvent,
  readSubmissionLedger,
  recoveryMarkMatches,
  submissionLedgerPath,
  type SubmissionLedgerEvent,
} from "../../src/shared/submission/submissionLedger.js";

describe("the ingest-event partition", () => {
  it("admits exactly the kinds that record a decision about a received submission", () => {
    expect([...INGEST_EVENT_KINDS]).toEqual([
      "accepted",
      "rejected",
      "recovered_by_hand",
      "accepted_via_recovery",
      "removed_by_operator",
    ]);
  });

  it("excludes the declaration and dispatch kinds", () => {
    expect(isIngestEvent("expected")).toBe(false);
    expect(isIngestEvent("dispatched")).toBe(false);
    expect(isIngestEvent("lane_outcome")).toBe(false);
  });

  it("classifies every kind in the live vocabulary", () => {
    // Exhaustive over SUBMISSION_EVENT_KINDS rather than a copied list, so a
    // member added without a classification is caught here as well as at the
    // compiler.
    const partitioned = SUBMISSION_EVENT_KINDS.filter((kind) =>
      isIngestEvent(kind),
    );
    expect(partitioned).toEqual([...INGEST_EVENT_KINDS]);
    expect(SUBMISSION_EVENT_KINDS.length).toBe(INGEST_EVENT_KINDS.length + 3);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The reader PARSES the event, it does not cast it.
//
// The version gate answers "which contract wrote this line". It says nothing
// about whether the bytes satisfy that contract, so everything past it used to
// be `value as SubmissionLedgerEvent` — an unchecked assertion. A line that
// parsed as JSON but carried an unknown `kind` then flowed into every
// `Record<SubmissionEventKind, …>` lookup as an absent key and into every
// `submission_id`-keyed map as no entry at all, which reads exactly like a
// ledger that recorded nothing. That is the one thing this file exists to
// prevent, so a shape failure is a REPORTED drop like any other.
// ───────────────────────────────────────────────────────────────────────────

describe("the ledger reader validates each event past the version gate", () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await rm(cleanups.pop()!, { recursive: true, force: true });
    }
  });

  async function artifactsDirWith(lines: readonly string[]): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "ledger-shape-"));
    cleanups.push(root);
    const artifactsDir = join(root, ".audit-tools", "audit");
    const path = submissionLedgerPath(artifactsDir);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, lines.join("\n") + "\n", "utf8");
    return artifactsDir;
  }

  /** A well-formed event, minus whatever `omit` removes. */
  function line(omit: readonly string[], overrides: Record<string, unknown> = {}): string {
    const base: Record<string, unknown> = {
      contract_version: SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION,
      run_id: "run-shape",
      submission_id: "item-a",
      lane: "item-a",
      kind: "accepted",
      recorded_at: "2026-08-12T00:00:00.000Z",
      ...overrides,
    };
    for (const key of omit) delete base[key];
    return JSON.stringify(base);
  }

  it("refuses an event whose kind is outside the vocabulary, and says so", async () => {
    const artifactsDir = await artifactsDirWith([
      line([], { kind: "a_kind_no_release_ever_emitted" }),
      line([], { submission_id: "survivor" }),
    ]);

    const read = await readSubmissionLedger(artifactsDir);

    expect(
      read.events.map((e) => e.submission_id),
      "the unknown kind is not an event; the valid line on either side still loads",
    ).toEqual(["survivor"]);
    expect(read.dropped).toEqual([
      {
        line: 1,
        reason: "shape_invalid",
        detail: `"kind" is not one of: ${SUBMISSION_EVENT_KINDS.join(", ")}`,
      },
    ]);
  });

  it("refuses an event missing a required field", async () => {
    const artifactsDir = await artifactsDirWith([
      line(["submission_id"]),
      line([], { submission_id: "survivor" }),
    ]);

    const read = await readSubmissionLedger(artifactsDir);

    expect(read.events.map((e) => e.submission_id)).toEqual(["survivor"]);
    expect(read.dropped).toEqual([
      {
        line: 1,
        reason: "shape_invalid",
        detail: '"submission_id" is missing or not a non-empty string',
      },
    ]);
  });

  it("refuses a required field of the wrong type, and an optional one too", async () => {
    const artifactsDir = await artifactsDirWith([
      line([], { run_id: 42 }),
      line([], { landed_commit: ["not", "a", "string"] }),
    ]);

    const read = await readSubmissionLedger(artifactsDir);

    expect(read.events).toEqual([]);
    expect(read.dropped).toEqual([
      { line: 1, reason: "shape_invalid", detail: '"run_id" is missing or not a non-empty string' },
      { line: 2, reason: "shape_invalid", detail: '"landed_commit" is present but is not a string' },
    ]);
  });

  it("keeps a shape failure distinct from a foreign-version drop", async () => {
    // Two different facts about two lines: one says "another release wrote
    // this", the other says "this release's writer emitted something the
    // reader cannot interpret". Collapsing them would send an operator
    // looking for a version problem that does not exist.
    const artifactsDir = await artifactsDirWith([
      line([], { contract_version: "submission-ledger-event/v0" }),
      line([], { kind: "not_a_kind" }),
    ]);

    const read = await readSubmissionLedger(artifactsDir);

    expect(read.dropped.map((drop) => drop.reason)).toEqual([
      "schema_version_mismatch",
      "shape_invalid",
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// A recovery mark carries its identity as DATA.
//
// The mark's identity is (run, submission, LANDED COMMIT): an item re-accepted
// from a DIFFERENT landing is a different relaxed acceptance and earns its own
// record, while a retry of the SAME landing is a duplicate. That question used
// to be answered by searching the free-text `message` for a sha the writer had
// itself interpolated — so any later reword of the message silently un-deduped
// the mark, and two events differing ONLY in message text were treated as
// distinct facts.
// ───────────────────────────────────────────────────────────────────────────

describe("a recovery mark's identity is its structured landed_commit, not its message", () => {
  function mark(
    overrides: Partial<SubmissionLedgerEvent> = {},
  ): SubmissionLedgerEvent {
    return {
      contract_version: SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION,
      run_id: "run-recovery",
      submission_id: "F1",
      lane: "F1",
      kind: "accepted_via_recovery",
      landed_commit: "a".repeat(40),
      message: "accepted under recovery: the trusted baseline is orphaned",
      recorded_at: "2026-08-12T00:00:00.000Z",
      ...overrides,
    } as SubmissionLedgerEvent;
  }

  it("matches on the structured commit, ignoring how the message is worded", () => {
    const sha = "a".repeat(40);
    const reworded = mark({
      message:
        "ENTIRELY different prose that mentions no sha at all, because someone " +
        "edited the diagnostic later",
    });

    expect(
      recoveryMarkMatches(reworded, "F1", sha),
      "the message is narration; the identity is the field",
    ).toBe(true);
  });

  it("does NOT match a different landing, a different submission, or another kind", () => {
    expect(recoveryMarkMatches(mark(), "F1", "b".repeat(40))).toBe(false);
    expect(recoveryMarkMatches(mark(), "F2", "a".repeat(40))).toBe(false);
    expect(recoveryMarkMatches(mark({ kind: "accepted" }), "F1", "a".repeat(40))).toBe(false);
  });

  it("does not match a row written before landed_commit existed", () => {
    // The fail-safe direction: matching would SUPPRESS a mark the run genuinely
    // owed. Not matching costs one duplicate row on a re-entry spanning the
    // upgrade — a faithful record of two acceptances rather than a lost one.
    const legacy = mark({ landed_commit: undefined });
    expect(recoveryMarkMatches(legacy, "F1", "a".repeat(40))).toBe(false);
  });

  it("two marks that differ ONLY in message text are two facts, and both survive a read", async () => {
    // The end-to-end form of the same claim: the ledger keeps both rows and the
    // identity helper tells them apart by commit alone.
    const root = await mkdtemp(join(tmpdir(), "ledger-recovery-"));
    try {
      const artifactsDir = join(root, ".audit-tools", "audit");
      const path = submissionLedgerPath(artifactsDir);
      await mkdir(dirname(path), { recursive: true });
      const first = mark();
      const second = mark({
        message: "accepted under recovery: reworded diagnostic, same landing",
      });
      await writeFile(path, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`, "utf8");

      const events = await readSubmissionLedger(artifactsDir);
      expect(events).toHaveLength(2);

      const sha = "a".repeat(40);
      expect(events.filter((e) => recoveryMarkMatches(e, "F1", sha))).toHaveLength(2);
      expect(
        events.filter((e) => recoveryMarkMatches(e, "F1", "b".repeat(40))),
        "neither row is the mark for a landing that never happened",
      ).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
