import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, it, vi } from "vitest";

const RED_SIGNATURE =
  "contract:backend-independent-remediation-planning:not-yet-satisfied";

const forbidden = vi.hoisted(() => {
  const counts: Record<string, number> = {
    context: 0,
    model: 0,
    network: 0,
    process: 0,
    provider: 0,
    quota: 0,
    state_store: 0,
  };
  return {
    counts,
    reset(): void {
      for (const key of Object.keys(counts)) counts[key] = 0;
    },
    call(name: keyof typeof counts): never {
      counts[name] = (counts[name] ?? 0) + 1;
      throw new Error(`forbidden-${name}-call`);
    },
  };
});

vi.mock("audit-tools/shared", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveContextBudget: () => forbidden.call("context"),
    resolveModelStatics: () => forbidden.call("model"),
    resolveFreshSessionProviderName: () => forbidden.call("provider"),
    createFreshSessionProvider: () => forbidden.call("provider"),
  };
});

vi.mock("../../src/remediate/state/store.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    StateStore: class ForbiddenStateStore {
      constructor() {
        forbidden.call("state_store");
      }
    },
  };
});

vi.mock("../../src/remediate/steps/dispatch.js", () => ({
  scheduleWave: () => forbidden.call("quota"),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const blocked = () => forbidden.call("process");
  return {
    ...actual,
    exec: blocked,
    execFile: blocked,
    execFileSync: blocked,
    execSync: blocked,
    fork: blocked,
    spawn: blocked,
    spawnSync: blocked,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (
      path: Parameters<typeof actual.readFileSync>[0],
      ...args: unknown[]
    ): ReturnType<typeof actual.readFileSync> => {
      if (String(path).replace(/\\/gu, "/").endsWith("/unreadable-baseline.ts")) {
        const error = new Error("synthetic unreadable baseline") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return (actual.readFileSync as (...values: unknown[]) => ReturnType<typeof actual.readFileSync>)(
        path,
        ...args,
      );
    },
  };
});

import {
  AUDIT_FINDINGS_CONTRACT_VERSION,
  ESTIMATED_ITEM_OVERHEAD_TOKENS,
  ESTIMATED_PROMPT_OVERHEAD_TOKENS,
  estimateTokensFromBytes,
  type AuditFindingsReport,
  type Finding,
} from "audit-tools/shared";
import { buildAuditFindingsDeliverable } from "../../src/shared/reporting/auditDeliverable.js";
import { writeContractArtifact } from "../../src/remediate/contractPipeline/artifactStore.js";
import { pathASeedFilePath } from "../../src/remediate/contractPipeline/artifactStore.js";
import {
  applyPlanPipeline,
  buildCoverageLedger,
  isAuditFindingsReport,
} from "../../src/remediate/phases/plan.js";
import { intakePaths } from "../../src/remediate/intake.js";
import {
  promoteImplementationDagToExtractedPlan,
  writePathASeedFromFindings,
} from "../../src/remediate/steps/contractPipeline.js";
import { snapshotAffectedFileHashes } from "../../src/remediate/utils/fileIntegrity.js";

const sandboxes = new Set<string>();
const originalFetch = globalThis.fetch;

function fail(detail: string, cause?: unknown): never {
  throw new Error(`${RED_SIGNATURE}: ${detail}`, cause === undefined ? undefined : { cause });
}

function requireContract(condition: unknown, detail: string): asserts condition {
  if (!condition) fail(detail);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requireEqual(actual: unknown, expected: unknown, detail: string): void {
  if (stable(actual) !== stable(expected)) {
    fail(`${detail}; expected ${stable(expected)}, received ${stable(actual)}`);
  }
}

function assertOffline(): void {
  const calls = Object.entries(forbidden.counts).filter(([, count]) => count !== 0);
  if (calls.length > 0) {
    fail(`planning invoked forbidden effects: ${calls.map(([name, count]) => `${name}=${count}`).join(", ")}`);
  }
}

function finding(id: "a" | "b" | "c", affectedFiles: string[], systemic = false): Finding {
  return {
    id,
    title: `Finding ${id}`,
    category: "contract-test",
    severity: id === "a" ? "high" : "medium",
    confidence: "high",
    lens: id === "c" ? "reliability" : "correctness",
    summary: `Summary ${id}`,
    affected_files: affectedFiles.map((path) => ({ path })),
    evidence: [`Evidence ${id}`],
    ...(systemic ? { systemic: true } : {}),
  };
}

function canonicalReport(reverse: boolean): AuditFindingsReport {
  const findings = [
    finding("a", ["src/shared.ts", "src/missing.ts"], true),
    finding("b", ["src/shared.ts", "./src/shared.ts", "src/b.ts"]),
    finding("c", ["src/c.ts"]),
  ];
  if (reverse) {
    findings.reverse();
    for (const entry of findings) entry.affected_files.reverse();
  }
  const report = buildAuditFindingsDeliverable(findings);
  // Planning must derive estimates from disk, not trust upstream estimates.
  report.work_blocks.forEach((block, index) => {
    block.token_estimate = index + 1;
  });
  return report;
}

async function makeSandbox(): Promise<{ sandbox: string; root: string; artifactsDir: string }> {
  const sandbox = await mkdtemp(join(tmpdir(), "audit-tools-birp-"));
  sandboxes.add(sandbox);
  const root = join(sandbox, "repo");
  const artifactsDir = join(root, ".audit-tools", "remediation");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "shared.ts"), "shared\n", "utf8");
  await writeFile(join(root, "src", "b.ts"), "bb\n", "utf8");
  await writeFile(join(root, "src", "c.ts"), "cccc\n", "utf8");
  return { sandbox, root, artifactsDir };
}

async function promote(
  reverse: boolean,
): Promise<{
  report: AuditFindingsReport;
  plan: Record<string, unknown>;
  root: string;
}> {
  const { root, artifactsDir } = await makeSandbox();
  const report = canonicalReport(reverse);
  const reportPath = join(root, "audit-findings.json");
  await writeFile(reportPath, JSON.stringify(report), "utf8");
  await writePathASeedFromFindings(artifactsDir, reportPath, report);

  const nodeAB = {
    id: "dag-node-ab",
    title: "Implement canonical group a/b",
    description: "Implement the canonical a/b finding group.",
    source_finding_ids: reverse ? ["b", "a"] : ["a", "b"],
    satisfies_obligations: [],
    verification_obligation_ids: [],
    addresses_counterexamples: [],
    depends_on: [],
    output_files: ["src/shared.ts", "src/b.ts"],
    targeted_commands: [],
    status: "pending",
  };
  const nodeC = {
    id: "dag-node-c",
    title: "Implement canonical group c",
    description: "Implement canonical finding c.",
    source_finding_ids: ["c"],
    satisfies_obligations: [],
    verification_obligation_ids: [],
    addresses_counterexamples: [],
    depends_on: ["dag-node-ab"],
    output_files: ["src/c.ts"],
    targeted_commands: [],
    status: "pending",
  };
  await writeContractArtifact(artifactsDir, "implementation_dag", {
    contract_version: "remediate-code-contract-pipeline/implementation-dag/v1alpha1",
    goal_id: "backend-independent-planning",
    nodes: reverse ? [nodeC, nodeAB] : [nodeAB, nodeC],
    waves: [],
    created_at: "2026-08-11T00:00:00.000Z",
  });
  await promoteImplementationDagToExtractedPlan(artifactsDir);
  const promoted = JSON.parse(
    await readFile(intakePaths(artifactsDir).extractedPlan, "utf8"),
  ) as Record<string, unknown>;
  try {
    const plan = await applyPlanPipeline(promoted as never, { root, artifactsDir });
    return { report, plan: plan as unknown as Record<string, unknown>, root };
  } catch (error) {
    fail("valid structured promotion did not complete backend-independently", error);
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function planView(result: {
  report: AuditFindingsReport;
  plan: Record<string, unknown>;
}): Record<string, unknown> {
  const findings = result.plan.findings as Finding[];
  const blocks = result.plan.blocks as Array<Record<string, unknown>>;
  requireContract(Array.isArray(findings), "promoted plan omitted findings");
  requireContract(Array.isArray(blocks), "promoted plan omitted blocks");

  const memberships = blocks
    .map((block) => [...((block.items as string[]) ?? [])].sort())
    .sort((left, right) => (left[0] ?? "").localeCompare(right[0] ?? ""));
  requireEqual(memberships, [["a", "b"], ["c"]], "canonical block membership changed");
  const flattened = memberships.flat();
  requireEqual(flattened, ["a", "b", "c"], "plan membership is not exhaustive");
  requireContract(new Set(flattened).size === flattened.length, "a finding was planned more than once");

  const itemStates: Record<string, { finding_id: string; status: "pending"; block_id: string }> = {};
  for (const block of blocks) {
    for (const findingId of (block.items as string[]) ?? []) {
      requireContract(itemStates[findingId] === undefined, `duplicate coverage membership for ${findingId}`);
      itemStates[findingId] = {
        finding_id: findingId,
        status: "pending",
        block_id: String(block.block_id),
      };
    }
  }
  const coverage = buildCoverageLedger({
    planId: String(result.plan.plan_id),
    sourceFindings: result.report.findings,
    droppedNoEvidence: [],
    droppedByCheckpoint: [],
    mergeMap: new Map(),
    items: itemStates,
  });
  requireContract(coverage.source_finding_count === 3 && coverage.planned_count === 3, "coverage counts are not exhaustive");
  requireEqual(
    coverage.entries.map((entry) => [entry.finding_id, entry.disposition]).sort(),
    [["a", "planned"], ["b", "planned"], ["c", "planned"]],
    "coverage dispositions are not exact-once planned",
  );

  const estimateByMembers = Object.fromEntries(
    blocks.map((block) => [
      ((block.items as string[]) ?? []).slice().sort().join(","),
      block.token_estimate,
    ]),
  );
  requireEqual(
    estimateByMembers,
    {
      "a,b":
        ESTIMATED_PROMPT_OVERHEAD_TOKENS +
        2 * ESTIMATED_ITEM_OVERHEAD_TOKENS +
        estimateTokensFromBytes(Buffer.byteLength("shared\n") + Buffer.byteLength("bb\n")),
      c:
        ESTIMATED_PROMPT_OVERHEAD_TOKENS +
        ESTIMATED_ITEM_OVERHEAD_TOKENS +
        estimateTokensFromBytes(Buffer.byteLength("cccc\n")),
    },
    "advisory estimates did not use canonical unique physical-file bytes",
  );

  const hashes = Object.fromEntries(
    findings
      .flatMap((entry) =>
        entry.affected_files.map((file) => [`${entry.id}:${file.path}`, file.hash_at_plan_time]),
      )
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
  );
  requireEqual(
    hashes,
    {
      "a:src/missing.ts": undefined,
      "a:src/shared.ts": sha256("shared\n"),
      "b:./src/shared.ts": sha256("shared\n"),
      "b:src/b.ts": sha256("bb\n"),
      "b:src/shared.ts": sha256("shared\n"),
      "c:src/c.ts": sha256("cccc\n"),
    },
    "baseline hashes or deterministic missing-path policy changed",
  );

  return { memberships, estimateByMembers, hashes, coverage: coverage.entries };
}

beforeEach(() => {
  forbidden.reset();
  globalThis.fetch = (() => forbidden.call("network")) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  const pending = [...sandboxes];
  sandboxes.clear();
  await Promise.all(pending.map(async (path) => await rm(path, { recursive: true, force: true })));
});

describe(RED_SIGNATURE, () => {
  it("rejects a malformed contract-claiming report before seed, plan, or state writes", async () => {
    const { root, artifactsDir } = await makeSandbox();
    const malformed = {
      contract_version: AUDIT_FINDINGS_CONTRACT_VERSION,
      findings: [{ id: "a", title: "malformed", severity: "impossible" }],
    };
    requireContract(isAuditFindingsReport(malformed), "malformed contract claim did not route structured");

    let rejection: unknown;
    try {
      await writePathASeedFromFindings(artifactsDir, join(root, "audit-findings.json"), malformed);
    } catch (error) {
      rejection = error;
    }
    const paths = intakePaths(artifactsDir);
    const forbiddenWrites = [
      pathASeedFilePath(artifactsDir),
      paths.extractedPlan,
      join(artifactsDir, "state.json"),
    ];
    const written = forbiddenWrites.filter(existsSync);
    if (rejection === undefined || written.length > 0) {
      fail(`malformed structured report was not rejected before writes${written.length > 0 ? `: ${written.join(", ")}` : ""}`);
    }
    requireContract(/Invalid AuditFindingsReport|summary|severity/iu.test(String(rejection)), "structured rejection was not path-qualified");
    assertOffline();
  });

  it("preserves canonical membership, coverage, estimates, and hashes across full promotion permutations", async () => {
    const forward = await promote(false);
    const reverse = await promote(true);
    const forwardView = planView(forward);
    const reverseView = planView(reverse);
    requireEqual(reverseView, forwardView, "permuting findings and DAG nodes changed the plan");
    assertOffline();
  });

  it("allows deterministic missing estimates but refuses dangerous paths as trusted baselines", async () => {
    const { sandbox, root } = await makeSandbox();
    await mkdir(join(root, "src", "directory-baseline"), { recursive: true });
    await writeFile(join(root, "src", "directory-baseline", "nested.ts"), "nested", "utf8");
    await writeFile(join(root, "src", "unreadable-baseline.ts"), "secret", "utf8");
    const outside = join(sandbox, "outside.ts");
    await writeFile(outside, "outside", "utf8");
    const cases = [
      { label: "directory", path: "src/directory-baseline" },
      { label: "unreadable", path: "src/unreadable-baseline.ts" },
      { label: "absolute", path: join(root, "src", "shared.ts") },
      { label: "root-escaping", path: "../outside.ts" },
    ];
    const accepted: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      for (const entry of cases) {
        const target = finding("a", [entry.path]);
        try {
          snapshotAffectedFileHashes(root, [target]);
          accepted.push(entry.label);
        } catch (error) {
          requireContract(
            String(error).includes(entry.path) || String(error).includes(entry.label),
            `${entry.label} rejection was not path-qualified`,
          );
        }
      }
    } finally {
      stderr.mockRestore();
    }
    if (accepted.length > 0) fail(`dangerous baseline paths were trusted: ${accepted.join(", ")}`);

    const missing = finding("a", ["src/missing.ts"]);
    snapshotAffectedFileHashes(root, [missing]);
    requireContract(missing.affected_files[0]?.hash_at_plan_time === undefined, "missing path acquired a trusted baseline hash");
    assertOffline();
  });
});
