/**
 * P25-a — the submission path is TOOL-OWNED, never host-typed.
 *
 * The measured drift (design record `docs/reviews/p25-design-check-2026-08-12.md`
 * §R2) is not on the host-handoff surface but on the flat `incoming/<filename>.json`
 * directory: the tool prints a filename into a host-facing prompt and then waits
 * for a file at exactly that name. A host that types it wrong — or renders it
 * through its own path handling — produces a submission the gate never sees, and
 * the run silently re-emits.
 *
 * The property this file pins is the one that makes that class impossible:
 *
 *   1. no host-facing prompt or worker packet contains a literal submission
 *      filename or an `incoming/` path;
 *   2. the emitted step's declared write paths are the tool-computed
 *      `submissions/<sha256>.json` names;
 *   3. mechanically, across the whole of `src/`: no `join(..., "incoming", ...)`
 *      construction and no rendered `incoming/` literal survives.
 *
 * (3) is the guard that keeps (1)–(2) from being re-introduced one call site at a
 * time — *durable traps are mechanically enforced, not remembered*.
 *
 * NOTE: the emitted step contract is read as RAW JSON on purpose. `StepArtifactSchema`
 * is `.strict()` while `writeStepContract` injects `agent_id`, so `.parse()`ing the
 * emitted contract fails for reasons that have nothing to do with P25.
 */
import { afterEach, describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireLock,
  absoluteSubmissionPath,
  assertSubmissionRunId,
  mintSubmissionId,
  releaseLock,
  repoRelativePath,
  resolveContainedPath,
  RunLogger,
  submissionPathFor,
} from "audit-tools/shared";
import {
  ingestAuditHostResults,
  prepareAuditHostHandoff,
  type AuditHostTask,
} from "../../src/audit/cli/dispatch/hostHandoff.js";
import { writeFixtureRepo } from "../audit/helpers/fixture.mjs";
import { HEAVY_AUDIT_TEST_TIMEOUT_MS } from "../helpers/heavy-timeout.mjs";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { AuditTask } from "../../src/audit/types.js";

const { cmdNextStep } = await import("../../src/audit/cli/nextStepCommand.js");
const { writeCoreArtifacts } = await import("../../src/audit/io/artifacts.js");
const { buildAdvancedBundle } = await import("../audit/helpers/advancedBundle.mjs");

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Shape of the emitted step contract this test reads (raw JSON, never `.parse()`d). */
interface EmittedStep {
  step_kind: string;
  prompt_path: string;
  artifact_paths: Record<string, string>;
  access?: { read_paths?: string[]; write_paths?: string[] };
}

/** OS-agnostic: step-contract path fields are forward-slashed, disk paths are not. */
function slashed(candidate: string): string {
  return String(candidate).replace(/\\/g, "/");
}

/**
 * Drop comments before scanning source, so the guard is about CODE. Sweeping the
 * ~20 explanatory doc-comments that mention the retired directory is a separate
 * obligation of the same commit; a comment is not a path a host can mistype.
 * Only whole-line `//` comments are stripped, so a `https://` inside a string
 * literal is never mistaken for one.
 */
function stripComments(source: string): string {
  return source
    // Blank a block comment to its own newlines so reported line numbers stay true.
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ""))
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

async function collectTypeScriptSources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Persist a bundle advanced to the design-review phase with the conceptual pass
 * already complete, leaving the SOLO `design_review_contract` branch — the
 * cheapest reachable gate that renders a submission path into a worker packet.
 * (Same fixture shape as `tests/audit/design-review-contract-independence.test.ts`.)
 */
