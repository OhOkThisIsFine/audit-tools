// `recover-submission` and the MIS-ROUTE door the retired `kind` field left open.
//
// Until 2026-09-17 an extraction submission stated its own `kind`, and the gate
// compared it with the lane the file arrived as. The owner's review of prompt 8
// removed the field: the lane writes at a lane-bound path, so the tool already
// knows which lane spoke, and asking the lane to restate it only ever let the
// lane check itself.
//
// The normal path loses nothing — a lane never chooses its own destination there.
// This verb does. `--lane` names the destination and `--from` names arbitrary
// content, so it is the ONE door through which one channel's goals can be
// attributed to another. That defect is silent: a wrongly attributed lane passed
// the whole audit and shared suites, 5448 tests, when it was measured.
//
// What replaces the field is WEAKER by construction, and the owner accepted that
// cost: with no declared kind left to compare, the channel is inferred from
// content. The inference is the property the prompt itself states — each lane's
// evidence packet is SUFFICIENT — so an obedient lane cites only paths its own
// packet delivered, and a payload authored against a different packet cites
// outside it.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cmdRecoverSubmission } from "../../src/audit/cli/recoverSubmissionCommand.js";
import { charterExtractionCoverageFilename } from "../../src/audit/cli/laneSubmissions.js";
import { laneAssetsDir } from "audit-tools/shared";

const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await rm(cleanups.pop()!, { recursive: true, force: true });
  }
});

/**
 * An artifacts tree the verb can read: the repo manifest its scope grounding
 * needs, and — unless `deliver` is `undefined` — the `stated` lane's packet
 * manifest naming what that lane was handed.
 */
async function fixture(deliver: string[] | undefined): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "recover-mis-route-"));
  cleanups.push(dir);
  const artifactsDir = join(dir, ".audit-tools", "audit");
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(
    join(artifactsDir, "repo_manifest.json"),
    JSON.stringify({
      generated_at: "2026-01-01T00:00:00.000Z",
      repository: { name: "fixture" },
      files: [
        { path: "docs/goals.md", language: "markdown", size_bytes: 10 },
        { path: "src/a.ts", language: "typescript", size_bytes: 10 },
      ],
    }),
    "utf8",
  );
  if (deliver !== undefined) {
    const assets = laneAssetsDir(artifactsDir);
    await mkdir(assets, { recursive: true });
    await writeFile(
      join(assets, charterExtractionCoverageFilename("stated")),
      JSON.stringify({
        schema_version: "charter-packet-manifest/v1",
        kind: "stated",
        excerpts: deliver.map((source_path, i) => ({
          excerpt_id: `e${i}`,
          source_path,
          evidence_class: "doc_prose",
          line_runs: [{ start: 1, end: 2 }],
          line_count: 2,
          prefix_width: 4,
        })),
        coverage: { kind: "stated", classes: [] },
      }),
      "utf8",
    );
  }
  return artifactsDir;
}

/** A payload shaped exactly as an obedient lane writes one. */
async function payload(dir: string, refs: string[]): Promise<string> {
  const path = join(dir, "payload.json");
  await writeFile(
    path,
    JSON.stringify({
      nodes: [
        {
          node_id: "top",
          purpose: "keep every promise the service gives a customer",
          provenance: refs.map((ref) => ({
            kind: "code",
            ref,
            quote: "some copied text",
          })),
          confidence: "high",
        },
      ],
      edges: [],
    }),
    "utf8",
  );
  return path;
}

describe("recover-submission refuses a MIS-ROUTED extraction payload", () => {
  it("refuses a payload citing a path this lane's packet never delivered, and names it", async () => {
    const artifactsDir = await fixture(["docs/goals.md"]);
    const from = await payload(artifactsDir, ["src/a.ts"]);
    await expect(
      cmdRecoverSubmission([
        "--artifacts-dir",
        artifactsDir,
        "--lane",
        "charter_extraction_stated",
        "--from",
        from,
      ]),
    ).rejects.toThrow(/src\/a\.ts/);
  });

  it("states WHICH lane the payload was aimed at, so the operator can fix the flag", async () => {
    const artifactsDir = await fixture(["docs/goals.md"]);
    const from = await payload(artifactsDir, ["src/a.ts"]);
    await expect(
      cmdRecoverSubmission([
        "--artifacts-dir",
        artifactsDir,
        "--lane",
        "charter_extraction_stated",
        "--from",
        from,
      ]),
    ).rejects.toThrow(/'stated' lane/);
  });

  it("refuses when the lane has NO packet manifest — there is no lane to rescue onto", async () => {
    // Unlike the repo manifest, whose absence only makes scope grounding
    // stricter, a missing packet manifest means the emit pass never handed this
    // lane a packet at all.
    const artifactsDir = await fixture(undefined);
    const from = await payload(artifactsDir, ["docs/goals.md"]);
    await expect(
      cmdRecoverSubmission([
        "--artifacts-dir",
        artifactsDir,
        "--lane",
        "charter_extraction_stated",
        "--from",
        from,
      ]),
    ).rejects.toThrow(/no evidence packet manifest/);
  });

  it("CONTROL: a payload citing only delivered paths is not refused for mis-routing", async () => {
    // Without this the refusals above could pass against a guard that rejects
    // every extraction rescue.
    const artifactsDir = await fixture(["docs/goals.md"]);
    const from = await payload(artifactsDir, ["docs/goals.md"]);
    let error: unknown;
    await cmdRecoverSubmission([
      "--artifacts-dir",
      artifactsDir,
      "--lane",
      "charter_extraction_stated",
      "--from",
      from,
    ]).catch((e: unknown) => {
      error = e;
    });
    expect(String(error ?? "")).not.toContain("never delivered");
    expect(String(error ?? "")).not.toContain("no evidence packet manifest");
  });

  it("resolves a `#symbol` ref to its FILE before the lookup", async () => {
    // The manifest records paths. Comparing the raw ref would refuse every
    // anchored citation an obedient lane writes — a false red.
    const artifactsDir = await fixture(["docs/goals.md"]);
    const from = await payload(artifactsDir, ["docs/goals.md#Charter"]);
    let error: unknown;
    await cmdRecoverSubmission([
      "--artifacts-dir",
      artifactsDir,
      "--lane",
      "charter_extraction_stated",
      "--from",
      from,
    ]).catch((e: unknown) => {
      error = e;
    });
    expect(String(error ?? "")).not.toContain("never delivered");
  });
});
