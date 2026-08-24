// Drift test for the generated installer-verb block in
// `docs/audit-pkg/product.md`, the render `check:cli-surface` gates.
//
// The gate itself re-runs the generator against the tree, so it catches a stale
// block. What it cannot catch is the generator drifting away from the
// DECLARATION it renders — `wrapper/installer-verb-help.mjs`, the same module
// both shipped bins answer `<verb> --help` from. A render that silently dropped
// a verb, or spelled a summary the bins do not print, would still be
// self-consistent and the gate would stay green: exactly the defect the block
// replaced, where product.md named two of four verbs and operator-guide.md
// three.
//
// So this asserts the render against the declaration rather than against
// itself, and pins the splice refusals — a missing or duplicated marker pair
// must fail loudly instead of picking a block.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  BEGIN_MARKER,
  END_MARKER,
  RENDER_FILE,
  SOURCE_FILE,
  renderCliSurface,
  spliceCliSurface,
} from "../../scripts/shared/generate-cli-surface.mjs";
import { INSTALLER_VERBS, installerVerbSummary } from "../../wrapper/installer-verb-help.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const PRODUCT = "/audit-code";

const renderedBlock: string = renderCliSurface();
const pageText = readFileSync(join(REPO_ROOT, RENDER_FILE), "utf8").replace(/\r\n/g, "\n");

describe("the product page's installer-verb block is rendered, not restated", () => {
  it("matches the block currently in the page", () => {
    expect(spliceCliSurface(pageText, renderedBlock)).toBe(pageText);
  });

  it("renders every declared verb with the summary the bins print", () => {
    for (const verb of INSTALLER_VERBS) {
      expect(renderedBlock).toContain(`- \`audit-code ${verb}\` — ${installerVerbSummary(verb, PRODUCT)}`);
    }
    const rendered = [...renderedBlock.matchAll(/^- `audit-code ([a-z-]+)`/gm)].map((match) => match[1]);
    expect(rendered).toEqual([...INSTALLER_VERBS]);
  });

  it("names the declaration it renders from and the page it renders into", () => {
    expect(SOURCE_FILE).toBe("wrapper/installer-verb-help.mjs");
    expect(RENDER_FILE).toBe("docs/audit-pkg/product.md");
    expect(renderedBlock).toContain(SOURCE_FILE);
    expect(renderedBlock.startsWith(BEGIN_MARKER)).toBe(true);
    expect(renderedBlock.endsWith(END_MARKER)).toBe(true);
  });

  it("refuses to splice a page with no marker pair, or with more than one", () => {
    expect(() => spliceCliSurface("# Product\n\nno markers here\n", renderedBlock)).toThrow(
      /missing the generated CLI-surface markers/,
    );
    expect(() => spliceCliSurface(`${pageText}\n${BEGIN_MARKER}\n${END_MARKER}\n`, renderedBlock)).toThrow(
      /multiple CLI-surface markers/,
    );
  });
});
