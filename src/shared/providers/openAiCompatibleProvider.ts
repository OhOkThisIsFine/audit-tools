import { readFile, mkdir, writeFile, appendFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type {
  FreshSessionProvider,
  LaunchFreshSessionInput,
  LaunchFreshSessionResult,
} from "./types.js";
import type { OpenAiCompatibleConfig } from "../types/sessionConfig.js";
import { writeJsonFile } from "../io/json.js";

export const OPENAI_COMPATIBLE_PROVIDER_NAME = "openai-compatible" as const;

/** Default per-file size cap when inlining referenced file contents. */
const DEFAULT_REFERENCED_FILE_BYTE_CAP = 64 * 1024;
/** Default aggregate cap across all inlined referenced files. */
const DEFAULT_REFERENCED_FILES_TOTAL_BYTE_CAP = 256 * 1024;
/** Default max number of referenced files inlined into the prompt. */
const DEFAULT_REFERENCED_FILES_MAX = 24;
/** Default completion token budget when the config does not set one. */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/**
 * The orchestrator's reserved control-plane / artifact root. A worker edits CODE,
 * never the tool's own artifact tree. Models frequently echo the result file (and
 * occasionally other artifacts) into files[] because the embedded prompt says
 * "write your result to <path>"; committing those into the worktree collides with
 * the live artifacts on merge. Any files[] entry under this dir is skipped — the
 * result still lands via the `result` channel / resultPath.
 */
const CONTROL_PLANE_DIR = ".audit-tools";

/** The single-shot worker output contract the model must return. */
interface WorkerOutput {
  files?: Array<{ path?: unknown; content?: unknown }>;
  result?: unknown;
}

type FetchFn = typeof fetch;

export interface OpenAiCompatibleProviderDeps {
  /** Injectable fetch for tests; defaults to the global fetch (Node 20+). */
  fetchFn?: FetchFn;
  /** Injectable env for key resolution; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * OpenAI-compatible **chat-completions** backend — a first-class, API-driven,
 * single-shot code-editing worker. Unlike the agentic-CLI providers
 * (claude-code / codex / opencode), which spawn an external agent that explores
 * and edits the worktree itself, this provider IS the worker: it sends the
 * rendered node prompt to any OpenAI-compatible `/chat/completions` endpoint
 * (NVIDIA NIM, vLLM, LM Studio, OpenRouter, …), the model returns the full set
 * of file edits plus the run's result artifact as one JSON object, and the
 * provider applies the edits into `input.repoRoot` (the node's isolated
 * worktree) and writes the result to `input.resultPath`.
 *
 * This is the `llm write` pattern promoted to a provider: it needs no agentic
 * CLI, so it works wherever an API key + endpoint exist — making it a permanent,
 * provider-agnostic background dispatch pool. The endpoint, model id, and key
 * source all come from session config (never hardcoded — INV no-hardcoded-models);
 * NIM is just one configured instance.
 *
 * The provider stays result-schema-agnostic: it relays the prompt verbatim (the
 * prompt defines the result shape for every worker, agentic or not) and writes
 * back whatever the model places under `result`. The deterministic merge
 * downstream is the authority on result contents; an empty/missing/oversize/
 * unparseable response, a missing result, or a path escaping the worktree all
 * fail the launch cleanly (`accepted:false`) so the rolling engine routes the
 * node to error/triage rather than silently closing it.
 */
export class OpenAiCompatibleProvider implements FreshSessionProvider {
  name = OPENAI_COMPATIBLE_PROVIDER_NAME;
  private readonly config: OpenAiCompatibleConfig;
  private readonly fetchFn: FetchFn;
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    config: OpenAiCompatibleConfig = {},
    deps: OpenAiCompatibleProviderDeps = {},
  ) {
    this.config = config;
    this.fetchFn = deps.fetchFn ?? globalThis.fetch;
    this.env = deps.env ?? process.env;
  }

  async launch(
    input: LaunchFreshSessionInput,
  ): Promise<LaunchFreshSessionResult> {
    const command = `${OPENAI_COMPATIBLE_PROVIDER_NAME}:${this.config.model ?? "?"}`;
    const fail = async (error: string): Promise<LaunchFreshSessionResult> => {
      await this.appendStderr(input.stderrPath, error);
      return { accepted: false, exitCode: null, command, error };
    };

    const baseUrl = this.config.base_url?.trim().replace(/\/+$/, "");
    const model = this.config.model?.trim();
    const apiKey =
      this.config.api_key?.trim() ||
      (this.config.api_key_env
        ? (this.env[this.config.api_key_env] ?? "").trim()
        : "");

    if (!baseUrl) return fail("openai-compatible provider requires openai_compatible.base_url.");
    if (!model) return fail("openai-compatible provider requires openai_compatible.model.");
    if (!apiKey) {
      return fail(
        `openai-compatible provider has no API key — set openai_compatible.api_key_env to a populated env var (e.g. NVIDIA_API_KEY)${this.config.api_key_env ? ` (env "${this.config.api_key_env}" is empty)` : ""}.`,
      );
    }
    if (typeof this.fetchFn !== "function") {
      return fail("openai-compatible provider: no fetch implementation available (Node 20+ provides a global fetch).");
    }

    let messages: Array<{ role: string; content: string }>;
    try {
      const prompt = await readFile(input.promptPath, "utf8");
      const referenced = await this.gatherReferencedFiles(prompt, input.repoRoot);
      messages = [
        { role: "system", content: SINGLE_SHOT_SYSTEM_PROMPT },
        { role: "user", content: prompt + referenced },
      ];
    } catch (err) {
      return fail(`openai-compatible provider failed to read the prompt: ${errText(err)}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    // Emit-time constraint ladder (strongest → weakest), each degrading to the next
    // on an endpoint rejection (HTTP 400/422) so leaving the levers on is safe for
    // ANY endpoint:
    //   "json_schema" — CE-004 build lever: per-field constraint from the worker's
    //     canonical JSON Schema (read ONCE from input.outputSchema, single-sourced
    //     from zod by the dispatch site) via response_format json_schema + NIM/vLLM
    //     guided_json. Only offered when a schema is supplied AND guided_json is not
    //     disabled in config.
    //   "json_object" — structured output, no per-field enforcement
    //     (response_format_json, the prior default).
    //   "none" — no response_format at all.
    const wantJsonObject = this.config.response_format_json !== false;
    const outputSchema =
      this.config.guided_json !== false &&
      input.outputSchema != null &&
      typeof input.outputSchema === "object"
        ? input.outputSchema
        : null;
    type ConstraintMode = "json_schema" | "json_object" | "none";
    const initialMode: ConstraintMode = outputSchema
      ? "json_schema"
      : wantJsonObject
        ? "json_object"
        : "none";
    // The degrade target when the current mode is rejected: json_schema falls to
    // json_object only if json_object is itself wanted, else straight to none.
    const nextMode = (mode: ConstraintMode): ConstraintMode | null => {
      if (mode === "json_schema") return wantJsonObject ? "json_object" : "none";
      if (mode === "json_object") return "none";
      return null;
    };
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(this.config.headers ?? {}),
    };
    const buildBody = (mode: ConstraintMode): string => {
      const body: Record<string, unknown> = {
        model,
        messages,
        temperature: this.config.temperature ?? 0,
        max_tokens: this.config.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        stream: false,
      };
      if (mode === "json_schema" && outputSchema) {
        // OpenAI / vLLM structured outputs. `name` is required by the OpenAI shape.
        body.response_format = {
          type: "json_schema",
          json_schema: { name: "worker_result", schema: outputSchema, strict: true },
        };
        // NIM / vLLM guided decoding: accept the schema both at top level and under
        // `nvext` so a single request covers vLLM's `guided_json` and NIM's
        // `nvext.guided_json` — an endpoint ignores the key it doesn't recognize.
        body.guided_json = outputSchema;
        body.nvext = { guided_json: outputSchema };
      } else if (mode === "json_object") {
        body.response_format = { type: "json_object" };
      }
      return JSON.stringify(body);
    };
    const post = (mode: ConstraintMode): ReturnType<FetchFn> =>
      this.fetchFn(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: buildBody(mode),
        signal: controller.signal,
      });

    let content: string;
    try {
      let mode = initialMode;
      let res = await post(mode);
      // A constraint rejection (400/422) is non-fatal: step down the ladder until
      // the endpoint accepts the request or there is no weaker mode left to try.
      while (!res.ok && (res.status === 400 || res.status === 422)) {
        const downgraded = nextMode(mode);
        if (downgraded === null) break;
        mode = downgraded;
        res = await post(mode);
      }
      if (!res.ok) {
        const body = await safeText(res);
        return fail(`openai-compatible endpoint returned HTTP ${res.status}: ${truncate(body, 600)}`);
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const raw = json.choices?.[0]?.message?.content;
      if (typeof raw !== "string" || raw.trim().length === 0) {
        return fail("openai-compatible endpoint returned an empty completion (no choices[0].message.content).");
      }
      content = raw;
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      return fail(
        aborted
          ? `openai-compatible request timed out after ${input.timeoutMs}ms.`
          : `openai-compatible request failed: ${errText(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    // Persist the raw completion for run-correlated observability (parallels the
    // spawn providers' stdout log).
    await this.appendStdout(input.stdoutPath, content);

    let parsed: WorkerOutput;
    try {
      parsed = parseJsonLoose(content) as WorkerOutput;
    } catch (err) {
      return fail(`openai-compatible response was not parseable JSON: ${errText(err)}`);
    }

    // Apply the file edits into the worktree (repoRoot). The worktree branch diff
    // is the write-scope ground truth, so out-of-scope edits are caught at merge;
    // here we only defend against a path escaping the worktree entirely.
    const files = Array.isArray(parsed.files) ? parsed.files : [];
    let applied = 0;
    for (const file of files) {
      if (typeof file?.path !== "string" || typeof file?.content !== "string") {
        return fail("openai-compatible response files[] entries must be { path: string, content: string }.");
      }
      // Never let a worker write into the orchestrator's control plane via files[]
      // (the result has its own channel). This keeps the worktree commit to genuine
      // code edits, so the cherry-pick merge doesn't collide with the live artifacts.
      const relPath = file.path.replace(/\\/g, "/").replace(/^\.\//, "");
      if (relPath === CONTROL_PLANE_DIR || relPath.startsWith(`${CONTROL_PLANE_DIR}/`)) {
        await this.appendStderr(input.stderrPath, `skipped control-plane path in files[]: ${file.path}`);
        continue;
      }
      const abs = safeResolveInRepo(input.repoRoot, file.path);
      if (!abs) {
        return fail(`openai-compatible response tried to write outside the worktree: ${file.path}`);
      }
      try {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, file.content, "utf8");
        applied += 1;
      } catch (err) {
        return fail(`openai-compatible failed writing ${file.path}: ${errText(err)}`);
      }
    }

    if (parsed.result === undefined) {
      return fail(
        `openai-compatible response omitted the "result" artifact (applied ${applied} file(s) but produced no result to write to ${input.resultPath}).`,
      );
    }

    try {
      await writeJsonFile(input.resultPath, parsed.result);
    } catch (err) {
      return fail(`openai-compatible failed writing the result file: ${errText(err)}`);
    }

    return {
      accepted: true,
      exitCode: 0,
      command,
      args: [baseUrl],
      stdoutPath: input.stdoutPath,
      stderrPath: input.stderrPath,
    };
  }

  /**
   * Best-effort: inline the current contents of repo-relative files the prompt
   * names, so the model edits real content rather than hallucinating it. Bounded
   * by per-file and aggregate byte caps and a file-count cap; silently skips
   * missing / oversized / non-resolving paths. Disabled via
   * `include_referenced_files:false`.
   */
  private async gatherReferencedFiles(
    prompt: string,
    repoRoot: string,
  ): Promise<string> {
    if (this.config.include_referenced_files === false) return "";
    // Operator-tunable caps so a read-heavy AUDIT packet on a large-context endpoint
    // inlines every granted file (the single-shot worker has no Read tool) instead of
    // silently truncating to a coverage hole.
    const perFileCap = positiveOr(this.config.referenced_file_byte_cap, DEFAULT_REFERENCED_FILE_BYTE_CAP);
    const totalCap = positiveOr(this.config.referenced_files_total_byte_cap, DEFAULT_REFERENCED_FILES_TOTAL_BYTE_CAP);
    const maxFiles = positiveOr(this.config.referenced_files_max, DEFAULT_REFERENCED_FILES_MAX);

    const candidates = new Set<string>();
    // Conservative file-ish tokens: a path segment with an extension. Strips
    // surrounding quotes/backticks/parens the prompt may wrap paths in.
    const re = /[A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+/g;
    for (const match of prompt.matchAll(re)) {
      const token = match[0].replace(/\\/g, "/");
      if (token.length <= 256) candidates.add(token);
      if (candidates.size > maxFiles * 4) break;
    }

    const parts: string[] = [];
    let total = 0;
    let count = 0;
    for (const token of candidates) {
      if (count >= maxFiles || total >= totalCap) break;
      const abs = safeResolveInRepo(repoRoot, token);
      if (!abs) continue;
      try {
        const info = await stat(abs);
        if (!info.isFile() || info.size > perFileCap) continue;
        const body = await readFile(abs, "utf8");
        if (total + body.length > totalCap) continue;
        parts.push(`\n--- BEGIN CURRENT FILE ${token} ---\n${body}\n--- END CURRENT FILE ${token} ---`);
        total += body.length;
        count += 1;
      } catch {
        // missing / binary / unreadable — skip.
      }
    }
    if (parts.length === 0) return "";
    // Task-neutral framing: this serves BOTH edit tasks (remediate — return the new
    // contents in `files`) AND read-only review tasks (audit — leave `files` empty,
    // the finding array goes in `result`). The prior "edit these" wording pushed an
    // audit review worker toward returning file edits it should never make.
    return (
      "\n\nCURRENT CONTENTS OF REFERENCED FILES (provided so you work from real content, " +
      "not guesses). Only include a file in `files` if the task instructs you to MODIFY " +
      "it; for a read-only review task, leave `files` empty and put your output in " +
      `\`result\`:${parts.join("")}`
    );
  }

  private async appendStdout(path: string, content: string): Promise<void> {
    try {
      await appendFile(path, content + "\n", "utf8");
    } catch {
      // Observability log is best-effort; never fail the launch on a log write.
    }
  }

  private async appendStderr(path: string, message: string): Promise<void> {
    try {
      await appendFile(path, `[openai-compatible] ${message}\n`, "utf8");
    } catch {
      // best-effort
    }
  }
}

const SINGLE_SHOT_SYSTEM_PROMPT =
  "You are a non-interactive, single-shot worker. You cannot ask " +
  "questions, open additional files, run commands, use Read/Write/Grep tools, or " +
  "reply in a second turn — you must complete the task in ONE response. The current " +
  "contents of the files you need are inlined in the user message. Read the task and " +
  "decide the exact output required. Then respond with a SINGLE JSON object and NOTHING " +
  "else — no prose, no explanation, no markdown, no code fences. The object has " +
  'exactly two keys: "files" — an array of {"path": string, "content": string} ' +
  "objects, one per file you create or modify (EMPTY for a read-only review task), where " +
  "`path` is relative to the repository root and `content` is the COMPLETE new contents " +
  'of that file; and "result" — the exact JSON value the task instructions tell you to ' +
  "WRITE to the result file / result_path (the run's result artifact / item results / " +
  "the audit findings array). Include every file you change in `files`, but do NOT put " +
  "the result artifact, the result file, or any .audit-tools/ path in `files` — the " +
  "result belongs ONLY in the `result` key. " +
  // Output-contract override for the single-shot worker (defect-1 sub-defect 3): agentic
  // prompts tell the worker to WRITE a file then REPLY with a one-line confirmation
  // ("valid: …" / "done"). A single-shot worker has no file access and no reply channel,
  // so that convention must NOT leak into `result` — the observed NIM failure.
  "IMPORTANT: the task instructions were written for an interactive agent and may tell " +
  "you to WRITE your output to a result file and then REPLY with a one-line confirmation " +
  "(e.g. 'reply exactly: valid: <id>, findings=<n>'). You have no file access and no " +
  "separate reply turn: put the EXACT content that instruction says to write to the file " +
  "into `result` — NEVER the confirmation/acknowledgement string. If the task asks for " +
  "structured data (e.g. a JSON array of audit results), `result` MUST be that array, not " +
  "a 'valid: …' summary line. Ignore any instruction to 'reply', 'confirm', or use a " +
  "Read/Write/Grep tool — those are for interactive agents. Your ONLY output is this JSON object.";

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A finite positive override, else the default (guards a 0 / negative / NaN config value). */
function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function safeText(res: { text: () => Promise<string> }): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<unreadable body>";
  }
}

/**
 * Resolve a model-supplied repo-relative path against `repoRoot`, returning the
 * absolute path only when it stays inside the worktree. Any absolute path or
 * `..` escape returns null so the caller can reject it.
 */
function safeResolveInRepo(repoRoot: string, candidate: string): string | null {
  if (typeof candidate !== "string" || candidate.length === 0) return null;
  const normalizedRoot = resolve(repoRoot);
  const abs = resolve(normalizedRoot, candidate);
  const rel = relative(normalizedRoot, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return abs;
}

/**
 * Parse JSON that may arrive wrapped in markdown fences or with leading/trailing
 * prose (reasoning models sometimes do this even under an explicit JSON
 * instruction). Tries a direct parse, then a fenced block, then a
 * string/escape-aware balance scan that collects every complete top-level object
 * and returns the LARGEST one that parses — so a trivial `{}` example emitted
 * before the real payload is skipped, an in-string `}` doesn't truncate the
 * object, and trailing garbage after the object is tolerated.
 */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // fall through
    }
  }
  for (const candidate of extractBalancedObjects(trimmed)) {
    try {
      return JSON.parse(candidate);
    } catch {
      // not valid JSON — try the next candidate.
    }
  }
  throw new Error("no JSON object found in response");
}

/**
 * Scan `text` for complete, brace-balanced top-level `{…}` objects, tracking
 * JSON string state so a `{` or `}` inside a string (or escaped) is ignored.
 * Returns the candidate substrings ordered largest-first, so the caller prefers
 * the real payload over a trivial example object.
 */
function extractBalancedObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '"' && !isEscaped(text, i)) inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start !== -1) {
          objects.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  // Largest first: skips a leading trivial `{}` in favour of the real object.
  return objects.sort((a, b) => b.length - a.length);
}

/** True when the character at `index` is escaped by an odd run of backslashes. */
function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}
