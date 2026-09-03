import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BENCHMARK_ROOT = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(BENCHMARK_ROOT, "../..");

const AXES = [
  "structural_recall",
  "philosophy_telos_recall",
  "grounding_precision",
  "telos_to_code_linkage",
  "reduction_value",
  "false_positive_discipline",
];
const OUTCOME_WEIGHTS = {
  recovered: 1,
  validly_subsumed: 1,
  partial: 0.5,
  evidence_refuted: 1,
  missed: 0,
};
const CLAIM_TREATMENTS = [
  "finding",
  "validly_subsumed",
  "explicitly_defended",
];
const CLAIM_SUPPORT_LEVELS = ["supported", "partial", "unsupported"];
const CLAIM_CONTRACT = {
  instructions:
    "For each report, list every distinct evidence-backed claim without reference to hidden benchmark cases.",
  fields: [
    "normalized_finding_text",
    "treatment",
    "support",
    "confidence",
    "evidence",
  ],
  treatments: CLAIM_TREATMENTS,
  support_levels: CLAIM_SUPPORT_LEVELS,
  confidence_range: [0, 1],
};
const AXIS_RUBRIC = {
  structural_recall: "Coverage of consequential structural relationships.",
  philosophy_telos_recall: "Coverage of stated goals and governing intent.",
  grounding_precision: "Precision and traceability of cited evidence.",
  telos_to_code_linkage: "Connection between intent and implementation evidence.",
  reduction_value: "Value of the proposed simplification or clarification.",
  false_positive_discipline: "Discipline against unsupported assertions.",
};
const HELD_OUT_QUALITY_FLOORS = {
  candidate_axis_median_min: 0.6,
  candidate_positive_rate_min: 0.8,
  candidate_negative_false_positive_rate_max: 0.1,
};
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.length > 0;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const readJson = (path) => JSON.parse(readFileSync(resolve(path), "utf8"));
const digest = (value) =>
  createHash("sha256")
    .update(Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest("hex");
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

export const buildCandidateInvocation = ({ audit_code, snapshot_root }) => [
  "node",
  audit_code,
  "next-step",
  "--root",
  snapshot_root,
];

export function currentStepPathFromCliOutput(output) {
  let contract;
  try {
    contract = JSON.parse(output);
  } catch {
    throw Error("next-step did not emit a JSON contract");
  }
  const path = contract?.artifact_paths?.current_step;
  if (!isStr(path))
    throw Error("next-step contract lacks artifact_paths.current_step");
  return path;
}

function git(repoRoot, args) {
  return spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    shell: false,
  });
}
export async function materializePinnedPrimary({
  repoRoot,
  commit,
  destination,
}) {
  if (
    !isStr(repoRoot) ||
    !/^[0-9a-f]{40}$/i.test(commit ?? "") ||
    !isStr(destination) ||
    existsSync(destination)
  )
    throw Error("invalid pinned worktree request or destination collision");
  const exists = git(repoRoot, ["cat-file", "-e", `${commit}^{commit}`]);
  if (exists.status !== 0) throw Error("pinned commit does not exist");
  const added = git(repoRoot, [
    "worktree",
    "add",
    "--detach",
    destination,
    commit,
  ]);
  if (added.status !== 0)
    throw Error(`cannot materialize pinned primary: ${added.stderr}`);
  const head = git(destination, ["rev-parse", "HEAD"]),
    status = git(destination, ["status", "--porcelain"]);
  if (
    head.status !== 0 ||
    head.stdout.trim() !== commit ||
    status.status !== 0 ||
    status.stdout.trim()
  ) {
    await removePinnedPrimary({ repoRoot, destination });
    throw Error("pinned primary verification failed");
  }
  return {
    snapshot_commit: commit,
    source_tree_clean: true,
    root: destination,
  };
}
export async function removePinnedPrimary({ repoRoot, destination }) {
  if (!isStr(destination) || !existsSync(destination)) return;
  const root = repoRoot ?? destination;
  const removed = git(root, ["worktree", "remove", "--force", destination]);
  if (removed.status !== 0)
    rmSync(destination, { recursive: true, force: true });
  git(root, ["worktree", "prune"]);
}

