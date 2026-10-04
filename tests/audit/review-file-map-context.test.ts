// The complete review call-site map reaches a review lane as a READ-ONLY, tool-generated file bound
// into the lane's review binding, never inlined into the prompt (owner decision 2026-10-04). The
// binding is what makes "read-only" a property rather than a request: acceptance re-hashes every
// bound input, so a submission made against an edited map is refused.
import { afterEach, expect, test } from "vitest";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { toPromptPathToken } from "audit-tools/shared";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { readAuditReviewBinding } from "../../src/audit/cli/auditReviewBindings.js";
import { prepareConceptualDispatch } from "../../src/audit/cli/conceptualDispatch.js";
import { materializeFanoutLanes } from "../../src/audit/cli/fanoutLanes.js";
import { AUDIT_GATE_SUBMISSION_SCOPE, GATE_LANES } from "../../src/audit/cli/laneSubmissions.js";
import { tryConsumeSubmission } from "../../src/audit/cli/nextStepHelpers.js";
import { systemicReviewInputRevision } from "../../src/audit/orchestrator/systemicChallengeExecutor.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const MAP_FILENAME = "review-call-site-map.md";
/** The anchor the map file carries for the one starting-point file. */
const TARGET_ANCHOR = "- **src/target.ts**\n  - referenced by: src/caller.ts";
const LANE = GATE_LANES.design_review_conceptual;

function reviewBundle(): ArtifactBundle {
  return {
    repo_manifest: {
      repository: { name: "map-file-fixture", root: "/repo" },
      generated_at: "2026-01-01T00:00:00.000Z",
      files: [
        { path: "src/caller.ts", language: "typescript", size_bytes: 10 },
        { path: "src/target.ts", language: "typescript", size_bytes: 10 },
      ],
    },
    graph_bundle: { graphs: { calls: [{ from: "src/caller.ts", to: "src/target.ts" }] } },
    unit_manifest: {
      units: [{ unit_id: "target", name: "Target", files: ["src/target.ts"], required_lenses: ["architecture"] }],
    },
    risk_register: { items: [{ unit_id: "target", risk_score: 5, signals: [] }] },
  };
}

async function emitShallow(artifactsDir: string, bundle: ArtifactBundle = reviewBundle()) {
  const dispatch = await prepareConceptualDispatch({
    artifactsDir,
    bundle,
    settings: { conceptual_depth: "shallow", max_units: 5 },
  });
  const promptPath = dispatch.artifactPaths.conceptual_prompt!;
  const mapPath = dispatch.readPaths.find((path) => path.endsWith(MAP_FILENAME));
  return { dispatch, promptPath, mapPath: mapPath!, prompt: await readFile(promptPath, "utf8") };
}

