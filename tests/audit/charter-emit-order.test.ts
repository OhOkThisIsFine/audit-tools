// The charter-emission step's TOOL-side properties: what the step contract
// persists, and what the merge stamps onto each lane it consumed. Both are
// properties of one bounded fixture, so they share it.
//
// A8 — the packet read_paths a charter emission persists are in KIND order.
//
// The emitter builds three packets concurrently with `Promise.all` and persists
// their paths into the step contract's `access.read_paths`. Pushing each path
// from inside the concurrent callback records IO COMPLETION order, so a slower
// disk (or, as here, a much larger packet) silently reorders a persisted
// artifact. The fixture makes the FIRST kind's packet by far the largest, so
// completion order and kind order genuinely disagree.
import { test, expect } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { cmdNextStep } from "../../src/audit/cli/nextStepCommand.js";
import {
  writeCoreArtifacts,
  type ArtifactBundle,
} from "../../src/audit/io/artifacts.js";
import { charterExtractionKindsForCeiling } from "../../src/audit/cli/charterExtractionPrompt.js";
import { charterExtractionPacketFilename } from "../../src/audit/cli/laneSubmissions.js";
import { withTempRepo } from "./helpers/next-step-harness.js";

function deepCeilingBundle(): ArtifactBundle {
  return {
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: "2026-01-01T00:00:00.000Z",
      files: [
        { path: "src/a.ts", language: "typescript", size_bytes: 100 },
        { path: "README.md", language: "markdown", size_bytes: 100 },
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
        {
          node_id: "src/a.ts",
          members: ["src/a.ts"],
          agreed_across_source: 1,
          stable_across_scale: 1,
          contested: false,
        },
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
      design_review: { ceiling: { rung: "deep" } },
    },
  } as ArtifactBundle;
}

test("charter packet read_paths are persisted in KIND order, not IO-completion order", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(join(root, "src"), { recursive: true });
    // A large doc makes the `stated` packet by far the biggest, so its write
    // finishes LAST while kind order puts it FIRST.
    await writeFile(
      join(root, "README.md"),
      `# Fixture\n\n${"prose that makes the stated packet the slowest write.\n".repeat(3_000)}`,
      "utf8",
    );
    await writeFile(
      join(root, "src", "a.ts"),
      "// intent\nexport const alpha = 1;\n",
      "utf8",
    );
    await mkdir(artifactsDir, { recursive: true });
    await writeCoreArtifacts(artifactsDir, deepCeilingBundle());

    await cmdNextStep(["--root", root, "--artifacts-dir", artifactsDir]);
    const step = JSON.parse(
      await readFile(join(artifactsDir, "steps", "current-step.json"), "utf8"),
    );
    expect(step.step_kind).toBe("charter_extraction");

    const kinds = charterExtractionKindsForCeiling({ rung: "deep" });
    const packetPaths: string[] = step.access.read_paths.filter((p: string) =>
      p.includes("-packet.md"),
    );
    expect(packetPaths.map((p) => p.replace(/\\/g, "/").split("/").pop())).toEqual(
      kinds.map((kind) => charterExtractionPacketFilename(kind)),
    );

    // …and the biggest packet really is the FIRST one, so the two orders differ.
    const sizes = await Promise.all(
      packetPaths.map(async (p) => (await readFile(p, "utf8")).length),
    );
    expect(sizes[0]).toBeGreaterThan(Math.max(sizes[1]!, sizes[2]!));
  });
});

// The lane submission stopped stating its own `kind` on 2026-09-17 (owner review
// of prompt 8): the lane writes its file at a lane-bound path, so the path IS the
// answer to "which lane is this", and the tool stamps the kind at merge.
//
// That makes the stamp the ONLY surviving answer. Before, the lane declared the
// kind and the gate cross-checked it, so a mis-stamp had a second witness; now it
// has none, and a mis-stamp is silent — it attributes one channel's goals to
// another and corrupts every downstream comparison. So the pairing of a lane's
// CONTENT to the kind it was stamped with is pinned here. Measured: inverting the
// stamp to a constant kind passed the whole audit and shared suites, 5448 tests,
// before this test existed.
test("the merge stamps each lane with the kind of the PATH it arrived on", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "README.md"), "# Fixture\n\nprose.\n", "utf8");
    await writeFile(
      join(root, "src", "a.ts"),
      "// intent\nexport const alpha = 1;\n",
      "utf8",
    );
    await mkdir(artifactsDir, { recursive: true });
    await writeCoreArtifacts(artifactsDir, deepCeilingBundle());

    await cmdNextStep(["--root", root, "--artifacts-dir", artifactsDir]);
    const step = JSON.parse(
      await readFile(join(artifactsDir, "steps", "current-step.json"), "utf8"),
    );
    expect(step.step_kind).toBe("charter_extraction");

    // Write paths are emitted in canonical kind order, so position i binds to
    // kind i. Each lane's node NAMES its own kind, which is what lets the
    // assertion below tell a correct stamp from a constant one.
    const kinds = charterExtractionKindsForCeiling({ rung: "deep" });
    const writePaths = step.access.write_paths as string[];
    expect(writePaths).toHaveLength(kinds.length);
    for (const [i, path] of writePaths.entries()) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({
          nodes: [
            {
              node_id: `authored-by-${kinds[i]}`,
              purpose: "Keep every promise the fixture gives its reader",
              provenance: [
                {
                  kind: "code",
                  ref: "src/a.ts#alpha",
                  quote: "export const alpha = 1;",
                },
              ],
              confidence: "high",
            },
          ],
          edges: [],
        }) + "\n",
        "utf8",
      );
    }

    await cmdNextStep(["--root", root, "--artifacts-dir", artifactsDir]);
    const register = JSON.parse(
      await readFile(join(artifactsDir, "charter_register.json"), "utf8"),
    ) as { lanes: { kind: string; nodes: { node_id: string }[] }[] };

    expect(
      register.lanes.map((lane) => [lane.kind, lane.nodes[0]?.node_id]),
      "each lane must carry the kind of the path it was written to",
    ).toEqual(kinds.map((kind) => [kind, `authored-by-${kind}`]));
  });
});
