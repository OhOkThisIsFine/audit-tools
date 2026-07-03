import { describe, it, expect } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

// ── Committed remediate host assets in scope ──────────────────────────────────
//
// Source/canonical body (single source of truth for the handshake flag set):
const CANONICAL_BODY_PATH = join(repoRoot, "skills", "remediate-code", "remediate-code.prompt.md");

// BODY-EMBEDDING assets: each inlines the canonical prompt body, so every
// handshake flag in the body must appear in each of them.
const BODY_EMBEDDING_ASSETS: Array<{ name: string; path: string }> = [
  { name: ".github/prompts/remediate-code.prompt.md", path: join(repoRoot, ".github", "prompts", "remediate-code.prompt.md") },
  { name: ".github/agents/remediator.agent.md", path: join(repoRoot, ".github", "agents", "remediator.agent.md") },
  { name: ".gemini/commands/remediate-code.toml", path: join(repoRoot, ".gemini", "commands", "remediate-code.toml") },
];

// The .agent SKILL is a SOURCE COPY of the bare skills/remediate-code/SKILL.md
// (a copy, not a body render). It carries a next-step reference only.
const AGENT_SKILL_PATH = join(repoRoot, ".agent", "skills", "remediate-code", "SKILL.md");
const SOURCE_SKILL_PATH = join(repoRoot, "skills", "remediate-code", "SKILL.md");

// Bare SKILL assets: assert only that they reference 'remediate-code next-step'.
const BARE_NEXT_STEP_ASSETS: Array<{ name: string; path: string }> = [
  { name: ".agent/skills/remediate-code/SKILL.md", path: AGENT_SKILL_PATH },
  { name: "skills/remediate-code/SKILL.md", path: SOURCE_SKILL_PATH },
];

// Every committed asset — used by the presence guard so a missing file fails loudly.
const ALL_ASSET_PATHS: Array<{ name: string; path: string }> = [
  ...BODY_EMBEDDING_ASSETS,
  ...BARE_NEXT_STEP_ASSETS,
];

// Same forbidden-model-name set as the audit host-bootstrap test. Relative rank
// labels (small/standard/deep) are allowed; concrete model identities are not.
const FORBIDDEN_PATTERNS = [
  /claude-[a-z0-9]/i,
  /gpt-[0-9]/i,
  /gemini-[a-z]/i,
  /sonnet|opus|haiku/i,
  /llama|mistral|codestral/i,
  /KNOWN_MODEL_LIMITS/,
  /CAPABILITY_TIER_MAP/,
];

const NEXT_STEP_INVOCATION = "remediate-code next-step";

function normalizeCRLF(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

// Derive the full handshake flag set from the canonical body so a future dropped
// flag fails the guard (no hardcoded partial flag literal). Currently yields six,
// including --host-model-id.
function deriveHandshakeFlags(): string[] {
  const body = readFileSync(CANONICAL_BODY_PATH, "utf8");
  const matches = body.match(/--host-[a-z-]+/g) ?? [];
  const flags = Array.from(new Set(matches)).sort();
  return flags;
}

describe("INV-remediate-assets: remediate host asset drift guard", () => {
  it("INV-remediate-assets-06: every committed remediate asset is present (missing fails loudly)", () => {
    for (const { name, path } of ALL_ASSET_PATHS) {
      // readFileSync throws (ENOENT) on a missing asset — do not swallow.
      const content = readFileSync(path, "utf8");
      expect(content.length, `${name} must be a non-empty committed asset`).toBeGreaterThan(0);
    }
  });

  it("INV-remediate-assets-01: body-derived handshake flags appear in every body-embedding asset + next-step", () => {
    const flags = deriveHandshakeFlags();
    // Sanity: the body currently defines six flags incl. --host-model-id.
    expect(flags.length, `canonical body must define the handshake flag set; got ${JSON.stringify(flags)}`).toBeGreaterThanOrEqual(6);
    expect(flags.includes("--host-model-id"), "canonical body must still carry --host-model-id").toBe(true);

    for (const { name, path } of BODY_EMBEDDING_ASSETS) {
      const content = readFileSync(path, "utf8");
      for (const flag of flags) {
        expect(content.includes(flag), `${name} must carry body-derived handshake flag '${flag}' (INV-remediate-assets-01)`).toBe(true);
      }
      expect(content.includes(NEXT_STEP_INVOCATION), `${name} must reference '${NEXT_STEP_INVOCATION}' (INV-remediate-assets-01)`).toBe(true);
    }

    // The bare skills/remediate-code/SKILL.md is asserted only for the next-step invocation.
    const bareSkill = readFileSync(SOURCE_SKILL_PATH, "utf8");
    expect(bareSkill.includes(NEXT_STEP_INVOCATION), `skills/remediate-code/SKILL.md must reference '${NEXT_STEP_INVOCATION}' (INV-remediate-assets-01)`).toBe(true);
  });

  it("INV-remediate-assets-03: no hardcoded model names in any remediate asset", () => {
    for (const { name, path } of ALL_ASSET_PATHS) {
      // "Claude-style"/"Codex-style" etc. are host-name references, not model
      // identities. Strip that fixed host-adjective phrase so the model-name
      // guard still catches real identities (e.g. "claude-3") without a false
      // positive on the host reference.
      const content = readFileSync(path, "utf8").replace(/\bClaude-style\b/gi, "HOST-style");
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(!pattern.test(content), `${name} must not contain hardcoded model identity '${pattern}' (INV-remediate-assets-03)`).toBe(true);
      }
    }
  });

  it("INV-remediate-assets-04: every body-embedding asset carries the identical body-derived flag set + a next-step reference", () => {
    const flags = deriveHandshakeFlags();
    for (const { name, path } of BODY_EMBEDDING_ASSETS) {
      const content = readFileSync(path, "utf8");
      const present = flags.filter((flag) => content.includes(flag));
      expect(present, `${name} must carry the identical body-derived flag set (INV-remediate-assets-04)`).toEqual(flags);
      expect(content.includes(NEXT_STEP_INVOCATION), `${name} must reference '${NEXT_STEP_INVOCATION}' (INV-remediate-assets-04)`).toBe(true);
    }
  });

  it("INV-remediate-assets-05: .agent SKILL is a byte-equal (CRLF-normalized) copy of the source SKILL", () => {
    const agentSkill = readFileSync(AGENT_SKILL_PATH, "utf8");
    const sourceSkill = readFileSync(SOURCE_SKILL_PATH, "utf8");
    // It is a copy of the source, NOT a render — assert exact equality after
    // normalizing line endings so Windows CRLF vs LF does not spuriously fail.
    assert.equal(
      normalizeCRLF(agentSkill),
      normalizeCRLF(sourceSkill),
      ".agent/skills/remediate-code/SKILL.md must be a byte-equal copy of skills/remediate-code/SKILL.md (INV-remediate-assets-05)",
    );
  });
});
