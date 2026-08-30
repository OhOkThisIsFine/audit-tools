// The closeout hand-back is MANDATORY every sprint, so its renderer chain must
// run in a checkout that has never been built (backlog 2026-08-29: --template
// died on ERR_MODULE_NOT_FOUND in a fresh worktree). Two pins hold that:
//  1. the static import closure of scripts/render-closeout.mjs stays free of
//     audit-tools/shared (= dist/) and of any direct dist/ path;
//  2. the tracked generated vocabulary module matches the generator's render of
//     the canonical TS source, so CI holds what the check:friction-categories
//     commit leg holds.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  extractFrictionCategories,
  renderFrictionCategoriesModule,
} from "../../scripts/shared/generate-friction-categories.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

/** Collect every static and dynamic import specifier in one source file. */
function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/(?:^|\n)\s*import\s+(?:[^"'`;]*?from\s+)?["']([^"']+)["']/g)) {
    out.push(m[1]!);
  }
  for (const m of source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) {
    out.push(m[1]!);
  }
  return out;
}

describe("closeout renderer runs without a build", () => {
  it("the renderer chain's import closure never touches audit-tools/shared or dist/", () => {
    const queue = ["scripts/render-closeout.mjs"];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const rel = queue.pop()!;
      if (seen.has(rel)) continue;
      seen.add(rel);
      const source = readFileSync(join(REPO_ROOT, rel), "utf8");
      for (const spec of importSpecifiers(source)) {
        expect(spec, `${rel} imports ${spec}`).not.toMatch(/^audit-tools(\/|$)/);
        expect(spec, `${rel} imports ${spec}`).not.toContain("dist/");
        if (spec.startsWith(".")) {
          const abs = resolve(join(REPO_ROOT, dirname(rel)), spec);
          queue.push(abs.slice(REPO_ROOT.length + 1).replaceAll("\\", "/"));
        }
      }
    }
    // The chain was actually walked, not vacuously empty.
    expect(seen.size).toBeGreaterThan(1);
    expect(seen).toContain("scripts/closeout-sections-data.mjs");
  });

  it("the tracked generated vocabulary matches the canonical TS source", () => {
    const source = readFileSync(
      join(REPO_ROOT, "src", "shared", "friction", "frictionRecord.ts"),
      "utf8",
    );
    const rendered = renderFrictionCategoriesModule(extractFrictionCategories(source));
    const tracked = readFileSync(
      join(REPO_ROOT, "scripts", "shared", "friction-categories.generated.mjs"),
      "utf8",
    );
    expect(tracked.replaceAll("\r\n", "\n")).toBe(rendered);
  });
});
