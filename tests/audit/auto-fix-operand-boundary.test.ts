import { test, expect, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../src/audit/orchestrator/localCommands.js", () => ({
  resolveNodeTool: (_root: string, script: string, args: string[], display: string) =>
    [{ command: "node", args: [script, ...args], display }],
  runFirstAvailableCommand: mocks.run,
}));

const { runAutoFixExecutor } = await import("../../src/audit/orchestrator/autoFixExecutor.js");

test("Prettier receives leading-dash filenames only after the operand delimiter in both resolution arms", async () => {
  const root = await mkdtemp(join(tmpdir(), "autofix-operands-"));
  mocks.run.mockResolvedValue(null);
  try {
    await writeFile(join(root, ".prettierrc"), "{}\n");
    const paths = ["--config=evil.js", "ordinary.js"];
    await runAutoFixExecutor({ file_disposition: { files: paths.map(path => ({ path, status: "included" as const })) } }, root, { autoFix: { enabled: true } });
    expect(mocks.run).toHaveBeenCalledTimes(1);
    const candidates = mocks.run.mock.calls[0][1] as Array<{ args: string[] }>;
    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) {
      expect(candidate.args.slice(-4)).toEqual(["--write", "--", ...paths]);
    }
  } finally {
    mocks.run.mockReset();
    await rm(root, { recursive: true, force: true });
  }
});
