import { test, expect } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWrapper } from "./helpers/run-wrapper.mjs";
import { writeFixtureRepo } from "./helpers/fixture.mjs";
import { HEAVY_AUDIT_TEST_TIMEOUT_MS } from "../helpers/heavy-timeout.mjs";

const { writeCoreArtifacts } = await import("../../src/audit/io/artifacts.ts");
const { advanceAudit } = await import("../../src/audit/orchestrator/advance.ts");
const { buildAdvancedBundle } = await import("./helpers/advancedBundle.mjs");

// A host-authored critical flow the deterministic inference never produced.
const HOST_FLOW = {
  id: "flow:host:authentication",
  name: "authentication flow",
  entrypoints: ["src/api/auth.ts"],
  paths: ["src/api/auth.ts", "src/lib/session.ts"],
  concerns: ["security"],
  confidence: "high",
};

/**
 * Persist a structure-stage bundle whose deterministic critical-flow inference is
 * FORCED below the confidence bar (`fallback_required`), leaving
 * critical_flow_fallback_current as the next outstanding obligation. Metadata is
 * dropped so the hand-shaped state reads as a valid first-run (presence-based
 * staleness) — otherwise the mutated critical_flows re-stales structure, which
 * would rebuild it and recompute `fallback_required` back to the fixture's natural
 * (bar-met) value. This mirrors the edge-reasoning fixture pattern.
 */
async function persistFallbackState(root, artifactsDir) {
  const bundle = await buildAdvancedBundle(root, "critical_flow_fallback_current");
  bundle.critical_flows.fallback_required = true;
  delete bundle.artifact_metadata;
  await mkdir(artifactsDir, { recursive: true });
  await writeCoreArtifacts(artifactsDir, bundle);
  await writeFile(
    join(artifactsDir, "session-config.json"),
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

// Post-G2 the backend provider identity rides the per-invocation --auditor
// descriptor rather than the persisted session-config.json (which now rejects it).
const AUDITOR_ARGS = ["--auditor", JSON.stringify({ self: { provider: "worker-command" } })];

test.concurrent("next-step emits a host critical-flow fallback step, then persists + satisfies on the host submission", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-cff-"));
  const root = join(tempDir, "repo");
  const artifactsDir = join(root, ".audit-tools/audit");
  try {
    await writeFixtureRepo(root);
    await persistFallbackState(root, artifactsDir);

    // First next-step pauses on the critical-flow fallback host gate.
    const paused = JSON.parse(
      (await runWrapper(
        ["next-step", "--no-host-can-dispatch-subagents", ...AUDITOR_ARGS],
        { cwd: root },
      )).stdout,
    );
    expect(paused.step_kind).toBe("critical_flow_fallback");
    expect(paused.status).toBe("ready");
    const resultsPath = paused.artifact_paths.critical_flow_fallback_results;
    expect(resultsPath).toMatch(/critical-flow-fallback\.json$/);
    // The results path is pre-declared writable.
    expect(
      (paused.access?.write_paths ?? []).some((p) =>
        p.endsWith("critical-flow-fallback.json"),
      ),
    ).toBeTruthy();
    const prompt = await readFile(paused.prompt_path, "utf8");
    expect(prompt).toMatch(/Critical-flow fallback/);
    expect(prompt).toMatch(/"flows"/);
    expect(prompt).toMatch(/critical-flow-fallback\.json/);

    // Host authors the enrichment.
    await writeFile(
      resultsPath,
      JSON.stringify({ flows: [HOST_FLOW] }, null, 2) + "\n",
    );

    // Re-run: the submission is consumed + persisted and the obligation is
    // satisfied (the run advances past the gate, never re-asking).
    const advanced = JSON.parse(
      (await runWrapper(
        ["next-step", "--no-host-can-dispatch-subagents", ...AUDITOR_ARGS],
        { cwd: root },
      )).stdout,
    );
    expect(advanced.step_kind).not.toBe("critical_flow_fallback");

    // The durable host submission was persisted as the upstream input.
    const marker = JSON.parse(
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
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    await writeFile(
      join(artifactsDir, "incoming", "critical-flow-fallback.json"),
      JSON.stringify({ flows: [] }, null, 2) + "\n",
    );

    const step = JSON.parse(
      (await runWrapper(
        ["next-step", "--no-host-can-dispatch-subagents", ...AUDITOR_ARGS],
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
    const bundle = await buildAdvancedBundle(
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
    const flows = result.updated_bundle.critical_flows.flows;
    const merged = flows.find((f) => f.id === HOST_FLOW.id);
    expect(merged, "host-authored flow is merged into critical_flows").toBeTruthy();
    expect(merged.confidence).toBe("high");
    expect(merged.paths).toEqual(HOST_FLOW.paths);
    // Additive: the deterministic flows are preserved alongside the host flow.
    expect(flows.length).toBeGreaterThan(1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
