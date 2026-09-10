// Contract test for check:agents-region (P64, owner decision 2026-09-10).
//
// The property: the ONE generated region in this tree whose generator lives
// outside the repository is still watched by something. `check:generated-artifacts`
// reconciles TRACKED generators against declared freshness authorities, and
// `~/.agent-config/sync.mjs` is not tracked here — so before this gate, a
// CLAUDE.md edit that left AGENTS.md holding the old size was noticed by nobody.
// It cost three catch-up commits and two consecutive nightly runs.
//
// The check is EXACT because in pointer mode the printed byte length is the only
// CLAUDE.md-derived input to the region body: equal figure = fresh, different
// figure = stale. These cases pin both polarities and both refusal shapes.
import { describe, expect, test } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  POINTER_SENTENCE,
  actualPointerKb,
  statedPointerKb,
  validateAgentsRegion,
} from "../../scripts/check-agents-region.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

const sentence = (kb: string) =>
  `\`CLAUDE.md\` is the canonical instruction file for this repository. It is ${kb} KB,\n` +
  `so this file points at it instead of repeating it.`;

describe("check:agents-region — the untracked generator's region has a freshness authority", () => {
  test("a stated size equal to the real size is fresh", () => {
    expect(validateAgentsRegion({ agentsText: sentence("38.5"), claudeBytes: 39431 })).toEqual({
      ok: true,
    });
  });

  test("a stale stated size is refused, naming both figures and the remedy", () => {
    const verdict = validateAgentsRegion({ agentsText: sentence("38.3"), claudeBytes: 39431 });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("38.3");
    expect(verdict.reason).toContain("38.5");
    expect(verdict.reason).toContain("sync.mjs");
  });

  test("a region with no pointer sentence fails closed rather than passing vacuously", () => {
    // The machine-wide half of the P64 decision may retire this sentence. A
    // missing sentence must be loud — a green check over an unrecognized region
    // is the exact false-green this gate exists to remove.
    const verdict = validateAgentsRegion({
      agentsText: "<!-- shared:start -->\n<!-- shared:end -->\n",
      claudeBytes: 39431,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("no generated pointer sentence");
  });

  test("the size arithmetic is the generator's own (bytes/1024, one decimal)", () => {
    expect(actualPointerKb(39431)).toBe("38.5");
    expect(actualPointerKb(1024)).toBe("1.0");
    expect(statedPointerKb(sentence("38.5"))).toBe("38.5");
    expect(statedPointerKb("no sentence here")).toBeNull();
    // A whole-number size still carries the generator's forced decimal, so a
    // rounded form ("39 KB") cannot masquerade as fresh.
    expect(POINTER_SENTENCE.test(sentence("39"))).toBe(false);
  });

  test("the REAL tree is fresh — the gate and this test agree about the tracked pair", () => {
    const verdict = validateAgentsRegion({
      agentsText: readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8"),
      claudeBytes: statSync(join(REPO_ROOT, "CLAUDE.md")).size,
    });
    expect(verdict.ok, verdict.reason ?? "").toBe(true);
  });
});
