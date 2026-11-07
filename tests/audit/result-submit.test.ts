/**
 * `audit-code submit --work-item <id> --from <file>` — the reader hands the
 * tool its result and the tool writes the bound path (decision 4, 2026-11-06,
 * docs/reviews/result-submit-design-2026-11-06.md).
 *
 * Only an id and a path pass the shell, so a quote that holds a backslash
 * reaches the bound path byte-exact. The tool judges the document by the rules
 * ingestion applies BEFORE it writes: a refused result never lands at the bound
 * path, and the reader gets the same refusal text it would get from ingestion.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "vitest";

const packageRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

import { cmdSubmit } from "../../src/audit/cli/submitCommand.js";
import { cmdValidateResults } from "../../src/audit/cli/validateResultsCommand.js";
import { runSnapshotPath } from "../../src/audit/io/runSnapshot.js";
import { countLines } from "../../src/audit/cli/args.js";
import { captureConsole } from "./helpers/captureConsole.mjs";
import { advancePastDesignReview, withTempRepo } from "./helpers/next-step-harness.js";

interface WorkItem {
  id: string;
  lens: string;
  result_path: string;
  prompt: { sha256: string };
  scope: { files: string[] };
}

// One backslash in the source: `\s` inside a regular expression literal.
const BACKSLASH_LINE = "  return token.replace(/\\s+/g, \"\").length > 0;";

// captureConsole restores process.exitCode and hands back the command's as `code`.
async function run<T>(fn: () => Promise<void>): Promise<{ exitCode: number; report: T; stdout: string }> {
  const { code, stdout } = await captureConsole(fn);
  return { exitCode: Number(code), report: JSON.parse(stdout) as T, stdout };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

test("submit writes a judged result to its bound path byte-exact, and refuses one ingestion would refuse", async () => {
  await withTempRepo(async (root) => {
    await writeFile(
      join(root, "src", "api", "auth.ts"),
      ["export function authenticate(token: string): boolean {", BACKSLASH_LINE, "}", ""].join("\n"),
    );
    const step = await advancePastDesignReview(root);
    expect(step.step_kind).toBe("dispatch_review");
    const artifactsDir = join(root, ".audit-tools", "audit");
    const { source_root: sourceRoot } = JSON.parse(await readFile(runSnapshotPath(artifactsDir), "utf8")) as {
      source_root: string;
    };
    const workload = JSON.parse(await readFile(step.artifact_paths.host_workload, "utf8")) as {
      run_id: string;
      work_items: WorkItem[];
    };
    const item = workload.work_items.find((entry) => entry.scope.files.includes("src/api/auth.ts"))!;
    expect(item).toBeDefined();
    const boundPath = resolve(root, item.result_path);
    const lines = await countLines(join(sourceRoot, "src/api/auth.ts"));
    const document = (lens: string) => ({
      contract_version: "audit-host-result/v1alpha1",
      result_id: `${item.id}-${item.prompt.sha256.slice(0, 12)}`,
      run_id: workload.run_id,
      work_item_id: item.id,
      prompt_sha256: item.prompt.sha256,
      file_coverage: [{ path: "src/api/auth.ts", reviewed_lines: lines, total_lines: lines }],
      findings: [
        {
          id: "F-1",
          title: "Whitespace-only token is stripped, then any remainder authenticates",
          category: "auth",
          severity: "medium",
          confidence: "medium",
          lens,
          summary: "Any token with one non-space character authenticates.",
          evidence: ["src/api/auth.ts - length check only"],
          affected_files: [{ path: "src/api/auth.ts", quoted_text: 'token.replace(/\\s+/g, "")' }],
        },
      ],
    });
    const scratch = await mkdtemp(join(tmpdir(), "audit-submit-"));
    try {
      // Refused: a finding whose lens is not the task's fails the per-result
      // rule ingestion enforces. Nothing reaches the bound path.
      const wrongLens = item.lens === "security" ? "correctness" : "security";
      const refusedFile = join(scratch, "refused.json");
      await writeFile(refusedFile, JSON.stringify(document(wrongLens)));
      const refused = await run<{ error_count: number; issues: Array<{ message: string }> }>(() =>
        cmdSubmit(["--root", root, "--work-item", item.id, "--from", refusedFile]),
      );
      expect(refused.exitCode, refused.stdout).toBe(1);
      expect(refused.report.issues.map((issue) => issue.message).join("\n")).toMatch(/assigned task lens/u);
      expect(await exists(boundPath)).toBe(false);

      // Accepted: the bound path holds the submitted bytes, backslash intact,
      // and the read-only check finds nothing to refuse.
      const bytes = JSON.stringify(document(item.lens), null, 2);
      expect(bytes).toContain("\\\\s+");
      const acceptedFile = join(scratch, "accepted.json");
      await writeFile(acceptedFile, bytes);
      const accepted = await run<{ error_count: number; work_item_id: string; result_path: string }>(() =>
        cmdSubmit(["--root", root, "--work-item", item.id, "--from", acceptedFile]),
      );
      expect(accepted.exitCode, accepted.stdout).toBe(0);
      expect(accepted.report.work_item_id).toBe(item.id);
      expect(accepted.report.result_path).toBe(item.result_path);
      expect(await readFile(boundPath, "utf8")).toBe(bytes);
      const check = await run<{ error_count: number }>(() =>
        cmdValidateResults(["--root", root, "--results", boundPath]),
      );
      expect(check.report.error_count, check.stdout).toBe(0);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

test("the built `audit-code mcp` process serves submit_result over clean stdio and writes the bound path", async () => {
  await withTempRepo(async (root) => {
    const step = await advancePastDesignReview(root);
    expect(step.step_kind).toBe("dispatch_review");
    const artifactsDir = join(root, ".audit-tools", "audit");
    const { source_root: sourceRoot } = JSON.parse(await readFile(runSnapshotPath(artifactsDir), "utf8")) as {
      source_root: string;
    };
    const workload = JSON.parse(await readFile(step.artifact_paths.host_workload, "utf8")) as {
      run_id: string;
      work_items: WorkItem[];
    };
    const item = workload.work_items[0]!;
    const coverage = await Promise.all(
      item.scope.files.map(async (path) => {
        const lines = await countLines(join(sourceRoot, path));
        return { path, reviewed_lines: lines, total_lines: lines };
      }),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(packageRoot, "dist", "audit", "cli.js"), "mcp"],
      env: process.env as Record<string, string>,
      stderr: "pipe",
    });
    const client = new Client({ name: "test-host", version: "0.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["submit_result"]);
      const call = await client.callTool({
        name: "submit_result",
        arguments: {
          root,
          work_item_id: item.id,
          result: {
            contract_version: "audit-host-result/v1alpha1",
            result_id: `${item.id}-${item.prompt.sha256.slice(0, 12)}`,
            run_id: workload.run_id,
            work_item_id: item.id,
            prompt_sha256: item.prompt.sha256,
            file_coverage: coverage,
            findings: [],
          },
        },
      });
      const text = (call.content as Array<{ text: string }>).map((part) => part.text).join("\n");
      expect(call.isError, text).not.toBe(true);
      expect(JSON.parse(text).written).toBe(true);
      expect(await exists(resolve(root, item.result_path))).toBe(true);
    } finally {
      await client.close();
    }
  });
});

test("submit refuses a work item the current run does not publish, and writes nothing", async () => {
  await withTempRepo(async (root) => {
    const step = await advancePastDesignReview(root);
    expect(step.step_kind).toBe("dispatch_review");
    const scratch = await mkdtemp(join(tmpdir(), "audit-submit-"));
    try {
      const file = join(scratch, "result.json");
      await writeFile(file, "{}");
      await expect(cmdSubmit(["--root", root, "--work-item", "no-such-item", "--from", file])).rejects.toThrow(
        /no-such-item.*not a work item/u,
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
