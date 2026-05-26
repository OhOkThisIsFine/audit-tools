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
  command?: string;
  args?: string[];
  stdoutPath?: string;
  stderrPath?: string;
  error?: string;
}

export interface ProviderRateLimits {
  requests_per_minute?: number | null;
  input_tokens_per_minute?: number | null;
  output_tokens_per_minute?: number | null;
}

export interface FreshSessionProvider {
  name: string;
  launch(input: LaunchFreshSessionInput): Promise<LaunchFreshSessionResult>;
  queryLimits?(model: string | null): Promise<ProviderRateLimits | null>;
}
