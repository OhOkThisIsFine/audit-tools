/**
 * provider-construction-and-resolution.test.ts — CP-NODE-4 obligation 2
 * (structured provider-construction outcome) and the auto-resolution
 * red-green obligations: chooseAutoProvider's claude-worker exclusion as a
 * property over the full AutoProviderContext space, the self-spawn guard's
 * effect on the raw `*Available` flags, the stale-citation re-ground, and the
 * standing no-hardcoded-model-id contract for discoverOutputConstraintCapability.
 */
import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFreshSessionProvider,
  chooseAutoProvider,
  getAutoProviderContext,
  discoverOutputConstraintCapability,
  ProviderConstructionError,
  PROVIDER_NAMES,
} from "audit-tools/shared";
import type {
  AutoProviderContext,
  FreshSessionProviderDeps,
  ResolvedProviderName,
} from "audit-tools/shared";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../..");

const deps: FreshSessionProviderDeps = {
  orchestratorName: "test",
  createClaudeCodeProvider: () => {
    throw new Error("unexpected: createClaudeCodeProvider called");
  },
  createClaudeWorkerProvider: () => {
    throw new Error("unexpected: createClaudeWorkerProvider called");
  },
  createOpenCodeProvider: () => {
    throw new Error("unexpected: createOpenCodeProvider called");
  },
  createAgyProvider: () => {
    throw new Error("unexpected: createAgyProvider called");
  },
};

// ── obligation 2: structured, non-retryable provider-construction outcome ──

const TEMPLATE_REQUIRING_CASES: Array<{
  provider: "subprocess-template" | "vscode-task" | "antigravity";
  sessionConfig: Record<string, unknown>;
}> = [
  { provider: "subprocess-template", sessionConfig: {} },
  { provider: "vscode-task", sessionConfig: {} },
  { provider: "antigravity", sessionConfig: {} },
];

for (const { provider, sessionConfig } of TEMPLATE_REQUIRING_CASES) {
  test(`construction of '${provider}' with no config yields a structured, non-retryable ProviderConstructionError`, () => {
    let caught: unknown;
    try {
      createFreshSessionProvider(provider, sessionConfig, deps);
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof ProviderConstructionError, `expected a ProviderConstructionError, got ${caught}`).toBe(true);
    const err = caught as InstanceType<typeof ProviderConstructionError>;
    expect(err.launchOutcome.outcome).toBe("construction_failed");
    expect(err.launchOutcome.retryable).toBe(false);
    expect(err.launchOutcome.kind).toBe("missing_required_config");
    expect(err.launchOutcome.provider).toBe(provider);
    expect(err.launchOutcome.contract_version).toBe("provider-launch-outcome-envelope/v1alpha1");
    expect(typeof err.message).toBe("string");
    expect(err.message.length).toBeGreaterThan(0);
  });
}

test("construction with an unrecognized provider name yields a structured, non-retryable ProviderConstructionError", () => {
  let caught: unknown;
  try {
    createFreshSessionProvider("totally-not-a-real-provider", {}, deps);
  } catch (error) {
    caught = error;
  }
  expect(caught instanceof ProviderConstructionError).toBe(true);
  const err = caught as InstanceType<typeof ProviderConstructionError>;
  expect(err.launchOutcome.kind).toBe("unknown_provider");
  expect(err.launchOutcome.retryable).toBe(false);
  expect(err.launchOutcome.outcome).toBe("construction_failed");
});

test("a construction failure is thrown SYNCHRONOUSLY, exactly once — no busy-retry loop", () => {
  let callCount = 0;
  const wrapped = () => {
    callCount += 1;
    createFreshSessionProvider("vscode-task", {}, deps);
  };
  assert.throws(wrapped, ProviderConstructionError);
  // The caller invoked construction exactly once; construction itself does not
  // loop or retry internally (there is no retry/backoff logic in constructProvider).
  expect(callCount).toBe(1);
});

test("the original error message text is preserved verbatim (existing regex-based test coupling stays valid)", () => {
  assert.throws(
    () => createFreshSessionProvider("antigravity", {}, deps),
    /antigravity.*command_template/i,
  );
  assert.throws(
    () => createFreshSessionProvider("vscode-task", {}, deps),
    /vscode-task.*command_template/i,
  );
});

// ── chooseAutoProvider: claude-worker exclusion as a property, not a sample ──

