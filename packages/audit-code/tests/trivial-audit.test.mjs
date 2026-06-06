import test from "node:test";
import assert from "node:assert/strict";
import { importSourceModule } from "./helpers/sourceImport.mjs";

const { isTrivialAuditPath, autoCompleteTrivialCoverage } =
  await importSourceModule("src/orchestrator/trivialAudit.ts");

// ── isTrivialAuditPath — __init__.py special case ────────────────────────────

await test("isTrivialAuditPath returns true for __init__.py with lineCount <= 3", async (t) => {
  await t.test("lineCount 1", () => {
    assert.equal(isTrivialAuditPath("pkg/__init__.py", 1), true);
  });

  await t.test("lineCount 3 (boundary)", () => {
    assert.equal(isTrivialAuditPath("pkg/__init__.py", 3), true);
  });

  await t.test("lineCount 0 short-circuits before name check — also true", () => {
    assert.equal(isTrivialAuditPath("nested/a/b/__init__.py", 0), true);
  });

  await t.test("no directory prefix", () => {
    assert.equal(isTrivialAuditPath("__init__.py", 3), true);
  });
});

await test("isTrivialAuditPath returns false for __init__.py with lineCount > 3", async (t) => {
  await t.test("lineCount 4 (first non-trivial)", () => {
    assert.equal(isTrivialAuditPath("pkg/__init__.py", 4), false);
  });

  await t.test("lineCount 100", () => {
    assert.equal(isTrivialAuditPath("pkg/__init__.py", 100), false);
  });
});

await test("isTrivialAuditPath returns false for __init__.py when hasExternalSignal is true", async (t) => {
  await t.test("external signal overrides the trivial rule", () => {
    assert.equal(isTrivialAuditPath("pkg/__init__.py", 1, true), false);
  });
});

await test("isTrivialAuditPath is case-insensitive for __init__.py basename check", async (t) => {
  await t.test("uppercased basename and directory", () => {
    assert.equal(isTrivialAuditPath("PKG/__INIT__.PY", 2), true);
  });
});

// ── autoCompleteTrivialCoverage — guard branches ──────────────────────────────

await test("autoCompleteTrivialCoverage skips files where required_lenses is already empty", async (t) => {
  await t.test("already-cleared file is not in skipped; file with lenses is excluded", () => {
    const coverage = {
      files: [
        {
          path: "pkg/__init__.py",
          audit_status: "pending",
          classification_status: "unclassified",
          required_lenses: [],
          completed_lenses: [],
          unit_ids: [],
        },
        {
          path: "pkg2/__init__.py",
          audit_status: "pending",
          classification_status: "unclassified",
          required_lenses: ["security"],
          completed_lenses: [],
          unit_ids: [],
        },
      ],
    };
    // lineIndex makes both paths trivial (lineCount <= 3)
    const lineIndex = {
      "pkg/__init__.py": 1,
      "pkg2/__init__.py": 2,
    };

    const skipped = autoCompleteTrivialCoverage(coverage, lineIndex);

    // The already-cleared file must NOT appear in skipped.
    assert.ok(!skipped.includes("pkg/__init__.py"), "already-cleared file must not be in skipped");

    // The file with required_lenses=['security'] must appear in skipped.
    assert.ok(skipped.includes("pkg2/__init__.py"), "file with lenses must be in skipped");

    // The excluded file has audit_status='excluded'.
    const excluded = coverage.files.find((f) => f.path === "pkg2/__init__.py");
    assert.equal(excluded.audit_status, "excluded");

    // The already-cleared file retains its original audit_status unchanged.
    const unchanged = coverage.files.find((f) => f.path === "pkg/__init__.py");
    assert.equal(unchanged.audit_status, "pending");
  });
});

await test("autoCompleteTrivialCoverage does not re-exclude already-excluded files", async (t) => {
  await t.test("file with audit_status=excluded is skipped by the excluded guard", () => {
    const coverage = {
      files: [
        {
          path: "pkg/__init__.py",
          audit_status: "excluded",
          classification_status: "excluded_vendor",
          required_lenses: ["security"],
          completed_lenses: [],
          unit_ids: [],
        },
      ],
    };
    const lineIndex = { "pkg/__init__.py": 1 };

    const skipped = autoCompleteTrivialCoverage(coverage, lineIndex);

    // Already-excluded file must not appear in the returned array.
    assert.equal(skipped.length, 0);

    // Fields must be untouched.
    const file = coverage.files[0];
    assert.equal(file.audit_status, "excluded");
    assert.deepEqual(file.required_lenses, ["security"]);
  });
});
