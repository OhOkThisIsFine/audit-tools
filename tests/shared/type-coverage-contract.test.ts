import { test, expect } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { runExternalAnalyzer } from "../../src/shared/analyzers/acquisitionEngine.js";
import { isDegradedExternalAnalyzerStatus } from "../../src/shared/analyzers/types.js";
import { typeCoverageCandidate, parseTypeCoverage } from "../../src/shared/analyzers/candidates.js";

// Opt-in real-tool qualification: install the fixture's lock with npm ci
// --ignore-scripts in a disposable tools directory, then point this variable at it.
// Ordinary unit runs use the captured CLI JSON in analyzer-candidates.test.ts.
const toolsRoot = process.env.AUDIT_TYPE_COVERAGE_TOOLS;
const fixture = new URL("../fixtures/type-coverage-2.29.7/", import.meta.url);

test.skipIf(!toolsRoot)("pinned CLI honors observe-only flags despite project write settings", async () => {
  const tools = resolve(toolsRoot!);
  const lock = JSON.parse(await readFile(new URL("tool-package-lock.json", fixture), "utf8"));
  for (const name of ["type-coverage", "typescript", "type-coverage-core", "minimist"]) {
    const pkg = JSON.parse(await readFile(join(tools, "node_modules", name, "package.json"), "utf8"));
    expect(pkg.version).toBe(lock.packages[`node_modules/${name}`].version);
  }
  expect(lock.packages["node_modules/type-coverage"].version).toBe("2.29.7");
  expect(lock.packages["node_modules/typescript"].version).toBe("5.9.3");
  const root = await mkdtemp(join(tmpdir(), "type-coverage-read-only-"));
  const project = join(root, "project");
  const sentinel = join(root, "outside-project");
  const home = join(root, "home");
  const snapshot = async (dir: string): Promise<Record<string, string>> => {
    const result: Record<string, string> = {};
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        for (const [key, value] of Object.entries(await snapshot(path))) result[`${entry.name}/${key}`] = value;
      } else result[entry.name] = (await readFile(path)).toString("base64");
    }
    return result;
  };
  try {
    for (const dir of [project, sentinel, home]) await mkdir(dir);
    await writeFile(join(project, "tsconfig.json"), await readFile(new URL("tsconfig.json", fixture)));
    const source = await readFile(new URL("index.ts", fixture), "utf8");
    await writeFile(join(project, "index.ts"), source);
    await writeFile(join(sentinel, "keep.txt"), "sentinel bytes\n");
    const historyFile = join(sentinel, "history.json");
    const cacheDirectory = join(sentinel, "cache");
    const configs = [
      { update: true, atLeast: -1 }, { updateIfHigher: true, atLeast: -1 },
      { historyFile }, { cache: true, cacheDirectory },
      { update: true, updateIfHigher: true, historyFile, cache: true, cacheDirectory },
      { update: true, historyFile: "history.json", cache: true, cacheDirectory: ".cache" },
    ];
    const run = (args: string[] = []) => spawnSync(process.execPath,
      typeCoverageCandidate.buildArgv([join(tools, "node_modules/type-coverage/bin/type-coverage")], project).concat(args),
      { cwd: project, encoding: "utf8", timeout: 20_000, env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CACHE_HOME: join(home, "cache") } });
    const expected = JSON.parse(await readFile(new URL("any.json", fixture), "utf8"));
    for (const config of configs) {
      await writeFile(join(project, "package.json"), JSON.stringify({ typeCoverage: { showRelativePath: true, ...config } }) + "\n");
      const before = await snapshot(root);
      const result = run();
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const actual = JSON.parse(result.stdout);
      expect(actual.details).toEqual(expected.details);
      expect(actual.succeeded).toBe(true);
      expect(await snapshot(root)).toEqual(before);
    }
    // Preserve user strictness/thresholds and nonzero status; do not override them
    // merely to manufacture a clean measurement.
    await writeFile(join(project, "package.json"), JSON.stringify({ typeCoverage: { atLeast: 100, strict: true } }));
    const before = await snapshot(root);
    const failed = run();
    expect(failed.status).toBe(1);
    const failedJson = JSON.parse(failed.stdout);
    expect(failedJson.atLeast).toBe(100);
    expect(failedJson.succeeded).toBe(false);
    expect(failedJson.details.every((row: { filePath: string }) => row.filePath === join(project, "index.ts"))).toBe(true);
    expect(parseTypeCoverage(failed.stdout).items.length).toBeGreaterThan(0);
    expect(await snapshot(root)).toEqual(before);
    await writeFile(join(project, "package.json"), JSON.stringify({ typeCoverage: { atLeast: 100, suppressError: true } }));
    const suppressedBefore = await snapshot(root);
    const suppressed = run();
    expect(suppressed.status).toBe(0);
    expect(JSON.parse(suppressed.stdout).succeeded).toBe(false);
    const outcome = await runExternalAnalyzer(typeCoverageCandidate, project, {
      run: async (argv) => argv.includes("--version")
        ? { status: 0, stdout: "1.0.0", stderr: "", argv, duration_ms: 1 }
        : { status: suppressed.status, stdout: suppressed.stdout, stderr: suppressed.stderr, argv, duration_ms: 1 },
    });
    expect(outcome.results.results.length).toBeGreaterThan(0);
    expect(outcome.status.status).toBe("failed");
    expect(outcome.status.exit_code).toBe(0);
    expect(outcome.status.error).toContain("lower than the target(100%)");
    expect(outcome.status.dropped_rows ?? 0).toBe(0);
    expect(isDegradedExternalAnalyzerStatus(outcome.status)).toBe(true);
    expect(await snapshot(root)).toEqual(suppressedBefore);
    await writeFile(join(project, "index.ts"), "export const first: number = 1;\n");
    await writeFile(join(project, "package.json"), "{}\n");
    const clean = run();
    expect(clean.status).toBe(0);
    expect(JSON.parse(clean.stdout)).toEqual(JSON.parse(await readFile(new URL("clean.json", fixture), "utf8")));
    const error = run(["--project", "missing.json"]);
    expect(error.status).toBe(1);
    expect(JSON.parse(error.stdout)).toEqual(JSON.parse(await readFile(new URL("error.json", fixture), "utf8")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
