vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>() }));
import * as fs from "node:fs";
import { expect, test, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { gitleaksCandidate } from "../../src/shared/analyzers/candidates.js";
import { runExternalAnalyzer } from "../../src/shared/analyzers/acquisitionEngine.js";

const fakeSecret = "FAKE_SECRET_FOR_OFFLINE_FIXTURE_ONLY";
const report = JSON.stringify([{ File: "fixture.ts", RuleID: "fake-rule", Secret: fakeSecret,
  Match: fakeSecret, Description: "Synthetic finding", Fingerprint: "fake-fingerprint" }]);
const ok = (stdout = "") => ({ argv: ["fake-never-spawned"], status: 0, stdout, stderr: "", duration_ms: 1 });

test("gitleaks requires invocation-owned context and full redaction", () => {
  expect(() => gitleaksCandidate.buildArgv(["fake"], "/repo")).toThrow(/report/i);
  const argv = gitleaksCandidate.buildArgv(["fake"], "/repo", { reportPath: "/private/report.json" });
  expect(argv).toContain("--redact=100");
  expect(argv[argv.indexOf("--report-path") + 1]).toBe("/private/report.json");
});

for (const scenario of ["success", "malformed", "missing", "unreadable", "throw", "error", "deadline", "argv-throw", "argv-deadline", "parse-throw"] as const) {
  test(`private report cleanup: ${scenario}`, async () => {
    let path = "";
    const deadline = { at: Date.now() + 60000 };
    const candidate = { ...gitleaksCandidate,
      buildArgv: (...args: Parameters<typeof gitleaksCandidate.buildArgv>) => {
        path = args[2]?.reportPath ?? "";
        if (scenario === "argv-throw") throw new Error(fakeSecret);
        if (scenario === "argv-deadline") deadline.at = Date.now() - 1;
        return gitleaksCandidate.buildArgv(...args);
      },
      ...(scenario === "parse-throw" ? { parse: () => { throw new Error(fakeSecret); } } : {}),
    };
    const outcome = await runExternalAnalyzer(candidate, "/repo", {
      deadline, resolvedBinaries: { gitleaks: "fake-never-spawned" },
      run: async argv => {
        path = argv[argv.indexOf("--report-path") + 1];
        expect(path).toBeTruthy();
        if (process.platform !== "win32") expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
        if (scenario === "unreadable") mkdirSync(path);
        else if (scenario !== "missing") writeFileSync(path, scenario === "malformed" ? fakeSecret : report);
        if (scenario === "success") expect(readFileSync(path, "utf8")).toContain(fakeSecret);
        if (scenario === "throw") throw new Error(fakeSecret);
        if (scenario === "deadline") deadline.at = Date.now() - 1;
        return { ...ok(fakeSecret), stderr: fakeSecret,
          ...(scenario === "error" ? { error: new Error(fakeSecret) } : {}) };
      },
    });
    expect(path).toBeTruthy();
    expect(existsSync(dirname(path))).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain(fakeSecret);
    expect(outcome.status.status).toBe(scenario === "success" ? "findings" :
      ["deadline", "argv-deadline"].includes(scenario) ? "not_resolved" : ["throw", "error", "argv-throw"].includes(scenario) ? "spawn_error" : "parse_error");
  });
}

test("concurrent invocations never share report paths", async () => {
  const paths: string[] = [];
  let release!: () => void;
  const bothStarted = new Promise<void>(resolve => { release = resolve; });
  const invoke = () => runExternalAnalyzer(gitleaksCandidate, "/repo", {
    resolvedBinaries: { gitleaks: "fake-never-spawned" }, run: async argv => {
      const path = argv[argv.indexOf("--report-path") + 1];
      paths.push(path);
      writeFileSync(path, "[]");
      if (paths.length === 2) release();
      await bothStarted;
      expect(paths[0]).not.toBe(paths[1]);
      return ok();
    },
  });
  const results = await Promise.all([invoke(), invoke()]);
  expect(results.map(r => r.status.status)).toEqual(["success", "success"]);
  for (const path of paths) expect(existsSync(dirname(path))).toBe(false);
});


test("cleanup failure preserves the scan diagnostic without raw error text", async () => {
  let directory = "";
  const remove = fs.rmSync;
  const spy = vi.spyOn(fs, "rmSync").mockImplementation(() => { throw new Error(fakeSecret); });
  try {
    const outcome = await runExternalAnalyzer(gitleaksCandidate, "/repo", {
      resolvedBinaries: { gitleaks: "fake" }, run: async argv => {
        directory = dirname(argv[argv.indexOf("--report-path") + 1]);
        return { ...ok(), error: new Error(fakeSecret) };
      },
    });
    expect(outcome.status.status).toBe("spawn_error");
    expect(outcome.status.error).toContain("analyzer execution failed");
    expect(outcome.status.error).toContain("cleanup failed");
    expect(JSON.stringify(outcome)).not.toContain(fakeSecret);
  } finally {
    spy.mockRestore();
    if (directory) remove(directory, { recursive: true, force: true });
  }
});

test("POSIX isolation failure refuses the runner and cleans the allocation", async () => {
  if (process.platform === "win32") return;
  let directory = "";
  const spy = vi.spyOn(fs, "chmodSync").mockImplementation(path => {
    directory = String(path);
    throw new Error(fakeSecret);
  });
  const runner = vi.fn(async () => ok());
  try {
    const outcome = await runExternalAnalyzer(gitleaksCandidate, "/repo", {
      resolvedBinaries: { gitleaks: "fake" }, run: runner,
    });
    expect(outcome.status.status).toBe("spawn_error");
    expect(runner).not.toHaveBeenCalled();
    expect(directory).toBeTruthy();
    expect(existsSync(directory)).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain(fakeSecret);
  } finally { spy.mockRestore(); }
});

test("stdout candidates retain two-argument builders and ordinary diagnostics", async () => {
  const outcome = await runExternalAnalyzer({ ...gitleaksCandidate, managedReport: false,
    buildArgv: (prefix, root) => [...prefix, root], parse: () => [],
  }, "/repo", { resolvedBinaries: { gitleaks: "fake" }, run: async () => ok("[]") });
  expect(outcome.status.status).toBe("success");
});


test("legacy report callbacks are evaluated once and missing files fail", async () => {
  const directory = fs.mkdtempSync(join(tmpdir(), "legacy-report-"));
  const path = join(directory, "report.json");
  const reportFile = vi.fn(() => path);
  try {
    const outcome = await runExternalAnalyzer({ ...gitleaksCandidate, managedReport: false,
      reportFile, buildArgv: prefix => prefix, parse: () => [],
    }, "/repo", { resolvedBinaries: { gitleaks: "fake" }, run: async () => ok() });
    expect(reportFile).toHaveBeenCalledTimes(1);
    expect(outcome.status.status).toBe("parse_error");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

// Independent review regressions, retained alongside the lifecycle cases.
for (const assignedAt of ["builder", "runner"] as const) {
  test(`legacy path assigned by ${assignedAt} is read and cleaned`, async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "review-legacy-"));
    let path = "";
    try {
      const candidate = { ...gitleaksCandidate, managedReport: false,
        buildArgv: (prefix: string[]) => {
          if (assignedAt === "builder") path = join(directory, "report.json");
          return prefix;
        },
        reportFile: () => path,
      };
      const outcome = await runExternalAnalyzer(candidate, "/repo", {
        resolvedBinaries: { gitleaks: "fake" }, run: async () => {
          if (assignedAt === "runner") path = join(directory, "report.json");
          writeFileSync(path, "[]");
          return ok();
        },
      });
      expect(outcome.status.status).toBe("success");
      expect(existsSync(path)).toBe(false);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
}

for (const withFindings of [false, true]) {
  test(`managed parser notes do not leak secrets (${withFindings ? "findings" : "failure"})`, async () => {
    const candidate = { ...gitleaksCandidate, parse: () => ({
      items: withFindings ? [{ id: "fake", path: "fixture.ts", summary: "Synthetic finding" }] : [],
      parse_failed: !withFindings, note: fakeSecret,
    }) };
    const outcome = await runExternalAnalyzer(candidate, "/repo", {
      resolvedBinaries: { gitleaks: "fake" }, run: async argv => {
        writeFileSync(argv[argv.indexOf("--report-path") + 1], "[]");
        return ok();
      },
    });
    expect(JSON.stringify(outcome)).not.toContain(fakeSecret);
    expect(outcome.status.status).toBe(withFindings ? "findings" : "parse_error");
  });
}

for (const withFindings of [false, true]) {
  test(`managed measurement failure with exit zero stays private (${withFindings ? "findings" : "empty"})`, async () => {
    let reportPath = "";
    const candidate = { ...gitleaksCandidate, parse: () => ({
      items: withFindings ? [{ id: "fake", path: "fixture.ts", summary: "Synthetic finding" }] : [],
      measurement_failed: true, note: fakeSecret,
    }) };
    const outcome = await runExternalAnalyzer(candidate, "/repo", {
      resolvedBinaries: { gitleaks: "fake" }, run: async argv => {
        reportPath = argv[argv.indexOf("--report-path") + 1];
        writeFileSync(reportPath, fakeSecret);
        return { ...ok(fakeSecret), stderr: fakeSecret };
      },
    });
    expect(outcome.status.status).toBe("failed");
    expect(outcome.status.exit_code).toBe(0);
    expect(outcome.results.results).toHaveLength(Number(withFindings));
    expect(outcome.status.error).toBe("analyzer reported degraded output (private report)");
    expect(outcome.status).not.toHaveProperty("output_snippet");
    expect(outcome.status).not.toHaveProperty("stderr_snippet");
    expect(JSON.stringify(outcome)).not.toContain(fakeSecret);
    expect(existsSync(dirname(reportPath))).toBe(false);
  });
}