function stepIdentity(step) {
  if (!isObj(step) || (!isStr(step.step_id) && !isStr(step.step_kind)))
    throw Error("missing or malformed current step");
  if (isStr(step.step_id)) return step.step_id;
  const artifact_paths = Object.fromEntries(
    Object.entries(isObj(step.artifact_paths) ? step.artifact_paths : {})
      .filter(
        ([key, value]) =>
          !["current_step", "current_prompt"].includes(key) && isStr(value),
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return `${step.step_kind}:${digest({
    artifact_paths,
    run_id: step.run_id ?? null,
    step_kind: step.step_kind,
    stop_condition: step.stop_condition ?? null,
  }).slice(0, 24)}`;
}
function assertStep(step, seen) {
  const identity = stepIdentity(step);
  if (seen.has(identity))
    throw Error("non-advancing or repeated step identity");
  seen.add(identity);
}
function terminal(step) {
  return (
    step.complete === true ||
    (step.step_kind === "present_report" && step.status === "complete")
  );
}
export function bindCandidateTerminalStep(step) {
  const artifactPaths = isObj(step?.artifact_paths) ? step.artifact_paths : {};
  const artifact_path = isStr(step?.artifact_path)
    ? step.artifact_path
    : isStr(artifactPaths.final_report)
      ? artifactPaths.final_report
      : isStr(artifactPaths.audit_report)
        ? artifactPaths.audit_report
        : undefined;
  return {
    ...step,
    step_id: stepIdentity(step),
    artifact_path,
    complete: step?.complete === true || step?.status === "complete",
  };
}
function stepRequest(step, prompt, snapshot_root, pinned_profile) {
  const step_id = stepIdentity(step);
  if (!isStr(prompt)) throw Error(`missing prompt for step ${step_id}`);
  return {
    step_id,
    step_kind: step.step_kind,
    prompt,
    artifact_path: step.artifact_path,
    artifact_paths: step.artifact_paths,
    access: step.access,
    allowed_commands: step.allowed_commands,
    status: step.status,
    stop_condition: step.stop_condition,
    snapshot_root,
    pinned_profile,
  };
}

export async function driveCandidateLoop({
  snapshot_root,
  pinned_profile,
  maxSteps = 20,
  nextStep,
  executePrompt,
}) {
  if (typeof nextStep !== "function" || typeof executePrompt !== "function")
    throw Error("loop seams required");
  const seen = new Set();
  let last;
  for (let steps = 1; steps <= maxSteps; steps += 1) {
    const step = await nextStep();
    assertStep(step, seen);
    last = step;
    if (terminal(step)) return { step, steps };
    await executePrompt(
      stepRequest(step, step.prompt, snapshot_root, pinned_profile),
    );
  }
  throw Error(
    `max-step exhaustion after ${maxSteps} steps; last=${last ? stepIdentity(last) : "none"}`,
  );
}

/** Compose the ordinary next-step CLI on every iteration; executors never replace the loop. */
export async function runCandidateArm({
  auditCode,
  snapshotRoot,
  pinnedProfile,
  maxSteps = 20,
  invokeCommand,
  readCurrentStep,
  readPrompt,
  executeExternal,
}) {
  if (
    ![invokeCommand, readCurrentStep, readPrompt, executeExternal].every(
      (fn) => typeof fn === "function",
    )
  )
    throw Error("candidate runner seams required");
  if (!isObj(pinnedProfile) || !isStr(pinnedProfile.repo_commit))
    throw Error("concrete pinned profile required");
  const seen = new Set();
  let last;
  for (let count = 1; count <= maxSteps; count += 1) {
    const outcome = await invokeCommand(
      buildCandidateInvocation({
        audit_code: auditCode,
        snapshot_root: snapshotRoot,
      }),
    );
    if (
      outcome &&
      (outcome.error || ("status" in outcome && outcome.status !== 0))
    )
      throw Error(
        `next-step command failed: ${outcome.error ?? outcome.status}`,
      );
    const step = await readCurrentStep();
    assertStep(step, seen);
    last = step;
    if (terminal(step)) return step;
    if (!isStr(step.prompt_path))
      throw Error(`missing prompt_path for step ${stepIdentity(step)}`);
    await executeExternal(
      stepRequest(
        step,
        await readPrompt(step.prompt_path),
        snapshotRoot,
        pinnedProfile,
      ),
    );
  }
  throw Error(
    `max-step exhaustion after ${maxSteps} steps; last=${last ? stepIdentity(last) : "none"}`,
  );
}

export function validateBenchmarkManifest(input, { details = false } = {}) {
  let m = input;
  if (typeof input === "string") {
    try {
      m = readJson(input);
    } catch {
      return false;
    }
  }
  const errors = [];
  const bad = (ok, text) => {
    if (!ok) errors.push(text);
  };
  bad(isObj(m) && m.version === 1, "version");
  const shared = m?.shared;
  if (!isObj(shared)) return false;
  bad(/^[0-9a-f]{40}$/i.test(shared.repo_commit ?? ""), "commit");
  for (const field of ["host_build", "model", "reasoning_effort"]) {
    bad(isStr(shared[field]), field);
    bad(
      !/^(operator-pinned|operator-supplied|tbd|todo|unknown|unspecified|placeholder)$/i.test(
        shared[field] ?? "",
      ),
      `${field} placeholder`,
    );
  }
  bad(
    Array.isArray(shared.tool_inventory) &&
      shared.tool_inventory.length > 0 &&
      isObj(shared.budgets),
    "profile",
  );
  const pairs = (group, name) => {
    bad(
      Array.isArray(group?.pairs) && group.pairs.length === 5,
      `${name} count`,
    );
    const ids = new Set();
    for (const pair of group?.pairs ?? []) {
      bad(isObj(pair) && isStr(pair.id) && !ids.has(pair.id), `${name} id`);
      ids.add(pair?.id);
      bad(
        [
          "repo_commit",
          "host_build",
          "model",
          "reasoning_effort",
          "tool_inventory",
          "budgets",
        ].every((field) => equal(pair?.pinned?.[field], shared[field])),
        `${name} profile`,
      );
      bad(
        isStr(pair?.control_prompt) &&
          isStr(pair?.candidate_prompt) &&
          !/(rubric|opportunity|candidate[_ -]?id)/i.test(
            `${pair?.control_prompt} ${pair?.candidate_prompt}`,
          ),
        `${name} prompt leak`,
      );
    }
  };
  pairs(m.primary, "primary");
  pairs(m.held_out, "held_out");
  const allPairIds = [
    ...(m.primary?.pairs ?? []),
    ...(m.held_out?.pairs ?? []),
  ].map((pair) => pair.id);
  bad(new Set(allPairIds).size === allPairIds.length, "global pair ids");
  const held = m.held_out ?? {};
  for (const [section, field] of [
    [m.primary, "accepted_reports"],
    [m.primary, "normalized_opportunity_ids"],
    [m.primary, "strongest_opportunity_ids"],
    [held, "seeded_positive_classes"],
    [held, "negative_controls"],
  ])
    bad(!isObj(section) || !Object.hasOwn(section, field), `public gold ${field}`);
  bad(
    m.graph_disabled_trial?.graph_enabled === false &&
      m.graph_disabled_trial?.expected_outcome ===
        "abort_before_comprehensive" &&
      /degraded|non-comprehensive/i.test(m.graph_disabled_trial?.notice ?? ""),
    "graph-disabled",
  );
  bad(
    m.randomization?.pair_order === "randomized" &&
      m.randomization?.masking === "A/B",
    "randomization",
  );
  bad(m.randomization?.seed === undefined, "public randomization seed");
  bad(
    m.evaluation?.independent_evaluators === 2 &&
      m.evaluation?.adjudicator === 1 &&
      m.evaluation?.private_gold_schema ===
        "benchmarks/p0/private-gold.schema.json" &&
      equal(m.axes, AXES),
    "evaluation",
  );
  if (held.corpus)
    bad(
      held.corpus.deterministic_tree_digest === true &&
        !Object.hasOwn(held.corpus, "labels_outside_root") &&
        !Object.hasOwn(held.corpus, "labels_path"),
      "corpus metadata",
    );
  return details ? { valid: !errors.length, errors } : !errors.length;
}

function treeDigest(root) {
  const base = resolve(root),
    entries = [];
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else
          entries.push([
            path.slice(base.length + 1).replaceAll("\\", "/"),
            readFileSync(path),
          ]);
      });
  walk(base);
  const hash = createHash("sha256");
  for (const [path, bytes] of entries)
    hash.update(path).update("\0").update(bytes).update("\0");
  return hash.digest("hex");
}
function checkCorpus(manifest) {
  const corpus = manifest.held_out?.corpus;
  if (
    !isObj(corpus) ||
    !isStr(corpus.path) ||
    !existsSync(resolve(corpus.path)) ||
    !statSync(resolve(corpus.path)).isDirectory()
  )
    throw Error("held-out corpus directory required");
  const root = resolve(corpus.path);
  if (
    corpus.deterministic_tree_digest !== true ||
    treeDigest(root) !== corpus.sha256
  )
    throw Error("held-out tree digest mismatch");
}
export function evaluateBenchmarkScores(score) {
  if (
    !isObj(score) ||
    score.evaluator_coverage?.independent !== 2 ||
    score.evaluator_coverage?.adjudicated !== true
  )
    return false;
  const primary = score.primary;
  if (
    !isObj(primary) ||
    primary.ties_or_wins < 4 ||
    primary.candidate_runs_recovering_strongest < 4 ||
    score.admitted_high_confidence_unsupported !== 0 ||
    !isObj(primary.median_by_axis) ||
    AXES.some(
      (axis) =>
        !isObj(primary.median_by_axis[axis]) ||
        primary.median_by_axis[axis].candidate <
          primary.median_by_axis[axis].control,
    )
  )
    return false;
  const held = score.held_out;
  return (
    isObj(held) &&
    held.ties_or_wins >= 4 &&
    isObj(held.median_by_axis) &&
    AXES.every(
      (axis) =>
        isObj(held.median_by_axis[axis]) &&
        held.median_by_axis[axis].candidate >=
          held.median_by_axis[axis].control &&
        held.median_by_axis[axis].candidate >=
          HELD_OUT_QUALITY_FLOORS.candidate_axis_median_min,
    ) &&
    held.seeded_positive_rate?.candidate >=
      held.seeded_positive_rate?.control &&
    held.seeded_positive_rate?.candidate >=
      HELD_OUT_QUALITY_FLOORS.candidate_positive_rate_min &&
    held.negative_control_false_positive_rate?.candidate <=
      held.negative_control_false_positive_rate?.control &&
    held.negative_control_false_positive_rate?.candidate <=
      HELD_OUT_QUALITY_FLOORS.candidate_negative_false_positive_rate_max
  );
}

