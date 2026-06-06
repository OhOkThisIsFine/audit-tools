import {
  readFile,
  writeFile,
  mkdir,
  open,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isFileMissingError } from "@audit-tools/shared";
import {
  RemediationPlan,
  RemediationItemState,
  ClarificationRequest,
  ClosingPlan,
} from "./types.js";

export interface RemediationState {
  status:
    | "pending"
    | "planning"
    | "documenting"
    | "waiting_for_clarification"
    | "implementing"
    | "triage"
    | "waiting_for_triage"
    | "closing"
    | "complete";
  plan?: RemediationPlan;
  items?: Record<string, RemediationItemState>;
  clarifications?: ClarificationRequest[];
  closing_plan?: ClosingPlan;
  started_at?: string;
  step_count?: number;
}

const STATE_FILENAME = "state.json";
const LOCK_FILENAME = "state.lock";
const LOCK_RETRY_DELAY_MS = 20;
const LOCK_RETRY_MAX_DELAY_MS = 250;
const LOCK_RETRY_LIMIT = 20;
const LOCK_STALE_MS = 30_000;

function statePath(artifactsDir: string): string {
  return join(artifactsDir, STATE_FILENAME);
}

function lockPath(artifactsDir: string): string {
  return join(artifactsDir, LOCK_FILENAME);
}

function tempStatePath(artifactsDir: string): string {
  return join(
    artifactsDir,
    `${STATE_FILENAME}.${process.pid}.${randomUUID()}.tmp`,
  );
}

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "EEXIST"
  );
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logLockDebug(
  tag: string,
  fields: Record<string, string | number | boolean | undefined>,
): void {
  console.debug(JSON.stringify({ tag, ...fields }));
}

async function removeStaleLockIfNeeded(
  lock: string,
  correlationId?: string,
): Promise<boolean> {
  try {
    const lockStat = await stat(lock);
    // Try PID-based liveness check first
    try {
      const content = await readFile(lock, "utf8");
      const pid = parseInt(content.trim(), 10);
      if (!isNaN(pid) && pid > 0) {
        try {
          process.kill(pid, 0); // signal 0 = liveness check
          // Process is alive — only remove if stale by time
          if (Date.now() - lockStat.mtimeMs <= LOCK_STALE_MS) return false;
        } catch {
          // Process is dead — safe to remove
          await rm(lock, { force: true });
          logLockDebug("remediate_state_lock_stale_removed", {
            lock,
            reason: "dead_pid",
            pid,
            correlationId,
          });
          return true;
        }
      }
    } catch {
      // Can't read PID — fall through to time-based check
    }
    if (Date.now() - lockStat.mtimeMs <= LOCK_STALE_MS) return false;
    await rm(lock, { force: true });
    logLockDebug("remediate_state_lock_stale_removed", {
      lock,
      reason: "mtime",
      correlationId,
    });
    return true;
  } catch (error) {
    if (isFileMissingError(error)) return true;
    throw error;
  }
}

async function acquireLock(
  artifactsDir: string,
  correlationId?: string,
): Promise<Awaited<ReturnType<typeof open>>> {
  const lock = lockPath(artifactsDir);
  await mkdir(artifactsDir, { recursive: true });

  for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt++) {
    try {
      const handle = await open(lock, "wx");
      await handle.write(String(process.pid));
      return handle;
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
      if (await removeStaleLockIfNeeded(lock, correlationId)) {
        continue;
      }
      logLockDebug("remediate_state_lock_retry", {
        lock,
        attempt: attempt + 1,
        correlationId,
      });
      if (attempt === LOCK_RETRY_LIMIT - 1) {
        throw new Error(
          `Timed out waiting to write ${statePath(artifactsDir)}: lock file ${lock} is held.`,
        );
      }
      await sleep(
        Math.min(
          LOCK_RETRY_DELAY_MS * 2 ** Math.min(attempt, 4),
          LOCK_RETRY_MAX_DELAY_MS,
        ),
      );
    }
  }
  throw new Error(`Failed to acquire lock for ${statePath(artifactsDir)}.`);
}

interface StateStoreFileOps {
  writeFile: typeof writeFile;
  rename: typeof rename;
  rm: typeof rm;
}

export class StateStore {
  private readonly fileOps: StateStoreFileOps;

  constructor(
    private artifactsDir: string,
    fileOps: Partial<StateStoreFileOps> = {},
    private readonly correlationId?: string,
  ) {
    this.fileOps = { writeFile, rename, rm, ...fileOps };
  }

  async init(): Promise<void> {
    await mkdir(this.artifactsDir, { recursive: true });
  }

  async loadState(): Promise<RemediationState | null> {
    try {
      const data = await readFile(statePath(this.artifactsDir), "utf8");
      return JSON.parse(data) as RemediationState;
    } catch (error) {
      if (isFileMissingError(error)) {
        return null;
      }
      throw error;
    }
  }

  async saveState(state: RemediationState): Promise<void> {
    const lockHandle = await acquireLock(this.artifactsDir, this.correlationId);
    const path = statePath(this.artifactsDir);
    const temp = tempStatePath(this.artifactsDir);

    try {
      await this.fileOps.writeFile(temp, JSON.stringify(state, null, 2), "utf8");
      await this.fileOps.rename(temp, path);
    } finally {
      await lockHandle.close().catch((error) => {
        console.warn(`Failed to close state lock ${lockPath(this.artifactsDir)}:`, error);
      });
      await this.fileOps.rm(lockPath(this.artifactsDir), { force: true }).catch((error) => {
        console.warn(`Failed to remove state lock ${lockPath(this.artifactsDir)}:`, error);
      });
      await this.fileOps.rm(temp, { force: true }).catch(() => undefined);
    }
  }
}
