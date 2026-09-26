// sites-pinned: tests/shared/prompt-contract-v1.test.ts
// Prompt Contract v1 primitives (packet 7 / O03 foundation).
//
// Small shared renderers for the facts every prompt contract states the same
// way: exact paths, closed value sets, actor ownership, output shape,
// validation, continuation, stopping, and lane-class-compatible dispatch
// fallback. Each returns a plain markdown fragment; there is deliberately no
// general prompt language or central mega-renderer here (standard §7 slice 2:
// "avoid a generic prose DSL"). Renderers take caller-supplied content — the
// closed values MUST come from the validator-owned constant/schema source at
// the call site, never retyped beside it.
//
// Profiles mirror standard §4: worker (bounded semantic task writing an
// artifact), driver (orchestration/operator decision recording a result),
// dispatch (thin envelope naming already-materialized lanes).

/** The three Prompt Contract v1 profiles (standard §4). */
export type PromptProfile = "worker" | "driver" | "dispatch";

/** Actors that can own a prompt's immediate action (PC-01). */
export type PromptActor = "operator" | "host" | "worker" | "tool";

/** One readable input: an exact bound path plus what it contains. */
export interface PromptInput {
  path: string;
  description: string;
}

/**
 * An exact path token: backtick-quoted so it copies verbatim. Callers pass
 * the already-normalized forward-slash form (`toPromptPathToken` output);
 * the shared step writer normalizes the prompt body again on write.
 */
export function renderExactPath(path: string): string {
  return `\`${path}\``;
}

/** One `## Inputs`-style line per bound input: exact path + what it holds. */
export function renderInputList(entries: readonly PromptInput[]): string[] {
  return entries.map(
    (entry) => `- ${renderExactPath(entry.path)} — ${entry.description}`,
  );
}

/**
 * A complete closed value set, rendered from the validator-owned members the
 * caller passes (standard PC-05). Never an open `<a|b|...>` alternation: every
 * accepted value is named, each backtick-quoted so it copies verbatim.
 */
export function renderClosedValues(
  label: string,
  values: readonly string[],
): string {
  return `${label}: ${values.map((value) => `\`"${value}"\``).join(" | ")}`;
}

/**
 * Explicit actor ownership for the immediate action (PC-01): who does it —
 * never a bare "choose/decide/record" a second actor could own.
 */
export function renderActorOwnership(
  actor: PromptActor,
  action: string,
): string {
  const owner =
    actor === "operator"
      ? "Ask the operator"
      : actor === "host"
        ? "The host records"
        : actor === "worker"
          ? "The worker writes"
          : "The tool derives";
  return `${owner} ${action}`;
}

/** Where the decision/artifact is recorded, with its complete shape. */
export function renderOutputSection(
  outputPath: string,
  shapeExample: string,
): string {
  return [
    "Write the decision to:",
    "",
    renderExactPath(outputPath),
    "",
    "It must have this shape:",
    "",
    "```json",
    shapeExample,
    "```",
  ].join("\n");
}

/**
 * The mechanical self-check, rendered only when a worker-accessible validator
 * exists (PC-09): the exact command plus what success looks like.
 */
export function renderCheckSection(validationCommand: string): string {
  return [
    "Check the artifact before you stop:",
    "",
    renderExactPath(validationCommand),
    "",
    '`status: "ok"` means the artifact is admissible.',
  ].join("\n");
}

/** Terminal instruction for a prompt that ends the chain (PC-10). */
export function renderStopSection(): string {
  return "Stop after writing the output. Do not start the next phase.";
}

/** Terminal instruction for a prompt that continues the run (PC-10). */
export function renderContinueSection(command: string): string {
  return [`Run:`, ``, renderExactPath(command)].join("\n");
}

/**
 * Lane-class-compatible dispatch fallback (PC-11): an independence-required
 * review stops when no independent context exists — it never degrades into a
 * self-review. An ordinary lane may run inline.
 */
export function renderDispatchFallback(
  independenceRequired: boolean,
): string {
  return independenceRequired
    ? "If no independent context is available, stop and report that this review could not be performed independently. Do not write a result. An unavailable review is not an empty result."
    : "If no separate execution context exists, read and follow each lane file sequentially yourself.";
}

/**
 * Backtick-quoted spans that name files: contain a `/` and look like a path
 * (a dot-extension or a trailing slash segment), not prose emphasis. Used to
 * hold "every rendered input path is in the emitted read scope" (PC-03/PC-04)
 * mechanically: the caller compares these against the step's `read_paths`.
 */
export function collectRenderedPaths(prompt: string): string[] {
  const found = new Set<string>();
  for (const match of prompt.matchAll(/`([^`\n]+)`/gu)) {
    const token = match[1]!.trim();
    if (!token.includes("/")) continue;
    if (!/[.][A-Za-z0-9]+(?:\/)?$/.test(token) && !token.endsWith("/")) {
      // Bare `a/b` prose (e.g. `size/complexity`) is not a path.
      if (!/\.[A-Za-z0-9]+/.test(token)) continue;
    }
    found.add(token);
  }
  return [...found].sort();
}

/**
 * The read-scope half of PC-03/PC-04: every path the prompt renders must be
 * present in the emitted step's `read_paths`. Returns the missing set; empty
 * means the prompt's reader can reach everything it names.
 */
export function renderedPathsInScope(
  prompt: string,
  readPaths: readonly string[],
): { missing: string[] } {
  const scope = new Set(readPaths);
  return {
    missing: collectRenderedPaths(prompt).filter((path) => !scope.has(path)),
  };
}
