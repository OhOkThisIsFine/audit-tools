import { test, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import type { CapacityPool } from "../../src/shared/quota/capacity.js";
import type { SessionConfig } from "../../src/shared/types/sessionConfig.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SIZING_WINDOW = join(REPO_ROOT, "src/audit/cli/dispatch/sizingWindow.ts");

// ── The invariant ────────────────────────────────────────────────────────────
//
// Packet sizing asks ONE question: how many tokens of review content fit in a
// single packet. That is a property of the declared/discovered model window —
// task metadata the tool reports — not of a dispatch pool, which is a routing
// concept (audit-tools does NOT route; the host dispatches). Before this module
// existed the window was produced by running `computeDispatchCapacity` over a
// `CapacityPool` and reading `primary.schedule.resolved_limits` back out, so the
// sizing number could not be computed without the capacity fold and the wave
// scheduler.
//
// This test pins the separation MECHANICALLY rather than by convention: it walks
// the module's RUNTIME import closure (type-only imports are erased, so they
// cannot pull the fold in) and fails if the closure reaches `quota/capacity` or
// `quota/scheduler` — including via the `audit-tools/shared` barrel, which
// re-exports both.

const VALUE_IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)(?:[^;'"]*?\sfrom\s+)?["']([^"']+)["']/g;

function specifiersOf(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(VALUE_IMPORT)) {
    const specifier = match[1];
    if (specifier) out.push(specifier);
  }
  return out;
}

/** Map a specifier to a repo source file, or null when it leaves the tree. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  const toSourcePath = (base: string): string =>
    base.endsWith(".js") ? `${base.slice(0, -3)}.ts` : `${base}.ts`;
  if (specifier.startsWith(".")) {
    return toSourcePath(resolve(dirname(fromFile), specifier));
  }
  if (specifier === "audit-tools/shared") {
    return join(REPO_ROOT, "src/shared/index.ts");
  }
  if (specifier.startsWith("audit-tools/shared/")) {
    return toSourcePath(join(REPO_ROOT, "src/shared", specifier.slice("audit-tools/shared/".length)));
  }
  return null; // node: builtin or an external dependency
}

async function runtimeImportClosure(entry: string): Promise<Set<string>> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seen.has(current) || !existsSync(current)) continue;
    seen.add(current);
    const source = await readFile(current, "utf8");
    for (const specifier of specifiersOf(source)) {
      const target = resolveSpecifier(current, specifier);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

test("the packet-sizing window resolver does not run the capacity fold", async () => {
  expect(
    existsSync(SIZING_WINDOW),
    "src/audit/cli/dispatch/sizingWindow.ts must own the packet-sizing window",
  ).toBe(true);

  const closure = await runtimeImportClosure(SIZING_WINDOW);
  const routing = [...closure]
    .map((file) => file.slice(REPO_ROOT.length + 1).replaceAll("\\", "/"))
    .filter((file) => file === "src/shared/quota/capacity.ts" || file === "src/shared/quota/scheduler.ts");

  expect(
    routing,
    "sizing must resolve its window directly; reaching capacity.ts/scheduler.ts means the number is pool-derived again",
  ).toEqual([]);
});

// ── Behaviour preservation ───────────────────────────────────────────────────
//
// The extraction is only sound if the number is unchanged. `computeDispatchCapacity`
// reaches `resolved_limits` through `scheduleWave` -> `resolveLimits({providerName,
// sessionConfig, hostModel, discoveredLimits})`, and the wave scheduler mutates only
// the RPM/TPM fields afterwards — never the context/output pair sizing reads. So the
// direct resolution must agree with the fold on every rung.

// No cast: the fixture is a real SessionConfig / CapacityPool so `check:tests`
// keeps verifying its shape against the contract these functions actually read.
const SESSION_CONFIG: SessionConfig = {};

function poolWith(overrides: Partial<CapacityPool>): CapacityPool {
  return {
    id: "test-pool",
    accountKey: "test-account",
    providerName: "claude-code",
    hostModel: null,
    hostConcurrencyLimit: null,
    ...overrides,
  };
}

test("the direct window agrees with the capacity fold on every resolution rung", async () => {
  const { resolveSizingWindowTokens } = await import("../../src/audit/cli/dispatch/sizingWindow.js");
  const { computeDispatchCapacity } = await import("../../src/shared/quota/capacity.js");

  // Sizing names no provider at all (see SizingWindowInput). The fold still
  // does, so the equivalence is checked against BOTH host classes — `claude-code`
  // is `hosted` and `opencode` is `local`, the two branches `hostClassFor` can
  // take. Agreeing with both is the mechanical statement that the window pair is
  // provider-independent: if the provider could ever move the number, one of
  // these two folds would disagree with the single provider-free resolution.
  const PROVIDERS = ["claude-code", "opencode"] as const;

  const cases: Array<{ label: string; pool: CapacityPool }> = [
    {
      label: "discovered capability (the handshake rung)",
      pool: poolWith({
        hostModel: "test-model",
        discoveredLimits: { context_tokens: 200000, output_tokens: 32000 },
      }),
    },
    {
      label: "no window resolvable anywhere",
      pool: poolWith({ hostModel: null, discoveredLimits: null }),
    },
    {
      label: "discovered context with no output cap",
      pool: poolWith({
        hostModel: "test-model",
        discoveredLimits: { context_tokens: 128000 },
      }),
    },
  ];

  for (const { label, pool } of cases) {
    const direct = resolveSizingWindowTokens({
      sessionConfig: SESSION_CONFIG,
      hostModel: pool.hostModel,
      discoveredLimits: pool.discoveredLimits ?? null,
    });

    for (const providerName of PROVIDERS) {
      const folded = computeDispatchCapacity({
        pools: [{ ...pool, providerName }],
        sessionConfig: SESSION_CONFIG,
        pendingItemTokens: [],
      }).primary.schedule.resolved_limits;
      const expected =
        folded.context_tokens == null || folded.output_tokens == null
          ? null
          : folded.context_tokens - folded.output_tokens > 0
            ? folded.context_tokens - folded.output_tokens
            : null;

      expect(
        direct,
        `${label} / ${providerName}: the provider-free window must equal the folded window`,
      ).toBe(expected);
    }
  }
});
