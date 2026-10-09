import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeFanoutLanes } from "../../src/audit/cli/fanoutLanes.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("pointer lanes count their readable packet bytes and preserve semantic judgment floors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fanout-context-"));
  roots.push(dir);
  const packet = join(dir, "full-evidence.json");
  await writeFile(packet, JSON.stringify({ evidence: "x".repeat(100_000) }));
  const lanes = [{ id: "context-demand", label: "Review", promptFilename: "review.md", promptText: `Read ${packet}`, fileCount: 1, riskScore: 0.8, contextPaths: [packet], semanticComplexity: "deep" as const }];
  const result = await materializeFanoutLanes({ artifactsDir: dir, sourceRoot: dir, runId: "run", lanes });
  expect(result.lanes[0]!.demand).toEqual({ size: "large", complexity: "deep", risk: "high" });
  expect(result.readPaths).toContain(packet);
});

test("short semantic lanes retain deep judgment even with small concrete scope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fanout-semantic-"));
  roots.push(dir);
  const lanes = [{ id: "semantic-demand", label: "Review", promptFilename: "review.md", promptText: "Review the contract.", fileCount: 1, riskScore: 0.8, semanticComplexity: "deep" as const }];
  const result = await materializeFanoutLanes({ artifactsDir: dir, sourceRoot: dir, runId: "run", lanes });
  expect(result.lanes[0]!.demand).toEqual({ size: "small", complexity: "deep", risk: "high" });
});
