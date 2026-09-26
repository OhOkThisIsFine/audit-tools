// T75 (durable-traps, hit 2026-08-13): `docs/backlog.md` is not a record path to
// `writeOpenItems` but `docs/backlog/*` is, and nothing about the two filenames
// signals which side an item falls on — so authoring against the router file was
// a guess-then-retry. The enforceable half is a `recordPathHint(file)` export the
// author can read UP FRONT, and the classification must agree across Windows and
// POSIX spellings of the same path (a probe written with backslashes classifies
// identically to one written with forward slashes).
//
// `isRecordPath` and `recordPathHint` are pure (no git, no fs), so this test
// needs no fixture repo.
import { describe, expect, it } from "vitest";

import { isRecordPath, recordPathHint } from "../../scripts/nightly/items.mjs";

describe("record-path classification agrees across platforms and up front", () => {
  // The split item files are record paths; the router file one directory up is not.
  it("classifies docs/backlog/* as record paths and docs/backlog.md as a source path", () => {
    expect(isRecordPath("docs/backlog/open-bugs.md")).toBe(true);
    expect(isRecordPath("docs/backlog.md")).toBe(false);
  });

  it("classifies the same path identically under Windows and POSIX spellings", () => {
    const pairs: Array<[string, string]> = [
      ["docs\\backlog\\open-bugs.md", "docs/backlog/open-bugs.md"],
      ["docs\\backlog.md", "docs/backlog.md"],
      ["docs\\reviews\\run.md", "docs/reviews/run.md"],
      [".\\docs\\backlog\\x.md", "docs/backlog/x.md"],
      [".claude\\skills\\s\\SKILL.md", ".claude/skills/s/SKILL.md"],
      [".claude\\hooks\\gate.mjs", ".claude/hooks/gate.mjs"],
    ];
    for (const [win, posix] of pairs) {
      expect(isRecordPath(win), `${win} vs ${posix}`).toBe(isRecordPath(posix));
    }
  });

  it("the .claude/hooks carve-out is a source path, the rest of .claude is a record path", () => {
    expect(isRecordPath(".claude/hooks/gate.mjs")).toBe(false);
    expect(isRecordPath(".claude/skills/s/SKILL.md")).toBe(true);
    expect(isRecordPath(".claude/nightly-decisions.json")).toBe(true);
  });

  it("recordPathHint returns the author-facing classification matching isRecordPath", () => {
    expect(recordPathHint("docs/backlog/open-bugs.md")).toBe("record path");
    expect(recordPathHint("docs/backlog.md")).toBe("source path");
    expect(recordPathHint("src/audit/cli.ts")).toBe("source path");
    expect(recordPathHint(".claude/hooks/gate.mjs")).toBe("source path");
    expect(recordPathHint("docs\\backlog\\open-bugs.md")).toBe("record path");
  });

  it("recordPathHint classifies an empty target as 'not a path'", () => {
    expect(recordPathHint("")).toBe("not a path");
    expect(recordPathHint(undefined)).toBe("not a path");
  });
});
