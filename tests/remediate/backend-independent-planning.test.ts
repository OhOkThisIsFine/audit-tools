import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, it, vi } from "vitest";

import { DISPATCH_BARREL_EXPORTS } from "../helpers/dispatchBarrelBaseline.js";

const RED_SIGNATURE =
  "contract:backend-independent-remediation-planning:not-yet-satisfied";

const forbidden = vi.hoisted(() => {
  // Every channel here must be one a REGRESSION could actually reach. The
  // context / model / provider / quota channels were mocked onto
  // resolveContextBudget, resolveModelStatics, resolveFreshSessionProviderName,
  // createFreshSessionProvider and scheduleWave — all five deleted by the
  // zero-adapter retirement, so a grep across src/ returns zero hits for each.
  // A mock on a symbol that no longer exists cannot be called by anything, so
  // those four counters were pinned at 0 for every possible regression: the
  // guard read as four channels of protection and was none. They are removed
  // rather than repointed at a contrived call site — a channel is either
  // reachable or it does not belong here.
  const counts: Record<string, number> = {
    dispatch: 0,
    network: 0,
    process: 0,
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

// NOTE: there is deliberately NO `vi.mock("audit-tools/shared", …)` here. Its
// only overrides were the four retired symbols above; with those gone the mock
// spread `...actual` over the real module and overrode nothing, i.e. it was an
// elaborate identity function.

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

// The dispatch barrel, retargeted onto symbols that EXIST at HEAD. Planning
// must never prepare a host workload or ingest a result — those are the live
// capabilities a planning-side regression could actually reach, unlike
// `scheduleWave`, which this mock used to name and which no longer exists.
//
// REACHABILITY IS PROVEN, NOT ASSUMED. `src/remediate/steps/dispatch.ts` is not
// in the current transitive import closure of the planning entry points this
// suite drives, which reads like a dead channel. It is not: `vi.mock` replaces
// the module REGISTRY-WIDE, so the substitution is already in force for whatever
// imports the barrel next. Running this suite with a call to
// `prepareRemediationHostHandoff` added inside `promoteImplementationDagToExtractedPlan`
// produced `planning invoked forbidden effects: dispatch=2` — the counter fired
// and assertOffline() went red. That is the whole point of a tripwire, and it is
// the same standing as the global fetch / child_process patches, which today's
// closure also never reaches. The four channels deleted above were different in
// kind: their symbols no longer exist anywhere in src/, so no regression could
// call them even in principle.
//
// `...actual` is load-bearing. The previous shape was a bare object literal, so
// every other export of the barrel resolved to `undefined` for any module this
// test loads — a mock of one symbol silently blanking the rest of a barrel is a
// failure mode that hides behind a green suite until an unrelated path needs one
// of them.
vi.mock("../../src/remediate/steps/dispatch/hostHandoff.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    prepareRemediationHostHandoff: () => forbidden.call("dispatch"),
    ingestRemediationHostResults: () => forbidden.call("dispatch"),
  };
});

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
    realpathSync: (
      path: Parameters<typeof actual.realpathSync>[0],
      ...args: unknown[]
    ): ReturnType<typeof actual.realpathSync> => {
      if (
        String(path)
          .replace(/\\/gu, "/")
          .endsWith("/disappears-after-stat.ts")
      ) {
        const error = new Error(
          "synthetic post-stat disappearance",
        ) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return (
        actual.realpathSync as (
          ...values: unknown[]
        ) => ReturnType<typeof actual.realpathSync>
      )(path, ...args);
    },
    statSync: (
      path: Parameters<typeof actual.statSync>[0],
      ...args: unknown[]
    ): ReturnType<typeof actual.statSync> => {
      if (
        String(path)
          .replace(/\\/gu, "/")
          .endsWith("/disappears-after-lstat.ts")
      ) {
        const error = new Error(
          "synthetic post-lstat disappearance",
        ) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return (
        actual.statSync as (
          ...values: unknown[]
        ) => ReturnType<typeof actual.statSync>
      )(path, ...args);
    },
    readFileSync: (
      path: Parameters<typeof actual.readFileSync>[0],
      ...args: unknown[]
    ): ReturnType<typeof actual.readFileSync> => {
      const normalized = String(path).replace(/\\/gu, "/");
      if (
        normalized.endsWith("/unreadable-baseline.ts") ||
        normalized.endsWith("/disappears-after-realpath.ts")
      ) {
        const disappears = normalized.endsWith(
          "/disappears-after-realpath.ts",
        );
        const error = new Error(
          disappears
            ? "synthetic post-realpath disappearance"
            : "synthetic unreadable baseline",
        ) as NodeJS.ErrnoException;
        error.code = disappears ? "ENOENT" : "EACCES";
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

  it("allows deterministic missing estimates and directories but refuses unsafe or racy baselines", async () => {
    const { sandbox, root } = await makeSandbox();
    await mkdir(join(root, "src", "directory-baseline"), { recursive: true });
    await writeFile(join(root, "src", "directory-baseline", "nested.ts"), "nested", "utf8");
    await writeFile(join(root, "src", "unreadable-baseline.ts"), "secret", "utf8");
    await writeFile(join(root, "src", "disappears-after-lstat.ts"), "race", "utf8");
    await writeFile(join(root, "src", "disappears-after-stat.ts"), "race", "utf8");
    await writeFile(
      join(root, "src", "disappears-after-realpath.ts"),
      "race",
      "utf8",
    );
    const outside = join(sandbox, "outside.ts");
    await writeFile(outside, "outside", "utf8");

    const directory = finding("a", ["src/directory-baseline"]);
    snapshotAffectedFileHashes(root, [directory]);
    requireContract(
      typeof directory.affected_files[0]?.hash_at_plan_time === "string",
      "directory did not acquire trusted baseline hash",
    );

    const cases = [
      { label: "unreadable", path: "src/unreadable-baseline.ts" },
      {
        label: "post-lstat disappearance",
        path: "src/disappears-after-lstat.ts",
      },
      { label: "post-stat disappearance", path: "src/disappears-after-stat.ts" },
      {
        label: "post-realpath disappearance",
        path: "src/disappears-after-realpath.ts",
      },
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

// ───────────────────────────────────────────────────────────────────────────
// The dispatch barrel, pinned by TWO separately-derived assertions.
//
// One comparison cannot do this job. Deriving both sides from the same live
// module reduces the predicate to "keys(actual) ∪ overrides ⊇ keys(actual)",
// which is true for every possible barrel content — removing an export shrinks
// both sides at once and the assertion cannot change value. So the two
// properties are split, and they have different subjects:
//
//   (a) MOCK COVERAGE — run-time-derived, and REQUIRED to be: does the mock's
//       `...actual` spread still cover every key the barrel really exports?
//       This is what catches a mock written as a bare object literal.
//   (b) EXPORT-SET DRIFT — compared against a COMMITTED baseline that does NOT
//       move with its subject. A baseline that re-derives from the thing it
//       guards cannot detect that thing changing, which is the whole defect
//       class this file exists to close.
// ───────────────────────────────────────────────────────────────────────────

describe("the dispatch barrel mock covers the real surface, and the surface itself is pinned", () => {
  it("(a) spreads ...actual over every key the live barrel exports", async () => {
    // `importActual` deliberately, not a plain import: this file MOCKS the
    // barrel, so a normal import here would return the mock and the assertion
    // would compare the mock against itself.
    const live = await vi.importActual<Record<string, unknown>>(
      "../../src/remediate/steps/dispatch/hostHandoff.js",
    );
    const mocked = await import("../../src/remediate/steps/dispatch/hostHandoff.js");

    const blanked = Object.keys(live).filter(
      (key) => (mocked as Record<string, unknown>)[key] === undefined,
    );
    requireContract(
      blanked.length === 0,
      `the barrel mock blanked live exports (no ...actual spread): ${blanked.join(", ")}`,
    );
  });

  it("(b) matches the committed export-set baseline", async () => {
    const live = await vi.importActual<Record<string, unknown>>(
      "../../src/remediate/steps/dispatch/hostHandoff.js",
    );
    requireEqual(
      Object.keys(live).sort(),
      [...DISPATCH_BARREL_EXPORTS].sort(),
      "the dispatch barrel's export set drifted from the baseline committed in this file",
    );
  });
});
