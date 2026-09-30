// sites-pinned: tests/shared/root-log-observations.test.ts, tests/remediate/host-handoff.test.ts
import { opendir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { compareCodeUnits } from "../compareCodeUnits.js";
import { createLockedJsonStore, siblingLockPath, SKIP_WRITE } from "../io/lockedJsonStore.js";
import { resolveSpawnDeadline, runTrackedAsync, TRACKED_CHILD_DEADLINE_MS } from "../tooling/exec.js";
import type { RunLogger } from "./runLog.js";

// Root-only, names-only observation. Never read bodies, recurse, remove files,
// or infer which host/session created a name. These are inventory bounds, not
// admission limits: incomplete observation never rejects otherwise valid work.
const ENTRY_LIMIT = 4096;
const LOG_LIMIT = 128;
const LOG_NAME = /\.(?:log|out|err)$/iu;
const CodeSchema = z.enum(["baseline_missing", "entry_limit", "candidate_limit", "history_limit", "git_unavailable", "git_diagnostic", "io_unavailable"]);
const InventorySchema = z.object({
  status: z.enum(["complete", "partial", "unavailable"]),
  names: z.array(z.string().max(1024)).max(LOG_LIMIT),
  code: CodeSchema.optional(),
  detail: z.string().max(240).optional(),
}).strict();
type Inventory = z.infer<typeof InventorySchema>;
const StateSchema = z.object({
  contract_version: z.literal("root-log-observations/v1"),
  root: z.string(),
  run_id: z.string(),
  baseline: InventorySchema,
  latest: InventorySchema,
  observations: z.array(z.object({
    name: z.string().max(1024), creator: z.literal("unknown"), observed_at: z.string(),
  }).strict()).max(LOG_LIMIT),
  notices: z.array(CodeSchema).max(8),
}).strict();
type State = z.infer<typeof StateSchema>;

function incomplete(status: "partial" | "unavailable", code: z.infer<typeof CodeSchema>, detail: string): Inventory {
  return { status, code, detail: detail.slice(0, 240), names: [] };
}

async function inventory(root: string, includeNonIgnored = false): Promise<Inventory> {
  try {
    const candidates: string[] = [];
    let entries = 0;
    // Async iteration closes the directory even when a bound returns early.
    for await (const entry of await opendir(root)) {
      if (++entries > ENTRY_LIMIT) return incomplete("partial", "entry_limit", "root directory entry limit reached");
      // In particular, .audit-tools and every nested/sanctioned log directory
      // are excluded by construction. Symlinks are not followed either.
      if (!entry.isFile() || !LOG_NAME.test(entry.name)) continue;
      if (candidates.length === LOG_LIMIT) return incomplete("partial", "candidate_limit", "root log candidate limit reached");
      candidates.push(entry.name);
    }
    const checked = await runTrackedAsync(["git", "check-ignore", "-z", "--stdin"], {
      cwd: root,
      input: candidates.length ? candidates.join("\0") + "\0" : "",
      encoding: "utf8",
      timeout: resolveSpawnDeadline(undefined, TRACKED_CHILD_DEADLINE_MS),
      maxBuffer: 256 * 1024,
    });
    if (checked.error || (checked.status !== 0 && checked.status !== 1)) {
      return incomplete("unavailable", "git_unavailable", "git check-ignore could not establish ignore status");
    }
    if (checked.stderr.trim() !== "") return incomplete("unavailable", "git_diagnostic", "git check-ignore reported a diagnostic; ignore coverage is uncertain");
    const names = checked.stdout.split("\0").filter(Boolean);
    if (names.some((name) => !candidates.includes(name))) {
      return incomplete("unavailable", "git_diagnostic", "git check-ignore returned an unexpected path");
    }
    // A baseline remembers every candidate name: later ignore-rule changes
    // cannot turn an already present log into a newly appeared name.
    return { status: "complete", names: [...new Set(includeNonIgnored ? candidates : names)].sort(compareCodeUnits) };
  } catch (error) {
    return incomplete("unavailable", "io_unavailable", `root directory could not be inventoried: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Advisory observation at the two existing host boundaries; no workload fields change. */
export async function recordHostRootLogBoundary(params: {
  root: string;
  runDir: string;
  runId: string;
  phase: "prepare" | "ingest";
  logger?: RunLogger;
}): Promise<void> {
  const report = (message: string): void => {
    params.logger?.event({ kind: "scope", phase: "host-handoff", note: message });
    process.stderr.write(`[audit-tools] ${message}\n`);
  };
  try {
    const canonicalRoot = await realpath(params.root);
    const path = join(params.runDir, "root-log-observations.json");
    const messages: string[] = [];
    const store = createLockedJsonStore<State | undefined>({
      path, lockPath: siblingLockPath(path),
      validate: (next) => { StateSchema.parse(next); },
      parse: (raw) => {
        if (raw === undefined) return undefined;
        const state = StateSchema.parse(raw);
        if (state.root !== canonicalRoot || state.run_id !== params.runId) throw new Error("root-log observation record belongs to another root/run");
        return state;
      },
    });
    await store.mutate(async (previous) => {
      const note = (state: State, observation: Inventory): void => {
        if (!observation.code || state.notices.includes(observation.code)) return;
        state.notices.push(observation.code);
        messages.push(`ignored root log inventory ${observation.status}: ${observation.detail}; no new-file inference from incomplete evidence`);
      };
      if (previous === undefined) {
        const baseline = params.phase === "prepare"
          ? await inventory(canonicalRoot, true)
          : incomplete("unavailable", "baseline_missing", "pre-execution baseline missing");
        const state: State = { contract_version: "root-log-observations/v1", root: canonicalRoot,
          run_id: params.runId, baseline, latest: baseline, observations: [], notices: [] };
        note(state, baseline);
        return state;
      }
      // Never reset on re-prepare: doing so would absorb new logs into the
      // baseline before ingestion had a chance to report them.
      if (params.phase === "prepare" || previous.baseline.status !== "complete") return SKIP_WRITE;
      const current = await inventory(canonicalRoot);
      const state = structuredClone(previous);
      state.latest = current;
      if (current.status !== "complete") {
        note(state, current);
      } else {
        const known = new Set([...state.baseline.names, ...state.observations.map((entry) => entry.name)]);
        const fresh = current.names.filter((name) => !known.has(name));
        if (state.observations.length + fresh.length > LOG_LIMIT) {
          state.latest = incomplete("partial", "history_limit", "per-run observation history limit reached");
          note(state, state.latest);
        } else if (fresh.length) {
          state.observations.push(...fresh.map((name) => ({ name, creator: "unknown" as const, observed_at: new Date().toISOString() })));
          messages.push(`new ignored root log names observed: ${JSON.stringify(fresh)}; creator/session unknown; every file is preserved`);
        }
      }
      return JSON.stringify(state) === JSON.stringify(previous) ? SKIP_WRITE : state;
    });
    // Record first, report second: simultaneous ingests cannot report a name twice.
    for (const message of messages) report(message);
  } catch (error) {
    // A broken observation store cannot turn a successful acceptance into a
    // rejection. It also cannot be described as a clean inventory.
    report(`ignored root log inventory unavailable: ${JSON.stringify(error instanceof Error ? error.message : String(error)).slice(0, 240)}`);
  }
}
