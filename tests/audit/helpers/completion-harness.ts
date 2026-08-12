// Shared harness for the audit-code-completion-*.test.ts suite (split from the
// former single audit-code-completion.test.ts so no one file dominates a CI
// shard — the wall-clock brief's T4). Faithful move: the in-process handler
// callers, the temp-repo fixture, the pre-dispatch pause walker and the
// finalize loop the split files share.
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { countLines } from "./countLines.mjs";
import { walkStepsUntilTerminal } from "./step-driver.js";
import type { AuditTask } from "../../../src/audit/types.js";

const { GATE_LANES, laneSubmissionPath } = await import(
  "../../../src/audit/cli/laneSubmissions.js"
);
const { currentStepPath } = await import("audit-tools/shared");

const { cmdNextStep } = await import("../../../src/audit/cli/nextStepCommand.js");
const { cmdIngestResults } = await import("../../../src/audit/cli/ingestResultsCommand.js");

export async function buildSyntheticResults(tasks: AuditTask[], root: string) {
  return Promise.all(tasks.map(async (task) => ({
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    agent_role: "smoke-reviewer",
    file_coverage: await Promise.all(
      task.file_paths.map(async (path) => ({
        path,
        total_lines: await countLines(root, path),
      })),
    ),
    findings: [],
    reviewed_clean: true,
    notes: ["Synthetic completion result for wrapper integration coverage."],
    requires_followup: false,
  })));
}

// Capture console.log output (and silence the non-git-repo warning + the
// per-derivation staleness JSONL record every handler call emits against a
// fixture temp dir) around an in-process handler call. cmdIngestResults/
// cmdIngestResults prints its JSON result via console.log — NOT
// process.stdout.write. Vitest's own per-test console
// interception sits between console.log and process.stdout.write, so
// overriding process.stdout.write here would silently capture nothing).
// Overriding console.log itself intercepts at the exact call site the
// handlers use. The staleness record (emitStalenessRecord in
// src/audit/orchestrator/staleness.ts) writes straight to process.stderr —
// spawned subprocesses previously swallowed this in an unread child.stderr
// buffer; in-process it would otherwise flood every test run with dozens of
// duplicate lines, so it's silenced the same way.
async function captureConsoleLog(fn: () => Promise<unknown>): Promise<string> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let buffer = "";
  console.log = (...args) => {
    buffer += args.map(String).join(" ") + "\n";
  };
  console.warn = () => {};
  process.stderr.write = () => true;
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    process.stderr.write = originalStderrWrite;
  }
  return buffer;
}

// Call `cmdNextStep` in-process with the same argv the wrapper would have
// passed, then read the step contract back from steps/current-step.json —
// cmdNextStep's console.log and its writeCurrentStep() persist the identical
// object, so reading from disk is a robust, log-noise-free substitute for
// parsing a spawned child's stdout.
export async function callNextStep(
  root: string,
  artifactsDir: string,
  extraArgs: string[] = [],
) {
  await captureConsoleLog(() =>
    cmdNextStep(["--root", root, "--artifacts-dir", artifactsDir, ...extraArgs]),
  );
  return JSON.parse(await readFile(currentStepPath(artifactsDir), "utf8"));
}

export async function callIngestResults(args: string[]) {
  const stdout = await captureConsoleLog(() => cmdIngestResults(args));
  return JSON.parse(stdout);
}

export async function withTempRepo<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-completion-"));
  const root = join(tempDir, "repo");
  try {
    await mkdir(join(root, "src", "api"), { recursive: true });
    await mkdir(join(root, "src", "lib"), { recursive: true });
    await mkdir(join(root, "infra"), { recursive: true });
    // cmdNextStep creates this itself on its first in-process call, but
    // ingest-results/force-synthesis do not — ensure it exists unconditionally
    // so every handler is safe to call first (the wrapper used to guarantee
    // this via its own default-flag + mkdir before dispatching).
    await mkdir(join(root, ".audit-tools", "audit"), { recursive: true });

    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "test-repo", version: "0.0.0" }, null, 2) + "\n",
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

// Drive `next-step` past the host pause steps that precede review dispatch by
// answering each pause with scripted host inputs (skip analyzer installs, confirm the default
// scope, submit empty design-review findings). Returns the first
// dispatch-ready step (dispatch_review).
//
// The walk itself is `walkStepsUntilTerminal`; this harness supplies only the
// IN-PROCESS transport, which is the single thing that made it differ from
// wrapper-harness's spawned equivalent.
export async function advanceToDispatchReady(root: string) {
  const artifactsDir = join(root, ".audit-tools/audit");
  return walkStepsUntilTerminal({
    transport: () => callNextStep(root, artifactsDir),
    terminalKinds: new Set(["dispatch_review"]),
    label: "advanceToDispatchReady",
  });
}

// Seed the host's valid empty optional narrative result so completion remains
// deterministic without transport-owned configuration.
export async function seedEmptyNarrative(artifactsDir: string) {
  const path = laneSubmissionPath(artifactsDir, GATE_LANES.synthesis_narrative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({ themes: [], top_risks: [] }, null, 2) + "\n",
  );
}

// Bound the number of next-step calls needed to finalize after ingestion.
const MAX_FINALIZE_STEPS = 10;

export async function nextStepUntilPresentReport(root: string, extraArgs: string[] = []) {
  const artifactsDir = join(root, ".audit-tools/audit");
  for (let i = 0; i < MAX_FINALIZE_STEPS; i++) {
    const step = await callNextStep(root, artifactsDir, extraArgs);
    if (step.step_kind === "present_report") {
      // Friction triage pending: the tool materialized the record and set status
      // "ready" so the host can add open_observations. Simulate the host adding
      // one observation, then loop so the next call emits status:"complete".
      if (step.status === "ready" && step.artifact_paths?.friction_record) {
        let record: {
          category_attestations?: Array<{ category: string; note?: string }>;
        } = {};
        try {
          record = JSON.parse(await readFile(step.artifact_paths.friction_record, "utf8"));
        } catch { /* new record, start empty */ }
        record.category_attestations = [
          { category: "ambiguous_direction", note: "none this run" },
          { category: "tool_should_decide", note: "none this run" },
          { category: "inefficient_feeding", note: "none this run" },
        ];
        // promoteFinalAuditReport deletes artifactsDir; recreate the friction
        // subdir so the write and the subsequent next-step call both succeed.
        await mkdir(dirname(step.artifact_paths.friction_record), { recursive: true });
        await writeFile(step.artifact_paths.friction_record, JSON.stringify(record) + "\n");
        continue;
      }
      return step;
    }
  }
  throw new Error(
    `next-step did not reach present_report within ${MAX_FINALIZE_STEPS} calls`,
  );
}
