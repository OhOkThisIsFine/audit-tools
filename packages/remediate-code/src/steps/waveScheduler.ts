/**
 * Thin re-export shim. All wave-scheduler logic now lives in dispatch.ts so
 * the public surface is single-sourced. Existing callers that import from
 * waveScheduler continue to work unchanged.
 */
export {
  normalizeSlotTokens,
  scheduleWave,
  buildDispatchQuota,
  resolveHostConcurrencyLimit,
  detectHostConcurrencyFromEnv,
  resolveHostActiveSubagentLimit,
  type ScheduleWaveInput,
  type WaveScheduleResult,
  type HostConcurrencyLimit,
} from "./dispatch.js";