function concrete(manifest) {
  if (!validateBenchmarkManifest(manifest))
    throw Error(
      "invalid manifest: exact protocol and concrete pinned profile required",
    );
  const allProfiles = [
    manifest.shared,
    ...(manifest.primary?.pairs ?? []).map((pair) => pair.pinned),
    ...(manifest.held_out?.pairs ?? []).map((pair) => pair.pinned),
  ];
  if (
    allProfiles.some((profile) =>
      ["host_build", "model", "reasoning_effort"].some((key) =>
        /^(operator-pinned|operator-supplied|tbd|todo|unknown|unspecified|placeholder)$/i.test(
          profile?.[key] ?? "",
        ),
      ),
    )
  )
    throw Error("concrete pinned profile required");
  return manifest.shared;
}
function preflight(path) {
  const manifest = readJson(path);
  concrete(manifest);
  checkCorpus(manifest);
  if (
    spawnSync(
      "git",
      ["cat-file", "-e", `${manifest.shared.repo_commit}^{commit}`],
      { shell: false },
    ).status !== 0
  )
    throw Error("pinned commit does not exist");
  return {
    protocol: "p0-preflight-v1",
    status: "ready",
    manifest_digest: digest(manifest),
    corpus_digest: treeDigest(
      (manifest.held_out?.corpus ?? manifest.corpus_snapshot).path,
    ),
  };
}
function shuffled(values, seed) {
  let state = Number.parseInt(digest(seed).slice(0, 8), 16) >>> 0;
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const target = Math.floor((state / 2 ** 32) * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}
function expectedPrivateArms(manifest, seed) {
  return Object.fromEntries(
    [...manifest.primary.pairs, ...manifest.held_out.pairs].map((pair) => {
      const order = shuffled(["control", "candidate"], `${seed}:${pair.id}`);
      return [pair.id, { A: order[0], B: order[1] }];
    }),
  );
}
function validatePrivateIdentity(manifest, identity) {
  const seed = identity?.randomization_seed;
  const expected = isStr(seed) ? expectedPrivateArms(manifest, seed) : {};
  return (
    isObj(identity) &&
    identity.protocol === "p0-private-identity-v1" &&
    identity.manifest_digest === digest(manifest) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      seed ?? "",
    ) &&
    isObj(identity.arms) &&
    equal(Object.keys(identity.arms).sort(), Object.keys(expected).sort()) &&
    Object.entries(expected).every(([pairId, arms]) =>
      equal(identity.arms[pairId], arms),
    )
  );
}
function validatePublicRequests(manifest, requests, identity) {
  if (
    !isObj(requests) ||
    requests.protocol !== "p0-public-requests-v1" ||
    requests.manifest_digest !== digest(manifest) ||
    !Array.isArray(requests.requests) ||
    requests.requests.length !== 20
  )
    return false;
  const pairs = new Map(
    [...manifest.primary.pairs, ...manifest.held_out.pairs].map((pair) => [
      pair.id,
      pair,
    ]),
  );
  const ids = new Set();
  const valid = requests.requests.every((request) => {
    const pair = pairs.get(request?.pair_id);
    const kind = identity.arms?.[request?.pair_id]?.[request?.arm];
    if (!pair || !["A", "B"].includes(request?.arm)) return false;
    ids.add(request.request_id);
    return (
      request.protocol === "p0-request-v1" &&
      request.request_id === `${pair.id}-${request.arm}` &&
      request.prompt === pair[`${kind}_prompt`] &&
      equal(request.pinned_profile, manifest.shared) &&
      request.snapshot ===
        (pair.id.startsWith("held-out-") ? "held-out" : "primary")
    );
  });
  return valid && ids.size === 20;
}
function prepare(path, output) {
  const manifest = readJson(path);
  concrete(manifest);
  checkCorpus(manifest);
  const seed = randomUUID();
  const requests = [],
    arms = {};
  for (const pair of shuffled(
    [...manifest.primary.pairs, ...manifest.held_out.pairs],
    seed,
  )) {
    const order = shuffled(["control", "candidate"], `${seed}:${pair.id}`);
    arms[pair.id] = {};
    order.forEach((kind, index) => {
      const arm = index ? "B" : "A";
      arms[pair.id][arm] = kind;
      requests.push({
        protocol: "p0-request-v1",
        request_id: `${pair.id}-${arm}`,
        pair_id: pair.id,
        arm,
        prompt: pair[`${kind}_prompt`],
        pinned_profile: manifest.shared,
        snapshot: pair.id.startsWith("held-out-") ? "held-out" : "primary",
      });
    });
  }
  mkdirSync(output, { recursive: true });
  const publicPath = join(output, "requests.public.json"),
    privatePath = join(output, "identity.private.json");
  writeJson(publicPath, {
    protocol: "p0-public-requests-v1",
    manifest_digest: digest(manifest),
    requests,
  });
  writeJson(privatePath, {
    protocol: "p0-private-identity-v1",
    manifest_digest: digest(manifest),
    randomization_seed: seed,
    arms,
  });
  return {
    requestsPath: publicPath,
    identityPath: privatePath,
    count: requests.length,
  };
}
function external(executor, executorArgs, request, dir) {
  const id = randomUUID(),
    requestPath = join(dir, `${id}.request.json`),
    responsePath = join(dir, `${id}.response.json`);
  writeJson(requestPath, request);
  const child = spawnSync(
    executor,
    [...executorArgs, "--request", requestPath, "--response", responsePath],
    { encoding: "utf8", shell: false },
  );
  if (child.error || child.status !== 0)
    throw Error(
      `external executor failed: ${child.error?.message ?? child.stderr ?? child.status}`,
    );
  const response = readJson(responsePath);
  if (
    response.protocol !== "p0-executor-response-v1" ||
    response.request_digest !== digest(request) ||
    !equal(response.pinned_profile, request.pinned_profile)
  )
    throw Error("executor response binding/profile failure");
  if (
    !isStr(response.artifact_path) ||
    !existsSync(response.artifact_path) ||
    response.artifact_sha256 !==
      createHash("sha256")
        .update(readFileSync(response.artifact_path))
        .digest("hex")
  )
    throw Error("executor artifact digest failure");
  return response;
}
async function candidate({ root, profile, executor, executorArgs, results }) {
  let currentStepPath;
  return runCandidateArm({
    auditCode: resolve("audit-code.mjs"),
    snapshotRoot: root,
    pinnedProfile: profile,
    invokeCommand: (argv) => {
      const child = spawnSync(process.execPath, argv.slice(1), {
        encoding: "utf8",
        shell: false,
      });
      if (!child.error && child.status === 0)
        currentStepPath = currentStepPathFromCliOutput(child.stdout);
      return { status: child.status, error: child.error?.message };
    },
    readCurrentStep: () => readJson(currentStepPath),
    readPrompt: (promptPath) => readFileSync(resolve(root, promptPath), "utf8"),
    executeExternal: (request) => {
      const boundRequest = { protocol: "p0-step-request-v1", ...request };
      results.push({
        request: boundRequest,
        response: external(
          executor,
          executorArgs,
          boundRequest,
          dirname(root),
        ),
      });
    },
  });
}
async function run(path, requestsPath, identityPath, executor, executorArgs) {
  if (!isStr(executor))
    throw Error(
      "run requires --executor <executable>; operator credentials/configuration are required for a real run",
    );
  const manifest = readJson(path),
    requests = readJson(requestsPath),
    identity = readJson(identityPath);
  concrete(manifest);
  if (
    !validatePrivateIdentity(manifest, identity) ||
    !validatePublicRequests(manifest, requests, identity)
  )
    throw Error("prepared files do not bind manifest");
  const records = [],
    artifactDir = join(dirname(requestsPath), "raw-artifacts");
  for (const request of requests.requests) {
    const kind = identity.arms?.[request.pair_id]?.[request.arm];
    if (
      !["control", "candidate"].includes(kind) ||
      !equal(request.pinned_profile, manifest.shared)
    )
      throw Error("identity map/profile mismatch");
    if (kind === "control")
      records.push({
        request_id: request.request_id,
        request_digest: digest(request),
        response: external(
          executor,
          executorArgs,
          { ...request, execution: "standalone" },
          dirname(requestsPath),
        ),
      });
    else {
      const tempParent = mkdtempSync(join(tmpdir(), "audit-tools-p0-"));
      const root = join(tempParent, "repo");
      const primary = request.snapshot !== "held-out";
      try {
        if (primary) {
          await materializePinnedPrimary({
            repoRoot: process.cwd(),
            commit: manifest.shared.repo_commit,
            destination: root,
          });
        } else {
          cpSync(resolve(manifest.held_out.corpus.path), root, {
            recursive: true,
          });
        }
        const step_responses = [],
          final_step = await candidate({
            root,
            profile: manifest.shared,
            executor,
            executorArgs,
            results: step_responses,
          });
        const boundFinalStep = bindCandidateTerminalStep(final_step);
        if (
          boundFinalStep.complete !== true ||
          boundFinalStep.step_kind !== "present_report" ||
          !isStr(boundFinalStep.artifact_path)
        )
          throw Error("candidate terminal step lacks bound report evidence");
        const sourceReport = resolve(
          root,
          boundFinalStep.artifact_path,
        );
        if (!existsSync(sourceReport))
          throw Error(
            "candidate terminal step did not materialize an audit report artifact",
          );
        mkdirSync(artifactDir, { recursive: true });
        for (const [index, step] of step_responses.entries()) {
          const artifact_path = join(
            artifactDir,
            `${request.request_id}.step-${index + 1}.artifact`,
          );
          copyFileSync(step.response.artifact_path, artifact_path);
          step.response = {
            ...step.response,
            artifact_path,
            artifact_sha256: digest(readFileSync(artifact_path)),
          };
        }
        const artifact_path = join(artifactDir, `${request.request_id}.md`);
        copyFileSync(sourceReport, artifact_path);
        records.push({
          request_id: request.request_id,
          request_digest: digest(request),
          final_step: boundFinalStep,
          step_responses,
          snapshot_commit: primary ? manifest.shared.repo_commit : null,
          source_tree_clean: true,
          response: {
            artifact_path,
            artifact_sha256: createHash("sha256")
              .update(readFileSync(artifact_path))
              .digest("hex"),
          },
        });
      } finally {
        if (primary && existsSync(root)) {
          await removePinnedPrimary({
            repoRoot: process.cwd(),
            destination: root,
          });
        } else {
          rmSync(root, { recursive: true, force: true });
        }
        rmSync(tempParent, { recursive: true, force: true });
      }
    }
  }
  return {
    protocol: "p0-raw-results-v1",
    manifest_digest: digest(manifest),
    identity_digest: digest(identity),
    records,
  };
}
function graphDisabled(path, output) {
  const manifest = readJson(path);
  if (!validateBenchmarkManifest(manifest))
    throw Error("invalid graph-disabled protocol manifest");
  const record = {
    protocol: "p0-graph-disabled-v1",
    manifest_digest: digest(manifest),
    graph_enabled: false,
    outcome: "abort_before_comprehensive",
    notice: manifest.graph_disabled_trial.notice,
    comprehensive_started: false,
  };
  if (
    !/degraded|non-comprehensive/i.test(record.notice) ||
    record.comprehensive_started
  )
    throw Error("invalid graph-disabled abort record");
  if (output) writeJson(output, record);
  return record;
}
function expectedRequests(manifest, identity) {
  return new Map(
    [...manifest.primary.pairs, ...manifest.held_out.pairs].flatMap((pair) =>
      ["A", "B"].map((arm) => {
        const kind = identity.arms[pair.id][arm];
        return [
          `${pair.id}-${arm}`,
          {
            kind,
            request: {
              protocol: "p0-request-v1",
              request_id: `${pair.id}-${arm}`,
              pair_id: pair.id,
              arm,
              prompt: pair[`${kind}_prompt`],
              pinned_profile: manifest.shared,
              snapshot: pair.id.startsWith("held-out-")
                ? "held-out"
                : "primary",
            },
          },
        ];
      }),
    ),
  );
}

