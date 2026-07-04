import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderVSCodeAgentFile,
  renderCodexAutomationRecipe,
  renderAntigravityPlanningGuide,
  renderGeminiCommandToml,
} from "../../wrapper/audit-code-wrapper-install-renderers.mjs";
import { buildInstallDirective } from "../../wrapper/audit-code-wrapper-install-hosts.mjs";
import { assertOpenCodeAuditPermissionConfig } from "../../wrapper/audit-code-wrapper-opencode.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

/** Strip YAML frontmatter, returning only the body (LF-normalized). */
function bodyOf(markdown) {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n[\s\S]*?\n---\n?/u);
  return match ? normalized.slice(match[0].length) : normalized;
}

const promptSource = readFileSync(
  join(repoRoot, "skills", "audit-code", "audit-code.prompt.md"),
  "utf8",
);
const canonicalBody = bodyOf(promptSource);

function lf(text) {
  return text.replace(/\r\n/g, "\n");
}

// Every IDE host asset must derive from the ONE canonical prompt body. These are
// the renderers that previously hand-authored bespoke per-host prose (and so
// dropped the next-step capability handshake / embedded a wrong entrypoint).
const RENDERED_ASSETS = {
  "vscode-agent": renderVSCodeAgentFile(canonicalBody),
  "codex-recipe": renderCodexAutomationRecipe(canonicalBody),
  "antigravity-guide": renderAntigravityPlanningGuide(canonicalBody),
  "gemini-toml": renderGeminiCommandToml(canonicalBody),
};

// ── E1: every IDE asset embeds the canonical body verbatim ───────────────────

test("E1: every IDE host asset embeds the canonical loader body verbatim", () => {
  // The Gemini TOML escapes backslashes/quotes for TOML; the markdown assets
  // embed the body unescaped. Spot-check structural anchors that only exist in
  // the canonical body so we know each asset actually wrapped it.
  for (const [kind, asset] of Object.entries(RENDERED_ASSETS)) {
    expect(asset.includes("# `/audit-code` Loader"), `${kind} asset must embed the canonical loader heading`).toBeTruthy();
    expect(asset.includes("capability\nhandshake") || asset.includes("capability handshake") ||
        asset.includes("**capability"), `${kind} asset must embed the capability handshake section`).toBeTruthy();
  }
});

// ── E1: capability handshake (incl. --host-models) in BOTH initial + continuation ─

test("E1: --host-models appears in BOTH the report and continuation guidance for every IDE asset", () => {
  for (const [kind, asset] of Object.entries(RENDERED_ASSETS)) {
    // The asset overall must carry the flag (initial Report block).
    expect(asset.includes("--host-models"), `${kind} asset must carry --host-models in the capability handshake`).toBeTruthy();
    // The CONTINUATION guidance ("run ... next-step again with the same
    // capability flags (...)") must itself list --host-models, so a host that
    // only reads the continuation block on later turns still reports its roster.
    const continuationMatch = asset.match(
      /again with[\s\S]*?(`--host-models`)[\s\S]*?prompt_path/,
    );
    expect(continuationMatch, `${kind} asset continuation section must list --host-models alongside the other capability flags`).toBeTruthy();
  }
});

test("E1: all four capability flags appear in every IDE asset", () => {
  const FLAGS = [
    "--host-max-active-subagents",
    "--host-models",
    "--host-context-tokens",
    "--host-output-tokens",
  ];
  for (const [kind, asset] of Object.entries(RENDERED_ASSETS)) {
    for (const flag of FLAGS) {
      expect(asset.includes(flag), `${kind} asset must carry capability flag '${flag}'`).toBeTruthy();
    }
  }
});

// ── E1: correct in-repo entrypoint (no wrong `node audit-code.mjs` root path) ─

test("E1: every IDE asset uses the correct in-repo entrypoint, not a stale monorepo path", () => {
  for (const [kind, asset] of Object.entries(RENDERED_ASSETS)) {
    // A12 collapsed the monorepo: the dev entrypoint is `audit-code.mjs` at the
    // repo root, not the old `packages/audit-code/audit-code.mjs`.
    expect(/\bnode audit-code\.mjs\b/.test(asset), `${kind} asset must reference the repo-root 'node audit-code.mjs' entrypoint`).toBeTruthy();
    expect(!asset.includes("packages/audit-code/audit-code.mjs"), `${kind} asset must not embed the stale 'packages/audit-code/audit-code.mjs' entrypoint`).toBeTruthy();
  }
});

// ── E1: no-drift guard — committed rendered asset == freshly rendered ────────

