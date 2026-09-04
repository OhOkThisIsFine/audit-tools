# P0 benchmark harness

This provider-neutral external benchmark compares five randomized primary pairs and five randomized held-out pairs, plus a separate graph-disabled trial. The candidate arm runs through the ordinary external `node audit-code.mjs next-step --root <snapshot>` loop. The control arm receives the exact standalone prompt recorded in `manifest.json`. The harness contains no executor, provider, lane, model inventory, or routing policy.

## Operator workflow

The operator supplies the external executor configuration required by the pinned profile, a private-gold file that is never checked into the repository, two independent blinded evaluators, and one private adjudicator.

```text
node benchmarks/p0/runner.mjs preflight [--manifest benchmarks/p0/manifest.json]
node benchmarks/p0/runner.mjs prepare [--manifest ...] [--output benchmarks/p0/results]
node benchmarks/p0/runner.mjs run --requests <requests.public.json> --identity <identity.private.json> --executor <executable> [--executor-arg <arg>]...
node benchmarks/p0/runner.mjs graph-disabled [--manifest ...] [--output <raw-graph-disabled.json>]
node benchmarks/p0/runner.mjs package-evaluators --raw <raw-results.json> --graph <raw-graph-disabled.json> --identity <identity.private.json> --gold <private-gold.json> --provenance <scoring-provenance.private.json> [--output <public-packet-directory>]
node benchmarks/p0/runner.mjs score --input <complete-score-input.json>
```

`preflight` requires a valid manifest, a concrete shared pair profile, the existing pinned commit, the exact unlabeled held-out tree digest, and the pinned protocol. The checked-in manifest contains no randomization seed, scored subset, case sign, strongest flag, gold identity, or label path.

<!-- doc-citation-exempt: runtime benchmark outputs are created by prepare, not tracked source files -->
`prepare` generates fresh randomization internally and writes two separate files. `requests.public.json` contains one randomized A/B prompt per request without the seed or original-arm identity. `identity.private.json` alone stores the seed needed to reproduce order and maps each A/B label to control or candidate; keep it private.

`run` invokes the supplied executor without a shell as `executable ...executor-arg --request <file> --response <file>`. Each response uses `p0-executor-response-v1`, binds the request SHA-256 and pinned profile, and supplies a report artifact path matching its SHA-256. Candidate requests are materialized in isolated roots and repeatedly execute `process.execPath audit-code.mjs next-step --root <root>` until the ordinary workflow reaches its terminal report. Control requests call the same executor once with the exact standalone prompt. A prebuilt final response is not accepted as a candidate substitute.

`graph-disabled` records the required degraded, non-comprehensive abort before work begins.

## Private gold and evaluator packets

`package-evaluators` requires 20 complete run records bound to reconstructed requests, executor responses, candidate step evidence, the private identity, the private gold, and the graph-disabled record. It privately reshuffles records, copies reports under packet-local names such as `reports/R-01.md`, and emits two independently identified `p0-blinded-evaluator-packet-v2` packets.

The `--gold` file is the only source of private case IDs, groups, signs, strongest flags, subjects, and evidence focus. Its complete structure-only contract is checked in at `benchmarks/p0/private-gold.schema.json`; `manifest.json` points to that schema without carrying real gold values. The runtime requires `p0-private-gold-v1`, exact manifest binding, normalized-unique private IDs, exact classifications and counts, and placement outside both the repository and the evaluator packet directory. Private description wording is unrestricted because it never enters an evaluator packet.

Each evaluator packet contains only:

- blinded report IDs, packet-local report paths, and report digests;
- the six generic axes and generic axis rubric;
- generic claim instructions and field vocabularies.

Packets never contain private-gold case data or descriptions, private IDs, case signs, strongest flags, gold paths, private report groups, request pair identities, arm identities, source paths, or the randomization seed. Packet bytes are therefore independent of arbitrary changes to private-gold descriptions.

The separate self-digested `p0-private-scoring-provenance-v2` file binds the manifest, raw results, graph record, private identity, private-gold path and digest, source and copied report hashes, private report groups, and each complete packet identity, evaluator slot, path, and digest. Its path must be outside the public packet directory. `package-evaluators` returns `p0-evaluator-package-v2`.

## Evaluation, adjudication, and scoring

Each `p0-blinded-evaluation-v2` row supplies all six axis values and a `claims` array. Every distinct evidence-backed report claim has exactly these fields:

- `normalized_finding_text`
- `treatment`: `finding`, `validly_subsumed`, or `explicitly_defended`
- `support`: `supported`, `partial`, or `unsupported`
- `confidence`: a number from 0 through 1
- `evidence`: non-empty report evidence

Evaluators do not receive or reconstruct benchmark cases. They assess only the reports and generic rubric.

A third arm-blind adjudicator privately consumes both evaluations and the runtime private gold. `p0-private-adjudication-v2` resolves every axis disagreement and groups evaluator claims through exact `(evaluator_slot, claim_index)` references. Each grouped claim maps to one group-valid private ID or `null`. Canonical claim values must have appeared in a referenced evaluator claim, and every evaluator claim must be referenced exactly once. Reviewer identities are compared after NFKC normalization, trimming, and lowercasing.

`score` rejects caller-supplied aggregates, revalidates exact packet shapes and all private bindings, and mechanically derives positive recovery, negative-case false positives, unmatched false positives, and high-confidence unsupported counts from the validated private mappings. It then privately derives candidate/control roles and computes the acceptance aggregate.

A pair is non-inferior only when the candidate is at least the control on every axis. At least four of five primary pairs and four of five held-out pairs must be non-inferior, and neither group may have a lower candidate median on any axis. Strongest recovery requires every privately marked strongest case to carry outcome weight 1 in a candidate run, in at least four of the five primary candidate runs. Held-out quality floors are a candidate axis median of `0.6`, positive recovery rate of `0.8`, and negative false-positive rate no greater than `0.1`.
