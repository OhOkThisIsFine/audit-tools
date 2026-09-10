// Live external-analyzer normalizer tests, extracted from the deleted
// tests/audit/adapters-remediation.test.ts when the superseded
// src/audit/adapters/ set was removed (CY-01, ceremony review 2026-08-29).
// Everything here targets src/shared/analyzers/* — the live normalization seam.
import { test, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeGenericExternalResults } from "../../src/shared/analyzers/normalizeExternal.js";
import { normalizeClippyJson, parseClippy } from "../../src/shared/analyzers/clippy.js";
import { normalizeRubocopJson, parseRubocop } from "../../src/shared/analyzers/rubocop.js";
import { VALID_SEVERITIES } from "../../src/shared/types/lens.js";

test("normalizeGenericExternalResults maps absent severity to 'info' (COR-0a17639f)", () => {
  const result = normalizeGenericExternalResults("my-tool", [
    { path: "src/a.ts", summary: "finding with no severity" },
  ]);
  expect(result.results.length).toBe(1);
  expect(result.results[0].severity).toBe("info");
  expect(VALID_SEVERITIES.has(result.results[0].severity), `severity '${result.results[0].severity}' must be a member of the schema enum`).toBeTruthy();
});

// --- CP-NODE-1: dedicated clippy / rubocop severity adapters ---

const CLIPPY_STREAM = [
  JSON.stringify({
    reason: "compiler-message",
    message: {
      level: "error",
      message: "mismatched types",
      code: { code: "E0308" },
      spans: [{ file_name: "src/lib.rs", line_start: 3, line_end: 3, is_primary: true }],
    },
  }),
  JSON.stringify({
    reason: "compiler-message",
    message: {
      level: "warning",
      message: "unused import",
      code: { code: "clippy::unused" },
      spans: [{ file_name: "src/main.rs", line_start: 1, line_end: 1, is_primary: true }],
    },
  }),
].join("\n");

test("normalizeClippyJson maps clippy severities and validates through the generic seam", () => {
  const normalized = normalizeClippyJson(CLIPPY_STREAM);
  expect(normalized.tool).toBe("clippy");
  expect(normalized.results.map((r) => ({ severity: r.severity, path: r.path, rule: r.rule }))).toEqual([
      { severity: "high", path: "src/lib.rs", rule: "E0308" },
      { severity: "medium", path: "src/main.rs", rule: "clippy::unused" },
    ]);
  for (const r of normalized.results) {
    expect(VALID_SEVERITIES.has(r.severity), `severity '${r.severity}' must be a schema enum member`).toBeTruthy();
  }
});

test("normalizeClippyJson downgrades malformed input to an empty result set (no throw)", () => {
  for (const bad of ["", "not json", "{}", "garbage\nmore garbage"]) {
    const normalized = normalizeClippyJson(bad);
    expect(normalized.tool).toBe("clippy");
    expect(normalized.results).toEqual([]);
  }
  expect(parseClippy("not json")).toEqual([]);
});

const RUBOCOP_REPORT = JSON.stringify({
  files: [
    {
      path: "app/foo.rb",
      offenses: [
        { severity: "fatal", message: "fatal issue", cop_name: "Lint/Fatal", location: { start_line: 2 } },
        { severity: "convention", message: "style nit", cop_name: "Style/Nit", location: { line: 9 } },
      ],
    },
  ],
});

test("normalizeRubocopJson maps rubocop severities (fatal→high, convention→low) through the generic seam", () => {
  const normalized = normalizeRubocopJson(RUBOCOP_REPORT);
  expect(normalized.tool).toBe("rubocop");
  expect(normalized.results.map((r) => ({ severity: r.severity, path: r.path, rule: r.rule, line_start: r.line_start }))).toEqual([
      { severity: "high", path: "app/foo.rb", rule: "Lint/Fatal", line_start: 2 },
      { severity: "low", path: "app/foo.rb", rule: "Style/Nit", line_start: 9 },
    ]);
  for (const r of normalized.results) {
    expect(VALID_SEVERITIES.has(r.severity), `severity '${r.severity}' must be a schema enum member`).toBeTruthy();
  }
});

