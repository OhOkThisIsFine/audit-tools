import { captureCompletedDesignReviews, persistDesignReviewSnapshots } from "./helpers/designReviewSnapshotFixture.js";
import { writeBoundReviewFixture } from "./helpers/reviewSubmissionFixture.js";
// Charter-lane reuse (forward-tracks.md, the frozen-snapshot track; design record
// docs/reviews/charter-lane-reuse-design-2026-10-09.md): each register lane
// records the digest of the packet it was written from, and a later extraction
// asks the host only for the lanes whose packet changed. A comment edit of the
// same length changes the `stated` packet only (comments are its evidence; the
// structural packet carries sizes and declarations, the revealed packet stripped
// bodies), so only `stated` is re-authored and the other two lanes are carried.
import { test, expect } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { cmdNextStep } from "../../src/audit/cli/nextStepCommand.js";
import { writeCoreArtifacts, type ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { charterExtractionKindsForCeiling } from "../../src/audit/cli/charterExtractionPrompt.js";
import { charterExtractionLane, charterExtractionPacketFilename, laneSubmissionPath } from "../../src/audit/cli/laneSubmissions.js";
import { runSnapshotPath } from "../../src/audit/io/runSnapshot.js";
import { withTempRepo } from "./helpers/next-step-harness.js";
import { walkStepsUntilTerminal } from "./helpers/step-driver.js";

const SOURCE_V1 = "// intent\nexport const alpha = 1;\n";
// Same length, different comment: only the `stated` packet moves.
const SOURCE_V2 = "// intens\nexport const alpha = 1;\n";

function deepCeilingBundle(): ArtifactBundle {
  return {
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: "2026-01-01T00:00:00.000Z",
      files: [
        { path: "src/a.ts", language: "typescript", size_bytes: SOURCE_V1.length, hash: "v1" },
        { path: "README.md", language: "markdown", size_bytes: 100, hash: "readme" },
      ],
    },
    file_disposition: {
      files: [
        { path: "src/a.ts", status: "included" },
        { path: "README.md", status: "doc_only" },
      ],
    },
    auto_fixes_applied: {},
    syntax_resolution_status: {},
    external_analyzer_acquisition: { enabled: false, tool_statuses: [] },
    external_analyzer_results: [{ tool: "eslint", results: [] }],
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [], fallback_required: false },
    risk_register: { items: [] },
    analyzer_capability: { coverage: "not_applicable", analyzers: [] },
    design_assessment: {
      generated_at: "2026-01-01T00:00:00.000Z",
      findings: [],
      contract_findings: [],
      contract_reviewed: true,
      conceptual_findings: [],
      conceptual_reviewed: true,
    },
    docs_digest: { generated_at: "2026-01-01T00:00:00.000Z", docs: [] },
    structure_decomposition: {
      generated_at: "2026-01-01T00:00:00.000Z",
      target: "structure",
      node_universe_size: 1,
      source_ids: ["call_import"],
      consensus: [
        { node_id: "src/a.ts", members: ["src/a.ts"], agreed_across_source: 1, stable_across_scale: 1, contested: false },
      ],
      contested: [],
      findings: [],
    },
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: "2026-01-01T00:00:00Z",
      confirmed_by: "host",
      scope_summary: "s",
      intent_summary: "i",
      design_review: { answered_at: "2026-01-01T00:00:00Z", ceiling: { rung: "deep" } },
    },
  } as ArtifactBundle;
}

type Register = {
  lanes: { kind: string; packet_sha256?: string; nodes: { node_id: string }[] }[];
  evidence_coverage: { kind: string }[];
  citation_validation: { quote_presence_checked: boolean };
};

async function currentStep(artifactsDir: string): Promise<{ step_kind: string; access: { write_paths: string[] } }> {
  return JSON.parse(await readFile(join(artifactsDir, "steps", "current-step.json"), "utf8"));
}

async function answerLanes(artifactsDir: string, kinds: readonly string[], paths: readonly string[], tag: string): Promise<void> {
  for (const [i, path] of paths.entries()) {
    const kind = kinds[i] as Parameters<typeof charterExtractionLane>[0];
    await mkdir(dirname(path), { recursive: true });
    await writeBoundReviewFixture(artifactsDir, charterExtractionLane(kind), {
      inputs: [charterExtractionPacketFilename(kind)],
      nodes: [{
        node_id: `${tag}-${kind}`,
        purpose: "Keep every promise the fixture gives its reader",
        provenance: [{ kind: "code", ref: "src/a.ts#alpha", quote: "export const alpha = 1;" }],
        confidence: "high",
      }],
      edges: [],
    });
  }
}

const KINDS = charterExtractionKindsForCeiling({ rung: "deep" });

