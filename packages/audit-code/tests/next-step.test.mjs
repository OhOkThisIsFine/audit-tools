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
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const wrapperPath = join(repoRoot, "audit-code.mjs");

function runWrapper(args, options = {}) {
  const { CLAUDECODE: _cc, ...cleanEnv } = process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapperPath, ...args], {
      cwd: options.cwd ?? repoRoot,
      env: { ...cleanEnv, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr || stdout || `wrapper exited with ${code}`));
    });
  });
}

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
async function advancePastDesignReview(root, wrapperArgs = ["next-step"], wrapperOpts = {}) {
  const incomingDir = join(root, ".audit-artifacts", "incoming");
  for (let i = 0; i < 6; i++) {
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
    return step;
  }
  throw new Error("next-step did not advance past structure-phase pauses");
}

test("next-step proposes an analyzer install, then proceeds after a skip decision is recorded", async () => {
  await withTempRepo(async (root) => {
    // The fixture has a .ts file but no local `typescript`, so graph enrichment
    // pauses to propose an install.
    const proposed = JSON.parse(
      (await runWrapper(["next-step"], { cwd: root })).stdout,
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
      (await runWrapper(["next-step"], { cwd: root })).stdout,
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
