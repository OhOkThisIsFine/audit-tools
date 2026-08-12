import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { AuditState } from "../../src/audit/types/auditState.js";

// P25-f / R7 — a host submission that the tool reads but cannot merge must
// never be consumed-and-dropped.
//
// At HEAD `consumeArrayIncoming` (src/audit/cli/nextStepHelpers.ts) unlinks the
// file unconditionally on a successful unwrap, and the merge arms in
// `handleDesignReviewBranch` are guarded by `&& existing`. With no
// `design_assessment` in the bundle there is nothing to merge into, so a
// perfectly valid submission is deleted, discarded, and the identical step is
// re-emitted with zero signal to the host. `recordRejectedDesignReviewSubmission`
// opens with `if (!existing) return;`, so not even the quarantine note is
// written for this case.
//
// This test asserts the PROPERTY (never consumed-and-dropped), in two halves:
//
//   half 1 — SURVIVAL: the submitted bytes still exist somewhere under
//            artifactsDir (original path, quarantine, or wherever the scheme
//            puts a held submission).
//   half 2 — RECORD: something durable says the submission was received and
//            could not be merged (quarantine file, a rejected-submissions note,
//            or a submission ledger event).
//
// P25-f ALONE (quarantine-never-delete inside `consumeArrayIncoming` + removing
// the silent `if (!existing) return;` skip) turns BOTH halves green. Half 2 is
// also the non-vacuity guard: once P25-a moves the submission scheme off
// `incoming/`, a stale plant path would leave the file untouched and half 1
// would pass for the wrong reason — half 2 stays red until `plantSubmission`
// below is re-pointed at the path the consuming code actually reads.
const FAILURE_SIGNATURE =
  "contract:design-review-submission-not-consumed-and-dropped:not-yet-satisfied";

const MARKER = "DR-P25F-CONSUMED-WITHOUT-TARGET";
const SUBMISSION_BODY = JSON.stringify([{ id: "DR-001", title: MARKER }]);

/**
 * Plant a valid design-review CONTRACT findings submission where the consuming
 * branch reads it.
 *
 * ⚠ Single point of change: when P25-a moves submissions off `incoming/` to the
 * tool-owned `submissions/<sha256(submission_id)>.json` scheme, re-point THIS
 * function (only) at the new path. Everything below asserts the property, not
 * the location.
 */
async function plantSubmission(artifactsDir: string): Promise<string> {
  const { GATE_LANES, laneSubmissionPath } = await import(
    "../../src/audit/cli/laneSubmissions.js"
  );
  // The production path helper, not a re-spelling of it: the point of the
  // scheme is that only the tool can name this file, so the test asks the tool.
  const path = laneSubmissionPath(artifactsDir, GATE_LANES.design_review_contract);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, SUBMISSION_BODY, "utf8");
  return path;
}

interface TreeFile {
  readonly path: string;
  readonly content: string;
}

async function walkTree(dir: string): Promise<readonly TreeFile[]> {
  const found: TreeFile[] = [];
  const visit = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of [...entries].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        found.push({ path, content: await readFile(path, "utf8") });
      }
    }
  };
  await visit(dir);
  return found;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe(FAILURE_SIGNATURE, () => {
  it("keeps a valid submission it has no target to merge into, and records it", async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), "dr-consume-no-target-"));
    try {
      const { handleDesignReviewBranch } = await import(
        "../../src/audit/cli/nextStepCommand.js"
      );

      const plantedPath = await plantSubmission(artifactsDir);

      // No design_assessment anywhere: not on disk, not in the bundle. This is
      // exactly the "consumed but no target to merge into" arm.
      const bundle = {} as ArtifactBundle;
      const state: AuditState = { status: "active", obligations: [] };
      const params = { artifactsDir };

      const branch = await handleDesignReviewBranch(params, bundle, state);

      // The branch must still hand the host a step to run — losing the
      // submission AND stalling would be strictly worse.
      expect(branch.action).toBe("return");

      const tree = await walkTree(artifactsDir);
      const bodyDigest = digest(SUBMISSION_BODY);

      // ── half 1: SURVIVAL ────────────────────────────────────────────────
      const survivors = tree.filter(
        (file) => digest(file.content) === bodyDigest || file.content.includes(MARKER),
      );
      expect(
        survivors.map((file) => file.path),
        `the submission planted at ${plantedPath} was destroyed: no copy of its ` +
          `bytes survives anywhere under the artifacts dir (files seen: ` +
          `${JSON.stringify(tree.map((file) => file.path))})`,
      ).not.toEqual([]);

      // ── half 2: RECORD ──────────────────────────────────────────────────
      // Something durable must say "received, could not be merged" — a
      // quarantine artifact, a rejected-submissions note, or a ledger event.
      const records = tree.filter((file) => {
        const slashed = file.path.replaceAll("\\", "/");
        if (slashed.includes("/quarantine/")) return true;
        if (/submission[-_]?ledger/iu.test(slashed)) return true;
        return (
          slashed.endsWith("design_assessment.json") &&
          file.content.includes("rejected_submissions")
        );
      });
      expect(
        records.map((file) => file.path),
        "nothing records that the submission was received but had no merge " +
          "target — an unmergeable submission must be held AND reported, not " +
          "silently folded past",
      ).not.toEqual([]);
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });
});
