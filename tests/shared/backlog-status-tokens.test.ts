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
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { findStatusMarkers, STATUS_WORDS, STATUS_GLYPHS } from "../../scripts/check-backlog-status-tokens.mjs";
import {
  ACCEPTED_TAG_FORMS,
  evaluateFrictionTags,
  findFrictionTags,
} from "../../scripts/check-backlog-friction-tags.mjs";
import { FRICTION_CATEGORIES } from "../../scripts/shared/friction-categories.generated.mjs";

const hits = (text: string): number => findStatusMarkers(text).length;
const ROOT = resolve(import.meta.dirname, "..", "..");
const BACKLOG_DIR = join(ROOT, "docs", "backlog");

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

/**
 * The `friction:` tag is the field a closeout walk or a triage sweep GROUPS BY, and
 * nothing read it while five off-vocabulary tags — `false_red`, `false_green`,
 * `hermeticity`, `tooling_gap`, `missing_affordance`, plus two bare descriptors —
 * accumulated in the backlog. The vocabulary itself was never the problem: it existed
 * in the TypeScript source and in the close-out gate, both in step. What was missing
 * was anything that read the TAGS against it, which is this.
 *
 * The cases are weighted toward the ACCEPT side, for the same reason the guard's own
 * header gives: a gate that fires on prose gets disabled, and a disabled gate guards
 * nothing. Only a `friction:` tag is a tag; the word in a sentence is not.
 */
describe("backlog friction-tag vocabulary", () => {
  const tagsIn = (text: string) => findFrictionTags("probe.md", text).map((hit) => hit.tag);

  test("the accepted spellings are DERIVED from the canonical categories, never listed", () => {
    // The failure mode of every allowlist: a category is added to the source and
    // this gate quietly keeps refusing its tag. Nothing here names a category.
    expect(ACCEPTED_TAG_FORMS.size).toBe(FRICTION_CATEGORIES.length * 2);
    for (const category of FRICTION_CATEGORIES) {
      expect(ACCEPTED_TAG_FORMS.get(category)).toBe(category);
      expect(ACCEPTED_TAG_FORMS.get(category.replace(/_/g, "-"))).toBe(category);
    }
  });

  test("a canonical tag is accepted in either spelling", () => {
    for (const category of FRICTION_CATEGORIES) {
      expect(tagsIn(`- **X (2026-09-10, low, friction: ${category}).** prose`)).toEqual([category]);
      expect(
        evaluateFrictionTags([
          { file: "probe.md", text: `- **X (2026-09-10, low, friction: ${category}).** prose` },
        ]).violations,
      ).toEqual([]);
    }
  });

  test("an off-vocabulary tag is red, and the refusal names the entry and the vocabulary", () => {
    const text = "- **X (2026-09-10, low, friction: false_red).** prose";
    const result = evaluateFrictionTags([{ file: "probe.md", text }]);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("friction: false_red");
    // The entry the tag sits in, per the SHARED grammar, so the writer knows which
    // of the file's entries to edit.
    expect(result.violations[0]).toContain("entry: X (2026-09-10, low, friction: false_red).");
    for (const category of FRICTION_CATEGORIES) expect(result.violations[0]).toContain(category);
  });

  test("a near-miss of a canonical id is refused, not silently mapped", () => {
    // A fuzzy match here would BE the drift this gate exists to catch.
    for (const tag of ["tool_should_decides", "inefficient", "tool", "false_green", "ambiguous"]) {
      expect(evaluateFrictionTags([{ file: "probe.md", text: `- **X (friction: ${tag}).**` }]).violations)
        .toHaveLength(1);
    }
  });

  test("the word in prose is not a tag — only the `friction:` form is", () => {
    // The corpus legitimately discusses friction; refusing the bare word would make
    // this a tax on writing, which is how these gates die.
    expect(tagsIn("- The tool-should-decide class is described at length here.")).toEqual([]);
    expect(tagsIn("- Our friction with the analyzer: it re-runs npx.")).toEqual([]);
    // A tag holds one word, so a `friction:` followed by prose is a sentence, not a
    // tag — and a narrative that starts one deliberately stays quiet.
    expect(tagsIn("- Our friction: the analyzer re-runs npx every time.")).toEqual([]);
    // …while both closed forms ARE tags: the parenthetical member and line end.
    expect(tagsIn("- **X (friction: tool_should_decide).** prose")).toEqual(["tool_should_decide"]);
    expect(tagsIn("- **X (2026-09-10, low, friction: inequity).**")).toEqual(["inequity"]);
    // A tag QUOTED in a fenced block is a citation of the vocabulary, not a use of it.
    expect(
      tagsIn(["```md", "- **X (friction: false_red).** sample", "```"].join("\n")),
    ).toEqual([]);
  });

  test("a tag is attributed to the entry the shared grammar says owns its line", () => {
    const text = [
      "- **First entry (2026-09-10, low, friction: tool_should_decide).** prose",
      "  wrapped line",
      "",
      "- **Second entry (2026-09-10, low, friction: false_red).** prose",
    ].join("\n");
    const hits = findFrictionTags("probe.md", text);
    expect(hits).toHaveLength(2);
    expect(hits[0]?.entry).toContain("First entry");
    expect(hits[1]?.entry).toContain("Second entry");
  });

  test("the live backlog is clean and every tag it carries is counted", () => {
    const files = readdirSync(BACKLOG_DIR)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => ({ file: f, text: readFileSync(join(BACKLOG_DIR, f), "utf8") }));
    const result = evaluateFrictionTags(files);
    expect(result.violations, result.violations.join("\n")).toEqual([]);
    // A vacuous pass would be a gate guarding nothing: the corpus DOES carry tags.
    expect(result.tags).toBeGreaterThan(20);
  });
});
