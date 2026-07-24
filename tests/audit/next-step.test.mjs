import { test, expect } from "vitest";
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
import { spawnHidden as spawn } from "../helpers/spawn.mjs";
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
    // Pre-satisfy the interactive provider-confirmation gate (accept the suggested
    // ordering) so tests that assert a specific FIRST next-step reach it directly.
    // Without this the gate would halt first whenever the host has ≥2 dispatchable
    // providers on PATH — a PATH-dependent (non-hermetic) stop point orthogonal to
    // what these tests exercise.
    const seededArtifactsDir = join(root, ".audit-tools/audit");
    await mkdir(seededArtifactsDir, { recursive: true });
    await writeFile(
      join(seededArtifactsDir, "provider-confirmation.input.json"),
      JSON.stringify({ schema_version: "provider-confirmation-input/v1" }, null, 2) + "\n",
    );
    return await fn(root);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test.concurrent("next-step emits present_report for a complete audit", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools/audit");
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

    // Seed a pre-satisfied friction record so present_report emits status:"complete"
    // rather than status:"ready" (friction triage requires ≥1 open_observation;
    // without the record the tool materializes one with needs_open_observations=true).
    const frictionDir = join(artifactsDir, "friction");
    await mkdir(frictionDir, { recursive: true });
    await writeFile(
      join(frictionDir, "run.json"),
      JSON.stringify({
        schema_version: "friction-capture/v1alpha1",
        tool: "audit-code",
        run_id: "run",
        captured_at: new Date().toISOString(),
        frictions: [],
        dispositions: [],
        category_attestations: [
          { category: "ambiguous_direction", note: "none this run" },
          { category: "tool_should_decide", note: "none this run" },
          { category: "inefficient_feeding", note: "none this run" },
        ],
      }) + "\n",
    );

    const step = JSON.parse((await runWrapper(["next-step"], { cwd: root })).stdout);

    expect(step.contract_version).toBe("audit-code-step/v1alpha1");
    expect(step.step_kind).toBe("present_report");
    expect(step.status).toBe("complete");
    expect(step.artifact_paths.final_report).toMatch(/audit-report\.md$/);
    expect((await stat(join(root, ".audit-tools", "audit-report.md"))).isFile()).toBe(true);
    expect(await readFile(step.prompt_path, "utf8")).toMatch(/present report/i);
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

// Several pause step kinds (analyzer_install + design_review_parallel/contract/conceptual
// + confirm_intent + optional edge_reasoning), each at most once; allow extra headroom.
const MAX_STRUCTURE_PHASE_PAUSES = 8;

async function advancePastDesignReview(root, wrapperArgs = ["next-step"], wrapperOpts = {}) {
  const incomingDir = join(root, ".audit-tools/audit", "incoming");
  for (let i = 0; i < MAX_STRUCTURE_PHASE_PAUSES; i++) {
    const step = JSON.parse(
      (await runWrapper(wrapperArgs, { cwd: root, ...wrapperOpts })).stdout,
    );
    if (step.step_kind === "critical_flow_fallback") {
      await mkdir(incomingDir, { recursive: true });
      await writeFile(
        step.artifact_paths.critical_flow_fallback_results,
        JSON.stringify({ flows: [] }, null, 2) + "\n",
      );
      continue;
    }
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
    if (step.step_kind === "design_review_parallel") {
      // Regression (double-driver): the dispatched contract-review WORKER packet
      // must NOT carry the orchestrator advance command — a worker that runs
      // `next-step` becomes a SECOND driver while the host is mid-parallel-dispatch.
      // The advance belongs solely to the host step prompt. (Discriminate on the
      // instruction phrasing, not the bare "next-step" token, which also appears
      // inside the temp-repo path the packet legitimately prints.)
      const workerPacket = await readFile(step.artifact_paths.contract_prompt, "utf8");
      expect(workerPacket).not.toContain("Then run:");
      const hostPrompt = await readFile(step.prompt_path, "utf8");
      expect(hostPrompt).toContain("both been written, run:");
      await mkdir(incomingDir, { recursive: true });
      await writeFile(
        join(incomingDir, "design-review-contract-findings.json"),
        JSON.stringify([], null, 2) + "\n",
      );
      await writeFile(
        join(incomingDir, "design-review-conceptual-findings.json"),
        JSON.stringify([], null, 2) + "\n",
      );
      continue;
    }
    if (step.step_kind === "design_review_contract") {
      await mkdir(incomingDir, { recursive: true });
      await writeFile(
        join(incomingDir, "design-review-contract-findings.json"),
        JSON.stringify([], null, 2) + "\n",
      );
      continue;
    }
    if (step.step_kind === "design_review_conceptual") {
      await mkdir(incomingDir, { recursive: true });
      await writeFile(
        join(incomingDir, "design-review-conceptual-findings.json"),
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
    if (step.step_kind === "provider_confirmation") {
      await writeFile(
        step.artifact_paths.provider_confirmation_input,
        JSON.stringify(
          { schema_version: "provider-confirmation-input/v1" },
          null,
          2,
        ) + "\n",
      );
      continue;
    }
    if (step.step_kind === "confirm_intent") {
      await writeFile(
        step.artifact_paths.intent_checkpoint,
        JSON.stringify(
          {
            schema_version: "intent-checkpoint/v1",
            confirmed_at: "2026-04-22T00:00:00Z",
            confirmed_by: "host",
            scope_summary: "test scope",
            intent_summary: "full-audit",
          },
          null,
          2,
        ) + "\n",
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

test.concurrent("next-step proposes an analyzer install, then proceeds after a skip decision is recorded", async () => {
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

    // Pre-satisfy the critical-flow fallback gate (this fixture's deterministic
    // flow inference falls below the confidence bar) so the first pause under test
    // is the analyzer install, not the fallback host step.
    await mkdir(join(root, ".audit-tools/audit", "incoming"), { recursive: true });
    await writeFile(
      join(root, ".audit-tools/audit", "incoming", "critical-flow-fallback.json"),
      JSON.stringify({ flows: [] }, null, 2) + "\n",
    );

    const proposed = JSON.parse(
      (await runWrapper(["next-step"], { cwd: root, env })).stdout,
    );
    expect(proposed.step_kind).toBe("analyzer_install");
    expect(proposed.artifact_paths.analyzer_decisions).toMatch(/analyzer-decisions\.json$/);
    const prompt = await readFile(proposed.prompt_path, "utf8");
    expect(prompt).toMatch(/typescript/);
    expect(prompt).toMatch(/ephemeral/);

    // Host declines the install.
    await mkdir(join(root, ".audit-tools/audit", "incoming"), { recursive: true });
    await writeFile(
      proposed.artifact_paths.analyzer_decisions,
      JSON.stringify({ typescript: "skip" }, null, 2) + "\n",
    );

    const next = JSON.parse(
      (await runWrapper(["next-step"], { cwd: root, env })).stdout,
    );
    expect(next.step_kind).not.toBe("analyzer_install");

    // The decision is persisted durably to session config.
    const config = JSON.parse(
      await readFile(join(root, ".audit-tools/audit", "session-config.json"), "utf8"),
    );
    expect(config.analyzers.typescript).toBe("skip");
  });
});

test.concurrent("next-step defaults to dispatch_review when host dispatch capability is not configured", async () => {
  await withTempRepo(async (root) => {
    const step = await advancePastDesignReview(root);
    const currentStep = JSON.parse(
      await readFile(join(root, ".audit-tools/audit", "steps", "current-step.json"), "utf8"),
    );
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(step.step_kind).toBe("dispatch_review");
    expect(currentStep.step_kind).toBe("dispatch_review");
    expect(step.run_id).toBeTruthy();
    expect(prompt).toMatch(/merge-and-ingest/);
    expect(prompt).not.toMatch(/single-task fallback/i);
  });
});

test.concurrent("next-step reads host_can_dispatch_subagents from session-config", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "session-config.json"),
      JSON.stringify(
        {
          host_can_dispatch_subagents: true,
        },
        null,
        2,
      ) + "\n",
    );

    const step = await advancePastDesignReview(root, [
      "next-step",
      "--auditor",
      JSON.stringify({ self: { provider: "worker-command" } }),
    ]);

    expect(step.step_kind).toBe("dispatch_review");
    expect(step.artifact_paths.dispatch_plan).toMatch(/dispatch-plan\.json$/);
  });
});

