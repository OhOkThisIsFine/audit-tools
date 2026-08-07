import { test, expect, vi } from "vitest";

// Heavy spawn suite: real tarball packs + real subprocess round-trips, and the
// cases are `concurrent`, so under a full-suite run they contend with siblings.
// Single-sourced ceiling — see tests/helpers/heavy-timeout.mjs for the rationale.
import { HEAVY_AUDIT_TEST_TIMEOUT_MS } from "../helpers/heavy-timeout.mjs";
vi.setConfig({ testTimeout: HEAVY_AUDIT_TEST_TIMEOUT_MS });
import { mkdtemp, rm, stat, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUDITOR_ARGS,
  assertMatchesResponseSchema,
  runWrapper,
  startDispatchRun,
  withTempRepo,
} from "./helpers/wrapper-harness.js";
// Step contracts normalize host-facing paths to forward slashes (drift-plan
// R3); compare step path fields against the normalized form so the assertions
// hold on Windows as well as Linux CI.
const { toPromptPathToken } = await import("audit-tools/shared");

test.concurrent("audit-code wrapper advance-audit drains the deterministic regen frontier to the first host-input pause and prints the execution envelope", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools/audit");
    // advance-audit now SAFELY DRAINS the consecutive deterministic regen frontier
    // in one call (the fold-aware drain is the default): the provider gate
    // auto-completes headlessly, then intake → auto-fix → syntax → analyzer
    // acquisition → structure → graph enrichment → design assessment → structure
    // decomposition all run, halting at the intent_checkpoint host-input boundary.
    const { stdout: stdout0 } = await runWrapper(["advance-audit", ...AUDITOR_ARGS], { cwd: root });
    const step0 = JSON.parse(stdout0);

    const info = await stat(artifactsDir);
    expect(info.isDirectory()).toBe(true);
    assertMatchesResponseSchema(step0, "auditCodeResponse");
    expect(step0.contract_version).toBe("audit-code/v1alpha1");
    // The drain resolved the whole deterministic frontier and stopped at the first
    // host-input pause (the intent checkpoint), so the last executor it ran is the
    // final deterministic step (the change-3 docs digest) and the next step it
    // hands back is a host boundary.
    expect(step0.selected_executor).toBe("docs_digest_executor");
    expect(step0.progress_made).toBe(true);
    expect(step0.next_likely_step).toBe("intent_checkpoint_current");
    expect(step0.handoff.status).toBe("active");
    // Every deterministic artifact across the drained frontier is present + the
    // artifact directory is reused (stable) — not one-executor-per-invocation.
    expect(step0.artifacts_written.includes("repo_manifest.json")).toBe(true);
    expect(step0.artifacts_written.includes("graph_bundle.json")).toBe(true);
    expect(step0.artifacts_written.includes("structure_decomposition.json")).toBe(true);

    // A second advance from the same artifact directory continues past the intent
    // checkpoint (auto-completed headlessly) and drains onward, still making
    // progress against the same stable artifact dir.
    const { stdout: stdout1 } = await runWrapper(["advance-audit", ...AUDITOR_ARGS], { cwd: root });
    const step1 = JSON.parse(stdout1);

    assertMatchesResponseSchema(step1, "auditCodeResponse");
    expect(step1.progress_made).toBe(true);
    expect(step1.handoff.status).toBe("active");
    expect(step1.handoff.suggested_commands.length).toBe(0);
  });
});

test.concurrent("audit-code wrapper can explain a resolved task id", async () => {
  await withTempRepo(async (root) => {
    await startDispatchRun(root);
    const tasks = JSON.parse(
      await readFile(join(root, ".audit-tools/audit", "audit_tasks.json"), "utf8"),
    );
    const taskId = tasks[0].task_id;

    const explained = JSON.parse(
      (await runWrapper(["explain-task", taskId], { cwd: root })).stdout,
    );

    expect(explained.task_id).toBe(taskId);
    expect(Array.isArray(explained.coverage_entries)).toBeTruthy();
    expect(explained.coverage_entries.length > 0).toBeTruthy();
  });
});

test.concurrent("next-step reaches a ready review dispatch step from repo root under worker-command", async () => {
  await withTempRepo(async (root) => {
    const step = await startDispatchRun(root);

    expect(step.contract_version).toBe("audit-code-step/v1alpha1");
    expect(step.status).toBe("ready");
    expect(step.step_kind).toBe("dispatch_review");
    expect(step.run_id).toBeTruthy();
    expect(step.repo_root).toBe(toPromptPathToken(root));
    expect(step.artifacts_dir).toBe(toPromptPathToken(join(root, ".audit-tools/audit")));

    // The printed contract matches the persisted current-step.json, so the host
    // can act on steps/current-step.json without a second next-step round-trip.
    const currentStep = JSON.parse(
      await readFile(
        join(root, ".audit-tools/audit", "steps", "current-step.json"),
        "utf8",
      ),
    );
    expect(currentStep.step_kind).toBe(step.step_kind);
    expect(currentStep.run_id).toBe(step.run_id);

    // The dispatch run covers every planned audit task.
    const allAuditTasks = JSON.parse(
      await readFile(join(root, ".audit-tools/audit", "audit_tasks.json"), "utf8"),
    );
    expect(allAuditTasks.length > 0).toBeTruthy();
    const pendingRunTasks = JSON.parse(
      await readFile(
        join(root, ".audit-tools/audit", "runs", step.run_id, "pending-audit-tasks.json"),
        "utf8",
      ),
    );
    expect(pendingRunTasks.length).toBe(allAuditTasks.length);

    // The step prompt is the host's sole instruction surface.
    const prompt = await readFile(step.prompt_path, "utf8");
    expect(prompt).toMatch(/merge-and-ingest|exactly one AuditResult/i);
  });
});

// Machine-global state-dir hermeticity (docs/backlog.md "Machine-global
// ~/.audit-code state leaks into EVERY e2e test", 2026-07-17): a spawned CLI
// must resolve sources-declared.json from AUDIT_CODE_STATE_DIR, never the
// box's live ~/.audit-code. The fake declaration's source fails its PATH reach
// probe, so the CLI proves WHICH declaration it read via the dropped-source
// stderr report — red without the env override (the fake source never
// surfaces), green with it.
test("AUDIT_CODE_STATE_DIR redirects the machine-global state dir for a spawned CLI", async () => {
  await withTempRepo(async (root) => {
    const stateDir = await mkdtemp(join(tmpdir(), "audit-code-fake-state-"));
    try {
      await writeFile(
        join(stateDir, "sources-declared.json"),
        JSON.stringify(
          {
            sources: [
              {
                id: "hermetic-fake-source",
                transport: "codex",
                endpoint: "audit-tools-hermeticity-missing-cmd",
              },
            ],
          },
          null,
          2,
        ) + "\n",
      );
      const { stderr } = await runWrapper(["next-step", ...AUDITOR_ARGS], {
        cwd: root,
        env: { AUDIT_CODE_STATE_DIR: stateDir },
      });
      expect(
        stderr,
        "the CLI must read the FAKE state dir's declaration (dropped-source report)",
      ).toContain('declared source "hermetic-fake-source" not resolved');
      expect(stderr).toContain(
        'launcher "audit-tools-hermeticity-missing-cmd" is not on PATH',
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
