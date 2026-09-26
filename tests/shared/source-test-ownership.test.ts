/**
 * Source → test ownership: the EXECUTION-REACH classifier and the ownership gate
 * that turn "which test asserts this source" from an author's word into a
 * mechanical distinction between EXECUTION REACH (does the test actually RUN the
 * subject) and BEHAVIOURAL EVIDENCE (does it assert on what the subject declares).
 *
 * The defect this closes (O11 / O36): two pinning mechanisms bind a source to a
 * test NAME, and the name was author-supplied — the gate measured "the named test
 * exists" rather than "the named test runs this code". O36 demanded reach be
 * established by EXECUTION, not by the author's word about their own import
 * statements — so the prior static proxy (transitive import closure + disk-path
 * literal scan) is replaced here by RUNTIME COVERAGE: the test is executed in
 * isolation under `@vitest/coverage-v8` and the subject's own coverage record is
 * inspected for a line that actually ran.
 *
 * THREE KINDS OF ASSERTION, and the split matters:
 *   • the EXECUTION-REACH decision (`executionReached`, `recordReached`) is
 *     driven against fixture coverage maps, so every verdict — including the
 *     "loaded but never executed" all-zero record that a static import graph
 *     CANNOT detect — is exercised without a real run;
 *   • the BEHAVIOURAL classifier (`subjectExports` / `bindings` / `assertsBehavior`)
 *     is driven against fixture sources, unchanged, so reach-without-assertion is
 *     reported distinctly;
 *   • the OWNERSHIP GATE (`reconcileSourceTestOwnership`) is driven against a
 *     SCRIPTED reach resolver, so the missing-reach (unrelated vs never-executes)
 *     and missing-behaviour diagnostics fire without touching the real tree;
 * The real map runs through the standalone `check:source-test-ownership` gate.
 * Running nested Vitest processes inside this Vitest worker can exceed its RPC
 * heartbeat even when every inner test passes.
 */
import { describe, expect, it } from "vitest";
import {
  assertsBehavior,
  bindings,
  executionReached,
  recordReached,
  subjectExports,
} from "../../scripts/shared/source-test-reach.mjs";
import {
  classifyBinding,
  reconcileSourceTestOwnership,
} from "../../scripts/check-source-test-ownership.mjs";

describe("the execution-reach classifier — runtime coverage, not import closure", () => {
  it("reached when any subject line carries a positive hit count", () => {
    expect(recordReached({ "26": 1, "33": 0 })).toBe(true);
    expect(recordReached({ "26": 79 })).toBe(true);
  });

  it("NOT reached when every subject line is zero-count — loaded, never executed", () => {
    expect(recordReached({ "26": 0, "33": 0 })).toBe(false);
  });

  it("NOT reached for an empty record (subject absent from the report)", () => {
    expect(recordReached({})).toBe(false);
    expect(recordReached(undefined)).toBe(false);
  });

  it("matches the subject by repo-relative suffix and skips text:// virtual modules", () => {
    const merged: Record<string, { s?: Record<string, number> } | undefined> = {
      "file:///C:/repo/src/subject.ts": { s: { "7": 1 } },
      "text://virtual.test.ts": { s: { "1": 5 } },
    };
    expect(executionReached(merged, "src/subject.ts")).toEqual({ reached: true, hasRecord: true });
    expect(executionReached(merged, "text://virtual.test.ts")).toEqual({
      reached: false,
      hasRecord: false,
    });
    expect(executionReached(merged, "src/other.ts")).toEqual({ reached: false, hasRecord: false });
  });

  it("reports hasRecord but not reached for an all-zero subject record", () => {
    const merged: Record<string, { s?: Record<string, number> } | undefined> = {
      "/repo/src/subject.ts": { s: { "1": 0, "2": 0 } },
    };
    expect(executionReached(merged, "src/subject.ts")).toEqual({ reached: false, hasRecord: true });
  });
});

