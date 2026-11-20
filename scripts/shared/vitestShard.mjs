// Single-sourced shard-suffix derivation. Both the timing reporter (running
// inside the vitest process, reading its own `process.argv`) and the vitest
// gate script (reading the args it is about to forward to vitest, before
// spawning it) must agree on the same ledger filename for a given shard — this
// is that one shared derivation so they can never drift apart.
// sites-pinned: tests/shared/script-entry-regressions.test.ts
export function shardSuffix(argv) {
  const index = argv.findIndex(arg => arg === "--shard" || arg.startsWith("--shard="));
  if (index < 0) return "";
  const arg = argv[index];
  const value = arg === "--shard" ? argv[index + 1] : arg.slice("--shard=".length);
  const match = /^(\d+)\/(\d+)$/.exec(value ?? "");
  const current = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!Number.isSafeInteger(current) || !Number.isSafeInteger(total) || current < 1 || current > total) {
    throw new Error(`Invalid --shard value "${value ?? ""}": expected index/total with 1 <= index <= total.`);
  }
  return `-shard${current}of${total}`;
}
