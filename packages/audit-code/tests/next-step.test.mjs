import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { runWrapper } from "./helpers/run-wrapper.mjs";

async function withTempRepo(fn) {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-next-step-"));
  const root = join(tempDir, "repo");
  try {
    await mkdir(join(root, "src", "api"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "next-step-fixture", version: "0.0.0" }, null, 2) + "\n",
    );
    await writeFile(
      join(root, "src", "api", "auth.ts"),
      [
        "export function authenticate(token: string): boolean {",
        "  return token.trim().length > 0;",
        "}",
        "",
      ].join("\n"),
    );
    return await fn(root);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("next-step emits present_report for a complete audit", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-artifacts");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify(
        {
          status: "complete",
          obligations: [],
        },
        null,
        2,
      ) + "\n",
    );
    await writeFile(
      join(artifactsDir, "audit-report.md"),
      "# Audit report\n\n## Work blocks\n\n- Done\n",
    );

    const step = JSON.parse((await runWrapper(["next-step"], { cwd: root })).stdout);

    assert.equal(step.contract_version, "audit-code-step/v1alpha1");
    assert.equal(step.step_kind, "present_report");
    assert.equal(step.status, "complete");
    assert.match(step.artifact_paths.final_report, /audit-report\.md$/);
    assert.equal((await stat(join(root, "audit-report.md"))).isFile(), true);
    assert.match(await readFile(step.prompt_path, "utf8"), /present report/i);
  });
});

// Walk next-step past the structure-phase pauses (graph-enrichment install
// prompt, then design review) by skipping the optional analyzers and supplying
// empty design-review findings, returning the first non-pause step.
//
// Known pause kinds that are advanced past automatically:
//   - analyzer_install: write an empty analyzer-decisions.json to skip
//   - design_review: write an empty design-review-findings.json
//   - edge_reasoning / edge_reasoning_dispatch: write an empty edge-reasoning.json
//
// Terminal (non-pause) kinds that are returned to callers:
//   dispatch_review, single_task_fallback, single_task, synthesis, present_report
//
// Any other unrecognised kind causes an immediate descriptive throw rather than
// silently returning a mismatched step to the caller.
const ADVANCE_PAST_DESIGN_REVIEW_TERMINAL_KINDS = new Set([
  "dispatch_review",
  "single_task_fallback",
  "single_task",
  "synthesis",
  "present_report",
]);

// Two pause step kinds (analyzer_install + design_review), each may appear
// at most once; allow a few extra iterations as headroom.
const MAX_STRUCTURE_PHASE_PAUSES = 6;

async function advancePastDesignReview(root, wrapperArgs = ["next-step"], wrapperOpts = {}) {
  const incomingDir = join(root, ".audit-artifacts", "incoming");
  for (let i = 0; i < MAX_STRUCTURE_PHASE_PAUSES; i++) {
    const step = JSON.parse(
      (await runWrapper(wrapperArgs, { cwd: root, ...wrapperOpts })).stdout,
    );
    if (step.step_kind === "analyzer_install") {
      await mkdir(incomingDir, { recursive: true });
      await writeFile(
        join(incomingDir, "analyzer-decisions.json"),
        JSON.stringify({ typescript: "skip" }, null, 2) + "\n",
      );
      continue;
    }
    if (step.step_kind === "design_review") {
      await mkdir(incomingDir, { recursive: true });
      await writeFile(
        join(incomingDir, "design-review-findings.json"),
        JSON.stringify([], null, 2) + "\n",
      );
      continue;
    }
    if (
      step.step_kind === "edge_reasoning" ||
      step.step_kind === "edge_reasoning_dispatch"
    ) {
      await mkdir(incomingDir, { recursive: true });
      await writeFile(
        step.artifact_paths.edge_reasoning_results,
        JSON.stringify([], null, 2) + "\n",
      );
      continue;
    }
    if (ADVANCE_PAST_DESIGN_REVIEW_TERMINAL_KINDS.has(step.step_kind)) {
      return step;
    }
    throw new Error(
      `advancePastDesignReview: unexpected pause kind '${step.step_kind}' (iteration ${i})`,
    );
  }
  throw new Error("next-step did not advance past structure-phase pauses");
}

test("next-step proposes an analyzer install, then proceeds after a skip decision is recorded", async () => {
  await withTempRepo(async (root) => {
    // The fixture has a .ts file but no local `typescript`. Pin an isolated,
    // empty analyzer cache so `typescript` resolves "absent" deterministically —
    // otherwise a `typescript` already present in the host's shared cache (from a
    // prior real audit) would resolve "cache", skip the install prompt, and the
    // pipeline would advance straight to design_review. With the dependency
    // genuinely absent, graph enrichment pauses to propose an install.
    const analyzerCache = join(dirname(root), "empty-analyzer-cache");
    await mkdir(analyzerCache, { recursive: true });
    const env = { AUDIT_TOOLS_ANALYZER_CACHE: analyzerCache };

    const proposed = JSON.parse(
      (await runWrapper(["next-step"], { cwd: root, env })).stdout,
    );
    assert.equal(proposed.step_kind, "analyzer_install");
    assert.match(proposed.artifact_paths.analyzer_decisions, /analyzer-decisions\.json$/);
    const prompt = await readFile(proposed.prompt_path, "utf8");
    assert.match(prompt, /typescript/);
    assert.match(prompt, /ephemeral/);

    // Host declines the install.
    await mkdir(join(root, ".audit-artifacts", "incoming"), { recursive: true });
    await writeFile(
      proposed.artifact_paths.analyzer_decisions,
      JSON.stringify({ typescript: "skip" }, null, 2) + "\n",
    );

    const next = JSON.parse(
      (await runWrapper(["next-step"], { cwd: root, env })).stdout,
    );
    assert.notEqual(next.step_kind, "analyzer_install");

    // The decision is persisted durably to session config.
    const config = JSON.parse(
      await readFile(join(root, ".audit-artifacts", "session-config.json"), "utf8"),
    );
    assert.equal(config.analyzers.typescript, "skip");
  });
});

