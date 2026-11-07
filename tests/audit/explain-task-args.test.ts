import { afterEach, expect, test, vi } from "vitest";
import { join, resolve } from "node:path";
import { cmdExplainTask } from "../../src/audit/cli/explainTaskCommand.js";
import { loadArtifactBundle } from "../../src/audit/io/artifacts.js";
import { validateAuditArguments, NEXT_STEP_ARGUMENTS } from "../../src/audit/cli/argumentContract.js";

vi.mock("../../src/audit/io/artifacts.js", () => ({
  loadArtifactBundle: vi.fn(async () => ({
    audit_tasks: ["T1", "T2", "--task-id=T2", "--root=elsewhere"].map(task_id => ({
      task_id, file_paths: [],
    })),
  })),
}));

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

const root = resolve("explain-task-test-root");
const artifacts = resolve("explain-task-test-artifacts");
test.each([
  { args: ["T1"], task: "T1" },
  { args: ["--root", root, "T1"], task: "T1", dir: join(root, ".audit-tools", "audit") },
  { args: ["T1", "--root", root], task: "T1", dir: join(root, ".audit-tools", "audit") },
  { args: [`--root=${root}`, "T1"], task: "T1", dir: join(root, ".audit-tools", "audit") },
  { args: ["--artifacts-dir", artifacts, "T1"], task: "T1", dir: artifacts },
  { args: [`--artifacts-dir=${artifacts}`, "T1"], task: "T1", dir: artifacts },
  { args: ["--root", root, "T1", "--artifacts-dir", artifacts], task: "T1", dir: artifacts },
  { args: ["--root", root, "--", "T1"], task: "T1", dir: join(root, ".audit-tools", "audit") },
  { args: ["--task-id", "T2", "T1"], task: "T2" },
  { args: ["--task-id", "T2"], task: "T2" },
  { args: ["T1", "--task-id=T2"], task: "T2" },
  { args: ["--task-id=T2", "--", "T1"], task: "T2" },
  { args: ["--", "--task-id=T2"], task: "--task-id=T2" },
  { args: ["--artifacts-dir", artifacts, "--", "--root=elsewhere"], task: "--root=elsewhere", dir: artifacts },
])("resolves task and artifact options: $args", async ({ args, task, dir }) => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await cmdExplainTask(["node", "cli.js", "explain-task", ...args]);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ task_id: task });
  if (dir) expect(loadArtifactBundle).toHaveBeenCalledWith(dir);
});

test.each([[], ["--root", root], [`--artifacts-dir=${artifacts}`], ["--root", root, "--"]])(
  "missing task fails before reading artifacts: %j", async (...args) => {
    await expect(cmdExplainTask(["node", "cli.js", "explain-task", ...args]))
      .rejects.toThrow("explain-task requires <task_id> or --task-id <task_id>");
    expect(loadArtifactBundle).not.toHaveBeenCalled();
  },
);

test.each([
  { args: ["--task-id"], error: "--task-id requires a value" },
  { args: ["--task-id="], error: "--task-id requires a value" },
  { args: ["T1", "T2"], error: "unexpected positional argument T2" },
  { args: ["--", "T1", "T2"], error: "unexpected positional argument T2" },
])("invalid task arguments fail before reading artifacts: $args", async ({ args, error }) => {
  await expect(cmdExplainTask(["node", "cli.js", "explain-task", ...args])).rejects.toThrow(error);
  expect(loadArtifactBundle).not.toHaveBeenCalled();
});

test("shared argument validation still accepts switches and consumes values without positionals", () => {
  expect(validateAuditArguments("next-step", ["--root", root, "--auto-fix", "--timeout=100", "--dry-run"], NEXT_STEP_ARGUMENTS)).toEqual([]);
});

test.each([
  { args: ["T1"], error: "unexpected positional argument T1" },
  { args: ["--", "--auto-fix"], error: "unexpected positional argument --auto-fix" },
  { args: ["--auto-fix=true"], error: "--auto-fix does not take a value" },
  { args: ["--root"], error: "--root requires a value" },
  { args: ["--timeout="], error: "--timeout requires a value" },
  { args: ["--bogus"], error: "unsupported argument --bogus" },
])("shared validation preserves rejection: $args", ({ args, error }) => {
  expect(() => validateAuditArguments("next-step", args, NEXT_STEP_ARGUMENTS)).toThrow(error);
});
