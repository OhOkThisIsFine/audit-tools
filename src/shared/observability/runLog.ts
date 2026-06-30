import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Append-only structured run log shared by both orchestrators. One JSON object
// per line; logging never throws and is a no-op when disabled, so it can be
// threaded through hot paths without guarding every call site.

/**
 * Stable vocabulary of run-log event kinds emitted across both orchestrators.
 * Typed as a union so consumers can rely on a fixed set when aggregating logs.
 */
export type RunLogEventKind =
  | "obligation"
  | "executor_start"
  | "executor_end"
  | "artifact_write"
  | "scope"
  | "outcome"
  | "provider_launch"
  | "provider_done"
  | "step"
  | "state"
  | "error";

export interface RunLogEvent {
  /** Coarse phase/state, e.g. "advance" or "implementing". */
  phase?: string;
  /** The obligation/decision this event relates to. */
  obligation?: string;
  /** Event kind drawn from the stable {@link RunLogEventKind} vocabulary. */
  kind: RunLogEventKind;
  artifact?: string;
  provider?: string;
  tokens_est?: number;
  duration_ms?: number;
  note?: string;
  /** Run- or request-scoped token for correlating log events across a single invocation. */
  correlationId?: string;
}

export interface RunLoggerOptions {
  enabled?: boolean;
  /** Injectable clock (epoch ms) for deterministic tests. */
  now?: () => number;
}

export class RunLogger {
  private readonly path: string;
  private readonly enabled: boolean;
  private readonly now: () => number;

  constructor(path: string, options: RunLoggerOptions = {}) {
    this.path = path;
    this.enabled = options.enabled ?? true;
    this.now = options.now ?? (() => Date.now());
  }

  /** A logger that drops every event. Use when observability is disabled. */
  static disabled(): RunLogger {
    return new RunLogger("", { enabled: false });
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Append one event line. Atomic per line (O_APPEND); swallows all errors. */
  event(event: RunLogEvent): void {
    if (!this.enabled || this.path.length === 0) return;
    let line: string;
    try {
      line = JSON.stringify({ ts: new Date(this.now()).toISOString(), ...event }) + "\n";
    } catch {
      // Non-serializable payload: log a minimal marker instead of throwing.
      line = JSON.stringify({ ts: new Date(this.now()).toISOString(), kind: event.kind, note: "unserializable_event" }) + "\n";
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, line, "utf8");
    } catch {
      // Observability must never break a run.
    }
  }
}