function validArtifact(response) {
  return (
    isObj(response) &&
    isStr(response.artifact_path) &&
    existsSync(response.artifact_path) &&
    response.artifact_sha256 === digest(readFileSync(response.artifact_path))
  );
}

function validExecutorResponse(response, request) {
  return (
    validArtifact(response) &&
    response.protocol === "p0-executor-response-v1" &&
    response.request_digest === digest(request) &&
    equal(response.pinned_profile, request.pinned_profile)
  );
}

function validateRawRunRecords(manifest, identity, raw) {
  const expected = expectedRequests(manifest, identity);
  const records = new Map(
    Array.isArray(raw?.records)
      ? raw.records.map((record) => [record?.request_id, record])
      : [],
  );
  if (
    raw?.protocol !== "p0-raw-results-v1" ||
    raw.manifest_digest !== digest(manifest) ||
    raw.identity_digest !== digest(identity) ||
    !Array.isArray(raw.records) ||
    raw.records.length !== expected.size ||
    records.size !== expected.size ||
    [...expected.keys()].some((requestId) => !records.has(requestId))
  )
    throw Error("raw benchmark records do not cover the 20 bound requests");

  for (const [requestId, { kind, request }] of expected) {
    const record = records.get(requestId);
    if (record.request_digest !== digest(request))
      throw Error("raw benchmark record request provenance is invalid");
    if (kind === "control") {
      if (
        !validExecutorResponse(record.response, {
          ...request,
          execution: "standalone",
        }) ||
        record.final_step !== undefined ||
        record.step_responses !== undefined
      )
        throw Error("raw control executor provenance is invalid");
      continue;
    }
    if (
      !validArtifact(record.response) ||
      !isObj(record.final_step) ||
      record.final_step.complete !== true ||
      record.final_step.step_kind !== "present_report" ||
      !isStr(record.final_step.step_id) ||
      !isStr(record.final_step.artifact_path) ||
      !Array.isArray(record.step_responses) ||
      record.step_responses.length === 0 ||
      record.source_tree_clean !== true ||
      record.snapshot_commit !==
        (request.snapshot === "primary" ? manifest.shared.repo_commit : null)
    )
      throw Error("raw candidate terminal provenance is invalid");
    const stepIds = new Set();
    for (const step of record.step_responses) {
      const stepRequest = step?.request;
      if (
        !isObj(stepRequest) ||
        stepRequest.protocol !== "p0-step-request-v1" ||
        !isStr(stepRequest.step_id) ||
        stepIds.has(stepRequest.step_id) ||
        !isStr(stepRequest.prompt) ||
        !isStr(stepRequest.snapshot_root) ||
        !equal(stepRequest.pinned_profile, manifest.shared) ||
        !validExecutorResponse(step.response, stepRequest)
      )
        throw Error("raw candidate step-response provenance is invalid");
      stepIds.add(stepRequest.step_id);
    }
  }
  return raw.records;
}

function isInsideOrEqual(parent, target) {
  const rel = relative(resolve(parent), resolve(target));
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
}

function orderedRawRecords(raw, seed) {
  const ordered = shuffled(raw.records, `${seed}:evaluator-packet-order`);
  if (
    ordered.length > 1 &&
    ordered.every(
      (record, index) => record.request_id === raw.records[index].request_id,
    )
  )
    ordered.push(ordered.shift());
  return ordered;
}

function normalizedJoinValue(value) {
  return String(value)
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replaceAll("\\", "/")
    .replace(/\s+/g, " ");
}

function validatePrivateGold(manifest, goldPath, packetDirectory) {
  if (
    !isStr(goldPath) ||
    !existsSync(resolve(goldPath)) ||
    !statSync(resolve(goldPath)).isFile()
  )
    throw Error("package-evaluators requires an existing private --gold file");
  const path = realpathSync(resolve(goldPath));
  const repository = realpathSync(REPOSITORY_ROOT);
  const packets = realpathSync(resolve(packetDirectory));
  if (isInsideOrEqual(repository, path) || isInsideOrEqual(packets, path))
    throw Error("private gold must be outside the repository and evaluator packet directory");
  const gold = readJson(path);
  if (
    !isObj(gold) ||
    !equal(Object.keys(gold).sort(), ["cases", "manifest_digest", "protocol"]) ||
    gold.protocol !== "p0-private-gold-v1" ||
    gold.manifest_digest !== digest(manifest) ||
    !Array.isArray(gold.cases) ||
    gold.cases.length === 0
  )
    throw Error("private gold does not bind the benchmark manifest");
  const privateIds = new Set();
  for (const item of gold.cases) {
    if (
      !isObj(item) ||
      !equal(Object.keys(item).sort(), [
        "evidence_focus",
        "group",
        "private_id",
        "sign",
        "strongest",
        "subject",
      ]) ||
      !isStr(item.private_id) ||
      !["primary", "held_out"].includes(item.group) ||
      !["positive", "negative", "unscored"].includes(item.sign) ||
      typeof item.strongest !== "boolean" ||
      !isStr(item.subject) ||
      item.subject.trim().length < 16 ||
      !isStr(item.evidence_focus) ||
      item.evidence_focus.trim().length < 24 ||
      (item.group === "primary" && item.sign === "negative") ||
      (item.strongest &&
        (item.group !== "primary" || item.sign !== "positive"))
    )
      throw Error("private gold case schema or classification is invalid");
    const privateId = normalizedJoinValue(item.private_id);
    if (privateIds.has(privateId))
      throw Error("private gold case identities must be normalized-unique");
    privateIds.add(privateId);
  }
  const count = (group, sign) =>
    gold.cases.filter((item) => item.group === group && item.sign === sign)
      .length;
  if (
    count("primary", "positive") < 4 ||
    count("primary", "unscored") < 1 ||
    count("held_out", "positive") < 1 ||
    count("held_out", "negative") < 1 ||
    count("held_out", "unscored") < 1 ||
    gold.cases.filter((item) => item.strongest).length !== 4
  )
    throw Error("private gold lacks required scored and distractor cases");
  return { gold, path, digest: digest(gold) };
}

