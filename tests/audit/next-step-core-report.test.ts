import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runWrapper } from "./helpers/run-wrapper.mjs";
import { HEAVY_AUDIT_TEST_TIMEOUT_MS } from "../helpers/heavy-timeout.mjs";
import { withTempRepo } from "./helpers/next-step-harness.js";

test.concurrent("next-step emits present_report for a complete audit", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
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

test.concurrent("next-step proposes an analyzer install, then proceeds after a skip decision is recorded", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
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

    // Item B: on an applicable repo the FIRST pause is now the batched
    // analyzer-consent offer (external analyzers precede graph enrichment).
    // Answer it (decline everything) and the pipeline proceeds to the
    // analyzer-install pause under test.
    const consent = JSON.parse(
      (await runWrapper(["next-step"], { cwd: root, env })).stdout,
    );
    expect(consent.step_kind).toBe("analyzer_consent");
    expect(consent.artifact_paths.analyzer_consent_decisions).toMatch(
      /analyzer-consent-decisions\.json$/,
    );
    const consentPrompt = await readFile(consent.prompt_path, "utf8");
    expect(consentPrompt).toMatch(/eslint/);
    expect(consentPrompt).toMatch(/"granted"/);
    await writeFile(
      consent.artifact_paths.analyzer_consent_decisions,
      JSON.stringify(
        { semgrep: "declined", eslint: "declined", knip: "declined", jscpd: "declined", "osv-scanner": "declined" },
        null,
        2,
      ) + "\n",
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

    // Both decisions persist durably to session config: the install skip AND
    // the consent declines (Item B — decisions durable, tokens never).
    const config = JSON.parse(
      await readFile(join(root, ".audit-tools/audit", "session-config.json"), "utf8"),
    );
    expect(config.analyzers.typescript).toBe("skip");
    expect(config.analyzer_consent.eslint).toBe("declined");
  });
});

// ---------------------------------------------------------------------------
// INV-READY-STEP-CONTINUATION (COR-f6a36670): any current-step written with
// status "ready" whose stop_condition instructs calling next-step again must
// carry the executable continuation command in allowed_commands — the host must
// never have to reconstruct the invocation from prose.
// ---------------------------------------------------------------------------

test("present_report with pending friction triage is a ready step carrying the next-step continuation command", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
  // In-process (no wrapper spawn) so the check stays build-free: the wrapper
  // path imports from dist/, which the accept gate does not build.
  const { cmdNextStep } = await import("../../src/audit/cli/nextStepCommand.js");
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
      step.allowed_commands.some((command: string) => /next-step/.test(command)),
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

test("a fatal next-step exit overwrites the stale step with a blocked step naming the cause", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
  const { cmdNextStep } = await import("../../src/audit/cli/nextStepCommand.js");
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
