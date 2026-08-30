// The ONE splice contract test (F1 + F8, ceremony review 2026-08-29): the
// generated-artifact substrate owns the splice, so its refusals are pinned
// once here instead of once per generator — four private splice copies each
// carried their own "missing pair" / "duplicated pair" tests before the
// substrate landed.
import { describe, expect, it } from "vitest";
import { spliceGeneratedBlock } from "../../scripts/shared/generatedArtifacts.mjs";

const M = { begin: "<!-- BEGIN X -->", end: "<!-- END X -->", target: "doc.md" };
const page = `pre\n${M.begin}\nold\n${M.end}\npost\n`;
const block = `${M.begin}\nnew\n${M.end}`;

describe("spliceGeneratedBlock — the one splice", () => {
  it("replaces only the delimited block, leaving every other byte untouched", () => {
    expect(spliceGeneratedBlock(page, block, M)).toBe(`pre\n${block}\npost\n`);
  });

  it("refuses a page with no marker pair rather than silently appending", () => {
    expect(() => spliceGeneratedBlock("no markers here\n", block, M)).toThrow(
      /missing its generated-block markers/,
    );
  });

  it("refuses out-of-order markers", () => {
    expect(() => spliceGeneratedBlock(`${M.end}\nmiddle\n${M.begin}\n`, block, M)).toThrow(
      /missing its generated-block markers/,
    );
  });

  it("refuses a duplicated pair rather than choosing one block", () => {
    expect(() => spliceGeneratedBlock(page + page, block, M)).toThrow(
      /multiple generated-block marker pairs/,
    );
  });

  it("validateBlock refuses marker-shaped replacement content", () => {
    expect(() =>
      spliceGeneratedBlock(page, `${block}\ntrailing after end`, { ...M, validateBlock: true }),
    ).toThrow(/exactly one outer marker pair/);
    expect(() =>
      spliceGeneratedBlock(page, `leading ${block}`, { ...M, validateBlock: true }),
    ).toThrow(/exactly one outer marker pair/);
    expect(() =>
      spliceGeneratedBlock(page, `${M.begin}\n${M.begin}\nx\n${M.end}`, { ...M, validateBlock: true }),
    ).toThrow(/exactly one outer marker pair/);
  });

  it("foreignMarkers refuses a block invading another generated slot", () => {
    expect(() =>
      spliceGeneratedBlock(page, `${M.begin}\n<!-- OTHER SLOT -->\n${M.end}`, {
        ...M,
        foreignMarkers: ["<!-- OTHER SLOT -->"],
      }),
    ).toThrow(/owned by another generated slot/);
  });
});