function buildPrivateGoldIndex(gold) {
  return {
    by_id: new Map(gold.cases.map((item) => [item.private_id, item])),
    scoring: {
      primary_strongest_ids: gold.cases
        .filter((item) => item.strongest)
        .map((item) => item.private_id),
      held_positive_ids: gold.cases
        .filter(
          (item) => item.group === "held_out" && item.sign === "positive",
        )
        .map((item) => item.private_id),
      held_negative_ids: gold.cases
        .filter(
          (item) => item.group === "held_out" && item.sign === "negative",
        )
        .map((item) => item.private_id),
    },
  };
}

function buildReportBindings(
  manifest,
  identity,
  raw,
  packetDirectory,
) {
  const directory = resolve(packetDirectory);
  return orderedRawRecords(raw, identity.randomization_seed).map(
    (record, index) => {
      const blindedId = `R-${String(index + 1).padStart(2, "0")}`;
      const primary = manifest.primary.pairs.some((pair) =>
        [`${pair.id}-A`, `${pair.id}-B`].includes(record.request_id),
      );
      const packetReport = `reports/${blindedId}.md`;
      return {
        blinded_id: blindedId,
        request_id: record.request_id,
        source_report_path: resolve(record.response.artifact_path),
        source_report_sha256: record.response.artifact_sha256,
        packet_report: packetReport,
        packet_report_path: resolve(directory, packetReport),
        packet_report_sha256: record.response.artifact_sha256,
        gold_group: primary ? "primary" : "held_out",
      };
    },
  );
}

function packetReports(bindings) {
  return bindings.map((binding) => ({
    blinded_id: binding.blinded_id,
    report: binding.packet_report,
    report_sha256: binding.packet_report_sha256,
  }));
}

function packetWithoutDigest(packet) {
  const { packet_digest: _packetDigest, ...content } = packet;
  return content;
}

function containsIdentityLeak(value) {
  if (typeof value === "string") return /\b(?:control|candidate)\b/i.test(value);
  if (Array.isArray(value)) return value.some(containsIdentityLeak);
  if (!isObj(value)) return false;
  return Object.entries(value).some(([key, child]) =>
    [
      "identity",
      "identity_map",
      "private_arm_identity",
      "arm_identity",
      "control",
      "candidate",
    ].includes(key.toLowerCase()) || containsIdentityLeak(child),
  );
}

