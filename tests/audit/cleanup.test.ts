import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { join, dirname, parse } from "node:path";
import {
  AUDIT_FINDINGS_FILENAME,
  AUDIT_REPORT_FILENAME,
  REMEDIATION_OUTCOMES_FILENAME,
  REMEDIATION_REPORT_FILENAME,
  auditArtifactsDir,
  auditFindingsPath,
  auditReportPath,
  promotedAuditFindingsPath,
  promotedAuditReportPath,
} from "audit-tools/shared";
import { fileURLToPath } from "node:url";
import { captureConsole } from "./helpers/captureConsole.mjs";
import { withTempDir } from "./helpers/withTempDir.mjs";
import { withTempRepo } from "./helpers/next-step-harness.js";
import { runWrapper } from "./helpers/run-wrapper.mjs";
import { HEAVY_AUDIT_TEST_TIMEOUT_MS } from "../helpers/heavy-timeout.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

const { cleanupStaleArtifactsDir } = await import("../../src/audit/cli/cleanup.js");
const { cmdCleanup, validateCleanupTarget } = await import(
  "../../src/audit/cli/cleanupCommand.js"
);

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const s = await stat(dirPath);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const s = await stat(filePath);
    return s.isFile();
  } catch {
    return false;
  }
}

/** Bytes a completed run rendered in place; its promoted copies must equal them. */
const RENDER = "# Audit report\n\n## Work blocks\n\n- Done\n";
const FINDINGS = JSON.stringify({ schema_version: "audit-findings/v1alpha1", work_blocks: [] }) + "\n";

async function writeState(artifactsDir: string, status: string): Promise<void> {
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(join(artifactsDir, "audit_state.json"), JSON.stringify({ status }));
}

/** A complete run's in-place deliverables: the render and the machine contract. */
async function plantInPlaceDeliverables(artifactsDir: string): Promise<void> {
  await writeFile(auditReportPath(artifactsDir), RENDER);
  await writeFile(auditFindingsPath(artifactsDir), FINDINGS);
}

/** Promoted copies one level up — byte-identical unless a variant asks otherwise. */
async function plantPromotedCopies(
  artifactsDir: string,
  variant: { report?: string; findings?: boolean } = {},
): Promise<void> {
  await writeFile(promotedAuditReportPath(artifactsDir), variant.report ?? RENDER);
  if (variant.findings !== false) {
    await writeFile(promotedAuditFindingsPath(artifactsDir), FINDINGS);
  }
}

/** A complete run whose completion transition has nothing left to do. */
async function plantFullyPromotedCompleteRun(artifactsDir: string): Promise<void> {
  await writeState(artifactsDir, "complete");
  await plantInPlaceDeliverables(artifactsDir);
  await plantPromotedCopies(artifactsDir);
}

/**
 * The four promoted final reports, one level above the working artifacts dir.
 * The deletion contract says no cleanup path touches them.
 */
const PROMOTED_FINAL_REPORTS = [
  AUDIT_FINDINGS_FILENAME,
  AUDIT_REPORT_FILENAME,
  REMEDIATION_OUTCOMES_FILENAME,
  REMEDIATION_REPORT_FILENAME,
] as const;

test("cleanupStaleArtifactsDir preserves artifacts directory when status is active", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify({ status: "active" }),
    );

    await cleanupStaleArtifactsDir(artifactsDir);

    expect(await dirExists(artifactsDir), "directory should still exist for active status").toBeTruthy();
  });
});

test("cleanupStaleArtifactsDir preserves artifacts directory when status is blocked", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify({ status: "blocked" }),
    );

    await cleanupStaleArtifactsDir(artifactsDir);

    expect(await dirExists(artifactsDir), "directory should still exist for blocked status").toBeTruthy();
  });
});

test("cleanupStaleArtifactsDir re-throws on malformed audit_state.json", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(artifactsDir, "audit_state.json"), "not json");

    await assert.rejects(
      () => cleanupStaleArtifactsDir(artifactsDir),
      "should throw on malformed JSON",
    );

    expect(await dirExists(artifactsDir), "directory should still exist after rejection").toBeTruthy();
  });
});

