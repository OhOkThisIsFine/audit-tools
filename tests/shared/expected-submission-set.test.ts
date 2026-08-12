/**
 * P25-b — the expected-submission set.
 *
 * A fan-out gate today emits N lanes and then, on the next turn, simply looks to
 * see which files happen to be there: an absent lane is a `continue`, and the
 * step re-emits with no statement of what was owed. So a lane that was never
 * delivered — because the host mistyped the path, dropped the task, or crashed —
 * is indistinguishable from a lane that is merely slow, and the run reports
 * neither the shortfall nor its cause.
 *
 * The contract this file pins: the emission RECORDS what it expects, and
 * ingestion DIFFS the expectation against what arrived, classifying every member
 * by its own id. A missing member is `submission_missing` — named, counted, and
 * attributed to a content-coherent LANE.
 *
 * Vocabulary is load-bearing (design record §1.2 / brief D9): a member is a lane,
 * never a shard, packet, or wave; the diff reports `expected` vs `accepted`, never
 * a backend's fit or budget.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The P25 shared submission core. These module paths and exported names ARE the
// contract the implementation is built to — see `handoff-twins.md` §7 and the
// brief's D1/D3/D5/D8.
const { mintSubmissionId, absoluteSubmissionPath } = await import(
  "../../src/shared/submission/submissionIdentity.js"
);
const { buildExpectedSubmissionSet, diffExpectedSet } = await import(
  "../../src/shared/submission/expectedSubmissions.js"
);
const { readSubmissionDocument } = await import(
  "../../src/shared/submission/submissionClassifier.js"
);
const { materializeFanoutLanes } = await import("../../src/audit/cli/fanoutLanes.js");

const CHARTER_LANES = ["stated", "structural", "revealed"] as const;

/** A lane body that is valid JSON — the diff classifies reads, not charter semantics. */
function charterSubmissionBody(lane: string): string {
  return (
    JSON.stringify(
      { nodes: [{ kind: lane, name: `${lane}-telos`, files: ["src/a.ts"], evidence: [] }] },
      null,
      2,
    ) + "\n"
  );
}

async function writeSubmission(absolutePath: string, body: string): Promise<void> {
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, body, "utf8");
}

describe("the expected-submission set", () => {
  it("classifies an unsatisfied member by id as submission_missing and counts expected vs accepted", async () => {
    const root = await mkdtemp(join(tmpdir(), "p25-expected-set-"));
    try {
      const artifactsDir = join(root, ".audit-tools", "audit");
      const paths = { root, submissionDir: join(artifactsDir, "submissions") };
      const runId = "p25-expected-set-run";

      const set = buildExpectedSubmissionSet({
        runId,
        paths,
        lanes: CHARTER_LANES.map((lane) => ({
          lane,
          submissionId: mintSubmissionId({ kind: "charter_extraction", lane, runId }),
          promptSha256: "0".repeat(64),
        })),
      });
      expect(set.entries).toHaveLength(3);

      // Satisfy two of the three lanes; `revealed` never arrives.
      for (const entry of set.entries.filter((candidate) => candidate.lane !== "revealed")) {
        await writeSubmission(
          absoluteSubmissionPath(paths, entry.submission_id),
          charterSubmissionBody(entry.lane),
        );
      }

      const observed = new Map(
        await Promise.all(
          set.entries.map(
            async (entry) =>
              [
                entry.submission_id,
                await readSubmissionDocument(absoluteSubmissionPath(paths, entry.submission_id)),
              ] as const,
          ),
        ),
      );

      const diff = diffExpectedSet(set, observed);
      expect(diff.expected, "the set states what was owed").toBe(3);
      expect(diff.accepted, "…and what actually arrived").toBe(2);
      expect(diff.members).toHaveLength(3);

      const issues = diff.members.flatMap((member) =>
        member.status === "issue" ? [member] : [],
      );
      expect(issues, "exactly the unsatisfied lane is reported").toHaveLength(1);

      const revealed = set.entries.find((entry) => entry.lane === "revealed");
      expect(revealed).toBeTruthy();
      expect(
        issues[0].submission_id,
        "the missing member is named by its tool-minted submission id",
      ).toBe(revealed?.submission_id);
      expect(issues[0].issue.code).toBe("submission_missing");
      expect(
        issues[0].issue.message,
        "the report reads in lane vocabulary, never shard/packet/transport",
      ).not.toMatch(/shard|packet|wave|transport/iu);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a fan-out emission records its expected set at the tool-owned artifacts path", async () => {
    const root = await mkdtemp(join(tmpdir(), "p25-fanout-expected-"));
    try {
      const artifactsDir = join(root, ".audit-tools", "audit");
      await mkdir(artifactsDir, { recursive: true });

      const fanout = await materializeFanoutLanes({
        artifactsDir,
        runId: "p25-fanout-run",
        lanes: CHARTER_LANES.map((lane) => ({
          id: `charter_${lane}`,
          label: `Charter extraction — ${lane}`,
          promptFilename: `charter-extraction-${lane}-packet.md`,
          promptText: `Author the ${lane} charter lane.`,
        })),
      });

      // Every declared write path is the tool-computed submission name.
      expect(fanout.writePaths.length).toBe(3);
      for (const writePath of fanout.writePaths) {
        expect(writePath.replace(/\\/g, "/")).toMatch(/\/submissions\/[0-9a-f]{64}\.json$/);
      }

      // Read raw — the expected set is an UNREGISTERED artifact (brief D1),
      // outside ARTIFACT_DEFINITIONS and the staleness DAG.
      const expectedSet = JSON.parse(
        await readFile(join(artifactsDir, "submissions", "expected-submissions.json"), "utf8"),
      ) as {
        contract_version: string;
        entries: { submission_id: string; lane: string; prompt_sha256: string; submission_path: string }[];
      };

      expect(expectedSet.contract_version).toBe("submission-expected-set/v1alpha1");
      expect(expectedSet.entries).toHaveLength(3);
      expect(expectedSet.entries.map((entry) => entry.lane).sort()).toEqual(
        ["charter_revealed", "charter_stated", "charter_structural"],
      );
      for (const entry of expectedSet.entries) {
        expect(entry.submission_id).toBeTruthy();
        expect(entry.prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(
          entry.submission_path.replace(/\\/g, "/"),
          "the recorded path is tool-computed, never a host-typed lane filename",
        ).toMatch(/\/submissions\/[0-9a-f]{64}\.json$/);
        expect(entry.submission_path).not.toContain(entry.lane);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