/** Run the first extraction to a register whose lanes all record their digest. */
async function firstExtraction(root: string, artifactsDir: string): Promise<Register> {
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "README.md"), "# Fixture\n\nprose.\n", "utf8");
  await writeFile(join(root, "src", "a.ts"), SOURCE_V1, "utf8");
  await mkdir(artifactsDir, { recursive: true });
  const completed = captureCompletedDesignReviews(deepCeilingBundle());
  await writeCoreArtifacts(artifactsDir, completed);
  await persistDesignReviewSnapshots(artifactsDir, completed);

  await cmdNextStep(["--root", root, "--artifacts-dir", artifactsDir]);
  const first = await currentStep(artifactsDir);
  expect(first.step_kind).toBe("charter_extraction");
  await answerLanes(artifactsDir, KINDS, first.access.write_paths, "first");
  await cmdNextStep(["--root", root, "--artifacts-dir", artifactsDir]);

  const register = await readRegister(artifactsDir);
  // Every lane records the digest of the packet it was written from.
  for (const lane of register.lanes) expect(lane.packet_sha256, lane.kind).toMatch(/^[0-9a-f]{64}$/u);
  return register;
}

async function readRegister(artifactsDir: string): Promise<Register> {
  return JSON.parse(await readFile(join(artifactsDir, "charter_register.json"), "utf8")) as Register;
}

/**
 * Make ONLY the register stale by moving its recorded read-file slice — the
 * property under test is what a stale register's re-extraction asks for, not
 * how intake notices an edit (a manifest rewrite would also re-derive the
 * fixture's hand-written upstream artifacts).
 */
async function staleTheRegister(artifactsDir: string): Promise<void> {
  const metadataPath = join(artifactsDir, "artifact_metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
    artifacts: Record<string, { dependency_slices?: Record<string, string> }>;
  };
  const slices = metadata.artifacts["charter_register.json"]?.dependency_slices;
  expect(slices?.["repo_manifest.json"]).toBeDefined();
  slices!["repo_manifest.json"] = "moved-by-the-edit";
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf8");
}

/** Walk next-step, answering any other pause as a host would, to the first step of a named kind. */
async function walkTo(root: string, artifactsDir: string, kinds: readonly string[], label: string) {
  return await walkStepsUntilTerminal({
    transport: async () => {
      await cmdNextStep(["--root", root, "--artifacts-dir", artifactsDir]);
      return currentStep(artifactsDir);
    },
    terminalKinds: new Set(kinds),
    label,
  }) as Awaited<ReturnType<typeof currentStep>>;
}

const digest = (register: Register, kind: string) => register.lanes.find((lane) => lane.kind === kind)?.packet_sha256;

test("a later extraction re-authors only the lanes whose packet changed and carries the rest", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools", "audit");
    const before = await firstExtraction(root, artifactsDir);

    // The run reads its frozen snapshot: the comment edit lands there.
    const { source_root: sourceRoot } = JSON.parse(await readFile(runSnapshotPath(artifactsDir), "utf8")) as { source_root: string };
    await writeFile(join(sourceRoot, "src", "a.ts"), SOURCE_V2, "utf8");
    await staleTheRegister(artifactsDir);

    const second = await walkTo(root, artifactsDir, ["charter_extraction"], "re-extraction");
    // Only the `stated` lane is asked for again (the step may carry other host
    // work; only the charter lane paths matter).
    const lanePath = (kind: string) => laneSubmissionPath(artifactsDir, charterExtractionLane(kind as Parameters<typeof charterExtractionLane>[0]));
    const posix = (path: string) => path.replace(/\\/g, "/");
    const written = new Set(second.access.write_paths.map(posix));
    const askedLanes = KINDS.filter((kind) => written.has(posix(lanePath(kind))));
    expect(askedLanes).toEqual(["stated"]);
    await answerLanes(artifactsDir, ["stated"], [lanePath("stated")], "second");
    await walkTo(root, artifactsDir, ["charter_comparison"], "after re-extraction");

    const after = await readRegister(artifactsDir);
    expect(after.lanes.map((lane) => [lane.kind, lane.nodes[0]?.node_id])).toEqual(
      KINDS.map((kind) => [kind, kind === "stated" ? "second-stated" : `first-${kind}`]),
    );
    expect(digest(after, "stated")).not.toBe(digest(before, "stated"));
    expect(digest(after, "structural")).toBe(digest(before, "structural"));
    expect(digest(after, "revealed")).toBe(digest(before, "revealed"));
  });
});

// The common real case: a change outside every packet (a new non-member file)
// stales the register while all three packets stay byte-identical. No lane is
// asked for, so no emission runs — the merge itself must write each kind's
// coverage manifest, or the register silently loses its evidence coverage and
// its delivered-quote check.
test("a stale register whose every packet is unchanged carries all lanes with no host turn and keeps its evidence coverage", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools", "audit");
    const before = await firstExtraction(root, artifactsDir);
    await staleTheRegister(artifactsDir);

    // Reaching the comparison without a `charter_extraction` step on the way is
    // the proof that no lane was re-asked.
    const reached = await walkTo(root, artifactsDir, ["charter_extraction", "charter_comparison"], "all carried");
    expect(reached.step_kind).toBe("charter_comparison");

    const after = await readRegister(artifactsDir);
    expect(after.lanes.map((lane) => [lane.kind, lane.nodes[0]?.node_id, lane.packet_sha256])).toEqual(
      KINDS.map((kind) => [kind, `first-${kind}`, digest(before, kind)]),
    );
    expect(after.evidence_coverage.map((coverage) => coverage.kind).sort()).toEqual([...KINDS].sort());
    expect(after.citation_validation.quote_presence_checked).toBe(true);
  });
});
