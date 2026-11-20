import { afterEach, beforeEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({ calls: [] as string[], badFlag: "", output: "", failInit: false }));
vi.mock("../../scripts/shared/hermetic-state-dir.mjs", () => ({}));
vi.mock("../../scripts/shared/smoke-tarball.mjs", () => ({
  resolveSmokeTarball: () => ({ tarballPath: "/fixture/package.tgz", packed: false }),
}));
vi.mock("../../scripts/shared/spawn-shell.mjs", () => ({
  resolveSpawn: (command: string, args: string[]) => ({ command, args }),
}));
vi.mock("fs", () => ({
  mkdtempSync: () => "/fixture/smoke",
  mkdirSync: vi.fn(), rmSync: vi.fn(), existsSync: () => true,
  readFileSync: (path: string) => path.endsWith("package.json") ? '{"version":"0.52.4"}' : "prompt\n",
}));
vi.mock("child_process", () => ({
  spawnSync: (command: string, args: string[]) => {
    fixture.calls.push(`${command} ${args.join(" ")}`);
    if (fixture.failInit && args[0] === "init") return { status: 17, stderr: "fixture init refused", stdout: "" };
    if (fixture.failInit && args[0] === "install") return { status: 19, stderr: "later install failure", stdout: "" };
    let stdout = "";
    if (/remediate-code(?:\.cmd)?$/.test(command)) {
      stdout = args[0] === "--version" ? "0.52.4\n" : "Usage: remediate-code [options] [command]\n";
      if (args[0] === fixture.badFlag) stdout = fixture.output;
    } else if (command === process.execPath) {
      // The old smoke bypassed the shim by invoking the real wrapper path.
      stdout = "0.52.4\n";
    }
    return { status: 0, stdout, stderr: "" };
  },
}));

beforeEach(() => {
  vi.resetModules();
  fixture.calls.length = 0;
  fixture.badFlag = fixture.output = "";
  fixture.failInit = false;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("smoke rejected"); });
});
afterEach(() => vi.restoreAllMocks());

const runSmoke = () => import("../../scripts/remediate/smoke-packaged-remediate-code.mjs");

test("an npm init failure stops fixture setup and reports the child error", async () => {
  fixture.failInit = true;
  await expect(runSmoke()).rejects.toThrow(/npm init.*17.*fixture init refused/s);
  expect(fixture.calls.some(call => call.includes(" install "))).toBe(false);
});

test("packaged smoke executes installed npm bin for version and help", async () => {
  await runSmoke();
  for (const flag of ["--version", "--help"]) {
    expect(fixture.calls.some((call) => call.replace(/\\/g, "/").endsWith(`/.bin/remediate-code${process.platform === "win32" ? ".cmd" : ""} ${flag}`))).toBe(true);
  }
  expect(fixture.calls.some((call) => call.startsWith(process.execPath))).toBe(false);
});

test.each([
  ["--version", ""], ["--version", "0.52.3"],
  ["--help", ""], ["--help", "Usage: other-tool [options]"],
])("packaged smoke rejects successful but invalid %s output %j", async (flag, output) => {
  fixture.badFlag = flag;
  fixture.output = output;
  await expect(runSmoke()).rejects.toThrow("smoke rejected");
});
