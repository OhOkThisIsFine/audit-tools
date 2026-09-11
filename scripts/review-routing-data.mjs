// The `docs/reviews/` routing vocabulary, HELD AS DATA.
//
// WHY DATA AND NOT PROSE. The declaration a review record carries
// (`<!-- review-routing: <id> -->`) has to name a destination the gate can
// CHECK. Holding the rows here — one `id`, one sentence of what it MEANS, one
// path the destination must resolve to — makes two properties mechanical that
// prose cannot: an unknown id is a red (a typo cannot silently declare a
// disposition nobody defined), and a row whose destination has been retired is
// a red (a declaration that routes nowhere would green a record that reached no
// queue, which is the exact failure this mechanism exists to end).
//
// `destination: null` is the declared "no forward work" case — a record whose
// analysis produced nothing to route. That is a LEGITIMATE disposition, not an
// escape hatch, which is why it is a row with a definition rather than an
// absence: the point of the mechanism is that the author SAYS SO, once.

/** @typedef {object} ReviewRoutingRow */
/**
 * @typedef {object} ReviewRoutingRowShape
 * @property {string} id
 * @property {string} means
 * @property {string|null} destination
 */

/** @type {ReviewRoutingRowShape[]} */
export const REVIEW_ROUTING_ROWS = [
  {
    id: "backlog-bugs",
    means:
      "the record names defects or friction that still need fixing — route them into the split backlog",
    destination: "docs/backlog/open-bugs.md",
  },
  {
    id: "backlog-minor",
    means: "the record names LOW-severity defects or friction — the minor backlog",
    destination: "docs/backlog/minor-bugs.md",
  },
  {
    id: "backlog-forward",
    means: "the record names design directions or forward tracks rather than defects",
    destination: "docs/backlog/forward-tracks.md",
  },
  {
    id: "durable-trap",
    means:
      "the record names a standing environment or tooling gotcha, not work to do",
    destination: "docs/backlog/durable-traps.md",
  },
  {
    id: "deferred",
    means: "the record names work blocked on data or an environment this repo cannot supply",
    destination: "docs/backlog/deferred.md",
  },
  {
    id: "memory",
    means:
      "the record's durable outcome is a fact about how the project works — routed to project memory, whose index is the store's MEMORY.md (outside the tree, so this row's destination is the in-repo pointer that names the store)",
    destination: "CLAUDE.md",
  },
  {
    id: "no-forward-work",
    means:
      "the record identified no work — a dogfood log, a measurement, a completed triage, a snapshot whose findings were already routed by the lap that produced it",
    destination: null,
  },
];