test("cleanupStaleArtifactsDir returns silently when audit_state.json is absent", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    // No audit_state.json written

    await assert.doesNotReject(
      () => cleanupStaleArtifactsDir(artifactsDir),
      "should resolve without throwing when audit_state.json is missing",
    );

    expect(await dirExists(artifactsDir), "directory should still exist (nothing deleted)").toBeTruthy();
  });
});

test("cleanupStaleArtifactsDir removes artifacts directory when status is complete and fully promoted", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await plantFullyPromotedCompleteRun(artifactsDir);

    await cleanupStaleArtifactsDir(artifactsDir);

    expect(!(await dirExists(artifactsDir)), "directory should be removed for a fully promoted complete run").toBeTruthy();
  });
});

test("cleanupStaleArtifactsDir removes artifacts directory when status is not_started", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify({ status: "not_started" }),
    );

    await cleanupStaleArtifactsDir(artifactsDir);

    expect(!(await dirExists(artifactsDir)), "directory should be removed for not_started status").toBeTruthy();
  });
});

// ── Structured return value tests ─────────────────────────────────────────────

test("cleanupStaleArtifactsDir: deletes when status is complete and fully promoted (no options)", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await plantFullyPromotedCompleteRun(artifactsDir);

    const result = await cleanupStaleArtifactsDir(artifactsDir);

    expect(result.action).toBe("deleted");
    expect(result.status).toBe("complete");
    expect(!(await dirExists(artifactsDir)), "directory should be removed").toBeTruthy();
  });
});

test("cleanupStaleArtifactsDir: deletes when status is not_started (no options)", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify({ status: "not_started" }),
    );

    const result = await cleanupStaleArtifactsDir(artifactsDir);

    expect(result.action).toBe("deleted");
    expect(result.status).toBe("not_started");
    expect(!(await dirExists(artifactsDir)), "directory should be removed").toBeTruthy();
  });
});

test("cleanupStaleArtifactsDir: skips deletion when status is active and force is false", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify({ status: "active" }),
    );

    const result = await cleanupStaleArtifactsDir(artifactsDir);

    expect(result.action).toBe("skipped");
    expect(result.status).toBe("active");
    if (typeof result.reason !== "string") {
      throw new Error("Expected skipped cleanup to include a reason");
    }
    expect(typeof result.reason === "string", "reason should be a string").toBeTruthy();
    expect(result.reason.includes("active"), "reason should mention 'active'").toBeTruthy();
    expect(result.reason.includes("resumed") || result.reason.includes("resume"), "reason should mention resumption").toBeTruthy();
    expect(await dirExists(artifactsDir), "directory should still exist").toBeTruthy();
  });
});

test("cleanupStaleArtifactsDir: deletes when status is active and force is true", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify({ status: "active" }),
    );

    const result = await cleanupStaleArtifactsDir(artifactsDir, { force: true });

    expect(result.action).toBe("deleted");
    expect(result.status).toBe("active");
    expect(!(await dirExists(artifactsDir)), "directory should be removed despite active status").toBeTruthy();
  });
});

test("cleanupStaleArtifactsDir: dry-run skips rm but returns dry-run action", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await plantFullyPromotedCompleteRun(artifactsDir);

    const result = await cleanupStaleArtifactsDir(artifactsDir, { dryRun: true });

    expect(result.action).toBe("dry-run");
    expect(result.status).toBe("complete");
    expect(await dirExists(artifactsDir), "directory should still exist in dry-run mode").toBeTruthy();
  });
});

test("cleanupStaleArtifactsDir: skips silently when audit_state.json is missing (no options)", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    // No audit_state.json written

    const result = await cleanupStaleArtifactsDir(artifactsDir);

    expect(result.action).toBe("skipped");
    expect(result.status).toBe("unknown");
    expect(await dirExists(artifactsDir), "directory should still exist").toBeTruthy();
  });
});

