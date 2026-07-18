/**
 * H3 drift guard: ONE shared in-process worker classification. The three per-draw
 * allowlists this replaced had silently diverged (claude-worker missing from both at
 * first — a confirmable-but-undrivable lane; then agy missing from audit-hybrid) —
 * a new worker kind now routes in both draws by construction, and the two
 * predicates (pool-drivable-as-worker vs can-be-headless-primary) are distinct.
 */

import { test, expect } from "vitest";

const { isInProcessWorkerProvider, isHeadlessPrimaryProvider } = await import(
  "../../src/shared/providers/inProcessWorkers.ts"
);
const { isInProcessAuditPool } = await import("../../src/audit/cli/hybridDispatch.ts");

test("the worker base set is drivable in BOTH draws by construction (no per-draw drift)", () => {
  for (const provider of ["openai-compatible", "codex", "opencode", "agy", "claude-worker"]) {
    expect(isInProcessWorkerProvider(provider), `${provider} must be a worker in the shared base`).toBe(true);
    expect(isInProcessAuditPool({ providerName: provider }), `${provider} must classify as an audit in-process pool`).toBe(true);
    expect(isInProcessWorkerProvider(provider, { commandWorkers: true }), `${provider} must remain a worker under remediate policy`).toBe(true);
  }
});

test("command-shaped workers are remediate policy only (audit review packets carry no worker command)", () => {
  for (const provider of ["subprocess-template", "worker-command"]) {
    expect(isInProcessWorkerProvider(provider)).toBe(false);
    expect(isInProcessAuditPool({ providerName: provider })).toBe(false);
    expect(isInProcessWorkerProvider(provider, { commandWorkers: true })).toBe(true);
  }
});

test("claude-worker is a worker class ONLY — never a headless primary, in either draw", () => {
  expect(isInProcessWorkerProvider("claude-worker")).toBe(true);
  expect(isHeadlessPrimaryProvider("claude-worker")).toBe(false);
  expect(isHeadlessPrimaryProvider("claude-worker", { commandWorkers: true })).toBe(false);
});

test("the host and IDE backends are never in-process workers", () => {
  for (const provider of ["claude-code", "vscode-task", "antigravity", "auto", undefined]) {
    expect(isInProcessWorkerProvider(provider, { commandWorkers: true })).toBe(false);
    expect(isHeadlessPrimaryProvider(provider, { commandWorkers: true })).toBe(false);
  }
});

test("H3 guard: provider 'claude-worker' is rejected at session-config validation (worker class, never primary)", async () => {
  const { validateSessionConfig } = await import("../../src/shared/validation/sessionConfig.ts");
  const issues = validateSessionConfig({ provider: "claude-worker" });
  expect(issues.some((i) => i.path === "provider" && /worker class/i.test(i.message))).toBe(true);
  // A legitimate worker provider as primary stays accepted.
  expect(validateSessionConfig({ provider: "codex" }).filter((i) => i.path === "provider")).toEqual([]);
});