describe("the behavioural classifier — reach is necessary but not sufficient", () => {
  it("detects an assertion on a subject export under its own name", () => {
    const testText = 'import { pinned } from "../../src/subject.js"; test("x", () => expect(pinned).toBe(1));';
    expect(assertsBehavior(testText, ["pinned", "other"])).toEqual(["pinned"]);
  });

  it("detects an assertion on an ALIASED subject export (the X as XImpl wrapper)", () => {
    const testText = 'import { GUARDS as LIVE_GUARDS } from "../../scripts/guard-reach-data.mjs"; test("x", () => expect(LIVE_GUARDS.length).toBeGreaterThan(0));';
    expect(assertsBehavior(testText, ["GUARDS", "REACH"])).toEqual(["GUARDS"]);
  });

  it("reports NO behavioural evidence for a binding never used beyond the import", () => {
    // Reach exists (the import), but the bound name is not used anywhere after.
    const testText = 'import { pinned } from "../../src/subject.js"; test("x", () => expect(1).toBe(1));';
    expect(assertsBehavior(testText, ["pinned"])).toEqual([]);
  });

  it("records bindings with their remote names for alias mapping", () => {
    expect(bindings('import { a, b as c } from "m";')).toEqual([
      { local: "a", remote: "a" },
      { local: "c", remote: "b" },
    ]);
  });

  it("computes a subject's declared exports", () => {
    expect(
      subjectExports("export function f() {}\nexport const G = 1;\nexport class K {}"),
    ).toEqual(["f", "G", "K"]);
  });
});

