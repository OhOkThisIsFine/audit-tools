/**
 * Lens guidance reaches the worker, from one source.
 *
 * WHY THIS EXISTS (open-bugs, 2026-10-01: "`dispatch/lens-definitions.json`
 * ships with no reader"). Commit 5b55445e wrote per-lens worker guidance (what
 * each lens looks for, and what it must leave to other lenses) into
 * `dispatch/lens-definitions.json` and threaded it into every packet worker
 * prompt through `buildTaskSections`. The execution-substrate retirement
 * (467b1e8f) deleted that builder with the rest of the packet prompt code, and
 * nothing noticed: the asset kept shipping, its only references were presence
 * checks, and knip does not scan JSON. Workers got a bare lens id.
 *
 * The guidance now lives in `LENS_REGISTRY` (`src/audit/types.ts`), the one
 * home for lens prose, and the work-item prompt renders it. Two properties hold
 * that, each watched in both polarities:
 *
 *   1. Every canonical lens's rendered work-item prompt carries that lens's
 *      focus and its do-not-report boundary — and not another lens's.
 *   2. Every asset under `dispatch/`, including executable scripts, has a
 *      reference path from production code or shipped host instructions.
 *      Presence checks (the packaged smoke, `package.json` `files`) are not
 *      readers: they are exactly what let this asset rot.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareAuditHostHandoff } from "../../src/audit/cli/dispatch/hostHandoff.js";
import type { AuditHostTask } from "../../src/audit/cli/dispatch/hostHandoff.js";
import { LENS_REGISTRY } from "../../src/audit/types.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function renderedPrompt(lens: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "audit-lens-guidance-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "one\ntwo\n", "utf8");
  const task: AuditHostTask = {
    task_id: `lens-${lens}`,
    unit_id: "unit-a",
    pass_id: `pass:${lens}`,
    lens,
    file_paths: ["src/a.ts"],
    file_line_counts: { "src/a.ts": 2 },
    rationale: "Review src/a.ts",
    priority: "high",
    demand: { size: "small", complexity: "standard", risk: "high" },
    token_estimate: 100,
  } as unknown as AuditHostTask;
  const prepared = await prepareAuditHostHandoff({
    root,
    artifactsDir: join(root, ".audit-tools", "audit"),
    runId: `run-${lens}`,
    tasks: [task],
  });
  return prepared.workload.work_items[0]!.prompt.text;
}

describe("lens guidance reaches the work-item prompt", () => {
  it.each(LENS_REGISTRY.map((lens) => [lens.id, lens] as const))(
    "%s: the prompt carries this lens's focus and do-not-report boundary, and no other lens's focus",
    async (id, lens) => {
      const prompt = await renderedPrompt(id);
      expect(lens.focus.length).toBeGreaterThan(0);
      expect(lens.do_not_report.length).toBeGreaterThan(0);
      expect(prompt).toContain(lens.focus);
      expect(prompt).toContain(lens.do_not_report);
      for (const other of LENS_REGISTRY) {
        if (other.id !== id) expect(prompt).not.toContain(other.focus);
      }
    },
  );

  it("a custom lens is told plainly that it has no canonical guidance", async () => {
    const prompt = await renderedPrompt("accessibility");
    expect(prompt).toContain("no canonical guidance");
    for (const lens of LENS_REGISTRY) expect(prompt).not.toContain(lens.focus);
  });
});

/** Repo-relative paths of every file under `dir`. */
function filesUnder(dir: string): string[] {
  if (!existsSync(join(repoRoot, dir))) return [];
  return (readdirSync(join(repoRoot, dir), { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
    .filter((entry) => entry.isFile())
    .map((entry) => relative(repoRoot, join(entry.parentPath, entry.name)).replace(/\\/g, "/"))
    .sort();
}

const isScript = (path: string) => /\.(?:mjs|cjs|js|ts)$/.test(path);

/** Dispatch assets with no reference path from production callers. */
function unreadDispatchAssets(assets: readonly string[], readers: readonly { path: string; text: string }[]): string[] {
  const reached = new Set<string>();
  const frontier = readers.filter((reader) => !assets.includes(reader.path));
  for (let i = 0; i < frontier.length; i++) {
    const reader = frontier[i]!;
    for (const asset of assets) {
      if (reached.has(asset) || !reader.text.includes(asset.slice(asset.lastIndexOf("/") + 1))) continue;
      reached.add(asset);
      const next = readers.find((candidate) => candidate.path === asset);
      if (next) frontier.push(next);
    }
  }
  return assets.filter((asset) => !reached.has(asset));
}

describe("a dispatch asset has a production reference path", () => {
  it("fires on an asset nothing reads, and not on one a reader names", () => {
    const readers = [{ path: "src/a.ts", text: 'join(root, "dispatch", "read.json")' }];
    expect(unreadDispatchAssets(["dispatch/read.json", "dispatch/orphan.json"], readers)).toEqual([
      "dispatch/orphan.json",
    ]);
  });

  it("rejects orphan scripts and cycles, while following a live script to its data", () => {
    const assets = ["dispatch/live.mjs", "dispatch/read.json", "dispatch/a.mjs", "dispatch/b.mjs"];
    const readers = [
      { path: "src/main.ts", text: 'import "live.mjs"' },
      { path: "dispatch/live.mjs", text: 'readFileSync("read.json")' },
      { path: "dispatch/a.mjs", text: 'import "b.mjs"' },
      { path: "dispatch/b.mjs", text: 'import "a.mjs"' },
    ];
    expect(unreadDispatchAssets(assets, readers)).toEqual(["dispatch/a.mjs", "dispatch/b.mjs"]);
  });

  it("every dispatch file is reachable from src/, wrapper/, root bins or shipped skills", () => {
    const assets = filesUnder("dispatch");
    const readers = [
      ...filesUnder("src").filter((path) => path.endsWith(".ts")),
      ...filesUnder("wrapper").filter(isScript),
      ...filesUnder("dispatch").filter(isScript),
      ...filesUnder("skills").filter((path) => /\.(md|mjs|js|ts)$/.test(path)),
      "audit-code.mjs", "remediate-code.mjs",
    ].map((path) => ({ path, text: readFileSync(join(repoRoot, path), "utf8") }));
    expect(
      unreadDispatchAssets(assets, readers),
      "a dispatch asset must be reachable from production callers; wire a reader or delete the asset and its packaging rows",
    ).toEqual([]);
  });
});
