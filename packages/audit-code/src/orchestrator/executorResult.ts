import type { ArtifactBundle } from "../io/artifacts.js";

/**
 * Uniform result of running one audit executor: the updated artifact bundle, the
 * artifact filenames it wrote (which drive metadata/staleness bookkeeping in
 * advanceAudit), and a one-line human progress summary. Shared by every executor
 * module so they need not depend on the internalExecutors barrel.
 */
export interface ExecutorRunResult {
  updated: ArtifactBundle;
  artifacts_written: string[];
  progress_summary: string;
}
