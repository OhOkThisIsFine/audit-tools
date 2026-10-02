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
 *   2. A data asset under `dispatch/` (anything that is not an executable
 *      script) has a code reader in `src/`, `wrapper/` or a `dispatch/` script.
 *      Presence checks (the packaged smoke, `package.json` `files`) are not
 *      readers: they are exactly what let this asset rot.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
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
  return (readdirSync(join(repoRoot, dir), { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
    .filter((entry) => entry.isFile())
    .map((entry) => relative(repoRoot, join(entry.parentPath, entry.name)).replace(/\\/g, "/"))
    .sort();
}

const isScript = (path: string) => /\.(?:mjs|cjs|js|ts)$/.test(path);

/** Data assets under `dispatch/` that no reader names. */
function unreadDispatchAssets(assets: readonly string[], readers: readonly { path: string; text: string }[]): string[] {
  return assets.filter((asset) => {
    const name = asset.slice(asset.lastIndexOf("/") + 1);
    return !readers.some((reader) => reader.path !== asset && reader.text.includes(name));
  });
}

describe("a shipped dispatch data asset has a code reader", () => {
  it("fires on an asset nothing reads, and not on one a reader names", () => {
    const readers = [{ path: "src/a.ts", text: 'join(root, "dispatch", "read.json")' }];
    expect(unreadDispatchAssets(["dispatch/read.json", "dispatch/orphan.json"], readers)).toEqual([
      "dispatch/orphan.json",
    ]);
  });

  it("every non-script file under dispatch/ is read by src/, wrapper/ or a dispatch/ script", () => {
    const assets = filesUnder("dispatch").filter((path) => !isScript(path));
    const readers = [
      ...filesUnder("src").filter((path) => path.endsWith(".ts")),
      ...filesUnder("wrapper").filter(isScript),
      ...filesUnder("dispatch").filter(isScript),
    ].map((path) => ({ path, text: readFileSync(join(repoRoot, path), "utf8") }));
    expect(
      unreadDispatchAssets(assets, readers),
      "a shipped data asset with no code reader delivers nothing; wire a reader or delete the asset and its packaging rows",
    ).toEqual([]);
  });
});
