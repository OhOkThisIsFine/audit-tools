// Packet 27 (F02 CY09): duplicate audit-result validation must be avoided ONLY
// via a trusted, tool-minted validation receipt — never via a host-submitted
// claim and never across a changed context. A successful validation (zero
// error-severity issues) mints an in-process receipt bound to the exact
// (result content, canonical task manifest, effective line index, boundary);
// the host-accept door (`validateOneAuditResult`) and the batch gate
// (`validateAuditResults`) share that store within one fold, so the second pass
// over an identical result skips the rule walk and re-stamps the caller's
// result index. A failed validation mints nothing; changed task / line counts /
// result bytes / a fresh process (raw CLI) re-validate.
import { beforeEach, describe, expect, test } from "vitest";
import {
  __auditResultValidationRunCountForTests,
  __resetValidationReceiptsForTests,
  validateAuditResults,
  validateOneAuditResult,
} from "../../src/audit/validation/auditResults.js";
import type { AuditTask } from "../../src/audit/types.js";

// A zero-findings result validates clean. `file_coverage` must match the task's
// `file_paths` and `file_line_counts` (line-count check only runs when lineIndex
// is supplied).
function task(taskId: string, lines = 10): AuditTask {
  return {
    task_id: taskId,
    unit_id: "U1",
    pass_id: "P1",
    lens: "correctness",
    file_paths: ["src/x.ts"],
    file_line_counts: { "src/x.ts": lines },
    rationale: "fixture",
  };
}

function cleanResult(taskId: string, totalLines = 10): Record<string, unknown> {
  return {
    task_id: taskId,
    unit_id: "U1",
    pass_id: "P1",
    lens: "correctness",
    file_coverage: [{ path: "src/x.ts", total_lines: totalLines }],
    findings: [],
    reviewed_clean: true,
  };
}

beforeEach(() => {
  __resetValidationReceiptsForTests();
});

// ── Reuse only on an exact receipt match ────────────────────────────────────

describe("validation receipt: reuse only on exact match", () => {
  test("the same result/context validates once (the second pass is a receipt skip)", () => {
    const result = cleanResult("T-A");
    const opts = { lineIndex: { "src/x.ts": 10 } };

    const first = validateOneAuditResult(result, [task("T-A")], opts);
    expect(first).toEqual([]);
    expect(__auditResultValidationRunCountForTests()).toBe(1);

    const second = validateOneAuditResult(result, [task("T-A")], opts);
    expect(second).toEqual([]);
    // Reused: no further rule walk ran.
    expect(__auditResultValidationRunCountForTests()).toBe(1);

    // And through the OTHER door (the batch gate): still the one receipt.
    const batch = validateAuditResults([result], [task("T-A")], opts);
    expect(batch).toEqual([]);
    expect(__auditResultValidationRunCountForTests()).toBe(1);
  });

  test("changed result bytes re-validate", () => {
    const opts = { lineIndex: { "src/x.ts": 10 } };
    validateOneAuditResult(cleanResult("T-A"), [task("T-A")], opts);
    expect(__auditResultValidationRunCountForTests()).toBe(1);

    // Different coverage total_lines — a different byte image.
    validateOneAuditResult(cleanResult("T-A", 11), [task("T-A")], opts);
    expect(__auditResultValidationRunCountForTests()).toBe(2);
  });

  test("a changed task manifest re-validates", () => {
    const result = cleanResult("T-A");
    const opts = { lineIndex: { "src/x.ts": 10 } };
    validateOneAuditResult(result, [task("T-A")], opts);
    expect(__auditResultValidationRunCountForTests()).toBe(1);

    // Same result, but the matching task now names a different file → the
    // coverage path is refused, which neither the old receipt nor a skip could
    // know. A changed manifest is a different key.
    const changedTask: AuditTask = {
      ...task("T-A"),
      file_paths: ["src/y.ts"],
    };
    const issues = validateOneAuditResult(result, [changedTask], opts);
    expect(issues.some((i) => i.severity === "error")).toBe(true);
    expect(__auditResultValidationRunCountForTests()).toBe(2);
  });

  test("changed effective line counts re-validate", () => {
    const result = cleanResult("T-A");
    // First validate with a matching line index (clean).
    validateOneAuditResult(result, [task("T-A")], { lineIndex: { "src/x.ts": 10 } });
    expect(__auditResultValidationRunCountForTests()).toBe(1);

    // The line index moved materially: 200 vs 10 is a significant divergence, so
    // this must be re-validated and now refuse — a skip would have returned the
    // clean receipt and silently accepted a stale file view.
    const issues = validateOneAuditResult(result, [task("T-A")], {
      lineIndex: { "src/x.ts": 200 },
    });
    expect(issues.some((i) => i.severity === "error")).toBe(true);
    expect(__auditResultValidationRunCountForTests()).toBe(2);
  });

  test("a changed boundary re-validates", () => {
    const result = cleanResult("T-A");
    const opts = { lineIndex: { "src/x.ts": 10 } };
    validateOneAuditResult(result, [task("T-A")], opts);
    expect(__auditResultValidationRunCountForTests()).toBe(1);

    // The boundary is part of the receipt identity; even a harmless change must
    // not alias onto the prior receipt.
    validateOneAuditResult(result, [task("T-A")], { ...opts, boundaryPaths: ["src/other.ts"] });
    expect(__auditResultValidationRunCountForTests()).toBe(2);
  });
});