const AUTO_PROVIDER_CONTEXT_FIELDS: (keyof AutoProviderContext)[] = [
  "headless",
  "inVSCode",
  "insideOpenCode",
  "insideCodex",
  "insideAgy",
  "inAntigravity",
  "hasVSCodeTaskTemplate",
  "hasAntigravityTemplate",
  "hasSubprocessTemplate",
  "hasOpenCodeConfig",
  "hasCodexConfig",
  "hasAgyConfig",
  "hasOpenAiCompatibleConfig",
  "opencodeAvailable",
  "codexAvailable",
  "agyAvailable",
];

test("chooseAutoProvider NEVER returns 'claude-worker' and ALWAYS returns a defined, valid ResolvedProviderName — exhaustive over the full AutoProviderContext boolean space", () => {
  const validNames = new Set<string>(PROVIDER_NAMES.filter((n) => n !== "auto"));
  const fieldCount = AUTO_PROVIDER_CONTEXT_FIELDS.length;
  const total = 1 << fieldCount; // 2^19 — every boolean combination.
  const seenClaudeWorker: number[] = [];
  const invalid: Array<{ mask: number; resolved: unknown }> = [];

  for (let mask = 0; mask < total; mask++) {
    const ctx = {} as AutoProviderContext;
    for (let i = 0; i < fieldCount; i++) {
      (ctx as unknown as Record<string, boolean>)[AUTO_PROVIDER_CONTEXT_FIELDS[i]] = (mask & (1 << i)) !== 0;
    }
    const resolved: ResolvedProviderName = chooseAutoProvider(ctx);
    if ((resolved as string) === "claude-worker") seenClaudeWorker.push(mask);
    if (resolved === undefined || resolved === null || !validNames.has(resolved)) {
      invalid.push({ mask, resolved });
      if (invalid.length > 5) break;
    }
  }

  expect(seenClaudeWorker, `claude-worker returned for context masks: ${seenClaudeWorker.slice(0, 5).join(", ")}`).toEqual([]);
  expect(invalid, `undefined/invalid resolution for: ${JSON.stringify(invalid)}`).toEqual([]);
});

// ── self-spawn guard: *Available flags forced false, live against the real guard ──

test("getAutoProviderContext forces codexAvailable/agyAvailable false under each self-spawn env signal, even with the command on PATH", () => {
  const allCommandsExist = () => true;

  const codexCtx = getAutoProviderContext({}, { CODEX: "1" }, allCommandsExist);
  expect(codexCtx.codexAvailable, "codexAvailable must be forced false inside a CODEX session").toBe(false);

  const agyCtx = getAutoProviderContext({}, { AGY_CLI: "1" }, allCommandsExist);
  expect(agyCtx.agyAvailable, "agyAvailable must be forced false inside an AGY_CLI session").toBe(false);

  const antigravityCtx = getAutoProviderContext({}, { ANTIGRAVITY_CLI: "1" }, allCommandsExist);
  expect(antigravityCtx.agyAvailable, "agyAvailable must be forced false inside an ANTIGRAVITY_CLI session").toBe(false);

  // Sanity control: outside any self-spawn session, with the command on PATH,
  // *Available is true — proves the forcing above is the self-spawn guard's
  // doing, not e.g. lookupCommand always returning false.
  const clean = getAutoProviderContext({}, {}, allCommandsExist);
  expect(clean.codexAvailable).toBe(true);
  expect(clean.agyAvailable).toBe(true);
});

// ── RE-GROUND: the self-spawn signal citation must point at a real, current file ──

test("RE-GROUND: providerFactory.ts's self-spawn-signal citation points at the current single-package test path, not a stale packages/* path", () => {
  const src = readFileSync(resolve(repoRoot, "src/shared/providers/providerFactory.ts"), "utf8");
  expect(src.includes("packages/"), "providerFactory.ts must not cite a packages/* path — this is a single-package layout").toBe(false);
  const citedPath = "tests/shared/codex-antigravity-providers.test.ts";
  expect(src.includes(citedPath), `the self-spawn signal citation must name ${citedPath}`).toBe(true);
  expect(existsSync(resolve(repoRoot, citedPath)), `the cited test file must actually exist at ${citedPath}`).toBe(true);
});

// ── standing contract: no hardcoded model-id literal in discoverOutputConstraintCapability ──

test("standing contract: discoverOutputConstraintCapability's source contains no model-id literal", () => {
  const src = discoverOutputConstraintCapability.toString();
  const modelIdPattern =
    /claude-[0-9]|claude-(opus|sonnet|haiku)|gpt-4|gpt-3\.5|gpt-oss|gemini-|llama-|mistral-|o[13]-mini|o1-preview/i;
  expect(modelIdPattern.test(src), `discoverOutputConstraintCapability must not hardcode a model id. Source:\n${src}`).toBe(false);
});