function normalizedFindingText(value) {
  return String(value).normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function validEvaluatorClaim(claim) {
  return (
    isObj(claim) &&
    equal(Object.keys(claim).sort(), [
      "confidence",
      "evidence",
      "normalized_finding_text",
      "support",
      "treatment",
    ]) &&
    isStr(claim.normalized_finding_text) &&
    claim.normalized_finding_text.length >= 8 &&
    claim.normalized_finding_text ===
      normalizedFindingText(claim.normalized_finding_text) &&
    CLAIM_TREATMENTS.includes(claim.treatment) &&
    CLAIM_SUPPORT_LEVELS.includes(claim.support) &&
    Number.isFinite(claim.confidence) &&
    claim.confidence >= 0 &&
    claim.confidence <= 1 &&
    isStr(claim.evidence) &&
    claim.evidence.trim().length > 0
  );
}

function readValidatedClaimEvaluation(evaluation) {
  if (
    !isObj(evaluation) ||
    !equal(Object.keys(evaluation).sort(), [
      "evaluator_id",
      "packet_digest",
      "packet_id",
      "packet_path",
      "protocol",
      "scores",
    ]) ||
    evaluation.protocol !== "p0-blinded-evaluation-v2" ||
    !isStr(evaluation.evaluator_id) ||
    !isStr(evaluation.packet_path) ||
    !isStr(evaluation.packet_id) ||
    !isStr(evaluation.packet_digest) ||
    containsIdentityLeak(evaluation)
  )
    throw Error("invalid or identity-leaking blinded evaluator result");

  const packetPath = resolve(evaluation.packet_path);
  const packet = readJson(packetPath);
  const expectedBlindIds = Array.from(
    { length: 20 },
    (_, index) => `R-${String(index + 1).padStart(2, "0")}`,
  );
  if (
    !equal(Object.keys(packet).sort(), [
      "axes",
      "axis_rubric",
      "claim_contract",
      "evaluator_slot",
      "manifest_digest",
      "packet_digest",
      "packet_id",
      "protocol",
      "reports",
    ]) ||
    packet.protocol !== "p0-blinded-evaluator-packet-v2" ||
    packet.packet_id !== evaluation.packet_id ||
    packet.packet_digest !== evaluation.packet_digest ||
    packet.packet_digest !== digest(packetWithoutDigest(packet)) ||
    ![1, 2].includes(packet.evaluator_slot) ||
    !isStr(packet.manifest_digest) ||
    !equal(packet.axes, AXES) ||
    !equal(packet.axis_rubric, AXIS_RUBRIC) ||
    !equal(packet.claim_contract, CLAIM_CONTRACT) ||
    !Array.isArray(packet.reports) ||
    packet.reports.length !== expectedBlindIds.length ||
    !equal(packet.reports.map((report) => report.blinded_id), expectedBlindIds) ||
    packet.reports.some(
      (report) =>
        !isObj(report) ||
        !equal(Object.keys(report).sort(), [
          "blinded_id",
          "report",
          "report_sha256",
        ]) ||
        !isStr(report.report) ||
        isAbsolute(report.report) ||
        !isInsideOrEqual(
          dirname(packetPath),
          resolve(dirname(packetPath), report.report),
        ) ||
        !isStr(report.report_sha256) ||
        !existsSync(resolve(dirname(packetPath), report.report)) ||
        report.report_sha256 !==
          digest(readFileSync(resolve(dirname(packetPath), report.report))),
    ) ||
    containsIdentityLeak(packet)
  )
    throw Error("evaluator result does not bind a valid blinded packet");

  if (
    !Array.isArray(evaluation.scores) ||
    evaluation.scores.length !== expectedBlindIds.length ||
    !equal(evaluation.scores.map((row) => row.blinded_id), expectedBlindIds) ||
    evaluation.scores.some(
      (row) =>
        !isObj(row) ||
        !equal(Object.keys(row).sort(), ["axes", "blinded_id", "claims"]) ||
        !isObj(row.axes) ||
        !equal(Object.keys(row.axes).sort(), [...AXES].sort()) ||
        AXES.some(
          (axis) =>
            !Number.isFinite(row.axes[axis]) ||
            row.axes[axis] < 0 ||
            row.axes[axis] > 1,
        ) ||
        !Array.isArray(row.claims) ||
        row.claims.some((claim) => !validEvaluatorClaim(claim)) ||
        new Set(row.claims.map((claim) => claim.normalized_finding_text)).size !==
          row.claims.length,
    )
  )
    throw Error(
      "evaluator result must score all 20 reports and emit exact generic claim records",
    );

  return {
    evaluation,
    packet,
    matrix: new Map(
      evaluation.scores.map((row) => [row.blinded_id, row]),
    ),
  };
}

export function packageEvaluators(
  path,
  rawPath,
  graphPath,
  identityPath,
  output,
  provenancePath,
  goldPath,
) {
  if (!isStr(identityPath) || !isStr(provenancePath) || !isStr(goldPath))
    throw Error(
      "package-evaluators requires private identity, gold, and provenance paths",
    );
  if (isInsideOrEqual(output, provenancePath))
    throw Error("private scoring provenance must be outside evaluator packet directory");
  const manifest = readJson(path),
    raw = readJson(rawPath),
    graph = readJson(graphPath),
    identity = readJson(identityPath);
  const packetDirectory = resolve(output);
  mkdirSync(join(packetDirectory, "reports"), { recursive: true });
  concrete(manifest);
  checkCorpus(manifest);
  const goldBinding = validatePrivateGold(manifest, goldPath, packetDirectory);
  if (!validatePrivateIdentity(manifest, identity))
    throw Error("private identity does not bind the benchmark manifest");
  validateRawRunRecords(manifest, identity, raw);
  if (
    graph.protocol !== "p0-graph-disabled-v1" ||
    graph.manifest_digest !== digest(manifest) ||
    graph.graph_enabled !== false ||
    graph.outcome !== "abort_before_comprehensive" ||
    graph.notice !== manifest.graph_disabled_trial.notice ||
    graph.comprehensive_started !== false
  )
    throw Error("requires a manifest-bound graph-disabled abort record");
  const reportBindings = buildReportBindings(
    manifest,
    identity,
    raw,
    packetDirectory,
  );
  for (const binding of reportBindings) {
    copyFileSync(binding.source_report_path, binding.packet_report_path);
    if (digest(readFileSync(binding.packet_report_path)) !== binding.packet_report_sha256)
      throw Error("blinded packet report copy failed digest validation");
  }
  const reports = packetReports(reportBindings);
  const packets = [];
  for (const index of [1, 2]) {
    const packetPath = join(packetDirectory, `evaluator-${index}.packet.json`);
    const content = {
      protocol: "p0-blinded-evaluator-packet-v2",
      packet_id: `evaluator-${index}-${digest(manifest).slice(0, 12)}`,
      evaluator_slot: index,
      manifest_digest: digest(manifest),
      axes: AXES,
      axis_rubric: AXIS_RUBRIC,
      claim_contract: CLAIM_CONTRACT,
      reports,
    };
    const packet = { ...content, packet_digest: digest(content) };
    writeJson(packetPath, packet);
    packets.push({
      packet_id: packet.packet_id,
      packet_path: packetPath,
      packet_digest: packet.packet_digest,
    });
  }
  const packetBindings = packets.map((packet, index) => ({
    packet_id: packet.packet_id,
    evaluator_slot: index + 1,
    packet_path: resolve(packet.packet_path),
    packet_digest: packet.packet_digest,
  }));
  const privateContent = {
    protocol: "p0-private-scoring-provenance-v2",
    manifest_path: resolve(path),
    manifest_digest: digest(manifest),
    raw_path: resolve(rawPath),
    raw_digest: digest(raw),
    graph_path: resolve(graphPath),
    graph_digest: digest(graph),
    identity_path: resolve(identityPath),
    identity_digest: digest(identity),
    gold_path: goldBinding.path,
    gold_digest: goldBinding.digest,
    packet_directory: packetDirectory,
    report_bindings: reportBindings,
    packet_bindings: packetBindings,
  };
  writeJson(provenancePath, {
    ...privateContent,
    provenance_digest: digest(privateContent),
  });
  return {
    protocol: "p0-evaluator-package-v2",
    directory: packetDirectory,
    private_provenance_path: resolve(provenancePath),
    packets,
  };
}

function provenanceWithoutDigest(provenance) {
  const { provenance_digest: _provenanceDigest, ...content } = provenance;
  return content;
}

function readValidatedPrivateProvenance(path, validated) {
  if (!isStr(path)) throw Error("score requires private scoring provenance");
  const provenance = readJson(path);
  if (
    provenance.protocol !== "p0-private-scoring-provenance-v2" ||
    provenance.provenance_digest !== digest(provenanceWithoutDigest(provenance))
  )
    throw Error("invalid private scoring provenance digest");
  if (
    [
      provenance.manifest_path,
      provenance.raw_path,
      provenance.graph_path,
      provenance.identity_path,
      provenance.gold_path,
      provenance.packet_directory,
    ].some((item) => !isStr(item))
  )
    throw Error("private scoring provenance does not bind the benchmark run");

  const manifest = readJson(provenance.manifest_path),
    raw = readJson(provenance.raw_path),
    graph = readJson(provenance.graph_path),
    identity = readJson(provenance.identity_path);
  concrete(manifest);
  checkCorpus(manifest);
  const goldBinding = validatePrivateGold(
    manifest,
    provenance.gold_path,
    provenance.packet_directory,
  );
  if (!validatePrivateIdentity(manifest, identity))
    throw Error("private scoring provenance does not bind the benchmark run");
  validateRawRunRecords(manifest, identity, raw);
  const goldIndex = buildPrivateGoldIndex(goldBinding.gold);
  const bindings = buildReportBindings(
    manifest,
    identity,
    raw,
    provenance.packet_directory,
  );
  const reports = packetReports(bindings);
  const packetBindings = validated
    .map(({ evaluation, packet }) => ({
      packet_id: packet.packet_id,
      evaluator_slot: packet.evaluator_slot,
      packet_path: resolve(evaluation.packet_path),
      packet_digest: packet.packet_digest,
    }))
    .sort((left, right) => left.evaluator_slot - right.evaluator_slot);
  const reportFilesValid = bindings.every(
    (binding) =>
      validArtifact({
        artifact_path: binding.source_report_path,
        artifact_sha256: binding.source_report_sha256,
      }) &&
      isInsideOrEqual(provenance.packet_directory, binding.packet_report_path) &&
      validArtifact({
        artifact_path: binding.packet_report_path,
        artifact_sha256: binding.packet_report_sha256,
      }),
  );
  if (
    isInsideOrEqual(provenance.packet_directory, path) ||
    provenance.manifest_path !== resolve(provenance.manifest_path) ||
    provenance.raw_path !== resolve(provenance.raw_path) ||
    provenance.graph_path !== resolve(provenance.graph_path) ||
    provenance.identity_path !== resolve(provenance.identity_path) ||
    provenance.packet_directory !== resolve(provenance.packet_directory) ||
    provenance.gold_path !== goldBinding.path ||
    provenance.gold_digest !== goldBinding.digest ||
    provenance.manifest_digest !== digest(manifest) ||
    provenance.raw_digest !== digest(raw) ||
    provenance.graph_digest !== digest(graph) ||
    provenance.identity_digest !== digest(identity) ||
    !reportFilesValid ||
    graph.protocol !== "p0-graph-disabled-v1" ||
    graph.manifest_digest !== digest(manifest) ||
    graph.graph_enabled !== false ||
    graph.outcome !== "abort_before_comprehensive" ||
    graph.notice !== manifest.graph_disabled_trial.notice ||
    graph.comprehensive_started !== false ||
    !equal(provenance.report_bindings, bindings) ||
    !equal(provenance.packet_bindings, packetBindings) ||
    validated.some(
      ({ evaluation, packet }) =>
        resolve(dirname(evaluation.packet_path)) !==
          provenance.packet_directory ||
        packet.manifest_digest !== digest(manifest) ||
        !equal(packet.reports, reports),
    )
  )
    throw Error("private scoring provenance does not bind the benchmark run");
  return {
    manifest,
    identity,
    bindings,
    gold: goldBinding.gold,
    goldIndex,
    scoring: goldIndex.scoring,
  };
}

function validAxisResolution(resolution) {
  return (
    isObj(resolution) &&
    equal(Object.keys(resolution).sort(), [
      "disagreement_id",
      "rationale",
      "value",
    ]) &&
    isStr(resolution.disagreement_id) &&
    isStr(resolution.rationale) &&
    Number.isFinite(resolution.value) &&
    resolution.value >= 0 &&
    resolution.value <= 1
  );
}

function adjudicatedAxisRows(validated, bindings, resolutions) {
  const disagreements = [];
  for (const { blinded_id: blindedId } of bindings) {
    const left = validated[0].matrix.get(blindedId),
      right = validated[1].matrix.get(blindedId);
    for (const axis of AXES)
      if (!equal(left.axes[axis], right.axes[axis]))
        disagreements.push(`${blindedId}:${axis}`);
  }
  const resolutionIds = resolutions.map((item) => item?.disagreement_id);
  if (
    new Set(resolutionIds).size !== resolutionIds.length ||
    !equal([...resolutionIds].sort(), [...disagreements].sort()) ||
    resolutions.some((item) => !validAxisResolution(item))
  )
    throw Error("adjudication must resolve exactly the observed axis disagreements");
  const byId = new Map(
    resolutions.map((item) => [item.disagreement_id, item.value]),
  );
  return new Map(
    bindings.map(({ blinded_id: blindedId }) => {
      const row = validated[0].matrix.get(blindedId);
      return [
        blindedId,
        {
          axes: Object.fromEntries(
            AXES.map((axis) => [
              axis,
              byId.has(`${blindedId}:${axis}`)
                ? byId.get(`${blindedId}:${axis}`)
                : row.axes[axis],
            ]),
          ),
        },
      ];
    }),
  );
}

function claimReferenceKey(blindedId, evaluatorSlot, claimIndex) {
  return `${blindedId}:${evaluatorSlot}:${claimIndex}`;
}

function validateAdjudicatedClaimMappings(
  validated,
  bindings,
  goldIndex,
  resolutions,
) {
  if (!Array.isArray(resolutions))
    throw Error("private adjudication requires exact claim mappings");
  const bindingByBlindId = new Map(
    bindings.map((binding) => [binding.blinded_id, binding]),
  );
  const expectedReferences = new Map();
  for (const { packet, matrix } of validated) {
    for (const { blinded_id: blindedId } of bindings) {
      const claims = matrix.get(blindedId).claims;
      claims.forEach((claim, claimIndex) => {
        expectedReferences.set(
          claimReferenceKey(blindedId, packet.evaluator_slot, claimIndex),
          { blinded_id: blindedId, claim },
        );
      });
    }
  }

  const consumedReferences = new Set();
  const byReport = new Map(bindings.map(({ blinded_id }) => [blinded_id, []]));
  for (const resolution of resolutions) {
    if (
      !isObj(resolution) ||
      !equal(Object.keys(resolution).sort(), [
        "blinded_id",
        "claim_refs",
        "confidence",
        "normalized_finding_text",
        "private_id",
        "rationale",
        "support",
        "treatment",
      ]) ||
      !bindingByBlindId.has(resolution.blinded_id) ||
      !Array.isArray(resolution.claim_refs) ||
      resolution.claim_refs.length === 0 ||
      !isStr(resolution.rationale) ||
      !isStr(resolution.normalized_finding_text) ||
      resolution.normalized_finding_text !==
        normalizedFindingText(resolution.normalized_finding_text) ||
      !CLAIM_TREATMENTS.includes(resolution.treatment) ||
      !CLAIM_SUPPORT_LEVELS.includes(resolution.support) ||
      !Number.isFinite(resolution.confidence) ||
      resolution.confidence < 0 ||
      resolution.confidence > 1 ||
      !(resolution.private_id === null || isStr(resolution.private_id))
    )
      throw Error("private adjudication contains a malformed claim mapping");

    const observedClaims = [];
    for (const reference of resolution.claim_refs) {
      if (
        !isObj(reference) ||
        !equal(Object.keys(reference).sort(), [
          "claim_index",
          "evaluator_slot",
        ]) ||
        ![1, 2].includes(reference.evaluator_slot) ||
        !Number.isInteger(reference.claim_index) ||
        reference.claim_index < 0
      )
        throw Error("private adjudication contains an invalid claim reference");
      const key = claimReferenceKey(
        resolution.blinded_id,
        reference.evaluator_slot,
        reference.claim_index,
      );
      const observed = expectedReferences.get(key);
      if (!observed || consumedReferences.has(key))
        throw Error("private adjudication claim references must be exact and unique");
      consumedReferences.add(key);
      observedClaims.push(observed.claim);
    }
    if (
      !observedClaims.some(
        (claim) =>
          claim.normalized_finding_text ===
            resolution.normalized_finding_text &&
          claim.treatment === resolution.treatment &&
          claim.support === resolution.support &&
          claim.confidence === resolution.confidence,
      )
    )
      throw Error("private adjudication cannot fabricate canonical claim values");

    const goldCase =
      resolution.private_id === null
        ? null
        : goldIndex.by_id.get(resolution.private_id);
    if (
      (resolution.private_id !== null && !goldCase) ||
      (goldCase &&
        goldCase.group !== bindingByBlindId.get(resolution.blinded_id).gold_group)
    )
      throw Error("private adjudication maps a claim outside its private gold group");
    byReport.get(resolution.blinded_id).push({
      confidence: resolution.confidence,
      private_id: resolution.private_id,
      support: resolution.support,
      treatment: resolution.treatment,
    });
  }
  if (
    consumedReferences.size !== expectedReferences.size ||
    [...expectedReferences.keys()].some((key) => !consumedReferences.has(key))
  )
    throw Error("private adjudication must map every evaluator claim exactly once");
  return byReport;
}

function positiveOutcomeForClaim(claim) {
  if (
    claim.treatment === "explicitly_defended" ||
    claim.support === "unsupported" ||
    claim.confidence < 0.5
  )
    return "missed";
  if (claim.support === "partial" || claim.confidence < 0.8) return "partial";
  return claim.treatment === "validly_subsumed"
    ? "validly_subsumed"
    : "recovered";
}

function deriveClaimRows(bindings, gold, mappings) {
  return new Map(
    bindings.map((binding) => {
      const applicable = gold.cases.filter(
        (item) => item.group === binding.gold_group,
      );
      const positiveOutcomes = Object.fromEntries(
        applicable
          .filter((item) => item.sign === "positive")
          .map((item) => [item.private_id, "missed"]),
      );
      const negativeFalsePositives = Object.fromEntries(
        applicable
          .filter((item) => item.sign === "negative")
          .map((item) => [item.private_id, 0]),
      );
      let admittedUnsupported = 0,
        unmatchedFalsePositives = 0;
      for (const claim of mappings.get(binding.blinded_id)) {
        const goldCase =
          claim.private_id === null
            ? null
            : applicable.find((item) => item.private_id === claim.private_id);
        const assertedFinding =
          claim.treatment === "finding" && claim.confidence >= 0.8;
        const unsupportedFinding =
          assertedFinding &&
          (claim.support === "unsupported" ||
            !goldCase ||
            goldCase.sign === "negative");
        if (unsupportedFinding) admittedUnsupported += 1;
        if (!goldCase) {
          if (binding.gold_group === "held_out" && assertedFinding)
            unmatchedFalsePositives += 1;
          continue;
        }
        if (goldCase.sign === "positive") {
          const outcome = positiveOutcomeForClaim(claim);
          if (
            OUTCOME_WEIGHTS[outcome] >
            OUTCOME_WEIGHTS[positiveOutcomes[goldCase.private_id]]
          )
            positiveOutcomes[goldCase.private_id] = outcome;
        } else if (goldCase.sign === "negative" && assertedFinding) {
          negativeFalsePositives[goldCase.private_id] = 1;
        }
      }
      return [
        binding.blinded_id,
        {
          admitted_high_confidence_unsupported: admittedUnsupported,
          negative_control_false_positives: negativeFalsePositives,
          positive_outcomes: positiveOutcomes,
          unmatched_false_positives: unmatchedFalsePositives,
        },
      ];
    }),
  );
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function deriveBenchmarkAggregate(manifest, identity, bindings, rows, scoring) {
  const byRequest = new Map(
    bindings.map(({ blinded_id, request_id }) => [
      request_id,
      rows.get(blinded_id),
    ]),
  );
  const paired = (pairs) =>
    pairs.map((pair) => {
      const result = {};
      for (const arm of ["A", "B"])
        result[identity.arms[pair.id][arm]] = byRequest.get(`${pair.id}-${arm}`);
      return result;
    });
  const primaryPairs = paired(manifest.primary.pairs),
    heldPairs = paired(manifest.held_out.pairs);
  const pairTiesOrWins = (pairs) =>
    pairs.filter(({ candidate, control }) =>
      AXES.every((axis) => candidate.axes[axis] >= control.axes[axis]),
    ).length;
  const medians = (pairs) =>
    Object.fromEntries(
      AXES.map((axis) => [
        axis,
        {
          candidate: median(pairs.map((pair) => pair.candidate.axes[axis])),
          control: median(pairs.map((pair) => pair.control.axes[axis])),
        },
      ]),
    );
  const heldPositiveRate = (kind) =>
    mean(
      heldPairs.flatMap((pair) =>
        scoring.held_positive_ids.map(
          (id) => OUTCOME_WEIGHTS[pair[kind].positive_outcomes[id]],
        ),
      ),
    );
  const heldNegativeRate = (kind) =>
    heldPairs.reduce(
      (total, pair) =>
        total +
        scoring.held_negative_ids.reduce(
          (subtotal, id) =>
            subtotal + pair[kind].negative_control_false_positives[id],
          0,
        ) +
        pair[kind].unmatched_false_positives,
      0,
    ) /
    (heldPairs.length * scoring.held_negative_ids.length);
  return {
    evaluator_coverage: { independent: 2, adjudicated: true },
    primary: {
      ties_or_wins: pairTiesOrWins(primaryPairs),
      candidate_runs_recovering_strongest: primaryPairs.filter(({ candidate }) =>
        scoring.primary_strongest_ids.every(
          (id) => OUTCOME_WEIGHTS[candidate.positive_outcomes[id]] === 1,
        ),
      ).length,
      median_by_axis: medians(primaryPairs),
    },
    admitted_high_confidence_unsupported: [
      ...primaryPairs,
      ...heldPairs,
    ].reduce(
      (total, pair) =>
        total + pair.candidate.admitted_high_confidence_unsupported,
      0,
    ),
    held_out: {
      ties_or_wins: pairTiesOrWins(heldPairs),
      median_by_axis: medians(heldPairs),
      seeded_positive_rate: {
        candidate: heldPositiveRate("candidate"),
        control: heldPositiveRate("control"),
      },
      negative_control_false_positive_rate: {
        candidate: heldNegativeRate("candidate"),
        control: heldNegativeRate("control"),
      },
    },
  };
}

function canonicalReviewerId(value) {
  if (!isStr(value)) return null;
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function score(path) {
  const input = readJson(path);
  if (Object.hasOwn(input, "score"))
    throw Error("caller-supplied benchmark aggregates are not accepted");
  const evaluations = input.evaluator_input?.evaluations;
  const resolutions = input.adjudication?.resolutions ?? [];
  const claimResolutions = input.adjudication?.claim_resolutions;
  if (
    input.evaluator_input?.protocol !== "p0-independent-evaluations-v2" ||
    !isObj(input.adjudication) ||
    !equal(Object.keys(input.adjudication).sort(), [
      "adjudicator_id",
      "claim_resolutions",
      "packet_digests",
      "protocol",
      "resolutions",
    ]) ||
    input.adjudication.protocol !== "p0-private-adjudication-v2" ||
    !isStr(input.adjudication.adjudicator_id) ||
    containsIdentityLeak(input.adjudication) ||
    !Array.isArray(evaluations) ||
    evaluations.length !== 2 ||
    !Array.isArray(resolutions) ||
    !Array.isArray(claimResolutions)
  )
    throw Error("incomplete or identity-leaking evaluator/adjudication input");

  const validated = evaluations.map(readValidatedClaimEvaluation);
  const canonicalEvaluatorIds = validated.map(({ evaluation }) =>
      canonicalReviewerId(evaluation.evaluator_id),
    ),
    evaluatorIds = new Set(canonicalEvaluatorIds),
    adjudicatorId = canonicalReviewerId(input.adjudication.adjudicator_id),
    packetIds = new Set(validated.map(({ packet }) => packet.packet_id)),
    packetSlots = validated.map(({ packet }) => packet.evaluator_slot).sort(),
    packetDigests = validated.map(({ packet }) => packet.packet_digest).sort();
  if (
    canonicalEvaluatorIds.some((id) => id === null) ||
    adjudicatorId === null ||
    evaluatorIds.size !== 2 ||
    evaluatorIds.has(adjudicatorId) ||
    packetIds.size !== 2 ||
    !equal(packetSlots, [1, 2]) ||
    validated[0].packet.manifest_digest !==
      validated[1].packet.manifest_digest ||
    !equal(validated[0].packet.reports, validated[1].packet.reports) ||
    !Array.isArray(input.adjudication.packet_digests) ||
    !equal([...input.adjudication.packet_digests].sort(), packetDigests)
  )
    throw Error("evaluations must be independent and bind the same blinded corpus");

  const { manifest, identity, bindings, gold, goldIndex, scoring } =
    readValidatedPrivateProvenance(input.private_provenance_path, validated);
  const axisRows = adjudicatedAxisRows(validated, bindings, resolutions);
  const claimMappings = validateAdjudicatedClaimMappings(
    validated,
    bindings,
    goldIndex,
    claimResolutions,
  );
  const claimRows = deriveClaimRows(bindings, gold, claimMappings);
  const rows = new Map(
    bindings.map(({ blinded_id: blindedId }) => [
      blindedId,
      { ...axisRows.get(blindedId), ...claimRows.get(blindedId) },
    ]),
  );
  const aggregate = deriveBenchmarkAggregate(
    manifest,
    identity,
    bindings,
    rows,
    scoring,
  );
  if (!evaluateBenchmarkScores(aggregate))
    throw Error("derived benchmark score is non-passing");
  return { protocol: "p0-derived-score-v2", accepted: true, aggregate };
}
function args(values) {
  const flags = {};
  for (let i = 0; i < values.length; i += 1)
    if (values[i].startsWith("--")) {
      const key = values[i].slice(2);
      if (key === "executor-arg") (flags[key] ??= []).push(values[++i]);
      else flags[key] = values[++i];
    }
  return flags;
}
function help() {
  console.log(
    "Usage: node benchmarks/p0/runner.mjs <command> [options]\nCommands: preflight, prepare, run, graph-disabled, package-evaluators, score",
  );
}
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") return help();
  const f = args(rest),
    manifest = f.manifest ?? "benchmarks/p0/manifest.json";
  let result;
  switch (command) {
    case "preflight":
      result = preflight(manifest);
      break;
    case "prepare":
      result = prepare(manifest, f.output ?? "benchmarks/p0/results");
      break;
    case "run":
      result = await run(
        manifest,
        f.requests,
        f.identity,
        f.executor,
        f["executor-arg"] ?? [],
      );
      break;
    case "graph-disabled":
      result = graphDisabled(manifest, f.output);
      break;
    case "package-evaluators":
      result = packageEvaluators(
        manifest,
        f.raw,
        f.graph,
        f.identity,
        f.output ?? "benchmarks/p0/results/evaluators",
        f.provenance ?? "benchmarks/p0/results/scoring-provenance.private.json",
        f.gold,
      );
      break;
    case "score":
      result = score(f.input);
      break;
    default:
      throw Error(`unknown command: ${command}`);
  }
  if (result !== undefined) console.log(JSON.stringify(result, null, 2));
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(`p0 runner: ${error.message}`);
    process.exitCode = 1;
  });
