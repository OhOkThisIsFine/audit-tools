// Shared harness for the next-step-core-*.test.ts suite (split from the former
// single next-step.test.ts so no one file dominates a CI shard — the wall-clock
// brief's T4). Faithful move: temp-repo fixture + the structure-phase pause
// walker the split files share.
import { expect } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWrapper } from "./run-wrapper.mjs";
import { walkStepsUntilTerminal } from "./step-driver.js";

export async function withTempRepo<T>(fn: (root: string) => Promise<T>): Promise<T> {
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
    const seededArtifactsDir = join(root, ".audit-tools/audit");
    await mkdir(seededArtifactsDir, { recursive: true });
    return await fn(root);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// Walk next-step past the structure-phase pauses (graph-enrichment install
// prompt, then design review) by skipping the optional analyzers and supplying
// empty design-review findings, returning the first non-pause step.
//
// The pause answering itself is `walkStepsUntilTerminal`. What is genuinely
// specific to this walk is its BROADER terminal set — it stops at any of four
// step kinds, where the dispatch-oriented walks stop only at dispatch_review —
// and the double-driver assertion it makes on the parallel design-review step.
//
// Any unrecognised kind causes an immediate descriptive throw rather than
// silently returning a mismatched step to the caller.
export const ADVANCE_PAST_DESIGN_REVIEW_TERMINAL_KINDS = new Set([
  "dispatch_review",
  "single_task",
  "synthesis",
  "present_report",
]);

export const TEST_AUDITOR_ARGS = [
  "--auditor",
  JSON.stringify({
    self: {
      provider: "worker-command",
      context_tokens: 200_000,
      output_tokens: 8_000,
    },
  }),
];

export async function advancePastDesignReview(
  root: string,
  wrapperArgs: string[] = ["next-step", ...TEST_AUDITOR_ARGS],
  wrapperOpts: Record<string, unknown> = {},
) {
  return walkStepsUntilTerminal({
    root,
    transport: async () =>
      JSON.parse(
        (await runWrapper(wrapperArgs, { cwd: root, ...wrapperOpts })).stdout,
      ),
    terminalKinds: ADVANCE_PAST_DESIGN_REVIEW_TERMINAL_KINDS,
    label: "advancePastDesignReview",
    observePause: async (step) => {
      if (step.step_kind !== "design_review_parallel") return;
      // Regression (double-driver): the dispatched contract-review WORKER packet
      // must NOT carry the orchestrator advance command — a worker that runs
      // `next-step` becomes a SECOND driver while the host is mid-parallel-dispatch.
      // The advance belongs solely to the host step prompt. (Discriminate on the
      // instruction phrasing, not the bare "next-step" token, which also appears
      // inside the temp-repo path the packet legitimately prints.)
      const workerPacket = await readFile(step.artifact_paths.contract_prompt, "utf8");
      expect(workerPacket).not.toContain("Then run:");
      const hostPrompt = await readFile(step.prompt_path, "utf8");
      expect(hostPrompt).toContain("both been written, run:");
    },
  });
}
