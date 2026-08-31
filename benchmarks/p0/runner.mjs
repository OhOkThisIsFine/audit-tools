import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const AXES = [
  "structural_recall",
  "philosophy_telos_recall",
  "grounding_precision",
  "telos_to_code_linkage",
  "reduction_value",
  "false_positive_discipline",
];
const POS = [
  "duplicated_machinery",
  "duplicated_advancement_state_ownership",
  "goal_conflict",
  "disproportionate_lifecycle_ceremony",
];
const NEG = [
  "intentional_bounded_context_duplication",
  "safety_gate_removal_increases_risk",
];
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

function assertStep(step, seen) {
  if (!isObj(step) || !isStr(step.step_id))
    throw Error("missing or malformed current step");
  if (seen.has(step.step_id))
    throw Error("non-advancing or repeated step identity");
  seen.add(step.step_id);
}
function terminal(step) {
  return step.complete === true || step.step_kind === "present_report";
}
function stepRequest(step, prompt, snapshot_root, pinned_profile) {
  if (!isStr(prompt)) throw Error(`missing prompt for step ${step.step_id}`);
  return {
    step_id: step.step_id,
    prompt,
    artifact_path: step.artifact_path,
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
    `max-step exhaustion after ${maxSteps} steps; last=${last?.step_id ?? "none"}`,
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
      throw Error(`missing prompt_path for step ${step.step_id}`);
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
    `max-step exhaustion after ${maxSteps} steps; last=${last?.step_id ?? "none"}`,
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
  const held = m.held_out ?? {};
  bad(
    equal([...(held.seeded_positive_classes ?? [])].sort(), [...POS].sort()),
    "positive classes",
  );
  bad(
    equal([...(held.negative_controls ?? [])].sort(), [...NEG].sort()),
    "negative controls",
  );
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
  if (m.randomization?.seed !== undefined)
    bad(
      isStr(m.randomization.seed) &&
        !/^(operator-pinned|tbd|todo|unknown|unspecified|placeholder)$/i.test(
          m.randomization.seed,
        ),
      "seed",
    );
  bad(
    m.evaluation?.independent_evaluators === 2 &&
      m.evaluation?.adjudicator === 1 &&
      equal(m.axes, AXES),
    "evaluation",
  );
  if (
    m.primary?.accepted_reports?.some((x) =>
      String(x).includes("complexity-reduction"),
    )
  ) {
    const expected = Array.from(
      { length: 24 },
      (_, i) => `O-${String(i + 1).padStart(2, "0")}`,
    ).sort();
    bad(
      equal([...(m.primary.normalized_opportunity_ids ?? [])].sort(), expected),
      "opportunity ids",
    );
  }
  if (held.corpus)
    bad(
      held.corpus.labels_outside_root === true &&
        held.corpus.deterministic_tree_digest === true,
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
  const root = resolve(corpus.path),
    labelsPath = resolve(corpus.labels_path ?? "");
  if (
    !isStr(corpus.labels_path) ||
    labelsPath.startsWith(
      `${root}${process.platform === "win32" ? "\\" : "/"}`,
    ) ||
    !existsSync(labelsPath) ||
    !statSync(labelsPath).isFile()
  )
    throw Error("held-out labels must be a file outside snapshot root");
  if (
    corpus.deterministic_tree_digest !== true ||
    treeDigest(root) !== corpus.sha256
  )
    throw Error("held-out tree digest mismatch");
  const labels = readJson(labelsPath);
  const expected = [
    ...manifest.held_out.seeded_positive_classes,
    ...manifest.held_out.negative_controls,
  ];
  if (
    !Array.isArray(labels) ||
    labels.length !== expected.length ||
    new Set(labels.map((label) => label?.class)).size !== expected.length ||
    !equal(labels.map((label) => label?.class).sort(), [...expected].sort())
  )
    throw Error("held-out labels must contain each class exactly once");
  for (const label of labels) {
    if (
      !isStr(label.path) ||
      label.path.includes("..") ||
      resolve(root, label.path) === root ||
      !resolve(root, label.path).startsWith(
        `${root}${process.platform === "win32" ? "\\" : "/"}`,
      ) ||
      !existsSync(resolve(root, label.path)) ||
      !statSync(resolve(root, label.path)).isFile()
    )
      throw Error("held-out label path must name a regular snapshot file");
  }
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
    held.seeded_positive_rate?.candidate >=
      held.seeded_positive_rate?.control &&
    held.negative_control_false_positive_rate?.candidate <=
      held.negative_control_false_positive_rate?.control
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
  return [...values].sort(() => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32 - 0.5;
  });
}
function prepare(path, output, seed) {
  const manifest = readJson(path);
  concrete(manifest);
  checkCorpus(manifest);
  if (!isStr(seed) || /operator|placeholder|tbd|todo/i.test(seed))
    throw Error("prepare requires concrete --seed");
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
  return runCandidateArm({
    auditCode: resolve("audit-code.mjs"),
    snapshotRoot: root,
    pinnedProfile: profile,
    invokeCommand: (argv) => {
      const child = spawnSync(process.execPath, argv.slice(1), {
        encoding: "utf8",
        shell: false,
      });
      return { status: child.status, error: child.error?.message };
    },
    readCurrentStep: () =>
      readJson(
        join(root, ".audit-tools", "audit", "steps", "current-step.json"),
      ),
    readPrompt: (promptPath) => readFileSync(resolve(root, promptPath), "utf8"),
    executeExternal: (request) =>
      results.push(
        external(
          executor,
          executorArgs,
          { protocol: "p0-step-request-v1", ...request },
          dirname(root),
        ),
      ),
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
    requests.protocol !== "p0-public-requests-v1" ||
    identity.protocol !== "p0-private-identity-v1" ||
    requests.manifest_digest !== digest(manifest) ||
    identity.manifest_digest !== digest(manifest)
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
        const sourceReport = resolve(
          root,
          final_step.artifact_path ?? ".audit-tools/audit/audit-report.md",
        );
        if (!existsSync(sourceReport))
          throw Error(
            "candidate terminal step did not materialize an audit report artifact",
          );
        mkdirSync(artifactDir, { recursive: true });
        const artifact_path = join(artifactDir, `${request.request_id}.md`);
        copyFileSync(sourceReport, artifact_path);
        records.push({
          request_id: request.request_id,
          final_step,
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
function expectedRequestIds(manifest) {
  return [...(manifest.primary?.pairs ?? []), ...(manifest.held_out?.pairs ?? [])]
    .flatMap((pair) => [`${pair.id}-A`, `${pair.id}-B`]);
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

function readValidatedEvaluation(evaluation) {
  if (
    !isObj(evaluation) ||
    evaluation.protocol !== "p0-blinded-evaluation-v1" ||
    !isStr(evaluation.evaluator_id) ||
    !isStr(evaluation.packet_path) ||
    !isStr(evaluation.packet_id) ||
    !isStr(evaluation.packet_digest) ||
    containsIdentityLeak(evaluation)
  )
    throw Error("invalid or identity-leaking blinded evaluator result");

  const packet = readJson(evaluation.packet_path);
  const expectedBlindIds = Array.from(
    { length: 20 },
    (_, index) => `R-${String(index + 1).padStart(2, "0")}`,
  );
  if (
    packet.protocol !== "p0-blinded-evaluator-packet-v1" ||
    packet.packet_id !== evaluation.packet_id ||
    packet.packet_digest !== evaluation.packet_digest ||
    packet.packet_digest !== digest(packetWithoutDigest(packet)) ||
    ![1, 2].includes(packet.evaluator_slot) ||
    !isStr(packet.manifest_digest) ||
    !equal(packet.axes, AXES) ||
    !Array.isArray(packet.reports) ||
    packet.reports.length !== expectedBlindIds.length ||
    !equal(packet.reports.map((report) => report.blinded_id), expectedBlindIds) ||
    packet.reports.some(
      (report) =>
        !isStr(report.report) ||
        !isStr(report.report_sha256) ||
        !existsSync(report.report) ||
        report.report_sha256 !==
          createHash("sha256").update(readFileSync(report.report)).digest("hex"),
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
        !isObj(row.axes) ||
        !equal(Object.keys(row.axes).sort(), [...AXES].sort()) ||
        AXES.some(
          (axis) =>
            !Number.isFinite(row.axes[axis]) ||
            row.axes[axis] < 0 ||
            row.axes[axis] > 1,
        ),
    )
  )
    throw Error("evaluator result must score all 20 reports on exactly six axes");

  return {
    evaluation,
    packet,
    matrix: new Map(
      evaluation.scores.map((row) => [row.blinded_id, row.axes]),
    ),
  };
}

export function packageEvaluators(path, rawPath, graphPath, output) {
  const manifest = readJson(path),
    raw = readJson(rawPath),
    graph = readJson(graphPath);
  concrete(manifest);
  const expectedIds = new Set(expectedRequestIds(manifest));
  const ids = new Set(raw.records?.map((record) => record.request_id));
  const reportsValid = raw.records?.every(
    (record) =>
      isStr(record.response?.artifact_path) &&
      existsSync(record.response.artifact_path) &&
      record.response.artifact_sha256 ===
        createHash("sha256")
          .update(readFileSync(record.response.artifact_path))
          .digest("hex"),
  );
  if (
    raw.protocol !== "p0-raw-results-v1" ||
    !Array.isArray(raw.records) ||
    raw.records.length !== expectedIds.size ||
    ids.size !== expectedIds.size ||
    [...expectedIds].some((id) => !ids.has(id)) ||
    !reportsValid ||
    raw.manifest_digest !== digest(manifest) ||
    graph.protocol !== "p0-graph-disabled-v1" ||
    graph.manifest_digest !== digest(manifest) ||
    graph.graph_enabled !== false ||
    graph.outcome !== "abort_before_comprehensive" ||
    graph.comprehensive_started
  )
    throw Error(
      "requires 20 complete raw reports from ten pairs and a graph-disabled abort record",
    );
  mkdirSync(output, { recursive: true });
  const packets = [];
  for (const index of [1, 2]) {
    const packetPath = join(output, `evaluator-${index}.packet.json`);
    const content = {
      protocol: "p0-blinded-evaluator-packet-v1",
      packet_id: `evaluator-${index}-${digest(manifest).slice(0, 12)}`,
      evaluator_slot: index,
      manifest_digest: digest(manifest),
      axes: AXES,
      reports: raw.records.map((record, n) => ({
        blinded_id: `R-${String(n + 1).padStart(2, "0")}`,
        report: record.response.artifact_path,
        report_sha256: record.response.artifact_sha256,
      })),
    };
    const packet = { ...content, packet_digest: digest(content) };
    writeJson(packetPath, packet);
    packets.push({
      packet_id: packet.packet_id,
      packet_path: packetPath,
      packet_digest: packet.packet_digest,
    });
  }
  return {
    protocol: "p0-evaluator-package-v1",
    directory: output,
    packets,
  };
}

export function score(path) {
  const input = readJson(path);
  const evaluations = input.evaluator_input?.evaluations;
  const resolutions = input.adjudication?.resolutions ?? [];
  if (
    input.evaluator_input?.protocol !== "p0-independent-evaluations-v1" ||
    !isObj(input.adjudication) ||
    input.adjudication.protocol !== "p0-adjudication-v1" ||
    !Array.isArray(evaluations) ||
    evaluations.length !== 2
  )
    throw Error("incomplete evaluator/adjudication input or non-passing score");

  const validated = evaluations.map(readValidatedEvaluation);
  const evaluatorIds = new Set(
      validated.map(({ evaluation }) => evaluation.evaluator_id),
    ),
    packetIds = new Set(validated.map(({ packet }) => packet.packet_id)),
    packetDigests = validated.map(({ packet }) => packet.packet_digest).sort();
  if (
    evaluatorIds.size !== 2 ||
    packetIds.size !== 2 ||
    validated[0].packet.manifest_digest !==
      validated[1].packet.manifest_digest ||
    !equal(validated[0].packet.reports, validated[1].packet.reports) ||
    !Array.isArray(input.adjudication.packet_digests) ||
    !equal([...input.adjudication.packet_digests].sort(), packetDigests) ||
    !Array.isArray(resolutions)
  )
    throw Error("evaluations must be independent and bind the same blinded corpus");

  const disagreements = [];
  for (const report of validated[0].packet.reports) {
    for (const axis of AXES) {
      if (
        validated[0].matrix.get(report.blinded_id)[axis] !==
        validated[1].matrix.get(report.blinded_id)[axis]
      )
        disagreements.push(`${report.blinded_id}:${axis}`);
    }
  }
  const resolutionIds = resolutions.map((item) => item?.disagreement_id);
  if (
    new Set(resolutionIds).size !== resolutionIds.length ||
    !equal([...resolutionIds].sort(), [...disagreements].sort()) ||
    resolutions.some(
      (item) =>
        !isObj(item) ||
        !Number.isFinite(item.value) ||
        item.value < 0 ||
        item.value > 1 ||
        !isStr(item.rationale),
    ) ||
    !evaluateBenchmarkScores(input.score ?? input)
  )
    throw Error("adjudication must resolve exactly the observed disagreements");
  return true;
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
      result = prepare(manifest, f.output ?? "benchmarks/p0/results", f.seed);
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
        f.output ?? "benchmarks/p0/results/evaluators",
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