async function tempArtifacts(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

test("the map is a read-only file named in the prompt and bound into the review, not prompt text", async () => {
  const artifactsDir = await tempArtifacts("map-file-");
  const { prompt, mapPath } = await emitShallow(artifactsDir);

  expect(mapPath, "the lane's read set must carry the map file").toBeDefined();
  expect(await readFile(mapPath, "utf8")).toContain(TARGET_ANCHOR);
  expect(prompt).not.toContain(TARGET_ANCHOR);
  expect((await stat(mapPath)).mode & 0o222, "the map file must not be writable").toBe(0);

  // Named under its own section, which precedes the results footer.
  const section = prompt.indexOf("## Read-only context files");
  expect(section).toBeGreaterThan(-1);
  expect(prompt.indexOf(`- \`${toPromptPathToken(mapPath)}\``)).toBeGreaterThan(section);
  expect(prompt.indexOf("## Results path")).toBeGreaterThan(section);

  const binding = await readAuditReviewBinding(artifactsDir, LANE);
  expect(binding?.inputs.map((input) => input.path)).toContain(mapPath);
});

test("a submission made against an edited map file is refused at acceptance", async () => {
  const artifactsDir = await tempArtifacts("map-file-tamper-");
  const { dispatch, mapPath } = await emitShallow(artifactsDir);
  const binding = await readAuditReviewBinding(artifactsDir, LANE);
  await writeFile(
    dispatch.conceptualResultsPath,
    JSON.stringify({
      contract_version: "review-submission/v1",
      prompt_sha256: binding!.promptSha256,
      review: { mode: "independent", reason: "This reviewer did not author the audit." },
      result: { findings: [] },
    }),
  );

  await chmod(mapPath, 0o666);
  await writeFile(mapPath, "- **src/target.ts**\n  - referenced by: (none recorded)\n");
  expect((await tryConsumeSubmission(artifactsDir, LANE)).status).toBe("malformed");

  // The same submission against the restored map is accepted, so the refusal
  // above was the edited map and nothing else.
  await emitShallow(artifactsDir);
  expect((await tryConsumeSubmission(artifactsDir, LANE)).status).toBe("ok");
});

test("two emissions of an unchanged round write identical map bytes at an identical path", async () => {
  const artifactsDir = await tempArtifacts("map-file-stable-");
  const first = await emitShallow(artifactsDir);
  const firstBytes = await readFile(first.mapPath);
  const second = await emitShallow(artifactsDir);
  expect(second.mapPath).toBe(first.mapPath);
  expect((await readFile(second.mapPath)).equals(firstBytes)).toBe(true);
  expect(second.prompt).toBe(first.prompt);
});

test("re-emission replaces a map file whose bytes were changed, and leaves it read-only", async () => {
  const artifactsDir = await tempArtifacts("map-file-repair-");
  const { mapPath } = await emitShallow(artifactsDir);
  const original = await readFile(mapPath, "utf8");
  await chmod(mapPath, 0o666);
  await writeFile(mapPath, "edited");

  await emitShallow(artifactsDir);
  expect(await readFile(mapPath, "utf8")).toBe(original);
  expect((await stat(mapPath)).mode & 0o222).toBe(0);
  expect(await readAuditReviewBinding(artifactsDir, LANE)).toBeDefined();
});

test("a deep round builds the map once: every perspective and the judge bind the same file", async () => {
  const artifactsDir = await tempArtifacts("map-file-deep-");
  const dispatch = await prepareConceptualDispatch({
    artifactsDir,
    bundle: reviewBundle(),
    settings: { conceptual_depth: "deep", perspectives: 2, max_units: 5 },
  });
  const mapPaths = dispatch.readPaths.filter((path) => path.endsWith(MAP_FILENAME));
  expect(mapPaths).toHaveLength(1);
  const prompts = Object.entries(dispatch.artifactPaths)
    .filter(([key]) => key.endsWith("_prompt"))
    .map(([, path]) => path);
  expect(prompts).toHaveLength(3);
  for (const path of prompts) {
    const prompt = await readFile(path, "utf8");
    expect(prompt).toContain(`- \`${toPromptPathToken(mapPaths[0]!)}\``);
    expect(prompt).not.toContain(TARGET_ANCHOR);
  }
});

test("a lane that requires no review binding cannot take generated context", async () => {
  const artifactsDir = await tempArtifacts("map-file-ordinary-");
  await expect(
    materializeFanoutLanes({
      artifactsDir,
      runId: AUDIT_GATE_SUBMISSION_SCOPE,
      lanes: [{
        id: "synthesis_narrative",
        label: "Ordinary",
        promptFilename: "ordinary.md",
        promptText: "Write.",
        fileCount: 1,
        riskScore: 0.1,
        generatedContext: [{ filename: "x.md", label: "x", text: "x" }],
      }],
    }),
  ).rejects.toThrow(/no review binding/);
});

test("a rewired call site re-stales a pending systemic round though its prompt summary is unchanged", () => {
  // Same edge count, same anchor count, same scope — only the caller differs, and
  // only the map file says so.
  const withCaller = (caller: string): ArtifactBundle => ({
    ...reviewBundle(),
    repo_manifest: {
      ...reviewBundle().repo_manifest!,
      files: [...reviewBundle().repo_manifest!.files, { path: "src/other.ts", language: "typescript", size_bytes: 10 }],
    },
    graph_bundle: { graphs: { calls: [{ from: caller, to: "src/target.ts" }] } },
    design_assessment: {
      generated_at: "2026-01-01T00:00:00.000Z",
      findings: [],
      contract_findings: [{
        id: "CR-001",
        title: "target is serial",
        category: "systemic_improvement",
        severity: "medium",
        confidence: "medium",
        lens: "architecture",
        summary: "target does the work serially",
        evidence: ["`run` in src/target.ts does the work serially"],
        affected_files: [{ path: "src/target.ts" }],
      }],
      contract_reviewed: true,
      conceptual_findings: [],
      conceptual_reviewed: true,
    },
  });
  expect(systemicReviewInputRevision(withCaller("src/caller.ts"))).not.toBe(
    systemicReviewInputRevision(withCaller("src/other.ts")),
  );
});
