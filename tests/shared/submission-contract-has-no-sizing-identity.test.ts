/**
 * The submission contract carries NO sizing or execution identity.
 *
 * This is the mechanically enforced replacement for a backlog note (design record
 * §1.2, §5 #7; *durable traps are mechanically enforced, not remembered*). The
 * zero-adapter retirement deleted every provider, model, quota, window, and
 * packet/shard identity from this package; the submission core is exactly the
 * kind of new substrate that invites them back one convenient field at a time —
 * a `packet_id` to correlate a fan-out, a `model` to explain a rejection, a
 * `token_budget` to justify a partition.
 *
 * Two independent forms, because either alone is escapable:
 *   1. runtime — walk the objects the REAL producers emit (never a hand-written
 *      literal, which would only prove the literal is clean);
 *   2. source  — the submission modules must not even mention the banned
 *      identifiers, which catches a field that exists on a shape no test happens
 *      to construct.
 *
 * Vocabulary is part of the contract: a member is a LANE, a missing one is
 * `submission_missing` — never "shard", never "transport".
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { mintSubmissionId, absoluteSubmissionPath } = await import(
  "../../src/shared/submission/submissionIdentity.js"
);
const { buildExpectedSubmissionSet, diffExpectedSet } = await import(
  "../../src/shared/submission/expectedSubmissions.js"
);
const { SUBMISSION_ISSUE_CODES, readSubmissionDocument } = await import(
  "../../src/shared/submission/submissionClassifier.js"
);
const { SUBMISSION_EVENT_KINDS } = await import(
  "../../src/shared/submission/submissionLedger.js"
);

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const submissionSrcDir = join(repoRoot, "src", "shared", "submission");

/**
 * The audit DRAW of the same core. `laneSubmissions.ts` carries the bound-path
 * rule (it is where a lane's id, path, expected set, and ledger events are
 * derived) and `laneValidators.ts` carries the per-lane contracts — so a
 * sizing/execution field re-entering the submission vocabulary is exactly as
 * likely to arrive here as in `src/shared/submission/`, and a ban that stopped
 * at the shared directory would not see it.
 */
const drawSrcFiles = [
  join(repoRoot, "src", "audit", "cli", "laneSubmissions.ts"),
  join(repoRoot, "src", "audit", "cli", "laneValidators.ts"),
];

/** Sizing / execution / transport identity — none of it is this package's business. */
const BANNED_KEY =
  /packet_id|wave_id|shard|provider|model|endpoint|token_budget|budget|cost|rate_limit|concurrency|lease|admission|window|transport/iu;

/** The same ban as source identifiers, whole-word so `submission_path` is untouched. */
const BANNED_IDENTIFIER =
  /\b(packet_id|wave_id|shard_index|shard|provider|model|endpoint|token_budget|max_tokens|context_window|rate_limit|concurrency|lease|admission|transport)\b/iu;

/** Recursive key walk (same idiom as tests/audit/host-handoff.test.ts). */
function objectKeys(value: unknown, seen: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) objectKeys(item, seen);
    return seen;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      seen.push(key);
      objectKeys(child, seen);
    }
  }
  return seen;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ""))
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("the submission contract has no sizing identity", () => {
  it("nothing the producers emit carries a packet/shard/provider/model/budget field", async () => {
    const root = await mkdtemp(join(tmpdir(), "p25-sizing-guard-"));
    try {
      const paths = { root, submissionDir: join(root, ".audit-tools", "audit", "submissions") };
      const runId = "p25-sizing-guard-run";
      const set = buildExpectedSubmissionSet({
        runId,
        paths,
        lanes: ["stated", "structural"].map((lane) => ({
          lane,
          submissionId: mintSubmissionId({ kind: "charter_extraction", lane, runId }),
          promptSha256: "0".repeat(64),
        })),
      });

      // Nothing is written to disk: both members read as missing, so the diff
      // also exercises the issue shape.
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

      const keys = [...objectKeys(set), ...objectKeys(diff)];
      expect(keys.length, "the walk must actually reach fields").toBeGreaterThan(5);
      const offenders = keys.filter((key) => BANNED_KEY.test(key));
      expect(
        offenders,
        "the submission/expected-set contract carries no sizing, routing, or execution identity",
      ).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("the issue and event vocabularies speak lanes and submissions, never shards or transport", () => {
    const vocabulary = [...SUBMISSION_ISSUE_CODES, ...SUBMISSION_EVENT_KINDS];
    expect(vocabulary.length).toBeGreaterThan(5);
    expect(
      vocabulary.filter((code) => BANNED_KEY.test(code)),
      "no code may name a shard, packet, wave, provider, model, or transport",
    ).toEqual([]);
    expect(
      SUBMISSION_ISSUE_CODES,
      "the absence of an expected member is `submission_missing`",
    ).toContain("submission_missing");
    expect(SUBMISSION_ISSUE_CODES).toContain("submission_malformed");
  });

  it("no submission source file so much as mentions a sizing identifier", async () => {
    const entries = await readdir(submissionSrcDir, { recursive: true, withFileTypes: true });
    const sources = [
      ...entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => join(entry.parentPath, entry.name)),
      ...drawSrcFiles,
    ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    for (const required of [
      "submissionIdentity.ts",
      "expectedSubmissions.ts",
      "submissionClassifier.ts",
      "submissionLedger.ts",
      // The audit draw of the same core — scanned by the same ban.
      "laneSubmissions.ts",
      "laneValidators.ts",
    ]) {
      expect(
        sources.some((file) => file.endsWith(required)),
        `the scan must reach ${required}`,
      ).toBe(true);
    }

    const violations: string[] = [];
    for (const file of sources) {
      stripComments(await readFile(file, "utf8"))
        .split(/\r?\n/)
        .forEach((line, index) => {
          if (BANNED_IDENTIFIER.test(line)) {
            violations.push(
              `${file.slice(repoRoot.length).replace(/\\/g, "/")}:${index + 1}: ${line.trim()}`,
            );
          }
        });
    }
    expect(
      violations,
      "the submission core must not reintroduce the retired execution/sizing vocabulary",
    ).toEqual([]);
  });
});
