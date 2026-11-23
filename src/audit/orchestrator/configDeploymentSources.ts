// sites-pinned: tests/audit/config-deployment-sources.test.ts
import { posix } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { hashContent, isRecord, parseCommandString, scanStringAware, uniqueSorted } from "audit-tools/shared";
import { resolveContainedSourcePath } from "../../shared/io/sourcePath.js";
import type { ReviewInventoryItem } from "../../shared/types/reviewQuestion.js";
import { isDocIntentFile } from "../decompose/buildStructureDecomposition.js";
import { maskCommentSpans } from "../extractors/commentDecomposition.js";
import { packageScriptCandidates } from "../extractors/graphManifestEdges/packageJson.js";
import { yamlRootObject } from "../extractors/graphManifestEdges/yaml.js";
import { isTestPath } from "../extractors/pathPatterns.js";
import { DEFAULT_MAX_BYTES, defaultReadFileText } from "../extractors/readFileText.js";
import type { ArtifactBundle } from "../io/artifacts.js";
import { classifyConfiguration, reviewSourceScope } from "./questionPlanning.js";

const record = (value: unknown) => isRecord(value) ? value : {};
const defaultDirectory = (owner: Record<string, unknown>) => record(record(owner.defaults).run)["working-directory"];
const literalPath = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\w./-]+$/u;

/** An explicit package directory can be resolved. A tarball, workspace switch
 * or ambiguous operand provides no basis for choosing the cwd's manifest. */
function npmManifestDirectory(cwd: string, subcommand: string | undefined, args: string): string | undefined {
  if (/(?:^|\s)(?:--(?:prefix|workspaces?|global)(?:[=\s]|$)|-[gw])/u.test(args)) return undefined;
  if (subcommand !== "publish" && subcommand !== "pack") return cwd;
  const { positionals } = parseArgs({ args: parseCommandString(args.trim()), strict: false, allowPositionals: true,
    options: { access: { type: "string" }, tag: { type: "string" }, registry: { type: "string" } } });
  if (!positionals.length) return cwd;
  const [target] = positionals;
  return positionals.length === 1 && target && literalPath.test(target) ? posix.join(cwd, target) : undefined;
}

