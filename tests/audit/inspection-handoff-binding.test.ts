/**
 * The inspection (semantic review) host workload, as a host meets it.
 *
 * Found by the 0.55.15 self-audit (984 work items):
 *   1. `validate-results` refused every audit-host-result/v1alpha1 file the
 *      workload asks for, so a host had no way to check a result before
 *      ingestion. It must judge a host result by the SAME rules ingestion does.
 *   2. The worker prompt named its result path repository-relative with no
 *      anchor, and the step's read grant left out the snapshot the prompt sends
 *      the worker to — every binding must be cwd-independent and granted.
 *   3. The workload carried no coherence metadata, so a host scheduling 984
 *      items had nothing to group them by.
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "vitest";

import { cmdValidateResults } from "../../src/audit/cli/validateResultsCommand.js";
import {
  ingestAuditHostResults,
  prepareAuditHostHandoff,
} from "../../src/audit/cli/dispatch/hostHandoff.js";
import { buildLineIndex } from "../../src/audit/cli/lineIndex.js";
import { loadArtifactBundle } from "../../src/audit/io/artifacts.js";
import { deriveLaneDemand } from "../../src/shared/types/stepContract.js";
import type { AuditTask } from "../../src/audit/types.js";
import { runSnapshotPath } from "../../src/audit/io/runSnapshot.js";
import { countLines } from "../../src/audit/cli/args.js";
import { captureConsole } from "./helpers/captureConsole.mjs";
import { advancePastDesignReview, withTempRepo } from "./helpers/next-step-harness.js";

interface WorkItem {
  id: string;
  lens: string;
  result_path: string;
  metadata: Record<string, unknown>;
  prompt: { sha256: string; text: string };
  scope: { files: string[] };
}

function posix(path: string): string {
  return path.replace(/\\/g, "/");
}

async function publishedRun(root: string) {
  const step = await advancePastDesignReview(root);
  expect(step.step_kind).toBe("dispatch_review");
  const artifactsDir = join(root, ".audit-tools", "audit");
  const { source_root: sourceRoot } = JSON.parse(
    await readFile(runSnapshotPath(artifactsDir), "utf8"),
  ) as { source_root: string };
  const workload = JSON.parse(await readFile(step.artifact_paths.host_workload, "utf8")) as {
    run_id: string;
    work_items: WorkItem[];
  };
  return { step, artifactsDir, sourceRoot, workload };
}

async function writeHostResult(
  root: string,
  sourceRoot: string,
  runId: string,
  item: WorkItem,
  findings: unknown[],
): Promise<string> {
  const fileCoverage = await Promise.all(
    item.scope.files.map(async (path) => {
      const lines = await countLines(join(sourceRoot, path));
      return { path, reviewed_lines: lines, total_lines: lines };
    }),
  );
  const resultPath = resolve(root, item.result_path);
  await writeFile(
    resultPath,
    JSON.stringify({
      contract_version: "audit-host-result/v1alpha1",
      result_id: `${item.id}-${item.prompt.sha256.slice(0, 12)}`,
      run_id: runId,
      work_item_id: item.id,
      prompt_sha256: item.prompt.sha256,
      file_coverage: fileCoverage,
      findings,
    }),
  );
  return resultPath;
}

test("validate-results judges a host result by the rules ingestion applies, and accepts nothing", async () => {
  await withTempRepo(async (root) => {
    const { artifactsDir, sourceRoot, workload } = await publishedRun(root);
    const item = workload.work_items.find((entry) => entry.scope.files.includes("src/api/auth.ts"));
    expect(item).toBeDefined();

    const clean = await writeHostResult(root, sourceRoot, workload.run_id, item!, []);
    const before = process.exitCode;
    const valid = await captureConsole(() => cmdValidateResults(["--root", root, "--results", clean]));
    const validReport = JSON.parse(valid.stdout) as { error_count: number; work_item_id?: string };
    expect(validReport.error_count, valid.stdout).toBe(0);
    expect(validReport.work_item_id).toBe(item!.id);

    // A finding whose lens is not the task's passes the envelope but fails the
    // per-result rule ingestion enforces — validate-results must say so.
    const wrongLens = item!.lens === "security" ? "correctness" : "security";
    await writeHostResult(root, sourceRoot, workload.run_id, item!, [
      {
        id: "F-1",
        title: "Token accepted when non-empty",
        category: "auth",
        severity: "medium",
        confidence: "medium",
        lens: wrongLens,
        summary: "Any non-empty token authenticates.",
        evidence: ["src/api/auth.ts - length check only"],
        affected_files: [{ path: "src/api/auth.ts", no_quotable_span: "the defect is a missing check" }],
      },
    ]);
    const invalid = await captureConsole(() => cmdValidateResults(["--root", root, "--results", clean]));
    const invalidReport = JSON.parse(invalid.stdout) as { error_count: number; issues: Array<{ message: string }> };
    expect(invalidReport.error_count, invalid.stdout).toBeGreaterThan(0);
    expect(invalidReport.issues.map((issue) => issue.message).join("\n")).toMatch(/assigned task lens/u);
    process.exitCode = before;

    // Read-only: nothing reached the accepted pair.
    const ledgerPath = join(artifactsDir, "runs", workload.run_id, "host-accepted-results-ledger.json");
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as { entries: unknown[] };
    expect(ledger.entries).toEqual([]);
  });
});

test("every path a work item names is absolute, granted, and the only file it may write", async () => {
  await withTempRepo(async (root) => {
    const { step, sourceRoot, workload } = await publishedRun(root);
    expect(workload.work_items.length).toBeGreaterThan(0);
    for (const item of workload.work_items) {
      const absolute = posix(resolve(root, item.result_path));
      // Line 2 names the submit tool with the root and work-item id it needs,
      // then the absolute path once as the fallback; the closing template
      // points back to it (cut C1; owner decision on line 2, 2026-11-07).
      expect(item.prompt.text.split("\n")[1]).toBe(
        `Submit one JSON object with the submit_result tool (root: ${posix(resolve(root))}, work_item_id: ${item.id}). ` +
          `If you do not have that tool, write the object with a file-write tool to this exact absolute path: ${absolute}. ` +
          "Do not write it through a shell.",
      );
      expect(item.prompt.text.split(absolute).length - 1).toBe(1);
      expect(item.prompt.text).toContain("submit this JSON as line 2 says");
      expect(item.prompt.text).toMatch(/Write no other file/u);
    }
    // The step grants what the prompts send a worker to read.
    expect((step.access?.read_paths ?? []).map(posix)).toContain(posix(sourceRoot));
    const prompt = await readFile(step.prompt_path, "utf8");
    expect(prompt).toContain(posix(sourceRoot));
  });
});

test("the published wave's content-coherence groups sit beside the workload, and the step states the scheduling facts", async () => {
  await withTempRepo(async (root) => {
    const { step, workload } = await publishedRun(root);
    const groupsPath = step.artifact_paths.host_coherence_groups;
    expect(groupsPath, JSON.stringify(step.artifact_paths)).toEqual(expect.any(String));
    const document = JSON.parse(await readFile(groupsPath!, "utf8")) as {
      contract_version: string;
      run_id: string;
      groups: Array<{ id: string; work_item_ids: string[]; token_estimate: number }>;
    };
    expect(document.contract_version).toBe("audit-host-coherence-groups/v1alpha1");
    expect(document.run_id).toBe(workload.run_id);
    // A partition of exactly the published items, each group named by its lowest id.
    const members = document.groups.flatMap((group) => group.work_item_ids).sort();
    expect(members).toEqual(workload.work_items.map((item) => item.id).sort());
    for (const group of document.groups) expect(group.id).toBe([...group.work_item_ids].sort()[0]);
    // Items over the same file set land in one group.
    const groupOf = new Map(document.groups.flatMap((group) => group.work_item_ids.map((id) => [id, group.id] as const)));
    const byFiles = new Map<string, Set<string | undefined>>();
    for (const item of workload.work_items) {
      const key = [...item.scope.files].sort().join("|");
      byFiles.set(key, (byFiles.get(key) ?? new Set()).add(groupOf.get(item.id)));
    }
    for (const groups of byFiles.values()) expect(groups.size).toBe(1);
    expect((step.access?.read_paths ?? []).map(posix)).toContain(posix(groupsPath!));
    const prompt = await readFile(step.prompt_path, "utf8");
    expect(prompt).toContain(`content-coherence group(s) listed at ${posix(groupsPath!)}`);
    expect(prompt).toMatch(/order, grouping and parallelism are yours/u);
  });
});

async function validate(root: string, path: string) {
  const before = process.exitCode;
  try {
    const { stdout } = await captureConsole(() => cmdValidateResults(["--root", root, "--results", path]));
    return JSON.parse(stdout) as {
      error_count: number;
      issues: Array<{ code: string; message: string }>;
      hint?: string;
    };
  } finally {
    process.exitCode = before;
  }
}

test("validate-results and ingestion agree, refuse unbound paths with a remedy, and classify a stale workload", async () => {
  await withTempRepo(async (root) => {
    const { artifactsDir, sourceRoot, workload } = await publishedRun(root);
    const item = workload.work_items.find((entry) => entry.scope.files.includes("src/api/auth.ts"))!;
    const bundle = await loadArtifactBundle(artifactsDir);
    const lineIndex = await buildLineIndex(sourceRoot, bundle.repo_manifest!);
    const ingest = () =>
      ingestAuditHostResults({
        root,
        sourceRoot,
        artifactsDir,
        runId: workload.run_id,
        auditTasks: bundle.audit_tasks ?? [],
        lineIndex,
        pendingTaskIds: new Set(),
      });

    // REJECTED by both, with the same issue class.
    const wrongLens = item.lens === "security" ? "correctness" : "security";
    const path = await writeHostResult(root, sourceRoot, workload.run_id, item, [
      {
        id: "F-1", title: "Token accepted when non-empty", category: "auth", severity: "medium", confidence: "medium",
        lens: wrongLens, summary: "Any non-empty token authenticates.", evidence: ["src/api/auth.ts - length check only"],
        affected_files: [{ path: "src/api/auth.ts", no_quotable_span: "the defect is a missing check" }],
      },
    ]);
    const checked = await validate(root, path);
    const refused = await ingest();
    expect(refused.accepted_count).toBe(0);
    const ingestCodes = refused.raw_issues.filter((issue) => issue.work_item_id === item.id).map((issue) => issue.code);
    expect(checked.issues.map((issue) => issue.code)).toEqual(ingestCodes);
    expect(ingestCodes).toEqual(["result_validation_failed"]);

    // ACCEPTED by both.
    await writeHostResult(root, sourceRoot, workload.run_id, item, []);
    expect((await validate(root, path)).error_count).toBe(0);
    expect((await ingest()).completed_work_item_ids).toContain(item.id);

    // UNBOUND: a file in the run's host-results directory that no item binds,
    // and a host result written outside it — each refused with what to do.
    const runResults = join(artifactsDir, "runs", workload.run_id, "host-results");
    const stray = join(runResults, "not-bound.json");
    await writeFile(stray, await readFile(path, "utf8"));
    await expect(validate(root, stray)).rejects.toThrow(/not the bound result path of any work item.*names its own result_path/u);
    const outside = join(root, "result.json");
    await writeFile(outside, await readFile(path, "utf8"));
    await expect(validate(root, outside)).rejects.toThrow(/not a bound host result path.*write it there/u);

    // A lone non-host object is judged by the ingest-results door, with a hint.
    const lone = join(root, "one-audit-result.json");
    await writeFile(lone, JSON.stringify({ task_id: item.id }));
    const loneReport = await validate(root, lone);
    expect(loneReport.error_count).toBeGreaterThan(0);
    expect(loneReport.hint).toMatch(/wrap a single AuditResult in \[ \]/u);

    // STALE workload: the same classified refusal ingestion reports, not a throw.
    const workloadPath = join(artifactsDir, "runs", workload.run_id, "host-workload.json");
    const staleDoc = JSON.parse(await readFile(workloadPath, "utf8")) as Record<string, unknown>;
    staleDoc.contract_version = "audit-host-workload/v1alpha1";
    await writeFile(workloadPath, JSON.stringify(staleDoc));
    const staleCheck = await validate(root, path);
    const staleIngest = await ingest();
    expect(staleCheck.issues.map((issue) => issue.code)).toEqual(["workload_stale"]);
    expect(staleIngest.issues.map((issue) => issue.code)).toContain("workload_stale");
  });
});

test("a run resumed under a differently spelled root re-binds or refuses as classified stale, never as a throw", async () => {
  const base = await mkdtemp(join(tmpdir(), "audit-root-spelling-"));
  try {
    const prepareAt = async (root: string) => {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "a.ts"), "one\ntwo\n", "utf8");
      return prepareAuditHostHandoff({
        root, sourceRoot: root, artifactsDir: join(root, ".audit-tools", "audit"), runId: "spelling-run",
        tasks: [{ ...SPELLING_TASK, demand: deriveLaneDemand({ tokenEstimate: 10, fileCount: 1, riskScore: 0 }), token_estimate: 10,
          file_line_counts: { "src/a.ts": 2 }, priority: "low" }],
      });
    };
    const writeResult = async (root: string, item: { id: string; result_path: string; prompt: { sha256: string } }) => {
      const path = resolve(root, item.result_path);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, JSON.stringify({
        contract_version: "audit-host-result/v1alpha1", result_id: `${item.id}-${item.prompt.sha256.slice(0, 12)}`,
        run_id: "spelling-run", work_item_id: item.id, prompt_sha256: item.prompt.sha256,
        file_coverage: [{ path: "src/a.ts", reviewed_lines: 2, total_lines: 2 }], findings: [],
      }));
    };
    const ingestAt = (root: string) => ingestAuditHostResults({
      root, sourceRoot: root, artifactsDir: join(root, ".audit-tools", "audit"), runId: "spelling-run",
      auditTasks: [SPELLING_TASK], lineIndex: { "src/a.ts": 2 }, pendingTaskIds: new Set(),
    });

    const first = join(base, "first");
    const prepared = await prepareAt(first);
    const item = prepared.workload.work_items[0]!;
    await writeResult(first, item);

    // A drive letter spelled in the other case names the same directory: the
    // prompt re-renders identically and the result is accepted.
    if (/^[A-Za-z]:/u.test(first)) {
      const flipped = first[0] === first[0]!.toUpperCase()
        ? first[0]!.toLowerCase() + first.slice(1)
        : first[0]!.toUpperCase() + first.slice(1);
      expect((await ingestAt(flipped)).accepted_count).toBe(1);
    }

    // A root that really MOVED refuses as the classified, re-preparable stale.
    const moved = join(base, "moved");
    await cp(first, moved, { recursive: true });
    await rm(join(moved, ".audit-tools", "audit", "runs", "spelling-run", "host-accepted-results-ledger.json"), { force: true });
    await rm(join(moved, ".audit-tools", "audit", "runs", "spelling-run", "host-accepted-results.json"), { force: true });
    const stale = await ingestAt(moved);
    expect(stale.accepted_count).toBe(0);
    expect(stale.issues.map((issue) => issue.code)).toContain("workload_stale");
    // ...and re-preparing under the new root restores the binding.
    const republished = await prepareAt(moved);
    await writeResult(moved, republished.workload.work_items[0]!);
    expect((await ingestAt(moved)).accepted_count).toBe(1);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

const SPELLING_TASK: AuditTask = {
  task_id: "spelling-task",
  unit_id: "unit-spelling",
  pass_id: "pass:correctness",
  lens: "correctness",
  file_paths: ["src/a.ts"],
  rationale: "Review src/a.ts",
};