// ── Failed validation never mints a receipt ────────────────────────────────

describe("validation receipt: failed validation never mints", () => {
  test("a refused result is re-validated on every submission, not skipped", () => {
    const opts = { lineIndex: { "src/x.ts": 10 } };
    // A result whose reviewed_clean contradicts its findings is refused.
    const badResult = {
      ...cleanResult("T-A"),
      findings: [
        {
          id: "f1",
          title: "t",
          category: "correctness",
          severity: "low",
          confidence: "high",
          lens: "correctness",
          summary: "s",
          affected_files: [
            { path: "src/x.ts", line_start: 2, line_end: 5, quoted_text: "return x;" },
          ],
          evidence: ["src/x.ts:2"],
        },
      ],
      reviewed_clean: true,
    };

    const first = validateOneAuditResult(badResult, [task("T-A")], opts);
    expect(first.some((i) => i.severity === "error")).toBe(true);
    expect(__auditResultValidationRunCountForTests()).toBe(1);

    // The identical refusal is produced again: no receipt was minted, so the
    // second submission runs the walk rather than reading a cached refusal.
    const second = validateOneAuditResult(badResult, [task("T-A")], opts);
    expect(second).toEqual(first);
    expect(__auditResultValidationRunCountForTests()).toBe(2);

    // And the corrected result is validated fresh (not blocked by any refusal).
    const fixed = validateOneAuditResult(cleanResult("T-A"), [task("T-A")], opts);
    expect(fixed).toEqual([]);
    expect(__auditResultValidationRunCountForTests()).toBe(3);
  });
});

// ── Warnings appear exactly once ────────────────────────────────────────────

describe("validation receipt: warnings appear exactly once", () => {
  test("reuse returns the same single warning (not duplicated, not dropped)", () => {
    const opts = { lineIndex: { "src/x.ts": 10 } };
    // total_lines 12 vs 10 is a small divergence → an advisory warning (S7), no
    // error, so this result mints a receipt carrying exactly one warning.
    const result = cleanResult("T-A", 12);
    const first = validateOneAuditResult(result, [task("T-A")], opts);
    const firstWarnings = first.filter((i) => i.severity === "warning");
    expect(firstWarnings.length).toBe(1);
    expect(first.filter((i) => i.severity === "error")).toEqual([]);

    // The batch gate reuses the receipt; the warning is present exactly once,
    // identical to the minted one (re-stamped to the batch index).
    const second = validateAuditResults([result], [task("T-A")], opts);
    const secondWarnings = second.filter((i) => i.severity === "warning");
    expect(secondWarnings.length).toBe(1);
    expect(secondWarnings.map((i) => i.message)).toEqual(
      firstWarnings.map((i) => i.message),
    );
    expect(second.filter((i) => i.severity === "error")).toEqual([]);
    // No new rule walk ran — the receipt served both renders.
    expect(__auditResultValidationRunCountForTests()).toBe(1);
  });
});

// ── Raw input / fresh process re-validates ──────────────────────────────────

describe("validation receipt: raw input has no receipt authority", () => {
  test("after a reset (a fresh process / raw CLI), validation runs again", () => {
    const result = cleanResult("T-A");
    const opts = { lineIndex: { "src/x.ts": 10 } };
    validateOneAuditResult(result, [task("T-A")], opts);
    expect(__auditResultValidationRunCountForTests()).toBe(1);

    // Simulate a fresh process (the raw `validate-results` CLI or a dispatch
    // script): the in-process store is gone, so the same bytes validate again.
    __resetValidationReceiptsForTests();
    expect(__auditResultValidationRunCountForTests()).toBe(0);
    const issues = validateOneAuditResult(result, [task("T-A")], opts);
    expect(issues).toEqual([]);
    expect(__auditResultValidationRunCountForTests()).toBe(1);
  });

  test("there is no way for a host to submit a receipt", () => {
    // The receipt is minted inside `validateSingleAuditResult`, keyed by content
    // it hashes itself. Neither entry point accepts a receipt argument, so a
    // host-supplied "already validated" token has no surface to reach the store.
    expect(validateOneAuditResult.length).toBe(2); // (result, tasks[, options])
    expect(validateAuditResults.length).toBe(2);
  });
});
