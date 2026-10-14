import { test, expect } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExternalAnalyzer, registerExternalAnalyzers, type AcquisitionRunner } from "../../src/shared/analyzers/acquisitionEngine.js";
import { EXTERNAL_ANALYZER_CANDIDATES, lizardCandidate, semgrepCandidate, parseLizard } from "../../src/shared/analyzers/candidates.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/lizard-1.17.10.json", import.meta.url), "utf8")) as { header: string; rows: string[] };
const recordingRunner = (calls: string[][], stdout: string): AcquisitionRunner => async (argv) => {
  calls.push(argv);
  return { argv, status: 0, stdout: argv.includes("--version") ? "1.0" : stdout, stderr: "", duration_ms: 1 };
};

for (const [names, languages] of [
  [["a.py", "b.rs"], ["python", "rust"]],
  [["a.c", "b.cpp"], ["c", "cpp"]],
  [["a.py"], ["python"]],
] as const) {
  test(`registered Lizard invokes pipx with separate language operands: ${languages.join("/")}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "lizard-contract-"));
    try {
      for (const name of names) await writeFile(join(root, name), "");
      const calls: string[][] = [];
      const registered = registerExternalAnalyzers(EXTERNAL_ANALYZER_CANDIDATES).find(c => c.id === "lizard")!;
      const result = await runExternalAnalyzer(registered, root, { run: recordingRunner(calls, fixture.rows[0]) });
      expect(calls).toEqual([["pipx", "--version"], ["pipx", "run", "--spec", "lizard==1.17.10", "lizard", ...languages.flatMap(lang => ["-l", lang]), "--csv", root]]);
      expect(result.results.results).toHaveLength(3);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("registered semgrep remains consent-gated and uses its explicit app operand", async () => {
  const root = await mkdtemp(join(tmpdir(), "semgrep-contract-"));
  try {
    await writeFile(join(root, "package.json"), "{}");
    const registered = registerExternalAnalyzers(EXTERNAL_ANALYZER_CANDIDATES).find(c => c.id === "semgrep")!;
    const calls: string[][] = [];
    const run = recordingRunner(calls, '{"results":[]}');
    const consentToken = { value: "this-run", tools: ["semgrep"] };
    expect((await runExternalAnalyzer(registered, root, { run })).status.status).toBe("skipped");
    expect((await runExternalAnalyzer(registered, root, { run, consentToken, analyzerConsent: { semgrep: "declined" } })).status.status).toBe("skipped");
    expect(calls).toEqual([]);
    await runExternalAnalyzer(registered, root, { run, consentToken });
    expect(calls).toEqual([["pipx", "--version"], ["pipx", "run", "--spec", "semgrep==1.63.0", "semgrep", "--json", "--quiet", "--config", "auto", root]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pipx app is explicit even when distribution name differs; blank bins fail before any spawn", async () => {
  const candidate = { ...semgrepCandidate, spec: "different-distribution==1.2.3", bin: "actual-app", detect: () => true, defaultRun: true };
  const calls: string[][] = [];
  await runExternalAnalyzer(candidate, "/repo", { run: recordingRunner(calls, '{"results":[]}') });
  expect(calls[1].slice(0, 5)).toEqual(["pipx", "run", "--spec", "different-distribution==1.2.3", "actual-app"]);
  for (const bin of [undefined, "", "   "]) {
    const rejectedCalls: string[][] = [];
    const result = await runExternalAnalyzer({ ...candidate, bin }, "/repo", { run: recordingRunner(rejectedCalls, "") });
    expect(result.status.status).toBe("not_resolved");
    expect(result.status.error).toMatch(/pipx.*executable|executable.*pipx/i);
    expect(rejectedCalls).toEqual([]);
  }
});

test("Lizard excludes JS-only trees and honors recorded decline even with a grant", async () => {
  const root = await mkdtemp(join(tmpdir(), "lizard-admission-"));
  try {
    await writeFile(join(root, "a.ts"), "");
    const calls: string[][] = [];
    const run = recordingRunner(calls, "");
    expect((await runExternalAnalyzer(lizardCandidate, root, { run })).status.status).toBe("skipped");
    await writeFile(join(root, "a.py"), "");
    expect((await runExternalAnalyzer(lizardCandidate, root, { run, consentToken: { value: "run", tools: ["lizard"] }, analyzerConsent: { lizard: "declined" } })).status.status).toBe("skipped");
    expect(calls).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pinned Lizard default headerless rows are all parsed; verbose header is recognized precisely", () => {
  const [one, two] = fixture.rows;
  expect(parseLizard(one).items.map(({ id, rule, severity, path }) => ({ id, rule, severity, path }))).toEqual([
    { id: "lizard-ccn:src/utils.py:complex_func", rule: "lizard-ccn", severity: "medium", path: "src/utils.py" },
    { id: "lizard-length:src/utils.py:complex_func", rule: "lizard-length", severity: "low", path: "src/utils.py" },
    { id: "lizard-params:src/utils.py:complex_func", rule: "lizard-params", severity: "low", path: "src/utils.py" },
  ]);
  expect(parseLizard(`${one}\r\n${two}\r\n`).items).toHaveLength(6);
  expect(parseLizard(`${fixture.header}\n${one}\n${two}`).items).toHaveLength(6);
  expect(parseLizard(`${fixture.header}\n${one}`)).toEqual(parseLizard(one));
  expect(parseLizard(`${one}\n\nnot a csv\n${two}`)).toEqual({ items: parseLizard(`${one}\n${two}`).items, dropped_rows: 1 });
  expect(parseLizard(fixture.header)).toEqual({ items: [] });
  expect(parseLizard("")).toEqual({ items: [] });
  expect(parseLizard("header only")).toEqual({ items: [], dropped_rows: 1 });
  expect(parseLizard("250junk,25,1200,8,300,loc,src/a.py,fn")).toEqual({ items: [], dropped_rows: 1 });
  expect(parseLizard("not a csv")).toEqual({ items: [], dropped_rows: 1 });
  expect(parseLizard(`${fixture.header},unexpected`)).toEqual({ items: [], dropped_rows: 1 });
  expect(parseLizard(`250,25,1200,8,300,loc,"unclosed,fn`)).toEqual({ items: [], dropped_rows: 1 });
  expect(parseLizard('250,25,1200,8,300,loc,"src/a,b.py","f""n"').items[0].id).toBe('lizard-ccn:src/a,b.py:f"n');
});

