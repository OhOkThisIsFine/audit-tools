import { test, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnHidden as spawn } from "../helpers/spawn.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const wrapperPath = join(repoRoot, "audit-code.mjs");

function runWrapper(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapperPath, ...args], {
      cwd: options.cwd ?? repoRoot,
      env: process.env,
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
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-lifecycle-"));
  const root = join(tempDir, "repo");
  try {
    await mkdir(join(root, "src", "api"), { recursive: true });
    await mkdir(join(root, "src", "lib"), { recursive: true });
    await mkdir(join(root, "infra"), { recursive: true });

    await writeFile(
      join(root, "src", "api", "auth.ts"),
      [
        "export function authenticate(token: string): boolean {",
        "  return token.trim().length > 0;",
        "}",
        "",
      ].join("\n"),
    );

    await writeFile(
      join(root, "src", "lib", "session.ts"),
      [
        "export interface Session {",
        "  id: string;",
        "}",
        "",
        "export function createSession(id: string): Session {",
        "  return { id };",
        "}",
        "",
      ].join("\n"),
    );

    await writeFile(
      join(root, "infra", "deploy.yml"),
      [
        "name: deploy",
        "on: [push]",
        "jobs:",
        "  release:",
        "    runs-on: ubuntu-latest",
        "",
      ].join("\n"),
    );

    return await fn(root);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test.concurrent("audit-code wrapper supports repeated draining advance-audit invocations with a stable artifact directory", async () => {
  await withTempRepo(async (root) => {
    // advance-audit now SAFELY DRAINS the consecutive deterministic regen frontier
    // each call (the fold-aware drain is the default), halting at host-input
    // pauses. The interactive/host-delegation steps between the checkpoint and
    // planning (provider gate, intent checkpoint, charter extraction, both
    // design-review passes, charter clarification, systemic challenge) auto-complete
    // or omit headlessly under advance-audit, each bounding one drained segment; the
    // deterministic runs between them collapse into a single call. So the whole
    // deterministic pipeline resolves in a handful of drained round-trips against
    // ONE stable artifact directory — never one-executor-per-invocation.
    //
    // Chain-length-agnostic: loop until the deterministic planning tail runs rather
    // than pinning each intermediate step (adding a PRIORITY phase must not churn
    // this test). Every drained invocation makes progress; the first collapses the
    // intake→structure_decomposition run in one call.
    let first = null;
    let planning = null;
    for (let i = 0; i < 24; i += 1) {
      const step = JSON.parse(
        (await runWrapper(["advance-audit"], { cwd: root })).stdout,
      );
      first ??= step;
      expect(step.progress_made).toBe(true);
      if (step.selected_executor === "planning_executor") {
        planning = step;
        break;
      }
    }

    // The very first drained call resolved the whole deterministic pre-checkpoint
    // frontier in ONE invocation (intake → … → structure decomposition) and handed
    // back at the first host-input pause, the intent checkpoint.
    expect(first.selected_executor).toBe("structure_decomposition_executor");
    expect(first.next_likely_step).toBe("intent_checkpoint_current");
    expect(first.artifacts_written.includes("repo_manifest.json")).toBe(true);
    expect(first.artifacts_written.includes("external_analyzer_acquisition.json")).toBe(true);
    expect(first.artifacts_written.includes("graph_bundle.json")).toBe(true);
    expect(first.artifacts_written.includes("structure_decomposition.json")).toBe(true);

    // The drained pipeline reached the deterministic planning tail against the same
    // stable artifact directory.
    expect(planning, "planning_executor should be reached via drained advances").toBeTruthy();
    expect(Array.isArray(planning.artifacts_written)).toBeTruthy();
    expect(planning.artifacts_written.includes("audit_tasks.json")).toBeTruthy();
    expect(planning.artifacts_written.includes("requeue_tasks.json")).toBeTruthy();
  });
});

test.concurrent("audit-code wrapper accepts external analyzer evidence on the advance-audit surface", async () => {
  await withTempRepo(async (root) => {
    const analyzerPath = join(root, "external_analyzer_results.json");
    await writeFile(
      analyzerPath,
      JSON.stringify(
        {
          tool: "semgrep",
          generated_at: "2026-03-23T00:00:00Z",
          results: [
            {
              id: "sg-1",
              category: "security",
              severity: "warning",
              path: "src/api/auth.ts",
              line_start: 1,
              line_end: 3,
              summary: "Potentially missing auth logging.",
            },
          ],
        },
        null,
        2,
      ),
    );

    const imported = JSON.parse(
      (
        await runWrapper(
          ["advance-audit", "--external-analyzer-results", analyzerPath],
          { cwd: root },
        )
      ).stdout,
    );
    expect(imported.selected_executor).toBe("external_analyzer_import_executor");
    expect(imported.progress_made).toBe(true);
    expect(imported.artifacts_written.includes("external_analyzer_results.json")).toBeTruthy();
  });
});
