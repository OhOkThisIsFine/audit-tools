import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  _INSTALL_HOST_ORDER as INSTALL_HOST_ORDER,
  _INSTALL_HOST_DEFINITIONS as INSTALL_HOST_DEFINITIONS,
  _getInstallHostKeys as getInstallHostKeys,
  _getInstallProfile as getInstallProfile,
  _renderGeminiCommandToml as renderGeminiCommandToml,
} from "../audit-code-wrapper-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

test("every host in INSTALL_HOST_ORDER has a complete descriptor with verify", () => {
  for (const hostKey of INSTALL_HOST_ORDER) {
    const def = INSTALL_HOST_DEFINITIONS[hostKey];
    assert.ok(def, `Descriptor must exist for host "${hostKey}"`);
    assert.equal(def.host, hostKey, `Descriptor.host must match key "${hostKey}"`);
    assert.ok(typeof def.label === "string" && def.label.length > 0,
      `Descriptor for "${hostKey}" must have a non-empty label`);
    assert.ok(typeof def.support_level === "string",
      `Descriptor for "${hostKey}" must have a support_level`);
    assert.ok(typeof def.setup_kind === "string",
      `Descriptor for "${hostKey}" must have a setup_kind`);
    assert.ok(typeof def.summary === "string" && def.summary.length > 0,
      `Descriptor for "${hostKey}" must have a non-empty summary`);
    assert.ok(typeof def.primary_path_key === "string",
      `Descriptor for "${hostKey}" must have a primary_path_key`);
    assert.ok(Array.isArray(def.supporting_path_keys),
      `Descriptor for "${hostKey}" must have supporting_path_keys array`);
    assert.ok(Array.isArray(def.steps) && def.steps.length > 0,
      `Descriptor for "${hostKey}" must have a non-empty steps array`);
    assert.ok(def.profile && typeof def.profile === "object",
      `Descriptor for "${hostKey}" must have a profile object`);
    assert.ok(typeof def.verify === "function",
      `Descriptor for "${hostKey}" must have a verify function`);
  }
});

test("descriptor table covers exactly codex, opencode, vscode, and antigravity", () => {
  const definedHosts = Object.keys(INSTALL_HOST_DEFINITIONS).sort();
  const expectedHosts = [
    "antigravity",
    "codex",
    "opencode",
    "vscode",
  ];
  assert.deepEqual(definedHosts, expectedHosts);
  // The MCP surface (claude-desktop host) was removed; it must not reappear.
  assert.equal(INSTALL_HOST_DEFINITIONS["claude-desktop"], undefined);
});

test("getInstallHostKeys returns single key for known hosts", () => {
  for (const hostKey of INSTALL_HOST_ORDER) {
    const keys = getInstallHostKeys(hostKey);
    assert.deepEqual(keys, [hostKey]);
  }
});

test("getInstallHostKeys returns all hosts for 'all'", () => {
  const keys = getInstallHostKeys("all");
  assert.deepEqual(keys, INSTALL_HOST_ORDER);
});

test("getInstallHostKeys throws for unknown host", () => {
  assert.throws(() => getInstallHostKeys("nonexistent-host"), {
    message: /Unsupported host "nonexistent-host"/,
  });
});

test("getInstallProfile derives correct flags from host descriptors", () => {
  // codex should set writeAgents
  const codexProfile = getInstallProfile("codex");
  assert.equal(codexProfile.writeAgents, true);
  assert.equal(codexProfile.writeVSCode, false);

  // vscode should set writeVSCode and writeCopilotInstructions
  const vscodeProfile = getInstallProfile("vscode");
  assert.equal(vscodeProfile.writeVSCode, true);
  assert.equal(vscodeProfile.writeCopilotInstructions, true);
  assert.equal(vscodeProfile.writeAgents, false);

  // 'all' should merge all profiles
  const allProfile = getInstallProfile("all");
  assert.equal(allProfile.writeAgents, true);
  assert.equal(allProfile.writeVSCode, true);
  assert.equal(allProfile.writeAntigravity, true);
});

test("install profile skips descriptors whose profile predicate is false", () => {
  // opencode profile does not set writeVSCode
  const openProfile = getInstallProfile("opencode");
  assert.equal(openProfile.writeVSCode, false);
  assert.equal(openProfile.writeAntigravity, false);
  // The MCP surface was removed, so there is no writeClaudeDesktop profile flag.
  assert.equal("writeClaudeDesktop" in openProfile, false);
  // but does set writeOpenCode and writeAgents
  assert.equal(openProfile.writeOpenCode, true);
  assert.equal(openProfile.writeAgents, true);
});

