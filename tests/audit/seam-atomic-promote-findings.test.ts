/**
 * seam-atomic-promote-findings.test.mjs
 *
 * Cross-module seam test: atomic-promote-findings
 *
 * Verifies that the audit→remediate promotion handoff contract is satisfied:
 *
 *   audit-code side:
 *     `promoteFinalAuditReport` in src/io/artifacts.ts copies BOTH
 *     audit-report.md AND audit-findings.json from the audit artifactsDir
 *     to its PARENT directory (.audit-tools/).
 *
 *   remediate-code side:
 *     `defaultInputCandidates` in src/steps/nextStep.ts probes
 *     `.audit-tools/audit-findings.json` FIRST (before the fallback audit/
 *     subdirectory or legacy root paths).
 *
 * Seam contract enforced here:
 *   A. Successful promotion: both audit-report.md and audit-findings.json land
 *      at dirname(artifactsDir) — exactly where remediate-code expects them.
 *   B. Destination path contract: the promoted audit-findings.json path equals
 *      `.audit-tools/audit-findings.json` when the audit artifactsDir is the
 *      canonical `.audit-tools/audit/`. This matches the first candidate in
 *      remediate-code's defaultInputCandidates.
 *   C. audit-findings.json absence is best-effort: promotion still succeeds
 *      (returns promoted:true) even when audit-findings.json is missing; only
 *      a warning is emitted.
 *   D. audit-report.md failure is fatal to promotion: returns promoted:false
 *      and does NOT attempt to copy audit-findings.json.
 *   E. Post-promotion cleanup: artifactsDir is removed on a full successful
 *      promotion (returned cleaned:true).
 *   F. Interface stability: promoteFinalAuditReport accepts { artifactsDir }
 *      and returns { promoted, cleaned, warning? } — no undeclared properties.
 *   G. AUDIT_REPORT_FILENAME constant is "audit-report.md" — the literal used
 *      by nextStepHelpers.ts to compute finalReportPath after promotion.
 */

import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { withTempDir } from "./helpers/withTempDir.mjs";

const { promoteFinalAuditReport, AUDIT_REPORT_FILENAME } = await import("../../src/audit/io/artifacts.js");

// Canonical paths used in the audit→remediate handoff.
// These must be kept in sync with remediate-code's defaultInputCandidates.
const AUDIT_FINDINGS_FILENAME = "audit-findings.json";

// ─────────────────────────────────────────────────────────────────────────────
// G. AUDIT_REPORT_FILENAME constant
// ─────────────────────────────────────────────────────────────────────────────

test("G: AUDIT_REPORT_FILENAME is the literal 'audit-report.md'", () => {
  expect(AUDIT_REPORT_FILENAME, "AUDIT_REPORT_FILENAME must equal 'audit-report.md' — nextStepHelpers.ts uses this constant to construct finalReportPath after promotion").toBe("audit-report.md");
});

// ─────────────────────────────────────────────────────────────────────────────
// A. Successful promotion: both files land at dirname(artifactsDir)
// ─────────────────────────────────────────────────────────────────────────────

test("A1: promotion copies audit-report.md to dirname(artifactsDir)", async () => {
  await withTempDir("seam-promote-A1-", async (root) => {
    const artifactsDir = join(root, "audit");
    await mkdir(artifactsDir, { recursive: true });

    const reportContent = "# Audit Report\nA test report.";
    await writeFile(join(artifactsDir, AUDIT_REPORT_FILENAME), reportContent, "utf8");
    await writeFile(
      join(artifactsDir, AUDIT_FINDINGS_FILENAME),
      JSON.stringify({ contract_version: "audit-findings/v1" }),
      "utf8",
    );

    const result = await promoteFinalAuditReport({ artifactsDir });

    expect(result.promoted, "promoted must be true when source report exists").toBe(true);
    expect(result.warning, "no warning expected on clean promotion").toBe(undefined);

    const destContent = await readFile(join(root, AUDIT_REPORT_FILENAME), "utf8");
    expect(destContent, "promoted audit-report.md must have the same content as the source").toBe(reportContent);
  });
});

