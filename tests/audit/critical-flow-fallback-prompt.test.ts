import { test, expect } from "vitest";
import type { CriticalFlow, CriticalFlowManifest } from "audit-tools/shared";

const { renderCriticalFlowFallbackPrompt } = await import(
  "../../src/audit/reporting/criticalFlowFallbackPrompt.js"
);

// MAX_RENDERED_FLOWS is 80 (internal constant in criticalFlowFallbackPrompt.ts).
const MAX_RENDERED_FLOWS = 80;

const flow = (i: number): CriticalFlow => ({
  id: `flow:host:${String(i).padStart(4, "0")}`,
  name: `flow ${i}`,
  entrypoints: [`src/api/file${i}.ts`],
  paths: [`src/api/file${i}.ts`],
  concerns: ["security"],
  confidence: "low",
});

const manifest = (n: number): CriticalFlowManifest => ({
  flows: Array.from({ length: n }, (_, i) => flow(i)),
  fallback_required: true,
});

// The complete critical_flows.json artifact's host-facing path. The emitter
// passes the real one and GRANTS it in the step's read_paths — the overflow line
// is only actionable if the reader can open what it names.
const CRITICAL_FLOWS_PATH = "/run/.audit-tools/audit/critical_flows.json";

test("renders every flow up to MAX_RENDERED_FLOWS (80) with no overflow note", () => {
  const prompt = renderCriticalFlowFallbackPrompt(
    manifest(MAX_RENDERED_FLOWS),
    CRITICAL_FLOWS_PATH,
  );
  const rendered = prompt.split("\n").filter((l) => /^- `flow:host:/.test(l));
  expect(rendered.length, "exactly 80 flow lines rendered").toBe(MAX_RENDERED_FLOWS);
  // No overflow note at exactly the cap.
  expect(prompt).not.toMatch(/more flows at/);
});

test("at 81 flows adds the overflow note naming the REAL critical_flows path", () => {
  const prompt = renderCriticalFlowFallbackPrompt(
    manifest(MAX_RENDERED_FLOWS + 1),
    CRITICAL_FLOWS_PATH,
  );
  const rendered = prompt.split("\n").filter((l) => /^- `flow:host:/.test(l));
  expect(rendered.length, "exactly 80 flow lines rendered").toBe(MAX_RENDERED_FLOWS);
  // The 81st flow's id is not rendered inline.
  expect(prompt).not.toMatch(/flow:host:0080/);
  // The overflow note names the granted path — never the guessed bare filename.
  expect(prompt).toContain(`1 more flows at ${CRITICAL_FLOWS_PATH}`);
  expect(prompt).not.toMatch(/see critical_flows\.json/);
});

test("never guesses the bare filename, even below the cap", () => {
  const prompt = renderCriticalFlowFallbackPrompt(manifest(3), CRITICAL_FLOWS_PATH);
  expect(prompt).not.toMatch(/\bcritical_flows\.json\b/);
});

test("empty manifest renders the deterministic-inference-recorded-nothing sentinel", () => {
  const prompt = renderCriticalFlowFallbackPrompt(manifest(0), CRITICAL_FLOWS_PATH);
  expect(prompt).toContain("(deterministic inference recorded no flows)");
  expect(prompt).not.toMatch(/more flows at/);
});