test("normalizeRubocopJson downgrades malformed input to an empty result set (no throw)", () => {
  for (const bad of ["", "not json", "{}", JSON.stringify({ files: "nope" })]) {
    const normalized = normalizeRubocopJson(bad);
    expect(normalized.tool).toBe("rubocop");
    expect(normalized.results).toEqual([]);
  }
  expect(parseRubocop("not json")).toEqual([]);
});

test("normalizeGenericExternalResults maps native severity aliases onto schema enum (COR-0a17639f)", () => {
  const cases = [
    { input: "WARNING",    expected: "medium" },
    { input: "ERROR",      expected: "high" },
    { input: "moderate",   expected: "medium" },
    { input: "note",       expected: "info" },
    { input: "critical",   expected: "critical" },
    { input: "low",        expected: "low" },
    { input: "foobar",     expected: "info" },
    { input: "high",       expected: "high" },
    { input: "info",       expected: "info" },
    { input: "hint",       expected: "info" },
  ];
  for (const { input, expected } of cases) {
    const result = normalizeGenericExternalResults("test-tool", [
      { path: "src/x.ts", summary: "test finding", severity: input },
    ]);
    expect(result.results[0].severity, `severity '${input}' should map to '${expected}'`).toBe(expected);
  }
});

// ── CP-NODE-1(a): the adapter entry points must be able to persist a
// repo-RELATIVE path. Both tools are handed the ABSOLUTE repository root as
// their target and echo absolute paths back, so an adapter that offers no way to
// pass the root persists a machine-specific path — un-joinable against every
// repo-relative consumer, and unreadable by the provenance reader
// (`join(root, "/abs/path")` names nothing).
test("normalizeClippyJson rebases absolute paths onto the repo root", () => {
  const root = join(tmpdir(), "adapter-rebase-repo");
  const stdout = JSON.stringify({
    reason: "compiler-message",
    message: {
      level: "error",
      message: "mismatched types",
      code: { code: "E0308" },
      spans: [{ file_name: join(root, "src", "lib.rs"), line_start: 3, line_end: 3, is_primary: true }],
    },
  });
  const normalized = normalizeClippyJson(stdout, root);
  expect(
    normalized.results[0].path,
    "an absolute path in the persisted artifact is machine-specific and never joins",
  ).toBe("src/lib.rs");
});

test("normalizeRubocopJson rebases absolute paths onto the repo root", () => {
  const root = join(tmpdir(), "adapter-rebase-rubocop");
  const normalized = normalizeRubocopJson(
    JSON.stringify({
      files: [
        {
          path: join(root, "app", "foo.rb"),
          offenses: [
            { severity: "warning", message: "nit", cop_name: "Style/Nit", location: { line: 9 } },
          ],
        },
      ],
    }),
    root,
  );
  expect(normalized.results[0].path).toBe("app/foo.rb");
});

test("a path outside the repo root is left as reported, never silently rewritten", () => {
  // The tool may legitimately name something that is not in the repo; inventing a
  // repo-relative identity for it would be a lie about what it reported.
  const root = join(tmpdir(), "adapter-rebase-inside");
  const outside = join(tmpdir(), "adapter-rebase-outside", "lib.rs");
  const normalized = normalizeClippyJson(
    JSON.stringify({
      reason: "compiler-message",
      message: {
        level: "error",
        message: "x",
        code: { code: "E1" },
        spans: [{ file_name: outside, line_start: 1, is_primary: true }],
      },
    }),
    root,
  );
  // Asserted on the IDENTITY, not the exact string: the shared path helper folds
  // separators to "/" on the way through, so the value is not byte-identical to
  // the input — but it must still name the file the tool reported, not a
  // repo-relative invention.
  const reported = normalized.results[0].path;
  expect(reported, "a path outside the root must not be rebased into it").not.toBe("lib.rs");
  expect(reported).toContain("adapter-rebase-outside");
  expect(reported).toContain("lib.rs");
});
