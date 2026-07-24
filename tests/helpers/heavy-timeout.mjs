// Per-test timeout for the heavy audit integration tests.
//
// These tests drive the full multi-phase audit flow — several genuine
// `next-step` round-trips, each doing real repo extraction and staleness work.
// In isolation that is tens of seconds; under full-suite CPU contention it
// balloons past the global 120s `testTimeout` in vitest.config.ts. The result is
// a run that is non-deterministically red for a reason that has nothing to do
// with the change under test, which is exactly the condition that trains a
// reader to wave at "known flaky" instead of resolving failures to names.
//
// A generous per-test ceiling says the honest thing: these are legitimately long
// integration tests, not masked bugs. Making them genuinely fast (the residual
// per-step re-extraction) is separate, tracked work.
//
// Single-sourced because the defect is a CLASS, not a file: every test that
// spawns the CLI wrapper has the same cost profile, and pinning only the one
// file that happened to be observed leaves the other four to fail the same way.
export const HEAVY_AUDIT_TEST_TIMEOUT_MS = 300_000;
