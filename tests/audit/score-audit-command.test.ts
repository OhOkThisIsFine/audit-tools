import { test, expect } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/audit/cli.js";
import { captureConsole } from "./helpers/captureConsole.mjs";

test("score-audit refuses missing findings but scores an explicit empty array with distinct outputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "audit-score-command-"));
  try {
    const findings = join(root, "findings.json");
    const labels = join(root, "labels.json");
    const out = join(root, "scorecard");
    await writeFile(labels, JSON.stringify({ schema_version: "score-audit-corpus-labels/v1", run_id: "fixture", labels: [] }));
    const run = () => captureConsole(() => runCli(["node", "audit-code", "score-audit",
      "--root", root, "--findings", findings, "--labels", labels, "--out", out]));
    for (const invalid of [{}, { findings: null }, { findings: [null] }]) {
      await writeFile(findings, JSON.stringify(invalid));
      const result = await run();
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/findings array|Invalid finding/);
      await expect(readFile(out)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(`${out}.md`)).rejects.toMatchObject({ code: "ENOENT" });
    }

    await writeFile(findings, JSON.stringify({ findings: [] }));
    expect((await run()).code).toBe(0);
    expect(JSON.parse(await readFile(out, "utf8"))).toMatchObject({ counts: { findings_emitted: 0 } });
    expect(await readFile(`${out}.md`, "utf8")).toMatch(/^# .*Scorecard/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
