import { afterEach, expect, test } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSyncHidden } from "../helpers/spawn.mjs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { shardSuffix } from "../../scripts/shared/vitestShard.mjs";
import { checkDeclaredClaims } from "../../scripts/shared/loopCoreClosure.mjs";

const fixtures: string[] = [];
function fixture() {
  const path = mkdtempSync(join(tmpdir(), "script entry #"));
  fixtures.push(path);
  return path;
}
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function node(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSyncHidden(process.execPath, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
}
function copySources(root: string, paths: string[]) {
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(resolve(path), join(root, path));
  }
}
function moduleUrl(path: string) { return JSON.stringify(pathToFileURL(resolve(path)).href); }

test.each([
  ["1/4", "-shard1of4"], ["2/4", "-shard2of4"], ["0/4", null], ["5/4", null],
  ["1/0", null], ["1/4suffix", null], ["prefix2/4", null], ["1/4=extra", null], ["", null],
])("shard identity is unambiguous for %s", (value, suffix) => {
  for (const argv of [["--shard", value!], ["--shard=" + value]]) {
    if (suffix === null) expect(() => shardSuffix(argv)).toThrow(/shard/i);
    else expect(shardSuffix(argv)).toBe(suffix);
  }
  expect(shardSuffix(["--shards=2/4"])).toBe("");
  expect(shardSuffix([])).toBe("");
});

test("the timing reporter writes distinct latest and history records for split shard flags", () => {
  const root = fixture();
  copySources(root, ["vitest-timing-reporter.mjs", "vitestShard.mjs", "profile.mjs", "spawn-shell.mjs", "primitives.mjs"].map(f => "scripts/shared/" + f));
  const driver = join(root, "run.mjs");
  writeFileSync(driver, `import Reporter from "./scripts/shared/vitest-timing-reporter.mjs";
    new Reporter().onFinished([{filepath: "tests/shared/example.test.ts", tasks: [{type:"test", name:"pass", result:{state:"pass"}}]}]);`);
  for (const [shard, args] of [["1", ["--shard", "1/4"]], ["2", ["--shard", "2/4"]], ["3", ["--shard=3/4"]]] as const) {
    const r = node(root, [driver, ...args], { VITEST_GATE_TOKEN: shard, GITHUB_STEP_SUMMARY: "" });
    expect(r.status, r.stderr).toBe(0);
    for (const suffix of ["latest.json", "history.ndjson"]) {
      const record = JSON.parse(readFileSync(join(root, ".audit-tools-profile", "vitest-shard" + shard + "of4-" + suffix), "utf8"));
      expect(record.runToken).toBe(shard);
      expect(record.outcome.passed).toBe(1);
    }
  }
});

test.each(["check-doc-links", "check-memory-citations"])("%s import returns without running its CLI", (name) => {
  const root = fixture();
  const driver = join(root, "importer-" + name + ".mjs");
  writeFileSync(driver, 'await import(' + moduleUrl("scripts/" + name + ".mjs") + '); console.log("returned");');
  const r = node(root, [driver], { AUDIT_TOOLS_MEMORY_DIR: join(root, "absent") });
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout.trim()).toBe("returned");
  expect(r.stderr).toBe("");
});

test("triage API ignores an importer's positional output path", () => {
  const root = fixture();
  mkdirSync(join(root, ".audit-tools"));
  const driver = join(root, "importer.mjs");
  writeFileSync(driver, 'const { main } = await import(' + moduleUrl("scripts/shared/triage-backlog.mjs") + '); await main({root:process.cwd(), entries:[]});');
  const r = node(root, [driver, join(root, "unrelated.jsonl")], { CLAUDE_PROJECT_DIR: root });
  expect(r.status, r.stderr).toBe(0);
  expect(existsSync(join(root, ".audit-tools", "backlog-triage-coverage.json"))).toBe(true);
  expect(existsSync(join(root, "unrelated-coverage.json"))).toBe(false);
});

