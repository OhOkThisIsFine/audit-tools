// Drift test for the generated result-ingestion check block in
// `docs/audit-pkg/contracts.md`, the render `check:ingestion-checks` gates.
//
// The defect this pins (nightly item l1-4, owner decision 2026-09-05): the set of
// checks ingestion performs before accepting a host result was enumerated by hand
// in THREE docs — contracts.md, operator-guide.md, and the concurrent-runs design —
// and the three lists disagreed (only one named the result path, only one the
// strict result schema, only one the workload version). Nothing reconciled them.
//
// The fix is declared data: `INGESTION_CHECKS` (src/shared/submission/
// ingestionChecks.ts) is the ONE list, both host-handoff twins cite a check id on
// every refusal they emit, the block in contracts.md is RENDERED from the
// registry, and the other two docs state the property and point at the block.
//
// So this asserts (1) the render against the declaration rather than against
// itself, (2) the tracked page carries exactly that render, (3) the two former
// copies are pointers now, and (4) the registry is load-bearing: every check a
// draw declares is cited by that draw's ingestion source, and no draw cites a
// check it does not declare. (4) is what stops the registry from becoming a
// fourth prose copy — a row nothing cites is dead, and a citation nothing
// declares is an undocumented check.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BEGIN_MARKER,
  END_MARKER,
  RENDER_FILE,
  SOURCE_FILE,
  POINTER_FILES,
  extractCitedIngestionChecks,
  renderIngestionChecks,
} from "../../scripts/shared/generate-ingestion-checks.mjs";
import {
  INGESTION_CHECKS,
  INGESTION_DRAWS,
  INGESTION_SHARED_SOURCE,
  ingestionCheckIdsCitedBy,
  ingestionCheckIdsFor,
} from "../../src/shared/submission/ingestionChecks.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const read = (relative: string): string => readFileSync(join(repoRoot, relative), "utf8");

const renderedBlock: string = renderIngestionChecks();

/** The hand-enumeration shape all three docs carried before the block existed. */
const HAND_ENUMERATION = /run id, work-item id, prompt digest/;

describe("the ingestion check set is rendered from INGESTION_CHECKS, not restated", () => {
  it("renders every declared check with its id, what it verifies, and the draws it binds", () => {
    expect(INGESTION_CHECKS.length).toBeGreaterThan(0);
    for (const check of INGESTION_CHECKS) {
      expect(renderedBlock).toContain(`\`${check.id}\``);
      expect(renderedBlock).toContain(check.verifies);
    }
    const rendered = [...renderedBlock.matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1]);
    expect(rendered).toEqual(INGESTION_CHECKS.map((check) => check.id));
  });

  it("names the declaration it renders from and the page it renders into", () => {
    expect(SOURCE_FILE).toBe("src/shared/submission/ingestionChecks.ts");
    expect(RENDER_FILE).toBe("docs/audit-pkg/contracts.md");
    expect(renderedBlock).toContain(SOURCE_FILE);
    expect(renderedBlock.startsWith(BEGIN_MARKER)).toBe(true);
    expect(renderedBlock.endsWith(END_MARKER)).toBe(true);
  });

  it("the tracked contracts page carries exactly the current render", () => {
    const page = read(RENDER_FILE);
    const begin = page.indexOf(BEGIN_MARKER);
    const end = page.indexOf(END_MARKER);
    expect(begin, `${RENDER_FILE} carries no ${BEGIN_MARKER}`).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(begin);
    expect(page.slice(begin, end + END_MARKER.length)).toBe(renderedBlock);
    expect(page.replace(renderedBlock, "")).not.toMatch(HAND_ENUMERATION);
  });

  it("the two former copies point at the block instead of enumerating the checks", () => {
    expect(POINTER_FILES.length).toBe(2);
    for (const relative of POINTER_FILES) {
      const text = read(relative);
      expect(text, `${relative} still hand-enumerates the check set`).not.toMatch(HAND_ENUMERATION);
      expect(text, `${relative} does not point at the rendered block`).toContain("contracts.md");
    }
  });
});

describe("INGESTION_CHECKS is load-bearing: every declared check is cited where it says it is, and only there", () => {
  it("the shared submission scan cites exactly the shared-cited checks", () => {
    const cited = extractCitedIngestionChecks(read(INGESTION_SHARED_SOURCE));
    expect([...cited].sort()).toEqual([...ingestionCheckIdsCitedBy("shared")].sort());
  });

  for (const draw of INGESTION_DRAWS) {
    it(`the ${draw.id} draw cites exactly the draw-cited checks it declares`, () => {
      const cited = extractCitedIngestionChecks(read(draw.source));
      const declared = ingestionCheckIdsCitedBy("draw", draw.id);
      expect([...cited].sort(), `${draw.source} cites checks it does not declare, or omits declared ones`).toEqual(
        [...declared].sort(),
      );
    });

    it(`every check the ${draw.id} draw declares is either shared-cited or draw-cited`, () => {
      const all = ingestionCheckIdsFor(draw.id);
      const covered = new Set([...ingestionCheckIdsCitedBy("shared", draw.id), ...ingestionCheckIdsCitedBy("draw", draw.id)]);
      expect([...all].sort()).toEqual([...covered].sort());
    });
  }

  it("check ids are unique and declare at least one draw", () => {
    const ids = INGESTION_CHECKS.map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const check of INGESTION_CHECKS) expect(check.draws.length).toBeGreaterThan(0);
  });
});
