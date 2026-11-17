/**
 * backlog-status-tokens.test.mjs — the guard that keeps the backlog a to-do list.
 *
 * Every `docs/backlog/` file's header says the same thing: "A living to-do list, not
 * a status log. Remove an entry once it ships." The rule was written down and then
 * violated anyway — five `SHIPPED` markers accumulated in one entry — which is the
 * repo's standing lesson that a rule nothing enforces is a rule that decays.
 *
 * The hard part is NOT detecting the word. It is separating a status MARKER from
 * ordinary prose that happens to contain the same word, because a guard that fires
 * on prose gets disabled, and a disabled guard protects nothing. The guard's first
 * draft did exactly that: a naive "line opens with a status word" rule produced five
 * false positives on this corpus, every one a hard-wrapped continuation line.
 *
 * So the cases below are weighted toward the NEGATIVE side on purpose. Each positive
 * pins a marker form that was actually found in the backlog; each negative pins a
 * prose form that must never fire.
 */
import { describe, test, expect } from "vitest";
import { findStatusMarkers, STATUS_WORDS, STATUS_GLYPHS } from "../../scripts/check-backlog-status-tokens.mjs";

const hits = (text: string): number => findStatusMarkers(text).length;

describe("backlog status-token guard — marker forms FIRE", () => {
  test("a status glyph on a stage bullet", () => {
    expect(hits("- **Stage 1** — ✅ **SHIPPED 2026-07-19.** Renamed the chokepoint.")).toBeGreaterThan(0);
  });
  test("a bare status glyph with no word", () => {
    expect(hits("- ✅ the migration landed")).toBeGreaterThan(0);
    expect(hits("- ❌ declined")).toBeGreaterThan(0);
  });
  test("an ALL-CAPS status word opening an emphasis run, with no glyph", () => {
    // The form the glyph rule alone would miss.
    expect(hits("- **SHIPPED 2026-07-20** — the axis grammar.")).toBeGreaterThan(0);
    expect(hits("- _FIXED_ in the rolling driver.")).toBeGreaterThan(0);
  });
  test("a status word opening a block", () => {
    expect(hits("- DONE: the guard is wired.")).toBeGreaterThan(0);
    expect(hits("\n\nRESOLVED — the owner picked the floor.")).toBeGreaterThan(0);
  });
});

describe("backlog status-token guard — prose must STAY QUIET", () => {
  test("lowercase emphasis is prose, not a stamp", () => {
    // Case is the discriminator: a stamp is ALL CAPS at the head of the run.
    expect(hits("Entries are **shipped** one at a time.")).toBe(0);
    expect(hits("a *shipped* artifact still needs a home")).toBe(0);
  });
  test("a status word mid-sentence never fires, even in caps", () => {
    expect(hits("- The entry says the fix SHIPPED, but tracing shows otherwise.")).toBe(0);
  });
  test("a hard-wrapped continuation line is not a block start", () => {
    // The five false positives the guard's first draft produced. Prose WRAPS;
    // a label never does, which is why position is the discriminator.
    expect(hits("- The migration stage was reviewed and\n  SHIPPED before the gate existed.")).toBe(0);
  });
  test("a status word inside inline code is a citation, not a marker", () => {
    expect(hits("- grep for `✅ SHIPPED` to find the stale markers")).toBe(0);
  });
  test("a fenced block is skipped", () => {
    expect(hits("- example:\n\n```md\n- ✅ **SHIPPED** sample\n```\n")).toBe(0);
  });
  test("a status word used as an adjective is left alone", () => {
    expect(hits("- the fixed-width column")).toBe(0);
  });
});

describe("backlog status-token guard — the live backlog is clean", () => {
  test("every configured word and glyph is actually checked", () => {
    // Guards against a word being dropped from the list and the gate quietly
    // narrowing — the failure mode of every allowlist.
    expect(STATUS_WORDS.length).toBeGreaterThan(0);
    expect(STATUS_GLYPHS.length).toBeGreaterThan(0);
    for (const word of STATUS_WORDS) {
      expect(hits(`- **${word}** — probe.`), `${word} must be detected`).toBeGreaterThan(0);
    }
    for (const glyph of STATUS_GLYPHS) {
      expect(hits(`- ${glyph} probe`), `${glyph} must be detected`).toBeGreaterThan(0);
    }
  });
});
