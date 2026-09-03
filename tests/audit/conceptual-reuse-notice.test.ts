import { CHARTER_REGISTER_SCHEMA_VERSION } from "../../src/audit/types/charterRegister.js";
/**
 * Tests for renderReuseNotice helper (TST-4c8bd93a-3).
 * This test file covers the reuse notice generation for conceptual dispatch.
 */

import { test, describe, it, expect, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  prepareConceptualDispatch,
  renderReuseNotice,
  resolveConceptualReviewSettings,
} from "../../src/audit/cli/conceptualDispatch.js";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { IntentCheckpoint } from "audit-tools/shared";

test("renderReuseNotice: basic case with all fields", () => {
  const checkpoint: NonNullable<IntentCheckpoint["design_review"]> = {
    conceptual_depth: "deep",
    perspectives: 3,
  };
  const result = renderReuseNotice(checkpoint, "2026-08-06T10:30:00Z", { include: ["correctness"], exclude: ["performance"] }, "shallow");
  expect(result).toContain("2026-08-06T10:30:00Z");
  expect(result).toContain("correctness");
  expect(result).toContain("performance");
  expect(result).toContain("deep");
});

test("renderReuseNotice: degradation on missing confirmed_at", () => {
  const checkpoint: NonNullable<IntentCheckpoint["design_review"]> = {
    conceptual_depth: "shallow",
    perspectives: 1,
  };
  const result = renderReuseNotice(checkpoint, undefined, {}, "deep");
  expect(result).toContain("unknown");
  expect(result).toContain("all lenses");
});

test("renderReuseNotice: empty confirmed_at falls back to unknown", () => {
  const checkpoint: NonNullable<IntentCheckpoint["design_review"]> = {
    conceptual_depth: "deep",
    perspectives: 2,
  };
  const result = renderReuseNotice(checkpoint, "", { include: ["maintainability"] }, "shallow");
  expect(result).toContain("unknown");
  expect(result).toContain("maintainability");
});

test("renderReuseNotice: sorted lens inclusion and exclusion", () => {
  const checkpoint: NonNullable<IntentCheckpoint["design_review"]> = {
    conceptual_depth: "shallow",
    perspectives: 1,
  };
  const result = renderReuseNotice(
    checkpoint,
    "2026-08-06T10:30:00Z",
    { include: ["security", "correctness", "architecture"], exclude: ["performance", "maintainability"] },
    "shallow"
  );
  // Lenses should be sorted alphabetically in the output
  expect(result).toContain("+architecture,correctness,security");
  expect(result).toContain("-maintainability,performance");
});

test("renderReuseNotice: only include lenses", () => {
  const checkpoint: NonNullable<IntentCheckpoint["design_review"]> = {
    conceptual_depth: "deep",
    perspectives: 3,
  };
  const result = renderReuseNotice(checkpoint, "2026-08-06T10:30:00Z", { include: ["tests", "reliability"] }, "deep");
  expect(result).toContain("+reliability,tests");
  expect(result).not.toContain(" -");
});

test("renderReuseNotice: only exclude lenses", () => {
  const checkpoint: NonNullable<IntentCheckpoint["design_review"]> = {
    conceptual_depth: "shallow",
    perspectives: 1,
  };
  const result = renderReuseNotice(checkpoint, "2026-08-06T10:30:00Z", { exclude: ["operability"] }, "shallow");
  expect(result).toContain("-operability");
  expect(result).not.toContain("+");
  expect(result).not.toContain("all lenses"); // an exclusion filter IS a lens filter — "all lenses" renders only when both lists are empty
});

test("renderReuseNotice: checkpoint depth used when present", () => {
  const checkpoint: NonNullable<IntentCheckpoint["design_review"]> = {
    conceptual_depth: "deep",
    perspectives: 5,
  };
  const result = renderReuseNotice(checkpoint, "2026-08-06T10:30:00Z", {}, "shallow");
  expect(result).toContain("conceptual depth deep");
  expect(result).not.toContain("shallow");
});

