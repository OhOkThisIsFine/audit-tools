// Shared harness for the next-step-core-*.test.ts suite (split from the former
// single next-step.test.ts so no one file dominates a CI shard — the wall-clock
// brief's T4). Faithful move: temp-repo fixture + the structure-phase pause
// walker the split files share.
import { expect } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWrapper } from "./run-wrapper.mjs";

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
// Known pause kinds that are advanced past automatically:
//   - analyzer_install: write an empty analyzer-decisions.json to skip
//   - design_review: write an empty design-review-findings.json
//   - edge_reasoning_dispatch: write an empty edge-reasoning.json
//
// Terminal (non-pause) kinds that are returned to callers:
//   dispatch_review, single_task, synthesis, present_report
//
// Any other unrecognised kind causes an immediate descriptive throw rather than
// silently returning a mismatched step to the caller.
const ADVANCE_PAST_DESIGN_REVIEW_TERMINAL_KINDS = new Set([
  "dispatch_review",
  "single_task",
  "synthesis",
  "present_report",
]);

// Several pause step kinds (analyzer_install + design_review_parallel/contract/conceptual
// + confirm_intent + optional edge_reasoning), each at most once; allow extra headroom.
const MAX_STRUCTURE_PHASE_PAUSES = 8;
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
  const incomingDir = join(root, ".audit-tools/audit", "incoming");
  for (let i = 0; i < MAX_STRUCTURE_PHASE_PAUSES; i++) {
    const step = JSON.parse(
      (await runWrapper(wrapperArgs, { cwd: root, ...wrapperOpts })).stdout,
    );
    if (step.step_kind === "critical_flow_fallback") {
      await mkdir(incomingDir, { recursive: true });
      await writeFile(
        step.artifact_paths.critical_flow_fallback_results,
        JSON.stringify({ flows: [] }, null, 2) + "\n",
      );
      continue;
    }
    if (step.step_kind === "analyzer_consent") {
      await mkdir(incomingDir, { recursive: true });
      await writeFile(
        join(incomingDir, "analyzer-consent-decisions.json"),
        JSON.stringify({ semgrep: "declined", eslint: "declined", knip: "declined", jscpd: "declined", "osv-scanner": "declined" }, null, 2) + "\n",
      );
      continue;
    }
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
    if (step.step_kind === "design_review_parallel") {
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
      await mkdir(incomingDir, { recursive: true });
      await writeFile(
        join(incomingDir, "design-review-contract-findings.json"),
        JSON.stringify([], null, 2) + "\n",
      );
      await writeFile(
        join(incomingDir, "design-review-conceptual-findings.json"),
        JSON.stringify([], null, 2) + "\n",
      );
      continue;
    }
    if (step.step_kind === "design_review_contract") {
      await mkdir(incomingDir, { recursive: true });
      await writeFile(
        join(incomingDir, "design-review-contract-findings.json"),
        JSON.stringify([], null, 2) + "\n",
      );
      continue;
    }
    if (step.step_kind === "design_review_conceptual") {
      await mkdir(incomingDir, { recursive: true });
      await writeFile(
        join(incomingDir, "design-review-conceptual-findings.json"),
        JSON.stringify([], null, 2) + "\n",
      );
      continue;
    }
    if (step.step_kind === "edge_reasoning_dispatch") {
      await mkdir(incomingDir, { recursive: true });
      await writeFile(
        step.artifact_paths.edge_reasoning_results,
        JSON.stringify([], null, 2) + "\n",
      );
      continue;
    }
    if (step.step_kind === "confirm_intent") {
      await writeFile(
        step.artifact_paths.intent_checkpoint,
        JSON.stringify(
          {
            schema_version: "intent-checkpoint/v1",
            confirmed_at: "2026-04-22T00:00:00Z",
            confirmed_by: "host",
            scope_summary: "test scope",
            intent_summary: "full-audit",
          },
          null,
          2,
        ) + "\n",
      );
      continue;
    }
    if (ADVANCE_PAST_DESIGN_REVIEW_TERMINAL_KINDS.has(step.step_kind)) {
      return step;
    }
    throw new Error(
      `advancePastDesignReview: unexpected pause kind '${step.step_kind}' (iteration ${i})`,
    );
  }
  throw new Error("next-step did not advance past structure-phase pauses");
}