test("guard generator really runs at a path containing # and leaves imports inert", () => {
  const root = fixture();
  const script = "scripts/shared/generate-guard-reach-paths.mjs";
  copySources(root, [script, "scripts/shared/argvGuard.mjs", "scripts/shared/primitives.mjs", "scripts/check-sites-pinned.mjs", "src/audit/contracts/workerSchemas.ts"]);
  const target = join(root, "scripts/shared/guard-reach-derived-paths.generated.mjs");
  const driver = join(root, "importer.mjs");
  writeFileSync(driver, 'await import("./' + script + '");');
  expect(node(root, [driver]).status).toBe(0);
  expect(existsSync(target)).toBe(false);
  const stale = node(root, [script, "--check"]);
  expect(stale.status, stale.stderr).toBe(1);
  expect(node(root, [script]).status).toBe(0);
  expect(existsSync(target)).toBe(true);
  expect(node(root, [script, "--check"]).status).toBe(0);
});

test("triage CLI keeps its positional output for an empty backlog", () => {
  const root = fixture();
  mkdirSync(join(root, "docs/backlog"), { recursive: true });
  for (const name of ["open-bugs", "forward-tracks", "deferred"]) writeFileSync(join(root, "docs/backlog", name + ".md"), "");
  const result = node(root, [resolve("scripts/shared/triage-backlog.mjs"), join(root, "chosen.jsonl")], { CLAUDE_PROJECT_DIR: root });
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(join(root, "chosen-coverage.json"))).toBe(true);
});

test("importing the memory checker leaves a dangling citation for its CLI to report", () => {
  const root = fixture();
  const memory = join(root, "memory");
  mkdirSync(memory);
  writeFileSync(join(root, "README.md"), "See (memory: missing-note).\n");
  expect(spawnSyncHidden("git", ["init", "-q"], { cwd: root }).status).toBe(0);
  expect(spawnSyncHidden("git", ["add", "README.md"], { cwd: root }).status).toBe(0);
  const checker = resolve("scripts/check-memory-citations.mjs");
  const driver = join(root, "driver.mjs");
  writeFileSync(driver, 'await import(' + moduleUrl(checker) + '); console.log("returned");');
  const env = { AUDIT_TOOLS_MEMORY_DIR: memory };
  expect(node(root, [driver], env).stdout.trim()).toBe("returned");
  const cli = node(root, [checker], env);
  expect(cli.status).toBe(1);
  expect(cli.stderr).toContain("missing-note");
});

test("routing baseline parse failures name the damaged path and retain the JSON cause", () => {
  const root = fixture();
  expect(spawnSyncHidden("git", ["init", "-q"], { cwd: root }).status).toBe(0);
  const baseline = join(root, "docs", "reviews", ".routing-baseline.json");
  mkdirSync(dirname(baseline), { recursive: true });
  writeFileSync(baseline, "{ invalid");
  const checker = resolve("scripts/check-review-routing.mjs");
  const driver = join(root, "driver.mjs");
  writeFileSync(driver, 'await import(' + moduleUrl(checker) + '); console.log("returned");');
  expect(node(root, [driver, root]).stdout.trim()).toBe("returned");
  const result = node(root, [checker, root]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(baseline);
  expect(result.stderr).toMatch(/SyntaxError/);
});

test("a source import from a sibling sharing the root prefix contributes no closure edge", () => {
  const parent = fixture();
  const root = join(parent, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(parent, "repo-other"), { recursive: true });
  writeFileSync(join(parent, "repo-other", "outside.ts"), 'import fs from "node:fs"; export { fs };');
  writeFileSync(join(root, "src", "subject.ts"), 'export * from "../../repo-other/outside.js";');
  expect(checkDeclaredClaims(root, new Map([["src/subject.ts", "pure"]]))).toEqual([]);
});

test("closure mutation claims classify call expressions and ignore quoted or commented calls", () => {
  const root = fixture();
  mkdirSync(join(root, "src"));
  const mod = "src/subject.ts";
  const file = join(root, mod);
  writeFileSync(file, 'import fs from "node:fs"; // fs.unlinkSync("a")\nconst text = "rename("; function mkdir() {}');
  expect(checkDeclaredClaims(root, new Map([[mod, "reads-only"]]))).toEqual([]);
  writeFileSync(file, 'import fs from "node:fs"; fs.promises.rename("a", "b");');
  expect(checkDeclaredClaims(root, new Map([[mod, "reads-only"]]))).toMatchObject([{ module: mod, actual: "mutates" }]);
});
