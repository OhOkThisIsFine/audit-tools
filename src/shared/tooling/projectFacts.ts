import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gitRemotes, isGitRepo } from "../git.js";
import { CLOSING_ACTIONS, type ClosingAction } from "../types/closingActions.js";
import { discoverProjectCommands, type ProjectCommands } from "./testCommand.js";

/**
 * Deterministic project facts a remediation run detects at intake (owner
 * decision 92b0e2dd7cfdc06d, 2026-08-31): the project type and the closing
 * actions the repository's shape makes APPROPRIATE. These are candidates the
 * tool PRESENTS at the intent checkpoint; the user always chooses. Nothing
 * here selects a closing action, and no caller may treat the first candidate
 * as a default — an unchosen action is `none`.
 *
 * Signals are recorded so the presentation can say WHY a candidate is offered
 * ("a remote named origin exists", "package.json is private"). Remote NAMES
 * only, never URLs: a remote URL may carry a token.
 */
export interface ProjectSignals {
  /** `root` is inside a git working tree. */
  git_repo: boolean;
  /** Configured git remote names (never URLs). Empty when not a repo. */
  remotes: string[];
  /** Manifest files present at the root, repo-relative. */
  manifests: string[];
  /** package.json `private`; null when there is no package.json. */
  package_private: boolean | null;
  /** package.json carries a name and a version and is not private. */
  package_publishable: boolean;
  /** npm scripts whose name starts with `release` or `publish`. */
  release_scripts: string[];
  /** CI configuration present at the root, repo-relative. */
  ci_config: string[];
}

export interface ProjectFacts {
  /**
   * Ecosystem label derived from the manifests present — `node`, `python`,
   * `go`, `rust`, a `+`-joined mix of those in that order, or `unknown`.
   */
  project_type: string;
  /**
   * The closing actions the detected facts make appropriate, in
   * `CLOSING_ACTIONS` order. `none` and `custom` are always present: doing
   * nothing and running an operator command are appropriate for every repo.
   */
  candidate_closing_actions: ClosingAction[];
  /** One line per candidate saying which fact offers it. */
  candidate_rationale: Partial<Record<ClosingAction, string>>;
  signals: ProjectSignals;
  /** Test / e2e / build / lint argv discovered from the manifests. */
  commands: ProjectCommands;
}

const MANIFESTS: ReadonlyArray<{ file: string; ecosystem: string }> = [
  { file: "package.json", ecosystem: "node" },
  { file: "pyproject.toml", ecosystem: "python" },
  { file: "setup.py", ecosystem: "python" },
  { file: "pytest.ini", ecosystem: "python" },
  { file: "go.mod", ecosystem: "go" },
  { file: "Cargo.toml", ecosystem: "rust" },
];

const ECOSYSTEM_ORDER = ["node", "python", "go", "rust"] as const;

const CI_CONFIG = [
  ".github/workflows",
  ".gitlab-ci.yml",
  "azure-pipelines.yml",
  "Jenkinsfile",
  ".circleci/config.yml",
  "bitbucket-pipelines.yml",
];

/** The manifests that mark a package as publishable to a registry by shape alone. */
const PUBLISHABLE_MANIFESTS = new Set(["pyproject.toml", "Cargo.toml"]);

function readPackageJson(root: string): Record<string, unknown> | null {
  const path = join(root, "package.json");
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // A malformed manifest degrades to "no manifest facts", never a throw —
    // detection must not fail an intake.
    return null;
  }
}

function releaseScripts(pkg: Record<string, unknown> | null): string[] {
  const scripts = pkg?.scripts;
  if (scripts === null || typeof scripts !== "object") return [];
  return Object.keys(scripts as Record<string, unknown>)
    .filter((name) => /^(release|publish)/.test(name))
    .sort();
}

function projectTypeFrom(manifests: string[]): string {
  const present = new Set(
    MANIFESTS.filter((m) => manifests.includes(m.file)).map((m) => m.ecosystem),
  );
  const ordered = ECOSYSTEM_ORDER.filter((e) => present.has(e));
  return ordered.length === 0 ? "unknown" : ordered.join("+");
}

/**
 * Derive the candidate closing actions from the signals. Pure, so the rule is
 * testable without a filesystem; `detectProjectFacts` is the only production
 * caller.
 */
export function candidateClosingActions(
  signals: ProjectSignals,
): { candidates: ClosingAction[]; rationale: Partial<Record<ClosingAction, string>> } {
  const rationale: Partial<Record<ClosingAction, string>> = {};
  const offered = new Set<ClosingAction>(["none", "custom"]);
  rationale.none = "do nothing after the fixes land in the working tree";
  rationale.custom = "run an operator-supplied command; attach it when the close phase asks for confirmation";
  if (signals.git_repo) {
    offered.add("commit");
    rationale.commit = "the root is a git working tree";
    offered.add("tag");
    rationale.tag = "the root is a git working tree";
    if (signals.remotes.length > 0) {
      const named = signals.remotes.join(", ");
      offered.add("push");
      rationale.push = `a git remote exists (${named})`;
      offered.add("open-pr");
      rationale["open-pr"] = `a git remote exists (${named})`;
    }
  }
  const publishableManifest = signals.manifests.find((m) => PUBLISHABLE_MANIFESTS.has(m));
  if (signals.package_publishable) {
    offered.add("publish");
    rationale.publish = "package.json carries a name and a version and is not private";
  } else if (publishableManifest) {
    offered.add("publish");
    rationale.publish = `${publishableManifest} is present`;
  } else if (signals.release_scripts.length > 0) {
    offered.add("publish");
    rationale.publish = `release scripts exist (${signals.release_scripts.join(", ")})`;
  }
  const candidates = CLOSING_ACTIONS.filter((action) => offered.has(action));
  return { candidates, rationale };
}

/**
 * Detect the project facts for `root`. Deterministic and degrade-to-empty:
 * a missing manifest, an unreadable one, or an absent git binary narrows the
 * facts; it never throws.
 */
export async function detectProjectFacts(root: string): Promise<ProjectFacts> {
  const manifests = MANIFESTS.map((m) => m.file).filter((file) => existsSync(join(root, file)));
  const pkg = readPackageJson(root);
  const packagePrivate = pkg === null ? null : pkg.private === true;
  const packagePublishable =
    pkg !== null &&
    packagePrivate === false &&
    typeof pkg.name === "string" &&
    pkg.name.length > 0 &&
    typeof pkg.version === "string" &&
    pkg.version.length > 0;
  const gitRepo = await isGitRepo(root);
  const remotes = gitRepo ? await gitRemotes(root) : [];
  const signals: ProjectSignals = {
    git_repo: gitRepo,
    remotes,
    manifests,
    package_private: packagePrivate,
    package_publishable: packagePublishable,
    release_scripts: releaseScripts(pkg),
    ci_config: CI_CONFIG.filter((entry) => existsSync(join(root, entry))),
  };
  const { candidates, rationale } = candidateClosingActions(signals);
  return {
    project_type: projectTypeFrom(manifests),
    candidate_closing_actions: candidates,
    candidate_rationale: rationale,
    signals,
    commands: discoverProjectCommands(root),
  };
}