test("renderReuseNotice: fallback to resolvedDepth when checkpoint depth absent", () => {
  const checkpoint: NonNullable<IntentCheckpoint["design_review"]> = {
    perspectives: 2,
  };
  const result = renderReuseNotice(checkpoint, "2026-08-06T10:30:00Z", {}, "deep");
  expect(result).toContain("conceptual depth deep");
});

// INV 11 (audit-artifact-promotion-lifecycle): the CONSUMER-ENTRY-POINT leg.
//
// conceptualDispatch reads two NESTED bundle paths by name —
// `intent_checkpoint.design_review` and `charter_register.subsystems[].charters`.
// The typechecker covers a rename within one build; it cannot see a bundle
// written in one phase and read back in another, which is exactly the position
// this consumer is in. So the entry point is driven here and both paths are
// asserted to resolve, alongside the field-set pin in io-remediation.test.ts.
test("INV 11: resolveConceptualReviewSettings resolves both nested bundle paths it reads by name", () => {
  const bundle = {
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: "2026-08-20T00:00:00Z",
      design_review: { conceptual_depth: "deep", perspectives: 2 },
    },
    charter_register: {
      schema_version: CHARTER_REGISTER_SCHEMA_VERSION,
      subsystems: [
        { name: "s", charters: [{ id: "c", confidence: "low" }] },
      ],
    },
  } as never;

  const settings = resolveConceptualReviewSettings(bundle);

  // Resolved through intent_checkpoint.design_review: a rename of that path
  // would silently drop the depth back to its "shallow" default.
  expect(
    settings.conceptual_depth,
    "conceptualDispatch reads intent_checkpoint.design_review.conceptual_depth by name",
  ).toBe("deep");
  expect(settings.perspectives).toBe(2);
  // Resolved through charter_register.subsystems[].charters: the low-confidence
  // charter must reach charterReviewDisposition. A rename of that path would
  // leave this undefined and silently stop flagging for a human.
  expect(
    settings.flag_for_human,
    "conceptualDispatch reads charter_register.subsystems[].charters by name",
  ).toBe(true);
  // And the notice derives from the same checkpoint, so its presence is a third
  // witness that the nested read resolved.
  expect(settings.reuse_notice).toBeDefined();
});

