import { compareCodeUnits } from "audit-tools/shared";
import { isTestPath } from "../extractors/pathPatterns.js";
import type { ArtifactBundle } from "../io/artifacts.js";

const RUNNER = /^(?:(?:vitest|jest|playwright|cypress|karma|ava)\.config\.[^.]+|pytest\.ini|tox\.ini|conftest\.py|\.mocharc(?:\.[^.]+)?)$/iu;
const MANIFEST = /^(?:package\.json|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile|pom\.xml|build\.gradle(?:\.kts)?|[^/]+\.sln)$/iu;
const CODE = /\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|kts|cs|php|swift|exs|cpp|cc|c|h|hpp|sh)$/iu;
const TEST_HELPER = /(?:^|\/)(?:__fixtures__|fixtures|helpers|testdata|mocks|support)\/|(?:^|\/)(?:conftest\.py|[^/]*(?:test|vitest|jest|pytest)[-_.](?:setup|fixture|helper|sequencer|reporter)[^/]*\.[^.]+)$/iu;
const FIXTURE_DIRECTORY = /(?:^|\/)(?:__fixtures__|fixtures|testdata|mocks)\//iu;
const CI = /^(?:\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.ya?ml|Jenkinsfile)$/iu;
const TEST_CI = /(?:^|[-_.])(?:test(?:s|ing)?|checks?|ci|coverage|quality)(?:[-_.]|$)/iu;
const MEASUREMENT = /(?:^|\/)(?:[^/]*shard[-_.]duration[-_.]baseline\.json|coverage[-_.]summary\.json|(?:vitest|test)[-_.]timing(?:[-_.]ledger)?\.json)$/iu;
const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dir = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
const order = (paths: Iterable<string>) => [...new Set(paths)].sort(compareCodeUnits);
const rank = (path: string) => RUNNER.test(base(path)) ? 0 : 1;
const add = (map: Map<string, string[]>, key: string, value: string) => {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
};

export interface TestSuiteSubject {
  root: string;
  start: string;
  refs: string[];
  memberFingerprints: string[];
  hasRunnerCandidate: boolean;
}

/** Static navigation hints, not a claim that a runner executes these tests.
 * The caller supplies only admitted, hashed paths from the same frozen scope. */
export function discoverTestSuites(
  admitted: readonly string[],
  hashFor: (path: string) => string,
  graph?: ArtifactBundle["graph_bundle"],
): TestSuiteSubject[] {
  const paths = order(admitted);
  const allowed = new Set(paths);
  const anchors = new Map<string, string[]>();
  const helpers: string[] = [];
  const relatedConfig: string[] = [];
  const receipts: string[] = [];
  const cases: string[] = [];
  for (const path of paths) {
    const name = base(path);
    if (FIXTURE_DIRECTORY.test(path)) {
      if (isTestPath(path)) helpers.push(path);
    } else if ((RUNNER.test(name) && name.toLowerCase() !== "conftest.py") || MANIFEST.test(name)) {
      const root = dir(path);
      add(anchors, root, path);
    } else if (CI.test(path) && TEST_CI.test(name)) relatedConfig.push(path);
    else if (MEASUREMENT.test(path)) receipts.push(path);
    else if (TEST_HELPER.test(path) && (isTestPath(path) || /(?:test|vitest|jest|pytest|conftest)/iu.test(name))) helpers.push(path);
    else if (CODE.test(path) && (isTestPath(path) || /(?:^test_|_test\.|_spec\.)/iu.test(name))) cases.push(path);
  }
  const owner = (path: string): string => {
    let root = dir(path);
    for (;;) {
      if (anchors.has(root) || root === "") return root;
      root = dir(root);
    }
  };
  const members = new Map<string, string[]>();
  for (const path of cases) {
    const root = owner(path);
    add(members, root, path);
  }
  // Dedicated configs may be the only changed source in a delta run. A generic
  // build manifest without any candidate tests isn't evidence of a test suite.
  for (const [root, files] of anchors) {
    if (files.some(path => RUNNER.test(base(path))) && !members.has(root)) members.set(root, []);
  }
  const linked = new Map<string, string[]>();
  const edges = [...(graph?.graphs.imports ?? []), ...(graph?.graphs.references ?? [])];
  for (const { from, to } of edges) {
    if (!allowed.has(from) || !allowed.has(to)) continue;
    add(linked, from, to);
  }
  const helperRoots = new Map<string, string[]>();
  for (const path of helpers) {
    const root = owner(path);
    add(helperRoots, root, path);
  }
  const casePaths = new Set(cases);
  return [...members].sort(([a], [b]) => compareCodeUnits(a, b)).map(([root, testFiles]) => {
    const configs = [...(anchors.get(root) ?? [])].sort((a, b) => rank(a) - rank(b) || compareCodeUnits(a, b));
    const linkedHelpers = [...configs, ...testFiles].flatMap(path => (linked.get(path) ?? []).filter(link =>
      !casePaths.has(link) && (TEST_HELPER.test(link) || /^scripts\/.+?(?:test|coverage)/iu.test(link))));
    const boundHelpers = [...new Set([
      ...order(linkedHelpers),
      ...(helperRoots.get(root) ?? []).sort((a, b) =>
        Number(FIXTURE_DIRECTORY.test(a)) - Number(FIXTURE_DIRECTORY.test(b)) || compareCodeUnits(a, b)),
    ])];
    const ci = members.size === 1 || root === "" ? relatedConfig : [];
    const evidence = receipts.filter(path => owner(path) === root || members.size === 1);
    const start = configs[0] ?? testFiles[0]!;
    const refs = [...new Set([start, ...configs.slice(1, 3), ...ci.slice(0, 2), ...boundHelpers.slice(0, 3),
      ...testFiles.slice(0, 2), ...evidence.slice(0, 2)])];
    return { root, start, refs, hasRunnerCandidate: configs.length > 0,
      memberFingerprints: order([...testFiles, ...configs, ...boundHelpers, ...refs]).map(path => JSON.stringify([path, hashFor(path)])) };
  });
}