describe("the ownership gate — distinct never-executes vs unrelated vs missing-behaviour", () => {
  const row = (source: string, tests: string[]) => ({ source, tests, what: "pins a fact" });
  const reader = (files: Record<string, string>) => (rel: string) => {
    const key = rel.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!(key in files)) throw new Error(`ENOENT ${key}`);
    return files[key]!;
  };
  const subject = "export const pinned = 1;";
  const asserting = 'import { pinned } from "../../src/subject.js"; test("x", () => expect(pinned).toBe(1));';
  const importOnly = 'import { pinned } from "../../src/subject.js"; test("x", () => expect(1).toBe(1));';

  const reachedResolve = () => ({ reached: true, hasRecord: true, testFailed: false });
  const neverExecResolve = () => ({ reached: false, hasRecord: true, testFailed: false });
  const unrelatedResolve = () => ({ reached: false, hasRecord: false, testFailed: false });

  it("passes a row whose test executes AND asserts on the subject", () => {
    const files = { "src/subject.ts": subject, "tests/own.test.ts": asserting };
    const { errors, reachable, total } = reconcileSourceTestOwnership(
      [row("src/subject.ts", ["tests/own.test.ts"])],
      new Set(["src/subject.ts", "tests/own.test.ts"]),
      reader(files),
      reachedResolve,
    );
    expect(errors).toEqual([]);
    expect(reachable).toBe(1);
    expect(total).toBe(1);
  });

  it("refuses a test that IMPORTS but NEVER EXECUTES the subject as never-executes", () => {
    // This is the defect a static import-closure proxy cannot see: the import
    // edge exists, but the resolved reach is an all-zero record.
    const files = { "src/subject.ts": subject, "tests/import-only.test.ts": asserting };
    const { errors } = reconcileSourceTestOwnership(
      [row("src/subject.ts", ["tests/import-only.test.ts"])],
      new Set(["src/subject.ts", "tests/import-only.test.ts"]),
      reader(files),
      neverExecResolve,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("missing-reach: never-executes");
    expect(errors[0]).not.toContain("missing-behaviour");
  });

  it("refuses an UNRELATED test as missing-reach: unrelated, naming it distinctly", () => {
    const files = { "src/subject.ts": subject, "tests/unrelated.test.ts": 'test("x", () => expect(1).toBe(1));' };
    const { errors } = reconcileSourceTestOwnership(
      [row("src/subject.ts", ["tests/unrelated.test.ts"])],
      new Set(["src/subject.ts", "tests/unrelated.test.ts"]),
      reader(files),
      unrelatedResolve,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("missing-reach: unrelated");
    expect(errors[0]).not.toContain("missing-behaviour");
    expect(errors[0]).not.toContain("never-executes");
  });

  it("refuses an UNDER-ASSERTING test as missing-behaviour (reach holds, no assertion)", () => {
    const files = { "src/subject.ts": subject, "tests/import-only.test.ts": importOnly };
    const { errors } = reconcileSourceTestOwnership(
      [row("src/subject.ts", ["tests/import-only.test.ts"])],
      new Set(["src/subject.ts", "tests/import-only.test.ts"]),
      reader(files),
      reachedResolve,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("missing-behaviour");
    expect(errors[0]).not.toContain("missing-reach");
  });

  it("measures reach separately when one test owns two sources", () => {
    const sources: string[] = [];
    const files = {
      "src/first.ts": "export const first = 1;",
      "src/second.ts": "export const second = 2;",
      "tests/both.test.ts": 'import { first } from "../src/first.js"; import { second } from "../src/second.js"; test("both", () => { expect(first).toBe(1); expect(second).toBe(2); });',
    };
    const { errors } = reconcileSourceTestOwnership(
      [row("src/first.ts", ["tests/both.test.ts"]), row("src/second.ts", ["tests/both.test.ts"])],
      new Set(Object.keys(files)),
      reader(files),
      (source) => {
        sources.push(source);
        return { reached: source === "src/first.ts", hasRecord: source === "src/first.ts", testFailed: false };
      },
    );
    expect(sources).toEqual(["src/first.ts", "src/second.ts"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("src/second.ts");
    expect(errors[0]).toContain("missing-reach");
  });

  it("refuses a red owning test even when it executed the subject", () => {
    const files = { "src/subject.ts": subject, "tests/own.test.ts": asserting };
    const { errors } = reconcileSourceTestOwnership(
      [row("src/subject.ts", ["tests/own.test.ts"])],
      new Set(Object.keys(files)),
      reader(files),
      () => ({ reached: true, hasRecord: true, testFailed: true }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("FAILED when run in isolation");
  });

  it("refuses a binding when the coverage report cannot be read", () => {
    const files = { "src/subject.ts": subject, "tests/own.test.ts": asserting };
    const { errors, unverifiable } = reconcileSourceTestOwnership(
      [row("src/subject.ts", ["tests/own.test.ts"])],
      new Set(Object.keys(files)),
      reader(files),
      () => ({ reached: false, hasRecord: false, testFailed: true, diagnostics: "coverage report unreadable" }),
    );
    expect(unverifiable).toBe(1);
    expect(errors).toHaveLength(2); // unavailable coverage and the red owning test
    expect(errors.join("\n")).toContain("cannot pass");
    expect(errors.join("\n")).toContain("coverage report unreadable");
  });

  it("refuses a row naming an untracked subject or test", () => {
    const { errors } = reconcileSourceTestOwnership(
      [row("src/missing.ts", ["tests/x.test.ts"])],
      new Set(["tests/x.test.ts"]),
      reader({ "tests/x.test.ts": 'test("x", () => {});' }),
      reachedResolve,
    );
    expect(errors.some((e) => e.includes("NOT a tracked file"))).toBe(true);
  });

  it("classifies a green run with a zero-count record as never-executes (not unrelated)", () => {
    const verdict = classifyBinding({
      source: "src/subject.ts",
      test: "tests/x.test.ts",
      subjectText: subject,
      testText: asserting,
      resolveReach: () => ({ reached: false, hasRecord: true, testFailed: false }),
    });
    expect(verdict.verdict).toBe("never-executes");
  });

  it("classifies an all-zero record on a FAILED run as never-executes (advisory, not a pass)", () => {
    const verdict = classifyBinding({
      source: "src/subject.ts",
      test: "tests/x.test.ts",
      subjectText: subject,
      testText: asserting,
      resolveReach: () => ({ reached: false, hasRecord: true, testFailed: true }),
    });
    expect(verdict.verdict).toBe("never-executes");
  });
});
