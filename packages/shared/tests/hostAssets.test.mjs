import test from "node:test";
import assert from "node:assert/strict";
import { renderHostAsset } from "../src/hostAssets.ts";

const KINDS = ["vscode-agent", "codex-recipe", "antigravity-guide", "gemini-toml"];

// A canonical body that exercises the format-only wrappers: it carries the
// next-step continuation guidance with the capability flags, a backslash, and a
// double-quote (which only the TOML kind must escape).
const CANONICAL_BODY = [
  "# `/tool` Loader",
  "",
  'Report `--host-models` on every `next-step` call. Use C:\\path and say "hi".',
  "",
  "When a step prompt tells you to continue, run `tool next-step` again with",
  "the same capability flags (`--host-max-active-subagents`, `--host-models`,",
  "`--host-context-tokens`, `--host-output-tokens`) and follow only the newly",
  "returned `prompt_path`.",
].join("\n");

test("renderHostAsset embeds the canonical body for every kind", () => {
  for (const kind of KINDS) {
    const out = renderHostAsset(kind, { promptBody: CANONICAL_BODY, toolName: "tool" });
    assert.ok(out.length > 0, `${kind} must produce output`);
    assert.ok(
      out.includes("# `/tool` Loader"),
      `${kind} must embed the canonical loader heading`,
    );
  }
});

test("renderHostAsset carries --host-models in the continuation guidance for every kind", () => {
  for (const kind of KINDS) {
    const out = renderHostAsset(kind, { promptBody: CANONICAL_BODY, toolName: "tool" });
    const continuation = out.match(/again with[\s\S]*?(`--host-models`)[\s\S]*?prompt_path/);
    assert.ok(
      continuation,
      `${kind} continuation section must list --host-models`,
    );
  }
});

test("renderHostAsset gemini-toml escapes backslashes and double-quotes", () => {
  const toml = renderHostAsset("gemini-toml", {
    promptBody: CANONICAL_BODY,
    toolName: "tool",
  });
  const promptStart = toml.indexOf('prompt = """');
  assert.ok(promptStart >= 0, "TOML must contain the multi-line prompt field");
  const promptSection = toml.slice(promptStart);
  assert.ok(promptSection.includes("C:\\\\path"), "TOML must escape backslashes in the body");
  assert.ok(promptSection.includes('\\"hi\\"'), "TOML must escape double-quotes in the body");
});

test("renderHostAsset markdown kinds do not escape body characters", () => {
  for (const kind of ["vscode-agent", "codex-recipe", "antigravity-guide"]) {
    const out = renderHostAsset(kind, { promptBody: CANONICAL_BODY, toolName: "tool" });
    assert.ok(out.includes('say "hi"'), `${kind} must embed double-quotes unescaped`);
    assert.ok(out.includes("C:\\path"), `${kind} must embed backslashes unescaped`);
  }
});

test("renderHostAsset is bin-agnostic — toolName parameterizes the slash command", () => {
  // Proves remediate-code (or any orchestrator) can reuse the one renderer.
  for (const toolName of ["audit-code", "remediate-code"]) {
    const toml = renderHostAsset("gemini-toml", {
      promptBody: CANONICAL_BODY,
      toolName,
    });
    assert.ok(
      toml.includes(`# /${toolName}`),
      `gemini-toml header must use toolName '${toolName}'`,
    );
    const agent = renderHostAsset("vscode-agent", {
      promptBody: CANONICAL_BODY,
      toolName,
    });
    assert.ok(
      agent.includes(`/${toolName}`),
      `vscode-agent must reference '/${toolName}'`,
    );
  }
});

test("renderHostAsset throws on an unknown kind", () => {
  assert.throws(
    () => renderHostAsset("not-a-kind", { promptBody: CANONICAL_BODY, toolName: "tool" }),
    /Unknown host asset kind/,
  );
});