test("cleanupStaleArtifactsDir: force=true deletes even when state file is missing", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    // No audit_state.json written

    const result = await cleanupStaleArtifactsDir(artifactsDir, { force: true });

    expect(result.action).toBe("deleted");
    expect(result.status).toBe("unknown");
    expect(!(await dirExists(artifactsDir)), "directory should be removed when force=true and state file is missing").toBeTruthy();
  });
});

// ── cmdCleanup (CLI wiring) tests ─────────────────────────────────────────────
// FND-TST-49494736: cleanupCommand.ts CLI wiring — exitCode, stdout JSON shape,
// force/dryRun flag paths, unknown-status path.

async function runCleanup(artifactsDir: string, extraFlags: string[] = []) {
  const argv = [
    process.execPath,
    join(repoRoot, "src", "cli.ts"),
    "--artifacts-dir",
    artifactsDir,
    ...extraFlags,
  ];
  return captureConsole(() => cmdCleanup(argv));
}

test("cmdCleanup: active status — exitCode=1, JSON action=skipped with reason", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify({ status: "active" }),
    );

    const { code, stdout } = await runCleanup(artifactsDir);

    expect(code, "exitCode should be 1 when action is skipped").toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.action).toBe("skipped");
    expect(parsed.artifacts_dir).toBe(artifactsDir);
    expect(typeof parsed.reason === "string" && parsed.reason.length > 0, "reason should be a non-empty string").toBeTruthy();
    expect(await dirExists(artifactsDir), "directory should still exist").toBeTruthy();
  });
});

test("cmdCleanup: fully promoted complete status — exitCode=0, JSON action=deleted", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await plantFullyPromotedCompleteRun(artifactsDir);

    const { code, stdout } = await runCleanup(artifactsDir);

    expect(code, "exitCode should be 0 when action is deleted").toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.action).toBe("deleted");
    expect(parsed.status).toBe("complete");
    expect(!(await dirExists(artifactsDir)), "directory should be removed").toBeTruthy();
  });
});

test("cmdCleanup: missing state file (no flags) — exitCode=1, JSON action=skipped, reason mentions --force", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    // No audit_state.json

    const { code, stdout } = await runCleanup(artifactsDir);

    expect(code, "exitCode should be 1 when action is skipped").toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.action).toBe("skipped");
    expect(typeof parsed.reason === "string", "reason should be a string").toBeTruthy();
    expect(parsed.reason.includes("--force") || parsed.reason.includes("force"), "reason should mention --force").toBeTruthy();
    expect(await dirExists(artifactsDir), "directory should still exist").toBeTruthy();
  });
});

test("cmdCleanup: --force flag deletes active-status artifacts, exitCode=0", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify({ status: "active" }),
    );

    const { code, stdout } = await runCleanup(artifactsDir, ["--force"]);

    expect(code, "exitCode should be 0 when force-deleted").toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.action).toBe("deleted");
    expect(parsed.status).toBe("active");
    expect(!(await dirExists(artifactsDir)), "directory should be removed with --force").toBeTruthy();
  });
});

test("cmdCleanup: --dry-run flag returns dry-run action without deleting, exitCode=0", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await plantFullyPromotedCompleteRun(artifactsDir);

    const { code, stdout } = await runCleanup(artifactsDir, ["--dry-run"]);

    expect(code, "exitCode should be 0 for dry-run").toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.action).toBe("dry-run");
    expect(parsed.dry_run).toBe(true);
    expect(await dirExists(artifactsDir), "directory should still exist after dry-run").toBeTruthy();
  });
});

test("cmdCleanup: stdout is always valid JSON", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });

    const { stdout } = await runCleanup(artifactsDir);

    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      assert.fail(`cmdCleanup stdout is not valid JSON: ${stdout}`);
    }
    expect(typeof parsed.action === "string", "action should be a string").toBeTruthy();
    expect(typeof parsed.artifacts_dir === "string", "artifacts_dir should be a string").toBeTruthy();
  });
});

// ── validateCleanupTarget (CP-NODE-16) ────────────────────────────────────────
// The cleanup verb recursively deletes. Before ANY delete path — --force or not
// — it must prove the target IS an audit artifacts dir: `<X>/.audit-tools/audit`,
// never a filesystem root (fail-1), never a wrong-shaped path (fail-2). `--force`
// additionally requires the audit_state.json marker on disk (fail-3): force
// waives the status evidence, never the identity evidence.