// ── INV-audit-infra-07: renderGeminiCommandToml emits escaped body ───────────

test("renderGeminiCommandToml embeds escaped body (not raw promptBody) in TOML output", () => {
  // A prompt body containing a backslash and a double-quote — characters that
  // must be escaped in a TOML basic multi-line string.
  const rawBody = 'Say "hello" and use C:\\path\\to\\file.';
  const toml = renderGeminiCommandToml(rawBody);

  // The TOML must contain the escaped forms.
  assert.ok(
    toml.includes('\\"hello\\"'),
    "TOML output must escape double-quotes in the prompt body",
  );
  assert.ok(
    toml.includes("C:\\\\path\\\\to\\\\file"),
    "TOML output must escape backslashes in the prompt body",
  );
  // The raw unescaped content must NOT appear verbatim inside the TOML string.
  const promptSectionStart = toml.indexOf('prompt = """');
  assert.ok(promptSectionStart >= 0, "TOML output must contain the prompt field");
  const promptContent = toml.slice(promptSectionStart);
  assert.ok(
    !promptContent.includes('"hello"') || promptContent.includes('\\"hello\\"'),
    "Raw unescaped double-quotes must not appear in the TOML prompt body",
  );
});

test("renderGeminiCommandToml handles a body without special characters unchanged", () => {
  const plainBody = "Run audit-code next-step for the repo.";
  const toml = renderGeminiCommandToml(plainBody);
  assert.ok(toml.includes(plainBody), "Plain body must appear verbatim in TOML output");
  assert.ok(toml.includes('prompt = """'), "TOML must use multi-line basic string syntax");
  assert.ok(toml.startsWith("# /audit-code"), "TOML must start with the header comment");
});

// ── INV-audit-infra-09: no stale MCP tool references in rendered assets ─────

test("renderAntigravityAssets text does not reference removed MCP tools (INV-audit-infra-09)", () => {
  // These tools were removed when the MCP surface was dropped. Any rendered
  // asset that instructs the host agent to call them silently fails because the
  // tools no longer exist.
  const STALE_MCP_TOOLS = ["start_audit", "get_status", "continue_audit"];
  const installHostsPath = join(repoRoot, "audit-code-wrapper-install-hosts.mjs");
  const source = readFileSync(installHostsPath, "utf8");
  for (const tool of STALE_MCP_TOOLS) {
    // Allow deny-list entries (e.g. 'deny' rules in permission config) and
    // comments, but not live instructions to the agent to *call* the tool.
    // A bare tool name appearing as a string literal in rendered text is a signal.
    const inInstructionContext = new RegExp(
      `call\`[^]*\`${tool}|call.*\`${tool}\`|\`${tool}\`.*call|\\bcall ${tool}\\b`,
      "g",
    );
    assert.ok(
      !inInstructionContext.test(source),
      `Rendered host assets must not instruct the agent to call removed MCP tool '${tool}'`,
    );
    // The direct string reference that was found in the VsCodeAgentFile / MCP
    // agent instruction text — a plain inline mention in a rendered template string.
    const inRenderContext = new RegExp(
      `call \`${tool}\`|call.*${tool}.*those tools return`,
      "g",
    );
    assert.ok(
      !inRenderContext.test(source),
      `Rendered host asset template must not reference removed MCP tool '${tool}'`,
    );
  }
});

// ── INV-audit-infra-10: agent_reflection.schema.json severity enum ───────────

