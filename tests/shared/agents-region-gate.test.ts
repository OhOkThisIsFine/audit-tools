import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateAgentsRegion } from "../../scripts/check-agents-region.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const pointer = '> **Start with [`CLAUDE.md`](CLAUDE.md).** Canonical instructions live there.\n';

describe("check:agents-region — stable canonical instruction pointer", () => {
  test("the same pointer remains valid after the canonical instructions change", () => {
    for (const claudeText of ["Original rules", "Different, longer rules".repeat(3000)]) {
      expect(validateAgentsRegion({ agentsText: pointer, claudeText })).toEqual({ ok: true });
    }
  });

  test("missing, commented, fenced or wrong-target opening links refuse", () => {
    for (const agentsText of ["No pointer", `<!-- ${pointer} -->`, `\`\`\`md\n${pointer}\`\`\``, "Read [rules](../CLAUDE.md)", "Read [rules](OTHER.md)"]) {
      const result = validateAgentsRegion({ agentsText, claudeText: "Live rules" });
      expect(result.ok, agentsText).toBe(false);
      expect(result.reason).toContain("repo-local CLAUDE.md");
    }
  });

  test("a valid pointer cannot certify a missing or empty canonical file", () => {
    for (const claudeText of [undefined, "", " \n\t"]) {
      const result = validateAgentsRegion({ agentsText: pointer, claudeText });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("missing or empty");
    }
  });

  test("external sync metadata is not an instruction freshness authority", () => {
    // A machine-global sync may append metadata later; its opaque marker and
    // historical size do not decide whether the live canonical file is read.
    expect(validateAgentsRegion({
      agentsText: pointer + "\n<!-- shared:start -->\nshared-region-id: old\nIt is 1.0 KB\n<!-- shared:end -->",
      claudeText: "Current live instructions",
    })).toEqual({ ok: true });
  });

  test("the real tree opens with the live canonical instruction pointer", () => {
    const result = validateAgentsRegion({
      agentsText: readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8"),
      claudeText: readFileSync(join(REPO_ROOT, "CLAUDE.md"), "utf8"),
    });
    expect(result.ok, result.reason ?? "").toBe(true);
  });
});