test.concurrent("next-step reads AUDIT_CODE_HOST_CAN_DISPATCH when no flag or session value is set", async () => {
  await withTempRepo(async (root) => {
    const step = await advancePastDesignReview(
      root,
      ["next-step"],
      { env: { AUDIT_CODE_HOST_CAN_DISPATCH: "true" } },
    );

    expect(step.step_kind).toBe("dispatch_review");
  });
});

test.concurrent("next-step true emits dispatch_review and prepares dispatch artifacts", async () => {
  await withTempRepo(async (root) => {
    const step = await advancePastDesignReview(
      root,
      ["next-step", "--auditor", '{"self":{"can_dispatch_subagents":true}}'],
    );
    const plan = JSON.parse(await readFile(step.artifact_paths.dispatch_plan, "utf8"));
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(step.step_kind).toBe("dispatch_review");
    expect(Array.isArray(plan)).toBe(true);
    expect(plan.length > 0).toBeTruthy();
    expect(prompt).toMatch(/dispatch-quota\.json/);
    expect(prompt).toMatch(/admission\.granted_packet_ids/);
    expect(prompt).toMatch(/merge-and-ingest/);
    expect(prompt).not.toMatch(/single-task fallback/i);
  });
});

test.concurrent("next-step false emits single_task_fallback and does not prepare dispatch", async () => {
  await withTempRepo(async (root) => {
    const step = await advancePastDesignReview(
      root,
      ["next-step", "--auditor", '{"self":{"can_dispatch_subagents":false}}'],
    );
    const prompt = await readFile(step.prompt_path, "utf8");

    expect(step.step_kind).toBe("single_task_fallback");
    expect(prompt).toMatch(/exactly one AuditResult/i);
    expect(await readFile(step.artifact_paths.single_task_prompt, "utf8")).toMatch(/single-task fallback/i);
    await assert.rejects(() =>
      stat(join(root, ".audit-tools/audit", "runs", step.run_id, "dispatch-plan.json")),
    );
  });
});