test("agent_reflection.schema.json severity enum includes 'critical' (INV-audit-infra-10)", () => {
  const schemaPath = join(repoRoot, "schemas", "agent_reflection.schema.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const severityEnum = schema?.properties?.severity?.enum;
  assert.ok(Array.isArray(severityEnum), "severity must have an enum in agent_reflection.schema.json");
  assert.ok(
    severityEnum.includes("critical"),
    `agent_reflection.schema.json severity enum must include 'critical' to match finding severity; got: ${JSON.stringify(severityEnum)}`,
  );
  // All expected severity levels must be present.
  for (const level of ["info", "low", "medium", "high", "critical"]) {
    assert.ok(
      severityEnum.includes(level),
      `severity enum must include '${level}'`,
    );
  }
});

// ── INV-repo-assets-01/03/04: loader asset parity — handshake flags in all three assets ─

test("INV-repo-assets-01: SKILL.md source carries next-step invocation with capability handshake flags", () => {
  const skillPath = join(repoRoot, "skills", "audit-code", "SKILL.md");
  const skill = readFileSync(skillPath, "utf8");
  const REQUIRED_FLAGS = [
    "--host-max-active-subagents",
    "--host-models",
    "--host-context-tokens",
    "--host-output-tokens",
  ];
  for (const flag of REQUIRED_FLAGS) {
    assert.ok(
      skill.includes(flag),
      `SKILL.md must carry capability handshake flag '${flag}' (INV-repo-assets-01)`,
    );
  }
  assert.ok(
    skill.includes("audit-code next-step"),
    "SKILL.md must include an 'audit-code next-step' invocation (INV-repo-assets-01)",
  );
});

test("INV-repo-assets-03: SKILL.md contains no hardcoded model names or tier-map tables", () => {
  const skillPath = join(repoRoot, "skills", "audit-code", "SKILL.md");
  const skill = readFileSync(skillPath, "utf8");
  // Relative rank labels ("small"/"standard"/"deep") are fine; concrete model names are not.
  const FORBIDDEN_PATTERNS = [
    /claude-[a-z0-9]/i,
    /gpt-[0-9]/i,
    /gemini-[a-z]/i,
    /sonnet|opus|haiku/i,
    /llama|mistral|codestral/i,
    /KNOWN_MODEL_LIMITS/,
    /CAPABILITY_TIER_MAP/,
  ];
  for (const pattern of FORBIDDEN_PATTERNS) {
    assert.ok(
      !pattern.test(skill),
      `SKILL.md must not contain hardcoded model identity '${pattern}' (INV-repo-assets-03)`,
    );
  }
});

test("INV-repo-assets-04: all three loader assets carry the same capability handshake flag set", () => {
  // Canonical source assets — these are what get installed into host environments.
  // repoRoot = packages/audit-code; monorepoRoot = two levels up.
  const monorepoRoot = join(repoRoot, "..", "..");
  const skillPath = join(repoRoot, "skills", "audit-code", "SKILL.md");
  const promptPath = join(monorepoRoot, ".github", "prompts", "audit-code.prompt.md");
  const tomlPath = join(monorepoRoot, ".gemini", "commands", "audit-code.toml");

  const skill = readFileSync(skillPath, "utf8");
  const prompt = readFileSync(promptPath, "utf8");
  const toml = readFileSync(tomlPath, "utf8");

  const HANDSHAKE_FLAGS = [
    "--host-max-active-subagents",
    "--host-models",
    "--host-context-tokens",
    "--host-output-tokens",
  ];

  for (const flag of HANDSHAKE_FLAGS) {
    assert.ok(
      skill.includes(flag),
      `SKILL.md must carry handshake flag '${flag}' (INV-repo-assets-04 parity)`,
    );
    assert.ok(
      prompt.includes(flag),
      `audit-code.prompt.md must carry handshake flag '${flag}' (INV-repo-assets-04 parity)`,
    );
    assert.ok(
      toml.includes(flag),
      `audit-code.toml must carry handshake flag '${flag}' (INV-repo-assets-04 parity)`,
    );
  }

  // All three must reference the next-step command.
  for (const [name, content] of [["SKILL.md", skill], ["prompt.md", prompt], ["toml", toml]]) {
    assert.ok(
      content.includes("next-step"),
      `${name} must include 'next-step' invocation (INV-repo-assets-04 parity)`,
    );
  }
});

// ── verify function ──────────────────────────────────────────────────────────

test("verify function receives correct context shape", async () => {
  // Test that the verify callback is called with the expected argument shape
  const fakeDef = INSTALL_HOST_DEFINITIONS["codex"];
  let receivedContext = null;

  // Create a wrapper to capture the context
  const originalVerify = fakeDef.verify;
  const fakeChecks = [];
  const fakeAssetPaths = { agentsInstructionsPath: "/tmp/nonexistent" };
  const fakeCollect = async (checks, id, fn) => {
    checks.push({ id, status: "skipped" });
  };

  try {
    await originalVerify.call(fakeDef, {
      checks: fakeChecks,
      root: "/tmp",
      assetPaths: fakeAssetPaths,
      collectVerifyCheck: fakeCollect,
    });
  } catch {
    // verify may throw since paths don't exist -- that's fine for this test
  }

  // The verify function should have attempted to collect at least one check
  assert.ok(
    fakeChecks.length > 0,
    "codex verify should collect at least one check via collectVerifyCheck",
  );
  assert.equal(fakeChecks[0].id, "codex_global_surface");
});