test("malformed sole Lizard row reaches engine parse-error status", async () => {
  const result = await runExternalAnalyzer({ ...lizardCandidate, detect: () => true }, "/repo", { run: recordingRunner([], "not a csv") });
  expect(result.status.status).toBe("parse_error");
});

for (const [name, row] of [
  ["one-field header", `"${fixture.header}"`],
  ["grouped header captions", '"NLOC,CCN",token,PARAM,length,location,file,function,long_name,start,end'],
  ["text after closing quote", '250,25,1200,8,300,loc,"src/a.py"junk,fn'],
  ["below-threshold malformed path", '1,1,10,1,2,loc,"src/a.py"junk,fn'],
  ["quote inside unquoted path", '250,25,1200,8,300,loc,src/a"b".py,fn'],
  ["quote embedded before field boundary", '250,25,1200,8,300,loc,src/a.py"b",fn'],
  ["unclosed quote after eight fields", '250,25,1200,8,300,loc,src/a.py,"unclosed'],
] as const) {
  test(`Lizard rejects ${name} without losing valid adjacent rows`, async () => {
    expect(parseLizard(row)).toEqual({ items: [], dropped_rows: 1 });
    const valid = fixture.rows[0];
    expect(parseLizard(`${valid}\n${row}\n${valid}`)).toEqual({ items: [...parseLizard(valid).items, ...parseLizard(valid).items], dropped_rows: 1 });
    const result = await runExternalAnalyzer({ ...lizardCandidate, detect: () => true }, "/repo", { run: recordingRunner([], row) });
    expect(result.status.status).toBe("parse_error");
  });
}
