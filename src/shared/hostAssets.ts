/**
 * Single-sourced host-asset renderers.
 *
 * Every IDE/host integration asset (VS Code custom-agent file, Codex automation
 * recipe, Antigravity planning guide, Gemini/Antigravity slash-command TOML) is
 * derived from the ONE canonical loader prompt body. The bespoke per-host
 * renderers are thin format wrappers (frontmatter / header / TOML quoting) around
 * the shared body — they never re-author the loader instructions. This makes it
 * impossible for a host asset to drift out of sync with the canonical body (e.g.
 * to silently drop the `next-step` capability handshake or `--host-models`, or to
 * embed a wrong in-repo entrypoint), which is enforced by a no-drift guard test.
 *
 * `toolName` parameterizes the slash-command / bin name so both orchestrators
 * (`audit-code` and `remediate-code`) render from this one source.
 */

/** Kinds of host asset that wrap the canonical prompt body in a host-specific format. */
export type HostAssetKind =
  | "vscode-agent"
  | "codex-recipe"
  | "antigravity-guide"
  | "gemini-toml";

export interface RenderHostAssetOptions {
  /**
   * The canonical loader prompt body (frontmatter already stripped). This is the
   * single source every host asset embeds verbatim — it carries the `next-step`
   * capability handshake (including `--host-models`) in both the initial and the
   * continuation guidance, and the correct in-repo entrypoint.
   */
  promptBody: string;
  /** Slash-command / bin name, e.g. "audit-code" or "remediate-code". */
  toolName: string;
  /**
   * One-line description used in slash-command/agent metadata. Defaults to a
   * generic line derived from `toolName` when omitted.
   */
  description?: string;
}

/** Trimmed canonical body, with a single trailing newline trimmed off. */
function canonicalBody(promptBody: string): string {
  return promptBody.replace(/\r\n/g, "\n").trimEnd();
}

/**
 * Render a YAML frontmatter block from ordered key/value pairs. Empty/undefined
 * values are skipped. Returns "" when no fields survive.
 */
function renderFrontmatter(fields: Array<[string, string | undefined]>): string {
  const entries = fields.filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[1].length > 0,
  );
  if (entries.length === 0) {
    return "";
  }
  return ["---", ...entries.map(([k, v]) => `${k}: ${v}`), "---", "", ""].join("\n");
}

/**
 * Render the VS Code custom-agent markdown file. The agent's job is to drive the
 * `/<toolName>` workflow through the next-step machine, so it embeds the canonical
 * loader body verbatim (which carries the full capability handshake) rather than
 * re-authoring abbreviated prose.
 */
function renderVSCodeAgent(opts: RenderHostAssetOptions): string {
  const description =
    opts.description ??
    `Plan and orchestrate /${opts.toolName} through the next-step machine before making code changes.`;
  const frontmatter = renderFrontmatter([["description", description]]);
  return `${frontmatter}# ${titleCase(opts.toolName)} Agent\n\nWhen the user asks to run or continue \`/${opts.toolName}\`, follow the canonical loader below. Run \`${opts.toolName} next-step\` directly when shell access is available, and treat the deterministic report as the final source of truth once the workflow completes.\n\n${canonicalBody(opts.promptBody)}\n`;
}

/**
 * Render the Codex re-run automation recipe markdown. The recurring-task prompt
 * embeds the canonical loader body so a Codex automation drives the exact same
 * next-step handshake as every other host.
 */
function renderCodexRecipe(opts: RenderHostAssetOptions): string {
  return `# ${titleCase(opts.toolName)} automation recipe\n\nSuggested recurring task: re-run the autonomous \`/${opts.toolName}\` workflow for this repository, following the canonical loader below, and stop once the deterministic report is current.\n\n- Cadence: daily on active branches or before release cut-offs\n- Inputs: repository root\n\nUse this recipe as a starting point for a Codex automation once the local workflow is stable in your environment.\n\n${canonicalBody(opts.promptBody)}\n`;
}

/**
 * Render the Antigravity planning-mode guide. Embeds the canonical loader body so
 * the planning-mode conversation drives the same next-step handshake.
 */
function renderAntigravityGuide(opts: RenderHostAssetOptions): string {
  return `# ${titleCase(opts.toolName)} planning-mode guide\n\nOpen Antigravity in Planning mode, then follow the canonical loader below. Ask Antigravity to use \`${opts.toolName} next-step\` directly, and review Antigravity artifacts before accepting major code changes or imported evidence.\n\n${canonicalBody(opts.promptBody)}\n`;
}

/**
 * Render the Gemini/Antigravity slash-command TOML. Escapes backslashes and
 * double-quotes so the TOML multi-line basic string is valid regardless of prompt
 * content, then embeds the canonical body verbatim.
 */
function renderGeminiToml(opts: RenderHostAssetOptions): string {
  const description =
    opts.description ??
    `Autonomous local-loop workflow — loads one backend-rendered step at a time`;
  const escapedBody = canonicalBody(opts.promptBody)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return [
    `# /${opts.toolName} — ${description}`,
    "# Registered as a Gemini/Antigravity slash command.",
    "",
    `description = "${description.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
    "",
    'prompt = """',
    escapedBody,
    '"""',
    "",
  ].join("\n");
}

/** Title-case a hyphenated tool name, e.g. "audit-code" -> "Audit Code". */
function titleCase(toolName: string): string {
  return toolName
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Render a host asset of the given kind from the one canonical prompt body.
 * Every kind embeds the canonical body verbatim — only the surrounding format
 * (frontmatter / header / TOML quoting) is host-specific.
 */
export function renderHostAsset(
  kind: HostAssetKind,
  opts: RenderHostAssetOptions,
): string {
  switch (kind) {
    case "vscode-agent":
      return renderVSCodeAgent(opts);
    case "codex-recipe":
      return renderCodexRecipe(opts);
    case "antigravity-guide":
      return renderAntigravityGuide(opts);
    case "gemini-toml":
      return renderGeminiToml(opts);
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unknown host asset kind: ${String(exhaustive)}`);
    }
  }
}