test("validateCleanupTarget accepts a well-formed artifacts dir path", () => {
  const { ok } = validateCleanupTarget(auditArtifactsDir("/repo"));
  expect(ok).toBe(true);
});

test("validateCleanupTarget refuses a filesystem root", () => {
  for (const root of [parse(process.cwd()).root, "/"]) {
    const v = validateCleanupTarget(root);
    expect(v.ok, `root ${root} must be refused`).toBe(false);
    if (!v.ok) {
      expect(v.reason.includes("filesystem root"), "reason names the root").toBe(true);
    }
  }
});

test.each([".", "..", "/tmp", "/var/log", "C:\\Windows"])(
  "validateCleanupTarget refuses wrong-shape target %s",
  (target) => {
    const v = validateCleanupTarget(target);
    expect(v.ok, `${target} is not <X>/.audit-tools/audit`).toBe(false);
    if (!v.ok) {
      expect(v.reason.includes(".audit-tools/audit"), "reason names the required shape").toBe(true);
    }
  },
);

test("cmdCleanup: --force without marker refused — exitCode=1, action=refused, dir intact", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    // No audit_state.json written.

    const { code, stdout } = await runCleanup(artifactsDir, ["--force"]);

    expect(code, "--force without the marker must be refused").toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.action).toBe("refused");
    expect(parsed.artifacts_dir).toBe(artifactsDir);
    expect(parsed.reason.includes("audit_state.json"), "reason names the missing marker").toBe(true);
    expect(await dirExists(artifactsDir), "the directory must survive the refusal").toBeTruthy();
  });
});

test("cmdCleanup: --force with marker on a valid shape still deletes, exitCode=0", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify({ status: "active" }),
    );

    const { code, stdout } = await runCleanup(artifactsDir, ["--force"]);

    expect(code, "force-delete of a proven artifacts dir succeeds").toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.action).toBe("deleted");
    expect(!(await dirExists(artifactsDir)), "directory should be removed").toBeTruthy();
  });
});

test("cmdCleanup: structural refusal fires even with --force and --dry-run", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const broadDir = join(tempDir, "not-audit");
    await mkdir(broadDir, { recursive: true });

    const { code, stdout } = await runCleanup(broadDir, ["--force"]);

    expect(code, "a wrong-shape target is refused regardless of --force").toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.action).toBe("refused");
    expect(await dirExists(broadDir), "the non-audit dir must survive").toBeTruthy();
  });
});

// ── One eligibility rule (owner decision 74c89b226ab9b9cd, 2026-08-31) ────────
// Both callers — the `cleanup` verb and the next-step pre-run sweep — apply the
// SAME rule, with no mode flag: a dir is stale when its run is `not_started`, or
// `complete` with nothing left for the completion transition to do (every
// artifact promotion archives is already one level up, byte-identical — decided
// by promotion's own archive walk in verify-only mode, never by a second list).
// A complete dir with work left is a live continuation for BOTH callers: the
// fold's terminal step presents and promotes it; the verb refuses without
// --force. This replaced the not_started-only pre-run narrowing of 7ebeccc8 and
// keeps its protection — an unpromoted report is never destroyed — without the
// split.

test("one rule: deletes a not_started dir", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await writeState(artifactsDir, "not_started");

    const result = await cleanupStaleArtifactsDir(artifactsDir);

    expect(result.action).toBe("deleted");
    expect(result.status).toBe("not_started");
    expect(!(await dirExists(artifactsDir)), "a not_started dir is junk from a run that never got going").toBeTruthy();
  });
});

test("one rule: deletes a complete dir whose promotion has nothing left to do", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await plantFullyPromotedCompleteRun(artifactsDir);

    const result = await cleanupStaleArtifactsDir(artifactsDir);

    expect(result.action).toBe("deleted");
    expect(result.status).toBe("complete");
    expect(!(await dirExists(artifactsDir)), "a fully promoted complete dir is a leftover (an rm that failed), not a continuation").toBeTruthy();
    expect(await fileExists(promotedAuditReportPath(artifactsDir)), "the promoted report survives").toBeTruthy();
    expect(await fileExists(promotedAuditFindingsPath(artifactsDir)), "the promoted findings survive").toBeTruthy();
  });
});

