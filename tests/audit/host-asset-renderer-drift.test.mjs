import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderVSCodeAgentFile,
  renderCodexAutomationRecipe,
  renderAntigravityPlanningGuide,
  renderGeminiCommandToml,
} from "../../audit-code-wrapper-install-renderers.mjs";

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
    assert.ok(
      asset.includes("# `/audit-code` Loader"),
      `${kind} asset must embed the canonical loader heading`,
    );
    assert.ok(
      asset.includes("capability\nhandshake") || asset.includes("capability handshake") ||
        asset.includes("**capability"),
      `${kind} asset must embed the capability handshake section`,
    );
  }
});

// ── E1: capability handshake (incl. --host-models) in BOTH initial + continuation ─

test("E1: --host-models appears in BOTH the report and continuation guidance for every IDE asset", () => {
  for (const [kind, asset] of Object.entries(RENDERED_ASSETS)) {
    // The asset overall must carry the flag (initial Report block).
    assert.ok(
      asset.includes("--host-models"),
      `${kind} asset must carry --host-models in the capability handshake`,
    );
    // The CONTINUATION guidance ("run ... next-step again with the same
    // capability flags (...)") must itself list --host-models, so a host that
    // only reads the continuation block on later turns still reports its roster.
    const continuationMatch = asset.match(
      /again with[\s\S]*?(`--host-models`)[\s\S]*?prompt_path/,
    );
    assert.ok(
      continuationMatch,
      `${kind} asset continuation section must list --host-models alongside the other capability flags`,
    );
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
      assert.ok(
        asset.includes(flag),
        `${kind} asset must carry capability flag '${flag}'`,
      );
    }
  }
});

// ── E1: correct in-repo entrypoint (no wrong `node audit-code.mjs` root path) ─

test("E1: every IDE asset uses the correct in-repo entrypoint, not a wrong root path", () => {
  for (const [kind, asset] of Object.entries(RENDERED_ASSETS)) {
    assert.ok(
      asset.includes("node packages/audit-code/audit-code.mjs"),
      `${kind} asset must reference the correct in-repo entrypoint`,
    );
    // The stale wrong entrypoint (no `audit-code.mjs` exists at the monorepo
    // root) must not reappear as a bare `node audit-code.mjs ...` instruction.
    assert.ok(
      !/\bnode audit-code\.mjs\b/.test(asset),
      `${kind} asset must not embed the wrong 'node audit-code.mjs' entrypoint`,
    );
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
  assert.equal(
    committed,
    lf(RENDERED_ASSETS["gemini-toml"]),
    "Committed Gemini TOML drifted from the canonical body. Re-run `audit-code install` (or regenerate the asset).",
  );
});

test("no-drift: committed .github/agents/auditor.agent.md equals a fresh render of the canonical body", () => {
  const committed = lf(
    readFileSync(
      join(repoRoot, ".github", "agents", "auditor.agent.md"),
      "utf8",
    ),
  );
  assert.equal(
    committed,
    lf(RENDERED_ASSETS["vscode-agent"]),
    "Committed VS Code agent file drifted from the canonical body. Re-run `audit-code install` (or regenerate the asset).",
  );
});