async function persistSoloDesignReviewState(root: string, artifactsDir: string): Promise<void> {
  const bundle: ArtifactBundle = await buildAdvancedBundle(root, "design_review_contract_completed");
  if (!bundle.design_assessment) {
    throw new Error("advanced bundle missing design_assessment");
  }
  bundle.design_assessment = {
    ...bundle.design_assessment,
    conceptual_reviewed: true,
    conceptual_findings: [],
  };
  delete bundle.artifact_metadata;
  await mkdir(artifactsDir, { recursive: true });
  await writeCoreArtifacts(artifactsDir, bundle);
  await writeFile(
    join(artifactsDir, "analyzer-policy.json"),
    JSON.stringify(
      {
        analyzers: { typescript: "skip", python: "skip", html: "skip", css: "skip", sql: "skip" },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

describe("the submission path is tool-owned", () => {
  it(
    "a driven design-review emission renders no submission filename into any host-facing prompt",
    { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS },
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "p25-submission-path-"));
      const root = join(tempDir, "repo");
      const artifactsDir = join(root, ".audit-tools/audit");
      try {
        await writeFixtureRepo(root);
        await persistSoloDesignReviewState(root, artifactsDir);

        await cmdNextStep(["--root", root]);
        const step: EmittedStep = JSON.parse(
          await readFile(join(artifactsDir, "steps", "current-step.json"), "utf8"),
        );
        expect(step.step_kind).toBe("design_review_contract");

        const packetPath = step.artifact_paths.contract_prompt;
        expect(packetPath, "the solo contract pass must still emit a worker packet").toBeTruthy();
        const packetText = await readFile(packetPath, "utf8");
        const hostPromptText = await readFile(step.prompt_path, "utf8");

        for (const [label, text] of [
          ["worker packet", packetText],
          ["host step prompt", hostPromptText],
        ] as const) {
          expect(
            text,
            `${label} must not name a host-typed submission file — the path is tool-owned`,
          ).not.toContain("design-review-contract-findings.json");
          expect(
            text,
            `${label} must not render an incoming/ path`,
          ).not.toContain("incoming");
        }

        const writePaths = (step.access?.write_paths ?? []).map(slashed);
        expect(writePaths.length, "the step must still declare its writable paths").toBeGreaterThan(
          0,
        );
        for (const writePath of writePaths) {
          expect(
            writePath,
            "every declared submission path is the tool-computed submissions/<sha256>.json name",
          ).toMatch(/\/submissions\/[0-9a-f]{64}\.json$/);
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  );

  it("no source file constructs or renders a host-typed incoming/ path", async () => {
    const sources = await collectTypeScriptSources(join(repoRoot, "src"));
    expect(sources.length, "the src/ scan must actually reach files").toBeGreaterThan(50);

    const violations: string[] = [];
    for (const file of sources) {
      const code = stripComments(await readFile(file, "utf8"));
      code.split(/\r?\n/).forEach((line, index) => {
        // Two forms, both host-facing: the directory constructed as a path
        // segment (`join(artifactsDir, "incoming", …)`) and the literal
        // rendered into a prompt/packet body (`incoming/<name>.json`).
        if (/["'`]incoming["'`]/.test(line) || /incoming\//.test(line)) {
          violations.push(
            `${slashed(file.slice(repoRoot.length))}:${index + 1}: ${line.trim()}`,
          );
        }
      });
    }
    expect(
      violations,
      "the retired incoming/ directory must survive nowhere in src/ — not as a join() segment, not as a rendered literal",
    ).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The host-handoff ingestion substrate: path containment, the one filename
// rule, the run-id grammar, and the accepted-results ledger's serialization.
//
// These live beside the P25 guard above because they pin the SAME module —
// src/shared/submission/submissionIdentity.ts is the one rule both draws bind
// to, and the audit accepted-results ledger is the substrate that consumes it.
// Every property below held (or failed) entirely unpinned: no test in tests/
// referenced resolveContainedPath at all, so deleting its throw left the suite
// green while eight call sites across both host handoffs silently widened
// their write scope.
// ───────────────────────────────────────────────────────────────────────────

const substrateRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    substrateRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  substrateRoots.push(root);
  return root;
}

const AUDIT_RUN_ID = "audit-substrate-run";
const AUDITED_FILE = "src/a.ts";
const AUDITED_LINES = 3;

function auditTask(taskId: string): AuditHostTask {
  return {
    task_id: taskId,
    unit_id: `${taskId}-unit`,
    pass_id: "pass-1",
    lens: "correctness",
    file_paths: [AUDITED_FILE],
    file_line_counts: { [AUDITED_FILE]: AUDITED_LINES },
    rationale: `review ${AUDITED_FILE}`,
    priority: "high",
    complexity: "low",
    risk: "low",
    token_estimate: 1_000,
  };
}

interface AuditFixture {
  readonly root: string;
  readonly artifactsDir: string;
  readonly runDir: string;
  readonly lockPath: string;
  readonly ledgerPath: string;
  readonly acceptedPath: string;
  readonly items: readonly {
    readonly id: string;
    readonly prompt: { readonly sha256: string };
    readonly result_path: string;
  }[];
}

async function auditFixture(taskIds: readonly string[] = ["T1"]): Promise<AuditFixture> {
  const root = await tempRoot("audit-host-substrate-");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, AUDITED_FILE), "const a = 1;\nconst b = 2;\nexport { a, b };\n", "utf8");
  const artifactsDir = join(root, ".audit-tools", "audit");
  const prepared = await prepareAuditHostHandoff({
    root,
    artifactsDir,
    runId: AUDIT_RUN_ID,
    tasks: taskIds.map(auditTask),
  });
  const runDir = join(artifactsDir, "runs", AUDIT_RUN_ID);
  return {
    root,
    artifactsDir,
    runDir,
    lockPath: join(runDir, "host-accepted-results.lock"),
    ledgerPath: join(runDir, "host-accepted-results-ledger.json"),
    acceptedPath: join(runDir, "host-accepted-results.json"),
    items: prepared.workload.work_items.map((item) => ({
      id: item.id,
      prompt: { sha256: item.prompt.sha256 },
      result_path: item.result_path,
    })),
  };
}

/**
 * The AUDIT-SIDE manifest for {@link ingestAuditHostResults}: the same identity
 * fields `auditTask` publishes through prepare, shaped as the `AuditTask` the
 * per-result validator joins on.
 */
function auditManifest(taskIds: readonly string[]): AuditTask[] {
  return taskIds.map((taskId) => ({
    task_id: taskId,
    unit_id: `${taskId}-unit`,
    pass_id: "pass-1",
    lens: "correctness",
    file_paths: [AUDITED_FILE],
    rationale: `review ${AUDITED_FILE}`,
  }));
}

function auditSubmission(
  item: AuditFixture["items"][number],
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    contract_version: "audit-host-result/v1alpha1",
    result_id: `result-${item.id}`,
    run_id: AUDIT_RUN_ID,
    work_item_id: item.id,
    prompt_sha256: item.prompt.sha256,
    file_coverage: [
      { path: AUDITED_FILE, reviewed_lines: AUDITED_LINES, total_lines: AUDITED_LINES },
    ],
    findings: [],
    ...overrides,
  };
}

async function submitRaw(
  fixture: AuditFixture,
  item: AuditFixture["items"][number],
  bytes: string,
): Promise<void> {
  const path = resolve(fixture.root, item.result_path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, "utf8");
}

async function submit(
  fixture: AuditFixture,
  item: AuditFixture["items"][number],
  payload: unknown,
): Promise<void> {
  await submitRaw(fixture, item, JSON.stringify(payload));
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve_) => setTimeout(resolve_, ms));

describe("path containment is the tool's, not the caller's", () => {
  it("resolves a contained candidate and forward-slashes its repo-relative form", async () => {
    const root = await tempRoot("containment-");
    const contained = resolveContainedPath(root, "runs/RUN-1/host-results", "label");
    expect(isAbsolute(contained)).toBe(true);
    expect(contained).toBe(resolve(root, "runs/RUN-1/host-results"));
    // Identical on win32 and posix: the relative form is always forward-slashed.
    expect(repoRelativePath(root, contained, "label")).toBe("runs/RUN-1/host-results");
  });

  it("accepts the legal near-miss '..foo' as an ordinary segment", async () => {
    const root = await tempRoot("containment-near-miss-");
    // The guard tests the first path SEGMENT, not a bare '..' substring — a
    // substring test would refuse a legitimately-named directory.
    expect(resolveContainedPath(root, "..foo", "label")).toBe(resolve(root, "..foo"));
    expect(repoRelativePath(root, resolve(root, "..foo"), "label")).toBe("..foo");
  });

  it("throws on every escape rather than returning a value", async () => {
    const root = await tempRoot("containment-escape-");
    const absoluteBase = resolve(root);
    const foreignRoot = resolve(root, "..", "somewhere-else");
    for (const candidate of ["../x", "a/../../x", foreignRoot]) {
      expect(
        () => resolveContainedPath(root, candidate, "label"),
        `${candidate} must be refused, never resolved`,
      ).toThrow(`label must remain beneath ${absoluteBase}`);
    }
  });

  it("propagates the containment refusal through the audit prepare AND ingest callers", async () => {
    // The escape target sits under a CLEANED parent, not in the shared tmpdir:
    // a guessable `<tmpdir>/escaped-artifacts` survives any run that (by
    // mutation or by regression) actually performs the escape, and every later
    // run then reads that debris as its own.
    const parent = await tempRoot("containment-callers-");
    const root = join(parent, "repo");
    await mkdir(root, { recursive: true });
    const escaping = join(parent, "escaped-artifacts");
    await expect(
      prepareAuditHostHandoff({
        root,
        artifactsDir: escaping,
        runId: AUDIT_RUN_ID,
        tasks: [auditTask("T1")],
      }),
    ).rejects.toThrow(/artifactsDir must remain beneath/u);
    await expect(
      ingestAuditHostResults({ root, artifactsDir: escaping, runId: AUDIT_RUN_ID, auditTasks: auditManifest(["T1"]) }),
    ).rejects.toThrow(/artifactsDir must remain beneath/u);
    // The refusal fires BEFORE any filesystem effect: nothing was created.
    expect(existsSync(escaping)).toBe(false);
  });

  it("refuses a result path that is not the one the shared rule derives", async () => {
    // The escaping result_path an attacker would write is unreachable for a
    // second reason, and it is worth pinning that it is: every bound path is
    // RE-DERIVED at ingest and compared, so a substituted one is refused by
    // identity before containment ever has to catch it.
    const fixture = await auditFixture(["T1"]);
    const mapPath = join(fixture.runDir, "host-result-map.json");
    const map = JSON.parse(await readFile(mapPath, "utf8")) as {
      entries: { result_path: string }[];
    };
    map.entries[0]!.result_path = "../escaped.json";
    await writeFile(mapPath, JSON.stringify(map), "utf8");
    await expect(
      ingestAuditHostResults({
        root: fixture.root,
        artifactsDir: fixture.artifactsDir,
        runId: AUDIT_RUN_ID,
      auditTasks: auditManifest(fixture.items.map((item) => item.id)),
      }),
    ).rejects.toThrow(/Invalid audit host result binding/u);
  });
});

describe("the one filename rule and the run-id grammar", () => {
  it("derives one path from the id, on both the absolute and the bound form", async () => {
    const root = await tempRoot("filename-rule-");
    const submissionDir = join(root, "runs", "R", "host-results");
    const id = "some-work-item";
    const absolute = absoluteSubmissionPath({ root, submissionDir }, id);
    expect(basename(absolute)).toBe(`${sha256(id)}.json`);
    expect(dirname(absolute)).toBe(resolve(submissionDir));
    expect(submissionPathFor({ root, submissionDir }, id)).toBe(
      repoRelativePath(root, absolute, "bound"),
    );
  });

  it("mints a deterministic id so a re-emitted step re-declares the same bound path", () => {
    const parts = { kind: "review", lane: "lane-a", runId: "RUN-1" };
    expect(mintSubmissionId(parts)).toBe(mintSubmissionId({ ...parts }));
    expect(mintSubmissionId(parts)).not.toBe(
      mintSubmissionId({ ...parts, lane: "lane-b" }),
    );
  });

  it("refuses an empty or non-string submission id instead of defaulting", async () => {
    const root = await tempRoot("filename-empty-id-");
    const paths = { root, submissionDir: join(root, "s") };
    expect(() => absoluteSubmissionPath(paths, "")).toThrow(
      "submission id must be a non-empty string",
    );
    expect(() =>
      absoluteSubmissionPath(paths, undefined as unknown as string),
    ).toThrow("submission id must be a non-empty string");
  });

  it("keeps a traversal-shaped submission id inside the submission directory, with no write", async () => {
    const root = await tempRoot("filename-traversal-");
    const submissionDir = join(root, "runs", "R", "host-results");
    await mkdir(submissionDir, { recursive: true });
    const landing = absoluteSubmissionPath({ root, submissionDir }, "../../x");
    expect(dirname(landing)).toBe(resolve(submissionDir));
    expect(basename(landing)).toBe(`${sha256("../../x")}.json`);
    // The refusal (or, here, the containment) fires before anything lands.
    expect(await readdir(submissionDir)).toEqual([]);
  });

  it("refuses every run id that could become a climbing directory segment", () => {
    assertSubmissionRunId("run-2026.08.20_1");
    for (const runId of ["..", ".", "a/b", "a\\b", "", "x".repeat(129)]) {
      expect(
        () => assertSubmissionRunId(runId, "audit host run id"),
        `${JSON.stringify(runId)} must never become a directory segment`,
      ).toThrow(`Invalid audit host run id: ${JSON.stringify(runId)}`);
    }
  });

  it("enforces the run-id grammar before any path is built, on prepare and on ingest", async () => {
    const root = await tempRoot("run-id-grammar-");
    const artifactsDir = join(root, ".audit-tools", "audit");
    for (const runId of ["..", "a/b", ""]) {
      await expect(
        prepareAuditHostHandoff({ root, artifactsDir, runId, tasks: [auditTask("T1")] }),
      ).rejects.toThrow(/Invalid audit host run id/u);
      await expect(
        ingestAuditHostResults({ root, artifactsDir, runId, auditTasks: auditManifest(["T1"]) }),
      ).rejects.toThrow(/Invalid audit host run id/u);
    }
    // No run directory — not even the artifacts dir — was created on the way out.
    expect(existsSync(artifactsDir)).toBe(false);
  });
});

describe("the audit accepted-results ledger", () => {
  it("accepts a bound submission and records it in both ledger files", async () => {
    const fixture = await auditFixture(["T1"]);
    const item = fixture.items[0]!;
    await submit(fixture, item, auditSubmission(item));

    const summary = await ingestAuditHostResults({
      root: fixture.root,
      artifactsDir: fixture.artifactsDir,
      runId: AUDIT_RUN_ID,
    auditTasks: auditManifest(fixture.items.map((item) => item.id)),
      });
    expect(summary.accepted_count).toBe(1);
    expect(summary.issues).toEqual([]);
    expect(summary.completed_work_item_ids).toEqual([item.id]);
    const ledger = JSON.parse(await readFile(fixture.ledgerPath, "utf8")) as {
      entries: { work_item_id: string }[];
    };
    expect(ledger.entries.map((entry) => entry.work_item_id)).toEqual([item.id]);
    expect(
      (JSON.parse(await readFile(fixture.acceptedPath, "utf8")) as unknown[]).length,
    ).toBe(1);
  });

  it("is idempotent: a re-ingest accepts nothing new and leaves the ledger byte-identical", async () => {
    const fixture = await auditFixture(["T1"]);
    const item = fixture.items[0]!;
    await submit(fixture, item, auditSubmission(item));
    await ingestAuditHostResults({
      root: fixture.root,
      artifactsDir: fixture.artifactsDir,
      runId: AUDIT_RUN_ID,
    auditTasks: auditManifest(fixture.items.map((item) => item.id)),
      });
    const first = await readFile(fixture.ledgerPath, "utf8");

    const second = await ingestAuditHostResults({
      root: fixture.root,
      artifactsDir: fixture.artifactsDir,
      runId: AUDIT_RUN_ID,
    auditTasks: auditManifest(fixture.items.map((item) => item.id)),
      });
    expect(second.accepted_count).toBe(0);
    // Accepted-count 0 is not "nothing is done" — the completed set persists.
    expect(second.completed_work_item_ids).toEqual([item.id]);
    expect(second.accepted_results.length).toBe(1);
    expect(await readFile(fixture.ledgerPath, "utf8")).toBe(first);
  });

  it("re-filters an already-satisfied lane out of the next prepared workload", async () => {
    const fixture = await auditFixture(["T1", "T2"]);
    const first = fixture.items[0]!;
    await submit(fixture, first, auditSubmission(first));
    await ingestAuditHostResults({
      root: fixture.root,
      artifactsDir: fixture.artifactsDir,
      runId: AUDIT_RUN_ID,
    auditTasks: auditManifest(fixture.items.map((item) => item.id)),
      });

    const next = await prepareAuditHostHandoff({
      root: fixture.root,
      artifactsDir: fixture.artifactsDir,
      runId: AUDIT_RUN_ID,
      tasks: ["T1", "T2"].map(auditTask),
    });
    expect(next.workload.work_items.map((item) => item.id)).toEqual(["T2"]);
  });

  it("classifies and locates every refusal separately", async () => {
    const fixture = await auditFixture(["T1", "T2"]);
    const [first, second] = fixture.items;
    await submitRaw(fixture, second!, "{ not json");

    const summary = await ingestAuditHostResults({
      root: fixture.root,
      artifactsDir: fixture.artifactsDir,
      runId: AUDIT_RUN_ID,
    auditTasks: auditManifest(fixture.items.map((item) => item.id)),
      });
    expect(summary.accepted_count).toBe(0);
    expect(summary.issues.length).toBe(2);
    expect([...summary.issues].map((issue) => issue.code).sort()).toEqual([
      "submission_malformed",
      "submission_missing",
    ]);
    for (const issue of summary.issues) {
      expect(issue.work_item_id, "every refusal names the work item").toBeTruthy();
      expect(issue.result_path, "every refusal names the bound path it read").toBeTruthy();
    }

    // A contract refusal opens with the category that ACTUALLY failed and must
    // not enumerate the ones the submission satisfied — the drift that sent a
    // host to re-check three correct things for a whole lap.
    await submit(
      fixture,
      first!,
      auditSubmission(first!, { file_coverage: [{ path: AUDITED_FILE, reviewed_lines: 1, total_lines: 1 }] }),
    );
    const coverage = await ingestAuditHostResults({
      root: fixture.root,
      artifactsDir: fixture.artifactsDir,
      runId: AUDIT_RUN_ID,
    auditTasks: auditManifest(fixture.items.map((item) => item.id)),
      });
    const invalid = coverage.issues.find(
      (issue) => issue.code === "submission_contract_invalid",
    );
    expect(invalid).toBeDefined();
    expect(invalid!.message).toMatch(/file coverage/u);
    expect(invalid!.message).not.toMatch(/prompt binding|identity binding/u);
  });

  it("refuses a second submission that reuses an accepted result id", async () => {
    const fixture = await auditFixture(["T1", "T2"]);
    const [first, second] = fixture.items;
    await submit(fixture, first!, auditSubmission(first!));
    await submit(
      fixture,
      second!,
      auditSubmission(second!, { result_id: `result-${first!.id}` }),
    );

    const summary = await ingestAuditHostResults({
      root: fixture.root,
      artifactsDir: fixture.artifactsDir,
      runId: AUDIT_RUN_ID,
    auditTasks: auditManifest(fixture.items.map((item) => item.id)),
      });
    expect(summary.accepted_count).toBe(1);
    expect(summary.issues.map((issue) => issue.code)).toEqual(["duplicate_submission_id"]);
    expect(summary.completed_work_item_ids).toEqual([first!.id]);
  });

  it("refuses a submission that supplies the tool-computed grounding field", async () => {
    const fixture = await auditFixture(["T1"]);
    const item = fixture.items[0]!;
    await submit(
      fixture,
      item,
      auditSubmission(item, {
        findings: [
          {
            id: "F-1",
            title: "A finding",
            category: "correctness",
            severity: "high",
            confidence: "high",
            lens: "correctness",
            summary: "Something is wrong.",
            affected_files: [{ path: AUDITED_FILE }],
            evidence: [`${AUDITED_FILE}:1`],
            grounding: { status: "grounded" },
          },
        ],
      }),
    );

    const summary = await ingestAuditHostResults({
      root: fixture.root,
      artifactsDir: fixture.artifactsDir,
      runId: AUDIT_RUN_ID,
    auditTasks: auditManifest(fixture.items.map((item) => item.id)),
      });
    expect(summary.accepted_count).toBe(0);
    const issue = summary.issues[0];
    expect(issue?.code).toBe("submission_contract_invalid");
    expect(issue?.message).toContain(
      "findings[0].grounding: grounding is tool-computed at ingest and must not be supplied",
    );
  });

  it("serializes the ledger read-modify-write: BOTH ingest and prepare wait on the one lock", async () => {
    const fixture = await auditFixture(["T1"]);
    const item = fixture.items[0]!;
    await submit(fixture, item, auditSubmission(item));

    for (const start of [
      () =>
        ingestAuditHostResults({
          root: fixture.root,
          artifactsDir: fixture.artifactsDir,
          runId: AUDIT_RUN_ID,
        auditTasks: auditManifest(fixture.items.map((item) => item.id)),
      }),
      () =>
        prepareAuditHostHandoff({
          root: fixture.root,
          artifactsDir: fixture.artifactsDir,
          runId: AUDIT_RUN_ID,
          tasks: [auditTask("T1")],
        }),
    ]) {
      const token = await acquireLock(fixture.lockPath);
      let settled = false;
      const running = start().then((value) => {
        settled = true;
        return value;
      });
      await delay(250);
      // The whole read-modify-write is inside the lock, so neither writer can
      // reach its snapshot while another holds it. Unserialized, both would run
      // straight through and the later atomic replace would silently drop the
      // earlier writer's additions.
      expect(settled, "the ledger writer must block on the shared lock").toBe(false);
      await releaseLock(fixture.lockPath, token);
      await running;
      expect(settled).toBe(true);
    }

    // Whichever order they ran in, the accepted entry survived both writers.
    const ledger = JSON.parse(await readFile(fixture.ledgerPath, "utf8")) as {
      entries: { work_item_id: string }[];
    };
    expect(ledger.entries.map((entry) => entry.work_item_id)).toEqual([item.id]);
  });

  it("threads the caller's RunLogger into the lock substrate", async () => {
    const fixture = await auditFixture(["T1"]);
    const logPath = join(fixture.root, "run.log.jsonl");
    const logger = new RunLogger(logPath);
    // A lock left behind by a dead holder, older than the stale window: the
    // substrate reclaims it and REPORTS the reclaim — an event that vanished
    // entirely while no logger was threaded through.
    await mkdir(dirname(fixture.lockPath), { recursive: true });
    await writeFile(fixture.lockPath, "abandoned-owner-token", "utf8");
    const stale = new Date(Date.now() - 120_000);
    await utimes(fixture.lockPath, stale, stale);

    await prepareAuditHostHandoff({
      root: fixture.root,
      artifactsDir: fixture.artifactsDir,
      runId: AUDIT_RUN_ID,
      tasks: [auditTask("T1")],
      logger,
    });

    const events = (await readFile(logPath, "utf8"))
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { note?: string });
    expect(events.map((event) => event.note)).toContain("stale_lock_removed");
  });

  it("throws, never returns a success shape, on a structural or identity violation", async () => {
    const root = await tempRoot("audit-structural-");
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, AUDITED_FILE), "a\nb\nc\n", "utf8");

    await expect(
      prepareAuditHostHandoff({
        root,
        artifactsDir,
        runId: AUDIT_RUN_ID,
        tasks: [auditTask("T1"), auditTask("T1")],
      }),
    ).rejects.toThrow("Duplicate audit host task id: T1");

    await expect(
      prepareAuditHostHandoff({
        root,
        artifactsDir,
        runId: AUDIT_RUN_ID,
        tasks: [{ ...auditTask("T1"), file_line_counts: {} }],
      }),
    ).rejects.toThrow(`T1 is missing the line count for ${AUDITED_FILE}`);

    // A malformed result map propagates rather than degrading to an empty map.
    const fixture = await auditFixture(["T1"]);
    await writeFile(join(fixture.runDir, "host-result-map.json"), "{}", "utf8");
    await expect(
      ingestAuditHostResults({
        root: fixture.root,
        artifactsDir: fixture.artifactsDir,
        runId: AUDIT_RUN_ID,
      auditTasks: auditManifest(fixture.items.map((item) => item.id)),
      }),
    ).rejects.toThrow("Invalid audit host result map");
  });
});