// COR-4c8bd93a (CP-NODE-20): a RESUMED deep fan-out narrows the INSTRUCTION
// surface — never the access declaration.
//
// prepareConceptualDispatch fetched `fanout.pendingLanes` and ignored it, so a
// round resumed after a partial delivery re-instructed every perspective lane,
// including ones whose submission was already on disk. The fix filters the
// step-1 narrative to the pending lanes (preserving each lane's ORIGINAL
// ordinal, so "Perspective 2" stays "Perspective 2" when "Perspective 1" is
// omitted) and renders an informational "N of M ... already delivered" notice —
// while writePaths/readPaths stay the full, stable per-round access declaration
// that conceptual-perspective-round-identity.test.ts pins.
//
// Driven through the real `prepareConceptualDispatch`; the delivered state is
// established the only way the production code can observe it — a submission
// file sitting at the tool-computed bound path.
describe("deep conceptual resume narrows the instruction surface, not the access declaration", () => {
  const cleanups: string[] = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      await rm(cleanups.pop()!, { recursive: true, force: true });
    }
  });

  const DEEP = { conceptual_depth: "deep", perspectives: 2 } as const;

  async function artifactsDir(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "cp-node-20-resume-"));
    cleanups.push(root);
    const dir = join(root, ".audit-tools", "audit");
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /** Perspective bound paths, in emission order (the judge lane is last). */
  const perspectivePaths = (writePaths: readonly string[]): readonly string[] =>
    writePaths.slice(0, -1);

  /** The step-1 perspective bullets the host is told to execute. */
  const perspectiveLines = (instructionLines: readonly string[]): string[] =>
    instructionLines.filter((line) => line.trimStart().startsWith("- Perspective "));

  const noticeLines = (instructionLines: readonly string[]): string[] =>
    instructionLines.filter((line) => line.includes("already delivered"));

  it("zero delivered lanes: the instruction surface covers every perspective and carries no delivered notice", async () => {
    const dir = await artifactsDir();

    const dispatch = await prepareConceptualDispatch({
      artifactsDir: dir,
      bundle: {} as ArtifactBundle,
      settings: { ...DEEP },
    });

    const bound = perspectivePaths(dispatch.writePaths);
    expect(bound).toHaveLength(2);

    const lines = perspectiveLines(dispatch.instructionLines);
    expect(
      lines,
      "a fresh round instructs every perspective lane",
    ).toHaveLength(2);
    for (const path of bound) {
      expect(
        lines.some((line) => line.includes(path)),
        `fresh round must instruct the lane bound to ${path}`,
      ).toBe(true);
    }
    expect(lines[0]).toContain("Perspective 1 (");
    expect(lines[1]).toContain("Perspective 2 (");

    expect(
      noticeLines(dispatch.instructionLines),
      "nothing has been delivered, so no reuse notice may appear",
    ).toEqual([]);
    expect(
      dispatch.instructionLines.some((line) =>
        line.includes("1. Execute these 2 independent perspective lane(s)"),
      ),
      "step 1 asks for all 2 lanes when none are pending-narrowed",
    ).toBe(true);
  });

  it("some delivered: step 1 lists only the pending lanes (original ordinal kept), the notice reads 'N of M', and writePaths/readPaths stay FULL", async () => {
    const dir = await artifactsDir();
    const bundle = {} as ArtifactBundle;

    const first = await prepareConceptualDispatch({
      artifactsDir: dir,
      bundle,
      settings: { ...DEEP },
    });
    const [deliveredPath, pendingPath] = perspectivePaths(first.writePaths) as [
      string,
      string,
    ];

    // Perspective 1 lands its submission; the round itself is unchanged.
    await mkdir(dirname(deliveredPath), { recursive: true });
    await writeFile(deliveredPath, "[]", "utf8");

    const resumed = await prepareConceptualDispatch({
      artifactsDir: dir,
      bundle,
      settings: { ...DEEP },
    });

    // (a) The INSTRUCTION surface is narrowed to the pending lane only.
    const lines = perspectiveLines(resumed.instructionLines);
    expect(
      lines,
      "a delivered lane must never be re-instructed",
    ).toHaveLength(1);
    expect(lines[0]).toContain(pendingPath);
    expect(
      lines[0]!.includes(deliveredPath),
      "the delivered lane's bound path must not be re-offered as work",
    ).toBe(false);
    expect(
      lines[0],
      "the surviving lane keeps its ORIGINAL ordinal, not a re-numbered one",
    ).toContain("Perspective 2 (");
    expect(
      resumed.instructionLines.some((line) =>
        line.includes("1. Execute these 1 still-pending independent perspective lane(s)"),
      ),
      "step 1's count is adjusted to the pending set",
    ).toBe(true);

    // (b) The notice states how many of how many already delivered.
    expect(noticeLines(resumed.instructionLines)).toEqual([
      "_1 of 2 perspective lane(s) already delivered a submission this round — reusing that output, not re-executing them._",
    ]);

    // (c) The ACCESS declaration is untouched — a stable per-round binding.
    expect(
      resumed.writePaths,
      "writePaths is a stable per-round access declaration, not a must-write list",
    ).toEqual(first.writePaths);
    expect(perspectivePaths(resumed.writePaths)).toContain(deliveredPath);
    expect(
      resumed.readPaths,
      "readPaths stays full: the judge still reads every perspective's findings",
    ).toEqual(first.readPaths);
    expect(resumed.readPaths).toContain(deliveredPath);
  });
});
