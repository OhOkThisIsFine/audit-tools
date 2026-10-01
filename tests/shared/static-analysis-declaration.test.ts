// The declaration the machine-wide nightly static-analysis runner reads.
//
// `~/.claude/scheduled-tasks/nightly-maintenance/static-analysis-runner.mjs`
// reads `.claude/static-analysis.json` from the main checkout and runs each
// declared command. The runner lives OUTSIDE this repository, so a renamed npm
// script or a malformed file surfaces only as a nightly report line nobody may
// read. The shape and every command's target are pinned here, at the only
// boundary this repository owns — its own tree.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DECLARATION = join(ROOT, ".claude", "static-analysis.json");

function readDeclaration(): { tools: Array<{ name: unknown; command: unknown }> } {
  return JSON.parse(readFileSync(DECLARATION, "utf8"));
}

describe("static-analysis declaration", () => {
  it("parses as JSON and declares at least one tool", () => {
    const raw = readDeclaration();
    expect(Array.isArray(raw.tools)).toBe(true);
    expect(raw.tools.length).toBeGreaterThan(0);
  });

  it("gives every tool a name and a command", () => {
    for (const tool of readDeclaration().tools) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.command).toBe("string");
      expect((tool.name as string).trim().length).toBeGreaterThan(0);
    }
  });

  it("runs only npm scripts that package.json defines", () => {
    const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts as Record<string, string>;
    for (const tool of readDeclaration().tools) {
      const match = /^npm run (\S+)$/.exec(tool.command as string);
      expect(match, `"${String(tool.command)}" is not an \`npm run <script>\` command`).not.toBeNull();
      expect(Object.keys(scripts)).toContain(match![1]);
    }
  });
});