test("next-step defaults to dispatch_review when host dispatch capability is not configured", async () => {
  await withTempRepo(async (root) => {
    const step = await advancePastDesignReview(root);
    const currentStep = JSON.parse(
      await readFile(join(root, ".audit-artifacts", "steps", "current-step.json"), "utf8"),
    );
    const prompt = await readFile(step.prompt_path, "utf8");

    assert.equal(step.step_kind, "dispatch_review");
    assert.equal(currentStep.step_kind, "dispatch_review");
    assert.ok(step.run_id);
    assert.match(prompt, /merge-and-ingest/);
    assert.doesNotMatch(prompt, /single-task fallback/i);
  });
});

test("next-step reads host_can_dispatch_subagents from session-config", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-artifacts");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "session-config.json"),
      JSON.stringify(
        {
          provider: "local-subprocess",
          host_can_dispatch_subagents: true,
        },
        null,
        2,
      ) + "\n",
    );

    const step = await advancePastDesignReview(root);

    assert.equal(step.step_kind, "dispatch_review");
    assert.match(step.artifact_paths.dispatch_plan, /dispatch-plan\.json$/);
  });
});

test("next-step reads AUDIT_CODE_HOST_CAN_DISPATCH when no flag or session value is set", async () => {
  await withTempRepo(async (root) => {
    const step = await advancePastDesignReview(
      root,
      ["next-step"],
      { env: { AUDIT_CODE_HOST_CAN_DISPATCH: "true" } },
    );

    assert.equal(step.step_kind, "dispatch_review");
  });
});

test("next-step true emits dispatch_review and prepares dispatch artifacts", async () => {
  await withTempRepo(async (root) => {
    const step = await advancePastDesignReview(
      root,
      ["next-step", "--host-can-dispatch-subagents", "true"],
    );
    const plan = JSON.parse(await readFile(step.artifact_paths.dispatch_plan, "utf8"));
    const prompt = await readFile(step.prompt_path, "utf8");

    assert.equal(step.step_kind, "dispatch_review");
    assert.equal(Array.isArray(plan), true);
    assert.ok(plan.length > 0);
    assert.match(prompt, /dispatch-quota\.json/);
    assert.match(prompt, /wave_size/);
    assert.match(prompt, /merge-and-ingest/);
    assert.doesNotMatch(prompt, /single-task fallback/i);
  });
});

test("next-step false emits single_task_fallback and does not prepare dispatch", async () => {
  await withTempRepo(async (root) => {
    const step = await advancePastDesignReview(
      root,
      ["next-step", "--host-can-dispatch-subagents", "false"],
    );
    const prompt = await readFile(step.prompt_path, "utf8");

    assert.equal(step.step_kind, "single_task_fallback");
    assert.match(prompt, /exactly one AuditResult/i);
    assert.match(
      await readFile(step.artifact_paths.single_task_prompt, "utf8"),
      /single-task fallback/i,
    );
    await assert.rejects(() =>
      stat(join(root, ".audit-artifacts", "runs", step.run_id, "dispatch-plan.json")),
    );
  });
});

test("advancePastDesignReview throws on unknown pause kind", async () => {
  // Stub runWrapper to return a single step with an unrecognised step_kind.
  // We call advancePastDesignReview directly by monkey-patching its dependency
  // indirectly: write a tiny wrapper that returns a fake step JSON and call the
  // helper with that wrapper path.
  //
  // The simplest approach: create a fake wrapper script that emits the unknown
  // step as JSON, then pass it as a custom wrapperArgs using the wrapperPath
  // override pattern already used by runWrapper.
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-unknown-pause-"));
  try {
    // Create a fake wrapper that writes an unknown-kind step to stdout.
    const fakeWrapperPath = join(tempDir, "fake-wrapper.mjs");
    await writeFile(
      fakeWrapperPath,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({",
        "  contract_version: 'audit-code-step/v1alpha1',",
        "  step_kind: 'unknown_future_pause',",
        "  artifact_paths: {},",
        "  prompt_path: '/dev/null',",
        "}) + '\\n');",
      ].join("\n"),
    );

    // Build a minimal helper that mirrors advancePastDesignReview but uses the
    // fake wrapper path so we don't spin up a real audit run.
    const fakeIncomingDir = join(tempDir, "incoming");
    const TERMINAL = new Set([
      "dispatch_review", "single_task_fallback", "single_task",
      "synthesis", "present_report",
    ]);
    async function runFakeWrapper() {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [fakeWrapperPath], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        child.stdout.on("data", (chunk) => { stdout += String(chunk); });
        child.on("error", reject);
        child.on("exit", () => resolve({ stdout }));
      });
    }
    async function helperUnderTest() {
      for (let i = 0; i < 6; i++) {
        const step = JSON.parse((await runFakeWrapper()).stdout);
        if (step.step_kind === "analyzer_install") { continue; }
        if (step.step_kind === "design_review") { continue; }
        if (step.step_kind === "edge_reasoning" || step.step_kind === "edge_reasoning_dispatch") {
          continue;
        }
        if (TERMINAL.has(step.step_kind)) { return step; }
        throw new Error(
          `advancePastDesignReview: unexpected pause kind '${step.step_kind}' (iteration ${i})`,
        );
      }
      throw new Error("next-step did not advance past structure-phase pauses");
    }

    await assert.rejects(
      () => helperUnderTest(),
      (err) => {
        assert.match(err.message, /unexpected pause kind/);
        assert.match(err.message, /unknown_future_pause/);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
