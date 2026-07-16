import { test, expect } from "vitest";
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
} from "../../wrapper/audit-code-wrapper-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

test("every host in INSTALL_HOST_ORDER has a complete descriptor with verify", () => {
  for (const hostKey of INSTALL_HOST_ORDER) {
    const def = INSTALL_HOST_DEFINITIONS[hostKey];
    expect(def, `Descriptor must exist for host "${hostKey}"`).toBeTruthy();
    expect(def.host, `Descriptor.host must match key "${hostKey}"`).toBe(hostKey);
    expect(typeof def.label === "string" && def.label.length > 0, `Descriptor for "${hostKey}" must have a non-empty label`).toBeTruthy();
    expect(typeof def.support_level === "string", `Descriptor for "${hostKey}" must have a support_level`).toBeTruthy();
    expect(typeof def.setup_kind === "string", `Descriptor for "${hostKey}" must have a setup_kind`).toBeTruthy();
    expect(typeof def.summary === "string" && def.summary.length > 0, `Descriptor for "${hostKey}" must have a non-empty summary`).toBeTruthy();
    expect(typeof def.primary_path_key === "string", `Descriptor for "${hostKey}" must have a primary_path_key`).toBeTruthy();
    expect(Array.isArray(def.supporting_path_keys), `Descriptor for "${hostKey}" must have supporting_path_keys array`).toBeTruthy();
    expect(Array.isArray(def.steps) && def.steps.length > 0, `Descriptor for "${hostKey}" must have a non-empty steps array`).toBeTruthy();
    expect(def.profile && typeof def.profile === "object", `Descriptor for "${hostKey}" must have a profile object`).toBeTruthy();
    expect(typeof def.verify === "function", `Descriptor for "${hostKey}" must have a verify function`).toBeTruthy();
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
  expect(definedHosts).toEqual(expectedHosts);
  // The MCP surface (claude-desktop host) was removed; it must not reappear.
  expect(INSTALL_HOST_DEFINITIONS["claude-desktop"]).toBe(undefined);
});

test("getInstallHostKeys returns single key for known hosts", () => {
  for (const hostKey of INSTALL_HOST_ORDER) {
    const keys = getInstallHostKeys(hostKey);
    expect(keys).toEqual([hostKey]);
  }
});

test("getInstallHostKeys returns all hosts for 'all'", () => {
  const keys = getInstallHostKeys("all");
  expect(keys).toEqual(INSTALL_HOST_ORDER);
});

test("getInstallHostKeys throws for unknown host", () => {
  assert.throws(() => getInstallHostKeys("nonexistent-host"), {
    message: /Unsupported host "nonexistent-host"/,
  });
});

test("getInstallProfile derives correct flags from host descriptors", () => {
  // codex should set writeAgents
  const codexProfile = getInstallProfile("codex");
  expect(codexProfile.writeAgents).toBe(true);
  expect(codexProfile.writeVSCode).toBe(false);

  // vscode should set writeVSCode and writeCopilotInstructions
  const vscodeProfile = getInstallProfile("vscode");
  expect(vscodeProfile.writeVSCode).toBe(true);
  expect(vscodeProfile.writeCopilotInstructions).toBe(true);
  expect(vscodeProfile.writeAgents).toBe(false);

  // 'all' should merge all profiles
  const allProfile = getInstallProfile("all");
  expect(allProfile.writeAgents).toBe(true);
  expect(allProfile.writeVSCode).toBe(true);
  expect(allProfile.writeAntigravity).toBe(true);
});

test("install profile skips descriptors whose profile predicate is false", () => {
  // opencode profile does not set writeVSCode
  const openProfile = getInstallProfile("opencode");
  expect(openProfile.writeVSCode).toBe(false);
  expect(openProfile.writeAntigravity).toBe(false);
  // The MCP surface was removed, so there is no writeClaudeDesktop profile flag.
  expect("writeClaudeDesktop" in openProfile).toBe(false);
  // but does set writeOpenCode and writeAgents
  expect(openProfile.writeOpenCode).toBe(true);
  expect(openProfile.writeAgents).toBe(true);
});

// ── INV-audit-infra-07: renderGeminiCommandToml emits escaped body ───────────

test("renderGeminiCommandToml embeds escaped body (not raw promptBody) in TOML output", () => {
  // A prompt body containing a backslash and a double-quote — characters that
  // must be escaped in a TOML basic multi-line string.
  const rawBody = 'Say "hello" and use C:\\path\\to\\file.';
  const toml = renderGeminiCommandToml(rawBody);

  // The TOML must contain the escaped forms.
  expect(toml.includes('\\"hello\\"'), "TOML output must escape double-quotes in the prompt body").toBeTruthy();
  expect(toml.includes("C:\\\\path\\\\to\\\\file"), "TOML output must escape backslashes in the prompt body").toBeTruthy();
  // The raw unescaped content must NOT appear verbatim inside the TOML string.
  const promptSectionStart = toml.indexOf('prompt = """');
  expect(promptSectionStart >= 0, "TOML output must contain the prompt field").toBeTruthy();
  const promptContent = toml.slice(promptSectionStart);
  expect(!promptContent.includes('"hello"') || promptContent.includes('\\"hello\\"'), "Raw unescaped double-quotes must not appear in the TOML prompt body").toBeTruthy();
});

test("renderGeminiCommandToml handles a body without special characters unchanged", () => {
  const plainBody = "Run audit-code next-step for the repo.";
  const toml = renderGeminiCommandToml(plainBody);
  expect(toml.includes(plainBody), "Plain body must appear verbatim in TOML output").toBeTruthy();
  expect(toml.includes('prompt = """'), "TOML must use multi-line basic string syntax").toBeTruthy();
  expect(toml.startsWith("# /audit-code"), "TOML must start with the header comment").toBeTruthy();
});

// ── INV-audit-infra-09: no stale MCP tool references in rendered assets ─────

test("renderAntigravityAssets text does not reference removed MCP tools (INV-audit-infra-09)", () => {
  // These tools were removed when the MCP surface was dropped. Any rendered
  // asset that instructs the host agent to call them silently fails because the
  // tools no longer exist.
  const STALE_MCP_TOOLS = ["start_audit", "get_status", "continue_audit"];
  const installHostsPath = join(repoRoot, "wrapper", "audit-code-wrapper-install-hosts.mjs");
  const source = readFileSync(installHostsPath, "utf8");
  for (const tool of STALE_MCP_TOOLS) {
    // Allow deny-list entries (e.g. 'deny' rules in permission config) and
    // comments, but not live instructions to the agent to *call* the tool.
    // A bare tool name appearing as a string literal in rendered text is a signal.
    const inInstructionContext = new RegExp(
      `call\`[^]*\`${tool}|call.*\`${tool}\`|\`${tool}\`.*call|\\bcall ${tool}\\b`,
      "g",
    );
    expect(!inInstructionContext.test(source), `Rendered host assets must not instruct the agent to call removed MCP tool '${tool}'`).toBeTruthy();
    // The direct string reference that was found in the VsCodeAgentFile / MCP
    // agent instruction text — a plain inline mention in a rendered template string.
    const inRenderContext = new RegExp(
      `call \`${tool}\`|call.*${tool}.*those tools return`,
      "g",
    );
    expect(!inRenderContext.test(source), `Rendered host asset template must not reference removed MCP tool '${tool}'`).toBeTruthy();
  }
});

// ── INV-audit-infra-10: agent_reflection.schema.json severity enum ───────────

test("AgentReflection severity enum includes 'critical' (INV-audit-infra-10)", async () => {
  const { ReflectionSeveritySchema } = await import("audit-tools/shared");
  const severityEnum = ReflectionSeveritySchema.options;
  expect(severityEnum.includes("critical"), `AgentReflection severity enum must include 'critical' to match finding severity; got: ${JSON.stringify(severityEnum)}`).toBeTruthy();
  // All expected severity levels must be present.
  for (const level of ["info", "low", "medium", "high", "critical"]) {
    expect(severityEnum.includes(level), `severity enum must include '${level}'`).toBeTruthy();
  }
});

// ── INV-repo-assets-01/03/04: loader asset parity — handshake flags in all three assets ─

test("INV-repo-assets-01: SKILL.md source carries next-step invocation with capability handshake flags", () => {
  const skillPath = join(repoRoot, "skills", "audit-code", "SKILL.md");
  const skill = readFileSync(skillPath, "utf8");
  const REQUIRED_FLAGS = [
    "--auditor",
    "roster",
    "context_tokens",
    "output_tokens",
  ];
  for (const flag of REQUIRED_FLAGS) {
    expect(skill.includes(flag), `SKILL.md must carry capability handshake flag '${flag}' (INV-repo-assets-01)`).toBeTruthy();
  }
  expect(skill.includes("audit-code next-step"), "SKILL.md must include an 'audit-code next-step' invocation (INV-repo-assets-01)").toBeTruthy();
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
    expect(!pattern.test(skill), `SKILL.md must not contain hardcoded model identity '${pattern}' (INV-repo-assets-03)`).toBeTruthy();
  }
});

