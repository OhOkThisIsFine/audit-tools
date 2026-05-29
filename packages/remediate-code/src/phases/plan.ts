import { RemediationState } from "../state/store.js";
import { OrchestratorOptions } from "../orchestrator.js";
import {
  RemediationPlan,
  Finding,
  RemediationBlock,
  RemediationItemState,
} from "../state/types.js";
import { writeFile, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { AUDITOR_REPORT_MARKER } from "@audit-tools/shared";
import { existsSync, statSync } from "node:fs";
import { snapshotAffectedFileHashes } from "../utils/fileIntegrity.js";
import {
  readOptionalJsonFile,
  writeJsonFile,
  readJsonFile,
  formatValidationIssues,
  discoverProjectCommands,
  resolveContextBudget,
  estimateTokensFromBytes,
  type SessionConfig,
} from "@audit-tools/shared";
import { createFreshSessionProvider } from "../providers/index.js";
import {
  deduplicateCrossLensFindings,
  fixupBlocksAfterDedup,
} from "../dedup/crossLensDedup.js";
import {
  validateRemediationPlan,
  validateFinding,
} from "../validation/remediationState.js";
import { runCommand } from "../utils/commands.js";
import {
  createLaunchInputForTask,
  createRemediationWorkerTask,
} from "./workerTasks.js";

function enumerateTestFiles(root: string): string[] {
  if (!existsSync(join(root, "package.json"))) {
    return [];
  }

  // Try vitest first, then jest, and return the list of test file paths
  const vitestResult = runCommand(
    "npx",
    ["vitest", "--reporter=verbose", "--run", "--passWithNoTests", "list"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
    },
  );
  if (vitestResult.status === 0 && vitestResult.stdout) {
    const files = vitestResult.stdout
      .toString()
      .split(/\r?\n/)
      .map((l: string) => l.trim())
      .filter(
        (l: string) =>
          l.length > 0 &&
          !l.startsWith("✓") &&
          !l.startsWith("×") &&
          l.includes("."),
      );
    if (files.length > 0) return files;
  }

  const jestResult = runCommand(
    "npx",
    ["jest", "--listTests", "--no-coverage"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
    },
  );
  if (jestResult.status === 0 && jestResult.stdout) {
    const files = jestResult.stdout
      .toString()
      .split(/\r?\n/)
      .map((l: string) => l.trim())
      .filter((l: string) => l.length > 0);
    if (files.length > 0) return files;
  }

  return [];
}

function applyBlockLine(line: string, block: Partial<RemediationBlock>): void {
  if (line.startsWith("- Findings: ")) {
    const raw = line.slice("- Findings: ".length).trim();
    block.items = raw !== "none" ? raw.split(",").map((s) => s.trim()) : [];
  } else if (line.startsWith("- Depends on: ")) {
    const raw = line.slice("- Depends on: ".length).trim();
    block.dependencies =
      raw !== "none" ? raw.split(",").map((s) => s.trim()) : [];
  }
}

function applyFindingLine(
  line: string,
  finding: Partial<Finding>,
  inEvidence: boolean,
): boolean {
  if (line.startsWith("- Severity: ")) {
    finding.severity = line.slice("- Severity: ".length).trim() as any;
  } else if (line.startsWith("- Confidence: ")) {
    finding.confidence = line.slice("- Confidence: ".length).trim() as any;
  } else if (line.startsWith("- Lens: ")) {
    finding.lens = line.slice("- Lens: ".length).trim();
  } else if (line.startsWith("- Summary: ")) {
    finding.summary = line.slice("- Summary: ".length).trim();
  } else if (line.startsWith("- Files: ")) {
    const files = line
      .slice("- Files: ".length)
      .trim()
      .split(",")
      .map((s) => s.trim());
    finding.affected_files = files.map((f) => ({ path: f }));
  } else if (line.startsWith("- Evidence:")) {
    return true; // enter evidence mode
  } else if (inEvidence && line.startsWith("  - ")) {
    finding.evidence!.push(line.slice(4).trim());
  } else if (line.trim() === "") {
    return false; // exit evidence mode
  }
  return inEvidence;
}

export function parseAuditReport(content: string): {
  findings: Finding[];
  blocks: RemediationBlock[];
} {
  const lines = content.split(/\r?\n/);
  const findings: Finding[] = [];
  const blocks: RemediationBlock[] = [];

  let section: "none" | "blocks" | "findings" = "none";
  let currentBlock: Partial<RemediationBlock> | null = null;
  let currentFinding: Partial<Finding> | null = null;
  let inEvidence = false;

  for (const line of lines) {
    if (line.startsWith("## Work Blocks")) {
      section = "blocks";
      continue;
    } else if (line.startsWith("## Findings")) {
      section = "findings";
      if (currentBlock?.block_id) blocks.push(currentBlock as RemediationBlock);
      currentBlock = null;
      continue;
    } else if (line.startsWith("## Scope and Coverage")) {
      section = "none";
      if (currentFinding?.id) findings.push(currentFinding as Finding);
      currentFinding = null;
      continue;
    }

    if (section === "blocks") {
      if (line.startsWith("### ")) {
        if (currentBlock?.block_id)
          blocks.push(currentBlock as RemediationBlock);
        currentBlock = {
          block_id: line.slice(4).trim(),
          items: [],
          dependencies: [],
        };
      } else if (currentBlock) {
        applyBlockLine(line, currentBlock);
      }
    } else if (section === "findings") {
      if (line.startsWith("### ")) {
        if (currentFinding?.id) findings.push(currentFinding as Finding);
        const match = line.slice(4).match(/^([^\s—]+)\s*—\s*(.*)$/);
        if (match) {
          currentFinding = {
            id: match[1],
            title: match[2],
            category: "General",
            affected_files: [],
            evidence: [],
          };
          inEvidence = false;
        }
      } else if (currentFinding) {
        inEvidence = applyFindingLine(line, currentFinding, inEvidence);
      }
    }
  }

  if (
    currentBlock?.block_id &&
    !blocks.includes(currentBlock as RemediationBlock)
  ) {
    blocks.push(currentBlock as RemediationBlock);
  }
  if (currentFinding?.id && !findings.includes(currentFinding as Finding)) {
    findings.push(currentFinding as Finding);
  }

  for (const block of blocks) {
    block.parallel_safe =
      !block.dependencies || block.dependencies.length === 0;
  }

  return { findings, blocks };
}

export function isAuditorAuditReport(content: string): boolean {
  if (content.includes(AUDITOR_REPORT_MARKER)) return true;
  return (
    /^# Audit Report\s*$/im.test(content) &&
    /^## Work Blocks\s*$/im.test(content) &&
    /^## Findings\s*$/im.test(content)
  );
}

interface PlanPhaseDeps {
  enumerateTestFiles?: (root: string) => string[];
  runCommand?: typeof runCommand;
  now?: () => number;
}

function createBlockId(counter: number): string {
  return `B-${String(counter).padStart(3, "0")}`;
}

function assignFindingToBlock(
  finding: Finding,
  blockId: string,
  blocks: RemediationBlock[],
  fileToBlock: Map<string, string>,
): void {
  let block = blocks.find((candidate) => candidate.block_id === blockId);
  if (!block) {
    block = { block_id: blockId, items: [], parallel_safe: true };
    blocks.push(block);
  }
  block.items.push(finding.id);
  for (const file of finding.affected_files) {
    fileToBlock.set(file.path, blockId);
  }
}

function deriveBlocksFromTestGraph(
  findings: Finding[],
  testFiles: string[],
): { blocks: RemediationBlock[]; useful: boolean } {
  const blocks: RemediationBlock[] = [];
  const fileToBlock = new Map<string, string>();
  let blockCounter = 1;

  const sourceToTests = new Map<string, Set<string>>();
  for (const finding of findings) {
    for (const af of finding.affected_files) {
      if (!sourceToTests.has(af.path)) {
        const sourceParts = af.path.split(/[/\\]/).filter(Boolean);
        const covering = testFiles.filter((tf) => {
          const testParts = tf.split(/[/\\]/).filter(Boolean);
          return sourceParts.some((part) => testParts.includes(part));
        });
        sourceToTests.set(af.path, new Set(covering));
      }
    }
  }

  for (const finding of findings) {
    let assignedBlock: string | null = null;

    for (const af of finding.affected_files) {
      if (fileToBlock.has(af.path)) {
        assignedBlock = fileToBlock.get(af.path)!;
        break;
      }
      const testsA = sourceToTests.get(af.path) ?? new Set<string>();
      for (const [existingFile, existingBlock] of fileToBlock.entries()) {
        const testsB = sourceToTests.get(existingFile) ?? new Set<string>();
        const shared = [...testsA].filter((t) => testsB.has(t));
        if (shared.length > 0) {
          assignedBlock = existingBlock;
          break;
        }
      }
      if (assignedBlock) break;
    }

    if (!assignedBlock) {
      assignedBlock = createBlockId(blockCounter++);
    }
    assignFindingToBlock(finding, assignedBlock, blocks, fileToBlock);
  }

  return {
    blocks,
    useful: blocks.length < findings.length || findings.length <= 1,
  };
}

function collectFileCommits(
  findings: Finding[],
  root: string,
  commandRunner: typeof runCommand,
): Map<string, Set<string>> {
  const fileCommits = new Map<string, Set<string>>();
  for (const finding of findings) {
    for (const file of finding.affected_files) {
      if (fileCommits.has(file.path)) continue;
      try {
        const result = commandRunner(
          "git",
          ["log", "--format=%H", "--", file.path],
          { cwd: root, encoding: "utf8" },
        );
        fileCommits.set(
          file.path,
          result.status === 0 && result.stdout
            ? new Set(
                result.stdout
                  .toString()
                  .split("\n")
                  .map((s: string) => s.trim())
                  .filter((s: string) => s.length > 0),
              )
            : new Set(),
        );
      } catch {
        fileCommits.set(file.path, new Set());
      }
    }
  }
  return fileCommits;
}

function deriveBlocksFromGitCocommit(
  findings: Finding[],
  fileCommits: Map<string, Set<string>>,
): RemediationBlock[] {
  const blocks: RemediationBlock[] = [];
  const fileToBlock = new Map<string, string>();
  let blockCounter = 1;

  for (const finding of findings) {
    let assignedBlock: string | null = null;

    for (const file of finding.affected_files) {
      if (fileToBlock.has(file.path)) {
        assignedBlock = fileToBlock.get(file.path)!;
        break;
      }
      const commitsA = fileCommits.get(file.path) ?? new Set<string>();
      for (const [existingFile, existingBlock] of fileToBlock.entries()) {
        const commitsB = fileCommits.get(existingFile) ?? new Set<string>();
        let intersection = 0;
        for (const c of commitsA) if (commitsB.has(c)) intersection++;
        const union = commitsA.size + commitsB.size - intersection;
        if (union > 0 && intersection / union > 0.5) {
          assignedBlock = existingBlock;
          break;
        }
      }
      if (assignedBlock) break;
    }

    if (!assignedBlock) {
      assignedBlock = createBlockId(blockCounter++);
    }
    assignFindingToBlock(finding, assignedBlock, blocks, fileToBlock);
  }

  return blocks;
}

// Block-sizing constants specific to the remediator (the per-line ratio is the
// shared `ESTIMATED_TOKENS_PER_LINE`; the model-limit table and budget math now
// live in @audit-tools/shared).
export const ESTIMATED_BLOCK_BASE_TOKENS = 900;
export const ESTIMATED_FINDING_OVERHEAD_TOKENS = 600;

function resolveContextBudgetFromConfig(sessionConfig: SessionConfig | null): number {
  const quota = sessionConfig?.block_quota ?? {};
  return resolveContextBudget({
    contextTokens: quota.context_tokens ?? null,
    reservedOutputTokens: quota.reserved_output_tokens ?? null,
    hostModel: quota.host_model ?? null,
  });
}

// Phase 2: size by bytes from a stat (no full-file reads) rather than counting
// lines, and convert to tokens via the shared estimator.
function fileSizeBytes(filePath: string, root: string): number {
  const fullPath = isAbsolute(filePath) ? filePath : join(root, filePath);
  try {
    return statSync(fullPath).size;
  } catch {
    return 0;
  }
}

function groupFindingsByFileOverlap(findingIds: string[], findings: Finding[]): string[][] {
  const parent = new Map<string, string>(findingIds.map((id) => [id, id]));

  function find(id: string): string {
    let cur = id;
    while (parent.get(cur) !== cur) {
      const grandparent = parent.get(parent.get(cur)!)!;
      parent.set(cur, grandparent);
      cur = grandparent;
    }
    return cur;
  }

  const findingMap = new Map(findings.map((f) => [f.id, f]));
  const fileToIds = new Map<string, string[]>();

  for (const id of findingIds) {
    for (const af of findingMap.get(id)?.affected_files ?? []) {
      const list = fileToIds.get(af.path) ?? [];
      list.push(id);
      fileToIds.set(af.path, list);
    }
  }

  for (const ids of fileToIds.values()) {
    for (let i = 1; i < ids.length; i++) {
      const ra = find(ids[0]);
      const rb = find(ids[i]);
      if (ra !== rb) parent.set(ra, rb);
    }
  }

  const groups = new Map<string, string[]>();
  for (const id of findingIds) {
    const root = find(id);
    const g = groups.get(root) ?? [];
    g.push(id);
    groups.set(root, g);
  }
  return [...groups.values()];
}

function estimateGroupTokens(
  findingIds: string[],
  findings: Finding[],
  fileByteCounts: Map<string, number>,
): number {
  const uniqueFiles = new Set<string>();
  const findingMap = new Map(findings.map((f) => [f.id, f]));
  for (const id of findingIds) {
    for (const af of findingMap.get(id)?.affected_files ?? []) uniqueFiles.add(af.path);
  }
  const totalBytes = [...uniqueFiles].reduce((sum, p) => sum + (fileByteCounts.get(p) ?? 0), 0);
  return (
    ESTIMATED_BLOCK_BASE_TOKENS +
    estimateTokensFromBytes(totalBytes) +
    findingIds.length * ESTIMATED_FINDING_OVERHEAD_TOKENS
  );
}

function splitBlocksByContextBudget(
  blocks: RemediationBlock[],
  findings: Finding[],
  root: string,
  contextBudget: number,
): RemediationBlock[] {
  const allFiles = new Set<string>();
  const findingMap = new Map(findings.map((f) => [f.id, f]));
  for (const block of blocks) {
    for (const id of block.items) {
      for (const af of findingMap.get(id)?.affected_files ?? []) allFiles.add(af.path);
    }
  }

  const fileByteCounts = new Map<string, number>();
  for (const filePath of allFiles) {
    fileByteCounts.set(filePath, fileSizeBytes(filePath, root));
  }

  const result: RemediationBlock[] = [];

  for (const block of blocks) {
    const fileGroups = groupFindingsByFileOverlap(block.items, findings);

    const subBlocks: string[][] = [];
    let currentItems: string[] = [];
    let currentTokens = 0;

    for (const group of fileGroups) {
      const groupTokens = estimateGroupTokens(group, findings, fileByteCounts);
      if (currentItems.length > 0 && currentTokens + groupTokens > contextBudget) {
        subBlocks.push(currentItems);
        currentItems = group;
        currentTokens = groupTokens;
      } else {
        currentItems = [...currentItems, ...group];
        currentTokens += groupTokens;
      }
    }
    if (currentItems.length > 0) subBlocks.push(currentItems);

    if (subBlocks.length === 1) {
      result.push(block);
    } else {
      for (let i = 0; i < subBlocks.length; i++) {
        result.push({
          block_id: `${block.block_id}-${String(i + 1).padStart(2, "0")}`,
          items: subBlocks[i],
          parallel_safe: block.parallel_safe,
          dependencies: block.dependencies,
        });
      }
    }
  }

  return result;
}

function deriveFallbackBlocks(
  findings: Finding[],
  options: OrchestratorOptions,
  deps: PlanPhaseDeps,
): {
  blocks: RemediationBlock[];
  blockStrategy?: RemediationPlan["block_strategy"];
} {
  if (findings.length === 0) return { blocks: [] };

  const testFiles =
    deps.enumerateTestFiles?.(options.root) ?? enumerateTestFiles(options.root);
  if (testFiles.length > 0) {
    const testGraph = deriveBlocksFromTestGraph(findings, testFiles);
    if (testGraph.useful) {
      return { blocks: testGraph.blocks, blockStrategy: "test_graph" };
    }
  }

  const fileCommits = collectFileCommits(
    findings,
    options.root,
    deps.runCommand ?? runCommand,
  );
  const gitBlocks = deriveBlocksFromGitCocommit(findings, fileCommits);
  if (gitBlocks.length > 0) {
    return { blocks: gitBlocks, blockStrategy: "git_cocommit" };
  }

  return {
    blocks: findings.map((finding, index) => ({
      block_id: createBlockId(index + 1),
      items: [finding.id],
      parallel_safe: true,
    })),
    blockStrategy: "file_overlap",
  };
}

export async function runPlanPhase(
  state: RemediationState,
  options: OrchestratorOptions,
  deps: PlanPhaseDeps = {},
): Promise<RemediationState> {
  console.log("Running Plan Phase...");

  let findings: Finding[] = [];
  let blocks: RemediationBlock[] = [];

  if (
    options.input &&
    options.input.endsWith(".md") &&
    existsSync(options.input)
  ) {
    console.log(`Parsing input report: ${options.input}`);
    const content = await readFile(options.input, "utf8");
    if (isAuditorAuditReport(content)) {
      const parsed = parseAuditReport(content);
      findings = parsed.findings;
      blocks = parsed.blocks;
    } else {
      console.log("Input is not an auditor-shaped report; using LLM extraction.");
      const extracted = await extractFindingsWithProvider(
        content,
        state,
        options,
        deps,
      );
      findings = extracted.findings;
      blocks = extracted.blocks;
    }
  } else if (options.input && existsSync(options.input)) {
    console.log(`Extracting findings from input via LLM: ${options.input}`);
    const content = await readFile(options.input, "utf8");
    const extracted = await extractFindingsWithProvider(
      content,
      state,
      options,
      deps,
    );
    findings = extracted.findings;
    blocks = extracted.blocks;
  } else {
    console.log(
      "No input provided or file does not exist. Halting Plan phase.",
    );
    throw new Error("Missing valid input for Plan phase.");
  }

  // Cross-lens dedup: merge findings that different audit lenses flagged independently
  const dedup = deduplicateCrossLensFindings(findings);
  findings = dedup.findings;
  blocks = fixupBlocksAfterDedup(blocks, dedup.mergeMap);

  // Fallback blocks computation if none provided
  let blockStrategy: RemediationPlan["block_strategy"] | undefined;
  if (blocks.length === 0 && findings.length > 0) {
    const fallback = deriveFallbackBlocks(findings, options, deps);
    blocks = fallback.blocks;
    blockStrategy = fallback.blockStrategy;
  }

  // Split blocks that would exceed the implementation agent's context budget,
  // keeping file-overlapping findings together (logical cohesion first).
  const sessionConfig = await readOptionalJsonFile<SessionConfig>(
    join(options.root, "session-config.json"),
  );
  const contextBudget = resolveContextBudgetFromConfig(sessionConfig ?? null);
  blocks = splitBlocksByContextBudget(blocks, findings, options.root, contextBudget);

  // Project command discovery (shared; now also covers Go and Python). The
  // RemediationPlan stores commands as strings, so argv arrays are joined.
  const commands = discoverProjectCommands(options.root);
  const testCommand = commands.test ? commands.test.join(" ") : undefined;
  const e2eCommand = commands.e2e ? commands.e2e.join(" ") : undefined;
  let projectType = "unknown";
  if (existsSync(join(options.root, "package.json"))) {
    projectType = "typescript-node";
  } else if (existsSync(join(options.root, "go.mod"))) {
    projectType = "go";
  } else if (
    existsSync(join(options.root, "pyproject.toml")) ||
    existsSync(join(options.root, "pytest.ini"))
  ) {
    projectType = "python";
  }

  snapshotAffectedFileHashes(options.root, findings);

  const plan: RemediationPlan = {
    plan_id: "PLAN-" + (deps.now?.() ?? Date.now()),
    findings,
    blocks,
    project_type: projectType,
    test_command: testCommand,
    ...(e2eCommand ? { e2e_command: e2eCommand } : {}),
    candidate_closing_actions: ["none"],
    ...(blockStrategy ? { block_strategy: blockStrategy } : {}),
  };

  const items: Record<string, RemediationItemState> = {};
  for (const finding of findings) {
    const block = blocks.find((b) => b.items.includes(finding.id));
    items[finding.id] = {
      finding_id: finding.id,
      status: "pending",
      block_id: block ? block.block_id : "UNKNOWN",
    };
  }

  const planIssues = validateRemediationPlan(plan);
  if (planIssues.length > 0) {
    console.error(
      `Plan validation issues:\n${formatValidationIssues(planIssues)}`,
    );
    const errors = planIssues.filter((i) => i.severity === "error");
    if (errors.length > 0) {
      throw new Error(
        `Plan phase produced an invalid plan:\n${formatValidationIssues(errors)}`,
      );
    }
  }

  // Emit remediation_plan.json
  await writeJsonFile(
    join(options.artifactsDir, "remediation_plan.json"),
    plan,
  );

  return { ...state, status: "planning", plan, items };
}

async function extractFindingsWithProvider(
  content: string,
  _state: RemediationState,
  options: OrchestratorOptions,
  deps: PlanPhaseDeps,
): Promise<{ findings: Finding[]; blocks: RemediationBlock[] }> {
  const sessionConfig =
    (await readOptionalJsonFile<SessionConfig>(
      join(options.root, "session-config.json"),
    )) || {};
  const provider = createFreshSessionProvider(undefined, sessionConfig);
  const workerTimeoutMs = sessionConfig.timeout_ms;

  const taskPath = join(options.artifactsDir, `task_plan.json`);
  const resultPath = join(options.artifactsDir, `result_plan.json`);

  const promptPath = join(options.artifactsDir, `prompt_plan.md`);
  const promptContent = `
You are the Remediation Assistant. Your task is to extract findings and work blocks from the provided document.
Produce a JSON output matching the remediation_plan.schema.json structure (specifically the findings and blocks arrays).

Document Content:
${content}

Your task JSON is at: ${taskPath}
Write your result JSON to exactly this path: ${resultPath}
Use the Write tool to create or overwrite that file.
Do not write to any other path.
    `.trim();
  await writeFile(promptPath, promptContent, "utf8");
  const stdoutPath = join(options.artifactsDir, `stdout_plan.txt`);
  const stderrPath = join(options.artifactsDir, `stderr_plan.txt`);

  const task = createRemediationWorkerTask({
    runId: "PLAN-" + (deps.now?.() ?? Date.now()),
    options,
    obligationId: "extract-plan",
    preferredExecutor: provider.name,
    resultPath,
    timeoutMs: workerTimeoutMs,
  });
  await writeJsonFile(taskPath, task);

  try {
    await provider.launch(
      createLaunchInputForTask(options, task, {
        promptPath,
        taskPath,
        stdoutPath,
        stderrPath,
      }),
    );
    const extracted = await readJsonFile<{
      findings: Finding[];
      blocks: RemediationBlock[];
    }>(resultPath);
    return {
      findings: extracted.findings || [],
      blocks: extracted.blocks || [],
    };
  } catch (e) {
    console.error("Failed to extract plan via LLM:", e);
    throw new Error("Plan extraction failed.");
  }
}
