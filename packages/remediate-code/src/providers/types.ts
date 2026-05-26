export interface WorkerProgress {
  type: "heartbeat" | "output";
  runId: string;
  obligationId: string | null;
  elapsedMs: number;
  message?: string;
}

export interface LaunchFreshSessionInput {
  repoRoot: string;
  runId: string;
  obligationId: string | null;
  promptPath: string;
  taskPath: string;
  resultPath: string;
  stdoutPath: string;
  stderrPath: string;
  uiMode: "visible" | "headless";
  timeoutMs: number;
  stdinText?: string;
  onProgress?: (update: WorkerProgress) => void;
}

export interface LaunchFreshSessionResult {
  accepted: boolean;
  processId?: number;
  exitCode?: number | null;
  signal?: string | null;
}

export interface FreshSessionProvider {
  name: string;
  launch(input: LaunchFreshSessionInput): Promise<LaunchFreshSessionResult>;
}
