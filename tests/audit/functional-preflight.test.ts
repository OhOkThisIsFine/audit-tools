import { EXTERNAL_ANALYZER_CANDIDATES, persistAnalyzerConsent, persistAnalyzerSettings, toPromptPathToken } from "audit-tools/shared";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { functionalPreflightStep, functionalPreflightPath } from "../../src/audit/cli/functionalPreflight.js";
import { cmdNextStep } from "../../src/audit/cli/nextStepCommand.js";
import { runCli } from "../../src/audit/cli.js";
import { validateAuditArguments, NEXT_STEP_ARGUMENTS } from "../../src/audit/cli/argumentContract.js";
import { getFlag } from "../../src/audit/cli/args.js";
import { satisfyFunctionalPreflight } from "../helpers/functionalPreflightFixture.js";
import { cleanupStaleArtifactsDir } from "../../src/audit/cli/cleanup.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "audit-preflight-")); roots.push(root);
  return { root, artifactsDir: join(root, ".audit-tools", "audit") };
}
afterEach(async () => { vi.restoreAllMocks(); process.exitCode = 0; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("the public next-step emits capability work before semantic or deterministic audit work", async () => {
  const { root, artifactsDir } = await fixture();
  await writeFile(join(root, "sample.ts"), "export const sample = 1;\n");
  await persistAnalyzerSettings(root, { typescript: "skip", python: "skip", html: "skip", css: "skip", sql: "skip" });
  await persistAnalyzerConsent(root, Object.fromEntries(EXTERNAL_ANALYZER_CANDIDATES.map(candidate => [candidate.id, "declined" as const])));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  await cmdNextStep(["--root", root]);
  const step = JSON.parse(await readFile(join(artifactsDir, "steps", "current-step.json"), "utf8"));
  expect(step.step_kind).toBe("functional_preflight");
  // Host-facing paths are forward-slash tokens on every OS (toPromptPathToken).
  expect(step.artifact_paths.functional_preflight).toBe(toPromptPathToken(functionalPreflightPath(artifactsDir)));
  expect(await readdir(artifactsDir)).not.toContain("repo_manifest.json");
  const prompt = await readFile(step.prompt_path, "utf8");
  expect(prompt).toContain("Actor: the host");
  expect(prompt).toContain("operator_approved_degraded");
  expect(prompt).not.toContain("check:tests");
});
it("a host that copies the emitted example verbatim satisfies the run binding (the prompt body forward-slashes win32 paths)", async () => {
  const { root, artifactsDir } = await fixture();
  await writeFile(join(root, "sample.ts"), "export const sample = 1;\n");
  await persistAnalyzerSettings(root, { typescript: "skip", python: "skip", html: "skip", css: "skip", sql: "skip" });
  await persistAnalyzerConsent(root, Object.fromEntries(EXTERNAL_ANALYZER_CANDIDATES.map(candidate => [candidate.id, "declined" as const])));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  await cmdNextStep(["--root", root]);
  const step = JSON.parse(await readFile(join(artifactsDir, "steps", "current-step.json"), "utf8"));
  const prompt = await readFile(step.prompt_path, "utf8");
  const example = [...prompt.matchAll(/```json\s*([\s\S]*?)```/gu)]
    .map(match => JSON.parse(match[1]!))
    .find(value => value?.contract_version === "audit-functional-preflight/v1");
  expect(example.repository_root).toBe(toPromptPathToken(await realpath(root)));
  await writeFile(step.artifact_paths.functional_preflight, JSON.stringify({
    ...example,
    source_inspection: { available: true, evidence: "Read sample.ts." },
    relationship_inspection: { available: true, evidence: "sample.ts declares no import." },
    decision: "ready",
  }));
  expect(await functionalPreflightStep(root, artifactsDir)).toBeUndefined();
});
it("ready is run-bound; cleanup invalidates a copied prior report", async () => {
  const { root, artifactsDir } = await fixture();
  await satisfyFunctionalPreflight(root, artifactsDir);
  expect(await functionalPreflightStep(root, artifactsDir)).toBeUndefined();
  const prior = await readFile(functionalPreflightPath(artifactsDir), "utf8");
  await cleanupStaleArtifactsDir(artifactsDir, { force: true });
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(functionalPreflightPath(artifactsDir), prior);
  expect((await functionalPreflightStep(root, artifactsDir))?.progress?.summary).toMatch(/another run/);
});
it("unavailable capability cannot silently downgrade; explicit degraded approval records a report limitation once", async () => {
  const { root, artifactsDir } = await fixture();
  await satisfyFunctionalPreflight(root, artifactsDir);
  const path = functionalPreflightPath(artifactsDir);
  const report = JSON.parse(await readFile(path, "utf8"));
  report.relationship_inspection = { available: false, evidence: "Structural tool cannot read this repository." };
  await writeFile(path, JSON.stringify(report));
  expect((await functionalPreflightStep(root, artifactsDir))?.progress?.summary).toMatch(/Ready requires/);
  report.decision = "degraded"; report.limitation = "No structural relationship inspection; operator requested a shallow source review.";
  await writeFile(path, JSON.stringify(report));
  expect((await functionalPreflightStep(root, artifactsDir))?.progress?.summary).toMatch(/explicit operator approval/);
  report.operator_approved_degraded = true;
  await writeFile(path, JSON.stringify(report));
  expect(await functionalPreflightStep(root, artifactsDir)).toBeUndefined();
  expect(await functionalPreflightStep(root, artifactsDir)).toBeUndefined();
  const feedback = (await readFile(join(artifactsDir, "agent-feedback.jsonl"), "utf8")).trim().split("\n");
  expect(feedback).toHaveLength(1);
  expect(JSON.parse(feedback[0]!)).toMatchObject({ task_id: "audit-capability-preflight", severity: "high" });
});
it("stop persists; malformed content re-emits while IO failures remain failures", async () => {
  const { root, artifactsDir } = await fixture(); await satisfyFunctionalPreflight(root, artifactsDir);
  const path = functionalPreflightPath(artifactsDir);
  const report = JSON.parse(await readFile(path, "utf8")); report.decision = "stop";
  await writeFile(path, JSON.stringify(report));
  expect((await functionalPreflightStep(root, artifactsDir))?.status).toBe("blocked");
  expect((await functionalPreflightStep(root, artifactsDir))?.status).toBe("blocked");
  await writeFile(path, "{");
  expect((await functionalPreflightStep(root, artifactsDir))?.progress?.summary).toMatch(/not valid JSON/);
  await rm(path); await mkdir(path);
  await expect(functionalPreflightStep(root, artifactsDir)).rejects.toThrow();
});
it("unsupported arguments fail before artifacts change and help/values use declared route metadata", async () => {
  const { root } = await fixture();
  await expect(cmdNextStep(["--root", root, "--model", "anything"])).rejects.toThrow(/unsupported argument --model/);
  expect(await readdir(root)).toEqual([]);
  expect(() => validateAuditArguments("next-step", ["--root"], NEXT_STEP_ARGUMENTS)).toThrow(/requires a value/);
  expect(() => validateAuditArguments("next-step", ["--root=--odd", "--auto-fix"], NEXT_STEP_ARGUMENTS)).not.toThrow();
  expect(getFlag(["--root=--odd"], "--root")).toBe("--odd");
});
it("the public semantic ingestion CLI cannot skip preflight", async () => {
  const { root } = await fixture();
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await runCli(["node", "audit-code", "ingest-results", "--root", root, "--results", "never-read.json"]);
  expect(process.exitCode).toBe(1);
  expect(errors.mock.calls.flat().join(" ")).toMatch(/functional preflight first/);
});
