import { join } from "node:path";
import {
  readValidatedRepoSessionIntent,
  resolveSessionConfig,
  ambientAuditorDescriptor,
  type SessionConfig,
  type ResolveSessionConfigOptions,
} from "audit-tools/shared";

/**
 * The ONE place remediate turns a persisted `RepoSessionIntent` into an effective
 * {@link SessionConfig} — so the descriptor choice cannot drift across call sites.
 *
 * It is ALWAYS the ambient descriptor: remediate has no host handshake (no `--auditor`
 * flag), but it has an environment, so its dispatch pool resolves in-process from
 * `declared ∩ ambient-verifiable`. Host-self-class fields (model/window/roster) stay
 * absent → the host pool sizes to the conservative floor, which is a fidelity
 * degradation, never a block.
 *
 * ⚠ Why this function exists rather than three call sites each choosing: passing `null`
 * FAILS CLOSED to driver-self-only — no pool at all — and that is exactly what happened.
 * Between v0.32.68 and the fix, all three remediate sites hardcoded `null`, so remediate
 * could not dispatch to ANY non-self pool, where v0.32.68 read `sources[]` straight off
 * disk. The mechanism was deliberate; the consequence went unnoticed for four laps.
 * Routing every site through here makes the null choice UNREPRESENTABLE instead of a
 * thing each site must remember — enforce in tooling, never "the next author notices".
 * [[capability-is-per-auditor-not-per-audit]] [[enforce-robustness-in-tooling-not-host-discretion]]
 */
export async function loadRemediateSessionConfig(params: {
  root: string;
  /**
   * A programmatic EFFECTIVE config (tests / the audit→remediate handoff). Already
   * resolved, so it wins outright and bypasses the disk read entirely. Nullable because
   * the call sites' own option is — a null/absent override falls through to disk.
   */
  override?: SessionConfig | null | undefined;
  /**
   * Read `<root>/.remediation-artifacts/session-config.json` before `<root>/session-config.json`.
   *
   * The contract-pipeline scheduling path reads ONLY the root config; the step paths try
   * the artifacts dir first. That difference is PRE-EXISTING and is preserved verbatim
   * here rather than silently unified — this extraction single-sources the descriptor
   * choice, not the read-path policy. (Whether the contract-pipeline path SHOULD also
   * consult the artifacts dir is an open question, logged to the backlog.)
   */
  artifactsFirst: boolean;
  /**
   * Ambient probes for the in-process source resolution. Production passes NOTHING —
   * every probe then defaults to the real environment, which is the point: the reach
   * check must read the SAME env the provider reads at launch. Tests inject.
   */
  ambient?: ResolveSessionConfigOptions;
}): Promise<SessionConfig | undefined> {
  if (params.override) return params.override;
  const intent = params.artifactsFirst
    ? ((await readValidatedRepoSessionIntent(
        join(params.root, ".remediation-artifacts", "session-config.json"),
      )) ?? (await readValidatedRepoSessionIntent(join(params.root, "session-config.json"))))
    : await readValidatedRepoSessionIntent(join(params.root, "session-config.json"));
  return intent
    ? resolveSessionConfig(intent, ambientAuditorDescriptor(), params.ambient)
    : undefined;
}