test("no-drift: committed .gemini/commands/audit-code.toml equals a fresh render of the canonical body", () => {
  const committed = lf(
    readFileSync(
      join(repoRoot, ".gemini", "commands", "audit-code.toml"),
      "utf8",
    ),
  );
  expect(committed, "Committed Gemini TOML drifted from the canonical body. Re-run `audit-code install` (or regenerate the asset).").toBe(lf(RENDERED_ASSETS["gemini-toml"]));
});

test("no-drift: committed .github/agents/auditor.agent.md equals a fresh render of the canonical body", () => {
  const committed = lf(
    readFileSync(
      join(repoRoot, ".github", "agents", "auditor.agent.md"),
      "utf8",
    ),
  );
  expect(committed, "Committed VS Code agent file drifted from the canonical body. Re-run `audit-code install` (or regenerate the asset).").toBe(lf(RENDERED_ASSETS["vscode-agent"]));
});

// ── no-drift guard: managed-block + merge-target host assets ──────────────────
//
// AGENTS.md, .github/copilot-instructions.md, and opencode.json are NOT
// full-file renderHostAsset outputs (those are the two above). They are
// managed-block / merge targets by design: the two instruction files embed a
// tool-owned `<!-- audit-code:begin -->…<!-- audit-code:end -->` directive
// inside a hand-authored file, and opencode.json is a merged multi-orchestrator
// permission config. The correct no-drift invariant for them is that the
// TOOL-OWNED portion is renderer-identical — the audit-code directive block must
// equal buildInstallDirective(...), and the audit permission blocks must satisfy
// assertOpenCodeAuditPermissionConfig — even though the surrounding hand-authored
// content (the CLAUDE.md preamble, the remediate-code block, repo-specific
// permission paths) legitimately differs from a bare render.

const AUDIT_BLOCK_START = "<!-- audit-code:begin -->";
const AUDIT_BLOCK_END = "<!-- audit-code:end -->";

/** Extract the tool-owned audit-code managed block (markers included), LF-normalized. */
function auditManagedBlock(markdown) {
  const normalized = lf(markdown);
  const start = normalized.indexOf(AUDIT_BLOCK_START);
  const end = normalized.indexOf(AUDIT_BLOCK_END);
  if (start < 0 || end < 0) {
    return null;
  }
  return normalized.slice(start, end + AUDIT_BLOCK_END.length);
}

test("no-drift: committed AGENTS.md audit-code directive block equals buildInstallDirective output", () => {
  const committed = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
  const block = auditManagedBlock(committed);
  expect(block, "AGENTS.md is missing the audit-code managed directive block. Run `audit-code install`.").not.toBeNull();
  // AGENTS.md lives at the repo root, so the directive points at the install
  // prompt via a repo-root-relative path.
  const expected = lf(
    buildInstallDirective(".audit-code/install/audit-code.import.md"),
  );
  expect(block, "AGENTS.md audit-code directive block drifted from the installer output. Run `audit-code install`.").toBe(expected);
});

test("no-drift: committed .github/copilot-instructions.md audit-code directive block equals buildInstallDirective output", () => {
  const committed = readFileSync(
    join(repoRoot, ".github", "copilot-instructions.md"),
    "utf8",
  );
  const block = auditManagedBlock(committed);
  expect(block, ".github/copilot-instructions.md is missing the audit-code managed directive block. Run `audit-code install`.").not.toBeNull();
  // copilot-instructions.md lives under .github/, so the directive points at the
  // install prompt one directory up.
  const expected = lf(
    buildInstallDirective("../.audit-code/install/audit-code.import.md"),
  );
  expect(block, ".github/copilot-instructions.md audit-code directive block drifted from the installer output. Run `audit-code install`.").toBe(expected);
});

test("no-drift: committed opencode.json audit permission blocks satisfy the installer permission contract", () => {
  const config = JSON.parse(
    readFileSync(join(repoRoot, "opencode.json"), "utf8"),
  );
  // The tool never writes a project-level /audit-code command or mcp.auditor —
  // those are global npm-installed state.
  expect(config?.command?.["audit-code"], "opencode.json must not define command['audit-code'] (global npm state). Run `audit-code install --host opencode`.").toBeUndefined();
  expect(config?.mcp?.auditor, "opencode.json must not define mcp.auditor (global npm state). Run `audit-code install --host opencode`.").toBeUndefined();
  // The audit permission blocks must match the installer's permission contract.
  expect(() => assertOpenCodeAuditPermissionConfig(config?.permission, "permission")).not.toThrow();
  expect(() => assertOpenCodeAuditPermissionConfig(config?.agent?.auditor?.permission, "agent.auditor.permission")).not.toThrow();
});
