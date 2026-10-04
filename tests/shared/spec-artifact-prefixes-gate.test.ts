import { describe, it, expect, afterAll } from "vitest";
// INV-WH: never a raw child_process entry point in a test file.
import { spawnSyncHidden } from "../helpers/spawn.mjs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const CHECKER = resolve(process.cwd(), "scripts/check-spec-artifact-prefixes.mjs");

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function run(root: string): { code: number | null; out: string } {
  const r = spawnSyncHidden(process.execPath, [CHECKER, root], { encoding: "utf8", windowsHide: true });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** A minimal tree: one registered DAG-key artifact `a.json`, and a spec holding `rows`. */
function fixture(rows: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "spec-prefix-gate-"));
  temps.push(root);
  const files: Record<string, string> = {
    "src/audit/io/artifacts.ts": 'export const ARTIFACT_DEFINITIONS = {\n  a: jsonArtifact("a.json", "analysis"),\n};\n',
    "src/audit/orchestrator/dependencyMap.ts": 'export const ARTIFACT_DEPENDS_ON_MAP = {\n  "a.json": [],\n};\n',
    "src/shared/io/auditToolsPaths.ts": "export {};\n",
    "src/shared/agentReflections.ts": "export {};\n",
    "spec/audit/artifact-contract.md": `| Artifact | Format | Purpose |\n|---|---|---|\n${rows.join("\n")}\n`,
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

describe("check:spec-artifact-prefixes", () => {
  it("passes on the real spec", () => {
    const r = run(process.cwd());
    expect(r.code, r.out).toBe(0);
  });

  it("passes a transient file under the transient prefix and a registered DAG key under Marker", () => {
    const root = fixture([
      "| `a.json` | JSON | Marker: a run record. |",
      "| `t.json` | JSON | **Transient host submission** — deleted after ingestion. |",
    ]);
    const r = run(root);
    expect(r.code, r.out).toBe(0);
  });

  it("fails a transient (unregistered) file under the durable prefix, naming row, prefix and predicate", () => {
    const root = fixture(["| `t.json` | JSON | Durable host input: written then deleted. |"]);
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain("t.json");
    expect(r.out).toContain("durable host input");
    expect(r.out).toContain("registered in ARTIFACT_DEFINITIONS AND a leaf");
  });

  it("fails an unknown category prefix", () => {
    const root = fixture(["| `a.json` | JSON | Ephemeral cache: rebuilt on demand. |"]);
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain("unknown category prefix");
  });

  it("refuses an unrecognized argument", () => {
    const r = spawnSyncHidden(process.execPath, [CHECKER, "--bogus"], { encoding: "utf8", windowsHide: true });
    expect(r.status).toBe(2);
  });
});
