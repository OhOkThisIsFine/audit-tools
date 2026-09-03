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
import { describe, expect, it } from "vitest";

import {
  INGEST_EVENT_KINDS,
  SUBMISSION_EVENT_KINDS,
  isIngestEvent,
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
