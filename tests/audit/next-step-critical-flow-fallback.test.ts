import { test, expect } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWrapper } from "./helpers/run-wrapper.mjs";
import { writeFixtureRepo } from "./helpers/fixture.mjs";
import { HEAVY_AUDIT_TEST_TIMEOUT_MS } from "../helpers/heavy-timeout.mjs";
import type { CriticalFlow } from "audit-tools/shared";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";

const { GATE_LANES, laneSubmissionPath } = await import(
  "../../src/audit/cli/laneSubmissions.js"
);
const { submissionsDir } = await import(
  "../../src/shared/io/auditToolsPaths.js"
);
const { writeCoreArtifacts } = await import("../../src/audit/io/artifacts.js");
const { advanceAudit } = await import("../../src/audit/orchestrator/advance.js");
const { buildAdvancedBundle } = await import("./helpers/advancedBundle.mjs");

interface CriticalFlowFallbackStep {
  step_kind: string;
  status: string;
  prompt_path: string;
  artifact_paths: Record<string, string>;
  access?: {
    write_paths?: string[];
  };
}

// A host-authored critical flow the deterministic inference never produced.
const HOST_FLOW = {
  id: "flow:host:authentication",
  name: "authentication flow",
  entrypoints: ["src/api/auth.ts"],
  paths: ["src/api/auth.ts", "src/lib/session.ts"],
  concerns: ["security"],
  confidence: "high",
} satisfies CriticalFlow;

/**
 * Persist a structure-stage bundle whose deterministic critical-flow inference is
 * FORCED below the confidence bar (`fallback_required`), leaving
 * critical_flow_fallback_current as the next outstanding obligation. Metadata is
 * dropped so the hand-shaped state reads as a valid first-run (presence-based
 * staleness) — otherwise the mutated critical_flows re-stales structure, which
 * would rebuild it and recompute `fallback_required` back to the fixture's natural
 * (bar-met) value. This mirrors the edge-reasoning fixture pattern.
 */
async function persistFallbackState(
  root: string,
  artifactsDir: string,
): Promise<void> {
  const bundle: ArtifactBundle = await buildAdvancedBundle(
    root,
    "critical_flow_fallback_current",
  );
  if (!bundle.critical_flows) {
    throw new Error("advanced bundle missing critical_flows");
  }
  bundle.critical_flows.fallback_required = true;
  delete bundle.artifact_metadata;
  await mkdir(artifactsDir, { recursive: true });
  await writeCoreArtifacts(artifactsDir, bundle);
  await writeFile(
    join(artifactsDir, "analyzer-policy.json"),
    JSON.stringify(
      {
        analyzers: {
          typescript: "skip",
          python: "skip",
          html: "skip",
          css: "skip",
          sql: "skip",
        },
      },
      null,
      2,
    ) + "\n",
  );
}

