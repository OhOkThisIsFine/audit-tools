/**
 * The deep conceptual pass's perspective lanes are ROUND-scoped, and the tool is
 * owed nothing on them.
 *
 * Routing the perspectives through the shared lane materializer gave them two
 * properties that are right for every other lane and wrong for these:
 *
 *   1. K-of-N RESUME. A lane whose submission already sits at its bound path is
 *      complete — prompt not rewritten, lane not re-instructed. Keyed on the
 *      perspective INDEX alone, a re-review triggered by upstream staleness
 *      found the PREVIOUS round's findings there, skipped the lane, and handed
 *      the judge stale opinions of artifacts that had since changed.
 *   2. EXPECTED-SUBMISSION membership. The tool never reads a perspective's
 *      findings (the judge does), so an expectation recorded against one can
 *      never be satisfied or dropped — it accumulates in the expected set and
 *      the ledger as a permanent, false shortfall.
 *
 * Both are fixed at identity: the lane id carries a digest of what the round
 * asks, and a perspective declares itself un-expected. What must NOT change is
 * resume WITHIN a round (an id that churned per call would re-ask for work the
 * host already delivered) or the judge lane, whose submission the tool does
 * ingest.
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";

const { prepareConceptualDispatch } = await import(
  "../../src/audit/cli/conceptualDispatch.js"
);
const { expectedSubmissionsPath } = await import(
  "../../src/shared/io/auditToolsPaths.js"
);
const { readOptionalJsonFile } = await import("../../src/shared/io/json.js");
const { readSubmissionLedger } = await import(
  "../../src/shared/submission/submissionLedger.js"
);

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await rm(cleanups.pop()!, { recursive: true, force: true });
  }
});

async function artifactsDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "p25-perspective-round-"));
  cleanups.push(root);
  const dir = join(root, ".audit-tools", "audit");
  await mkdir(dir, { recursive: true });
  return dir;
}

const SETTINGS = { conceptual_depth: "deep", perspectives: 2 } as const;

/** The perspective lanes' bound paths, in emission order (the judge is last). */
function perspectivePaths(writePaths: readonly string[]): readonly string[] {
  return writePaths.slice(0, -1);
}

describe("deep conceptual perspectives are round-scoped and never expected submissions", () => {
  it("a fresh round mints fresh perspective paths while the judge lane keeps its identity", async () => {
    const dir = await artifactsDir();
    const bundle = {} as ArtifactBundle;

    const first = await prepareConceptualDispatch({
      artifactsDir: dir,
      bundle,
      settings: { ...SETTINGS },
    });
    // A perspective delivers its findings in the first round.
    const delivered = perspectivePaths(first.writePaths)[0]!;
    await mkdir(dirname(delivered), { recursive: true });
    await writeFile(delivered, "[]", "utf8");

    // Same round, re-emitted: identical bound paths, so an already-delivered
    // perspective is NOT re-asked.
    const reEmit = await prepareConceptualDispatch({
      artifactsDir: dir,
      bundle,
      settings: { ...SETTINGS },
    });
    expect(
      perspectivePaths(reEmit.writePaths),
      "re-emitting an unchanged round must re-declare the identical bound paths",
    ).toEqual(perspectivePaths(first.writePaths));

    // A genuine re-review (diff section present) is a NEW round.
    const second = await prepareConceptualDispatch({
      artifactsDir: dir,
      bundle,
      settings: { ...SETTINGS },
      reReviewSection: "## Diff-based re-review\n\nupstream changed",
    });
    for (const path of perspectivePaths(second.writePaths)) {
      expect(
        perspectivePaths(first.writePaths),
        "a re-review must not reuse the prior round's perspective submission",
      ).not.toContain(path);
    }
    expect(
      second.conceptualResultsPath,
      "the JUDGE lane is the ingested submission and keeps its resume semantics",
    ).toBe(first.conceptualResultsPath);
  });

  it("records an expectation for the judge lane only — never for a perspective", async () => {
    const dir = await artifactsDir();
    await prepareConceptualDispatch({
      artifactsDir: dir,
      bundle: {} as ArtifactBundle,
      settings: { ...SETTINGS },
    });

    const set = await readOptionalJsonFile<{
      entries?: { lane: string }[];
    }>(expectedSubmissionsPath(dir));
    expect(
      (set?.entries ?? []).map((entry) => entry.lane),
      "only the lane the tool itself ingests is owed a submission",
    ).toEqual(["design_review_conceptual"]);

    const ledger = await readSubmissionLedger(dir);
    expect(
      ledger.filter((event) => event.kind === "expected").map((e) => e.lane),
      "a perspective must not appear on the ledger as an unsatisfiable expectation",
    ).toEqual(["design_review_conceptual"]);

    // The retirement and the RECORD are different things. Expecting an artifact
    // is a claim the tool will be owed something and will re-ask until it
    // arrives — that is what P25 removed for perspectives, and the assertion
    // above still pins it. Recording that a lane was dispatched is a statement
    // about the past: it re-asks nothing, accumulates in no set, and can never
    // become a shortfall (shortfall is a diff over the expected SET, which
    // never reads ledger events). Without it, a perspective that exited 0
    // having written nothing left no trace in any artifact.
    expect(
      new Set(
        ledger.filter((e) => e.kind === "dispatched").map((e) => e.lane),
      ).size,
      "every dispatched lane, expected or not, leaves a dispatch row",
    ).toBe(3); // 2 perspectives + the judge
  });
});
