/**
 * ANSWERED is not DONE.
 *
 * The nightly ledger recorded a determination as `settled` the moment the owner
 * replied, and `--list` reported only UNANSWERED items. Nothing checked that the
 * answered work existed, and a settled subject is never re-raised — so on
 * 2026-07-28 the queue said "No open nightly items" while twelve answers had no
 * corresponding change anywhere in the tree. They were invisible, not pending.
 *
 * Two more shapes this pins:
 *   - a `question` disposition (an answer that asks something BACK) must NOT
 *     settle the subject: there is nothing executable in it.
 *   - subjects answered BEFORE completion tracking existed are counted, never
 *     enumerated as outstanding — listing them as work is a false RED, which
 *     trains the reader to skip the list exactly like the false GREEN did.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  recordDecision,
  recordCompletion,
  answeredNotDone,
  partitionBySettled,
  readDecisions,
  subjectKey,
  COMPLETION_TRACKING_SINCE,
} = await import("../../scripts/nightly/items.mjs");

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nightly-ledger-"));
  mkdirSync(join(root, ".claude"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Write a decisions ledger directly, so `decided_at` can be controlled. */
function seed(entries) {
  writeFileSync(join(root, ".claude/nightly-decisions.json"), JSON.stringify(entries, null, 2), "utf8");
}

describe("answeredNotDone — the class the ledger used to hide", () => {
  it("reports a settled subject with no completion record as ACTIONABLE", () => {
    seed({
      k1: { disposition: "settled", answer: "do it", subject: "s", path: "p", decided_at: "2026-07-28T10:00:00Z" },
    });
    const { actionable, grandfathered } = answeredNotDone(readDecisions(root));
    expect(actionable.map((d) => d.key)).toEqual(["k1"]);
    expect(grandfathered).toEqual([]);
  });

  it("drops it from ACTIONABLE once completion is recorded", () => {
    seed({
      k1: { disposition: "settled", answer: "do it", subject: "s", path: "p", decided_at: "2026-07-28T10:00:00Z" },
    });
    recordCompletion(root, "k1", "abc1234 — landed");
    const { actionable } = answeredNotDone(readDecisions(root));
    expect(actionable).toEqual([]);
    expect(readDecisions(root).k1.completed_ref).toBe("abc1234 — landed");
    expect(readDecisions(root).k1.completed_at).toBeTruthy();
  });

  it("never counts a `wontfix` — there is no work to land", () => {
    seed({
      k1: { disposition: "wontfix", answer: "not doing it", decided_at: "2026-07-28T10:00:00Z" },
    });
    expect(answeredNotDone(readDecisions(root)).actionable).toEqual([]);
  });

  it("never counts a `question` — it belongs in the OPEN list, not this one", () => {
    seed({
      k1: { disposition: "question", answer: "what did you mean?", decided_at: "2026-07-28T10:00:00Z" },
    });
    expect(answeredNotDone(readDecisions(root)).actionable).toEqual([]);
  });

  it("GRANDFATHERS anything answered before completion tracking began", () => {
    seed({
      old: { disposition: "settled", answer: "a", subject: "s", decided_at: "2026-07-01T10:00:00Z" },
      now: { disposition: "settled", answer: "b", subject: "s", decided_at: `${COMPLETION_TRACKING_SINCE}T10:00:00Z` },
    });
    const { actionable, grandfathered } = answeredNotDone(readDecisions(root));
    expect(actionable.map((d) => d.key)).toEqual(["now"]);
    expect(grandfathered.map((d) => d.key)).toEqual(["old"]);
  });

  it("treats a MALFORMED decided_at as old — a bad record must not manufacture work", () => {
    seed({
      bad: { disposition: "settled", answer: "a", subject: "s" },
      alsoBad: { disposition: "settled", answer: "a", subject: "s", decided_at: 12345 },
    });
    const { actionable, grandfathered } = answeredNotDone(readDecisions(root));
    expect(actionable).toEqual([]);
    expect(grandfathered).toHaveLength(2);
  });
});

describe("recordCompletion — landing is separate from answering", () => {
  it("refuses a key that was never settled, rather than inventing an entry", () => {
    seed({});
    expect(() => recordCompletion(root, "nope", "ref")).toThrow(/no settled subject/);
  });

  it("a RE-ANSWER does not silently un-land work that already shipped", () => {
    seed({
      k1: { disposition: "settled", answer: "v1", subject: "s", path: "p", decided_at: "2026-07-28T10:00:00Z" },
    });
    recordCompletion(root, "k1", "abc1234");
    recordDecision(root, "k1", { answer: "v2 — clarified", disposition: "settled", subject: "s", path: "p" });
    const after = readDecisions(root).k1;
    expect(after.answer).toBe("v2 — clarified");
    expect(after.completed_ref, "completion must survive a re-answer").toBe("abc1234");
    expect(answeredNotDone(readDecisions(root)).actionable).toEqual([]);
  });
});

describe("partitionBySettled — a counter-question is still open", () => {
  const item = (key) => ({ id: "docs-1", subject_key: key, title: "t", path: "p", leg: "docs", nights_open: 1 });

  it("a `settled` decision closes the item", () => {
    const k = subjectKey("p", "t");
    const { open, settled } = partitionBySettled([item(k)], { [k]: { disposition: "settled" } });
    expect(open).toEqual([]);
    expect(settled).toHaveLength(1);
  });

  it("a `question` decision leaves the item OPEN so it is asked again", () => {
    const k = subjectKey("p", "t");
    const { open, settled } = partitionBySettled([item(k)], { [k]: { disposition: "question" } });
    expect(open, "an answer that asks back is not an answer").toHaveLength(1);
    expect(settled).toEqual([]);
  });

  it("a `wontfix` decision closes the item", () => {
    const k = subjectKey("p", "t");
    const { open } = partitionBySettled([item(k)], { [k]: { disposition: "wontfix" } });
    expect(open).toEqual([]);
  });
});
