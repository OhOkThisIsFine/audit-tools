import { expect, describe, it } from "vitest";
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
    expect(excluded!.audit_status).toBe("excluded");

    // The already-cleared file retains its original audit_status unchanged.
    const unchanged = coverage.files.find((f) => f.path === "pkg/__init__.py");
    expect(unchanged!.audit_status).toBe("pending");
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

// ── An UNMEASURED line count is not a zero line count (DAT-3c07c004) ─────────
//
// The line index carries THREE states, not two: a real count, the
// UNMEASURED_LINE_COUNT sentinel buildLineIndex writes when a file cannot be
// read, and `undefined` for a key it never carried. Both non-counts resolve
// through the one shared `isUnmeasuredLineCount` predicate. Withholding the
// SIZE rules from an unmeasured file must not withhold the PATH rules.

describe("isTrivialAuditPath withholds only the SIZE rules when the count is unmeasured", () => {
  it("the NaN sentinel is not a zero-line file", () => {
    expect(isTrivialAuditPath("src/unmeasured.ts", Number.NaN)).toBe(false);
  });

  it("an absent index entry (undefined) is not a zero-line file either", () => {
    expect(isTrivialAuditPath("src/unindexed.ts", undefined)).toBe(false);
  });

  it("a genuinely zero-line file is still trivial — the control", () => {
    expect(isTrivialAuditPath("src/empty.ts", 0)).toBe(true);
  });

  it("an unmeasured DOTFILE is still trivial by name", () => {
    expect(isTrivialAuditPath(".gitignore", Number.NaN)).toBe(true);
    expect(isTrivialAuditPath("nested/.gitattributes", undefined)).toBe(true);
  });

  it("an unmeasured __init__.py is NOT trivial — that rule is size-gated", () => {
    // The <=3-line rule cannot be applied to a file whose size is unknown.
    expect(isTrivialAuditPath("pkg/__init__.py", Number.NaN)).toBe(false);
  });

  it("an external signal still overrides everything, measured or not", () => {
    expect(isTrivialAuditPath(".gitignore", Number.NaN, true)).toBe(false);
  });
});

describe("autoCompleteTrivialCoverage leaves an unmeasured file un-excluded", () => {
  it("the unmeasured file keeps its lenses; a measured empty one and an unmeasured dotfile are excluded", () => {
    const coverage = {
      files: [
        {
          path: "src/unmeasured.ts",
          audit_status: "pending",
          classification_status: "classified",
          required_lenses: ["security"],
          completed_lenses: [],
          unit_ids: ["u1"],
        },
        {
          path: "src/empty.ts",
          audit_status: "pending",
          classification_status: "classified",
          required_lenses: ["security"],
          completed_lenses: [],
          unit_ids: ["u1"],
        },
        {
          path: ".gitignore",
          audit_status: "pending",
          classification_status: "classified",
          required_lenses: ["security"],
          completed_lenses: [],
          unit_ids: ["u1"],
        },
      ],
    };
    const lineIndex = {
      "src/unmeasured.ts": Number.NaN,
      "src/empty.ts": 0,
      ".gitignore": Number.NaN,
    };

    const skipped = autoCompleteTrivialCoverage(coverage, lineIndex);

    expect(
      skipped.includes("src/unmeasured.ts"),
      "an unmeasured file must not be excluded — this is the pass that decides its fate",
    ).toBe(false);
    expect(skipped.includes("src/empty.ts"), "a measured empty file is still excluded").toBe(true);
    expect(skipped.includes(".gitignore"), "an unmeasured dotfile is still excluded by name").toBe(true);

    const unmeasured = coverage.files.find((f) => f.path === "src/unmeasured.ts");
    expect(unmeasured!.audit_status, "it must stay auditable").toBe("pending");
    expect(unmeasured!.required_lenses, "its lenses must survive so a task can still be built").toEqual(["security"]);
  });
});