test("A2: promotion copies audit-findings.json to dirname(artifactsDir)", async () => {
  await withTempDir("seam-promote-A2-", async (root) => {
    const artifactsDir = join(root, "audit");
    await mkdir(artifactsDir, { recursive: true });

    const findingsObj = { contract_version: "audit-findings/v1", findings: [] };
    await writeFile(join(artifactsDir, AUDIT_REPORT_FILENAME), "# Report", "utf8");
    await writeFile(
      join(artifactsDir, AUDIT_FINDINGS_FILENAME),
      JSON.stringify(findingsObj),
      "utf8",
    );

    await promoteFinalAuditReport({ artifactsDir });

    const destPath = join(root, AUDIT_FINDINGS_FILENAME);
    const destContent = JSON.parse(await readFile(destPath, "utf8"));
    expect(destContent, "promoted audit-findings.json must have the same content as the source").toEqual(findingsObj);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Destination path contract: canonical .audit-tools layout
// ─────────────────────────────────────────────────────────────────────────────

test("B: canonical .audit-tools/audit/ artifactsDir promotes to .audit-tools/ — matching remediate-code defaultInputCandidates[0]", async () => {
  await withTempDir("seam-promote-B-", async (root) => {
    // Mirrors the real layout: root/.audit-tools/audit/
    const auditToolsDir = join(root, ".audit-tools");
    const artifactsDir = join(auditToolsDir, "audit");
    await mkdir(artifactsDir, { recursive: true });

    await writeFile(join(artifactsDir, AUDIT_REPORT_FILENAME), "# Report", "utf8");
    await writeFile(
      join(artifactsDir, AUDIT_FINDINGS_FILENAME),
      JSON.stringify({ contract_version: "audit-findings/v1" }),
      "utf8",
    );

    await promoteFinalAuditReport({ artifactsDir });

    // remediate-code's defaultInputCandidates[0] == join(root, ".audit-tools", "audit-findings.json")
    const remediateFirstCandidate = join(root, ".audit-tools", "audit-findings.json");
    // promoteFinalAuditReport writes to join(dirname(artifactsDir), "audit-findings.json")
    //   = join(auditToolsDir, "audit-findings.json")
    //   = join(root, ".audit-tools", "audit-findings.json")  ✓
    const info = await stat(remediateFirstCandidate);
    expect(info.isFile(), `audit-findings.json must exist at ${remediateFirstCandidate} — the first path probed by remediate-code defaultInputCandidates`).toBeTruthy();

    // Report is co-promoted at the same directory
    const reportCandidate = join(root, ".audit-tools", "audit-report.md");
    const reportInfo = await stat(reportCandidate);
    expect(reportInfo.isFile(), "audit-report.md must also be promoted to .audit-tools/").toBeTruthy();
  });
});

test("B: dirname invariant — promoted destination is always dirname(artifactsDir)", async () => {
  // Verify the structural invariant: no matter what name the artifactsDir has,
  // the promotion lands in its parent.
  await withTempDir("seam-promote-B2-", async (root) => {
    const artifactsDir = join(root, "nested", "subdir", "outputs");
    await mkdir(artifactsDir, { recursive: true });

    await writeFile(join(artifactsDir, AUDIT_REPORT_FILENAME), "# Report", "utf8");
    await writeFile(
      join(artifactsDir, AUDIT_FINDINGS_FILENAME),
      JSON.stringify({ contract_version: "v1" }),
      "utf8",
    );

    await promoteFinalAuditReport({ artifactsDir });

    const expectedParent = dirname(artifactsDir); // root/nested/subdir
    const reportAtParent = await stat(join(expectedParent, AUDIT_REPORT_FILENAME));
    expect(reportAtParent.isFile()).toBeTruthy();
    const findingsAtParent = await stat(join(expectedParent, AUDIT_FINDINGS_FILENAME));
    expect(findingsAtParent.isFile()).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. audit-findings.json absence is best-effort
// ─────────────────────────────────────────────────────────────────────────────

test("C: promotion succeeds (promoted:true) even when audit-findings.json is missing", async () => {
  await withTempDir("seam-promote-C-", async (root) => {
    const artifactsDir = join(root, "audit");
    await mkdir(artifactsDir, { recursive: true });

    // Only the markdown report exists; JSON contract is absent (legacy bundle scenario)
    await writeFile(join(artifactsDir, AUDIT_REPORT_FILENAME), "# Report", "utf8");

    const warnings: string[] = [];
    const result = await promoteFinalAuditReport(
      { artifactsDir },
      { warn: (msg) => warnings.push(msg) },
    );

    expect(result.promoted, "promoted must be true even when audit-findings.json is absent").toBe(true);
    // A warning is emitted for the missing JSON contract
    expect(warnings.length, "exactly one warning expected for missing audit-findings.json").toBe(1);
    expect(warnings[0].includes("audit-findings.json"), "warning must mention audit-findings.json").toBeTruthy();
    // audit-report.md was still promoted
    const reportInfo = await stat(join(root, AUDIT_REPORT_FILENAME));
    expect(reportInfo.isFile()).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. audit-report.md failure is fatal to promotion
// ─────────────────────────────────────────────────────────────────────────────

test("D: promotion returns promoted:false when audit-report.md source is missing", async () => {
  await withTempDir("seam-promote-D-", async (root) => {
    const artifactsDir = join(root, "audit");
    await mkdir(artifactsDir, { recursive: true });

    // Neither report nor findings exist
    const warnings: string[] = [];
    const result = await promoteFinalAuditReport(
      { artifactsDir },
      { warn: (msg) => warnings.push(msg) },
    );

    expect(result.promoted, "promoted must be false when source report is missing").toBe(false);
    expect(result.cleaned, "cleaned must be false when promotion fails").toBe(false);
    expect(typeof result.warning, "warning string must be present on failure").toBe("string");
    expect(result.warning!.includes("could not promote"), "warning must describe the promotion failure").toBeTruthy();
  });
});

test("D2: promotion with missing report does NOT place audit-findings.json at destination", async () => {
  await withTempDir("seam-promote-D2-", async (root) => {
    const artifactsDir = join(root, "audit");
    await mkdir(artifactsDir, { recursive: true });

    // Only findings exists; the report copy will fail
    await writeFile(
      join(artifactsDir, AUDIT_FINDINGS_FILENAME),
      JSON.stringify({ contract_version: "v1" }),
      "utf8",
    );

    const warnings: string[] = [];
    const result = await promoteFinalAuditReport(
      { artifactsDir },
      {
        copy: async () => { throw new Error("copy disabled for test"); },
        warn: (msg) => warnings.push(msg),
      },
    );

    expect(result.promoted).toBe(false);
    // destination audit-findings.json must NOT exist (copy was blocked)
    await assert.rejects(
      () => stat(join(root, AUDIT_FINDINGS_FILENAME)),
      { code: "ENOENT" },
      "audit-findings.json must NOT be at destination when promotion fails",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Post-promotion cleanup
// ─────────────────────────────────────────────────────────────────────────────

test("E1: artifactsDir is removed after successful promotion (cleaned:true)", async () => {
  await withTempDir("seam-promote-E1-", async (root) => {
    const artifactsDir = join(root, "audit");
    await mkdir(artifactsDir, { recursive: true });

    await writeFile(join(artifactsDir, AUDIT_REPORT_FILENAME), "# Report", "utf8");
    await writeFile(
      join(artifactsDir, AUDIT_FINDINGS_FILENAME),
      JSON.stringify({ contract_version: "v1" }),
      "utf8",
    );

    const result = await promoteFinalAuditReport({ artifactsDir });

    expect(result.cleaned, "cleaned must be true after successful promotion+cleanup").toBe(true);
    await assert.rejects(
      () => stat(artifactsDir),
      { code: "ENOENT" },
      "artifactsDir must be removed after promotion",
    );
  });
});

test("E2: promoted:true but cleaned:false when remove throws (warning emitted)", async () => {
  await withTempDir("seam-promote-E2-", async (root) => {
    const artifactsDir = join(root, "audit");
    await mkdir(artifactsDir, { recursive: true });

    await writeFile(join(artifactsDir, AUDIT_REPORT_FILENAME), "# Report", "utf8");
    await writeFile(
      join(artifactsDir, AUDIT_FINDINGS_FILENAME),
      JSON.stringify({ contract_version: "v1" }),
      "utf8",
    );

    const warnings: string[] = [];
    const result = await promoteFinalAuditReport(
      { artifactsDir },
      {
        remove: async () => { throw new Error("remove blocked for test"); },
        warn: (msg) => warnings.push(msg),
      },
    );

    expect(result.promoted, "promoted must still be true when only cleanup fails").toBe(true);
    expect(result.cleaned, "cleaned must be false when remove throws").toBe(false);
    expect(typeof result.warning, "a warning must be emitted for the cleanup failure").toBe("string");
    expect(warnings.length > 0, "warn callback must have been called").toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. Interface stability
// ─────────────────────────────────────────────────────────────────────────────

test("F: promoteFinalAuditReport return shape has only promoted/cleaned/warning properties", async () => {
  await withTempDir("seam-promote-F-", async (root) => {
    const artifactsDir = join(root, "audit");
    await mkdir(artifactsDir, { recursive: true });

    await writeFile(join(artifactsDir, AUDIT_REPORT_FILENAME), "# Report", "utf8");
    await writeFile(
      join(artifactsDir, AUDIT_FINDINGS_FILENAME),
      JSON.stringify({ contract_version: "v1" }),
      "utf8",
    );

    const result = await promoteFinalAuditReport({ artifactsDir });

    // Only these three keys are part of the seam contract
    const knownKeys = new Set(["promoted", "cleaned", "warning"]);
    for (const key of Object.keys(result)) {
      expect(knownKeys.has(key), `unexpected property '${key}' in promoteFinalAuditReport result — seam contract violation`).toBeTruthy();
    }
    expect(typeof result.promoted).toBe("boolean");
    expect(typeof result.cleaned).toBe("boolean");
    // warning is optional; when present it must be a string
    if ("warning" in result && result.warning !== undefined) {
      expect(typeof result.warning).toBe("string");
    }
  });
});

test("F: promoteFinalAuditReport is a function accepting { artifactsDir } param", () => {
  expect(typeof promoteFinalAuditReport, "promoteFinalAuditReport must be a callable function").toBe("function");
  // Arity: params object is first arg; options is second (optional)
  expect(promoteFinalAuditReport.length <= 2, "promoteFinalAuditReport must accept at most 2 arguments").toBeTruthy();
});

// ─────────────────────────────────────────────────────────────────────────────
// H. NOTHING IS DELETED THAT WAS NOT FIRST ARCHIVED.
//
// The recursive delete used to be unconditional: a failed audit-findings.json
// copy was a warn() with no effect on the result, so the machine contract could
// be destroyed while the call returned { promoted: true, cleaned: true }. A
// caller had no way to tell a clean promotion from a lossy one.
// ─────────────────────────────────────────────────────────────────────────────

/** Seed a complete artifacts dir: report, findings, feedback, ledger. */
async function seedArtifacts(root: string): Promise<string> {
  const artifactsDir = join(root, "audit");
  await mkdir(join(artifactsDir, "submissions"), { recursive: true });
  await writeFile(join(artifactsDir, AUDIT_REPORT_FILENAME), "# Audit Report\n", "utf8");
  await writeFile(
    join(artifactsDir, AUDIT_FINDINGS_FILENAME),
    JSON.stringify({ contract_version: "audit-findings/v1" }),
    "utf8",
  );
  await writeFile(
    join(artifactsDir, "agent-feedback.jsonl"),
    JSON.stringify({ kind: "friction", note: "worker said something" }) + "\n",
    "utf8",
  );
  return artifactsDir;
}

test("H1: agent-feedback.jsonl is archived, and a complete promotion still reports clean", async () => {
  await withTempDir("seam-promote-H1-", async (root) => {
    const artifactsDir = await seedArtifacts(root);

    const result = await promoteFinalAuditReport({ artifactsDir });

    // POLARITY ONE: nothing failed, so the run is clean and says so.
    expect(result.cleaned, "a complete archive still cleans up").toBe(true);
    expect(result.unarchived, "a clean promotion names no loss").toBeUndefined();
    // Worker-owned, append-only, and inside artifactsDir — so the rm destroys
    // it. It had no archive step at all while the friction records and the
    // ledger beside it both had one (DAT-4802dc9e).
    expect(
      await readFile(join(root, "audit-agent-feedback.jsonl"), "utf8"),
      "the archived copy must carry the worker's records",
    ).toContain("worker said something");
  });
});

test("H2: a failed findings archive ABORTS the delete and reports the loss", async () => {
  await withTempDir("seam-promote-H2-", async (root) => {
    const artifactsDir = await seedArtifacts(root);
    const warnings: string[] = [];

    const result = await promoteFinalAuditReport(
      { artifactsDir },
      {
        // Only the findings copy fails; everything else archives normally.
        copy: (async (from: string, to: string, opts: unknown) => {
          if (String(from).endsWith(AUDIT_FINDINGS_FILENAME)) {
            throw new Error("simulated findings copy failure");
          }
          const { cp } = await import("node:fs/promises");
          return cp(from as never, to as never, opts as never);
        }) as never,
        warn: (message: string) => warnings.push(message),
      },
    );

    // POLARITY TWO. The source directory survives, because the only copy of the
    // machine contract is still inside it.
    expect(
      (await stat(artifactsDir)).isDirectory(),
      "the directory holding the unarchived file must NOT be deleted",
    ).toBe(true);
    expect(
      await readFile(join(artifactsDir, AUDIT_FINDINGS_FILENAME), "utf8"),
      "the unarchived machine contract must still be on disk",
    ).toContain("audit-findings/v1");

    // And the RESULT says so — { promoted: true, cleaned: true } would be a lie.
    expect(result.cleaned).toBe(false);
    expect(result.unarchived, "the loss must be nameable by the caller").toEqual([
      expect.stringContaining(AUDIT_FINDINGS_FILENAME),
    ]);
    expect(result.warning).toContain(AUDIT_FINDINGS_FILENAME);
    expect(warnings.join(" | ")).toContain(AUDIT_FINDINGS_FILENAME);
  });
});

test("H3: the ledger is archived byte-for-byte and its unreadable lines are named", async () => {
  await withTempDir("seam-promote-H3-", async (root) => {
    const artifactsDir = await seedArtifacts(root);
    // A valid event, a torn line, and a foreign-version line. The archive must
    // be the BYTES — a re-serialization of the parsed events would silently drop
    // the two lines the reader could not use, producing an archive cleaner than
    // the run actually was.
    const ledgerBody =
      JSON.stringify({
        contract_version: "submission-ledger-event/v1alpha1",
        run_id: "r",
        submission_id: "s",
        lane: "l",
        kind: "accepted",
        recorded_at: "2026-08-20T00:00:00.000Z",
      }) +
      "\n" +
      '{"contract_version":"submission-ledger-ev\n' +
      JSON.stringify({ contract_version: "submission-ledger-event/v0", kind: "rejected" }) +
      "\n";
    await writeFile(
      join(artifactsDir, "submissions", "submission-ledger.jsonl"),
      ledgerBody,
      "utf8",
    );

    const result = await promoteFinalAuditReport({ artifactsDir });

    expect(
      await readFile(join(root, "audit-submission-ledger.jsonl"), "utf8"),
      "the archive is a byte copy, torn lines included",
    ).toBe(ledgerBody);
    expect(
      result.ledger_dropped,
      "a result that did not name the drops would describe a cleaner record than the bytes hold",
    ).toEqual([
      { line: 2, reason: "unparsable" },
      { line: 3, reason: "schema_version_mismatch" },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// I. AN ALL-DROPPED LEDGER STILL REACHES THE BUNDLE.
//
// `bundle.submission_ledger` was set only when `events.length > 0`. A ledger
// whose every line is torn has events empty and dropped non-empty, so the field
// was never set and the drop signal died on precisely the worst case: the run
// whose record is least trustworthy looked identical to one that never drifted.
// ─────────────────────────────────────────────────────────────────────────────

const { loadArtifactBundle } = await import("../../src/audit/io/artifacts.js");

test("I1: a ledger of nothing but torn lines surfaces its drops in the bundle", async () => {
  await withTempDir("seam-promote-I1-", async (root) => {
    const artifactsDir = join(root, "audit");
    await mkdir(join(artifactsDir, "submissions"), { recursive: true });
    await writeFile(
      join(artifactsDir, "submissions", "submission-ledger.jsonl"),
      '{"contract_version":"submission-ledger-ev\n{"also torn\n',
      "utf8",
    );

    const bundle = await loadArtifactBundle(artifactsDir);

    // events is empty — correctly, nothing parsed — but that is NOT the same
    // fact as "this run never drifted".
    expect(bundle.submission_ledger).toBeUndefined();
    expect(
      bundle.submission_ledger_dropped,
      "an unreadable ledger must not read as an absent one",
    ).toEqual([
      { line: 1, reason: "unparsable" },
      { line: 2, reason: "unparsable" },
    ]);
  });
});

test("I2: a clean ledger sets the events field and leaves no drop field", async () => {
  await withTempDir("seam-promote-I2-", async (root) => {
    const artifactsDir = join(root, "audit");
    await mkdir(join(artifactsDir, "submissions"), { recursive: true });
    await writeFile(
      join(artifactsDir, "submissions", "submission-ledger.jsonl"),
      JSON.stringify({
        contract_version: "submission-ledger-event/v1alpha1",
        run_id: "r",
        submission_id: "s",
        lane: "l",
        kind: "accepted",
        recorded_at: "2026-08-20T00:00:00.000Z",
      }) + "\n",
      "utf8",
    );

    const bundle = await loadArtifactBundle(artifactsDir);
    expect(bundle.submission_ledger).toHaveLength(1);
    expect(bundle.submission_ledger_dropped).toBeUndefined();
  });
});

test("H4: a failed LEDGER archive also aborts the delete (the archive set is one class)", async () => {
  await withTempDir("seam-promote-H4-", async (root) => {
    const artifactsDir = await seedArtifacts(root);
    await writeFile(
      join(artifactsDir, "submissions", "submission-ledger.jsonl"),
      "{}\n",
      "utf8",
    );

    const result = await promoteFinalAuditReport(
      { artifactsDir },
      {
        copy: (async (from: string, to: string, opts: unknown) => {
          if (String(from).endsWith("submission-ledger.jsonl")) {
            const failure = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
            failure.code = "EACCES";
            throw failure;
          }
          const { cp } = await import("node:fs/promises");
          return cp(from as never, to as never, opts as never);
        }) as never,
        warn: () => {},
      },
    );

    // The ledger is the ONE durable statement that a run drifted and was
    // repaired. It used to warn and fall through, so the rm destroyed it.
    expect(
      (await stat(artifactsDir)).isDirectory(),
      "the directory holding the unarchived ledger must NOT be deleted",
    ).toBe(true);
    expect(result.cleaned).toBe(false);
    expect(result.unarchived?.join(" ")).toContain("submission ledger");
  });
});

test("H5: a friction record that cannot be archived also aborts the delete", async () => {
  await withTempDir("seam-promote-H5-", async (root) => {
    const artifactsDir = await seedArtifacts(root);
    const frictionDir = join(artifactsDir, "friction");
    await mkdir(frictionDir, { recursive: true });

    // TWO entries. One is a real record; the other is a DIRECTORY wearing a
    // .json name. `cp` of a directory without `recursive` fails on both win32
    // and linux, so the per-file archive failure is produced by ordinary
    // filesystem semantics — no stub, and nothing patched in
    // src/shared/io/frictionCapture.ts, which this module does not own.
    await writeFile(
      join(frictionDir, "good.json"),
      JSON.stringify({ kind: "friction", note: "real record" }),
      "utf8",
    );
    await mkdir(join(frictionDir, "poisoned.json"), { recursive: true });

    const result = await promoteFinalAuditReport({ artifactsDir });

    // archiveFrictionRecords warns per failed file and omits it from its return.
    // Dropping that return meant this record was destroyed by the rm with
    // nothing gating it — the same class as the findings and ledger archives.
    expect(
      (await stat(artifactsDir)).isDirectory(),
      "the directory holding the unarchived friction record must NOT be deleted",
    ).toBe(true);
    expect(result.cleaned).toBe(false);
    expect(
      result.unarchived?.join(" "),
      "the friction shortfall must be nameable by the caller",
    ).toContain("friction record");
  });
});