test("one rule: preserves a complete dir whose render is not promoted — the only copy of the report", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await writeState(artifactsDir, "complete");
    await plantInPlaceDeliverables(artifactsDir);

    const result = await cleanupStaleArtifactsDir(artifactsDir);

    expect(result.action).toBe("skipped");
    expect(result.status).toBe("complete");
    expect(result.reason ?? "").toMatch(/promot/);
    expect(result.reason ?? "").toMatch(/--force/);
    expect(await dirExists(artifactsDir), "an unpromoted complete dir is a live continuation the terminal step finishes").toBeTruthy();
    expect(await fileExists(auditReportPath(artifactsDir)), "the only copy of the render survives").toBeTruthy();
  });
});

test("one rule: preserves a complete dir whose render is promoted but whose findings are not archived (INV 1 parity)", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await writeState(artifactsDir, "complete");
    await plantInPlaceDeliverables(artifactsDir);
    await plantPromotedCopies(artifactsDir, { findings: false });

    const result = await cleanupStaleArtifactsDir(artifactsDir);

    expect(result.action).toBe("skipped");
    expect(await dirExists(artifactsDir), "promotion's delete gate would refuse this dir, so cleanup must too").toBeTruthy();
    expect(await fileExists(auditFindingsPath(artifactsDir)), "the only copy of the machine contract survives").toBeTruthy();
  });
});

test("one rule: a previous audit's promoted report does not make this complete dir stale", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await writeState(artifactsDir, "complete");
    await plantInPlaceDeliverables(artifactsDir);
    await plantPromotedCopies(artifactsDir, { report: "# An older audit's report\n" });

    const result = await cleanupStaleArtifactsDir(artifactsDir);

    expect(result.action).toBe("skipped");
    expect(await dirExists(artifactsDir), "identity, not existence: an older promoted report is not this run's").toBeTruthy();
  });
});

test("one rule: --force deletes a complete dir with work left", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await writeState(artifactsDir, "complete");
    await plantInPlaceDeliverables(artifactsDir);

    const result = await cleanupStaleArtifactsDir(artifactsDir, { force: true });

    expect(result.action).toBe("deleted");
    expect(!(await dirExists(artifactsDir)), "--force waives the run's status evidence").toBeTruthy();
  });
});

test("one rule: preserves active and blocked dirs", async () => {
  for (const status of ["active", "blocked"] as const) {
    await withTempDir("audit-cleanup-test-", async (tempDir) => {
      const artifactsDir = join(tempDir, ".audit-tools/audit");
      await writeState(artifactsDir, status);

      const result = await cleanupStaleArtifactsDir(artifactsDir);

      expect(result.action).toBe("skipped");
      expect(result.status).toBe(status);
      expect(await dirExists(artifactsDir), `a ${status} dir must survive cleanup`).toBeTruthy();
    });
  }
});

test("one rule: preserves a dir with no audit_state.json", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    // No audit_state.json written — status unknown, never eligible without --force.

    const result = await cleanupStaleArtifactsDir(artifactsDir);

    expect(result.action).toBe("skipped");
    expect(result.status).toBe("unknown");
    expect(await dirExists(artifactsDir), "an unknown-status dir must survive cleanup").toBeTruthy();
  });
});

test("deletion contract: the four promoted final reports survive every cleanup path", async () => {
  for (const viaVerb of [false, true]) {
    await withTempDir("audit-cleanup-test-", async (tempDir) => {
      const artifactsDir = join(tempDir, ".audit-tools/audit");
      await writeState(artifactsDir, "not_started");
      const promotedDir = dirname(artifactsDir);
      for (const name of PROMOTED_FINAL_REPORTS) {
        await writeFile(join(promotedDir, name), `promoted ${name}\n`);
      }

      if (viaVerb) {
        const { code } = await runCleanup(artifactsDir);
        expect(code).toBe(0);
      } else {
        expect((await cleanupStaleArtifactsDir(artifactsDir)).action).toBe("deleted");
      }

      expect(!(await dirExists(artifactsDir)), "only the working artifacts dir is removed").toBeTruthy();
      for (const name of PROMOTED_FINAL_REPORTS) {
        expect(await fileExists(join(promotedDir, name)), `${name} lives one level up and is never touched by cleanup`).toBeTruthy();
      }
    });
  }
});

