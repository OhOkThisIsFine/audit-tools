import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { detectProjectFacts, findingLocationLineIssues, RunLogger } from "audit-tools/shared";
import { stepBoundaryFrictionCategory } from "../dist/shared/friction/stepBoundaryCapture.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "audit-shared-boundary-values-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("friction categories use only documented own mapping entries", () => {
  for (const event of ["artifact_rejected", "intent_gate_fallback", "node_quarantine"]) {
    assert.equal(stepBoundaryFrictionCategory(event), "tool_should_decide");
  }
  for (const event of [
    "phase_reemit", "repair_round", "post_repair_rederive", "no_change_merge",
    "coverage_total_lines_mismatch", "future_event", "toString", "constructor",
  ]) {
    assert.equal(stepBoundaryFrictionCategory(event), "inefficient_feeding");
  }
});

test("publish candidates require a nonblank script or an independent package signal", async (t) => {
  const root = await fixture(t);
  const manifest = join(root, "package.json");
  const badScripts = { release: 42, "publish:empty": "", "release:blank": " \t\n" };
  async function facts(pkg) {
    await writeFile(manifest, JSON.stringify(pkg));
    return await detectProjectFacts(root);
  }

  const unusable = await facts({ private: true, scripts: badScripts });
  assert.deepEqual(unusable.signals.release_scripts, []);
  assert.ok(!unusable.candidate_closing_actions.includes("publish"));

  const script = await facts({ private: true, scripts: { ...badScripts, "release:dev": "node release.js" } });
  assert.deepEqual(script.signals.release_scripts, ["release:dev"]);
  assert.ok(script.candidate_closing_actions.includes("publish"));

  const pkg = await facts({ name: "fixture", version: "1.0.0", scripts: badScripts });
  assert.deepEqual(pkg.signals.release_scripts, []);
  assert.ok(pkg.candidate_closing_actions.includes("publish"));

  await writeFile(join(root, "Cargo.toml"), "[package]\n");
  const rust = await facts({ private: true, scripts: badScripts });
  assert.deepEqual(rust.signals.release_scripts, []);
  assert.equal(rust.candidate_rationale.publish, "Cargo.toml is present");
  assert.ok(rust.candidate_closing_actions.includes("publish"));
});

test("raw line locations reject invalid supplied endpoints before schema parsing", () => {
  for (const location of [{}, { line_start: 1 }, { line_end: 1 }, { line_start: 1, line_end: 1 }, { line_start: 2, line_end: 3 }]) {
    assert.deepEqual(findingLocationLineIssues(location), []);
  }
  for (const field of ["line_start", "line_end"]) {
    for (const value of [0, -1, 1.25, "1", null, NaN, Infinity]) {
      const issues = findingLocationLineIssues({ [field]: value });
      assert.equal(issues.length, 1);
      assert.equal(issues[0].field, field);
      assert.match(issues[0].message, /integer >= 1/);
    }
  }
  const issues = findingLocationLineIssues({ line_start: 3, line_end: 2 });
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /less than or equal/);
});

test("run logging is inert when disabled and contains clock, fallback and append errors", async (t) => {
  const root = await fixture(t);
  const path = join(root, "logs", "run.jsonl");
  const event = { kind: "step", note: "fixture" };
  let clockReads = 0;
  const logger = new RunLogger(path, { now: () => { clockReads++; return 0; } });
  const disabled = new RunLogger(path, { enabled: false, now: () => clockReads++ });
  disabled.event(event);
  assert.equal(clockReads, 0);
  await assert.rejects(readFile(path), { code: "ENOENT" });

  logger.event(event);
  logger.event({ ...event, unsupported: 1n });
  assert.equal(clockReads, 2);
  const original = await readFile(path, "utf8");
  const ts = "1970-01-01T00:00:00.000Z";
  assert.deepEqual(original.trimEnd().split("\n").map(JSON.parse), [
    { ts, ...event },
    { ts, kind: "step", note: "unserializable_event" },
  ]);

  for (const now of [() => { throw new Error("clock failed"); }, () => NaN, () => Infinity]) {
    assert.doesNotThrow(() => new RunLogger(path, { now }).event(event));
  }
  assert.equal(await readFile(path, "utf8"), original);
  assert.doesNotThrow(() => new RunLogger(root, { now: () => 0 }).event(event));
});
