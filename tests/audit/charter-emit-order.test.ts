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
import { join } from "node:path";

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
      review_findings: [],
      reviewed: true,
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