test("cmdCleanup: complete with work left — exitCode=1, JSON action=skipped, reason names --force", async () => {
  await withTempDir("audit-cleanup-test-", async (tempDir) => {
    const artifactsDir = join(tempDir, ".audit-tools/audit");
    await writeState(artifactsDir, "complete");
    await plantInPlaceDeliverables(artifactsDir);

    const { code, stdout } = await runCleanup(artifactsDir);

    expect(code, "a live continuation is refused").toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.action).toBe("skipped");
    expect(String(parsed.reason)).toMatch(/--force/);
    expect(await dirExists(artifactsDir), "the only copy of the report survives the verb").toBeTruthy();
  });
});

// ── Sweep wiring (next-step entry) ────────────────────────────────────────────
// The sweep runs at the top of cmdNextStepBody under the same rule as the verb: a
// stale not_started dir left by a crashed prior run, or a complete dir whose
// promotion already finished (a leftover from an rm that failed), is cleared
// before the fresh run bootstraps. A complete dir with work left survives entry
// and is finished by the fold's terminal step — anchored by
// tests/audit/next-step-core-report.test.ts (promotion + pending-friction-triage
// steps both require that dir to survive next-step entry).

test("next-step clears a stale not_started artifacts dir before the fresh run", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools/audit");
    await writeFile(
      join(artifactsDir, "audit_state.json"),
      JSON.stringify({ status: "not_started" }) + "\n",
    );
    const junkPath = join(artifactsDir, "stale-junk.txt");
    await writeFile(junkPath, "left by a crashed prior run\n");

    // Isolated, empty analyzer cache so the run pauses deterministically
    // regardless of what the host machine's shared cache holds.
    const analyzerCache = join(dirname(root), "empty-analyzer-cache");
    await mkdir(analyzerCache, { recursive: true });

    const { stdout } = await runWrapper(["next-step"], {
      cwd: root,
      env: { AUDIT_TOOLS_ANALYZER_CACHE: analyzerCache },
    });
    const step = JSON.parse(stdout);

    expect(!(await fileExists(junkPath)), "the stale not_started dir (and its junk) should be swept at next-step entry").toBeTruthy();
    expect(await dirExists(artifactsDir), "the artifacts dir should be recreated for the fresh run").toBeTruthy();
    expect(typeof step.step_kind === "string" && step.step_kind.length > 0, "the fresh run should proceed to a real step").toBeTruthy();
  });
});

test("next-step sweeps a complete dir whose promotion has nothing left to do", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools/audit");
    await plantFullyPromotedCompleteRun(artifactsDir);
    const junkPath = join(artifactsDir, "stale-junk.txt");
    await writeFile(junkPath, "left by an rm that failed after promotion\n");

    const analyzerCache = join(dirname(root), "empty-analyzer-cache");
    await mkdir(analyzerCache, { recursive: true });

    const { stdout } = await runWrapper(["next-step"], {
      cwd: root,
      env: { AUDIT_TOOLS_ANALYZER_CACHE: analyzerCache },
    });
    const step = JSON.parse(stdout);

    expect(!(await fileExists(junkPath)), "a fully promoted complete dir is swept at next-step entry like a not_started one").toBeTruthy();
    expect(await dirExists(artifactsDir), "the artifacts dir should be recreated for the fresh run").toBeTruthy();
    expect(step.step_kind, "the fresh run starts instead of re-presenting the finished audit").not.toBe("present_report");
    expect(await fileExists(promotedAuditReportPath(artifactsDir)), "the promoted report is untouched").toBeTruthy();
  });
});
