import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, test, expect, vi } from "vitest";
import { BaseSequencer } from "vitest/node";
import VitestDurationSequencer from "../../scripts/shared/vitest-sequencer.mjs";
import { scratchDir } from "../helpers/scratch.js";

const generator = readFileSync(new URL("../../scripts/shared/generate-vitest-shard-baseline.mjs", import.meta.url));
type Spec = Parameters<VitestDurationSequencer["shard"]>[0][number];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function sequencerInput(names: string[], weights: Record<string, number>) {
  const root = scratchDir("weighted-shard-input");
  mkdirSync(root, { recursive: true });
  const baseline = join(root, "weights.json");
  writeFileSync(baseline, JSON.stringify({ files: weights }));
  vi.stubEnv("VITEST_SHARD_DURATIONS_PATH", baseline);
  const specs = names.map((name) => ({ name, moduleId: resolve(root, name), project: { name: "test-project" } })) as Spec[];
  const args = (index: number, count: number) => ({ config: { root, shard: { index, count } } }) as ConstructorParameters<typeof BaseSequencer>[0];
  const run = (index: number, count: number, list = specs) => new VitestDurationSequencer(args(index, count)).shard(list);
  const defaultShard = (index: number, count: number) => new BaseSequencer(args(index, count)).shard(specs);
  return { specs, run, defaultShard };
}

test("one missing spec retains measured weights and gives stable, disjoint shards across enumeration orders", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const names = ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts", "tests/d.test.ts", "tests/new.test.ts"];
  const { specs, run } = sequencerInput(names, {
    [names[0]!]: 100, [names[1]!]: 90, [names[2]!]: 10, [names[3]!]: 10,
    "tests/deleted.test.ts": 10_000,
  });
  const shard1 = await run(1, 2);
  const shard2 = await run(2, 2);
  expect(shard1).toEqual([specs[0], specs[2], specs[3]]);
  expect(shard2).toEqual([specs[1], specs[4]]);
  expect(await run(1, 2, [...specs].reverse())).toEqual(shard1);
  expect(await run(2, 2, [...specs].reverse())).toEqual(shard2);
  expect([...shard1, ...shard2].map((spec) => spec.moduleId).sort()).toEqual(specs.map((spec) => spec.moduleId).sort());
  expect(log).toHaveBeenCalledWith(expect.stringContaining("4 measured, 1 estimated (50 ms/spec); predicted shard workloads: 120 ms, 140 ms."));
});

test("valid zero timings remain measured and tie-break without assigning all files to one shard", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { specs, run } = sequencerInput(["a", "b", "c", "d"], { a: 0, b: 0, c: 0, d: 0 });
  expect(await run(1, 2, [...specs].reverse())).toEqual([specs[0], specs[2]]);
  expect(await run(2, 2)).toEqual([specs[1], specs[3]]);
});

test("selection with no timings uses Vitest's default rather than suggesting measured balancing", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const { run, defaultShard } = sequencerInput(["a", "b", "c", "d"], { missing: 15, a: -10 });
  expect(await run(1, 2)).toEqual(await defaultShard(1, 2));
  expect(await run(2, 2)).toEqual(await defaultShard(2, 2));
  expect(log).toHaveBeenCalledWith(expect.stringContaining("0 measured specs"));
});

test("generator accepts standalone and complete older shard census, refuses bad evidence without replacing baseline", () => {
  const root = scratchDir("weighted-shard-generator");
  const scriptDir = join(root, "scripts", "shared");
  const profileDir = join(root, ".audit-tools-profile");
  const script = join(scriptDir, "generate-vitest-shard-baseline.mjs");
  const baseline = join(scriptDir, "vitest-shard-duration-baseline.json");
  const a = "tests/a.test.ts", b = "tests/b.test.ts", c = "tests/new.test.ts";
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  const add = (name: string) => { writeFileSync(join(root, name), ""); git(["add", name]); };
  for (const dir of [scriptDir, profileDir, join(root, "tests")]) mkdirSync(dir, { recursive: true });
  writeFileSync(script, generator);
  git(["init", "-q"]);
  add(a);
  add(b);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "timing corpus"]);
  const gitSha = git(["rev-parse", "HEAD"]);
  const ledger = (profile: string, files: Record<string, number>) => ({
    profile, gitSha, files, fileCount: Object.keys(files).length, platform: "linux", node: "v22.14.0", ci: true,
    outcome: { passed: 1, failed: 0, unfinished: 0 },
  });
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8", windowsHide: true });
  const standalone = join(profileDir, "vitest-latest.json");
  writeFileSync(standalone, JSON.stringify(ledger("vitest", { [b]: 10, [a]: 100 })));
  expect(run()).toMatchObject({ status: 0 });
  const initial = JSON.parse(readFileSync(baseline, "utf8"));
  expect(initial).toMatchObject({ source: { gitSha, shards: 1 }, files: { [a]: 100, [b]: 10 } });
  add(c);
  const first = join(root, "first.json"), second = join(root, "second.json");
  const one = ledger("vitest-shard1of2", { [a]: 100 });
  const two = ledger("vitest-shard2of2", { [b]: 10 });
  writeFileSync(first, JSON.stringify(one));
  writeFileSync(second, JSON.stringify(two));
  expect(run()).toMatchObject({ status: 1, stderr: expect.stringContaining("1 tracked test file(s) missing") });
  expect(run("--shards", second, first)).toMatchObject({ status: 0 });
  const valid = readFileSync(baseline, "utf8");
  expect(JSON.parse(valid)).toMatchObject({ source: { gitSha, shards: 2 }, files: { [a]: 100, [b]: 10 } });
  expect(Object.keys(JSON.parse(valid).files)).toEqual([a, b]);
  expect(run("--shards", first, second)).toMatchObject({ status: 0 });
  expect(readFileSync(baseline, "utf8")).toBe(valid);
  const invalid = [
    { value: one, message: "every index" },
    { value: { ...two, outcome: { passed: 1, failed: 1, unfinished: 0 } }, message: "was not green" },
    { value: { ...two, outcome: { passed: 1, failed: 0, unfinished: 1 } }, message: "was not green" },
    { value: { ...two, files: { [a]: 10 } }, message: "more than one timing ledger" },
    { value: { ...two, files: { [c]: 10 } }, message: "1 unknown ledger file" },
    { value: { ...two, gitSha: "0".repeat(40) }, message: "same recorded commit" },
    { value: { ...two, files: { [b]: -1 } }, message: "invalid duration" },
  ];
  for (const { value, message } of invalid) {
    writeFileSync(second, JSON.stringify(value));
    expect(run("--shards", first, second)).toMatchObject({ status: 1, stderr: expect.stringContaining(message) });
    expect(readFileSync(baseline, "utf8")).toBe(valid);
  }
});
