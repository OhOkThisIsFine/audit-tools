import { test, expect, describe, it } from "vitest";
import { importSourceModule } from "./helpers/sourceImport.mjs";

const { isTrivialAuditPath, autoCompleteTrivialCoverage } =
  await importSourceModule("src/orchestrator/trivialAudit.ts");

// ── isTrivialAuditPath — __init__.py special case ────────────────────────────

describe("isTrivialAuditPath returns true for __init__.py with lineCount <= 3", () => {
  it("lineCount 1", () => {
    expect(isTrivialAuditPath("pkg/__init__.py", 1)).toBe(true);
  });

  it("lineCount 3 (boundary)", () => {
    expect(isTrivialAuditPath("pkg/__init__.py", 3)).toBe(true);
  });

  it("lineCount 0 short-circuits before name check — also true", () => {
    expect(isTrivialAuditPath("nested/a/b/__init__.py", 0)).toBe(true);
  });

  it("no directory prefix", () => {
    expect(isTrivialAuditPath("__init__.py", 3)).toBe(true);
  });
});

describe("isTrivialAuditPath returns false for __init__.py with lineCount > 3", () => {
  it("lineCount 4 (first non-trivial)", () => {
    expect(isTrivialAuditPath("pkg/__init__.py", 4)).toBe(false);
  });

  it("lineCount 100", () => {
    expect(isTrivialAuditPath("pkg/__init__.py", 100)).toBe(false);
  });
});

describe("isTrivialAuditPath returns false for __init__.py when hasExternalSignal is true", () => {
  it("external signal overrides the trivial rule", () => {
    expect(isTrivialAuditPath("pkg/__init__.py", 1, true)).toBe(false);
  });
});

describe("isTrivialAuditPath is case-insensitive for __init__.py basename check", () => {
  it("uppercased basename and directory", () => {
    expect(isTrivialAuditPath("PKG/__INIT__.PY", 2)).toBe(true);
  });
});

// TST-f0b6f64e: lineCount=0 short-circuits before the __init__.py name check —
// any file with zero lines is trivial regardless of its name.
describe("isTrivialAuditPath returns true for a non-__init__.py file with lineCount 0", () => {
  it("regular .ts file with 0 lines is trivial", () => {
    expect(isTrivialAuditPath("src/generated/stub.ts", 0)).toBe(true);
  });

  it("regular .py file with 0 lines is trivial", () => {
    expect(isTrivialAuditPath("module/empty.py", 0)).toBe(true);
  });

  it("any file with 1 line is also trivial (lineCount <= 1 short-circuits)", () => {
    // lineCount <= 1 is a separate short-circuit that covers any file name.
    expect(isTrivialAuditPath("src/regular.ts", 1)).toBe(true);
  });
});

// ── autoCompleteTrivialCoverage — guard branches ──────────────────────────────

describe("autoCompleteTrivialCoverage skips files where required_lenses is already empty", () => {
  it("already-cleared file is not in skipped; file with lenses is excluded", () => {
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
    expect(!skipped.includes("pkg/__init__.py"), "already-cleared file must not be in skipped").toBeTruthy();

    // The file with required_lenses=['security'] must appear in skipped.
    expect(skipped.includes("pkg2/__init__.py"), "file with lenses must be in skipped").toBeTruthy();

    // The excluded file has audit_status='excluded'.
    const excluded = coverage.files.find((f) => f.path === "pkg2/__init__.py");
    expect(excluded.audit_status).toBe("excluded");

    // The already-cleared file retains its original audit_status unchanged.
    const unchanged = coverage.files.find((f) => f.path === "pkg/__init__.py");
    expect(unchanged.audit_status).toBe("pending");
  });
});

describe("autoCompleteTrivialCoverage does not re-exclude already-excluded files", () => {
  it("file with audit_status=excluded is skipped by the excluded guard", () => {
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
    expect(skipped.length).toBe(0);

    // Fields must be untouched.
    const file = coverage.files[0];
    expect(file.audit_status).toBe("excluded");
    expect(file.required_lenses).toEqual(["security"]);
  });
});
