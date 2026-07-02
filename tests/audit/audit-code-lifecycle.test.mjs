import { test, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

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

test("audit-code wrapper supports repeated bounded advance-audit invocations with a stable artifact directory", async () => {
  await withTempRepo(async (root) => {
    // Provider confirmation auto-completes headlessly under advance-audit.
    const first = JSON.parse(
      (await runWrapper(["advance-audit"], { cwd: root })).stdout,
    );
    expect(first.selected_executor).toBe("provider_confirmation_executor");
    expect(first.next_likely_step).toBe("repo_manifest");

    const second = JSON.parse(
      (await runWrapper(["advance-audit"], { cwd: root })).stdout,
    );
    expect(second.selected_executor).toBe("intake_executor");
    expect(second.next_likely_step).toBe("auto_fixes_applied");

    const third = JSON.parse(
      (await runWrapper(["advance-audit"], { cwd: root })).stdout,
    );
    expect(third.selected_executor).toBe("auto_fix_executor");
    expect(third.next_likely_step).toBe("syntax_resolved");

    const fourth = JSON.parse(
      (await runWrapper(["advance-audit"], { cwd: root })).stdout,
    );
    expect(fourth.selected_executor).toBe("syntax_resolution_executor");
    expect(fourth.next_likely_step).toBe("external_analyzers_current");

    // External-analyzer acquisition (Slice D) runs between syntax resolution and
    // structure. Under advance-audit it is NOT enabled (only the CLI next-step
    // path sets externalAcquisition.enabled), so it writes an empty hermetic
    // marker and proceeds — nothing is spawned/downloaded.
    const acquisition = JSON.parse(
      (await runWrapper(["advance-audit"], { cwd: root })).stdout,
    );
    expect(acquisition.selected_executor).toBe("external_analyzer_acquisition_executor");
    expect(acquisition.next_likely_step).toBe("structure_artifacts");
    expect(acquisition.artifacts_written.includes(
        "external_analyzer_acquisition.json",
      )).toBeTruthy();

    const fifth = JSON.parse(
      (await runWrapper(["advance-audit"], { cwd: root })).stdout,
    );
    expect(fifth.selected_executor).toBe("structure_executor");
    expect(fifth.next_likely_step).toBe("graph_enrichment_current");

    // Graph enrichment runs between structure and design assessment. Under
    // advance-audit it never prompts: optional analyzers resolve or fall
    // back to the regex floor, then the chain proceeds.
    const enrichment = JSON.parse(
      (await runWrapper(["advance-audit"], { cwd: root })).stdout,
    );
    expect(enrichment.selected_executor).toBe("graph_enrichment_executor");
    expect(enrichment.next_likely_step).toBe("design_assessment_current");

    const sixth = JSON.parse(
      (await runWrapper(["advance-audit"], { cwd: root })).stdout,
    );
    expect(sixth.selected_executor).toBe("design_assessment_executor");
    expect(sixth.next_likely_step).toBe("intent_checkpoint_current");

    // Intent checkpoint auto-completes headlessly under advance-audit.
    const seventh = JSON.parse(
      (await runWrapper(["advance-audit"], { cwd: root })).stdout,
    );
    expect(seventh.selected_executor).toBe("intent_checkpoint_executor");
    expect(seventh.next_likely_step).toBe("design_review_contract_completed");

    const eighth = JSON.parse(
      (await runWrapper(["advance-audit"], { cwd: root })).stdout,
    );
    expect(eighth.selected_executor).toBe("design_review_contract");
    expect(eighth.next_likely_step).toBe("design_review_conceptual_completed");

    const eighthB = JSON.parse(
      (await runWrapper(["advance-audit"], { cwd: root })).stdout,
    );
    expect(eighthB.selected_executor).toBe("design_review_conceptual");
    expect(eighthB.next_likely_step).toBe("planning_artifacts");

    const ninth = JSON.parse(
      (await runWrapper(["advance-audit"], { cwd: root })).stdout,
    );
    expect(ninth.selected_executor).toBe("planning_executor");
    expect(Array.isArray(ninth.artifacts_written)).toBeTruthy();
    expect(ninth.artifacts_written.includes("audit_tasks.json")).toBeTruthy();
    expect(ninth.artifacts_written.includes("requeue_tasks.json")).toBeTruthy();
  });
});

test("audit-code wrapper accepts external analyzer evidence on the advance-audit surface", async () => {
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
