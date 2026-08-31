# P0 benchmark harness

This is a provider-neutral, external benchmark. It compares five randomized primary pairs and five randomized held-out pairs, plus a separate graph-disabled trial. The candidate arm must be driven by the ordinary external `node audit-code.mjs next-step --root <snapshot>` loop; the control arm receives the exact standalone prompt recorded in `manifest.json`. No executor, provider, lane, model inventory, or routing policy is embedded here.

## Operator workflow

The runner is deliberately provider-neutral. It can execute a benchmark only when the operator supplies an external executor executable with the credentials and configuration for the pinned profile.

```text
node benchmarks/p0/runner.mjs preflight [--manifest benchmarks/p0/manifest.json]
node benchmarks/p0/runner.mjs prepare --seed <concrete-seed> [--manifest ...] [--output benchmarks/p0/results]
node benchmarks/p0/runner.mjs run --requests <requests.public.json> --identity <identity.private.json> --executor <executable> [--executor-arg <arg>]...
node benchmarks/p0/runner.mjs graph-disabled [--manifest ...] [--output <raw-graph-disabled.json>]
node benchmarks/p0/runner.mjs package-evaluators --raw <raw-results.json> --graph <raw-graph-disabled.json> [--output <directory>]
node benchmarks/p0/runner.mjs score --input <complete-score-input.json>
```

`preflight` requires a valid manifest, a concrete shared and pair profile, an existing pinned commit, the exact held-out tree digest, labels outside the snapshot, and the pinned protocol. The checked-in manifest pins the concrete host, model, effort, seed, budgets, and candidate commit used by this benchmark design, so preflight is expected to pass without editing it.

<!-- doc-citation-exempt: runtime benchmark outputs created by prepare, not tracked source files -->
`prepare` writes two separate files: `requests.public.json` has one randomized A/B prompt per request and no original-arm identity; `identity.private.json` maps each A/B label to control or candidate. Keep the latter private.

`run` never uses a shell. It invokes the supplied executor as `executable ...executor-arg --request <file> --response <file>`. Each response must be `p0-executor-response-v1`, bind the SHA-256 request digest and pinned profile, and provide a report artifact path with a matching SHA-256 digest. Candidate requests are materialized in isolated roots and repeatedly execute `process.execPath audit-code.mjs next-step --root <root>`; each current step/prompt is handed to the executor until the ordinary workflow reaches its terminal report. Control requests call the same executor once with the exact standalone prompt. A prebuilt final response is not accepted as a candidate substitute.

`graph-disabled` records the required degraded/non-comprehensive abort before work begins. `package-evaluators` requires all 20 raw reports from the ten pairs plus that manifest-bound graph-disabled record, then emits two independently identified blinded packets with report and packet digests. `score` revalidates both packets, requires two complete six-axis evaluator matrices, derives their actual disagreements, requires an exact adjudication set, and only then applies the strict aggregate score gate. The private arm mapping never enters either evaluator packet.

No benchmark acceptance is claimed here. A real run still needs the operator's external executor and credentials plus two independent blinded evaluators and an adjudicator.
