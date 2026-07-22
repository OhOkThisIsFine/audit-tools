// Single-sourced shard-suffix derivation. Both the timing reporter (running
// inside the vitest process, reading its own `process.argv`) and the vitest
// gate script (reading the args it is about to forward to vitest, before
// spawning it) must agree on the same ledger filename for a given shard — this
// is that one shared derivation so they can never drift apart.
export function shardSuffix(argv) {
  const shardArg = argv.find((a) => a.startsWith("--shard"));
  if (!shardArg) return "";
  const value = shardArg.includes("=") ? shardArg.split("=")[1] : "";
  const parsed = value.match(/(\d+)\/(\d+)/);
  return parsed ? `-shard${parsed[1]}of${parsed[2]}` : "";
}
