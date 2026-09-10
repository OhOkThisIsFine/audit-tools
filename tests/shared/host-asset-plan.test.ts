// Contract test for the declared host-asset install plan
// (scripts/shared/host-asset-plan.mjs).
//
// The property (backlog 2026-08-27, "Three governance vocabularies are copied
// per consumer"): the two postinstall entries execute ONE declared plan whose
// per-tool differences are ROWS, rather than each building its own install list
// around the shared installer. Two installers differing only by a tool token is
// a copy that drifts the moment either side changes — and the packaged smoke
// only exercises whichever tool it packs, so a divergence in the other is
// invisible until a user installs it.
//
// These pin the STRUCTURE the two share, and the per-tool policy that is
// legitimately different.
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HOST_ASSET_PLANS,
  PKG_ROOT,
  planClaudePluginDir,
  planInstalls,
  planOpenCodeCommand,
  planOpenCodeConfigPath,
  planSources,
} from "../../scripts/shared/host-asset-plan.mjs";

const TOOLS = Object.keys(HOST_ASSET_PLANS);

describe("host-asset plan — one declaration, two installers", () => {
  test("every shipped bin has exactly one plan row", () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
      bin: Record<string, string>;
    };
    expect(TOOLS.sort()).toEqual(Object.keys(pkg.bin).sort());
    for (const tool of TOOLS) {
      expect(HOST_ASSET_PLANS[tool]?.tool, `${tool} row names its own tool token`).toBe(tool);
    }
  });

  test("each plan's source files exist under the package root", () => {
    // A plan naming a missing source is the failure the postinstall would turn
    // into a silent `process.exit(0)` — an install that reports success and
    // deploys nothing.
    for (const tool of TOOLS) {
      const sources = planSources(HOST_ASSET_PLANS[tool]!);
      for (const [label, path] of Object.entries(sources)) {
        if (label === "codexUiMetadata") continue; // declared-optional
        expect(() => readFileSync(path, "utf8"), `${tool} ${label}: ${path}`).not.toThrow();
      }
    }
  });

  test("the install TARGETS are derived per tool, never shared literals", () => {
    // The structural property: every per-tool target path carries the tool token,
    // so two tools cannot land the same file. Target paths are the thing that
    // MUST differ; source paths are the thing that must be found.
    const seen = new Set<string>();
    for (const tool of TOOLS) {
      const installs = planInstalls(HOST_ASSET_PLANS[tool]!, {
        homeDir: "/home/fixture",
        promptContent: "p",
        skillContent: "s",
      });
      const paths = installs.map((i) => i.path);
      expect(new Set(paths).size, `${tool} has duplicate install targets`).toBe(paths.length);
      for (const path of paths) {
        expect(path, `${tool} target must carry the tool token`).toContain(tool);
        expect(seen.has(path), `${tool} and another tool collide on ${path}`).toBe(false);
        seen.add(path);
      }
    }
  });

  test("the optional Codex UI metadata target appears only when the source is present", () => {
    for (const tool of TOOLS) {
      const without = planInstalls(HOST_ASSET_PLANS[tool]!, {
        homeDir: "/home/fixture",
        promptContent: "p",
        skillContent: "s",
      });
      const with_ = planInstalls(HOST_ASSET_PLANS[tool]!, {
        homeDir: "/home/fixture",
        promptContent: "p",
        skillContent: "s",
        codexUiMetadataContent: "m",
      });
      expect(without.some((i) => i.label === "Codex skill UI metadata"), `${tool} without`).toBe(false);
      expect(with_.some((i) => i.label === "Codex skill UI metadata"), `${tool} with`).toBe(true);
      // Adding the optional target must not disturb the three required ones.
      expect(with_.slice(0, 3).map((i) => i.path)).toEqual(without.map((i) => i.path));
    }
  });

  test("the OpenCode command entry is derived, with a per-tool agent", () => {
    const commands = TOOLS.map((tool) => planOpenCodeCommand(HOST_ASSET_PLANS[tool]!, "  body  "));
    for (const command of commands) {
      expect(command.subtask).toBe(false);
    }
    // The agent names must differ — a shared one would route both commands to
    // the same permission block.
    expect(new Set(commands.map((c) => c.agent)).size).toBe(TOOLS.length);
  });

  test("each tool's template trim rule is DECLARED, not unified by default", () => {
    // audit-code's template is a standalone .txt (trailing newline must go);
    // remediate-code's is a markdown body extracted from the prompt (trailing
    // content is significant). Applying one rule to both would be a silent edit
    // to the other tool's deployed config — so each row states its own, and this
    // pins the two spellings the installers shipped with.
    const audit = planOpenCodeCommand(HOST_ASSET_PLANS["audit-code"]!, "  body  ");
    expect(audit.template, "audit-code trims both ends").toBe("body");
    const remediate = planOpenCodeCommand(HOST_ASSET_PLANS["remediate-code"]!, "  body  ");
    expect(remediate.template, "remediate-code preserves the trailing whitespace").toBe("body  ");
  });

  test("the OpenCode config path and the plugin dir convention are ONE location each", () => {
    // These are the two paths NOT derived per tool (the config is shared; the
    // plugin dir is per-tool by the host's convention, not by ours).
    for (const tool of TOOLS) {
      expect(planOpenCodeConfigPath({ homeDir: "/home/fixture" })).toBe(
        join("/home/fixture", ".config", "opencode", "opencode.json"),
      );
      expect(planClaudePluginDir(HOST_ASSET_PLANS[tool]!, { homeDir: "/home/fixture" })).toBe(
        join(
          "/home/fixture",
          ".claude",
          "plugins",
          "marketplaces",
          "claude-plugins-official",
          "external_plugins",
          tool,
        ),
      );
    }
  });

  test("the Claude command content rule is DECLARED, not re-decided per installer", () => {
    // audit-code ships the prompt verbatim; remediate-code strips its
    // frontmatter. That difference is real and stays — but it lives as a plan
    // flag, so a third tool cannot invent a third behaviour in its own file.
    expect(HOST_ASSET_PLANS["audit-code"]?.stripFrontmatter).toBe(false);
    expect(HOST_ASSET_PLANS["remediate-code"]?.stripFrontmatter).toBe(true);
  });

  test("each postinstall entry EXECUTES the plan rather than rebuilding it", () => {
    // The defect this closes: two installers each constructing their own install
    // list, their own command entry and their own plugin call around the shared
    // installer. A hand-rolled `join(homedir(), ".codex", ...)` in either file is
    // that copy returning.
    for (const entry of ["scripts/audit/postinstall.mjs", "scripts/remediate/postinstall.mjs"]) {
      const text = readFileSync(join(PKG_ROOT, entry), "utf8");
      expect(text, `${entry} must read the declared plan`).toContain("host-asset-plan.mjs");
      expect(text, `${entry} must not hand-spell a host target path`).not.toMatch(
        /join\(\s*homedir\(\)\s*,\s*["']\.(claude|codex|gemini)["']/,
      );
    }
  });
});
