// Pure poll-log throttle helper used by scripts/release-and-publish.mjs.
//
// This module must stay side-effect free: importing it must not spawn
// processes, start timers, or run any release logic. The release script
// executes `await main()` at module top level, so unit tests import the
// throttle from here instead of importing the release script.

// Heartbeat cadence for poll logging: with 5s polls, every 12th attempt is
// roughly one log line per minute in steady state.
const POLL_LOG_EVERY_N_ATTEMPTS = 12;

// Pure poll-log throttle: log the first attempt, any genuine status transition
// (normalized status/conclusion enum only), and an every-Nth-attempt heartbeat.
// Decision depends only on the arguments and POLL_LOG_EVERY_N_ATTEMPTS.
function shouldLogPollAttempt(attempt, statusKey, lastLoggedStatusKey) {
  if (attempt === 1) return true;
  if (statusKey !== lastLoggedStatusKey) return true;
  return attempt % POLL_LOG_EVERY_N_ATTEMPTS === 0;
}

export { POLL_LOG_EVERY_N_ATTEMPTS, shouldLogPollAttempt };