test.concurrent("advancePastDesignReview throws on unknown pause kind", async () => {
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
        expect(err.message).toMatch(/unexpected pause kind/);
        expect(err.message).toMatch(/unknown_future_pause/);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// INV-READY-STEP-CONTINUATION (COR-f6a36670): any current-step written with
// status "ready" whose stop_condition instructs calling next-step again must
// carry the executable continuation command in allowed_commands — the host must
// never have to reconstruct the invocation from prose.
// ---------------------------------------------------------------------------

test("present_report with pending friction triage is a ready step carrying the next-step continuation command", async () => {
  // In-process (no wrapper spawn) so the check stays build-free: the wrapper
  // path imports from dist/, which the accept gate does not build.
  const { cmdNextStep } = await import("../../src/audit/cli/nextStepCommand.ts");
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify({ status: "complete", obligations: [] }, null, 2) + "\n",
    );
    await writeFile(
      join(artifactsDir, "audit-report.md"),
      "# Audit report\n\n## Work blocks\n\n- Done\n",
    );
    // NO pre-satisfied friction record: triage is pending, so the step must be
    // status "ready" with a stop_condition instructing another next-step call.

    await cmdNextStep(["--root", root, "--artifacts-dir", artifactsDir]);
    const step = JSON.parse(
      await readFile(join(artifactsDir, "steps", "current-step.json"), "utf8"),
    );

    expect(step.step_kind).toBe("present_report");
    expect(step.status).toBe("ready");
    expect(step.stop_condition).toMatch(/next-step/i);
    expect(
      step.allowed_commands.some((command) => /next-step/.test(command)),
      `a ready step whose stop_condition says to call next-step again must carry the executable continuation command; got: ${JSON.stringify(step.allowed_commands)}`,
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Terminal-exit backstop (backlog: abnormal-exit no-step-contract): a fatal
// next-step exit must overwrite current-step.json with a blocked step naming
// the cause — a consumer must never read the PREVIOUS step as live after a
// crash. The trigger here (a missing --guidance-file) is one arbitrary member
// of the covered class (quota-wall abort, engine maxTransitions throw, parse
// crash, IO error): the backstop wraps the whole command body, so any throw
// exercises the same path.
// ---------------------------------------------------------------------------

test("a fatal next-step exit overwrites the stale step with a blocked step naming the cause", async () => {
  const { cmdNextStep } = await import("../../src/audit/cli/nextStepCommand.ts");
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools/audit");
    const stepsDir = join(artifactsDir, "steps");
    await mkdir(stepsDir, { recursive: true });
    // Seed a stale prior step — the defect was that this survived a fatal exit
    // and read as a live instruction.
    await writeFile(
      join(stepsDir, "current-step.json"),
      JSON.stringify({ step_kind: "dispatch_review", status: "ready" }, null, 2),
    );

    const missingGuidance = join(root, "no-such-guidance.md");
    await assert.rejects(() =>
      cmdNextStep([
        "--root",
        root,
        "--artifacts-dir",
        artifactsDir,
        "--guidance-file",
        missingGuidance,
      ]),
    );

    const step = JSON.parse(
      await readFile(join(stepsDir, "current-step.json"), "utf8"),
    );
    expect(step.step_kind).toBe("blocked");
    expect(step.status).toBe("blocked");
    // The step JSON names the cause on its own (headless consumers never read
    // the prompt file).
    expect(step.progress.summary).toContain("no-such-guidance.md");

    const prompt = await readFile(join(stepsDir, "current-prompt.md"), "utf8");
    expect(prompt).toContain("# audit-code blocked");
    expect(prompt).toContain("no-such-guidance.md");
  });
});