function readsDeclaredSetting(content: string, path: string, names: Set<string>): boolean {
  const code = maskCommentSpans(content, path);
  const access = path.endsWith(".py")
    ? /\bos\.(?:environ\[|(?:getenv|environ\.get)\()\s*["']([A-Za-z_]\w*)["']/gu
    : /\bprocess\.env(?:\.([A-Za-z_]\w*)(?![$\w])|\[\s*["']([A-Za-z_]\w*)["']\s*\])/gu;
  const sites = new Set([...code.matchAll(access)].filter(m => names.has(m[1] ?? m[2]!)).map(m => m.index));
  if (!sites.size) return false;
  let found = false;
  const quotes = ["'", '"', "`"] as const;
  scanStringAware(code, { quoteChars: quotes, escapedQuotes: quotes }, {
    onUnquoted: (_, i) => { if (sites.has(i)) { found = true; return false; } },
  });
  return found;
}

async function workflowSources(content: string, admitted: Set<string>, read: (path: string) => Promise<string | undefined>) {
  const workflow = yamlRootObject(content) ?? {};
  const sources = new Set<string>();
  const scripts = new Map<string, Set<string>>();
  const add = (path: string) => { if (admitted.has(path)) sources.add(path); };
  const uses = (value: unknown) => {
    if (typeof value !== "string" || !value.startsWith("./") || !literalPath.test(value)) return;
    const target = posix.normalize(value);
    if (admitted.has(target)) add(target);
    else for (const name of ["action.yml", "action.yaml"]) add(posix.join(target, name));
  };
  for (const value of Object.values(record(workflow.jobs))) {
    const job = record(value);
    uses(job.uses);
    for (const step of Array.isArray(job.steps) ? job.steps.filter(isRecord) : []) {
      uses(step.uses);
      const cwd = step["working-directory"] ?? defaultDirectory(job) ?? defaultDirectory(workflow) ?? ".";
      if (typeof cwd !== "string" || !literalPath.test(cwd) || typeof step.run !== "string") continue;
      for (const raw of step.run.split(/\r?\n/u)) {
        const line = raw.trim();
        // Once the shell changes directory, relative paths in later lines are uncertain.
        if (/\b(?:cd|pushd|popd)\b/u.test(line) && !line.startsWith("#")) break;
        const invocation = /^(?:(?:node|bun|deno run|tsx|python[23]?|bash|sh|pwsh -File)\s+["']?([\w./-]+)|(\.\/[\w./-]+))(?=["']?(?:\s|$))/u.exec(line);
        const file = invocation?.[1] ?? invocation?.[2];
        if (file && literalPath.test(file)) add(posix.join(cwd, file));
        const npm = /^npm\s+(?:(?:run|run-script)\s+([\w:.-]+)|(publish|pack|test|start|ci|install))(?=\s|$)/u.exec(line);
        if (!npm) continue;
        const dir = npmManifestDirectory(cwd, npm[2], line.slice(npm[0].length));
        if (!dir) continue;
        const manifest = posix.join(dir, "package.json");
        if (!admitted.has(manifest)) continue;
        add(manifest);
        const script = npm[1] ?? (npm[2] === "test" || npm[2] === "start" ? npm[2] : undefined);
        if (script) {
          const names = scripts.get(manifest) ?? new Set<string>();
          names.add(script);
          scripts.set(manifest, names);
        }
      }
    }
  }
  for (const [manifest, names] of scripts) {
    for (const { script, specifier } of packageScriptCandidates(await read(manifest) ?? "")) {
      if (names.has(script)) add(posix.join(posix.dirname(manifest), specifier));
    }
  }
  return sources;
}

/** Snapshot-only leads for the automatic configuration questions. Persist only paths so
 * submitting an answer needs neither another scan nor access to setting values. */
export async function addConfigurationStartingSources(bundle: ArtifactBundle, root: string): Promise<void> {
  const plan = bundle.review_plan!;
  const ids = new Set(plan.questions.filter(q => q.lens === "config_deployment").flatMap(q => q.inventory_item_ids));
  const items = plan.inventory.filter(item => ids.has(item.inventory_item_id) && item.kind === "release_transition");
  if (!items.length) return;
  const scope = reviewSourceScope(bundle);
  const admitted = new Set(scope.allowedSourcePaths);
  const read = async (path: string) => {
    const file = scope.files.get(path);
    if (!file?.hash || file.size_bytes > DEFAULT_MAX_BYTES) return undefined;
    const target = resolveContainedSourcePath(root, path);
    const content = target && await defaultReadFileText(target, DEFAULT_MAX_BYTES);
    return content !== undefined && hashContent(content) === file.hash ? content : undefined;
  };
  const leads = new Map<ReviewInventoryItem, Set<string>>();
  const releases = new Map<string, ReviewInventoryItem>();
  const names = new Set<string>();
  let runtime: ReviewInventoryItem | undefined;
  for (const item of items) {
    const refs = item.source_refs;
    const anchor = refs[0]?.path;
    if (!anchor) continue;
    let paths = new Set<string>();
    if (classifyConfiguration(anchor) === "release") {
      releases.set(anchor, item);
      if (/^\.github\/workflows\/[^/]+\.ya?ml$/iu.test(anchor)) {
        paths = await workflowSources(await read(anchor) ?? "", admitted, read);
      }
      for (const edge of bundle.graph_bundle?.graphs.references ?? []) {
        if (edge.from === anchor && edge.kind === "yaml-path-reference-link" && admitted.has(edge.to)) paths.add(edge.to);
      }
    } else {
      runtime = item;
      for (const { path } of refs) if (posix.basename(path) === ".env.example") {
        for (const key of Object.keys(parseEnv(await read(path) ?? ""))) names.add(key);
      }
    }
    leads.set(item, paths);
  }
  // A basename in a runbook resolves only when unique in the manifest, including excluded files.
  const filenames = new Map<string, string | undefined>();
  for (const path of scope.files.keys()) {
    const name = posix.basename(path);
    filenames.set(name, filenames.has(name) ? undefined : path);
  }
  for (const path of scope.allowedContractPaths) {
    if (isDocIntentFile(path, "included") && /(?:runbook|release|publish|deploy|rollback|setup|install|operator)/iu.test(path)) {
      const content = await read(path);
      for (const match of content?.matchAll(/`([^`\r\n]+)`|\]\(([^\s)]+)\)/gu) ?? []) {
        const token = (match[1] ?? match[2]!).split("#")[0]!;
        const target = releases.get(token) ?? releases.get(posix.join(posix.dirname(path), token)) ??
          releases.get(filenames.get(token) ?? "");
        if (target) leads.get(target)!.add(path);
        if (runtime && names.has(token)) leads.get(runtime)!.add(path);
      }
    } else if (runtime && names.size && admitted.has(path) && !isTestPath(path) && /\.(?:[cm]?[jt]sx?|py)$/iu.test(path)) {
      const content = await read(path);
      if (content && readsDeclaredSetting(content, path, names)) leads.get(runtime)!.add(path);
    }
  }
  for (const [item, paths] of leads) {
    for (const ref of item.source_refs) paths.delete(ref.path);
    if (paths.size) item.suggested_sources = uniqueSorted(paths).map(path => ({ path }));
  }
}
