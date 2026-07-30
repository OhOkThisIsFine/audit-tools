import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findBrokenLinks, normalizeTarget } from "../../scripts/check-doc-links.mjs";

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "doc-link-gate-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel, text) {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, text, "utf8");
  return rel;
}

describe("normalizeTarget", () => {
  it("strips an anchor fragment", () => {
    expect(normalizeTarget("../spec/foo.md#the-cut")).toBe("../spec/foo.md");
  });

  it("strips this repo's :<line> citation suffix", () => {
    expect(normalizeTarget("../../src/foo.ts:247")).toBe("../../src/foo.ts");
    expect(normalizeTarget("../../src/foo.ts:247-260")).toBe("../../src/foo.ts");
  });

  it("leaves a plain path alone", () => {
    expect(normalizeTarget("backlog/deferred.md")).toBe("backlog/deferred.md");
  });
});

describe("findBrokenLinks", () => {
  it("RED: reports a link that escapes the repo root", () => {
    // The exact HEAD defect: a docs/ file linking ../../spec/x.md climbs one
    // level too far and lands outside the repo.
    write("spec/backend-identity-axes.md", "# axes\n");
    const doc = write(
      "docs/HANDOFF.md",
      "see [axes](../../spec/backend-identity-axes.md) for the design of record\n",
    );

    const broken = findBrokenLinks(root, [doc, "spec/backend-identity-axes.md"]);

    expect(broken).toHaveLength(1);
    expect(broken[0].file).toBe("docs/HANDOFF.md");
    expect(broken[0].target).toBe("../../spec/backend-identity-axes.md");
  });

  it("RED: reports the outbound links a doc MOVE left behind", () => {
    // spec/backlog-remediation-design.md moved out of docs/ and kept linking
    // backlog.md as though it were still a sibling.
    write("docs/backlog.md", "# backlog\n");
    const doc = write(
      "spec/backlog-remediation-design.md",
      "tracked against [backlog.md](backlog.md) and [HANDOFF.md](HANDOFF.md)\n",
    );

    const broken = findBrokenLinks(root, [doc, "docs/backlog.md"]);

    expect(broken.map((b) => b.target)).toEqual(["backlog.md", "HANDOFF.md"]);
  });

  it("GREEN: the same links pass once rebased to the real target", () => {
    write("spec/backend-identity-axes.md", "# axes\n");
    write("docs/backlog.md", "# backlog\n");
    const a = write("docs/HANDOFF.md", "[axes](../spec/backend-identity-axes.md)\n");
    const b = write("spec/backlog-remediation-design.md", "[backlog](../docs/backlog.md)\n");

    expect(findBrokenLinks(root, [a, b])).toEqual([]);
  });

  it("GREEN: does not flag absolute URLs, anchors, or host paths", () => {
    const doc = write(
      "docs/x.md",
      [
        "[web](https://example.com/nope)",
        "[mail](mailto:someone@example.com)",
        "[section](#the-cut)",
        "[host](~/.claude/CLAUDE.md)",
      ].join("\n"),
    );

    expect(findBrokenLinks(root, [doc])).toEqual([]);
  });

  it("GREEN: accepts a citation carrying a :<line> suffix", () => {
    write("src/foo.ts", "export const x = 1;\n");
    const doc = write("docs/reviews/r.md", "[foo.ts](../../src/foo.ts:247)\n");

    expect(findBrokenLinks(root, [doc])).toEqual([]);
  });

  it("RED: a :<line> citation whose FILE is gone is still reported", () => {
    const doc = write("docs/reviews/r.md", "[gone.ts](../../src/gone.ts:247)\n");

    const broken = findBrokenLinks(root, [doc]);

    expect(broken).toHaveLength(1);
    expect(broken[0].resolvesTo).toBe("src/gone.ts");
  });
});