test.concurrent("next-step emits a host critical-flow fallback step, then persists + satisfies on the host submission", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-cff-"));
  const root = join(tempDir, "repo");
  const artifactsDir = join(root, ".audit-tools/audit");
  try {
    await writeFixtureRepo(root);
    await persistFallbackState(root, artifactsDir);

    // First next-step pauses on the critical-flow fallback host gate.
    const paused: CriticalFlowFallbackStep = JSON.parse(
      (await runWrapper(
        ["next-step"],
        { cwd: root },
      )).stdout,
    );
    expect(paused.step_kind).toBe("critical_flow_fallback");
    expect(paused.status).toBe("ready");
    const resultsPath = paused.artifact_paths.critical_flow_fallback_results;
    // The submission path is TOOL-computed \u2014 a digest of the lane's minted id,
    // not a name the host could type. (The registered
    // `critical-flow-fallback.json` ARTIFACT the executor writes keeps its name;
    // this is the submission that feeds it.)
    expect(resultsPath.replaceAll("\\", "/")).toMatch(
      /\/submissions\/[0-9a-f]{64}\.json$/u,
    );
    // The results path is pre-declared writable.
    expect(
      (paused.access?.write_paths ?? []).some(
        (p) => p.replaceAll("\\", "/") === resultsPath.replaceAll("\\", "/"),
      ),
    ).toBeTruthy();
    // Always-materialized (design resolution 2): the flow-stub body lives in
    // the LANE file; the step prompt is the capability-neutral instruction.
    const stepPrompt = await readFile(paused.prompt_path, "utf8");
    expect(stepPrompt).toMatch(/critical-flow fallback/i);
    expect(stepPrompt.replaceAll("\\", "/")).toContain(
      resultsPath.replaceAll("\\", "/"),
    );
    expect(stepPrompt).toMatch(/sequentially yourself|else read and follow/);
    const lanePromptPath = paused.artifact_paths.critical_flow_fallback_prompt;
    expect(lanePromptPath).toMatch(/critical-flow-fallback-prompt\.md$/);
    const lanePrompt = await readFile(lanePromptPath, "utf8");
    expect(lanePrompt).toMatch(/Critical-flow fallback/i);
    expect(lanePrompt).toMatch(/"flows"/);
    // Lane files are advance-free — the continue lives in the step prompt.
    expect(lanePrompt).not.toMatch(/next-step/);

    // Host authors the enrichment.
    await writeFile(
      resultsPath,
      JSON.stringify({ flows: [HOST_FLOW] }, null, 2) + "\n",
    );

    // Re-run: the submission is consumed + persisted and the obligation is
    // satisfied (the run advances past the gate, never re-asking).
    const advanced: CriticalFlowFallbackStep = JSON.parse(
      (await runWrapper(
        ["next-step"],
        { cwd: root },
      )).stdout,
    );
    expect(advanced.step_kind).not.toBe("critical_flow_fallback");

    // The durable host submission was persisted as the upstream input.
    const marker: { flows: CriticalFlow[] } = JSON.parse(
      await readFile(join(artifactsDir, "critical-flow-fallback.json"), "utf8"),
    );
    expect(marker.flows.map((f) => f.id)).toContain(HOST_FLOW.id);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.concurrent("next-step does not re-ask the critical-flow fallback once a submission is present", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-cff-once-"));
  const root = join(tempDir, "repo");
  const artifactsDir = join(root, ".audit-tools/audit");
  try {
    await writeFixtureRepo(root);
    await persistFallbackState(root, artifactsDir);

    // Provide the host submission up front (empty is a valid "nothing to add").
    await mkdir(submissionsDir(artifactsDir), { recursive: true });
    await writeFile(
      laneSubmissionPath(artifactsDir, GATE_LANES.critical_flow_fallback),
      JSON.stringify({ flows: [] }, null, 2) + "\n",
    );

    const step: CriticalFlowFallbackStep = JSON.parse(
      (await runWrapper(
        ["next-step"],
        { cwd: root },
      )).stdout,
    );
    // The submission is consumed and the run advances past the gate — it never
    // pauses again on critical_flow_fallback (submission present → satisfied).
    expect(step.step_kind).not.toBe("critical_flow_fallback");

    const marker = JSON.parse(
      await readFile(join(artifactsDir, "critical-flow-fallback.json"), "utf8"),
    );
    expect(Array.isArray(marker.flows)).toBeTruthy();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.concurrent("structure merges the host critical-flow submission into critical_flows in place", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-cff-merge-"));
  const root = join(tempDir, "repo");
  try {
    await writeFixtureRepo(root);
    const bundle: ArtifactBundle = await buildAdvancedBundle(
      root,
      "critical_flow_fallback_current",
    );

    // With the durable host submission present, a structure re-run folds the host
    // flows into critical_flows additively — the enrichment taking effect via the
    // normal upstream-input DAG (no post-hoc rewrite of critical_flows).
    const result = await advanceAudit(
      { ...bundle, critical_flow_fallback: { flows: [HOST_FLOW] } },
      { preferredExecutor: "structure_executor" },
    );
    if (!result.updated_bundle.critical_flows) {
      throw new Error("structure executor omitted critical_flows");
    }
    const flows = result.updated_bundle.critical_flows.flows;
    const merged = flows.find((f) => f.id === HOST_FLOW.id);
    expect(merged, "host-authored flow is merged into critical_flows").toBeTruthy();
    if (!merged) throw new Error("host-authored flow was not merged");
    expect(merged.confidence).toBe("high");
    expect(merged.paths).toEqual(HOST_FLOW.paths);
    // Additive: the deterministic flows are preserved alongside the host flow.
    expect(flows.length).toBeGreaterThan(1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