test("INV-repo-assets-04: all three loader assets carry the same capability handshake flag set", () => {
  // Canonical source assets — these are what get installed into host environments.
  // Single-package repo: all committed host assets live at the repo root.
  const skillPath = join(repoRoot, "skills", "audit-code", "SKILL.md");
  const promptPath = join(repoRoot, ".github", "prompts", "audit-code.prompt.md");
  const tomlPath = join(repoRoot, ".gemini", "commands", "audit-code.toml");

  const skill = readFileSync(skillPath, "utf8");
  const prompt = readFileSync(promptPath, "utf8");
  const toml = readFileSync(tomlPath, "utf8");

  const HANDSHAKE_FLAGS = [
    "--auditor",
    "roster",
    "context_tokens",
    "output_tokens",
  ];

  for (const flag of HANDSHAKE_FLAGS) {
    expect(skill.includes(flag), `SKILL.md must carry handshake flag '${flag}' (INV-repo-assets-04 parity)`).toBeTruthy();
    expect(prompt.includes(flag), `audit-code.prompt.md must carry handshake flag '${flag}' (INV-repo-assets-04 parity)`).toBeTruthy();
    expect(toml.includes(flag), `audit-code.toml must carry handshake flag '${flag}' (INV-repo-assets-04 parity)`).toBeTruthy();
  }

  // All three must reference the next-step command.
  for (const [name, content] of [["SKILL.md", skill], ["prompt.md", prompt], ["toml", toml]]) {
    expect(content.includes("next-step"), `${name} must include 'next-step' invocation (INV-repo-assets-04 parity)`).toBeTruthy();
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
  expect(fakeChecks.length > 0, "codex verify should collect at least one check via collectVerifyCheck").toBeTruthy();
  expect(fakeChecks[0].id).toBe("codex_global_surface");
});
