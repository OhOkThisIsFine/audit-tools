# Prompt Refinement and Workflow Prompt Inventory — 2026-09-13
<!-- review-routing: backlog-bugs -->

This document establishes the prompt refinement analysis and comprehensive plain-language inventory of all prompts in `audit-tools`. It serves as the durable evidence and design basis for the backlog defect in `docs/backlog/open-bugs.md` regarding prompt leakage, unnecessary host complexity, and conflation of tooling enforcement with prompt pleading.

---

## Part 1: Detailed Critique and Actionable Refinements for `audit-code.prompt.md`

### 1. The Core Issues Identified

A critical review of `skills/audit-code/audit-code.prompt.md` (and its counterpart `skills/remediate-code/remediate-code.prompt.md`) reveals several design defects where internal implementation concerns, unnecessary commentary, convoluted instructions, and unenforced tool invariants are pushed onto the host LLM orchestrator.

#### Issue A: Internal Development Instructions Leaked to Third-Party Auditees
- **Current Prompt Text:**
  ```markdown
  When developing audit-tools itself, use `node audit-code.mjs` from the repository root.
  ```
- **Critique:** When a user or host agent runs `/audit-code` on their own codebase (e.g. `express`, `react`, or an internal service), telling the LLM how to develop `audit-tools` is completely irrelevant, confusing, and pollutes prompt context.
- **Actionable Fix:** This instruction must only be conditionally rendered when `process.cwd()` is determined to be the `audit-tools` repository root (matching `package.json` name `audit-tools` and git root). When auditing external codebases, this line must not appear.

#### Issue B: Meta-Commentary About Markdown Code Generation
- **Current Prompt Text:**
  ```markdown
  This target-directory rule is one shared fragment, rendered into this body and
  the `remediate-code` loader body in the same words; both skills point here
  instead of restating it.
  ```
- **Critique:** This is an internal developer design note explaining DRY (Don't Repeat Yourself) fragment sharing in the build script. An LLM executing an audit has no reason to know or care how the prompt was assembled.
- **Actionable Fix:** Delete this meta-commentary entirely from both loader bodies.

#### Issue C: Unnecessarily Convoluted Execution Directives
- **Current Prompt Text:**
  ```markdown
  Immediately after this first response, before following its workload prompt or
  calling `next-step` again, perform a host-side structural-capability preflight.
  ```
- **Critique:** The phrasing is overly pedantic and legalese-heavy. It creates friction and comprehension overhead for the host model.
- **Actionable Fix:** Simplify to direct, clear imperative language:
  ```markdown
  Perform a host-side structural-capability preflight.
  ```

#### Issue D: Begging the LLM Not to Send Prohibited Fields (Conflating Tooling Enforcement with Prompting)
- **Current Prompt Text:**
  ```markdown
  This check belongs to the host; do not add provider, routing, model, or machine-capability fields to audit-tools.
  ...
  Do not send provider, model, quota, context-window, routing, or launch configuration to audit-tools.
  ...
  Keep the conversation-first flow and loader contract; do not add provider, routing, model, or machine-capability fields to audit-tools.
  ```
- **Critique:** The prompt repeatedly pleads with the orchestrator not to pass configuration fields. If `audit-tools` CLI does not accept or support provider/model arguments, the CLI argument parser (`guardArgv` or Zod schema) should mechanically reject them with exit code 1 or strip them. Pleading three separate times in one prompt is an admission of missing tooling enforcement.
- **Actionable Fix:** Enforce argument rejection in the CLI parser (`guardArgv`). In the prompt, state the CLI contract once plainly without repetitive negative begging.

#### Issue E: Vague Capability Terminology and the "Phantom Server" Trap
- **Current Prompt Text:**
  ```markdown
  Immediately after this first response, before following its workload prompt or
  calling `next-step` again, perform a host-side structural-capability preflight.
  Confirm that working tools can inspect the structural graph/relationships and
  source structure required for the audit. An installed tool name or an unavailable
  server is not evidence of capability. This check belongs to the host; do not add
  provider, routing, model, or machine-capability fields to audit-tools.

  If that capability is unavailable, state the concrete limitation and explicitly
  say the audit is degraded/non-comprehensive.
  ```
- **Critique:** What does the workflow actually require?
  - The workflow's frontmatter explicitly specifies `allowed-tools: [Read, Bash, Glob, Grep, Agent]`. `audit-tools` has a core architectural invariant: it is completely **provider-neutral and host-agnostic**. It has no dependency on any specific vendor, host IDE, or third-party MCP server (such as `codebase-memory-mcp`). It already builds its own deterministic call/flow graphs internally using Tree-sitter and AST extractors.
  - The "structural-capability preflight" was added (commit `09b0f4e4`) because an LLM restricted to flat keyword grep missed cross-file call-chain and architectural defects during benchmarks. But because `audit-tools` refuses to bake in provider or MCP clients, the requirement was pushed into prompt prose as an ambiguous mandate mentioning "an unavailable server is not evidence of capability".
  - To any host model running outside a specific local test rig, this is baffling: What server? What specific capability?
  - In reality, the engine only consumes this in `src/audit/reporting/synthesis.ts`: if the host writes a reflection with `task_id: "audit-capability-preflight"` and `severity: "high" | "critical"` to `agent-feedback.jsonl`, `synthesis.ts` renders a `## Audit Limitations` section in the final report.
- **Actionable Fix:** Do NOT invent or hardcode specific third-party tool names (like `codebase-memory MCP`). Instead, describe the functional capability directly in host-neutral terms: "Confirm whether you have tools to trace symbol definitions, call hierarchies, and cross-file relationships (e.g. language server, code intelligence, or symbol search). If you are limited to flat text search (grep/find), treat the audit as degraded and log an `audit-capability-preflight` reflection to `agent-feedback.jsonl`."


#### Issue F: Asking the LLM to Selectively Read JSON Payloads
- **Current Prompt Text:**
  ```markdown
  Read the returned JSON only far enough to find `prompt_path`, then read and
  follow only that prompt. Do not inspect workload, result, schema, or state files
  unless the current prompt directs you to them.
  ```
- **Critique:** Once a command returns stdout, the entire JSON payload is already ingested into the LLM's context window. An LLM cannot choose to "read only far enough" in a completed tool call. Telling the LLM not to look at JSON that is already in context wastes tokens and causes hesitation.
- **Actionable Fix:** Tooling should output only the concise status and `prompt_path` to stdout (or write heavy state directly to disk), rather than dumping extensive JSON to stdout and instructing the model to avert its eyes.

#### Issue G: Internal Parser Failure Warnings Leaked to Prompt
- **Current Prompt Text:**
  ```markdown
  Append each reflection as one JSON object per line to the run's agent-reflection
  file, whose path the step contract supplies as `artifact_paths.agent_feedback` —
  never reproduce that filename from memory, because a wrongly named file is read as
  "no reflections" rather than reported.
  ```
- **Critique:** Telling the LLM why the backend parser fails on typos ("because a wrongly named file is read as 'no reflections' rather than reported") exposes backend implementation quirks instead of simply providing the exact instruction.
- **Actionable Fix:** State the destination clearly: "Append each reflection as a JSON line to the file path given in `artifact_paths.agent_feedback`."

---

### 2. General Prompt Refinement Principles for `audit-tools`

1. **Tooling Enforces, Prompts Instruct**: Invariants regarding valid arguments, JSON structures, file formats, and allowed fields must be enforced by Zod schemas, CLI argument parsers, and gate scripts. Never rely on pleading prose in prompts to enforce system boundaries.
2. **Context Separation (Auditor vs. Auditee)**: Prompts running in a target repository must never leak internal development conventions of `audit-tools` unless the target repository is `audit-tools` itself.
3. **Concise Imperative Phrasing**: Eliminate metadiscussion, historical context, fragment sharing commentary, and legalese. State what the agent must do, what inputs to read, and what outputs to write.
4. **Concrete Naming**: Avoid abstract pronouns ("that capability", "those fields"). Name the exact tool, file path, or schema key.

---

## Part 2: Comprehensive Plain-Language Inventory of Workflow Prompts

Below is the complete inventory of all prompts in the `audit-tools` codebase, translated into plain, natural language so their operational purpose and instructions can be evaluated directly.

### 1. Host Loader: `/audit-code` Entrypoint Prompt
- **File**: `skills/audit-code/audit-code.prompt.md`
- **Role**: Host conversational orchestrator bootstrap.
- **Plain Language Instructions**:
  > You are the orchestrator for this audit conversation.
  > 
  > 1. Initialize audit tools by running `audit-code ensure --quiet`.
  > 2. Respect target paths: run commands from within the target repository; pass `--root <path>` only if operating from outside.
  > 3. Call `audit-code next-step` to fetch the first task.
  > 4. Perform a structural-capability preflight check. Confirm whether you have tools to trace symbol definitions, call hierarchies, and cross-file relationships (rather than flat text search alone). If only flat keyword searching is available, warn the user that the audit will be degraded/shallow rather than comprehensive and log an `audit-capability-preflight` reflection.
  > 5. Read the prompt file indicated by `prompt_path` in the step output and follow its directions.
  > 6. When the prompt asks for semantic reviews, dispatch them to subagents if your platform supports them.
  > 7. If any tooling limitations occurred, append reflection records to the path in `artifact_paths.agent_feedback`.
  > 8. When a step completes, invoke `audit-code next-step` again to receive the next step, repeating until the workflow signals completion.

### 2. Host Loader: `/remediate-code` Entrypoint Prompt
- **File**: `skills/remediate-code/remediate-code.prompt.md`
- **Role**: Host conversational orchestrator remediation bootstrap.
- **Plain Language Instructions**:
  > You are the orchestrator for code remediation.
  > 
  > 1. Initialize tools by running `remediate-code ensure --quiet`.
  > 2. Run inside the target repository or specify `--root <path>`. Pass input findings via `--input <path>` or feedback via `--guidance-file <path>`.
  > 3. Call `remediate-code next-step` to retrieve the first remediation action.
  > 4. Read and follow the instructions in the prompt file located at `prompt_path`.
  > 5. Dispatch code modification and testing tasks to subagents or execute them directly, collecting git commit and test verification evidence.
  > 6. Write results to the designated output artifacts for backend validation.
  > 7. Loop by calling `remediate-code next-step` until the remediation process signals completion.

### 3. Audit Step: Intent & Scope Confirmation
- **Step**: `confirm_intent`
- **File**: `src/audit/cli/confirmIntentStep.ts`
- **Role**: Operator alignment before starting audit planning.
- **Plain Language Instructions**:
  > The automated intake scan has discovered the repository's files, structure, and proposed audit lenses.
  > 
  > 1. Review the proposed audit scope, including discovered top-level directories, scope rules, and excluded files.
  > 2. If the user gave free-form instructions that cannot be automatically classified into audit lenses or scope filters, resolve those blocking clauses now.
  > 3. Review the proposed audit lenses (which lenses are mandatory, which are recommended to include, and which to exclude).
  > 4. Check the proposed design-review depth (shallow with a single reviewer, or deep with multiple diverse perspective reviewers).
  > 5. Present this scope and lens summary to the operator in a single interaction and wait for confirmation.
  > 6. Once confirmed, write the resulting choices to `intent_checkpoint.json` and proceed.

### 4. Audit Step: Intent Equivalence Judgment
- **Step**: `intent_equivalence`
- **File**: `src/audit/cli/nextStepCommand.ts`
- **Role**: Subagent judge determining whether intent prose wording changes invalidate existing planning.
- **Plain Language Instructions**:
  > The prose description in the intent checkpoint was modified after planning artifacts were already generated, but structured fields did not change.
  > 
  > Compare the prior prose against the new prose:
  > - Judge strictly: If there is ANY change in audit scope, goals, constraints, or emphasis, declare `"changed"`.
  > - Only if the new prose is a pure stylistic rephrasing, formatting adjustment, or word-order change with identical meaning, declare `"equivalent"`.
  > 
  > Write your verdict (`"equivalent"` or `"changed"`) to the designated verdict JSON file and run the continue command.

### 5. Audit Step: External Analyzer Consent
- **Step**: `analyzer_consent`
- **File**: `src/audit/cli/prompts.ts`
- **Role**: Operator permission prompt for external analyzers.
- **Plain Language Instructions**:
  > This codebase can be analyzed by external tools that have security or execution implications (such as running arbitrary config or making network calls).
  > 
  > 1. Present each candidate external analyzer and its security implications to the operator.
  > 2. Do not decide for the operator. Record whether they grant permission for this run or decline.
  > 3. Write the decisions to the designated JSON file and run the continue command.

### 6. Audit Step: Optional Analyzer Installation
- **Step**: `analyzer_install`
- **File**: `src/audit/cli/prompts.ts`
- **Role**: Operator permission prompt for package installations.
- **Plain Language Instructions**:
  > Optional language analyzers are available that can enrich the codebase knowledge graph, but they require installing packages.
  > 
  > 1. For each candidate analyzer, present the installation options to the operator: ephemeral install (for this run only), permanent install (saved in project dependencies), or skip.
  > 2. Save the choices in the designated decisions JSON file and continue.

### 7. Audit Step: Critical Flow Fallback / Verification
- **Step**: `critical_flow_fallback`
- **File**: `src/audit/reporting/criticalFlowFallbackPrompt.ts`
- **Role**: Validating business-critical end-to-end user paths.
- **Plain Language Instructions**:
  > Review the business-critical user and system flows discovered in the codebase (e.g. authentication, payment, data ingestion, core request processing).
  > 
  > 1. Examine the deterministic flow graph, entry points, and sink operations.
  > 2. Determine whether the identified flows accurately represent the system's core capabilities.
  > 3. Confirm valid flows, correct misidentified or incomplete paths, and add any critical business flows that automated intake missed.
  > 4. Record the confirmed flow specifications in the designated artifact file.

### 8. Audit Step: Architecture Charter Extraction
- **Step**: `charter_extraction`
- **File**: `src/audit/cli/charterExtractionPrompt.ts`
- **Role**: Identifying architecture boundaries and module responsibilities.
- **Plain Language Instructions**:
  > Analyze the specified subsystem or module to derive its architectural charter.
  > 
  > 1. Determine the module's core responsibilities and invariants.
  > 2. Identify allowed and disallowed dependencies (which layers it may call and which it must never call).
  > 3. List the public API entry points, key types, and data owners.
  > 4. Record the architectural charter in the structured charter register format.

### 9. Audit Step: Architecture Charter Delta Review
- **Step**: `charter_delta`
- **File**: `src/audit/cli/charterDeltaPrompt.ts`
- **Role**: Checking changes against architectural boundaries.
- **Plain Language Instructions**:
  > Review recent code modifications against the established architectural charter for this component.
  > 
  > 1. Check whether any changes violate boundary constraints, introduce forbidden dependencies, or leak internal responsibilities.
  > 2. Identify any architectural drift or erosion.
  > 3. Record whether the changes conform to the charter or represent a boundary breach.

### 10. Audit Step: Architecture Charter Clarification
- **Step**: `charter_clarification`
- **File**: `src/audit/cli/charterClarificationPrompt.ts`
- **Role**: Clarifying ambiguous component boundaries.
- **Plain Language Instructions**:
  > The architectural charter for this component contains ambiguous boundaries or unresolved relationships with adjacent modules.
  > 
  > 1. Inspect the boundary call sites and shared data structures.
  > 2. Clarify which component owns the disputed responsibilities and data invariants.
  > 3. Provide explicit boundary definitions to update the charter register.

### 11. Audit Step: Conceptual Design Review
- **Step**: `design_review`
- **File**: `src/audit/orchestrator/designReviewPrompt.ts`
- **Role**: Independent multi-perspective architectural review.
- **Plain Language Instructions**:
  > You are evaluating this system's conceptual design from a specific evaluation perspective (e.g., fault tolerance, operational simplicity, security boundary posture, or API ergonomics).
  > 
  > 1. Review the system architecture, documentation, and key contracts through your assigned perspective.
  > 2. Identify systemic architectural weaknesses, fragile assumptions, scalability bottlenecks, or missing invariants.
  > 3. Formulate concrete, evidence-backed findings citing specific components and failure scenarios.
  > 4. Write your perspective evaluation into the designated review artifact.

### 12. Audit Step: Second-Order Adversarial Verification
- **Step**: `second_order_adversary`
- **File**: `src/audit/systemic/secondOrderAdversaryPrompt.ts`
- **Role**: Adversarial critique of proposed findings.
- **Plain Language Instructions**:
  > You are an adversarial skeptic reviewing findings produced by earlier audit passes.
  > 
  > 1. Examine each claimed finding, bug, or design vulnerability.
  > 2. Challenge the finding: Is it a false positive? Is the behavior intended by design? Is there existing mitigating logic elsewhere in the codebase that the auditor missed?
  > 3. Verify whether the claimed failure state can actually occur under real operating conditions.
  > 4. Output a disposition for each finding: confirm with additional proof, refute with counter-evidence, or narrow its scope.

### 13. Audit Step: Unit Semantic Review / Auditor
- **Step**: `semantic_review`
- **File**: `src/audit/cli/semanticReviewStep.ts`
- **Role**: In-depth code audit of specific files or units against selected lenses.
- **Plain Language Instructions**:
  > Audit the assigned source files against the specified audit lenses (e.g., resource leaks, race conditions, error handling, contract breaches).
  > 
  > 1. Inspect the source code, trace caller and callee paths, and examine edge cases.
  > 2. Validate potential issues against project contracts and tests.
  > 3. For every confirmed issue, document the exact failure mechanism, impact, and reproduction conditions.
  > 4. Output structured finding records with severity, confidence, and affected symbols into the assigned lane result file.

### 14. Audit Step: Synthesis Narrative & Executive Report
- **Step**: `synthesis_narrative`
- **File**: `src/audit/reporting/synthesisNarrativePrompt.ts`
- **Role**: Compiling raw findings into a cohesive audit report.
- **Plain Language Instructions**:
  > Synthesize all validated findings, conceptual reviews, and adversarial verdicts into the final audit report.
  > 
  > 1. Group individual findings by systemic defect patterns and root causes rather than simple file lists.
  > 2. Highlight critical security, reliability, and architectural risks.
  > 3. Provide an executive summary of the codebase health, test coverage fidelity, and maintainability.
  > 4. Deliver concrete, prioritized remediation recommendations.
  > 5. Render the final report into `audit-report.md`.

### 15. Audit Step: Host Handoff / Dispatch Workload
- **Step**: `dispatch_review`
- **File**: `src/audit/cli/dispatch/hostHandoff.ts`
- **Role**: Instructing the host how to dispatch parallel subagent tasks.
- **Plain Language Instructions**:
  > The audit workflow has prepared a batch of independent review work items.
  > 
  > 1. For each item in the workload, assign a subagent or worker lane with the specified task prompt file.
  > 2. Ensure each worker writes its output to its assigned result file path.
  > 3. Do not modify or leak execution environment parameters.
  > 4. Once all worker tasks have written their results, call `audit-code next-step` to ingest the batch.

### 16. Remediate Step: Clarify Remediation Target
- **Step**: `clarify_remediation_target`
- **File**: `src/remediate/steps/prompts.ts`
- **Role**: Establishing exact scope and goals for a remediation run.
- **Plain Language Instructions**:
  > Clarify the scope of findings or user feedback to be remediated.
  > 
  > 1. Review the input findings or guidance file provided by the operator.
  > 2. Determine which issues are in scope, which depend on others, and whether any requirements are ambiguous.
  > 3. Resolve any ambiguities with the operator before writing code.
  > 4. Save the confirmed remediation scope into the run state.

### 17. Remediate Step: Remediation Plan Proposal
- **Step**: `plan_proposal`
- **File**: `src/remediate/steps/prompts.ts`
- **Role**: Developing a safe, step-by-step remediation plan.
- **Plain Language Instructions**:
  > Formulate an execution plan to fix the confirmed issues without regressing existing behavior.
  > 
  > 1. Define atomic fix steps, ordering fixes so foundational contracts are updated before dependent code.
  > 2. Specify the required red-to-green test proof for every fix.
  > 3. Identify risk areas, potential side effects, and rollback considerations.
  > 4. Present the plan to the operator or record it for automated step execution.

### 18. Remediate Step: Contract Derivation & Patch Construction
- **Step**: `contract_pipeline`
- **File**: `src/remediate/steps/contractPipelinePrompts.ts`
- **Role**: Generating targeted code patches and contract updates.
- **Plain Language Instructions**:
  > Implement the approved code fix in an isolated worktree.
  > 
  > 1. Write or update automated tests that fail before the change and pass after (proving the defect was resolved).
  > 2. Apply the minimal necessary source code edits to fix the root cause.
  > 3. Ensure no unrelated stylistic changes or scope creep are introduced.
  > 4. Verify that lint, typecheck, and the test suite pass cleanly.

### 19. Remediate Step: Verification Gate
- **Step**: none — no `verify_remediation` prompt exists (corrected 2026-09-18, owner review of row 19).
- **What verifies instead**: the tool itself. At ingest, `parseResult`, `corroborateHostResult` and `rerunRequiredTests` (`src/remediate/steps/dispatch/hostHandoff.ts`) check each result file, its git history and its required tests. The repository-wide build/typecheck/test gate (`toolOwnedFinalGateCommands`, `src/remediate/steps/gateCommands.ts`) runs ONLY when the target is the audit-tools repository; elsewhere it records `scoped_out`, and the close phase's `plan.test_command` is the only whole-repository suite.
- **Host-visible text**: only the `final_gate_red` pause (`emitFinalGateRedStep`, `src/remediate/steps/nextStep.ts`), which the owner reviewed as row 19.

### 20. Remediate Step: Host Work Item Dispatch
- **Step**: `host_handoff`
- **File**: `src/remediate/steps/dispatch/hostHandoff.ts`
- **Role**: Dispatching remediation tasks to worker subagents.
- **Plain Language Instructions**:
  > Dispatch the pending remediation items to worker subagents.
  > 
  > 1. Launch worker subagents for each item with its dedicated prompt and isolated worktree.
  > 2. Collect commit hashes, changed file lists, and test run output from each worker.
  > 3. Once all workers report completion, advance the state machine with `remediate-code next-step`.

---

## Part 3: Prompt Review Queue & Finalized Specifications

### Review Status Tracker

| # | Prompt / Step | Source File | Status | Notes |
|---|---------------|-------------|--------|-------|
| 1 | `/audit-code` Loader | `skills/audit-code/audit-code.prompt.md` | **APPROVED** | Finalized below (CWD-based root, preflight step 3, condensed loop). |
| 2 | `/remediate-code` Loader | `skills/remediate-code/remediate-code.prompt.md` | **APPROVED** | Finalized below (CWD-based root, guidance under `.audit-tools/`, condensed loop). |
| 3 | `confirm_intent` | `src/audit/cli/confirmIntentStep.ts` | **APPROVED** | Finalized below (mandatory lenses first, perspective selection, adversary/minimalist rephrased, simplified rules/clauses). |
| 4 | `intent_equivalence` | `src/audit/cli/nextStepCommand.ts` | **APPROVED** | Finalized below (natural section headers, rationale field in verdict contract). |
| 5 | `analyzer_consent` | `src/audit/cli/prompts.ts` | **APPROVED** | Finalized below (ephemeral-only consent, explicit question directive, concrete security risks, strict value enum). |
| 6 | `analyzer_install` | `src/audit/cli/prompts.ts` | **APPROVED** | Finalized below (explicit operator prompt directive, fenced JSON block, strict enum values). |
| 7 | `critical_flow_fallback` | `src/audit/reporting/criticalFlowFallbackPrompt.ts` | **APPROVED** | Finalized below (succinct path/entrypoint definitions, suggested canonical lens examples for concerns, explicit empty `{ "flows": [] }` format). |
| 8 | `charter_extraction` | `src/audit/cli/charterExtractionPrompt.ts` | **APPROVED (owner, 2026-09-17)** | Owner reviewed the LIVE rendered text and took the rewrite: one schema-valid provenance kind in the example (the alternation stays a field rule), a domain-neutral worked example marked as an unrelated codebase, the packet-scope rule stated once as a prohibition, the grounding rule stated once, the role statement folded into the opening paragraph. The pinned test now asserts the example parses and satisfies `CharterSubmissionSchema`; it previously REQUIRED the invalid form. **Second owner pass, same day:** the suggested-scaffold section is gone (it pinned filenames that may not exist); the submission no longer states its own `kind` (the lane writes at a lane-bound path, so the tool stamps the kind at merge — the field only ever let the lane check itself); references cite a SYMBOL or a file, never a line number; `parseCitationRef` learned the `#<anchor>` suffix the prompt teaches, which its own checker had been refusing as `unknown_path`. The quote requirement lands at BOTH boundaries on the owner's decision: `charterLaneSchema` refuses a quoteless ref that names a SPAN (unverifiable by construction), and `checkLaneCitations` refuses a quoteless citation of a file the packet EXCERPTED (the case needing the manifest the gate cannot see). `recover-submission` gained the mis-route guard the retired `kind` field used to be. Every half red-green validated by inversion; the merge stamp itself was UNWITNESSED before this pass — inverting it to a constant kind passed 5448 tests. |
| 9 | `charter_comparison` (was `charter_delta`) | `src/audit/cli/charterComparisonPrompt.ts` | **APPROVED (owner, 2026-09-17)** | Owner reviewed the LIVE rendered text and took the rewrite. Six defects, four of them the obedience-is-insufficient class: the worked example was not a valid submission (the whole verdict alternation sat in the field VALUE, plus three `<...>` placeholders); a `presence` difference filed as the prompt instructed was MISROUTED, because the tool names the silent channel by its ABSENCE from `accounts` — an account for every channel sent doc rot to `clarification` instead of `remediator`; the same gap was inexpressible on a two-channel correspondence; the added-correspondence evidence rule was not the two-different-sides test the tool applies; `provenance[].kind` was never stated; `widen` never said that a member left out is a member dropped. Owner chose to RELAX the account minimum rather than state the three-channel limit — `DifferenceInputSchema` now needs two accounts on every dimension but `presence`, and `assembleComparison` refuses a `presence` difference that does not leave exactly one channel silent. Owner also chose to PIN the example: `tests/shared/prompt-renders-its-contract.test.ts` parses the comparison prompt's fenced example against `CharterComparisonSubmissionSchema` and holds the provenance enum exhaustive. All three halves red-green validated by inversion. |
| 9b | `charter_fidelity` (new) | `src/audit/cli/charterFidelityPrompt.ts` | **APPROVED (owner, 2026-09-17)** | Owner approved the rewrite from the measured review rather than the rendered text, to land it beside prompt 8. It previously carried a label the owner never gave (shipped in `80793d83`; see row 9). Six defects, four of them the obedience-is-insufficient class the same layer showed twice already: the worked example wrote whole alternations into field VALUES (`"verdict": "supported \| interpretation \| unverifiable"`) and filled two more fields with `<...>` placeholders, so it did not parse; it also paired `over_read_side` with a `supported`-shaped verdict, which `CharterFidelitySubmissionSchema` refuses outright. The example is now a valid submission and `tests/shared/prompt-renders-its-contract.test.ts` parses it against the real schema; red-green validated by restoring the old example, which reds the pin with two `invalid_enum_value` issues. Content: the fidelity adversary lane (spec step 4) — per difference, `supported` / `interpretation` (odd side named) / `unverifiable`, judged from tool-materialized source slices. |
| 10 | `charter_clarification` | `src/audit/cli/charterClarificationPrompt.ts` | **APPROVED (owner, 2026-09-17)** | Owner reviewed the LIVE rendered text and took the rewrite. Seven defects. The obedience-is-insufficient class again (fourth file): the worked example taught `{"governs": "stated \| structural \| revealed"}`, which the strict enum refuses — the example now answers the REAL queue, and the three answer SHAPES are stated in words (the first is an object, the other two are bare strings; the correct object form appeared in the prompt zero times before). The severe defect was SILENT LOSS: `request_id` was a flat `z.string()` with no membership check, so a mistyped or placeholder id parsed, landed in a map nothing reads, and every question the run DID ask fell to the `leave_open` default while the register recorded a success. Owner chose to REFUSE the whole submission, at the first boundary holding both halves (`refuseUnaskedRequestIds` in `charterClarificationExecutor` — the gate never sees the asked queue); the grammar keeps the SHAPE half (`.min(1)`). Owner also took both render fixes: EVERY citation of every account renders (only `provenance[0]` did, so a reader decided which account governs from a partial account), and a question with no recorded `split` no longer prints its relation twice. Two further fixes: the write-only `ceiling` parameter is gone, and the prompt-contract registry's false `DRIVER_GAP` row ("no worker output contract" — untrue; this prompt's host writes a `ClarificationAnswersSubmission`) became a `derived` row, which is why nothing had reconciled the invalid example. All four halves red-green validated by inversion. |
| 11 | `design_review` | `src/audit/orchestrator/designReviewPrompt.ts` | **APPROVED (owner, 2026-09-17)** | Owner reviewed the LIVE rendered text of all four doors and took the rewrite. Five defects, and the obedience-is-insufficient class for the fifth file — this time in ONE example shared by four prompts. (1) The example was not a valid submission on ANY door: it wrote both alternations into the field VALUES (`"severity": "one of: critical, high, medium, low, info"`) and cited `relevant/file.ts`, which is in no repository, so a copied citation grounded as `ungrounded`. The two consumers then failed DIFFERENTLY — the judge door refused it (`ConceptualJudgeSubmissionSchema` is `.strict()`), while the contract and shallow-conceptual doors accepted it and stamped the finding `grounded` with a severity `SEVERITY_RANK` cannot rank: not dropped, kept, ranked below everything, and reported as a success. Owner chose to PARSE EACH FINDING at ingestion and quarantine a submission carrying one that fails, with a named reason — `consumeArraySubmission` (loop-core) now takes an optional item schema and refuses item by item, so the reason names `findings[2].severity` rather than a bare index. (2) The judge's example omitted `round_id`, `candidate_dispositions` and `final_finding_shares`, which its own prose required one line above; `judgeEnvelopeExample` now renders the whole submission, built from the round's REAL id and the REAL first contributor id. (3) The contract prompt never stated the grounding rule it is judged by — `groundDesignFindings` runs over `contract_findings` exactly as over the conceptual ones. (4) The registry declared a gap that was not there. (5) The no-lens example taught `"lens": "the lens this finding belongs to"`, which becomes a report bucket named after the placeholder; owner chose a real lens from the eleven-lens vocabulary. ⚠ **Correction to the measured review, confirmed independently by the `agy-gemini` refutation lane:** the PERSPECTIVE path was never tolerant — `submissionFindings` already parsed each item. Only the lane GATE for perspectives is shape-only, and the registry row now says so. Every half red-green validated by inversion (four separate inversions against the new prompt-11 pin, each red on its own assertion). Seven existing tests, across `tests/audit/next-step-helpers.test.ts` and `tests/audit/design-review-carry-no-aliasing.test.ts`, planted `{id, title}` findings the tolerant door had admitted; they now use one shared `designFinding()` factory. That partial shape was never a submission a host could produce — it was only what the tolerant door happened to admit — so the fixtures moved to the contract rather than the door moving back. |
| 12 | `second_order_adversary` | `src/audit/systemic/secondOrderAdversaryPrompt.ts` | **APPROVED (owner, 2026-09-17)** | Owner reviewed the LIVE rendered text and answered two questions. Three defects, and the obedience-is-insufficient class for the SIXTH file: the worked example wrote both closed alternations into the field VALUES (`"severity": "low\|medium\|high"`, `"confidence": "low\|medium\|high"`), so a copied submission failed its own lane gate with two `invalid_enum_value` issues; it taught a placeholder lens, which `FindingSchema.lens` (a `z.string()`) PARSES and the loop then preserves verbatim into the report, the `by_lens` digest the next round reads as its variation bar, and the `lens+category+title` dedupe key; and it cited `<a real repo path>`. **The severe defect was a FABRICATED CONVERGENCE SIGNAL.** `foldChallengeRound` was the one site in `src/` that DELETES an ungrounded finding rather than surfacing it not-confirmed; dryness counted new findings alone, so a round whose every improvement the grounding pass deleted read as QUIET, and two quiet rounds converge the register with `stop_reason: "converged"` — the tool manufactured, on the reader's behalf, the exact signal the prompt spends two paragraphs forbidding them to fake. Owner directed the fix at the SCHEMA: *"a finding can only be dropped explicitly, and if it lacks grounding the reviewer should be told to add that grounding — the schema shouldn't pass."* `systemicChallengeSchema(repoFiles)` binds the run's repository manifest into the submission contract and refuses an ungrounded improvement at `findings[i].affected_files`, reusing `groundDesignFinding` so the gate and the fold cannot disagree; an EMPTY manifest returns the bare schema, mirroring `groundDesignFindings` (a missing input is not proof the improvement is unreal). The drop STAYS as a backstop for any door that reaches the fold without the gate — `tests/audit/systemic-challenge.test.ts` pins it as designed behaviour — but a drop now costs the round its quiet status (`dry = new_finding_ids.length === 0 && droppedCount === 0`). The new `repoPathUniverse` helper is the one way a caller turns a manifest into the grounding set: `recoverSubmissionCommand`'s own universe passed manifest paths through verbatim while this module always normalized them, a disagreement visible on win32 and on any capitalized path. Owner also chose **"Teach all five values"**: the prompt now renders `severity`, `confidence` and the eleven-lens vocabulary from their schemas, never a hand copy. Cosmetics per the spec: "Push HARDER" / "human-grade pressure" / the "True lens" heading / the id-namespacing mechanics / the `docs_digest.json` aside are gone. `tests/shared/prompt-renders-its-contract.test.ts` now parses the example against the BOUND schema and holds the severity list exhaustive; the example's path comes from the call-site map the same prompt prints. ⚠ Removing the `SYSTEMIC_FINDING_ID_PREFIX` import left `systemicChallengeLoop.ts` reachable only through loop-core, which reds `check:loop-core-closure`; it is declared `pure` with its reason in `scripts/shared/loopCoreClosureData.mjs`. All five halves red-green validated by inversion. |
| 13 | `semantic_review` | `src/audit/cli/semanticReviewStep.ts` | **APPROVED (owner, 2026-09-17)** | Owner reviewed the LIVE rendered text and answered three questions. The lane draft kept TWO issue sections; the owner's answer adds a THIRD, so the landed prompt differs from the spec below and the spec's "two lists kept" line is superseded by this row. **The severe defect was a WRONG REMEDY, stated confidently.** The section split tested `code !== "submission_missing"`, so six codes shared one heading whose paragraph told the reader to repair the result and write it again — wrong for `duplicate_submission_id`, which `ingestAuditHostResults` raises only after the accepted-results ledger REFUSES the addition (the item is already accepted, is not pending, and the republished workload binds no path for it), and wrong for `workload_stale`, which names no work item at all and which the fold repairs itself by walking on to the re-prepare in the same call. Owner chose **"Third section, chosen by a shared rule"**: `SUBMISSION_ISSUE_REMEDY` (`src/shared/submission/hostResultOutcomes.ts`, loop-core) maps every submission code to `wait` / `repair` / `none`, the audit draw spreads it into an exhaustive `Record<AuditIngestIssueCode, IssueRemedy>` (`src/audit/validation/ingestIssueCodes.ts`) so a new code with no remedy is a TYPE ERROR rather than a default into whichever section a filter leaves it in, and `isMissingObservation` now derives from the map instead of a literal. `WORK_ITEM_OUTCOMES` was checked and is a different question — an item's observed state from evidence, not what the reader should do — so the two vocabularies stay separate and the new JSDoc says why. Owner also chose **"Extract one renderer, both callers use it"**: `renderIngestReportLines` (`src/audit/cli/ingestIssueSections.ts`) is now the ONE renderer; the hand copy in `renderCarriedAdvisoryLines` (`src/audit/cli/nextStepHelpers.ts`, loop-core) duplicated the split, the bullet format and the headings, and had already gone stale. The repair paragraph renders only when the repair section has entries. And **"Fix the class now, with a contract test"**: a prompt BODY is a free string, so a renderer interpolated a native win32 path into its prose while `writeStepContract` forward-slashed the same file in the path FIELD beside it; `normalizePromptBodyPaths` now runs over every written prompt at the one writer, anchored on a drive letter or a UNC root so a regex, an escape sequence or a code sample in a prompt body is never rewritten. Both halves are pinned in `tests/shared/step-contract-writer.test.ts`. Three remediate tests asserted the backslashed body form and now state the normalized one. Cosmetics per the spec: "provider-neutral" gone, the hand-merge plea gone (result identity + prompt digest binding already refuse a hand-merged result), the execution directive now two numbered steps. ⚠ NOT swept in: the remediate draw's renderers (`src/remediate/steps/nextStep.ts`, `src/remediate/steps/dispatch/hostHandoff.ts`) still use the two-way split and so still state the wrong remedy for `duplicate_submission_id`; that is queue items 16–20, and `SUBMISSION_ISSUE_REMEDY` already carries the right answer for the day they adopt it. All four halves red-green validated by inversion. |
| 14 | `synthesis_narrative` | `src/audit/reporting/synthesisNarrativePrompt.ts` | **APPROVED (owner, 2026-09-17)** | Owner reviewed the LIVE rendered text and answered three questions. ⚠ The LANDED prompt goes beyond the spec below on all three answers; where the two disagree, this row governs. Six defects. **The severe defect was a SILENT SEVERITY CUT.** `report.findings` arrives in MERGE order — `buildAuditFindingsDeliverable` copies the array untouched — and the renderer cut it at `MAX_RENDERED_FINDINGS` = 120, so the cut was by ARRIVAL. The dogfood audits in `git log -S'MAX_RENDERED_FINDINGS'` produced 2,179, 2,241 and 3,230 findings, which means a real run could hand the reader 120 findings with every `critical` one off the end, then ask that reader for the top risks. Owner chose **"Sort by severity, and grant the findings file"**: the renderer now sorts most-severe-first with `severityRank` before the cap, and the sort is stable, so merge order survives as the within-severity tie-break. The same answer fixed the OVERFLOW line, which named `audit-findings.json` as a bare filename — a lane prompt is a FILE with its own access grant, and `materializeFanoutLanes` grants the lane exactly one path, its own prompt, so the note pointed at something the reader could neither locate nor open. `renderSynthesisNarrativePrompt` now takes the report path as an ACCESS-BEARING argument, and `emitSynthesisNarrative` adds it to the step's `read_paths`. Owner also chose **"Refuse a finding claimed twice"**: `applyNarrative` previously let the first theme keep a contested id and STRIPPED it from the later one, in silence, so the stored narrative differed from the submitted one and the result was ORDER-DEPENDENT — which is exactly what `tests/audit/synthesis-narrative-convergence.test.ts` wants the narrative free of. Both halves of the id join now refuse, and the refusal names the finding and both claiming themes. A repeat of one id INSIDE a single theme breaks no rule and is still deduplicated. Owner took **both spec wording changes**: the observational-vs-conceptual paragraph is gone (unanswerable — `LensSchema` has ONE `architecture` value, `FindingSchema.category` is a free string, and the two names exist only as remediate contract-pipeline artifact names), and the "change severities" plea is gone (`SynthesisNarrative` carries no severity field). ⚠ Prompt 13's path-form class reached its SECOND writer here: `fanoutLanes.ts` writes every lane prompt file, so a lane read `C:\...\workload.json` in its prompt while the step contract beside it named the same file with forward slashes. `normalizePromptBodyPaths` now runs at that writer too, and `renderLaneResultsFooter` uses `toPromptPathToken`. BOTH halves are pinned in `tests/shared/prompt-capability.test.ts`: the body half was unpinned at first inversion (the footer normalizes its own path, so the existing test could not see it) and needed a new test. All four halves red-green validated by inversion, each red on its own assertion. |
| 15 | `dispatch_review` | `src/audit/cli/dispatch/hostHandoff.ts` | **APPROVED (owner, 2026-09-17)** | Owner reviewed the LIVE rendered text and answered three questions. ⚠ The landed change is LARGER than the spec below, on an explicit owner directive; where the two disagree, this row and `docs/reviews/lens-steward-redesign-2026-09-17.md` govern. **Q1, `reviewed_clean`:** owner chose **"Attest a zero-finding result"** — the envelope now ACCEPTS the key and CHECKS it, so a clean review states that it is clean instead of arriving as an empty array that also means "nothing ran". **Q2, quotes:** owner chose **"Refuse the finding, but allow a specific keyword"** — the prompt asks for a verbatim quote per affected file, and the door refuses a finding whose `affected_files` entry carries NEITHER `quoted_text` NOR `no_quotable_span` (a short statement of why nothing is quotable). Never both, never neither. The declaration is deliberately adversary-checkable: if a quotable span DID exist, that fact casts doubt on the finding's grounding. **Q3, the follow-up boundary:** the owner asked for "the packet boundary" to stop being a function of which siblings were dispatched alongside the result. Investigation showed the boundary was a SYMPTOM, and the owner then directed a fundamental redesign: *"A number of files is not a good way to measure ... anything. ... The lens steward should have access to every file the lens was applied to, and whatever useful metrics we can generate specific to that lens. It should then be allowed to review whatever it thinks it should."* `MAX_LENS_VERIFICATION_FILES` and `MAX_LENS_VERIFICATION_RESULT_SUMMARIES` (both 12) are DELETED — a file count measures no cost the tool cares about. A steward is now granted its whole lens surface with per-file metrics, under a new `coverage_policy: "complete" \| "selective"` axis on `AuditTask`, and it must state a `verification.selection_rationale` for what it opened and what it left. The full design, its three coverage gates, the independent refutation pass and the three defects that pass found are in `docs/reviews/lens-steward-redesign-2026-09-17.md`; its section F carries the remaining prompt-15 prompt defects (the `verification` self-contradiction, the buried result destination, and the lane-blind "review every listed file" line) as part of the same atomic change. |
| 16 | `clarify_remediation_target` | `src/remediate/steps/prompts.ts` | **APPROVED (owner, 2026-09-18)** | Owner reviewed the LIVE rendered text of all three prompts and answered four questions. ⚠ The landed change goes beyond specs 16a–16c below; where the two disagree, this row governs. **The severe defect was a LOST QUESTION.** A worker question lived in TWO places, the run-level `clarifications` list and the paused item, and the round cleared the whole list on ANY applied answer. A partial answer therefore left every unanswered item paused on a question the next round could no longer render. **Q1:** owner chose **"One source: the item"** — the question (category, text, options) is `clarification_question` on the item it pauses, the round is built from every `needs_clarification` item, and the run-level list is retired: `StateStore` refuses to write it or a paused item without a question, and adopts a legacy file's entries onto the items on read (falling back to `failure_reason`). An answered item loses its question; an unanswered one keeps it, and the round asks it again once the frontier drains. **Q2:** owner chose **"One shape, refuse bad entries"** — the resolution file is a bare JSON array (the object envelopes are gone), every entry is parsed by one zod schema, and ONE bad entry refuses the WHOLE file with a reason naming the entry index and the field: an unknown action, a blank `rationale` on `clarified`, `scope_additions` on `reject_finding` or `defer`, a duplicate `finding_id`, or an id that is not waiting for a clarification. Prompt 17a shares the parser. A `waiting_for_clarification` state with no paused item now resumes implementing instead of asking nothing. **Q3:** owner chose **"Flags only; tool owns file"** — 16b tells the host to pass documents with `--input` (repeatable) and conversational feedback with `--guidance-file`; the source manifest is written only by the tool, and `readSourceManifest` refuses a malformed one with the field named and the flag recovery stated. The step's allowed commands are exactly the three flag forms. **Q4:** owner took **all four wording fixes** — the examples use the round's REAL first id (16a leaves `scope_additions` out of the example and states it in words); the 16a actions are a three-row table; the scope rule is stated correctly as *a new file is allowed when its directory already holds a tracked file* (the spec's "files that exist" was wrong — `writeScopeCorpusViolations` admits a new file); 16c states its closed id set and refuses a blank answer. A further wedge found while measuring 16c: a summary with `ready: false` and no blocking question sent the run to a question round with nothing to ask; it now returns to `synthesize_intake` with the reason. Two older tests pinned the retired 16b contract (a manifest path in the prompt, and a hand-written manifest with an empty `sources` list the tool can never write); both now state the new one. Pinned in `tests/remediate/clarification-round-contract.test.ts` and `tests/remediate/intake-starting-point-contract.test.ts`; all twelve halves red-green validated by inversion, each red on its own test. |
| 17 | `plan_proposal` | `src/remediate/steps/prompts.ts` | **APPROVED (owner, 2026-09-18)** | Owner reviewed the LIVE rendered text of 17a–17c and answered four questions. ⚠ The landed change goes beyond specs 17a–17c below; where the two disagree, this row governs. **17a:** owner chose **"Take all, banner in 16a/17b too"** — the up-front ambiguity prompt states the SAME entry rules as 16a from one shared block (`resolutionEntryRules`: the example with the first real id, the three-row action table, the `scope_additions` rule, the whole-file refusal list), the steps follow the candidates they refer to, `[]` is stated as "the plan continues unchanged", and a finding with no entry continues as planned. The candidate text no longer says "a architecture finding". ONE refusal banner (`refusalBanner`) serves 16a, 17a and 17b: "Fix each problem named above. Then re-submit the WHOLE file." — it no longer blames the ids for every refusal. **17b check:** owner chose **"Strict, refuse whole file"** — `parseReviewResolution` reads `review_resolution.json` with a strict zod schema on BOTH review-gate paths. Invalid JSON, a bare array, an unknown field (top-level or in an entry), a wrong type, or an unknown id or tier refuses the WHOLE file: it is archived as `.refused-<ts>`, nothing is recorded, and the gate re-halts with a reason that names each problem and the valid set. Before, a wrong field name APPROVED the declined finding in silence, and a wrong type or bad JSON crashed next-step. A `plan_id` from another run still reads as stale. **17b reason:** owner chose **"Record the reason, rename"** — the shape is `{declined_findings: [{finding_id, reason?}], declined_tiers, plan_id?}`; the report records the user's own reason, or the generic line when the reason is absent or blank. The retired `disapproved_*` names are refused with the new names stated. The example shows empty arrays. **17c:** owner chose **"One file; tool renders rest"** — the host writes ONLY `intake-summary.json` (schema `remediate-code-intake-summary/v1alpha2`; new required fields `source_summary`, `acceptance_criteria`, `scope_summary`, `intent_summary`, `filters`; optional `intent_interpretation`). The tool renders `remediation-brief.md` from every schema-valid summary it reads (`renderRemediationBrief`, written only on a content change). A refused summary brings `synthesize_intake` back with the reason, never a thrown load error. The confirm step builds its proposal from the summary. The draft checkpoint and `confirmed_by: "draft"` are retired: a legacy draft on disk is archived as `.legacy-draft-<ts>` and the confirm step asks again. The prompt states the `ready` rules and drops the manifest read and the `free_form_intent` text. The 17a spec's "files that exist" is corrected below. Pinned in `tests/remediate/clarification-round-contract.test.ts`, `tests/remediate/reviewGate.test.ts`, `tests/remediate/next-step-review-gate.test.ts`, `tests/remediate/n-r04-intent-checkpoint.test.ts` and `tests/remediate/intake-sources-and-digest.test.ts`; the 17b parser (red on both gate paths) and the three 17c halves (brief render, legacy-draft archive, refusal re-issue) red-green validated by inversion. |
| 18 | `contract_pipeline` | `src/remediate/steps/contractPipelinePrompts.ts` | **APPROVED (owner, 2026-09-18)** | Owner reviewed the LIVE rendered text of 18a and 18b and answered four questions, all with the recommended option. ⚠ The landed change goes beyond specs 18a–18b below; where the two disagree, this row governs. **18a:** the rewrite is adopted — each role states its own read scope, its own **Field Rules** section and its own Path-A seed sentence; gate names and false claims are out of the worker text; the mandate and the critic text are unchanged. **Enforced, not asked:** (1) a decomposition `file_scope` that grounds only on re-export shims is refused at the pre-critic boundary and decomposition is RE-EMITTED with a "Module File Scope Errors" section (the same boundary as citation grounding); (2) the cyclic-seam worker is offered only `resolved`, and the re-check gate reads the LIVE ledger — a `no_cycles` record, or a `resolved` record with no cycle entries, is refused while any cycle remains, and the resolution phase is re-emitted with the reason; the cyclic-seam prompt is no longer a ROLES entry, the gate renders it (`renderCyclicSeamResolutionPrompt`) with the cycles it detected and the ledger rewrite it requires; (3) the judge is offered three repair targets, and `counterexample` is REFUSED with a reason ("the judge rules on the critic's report and cannot order it rewritten"), never swapped in silence. **Retired:** the `closing` ROLES entry and phase (no worker writes `verification_report`: the close phase builds it, `buildVerificationReport`); the `obligation_ledger` text is repair-only, matching `derive.ts`; an inapplicable test spec is admitted without `kind` or `assertions`, so the validator and the scaffold agree. **18b:** the repair prompt carries the producing role's Field Rules, the same self-check, and "Do not edit any other artifact or any source file". **Corrections to the approved text, stated here:** the last line reads "Do not start the next phase", not "Do not run next-step" — `writeContractPromptStep` appends the instruction to run next-step after the output is written, so the approved line would contradict it. **Kept, with reasons:** `design_spec` stays an ADMITTED legacy repair target (an older judge report still loads) and is not offered; Gate 6 (the circular warning in `validateDesignSpecGates`, `contractPipelineGates.ts`) stays for the validate-artifact self-check (`evaluateContractPipelineCrossGateOutcomes`), although its route into the critic prompt is now unreachable. Each enforcement was inverted alone and its test went red (shim merge, `no_cycles` bypass, empty-`cycles` bypass, the counterexample reason, the inapplicable admission). |
| 19 | `verify_remediation` | `src/remediate/steps/prompts.ts` | **APPROVED (owner, 2026-09-18)** | Owner chose the recommended option on all three questions. (1) **No verify prompt, by design**: the tool checks each result itself (`parseResult`, `corroborateHostResult`, `rerunRequiredTests`); Part 2 row 19 and spec 19 are corrected. ⚠ The draft claimed the repository-wide build/typecheck/test gate runs on every target. It runs ONLY on the audit-tools repository: `toolOwnedFinalGateCommands` returns no commands elsewhere and the gate records `scoped_out`. (2) **The `final_gate_red` pause is rewritten** (`emitFinalGateRedStep`, `src/remediate/steps/nextStep.ts`): the cache is explained once, the two actions are numbered steps, internal words ("tool-owned gate", "floor", "served", "spawning", "phase lock") are gone, and the false line "The gate re-runs from scratch" is removed (with no edit, the cached red returns at once). The pause names where the run stands ("At the phase N boundary" / "Before the close phase"). The attribution block is unchanged. Pinned in `tests/remediate/final-gate-red-pause.test.ts`; the old text went red against it. (3) **The suite gap outside audit-tools is logged** in `docs/backlog/open-bugs.md`, not fixed in this lap (scope and the design gate, not effort). |
| 20 | `host_handoff` (remediate) | `src/remediate/steps/dispatch/hostHandoff.ts` | **APPROVED (owner, 2026-09-18)** — implemented | The owner chose the recommended option on all four questions. (1) The result contract is slimmed to the fields the tool cannot derive: contract_version, result_id, run_id, work_item_id, prompt_sha256, landed_commit, obligation_evidence (new version v1alpha3). changed_files, commit_evidence.before, test_evidence, worktree_evidence, acceptance and merge are dropped: the tool reads them from git and from its own test rerun. (2) Each worker prompt, in BOTH draws (remediate and audit), ends with a result template whose identity values the tool fills in, from one shared helper; the prompt digest covers the text above the template (detail settled at `/design-check`). (3) The host prompt's result sections come from a remediate remedy map over every remediate issue code and ONE renderer shared with the audit draw; a duplicate resubmission lands under "Settled — no action needed" (closes the `SUBMISSION_ISSUE_REMEDY` open-bugs entry). (4) The plain-language rewrite of both prompts is adopted: no "frontier", no "later dependency level" sentence, no digest sentence, worker rules as bullets, "merged" stated as "HEAD contains your commit". Two follow-up answers at `/design-check` (owner, 2026-09-18, both recommended): (5) a FOURTH remedy, "operator", with its own section — problems the worker cannot fix (a plan block with a missing prerequisite or a malformed write scope, a capped test output, an unrecordable recovery mark, a tree or state that moved during recovery, a per-item missing binding) are listed under "stop and report them to the operator"; the shared vocabulary grows to four in both draws. (6) A remediate duplicate result is two files with one result_id in the same call, and neither is accepted, so the remediate map overrides it to "repair"; the audit draw keeps "settled". |

### Resume Instructions for Next Conversation

⚠ **What "approved" means here.** Only an owner verdict on the PROMPT TEXT counts. On 2026-09-17 the
owner stated: *"I've only explicitly approved 1-7. I need to look at 8+."* Rows 9, 9b and 10 had
carried an **APPROVED** label derived from the owner's approval of the charter DESIGN
(`docs/reviews/charter-redesign-feedback-2026-09-15.md` §"Owner decisions") — a design approval is
not a text approval. Their prompts shipped in `80793d83` regardless. Never derive an approval label
again; see memory `n-r13-shipped-unapproved-and-itemspec-was-its-corpse`.

1. Prompts 1–7 are owner-approved (2026-09-13). Their specs are recorded below and are NOT yet
   implemented — the live `skills/audit-code/audit-code.prompt.md` still carries the unconditional
   development instruction that spec 1 removes.
2. Prompts 8 and 9 are owner-approved (2026-09-17) AND implemented, each with its pinning test
   corrected or added. Prompt 9's review also changed the ingest contract, by owner decision: the
   `accounts` minimum in `DifferenceInputSchema` is conditional on the dimension, and
   `assembleComparison` refuses a `presence` difference that does not leave exactly one channel
   silent.
3. Rows 8 through 19 are owner-approved (2026-09-17 and 2026-09-18) AND implemented. Row 20 is
   owner-approved (2026-09-18); its Part 3 row states the four decisions, which supersede the
   lane-drafted spec 20 below. Prompt 20 (`src/remediate/steps/dispatch/hostHandoff.ts`) is
   loop-core, so it needs the design gate and a review attestation before it commits.
4. Specs 11e/11f propose NO prompt change (context blocks, kept as-is with shorter disclaimers). Row 19 has no verify prompt; its approved change is the `final_gate_red` pause text.
5. On approval: log each "Backend ... (Backlog)" bullet to `docs/backlog/open-bugs.md`, regenerate the backlog index, then implement per prompt with the pinning tests named in each spec's Evidence.
6. **The method, unchanged:** show the owner the LIVE RENDERED prompt text, the critique, and ONE
   proposed rewrite. Never TypeScript source, and never a batch of drafts
   (memory `prompt-review-is-interactive-one-at-a-time`).

---

### 1. `/audit-code` Loader (`skills/audit-code/audit-code.prompt.md`) — APPROVED

```markdown
---
description: Autonomous local-loop code auditing through provider-neutral host workloads
argument-hint: [target-dir]
allowed-tools: [Read, Bash, Glob, Grep, Agent]
---

# `/audit-code` Loader

You are the audit-code orchestrator for this conversation. The backend manages the workflow state machine and emits complete work items; you own semantic execution, user interaction, and code review.

## 1. Target Directory

Set your command working directory (`cwd`) to the target repository root:
- If the user specified a target directory (or if you are operating from a parent workspace), set `cwd` to that repository root for all commands.

## 2. Bootstrap

From the target repository root, run:
```bash
audit-code ensure --quiet
```
*(If running from the `audit-tools` development repository root, use `node audit-code.mjs` instead of `audit-code`.)*

## 3. Structural Capability Preflight

Check whether you have tools to trace symbol definitions, call hierarchies, and cross-file relationships (e.g. language server, code intelligence, symbol search) rather than flat keyword search alone:
- If missing, offer to install or configure appropriate code-intelligence tools (ephemerally for this session or permanently in the environment).
- If proceeding with flat text search (`grep` / `find`) only, inform the user that the audit will be degraded/shallow because cross-file call and relationship tracing is unavailable.
- For degraded runs, log an `AgentReflection` with `task_id: "audit-capability-preflight"`, `severity: "high"`, and describe the limitation in `tool_friction`. Append it as a JSON line to the file path in `artifact_paths.agent_feedback`.

## 4. Execution Loop

1. **Retrieve Step**: Run `audit-code next-step`.
2. **Follow Step Prompt**: Read the prompt file at `prompt_path` in the step output and follow its directions.
3. **Dispatch Work**: When the prompt emits review items, assign them to subagents if available, or execute them directly.
4. **Advance**: When a step completes, run `audit-code next-step` again and follow the new `prompt_path`. Repeat until the workflow signals completion.
```

### 2. `/remediate-code` Loader (`skills/remediate-code/remediate-code.prompt.md`) — APPROVED

```markdown
---
description: Autonomous local-loop remediation through provider-neutral host work items
argument-hint: [--input <path>] [--guidance-file <path>]
allowed-tools: [Read, Bash, Glob, Grep, Agent]
---

# `/remediate-code` Loader

You are the remediate-code orchestrator for this conversation. The backend manages the persisted workflow state machine and emits complete work items; you own all concrete implementation choices, code editing, and test verification.

## 1. Target Directory & Arguments

Set your command working directory (`cwd`) to the target repository root:
- If targeting an external repository, set `cwd` to that repository root for all commands.
- Pass input findings with `--input <path>`.
- If the user provided conversational guidance, write it to a temporary file inside the generated tool directory (e.g. `.audit-tools/guidance.txt`) and pass `--guidance-file <path>`. Never write temporary working files to the repository root.

## 2. Bootstrap

From the target repository root, run:
```bash
remediate-code ensure --quiet
```
*(If running from the `audit-tools` development repository root, use `node remediate-code.mjs` instead of `remediate-code`.)*

## 3. Execution Loop

1. **Retrieve Step**: Run `remediate-code next-step` (pass `--input <path>` and/or `--guidance-file <path>` on the initial invocation if provided).
2. **Follow Step Prompt**: Read the prompt file at `prompt_path` in the step output and follow its directions.
3. **Dispatch Work**: When the prompt emits implementation items, assign them to subagents if available, or execute them directly in isolated worktrees with test evidence.
4. **Advance**: When a step completes, run `remediate-code next-step` again and follow the new `prompt_path`. Repeat until the workflow signals completion.
```

### 3. `confirm_intent` (`src/audit/cli/confirmIntentStep.ts`) — APPROVED

#### Summary of Key Refinements Applied
- **Mandatory Lenses First**: Re-ordered the proposition table so mandatory base lenses (`correctness`, `security`, `reliability`, `data_integrity`) always appear at the top with their functional definitions.
- **Embedded Definitions & Glossary Removal**: Retained concise functional definitions in the table itself and eliminated the redundant 11-bullet glossary list that was previously appended below the table.
- **Unencodable Intent Directives**: Rephrased blocking clause instructions to clearly direct resolution in `constraint_clauses` while slightly discouraging removal: *"Clarify how each should be applied in `constraint_clauses` of `intent_checkpoint.json`. If a clause cannot be clarified, or is actually unnecessary, remove it from `free_form_intent`."*
- **Streamlined Scope Rules**: Eliminated internal rule guard branch explanations (e.g. `root_ignored`, `share_exceeded`) in favor of direct reporting: applied count vs skipped with concrete instruction on candidate file disposition.
- **Conceptual Design-Review Perspectives**: Replaced the rigid `shallow` vs `deep` binary toggle with an open perspective roster allowing the user to select an arbitrary number of independent reviewers, including custom orchestrator proposals.
- **Adversary & Minimalist Rephrasing**:
  - *Adversary*: Phrased in terms of actively trying to break things with open disdain for original coders' technical and creative abilities.
  - *Minimalist*: Differentiated from Pragmatist by focusing ruthlessly on eliminating absolutely everything possible without breaking the code entirely.
- **Mandatory Lens Tone**: Rephrased negative pleading to: *"Don't bother confirming the mandatory lenses - they are always on."*
- **Removed Provenance Cache Trivia**: Stripped historical backend cache-invalidation rationale for `answered_at`, requiring only that it match `confirmed_at`.
- **Backend Schema Evolution (Backlog)**: Logged open bugs for `IntentCheckpointSchema.design_review` to support named perspective selection and custom perspective definitions, and to prevent silent fallback to shallow defaults when provenance is unverified.

#### Finalized Prompt Specification

````markdown
# Confirm Audit Scope and Intent

## ⚠ Blocking: unencodable intent clauses

The following free-form directives could not be automatically mapped to standard lenses or scope rules. Clarify how each should be applied in `constraint_clauses` of `intent_checkpoint.json`. If a clause cannot be clarified, or is actually unnecessary, remove it from `free_form_intent`:

1. Clause: `<text>`
   clause_id: `<clause_id>`
   Question: <checkpoint_question>

Before planning, confirm what this audit should cover. The scope below was
discovered deterministically from intake. Your job is to **confirm it** and,
if needed, **prune scope pollution** the automatic disposition missed (build
output, vendored code, fixtures, generated files, scratch directories).

**Mode:** <full | diff> (since <rev>)
**Files in scope:** <count>

## ⚠ Possible mis-scope

Intake detected signals that the resolved root may be the wrong target.
Confirm the audit target with the user before writing `intent_checkpoint.json`:

- <mis-scope smell>

## Repository purpose (from its docs)

Extracted deterministically from the repo's own documentation. Weigh this
stated purpose when confirming scope, reviewing the lens table, and
phrasing the intent summary:

### `<path>` — <title>

<excerpt trimmed to 500 characters>

_Also digested (full excerpts in `docs_digest.json`): `<path>`, `<path>`_

## In-scope top-level directories

- `<dir>` — <count> file(s)

## Scope rules

- gitignore: Applied (<n> file(s) excluded).
- untracked: Skipped (<reason>). Candidate files remain in scope unless explicitly added to `disposition_overrides`.

## Already excluded (deterministic disposition)

- `<prefix>/` — <count> file(s) (<status>: <reason>)
- `<path>` (<status>: <reason>)

## Suspicious inclusions (proposed overrides)

The following files match build-output, vendor, or generated patterns but
are currently included. Accept proposals by adding them to `disposition_overrides`.

- `<path>` → `<proposed_status>` (<reason>)

## Lens proposition

Deterministic first pass over the codebase. Mandatory lenses are evaluated on every audit; optional lenses are recommended based on detected surface and structure.

| Lens               | Disposition           | Why |
|--------------------|-----------------------|-----|
| correctness        | ● mandatory           | Logic errors, broken invariants, and unhandled edge cases (always audited). |
| security           | ● mandatory           | Injection, authn/authz, secrets, and privilege boundaries (always audited). |
| reliability        | ● mandatory           | Failure modes, error recovery, and resource leaks (always audited). |
| data_integrity     | ● mandatory           | Persistence correctness, serialization drift, and state races (always audited). |
| architecture       | <disposition>         | <reason> |
| maintainability    | <disposition>         | <reason> |
| performance        | <disposition>         | <reason> |
| tests              | <disposition>         | <reason> |
| operability        | <disposition>         | <reason> |
| config_deployment  | <disposition>         | <reason> |
| observability      | <disposition>         | <reason> |

### Review and finalize this table (do this BEFORE asking the user)

Using your own judgment — research the code if it helps — review every optional disposition above. You MAY:
- flip any `✓ recommend include` / `✗ recommend exclude` row when the codebase warrants it;
- append rows for non-canonical (custom) lenses you decide would help this audit — give each a disposition and a reason; they sit in the same table, undistinguished from canonical lenses.

Mandatory lenses (security, correctness, reliability, data_integrity) are always audited. This preflight review is **invisible to the user** — they see only your final merged table.

## Conceptual Design-Review Perspectives

The audit runs an independent conceptual design-review pass (evaluating architecture, philosophy, alternative directions, and failure modes). Rather than a fixed shallow/deep toggle, the operator may select an arbitrary number of independent reviewers.

Review the proposed perspectives below. You may propose additional custom perspectives suited to this codebase:

- **Adversary** — Actively try to break the system with open disdain for the original coders' technical and creative abilities. Assume happy paths are naive, error handling is wishful thinking, and edge cases were ignored. Hunt for fragile assumptions to induce catastrophic failure.
- **Minimalist** — Ruthlessly eliminate absolutely everything possible without breaking the code entirely. Question every abstraction, layer, parameter, wrapper, and feature. If it is not strictly essential to keep the system functioning, advocate deleting it.
- **Pragmatist** — Does this actually work for users? What's the shortest path to value? Flag anything that adds ceremony or indirection without earning its keep.
- **Mathematician seeking elegance** — Minimal complexity, orthogonal abstractions, no redundancy. Flag overlapping concepts that should be unified and abstractions that fail to compose.
- **Short attention span** — Frustrated by anything taking >30 seconds to understand. If a design can't be explained simply, it's too complex. Flag cognitive-load hotspots and implicit knowledge.
- **Novelty-seeker** — Always hunting for the latest tool, pattern, or library that could replace hand-rolled machinery. Flag wheels being reinvented and standards being ignored.
- **Maintainer inheriting this cold** — A new engineer six months from now with no context. Flag what would take longest to learn, what's implicit, and what has no obvious entry point.
- *(Custom perspectives)* — Propose domain-relevant perspectives if helpful (e.g. "Distributed Systems Hardliner", "Zero-Trust Architect").

## Ask the user (single round)

After finalizing the lens and perspective proposals, confirm with the user in ONE round:

1. Present the scope summary above (noting any excluded areas or mis-scope warnings).
2. Show the user ONLY your final lens table. Ask which **optional** lenses to layer on top of the always-on mandatory set (and whether to flip any recommend-include / recommend-exclude). Don't bother confirming the mandatory lenses - they are always on. The user may add **any number** of additional custom lenses (freeform names).
3. Present the conceptual design-review perspectives. Allow the user to select which perspectives (or how many independent reviewers) to run, and whether to add custom perspectives.
4. Wait for the user to confirm before proceeding.

Record the result in `lens_selection` and `design_review`.

## What to do

After the user confirms, write `intent_checkpoint.json` to:

  <intentCheckpointPath>

Use this shape (only `scope_summary` and `intent_summary` are required; add the optional fields to constrain the run):

```json
{
  "schema_version": "intent-checkpoint/v1",
  "confirmed_at": "<ISO-8601 timestamp>",
  "confirmed_by": "host",
  "scope_summary": "<what is in scope>",
  "intent_summary": "<the goal, e.g. full-audit / security-focused>",
  "free_form_intent": "<optional: what to focus on; interpreted into lens/priority signals at planning, never threaded verbatim into review prompts>",
  "constraint_clauses": [{ "clause_id": "<the clause_id above>", "text": "<unencodable clause>", "checkpoint_question": "<the question above>", "host_answer": "<how to apply it>" }],
  "excluded_scope": [{ "path": "<path or prefix>", "reason": "<why>" }],
  "must_not_touch": ["<glob>"],
  "disposition_overrides": [{ "path": "<path>", "status": "<generated|vendor|excluded|...>", "reason": "<why>" }],
  "lens_selection": { "include": ["<lens>"], "exclude": ["<lens>"] },
  "design_review": {
    "answered_at": "<matches confirmed_at>",
    "perspectives": ["Adversary", "Minimalist"],
    "custom_perspectives": [{ "name": "<name>", "lens": "<focus description>" }]
  }
}
```

- `constraint_clauses`: Resolves any blocking clauses above. Each entry maps a `clause_id` to a concrete `host_answer`.
- `excluded_scope`: Paths/prefixes excluded from planning and tasks, listed under "Excluded / Out-of-Scope" in the report.
- `disposition_overrides`: Patches file disposition before coverage initialization.
- `lens_selection.include` and `lens_selection.exclude`: Accept canonical and custom lens names.
- `design_review.answered_at`: Must match `confirmed_at` to bind to this run.
- `design_review.perspectives`: The selected reviewer perspectives for conceptual design review.
- Leave optional fields out to audit the full discovered scope with defaults.

Then run: <continueCommand>
````

### 4. `intent_equivalence` (`src/audit/cli/nextStepCommand.ts`) — APPROVED

#### Summary of Key Refinements Applied
- **Natural Section Headers**: Replaced internal compiler jargon (`Prior prose normal form`, `Current prose normal form`) with clear operational labels: `Previous Intent (used for current plan)` and `Updated Intent`.
- **Grounded Verdict with Rationale**: Added a required `rationale` field to the output JSON contract to ensure chain-of-thought evaluation by the judge and provide an auditable explanation for why planning was preserved or invalidated.
- **Backend Schema Evolution (Backlog)**: Logged an open bug for `IntentEquivalenceVerdictSchema` in `src/audit/orchestrator/intentEquivalenceExecutor.ts` to support the new `rationale` field in its `.strict()` definition.

#### Finalized Prompt Specification

````markdown
# Intent-equivalence judgment (bounded)

The intent checkpoint's PROSE changed since the planning artifacts derived
(structured fields are identical — this is wording only). Judge whether the
two prose forms express the SAME audit intent. Judge STRICTLY: any change
in scope, emphasis, constraint, or goal — however small — is `changed`.
Only pure rephrasing (wording, ordering, formatting) is `equivalent`.
An `equivalent` verdict keeps every planning artifact fresh; `changed`
re-derives the planning cascade against the new intent.

## Previous Intent (used for current plan)

```json
<prior_prose>
```

## Updated Intent

```json
<current_prose>
```

## Verdict contract

Write EXACTLY this JSON object (no extra fields) to:

  <verdictPath>

```json
{
  "verdict": "equivalent | changed",
  "rationale": "<1-2 sentence explanation of your judgment>",
  "judged_pair": {
    "prior_hash": "<prior_hash>",
    "new_hash": "<new_hash>"
  }
}
```

`judged_pair` must carry the two hashes shown above verbatim — they bind
the verdict to this exact pair; a checkpoint edited again mid-judgment is
detected and re-judged.

Then run: <continueCommand>
````

### 5. `analyzer_consent` (`src/audit/cli/prompts.ts`) — APPROVED

#### Summary of Key Refinements Applied
- **Ephemeral-Only Consent**: Updated policy so that neither declines nor grants persist across runs. All consent decisions are strictly per-run and re-offered fresh on subsequent runs.
- **Explicit Operator Confirmation**: Replaced vague "present each candidate" instruction with an explicit directive: *"Ask the operator directly using your host's question/confirmation mechanism. Do not make assumptions or answer on the operator's behalf."*
- **Clear Security & Execution Risk Categories**: Rephrased the bullet points to clearly articulate concrete execution risks (e.g. *Arbitrary code execution during config evaluation*, *Outbound network requests*, *Unpinned package versions*).
- **Strict Decision Value Enum**: Explicitly stated in the prompt text that values must be either `"granted"` or `"declined"`, preventing ambiguous strings.
- **Backend Policy Evolution (Backlog)**: Logged an open bug to retire `persistAnalyzerConsent` writing durable declines in `.audit-tools/audit/analyzer-policy.json`, ensuring all consent decisions remain strictly ephemeral.

#### Finalized Prompt Specification

````markdown
# External Analyzer Consent

This repository is applicable to <count> consent-gated analyzer(s) with no recorded decision for this run. All decisions are strictly per-run and do not persist across runs.

Ask the operator directly using your host's question/confirmation mechanism. Do not make assumptions or answer on the operator's behalf.

### `<id>` (<runner>: `<spec>`)

- **Detects**: <purpose>
- **Security & Execution Risks**: <Arbitrary code execution during config evaluation | Outbound network requests | Unpinned version (<version_pinning>) | Heavy resource profile>

## Record the decisions

Write ONE JSON object mapping every candidate ID above to either `"granted"` or `"declined"`:

`<decisionsPath>`

For example:

```json
{
  "<candidate_id_1>": "granted",
  "<candidate_id_2>": "declined"
}
```

Then continue:

`<continueCommand>`
````

### 6. `analyzer_install` (`src/audit/cli/prompts.ts`) — APPROVED

#### Summary of Key Refinements Applied
- **Explicit Operator Confirmation**: Added clear directive: *"Ask the operator using your host's question mechanism to choose an install option for each analyzer. Do not make package installation decisions without operator confirmation."*
- **Fenced JSON Block & Strict Enum Values**: Replaced single-line example string with a clear fenced JSON block and explicitly enumerated allowed values (`"ephemeral"` | `"permanent"` | `"skip"`).

#### Finalized Prompt Specification

````markdown
# External Analyzer Installation

Optional language analyzers can enrich the deterministic codebase knowledge graph.

- **<entry.id>** — needs `<dependency>`; <supportedCount> in-scope file(s) would be analyzed.

Ask the operator using your host's question mechanism to choose an install option for each analyzer. Do not make package installation decisions without operator confirmation.

Allowed values: `"ephemeral"` | `"permanent"` | `"skip"`. These choices persist in the provider-neutral analyzer policy.

## Record the decisions

Write ONE JSON object mapping every analyzer ID above to your choice:

`<decisionsPath>`

For example:

```json
{
  "<entry_id_1>": "ephemeral",
  "<entry_id_2>": "skip"
}
```

Then run: <continueCommand>
````

### 7. `critical_flow_fallback` (`src/audit/reporting/criticalFlowFallbackPrompt.ts`) — APPROVED

#### Summary of Key Refinements Applied
- **Concise Path Role Clarification**: Succinctly distinguished `entrypoints` (ingress files such as route, CLI, webhook, queue listener) from `paths` (all in-scope files traversed end-to-end).
- **Suggested Canonical Lens Examples for Concerns**: Included active canonical audit lenses as examples (`security`, `correctness`, `reliability`, `data_integrity`, `performance`) while allowing custom tags if needed.
- **Explicit Empty Envelope Form**: Added unambiguous instruction: *"If no flows need to be added or upgraded, output `{ "flows": [] }`."*

#### Finalized Prompt Specification

````markdown
# Critical-flow fallback

Deterministic critical-flow inference fell below its confidence bar — <it found NO critical flows for this repository | <n> inferred flow(s) are low-confidence>.

A critical flow is an end-to-end user or system path whose failure has outsized
blast radius — authentication/session, billing/payment, data-write/migration,
async/queue processing, deploy/infra, or any repo-specific mission-critical path.

Review the repository and return an ADDITIVE enrichment of the flow map:
- ADD any genuine critical flow the deterministic pass missed (use a fresh id
  like `flow:host:<short-slug>`).
- UPGRADE a listed low-confidence flow by re-authoring it with its EXACT id
  above and `confidence: "high"`, correcting its entrypoints/paths/concerns.
- Cite only real repository paths. Do not invent files.
- Omit a flow you cannot substantiate. If no flows need to be added or upgraded, output `{ "flows": [] }`.

## Deterministic flows

- `<id>` [confidence: <confidence>] <name>
  entrypoints: <entrypoints>
  paths: <paths>
  concerns: <concerns>

## Output format

Write a single JSON object conforming to:

```json
{
  "flows": [
    {
      "id": "flow:host:checkout",
      "name": "short flow name",
      "entrypoints": ["src/api/checkout.ts"],
      "paths": ["src/api/checkout.ts", "src/billing/charge.ts"],
      "concerns": ["data_integrity", "security"],
      "confidence": "high"
    }
  ]
}
```

- `entrypoints`: Ingress files (e.g. API route, CLI handler, webhook, queue worker).
- `paths`: All in-scope files traversed end-to-end by the flow.
- `concerns`: Relevant lens tags for this path (recommend active audit lenses like `security`, `correctness`, `reliability`, `data_integrity`, `performance`, though custom tags are permitted).
- If no flows need to be added or upgraded, output `{ "flows": [] }`.
````

### 8. `charter_extraction` (`src/audit/cli/charterExtractionPrompt.ts`) — APPROVED (2026-09-15; supersedes the 2026-09-13 approval)

Re-specified from `spec/conceptual-design-review-design.md` §"The estimator charters", step 1
(three independent goal DAGs). The 2026-09-13 refinements (telos vs mechanism, symbol-first
citations, anti-slop, fixed JSON) all stand; the changes below are the design's, not wording.

#### Summary of Key Refinements Applied
- **Output is a goal DAG, not a node list.** Nodes carry a lane-minted local `node_id`; a new `edges` array states `from` SERVES `to`, and each edge carries its own provenance. Ids are local to one submission and never a join key.
- **`files` optional.** Structural and Revealed lanes name the files they describe; the Stated lane may cite provenance only (docs name goals and symbols, rarely files). The rendered packet-kind line states which rule applies to the lane.
- **`premise_height` dropped from the submission.** The tool derives each node's level from the edges; a lane-stated level that contradicts its own edges would be a validation issue, so the field is not asked for.
- **"Self-organize a Leveled Purpose Graph" becomes "Build your goal graph."** Same telos-versus-mechanism rule, same packet rule, same anti-slop list.
- **Backend Schema Evolution (Backlog)**: replace `CharterNodeInputSchema` and `CharterSubmissionSchema` in `src/shared/decompose/charterExtraction.ts` with a lane submission `{ kind, nodes[], edges[] }` built on `GoalNodeSchema` / `GoalEdgeSchema` from `src/shared/types/charter.ts`, extended with `files?`, `provenance`, `confidence` on nodes and `provenance` on edges; `TeleologyNodeSchema.files` loses `.min(1)`; `premise_height` becomes tool-derived (longest path from a root).

#### Finalized Prompt Specification

````markdown
# Design review — charter extraction, **<kind>** lane (conceptual, teleological)

You are authoring a high-level conceptual design review: not "is this module correct/clean" but
*"what is this code FOR, and does it serve that purpose as well as a better design could."*

Your review perspective:
- **<kind>** — <TESTIMONY: what docs/comments say | intent FROZEN INTO ORGANIZATION | BEHAVIOR: what code actually optimizes for>

## Core Concepts: Purpose vs. Mechanism

- **Purpose (Telos / The WHY)**: The problem this code exists to solve for users or the system.
- **Mechanism (The WHAT / HOW)**: The specific technical implementation.

- *Telos (DO emit)*: *"Ensures independent audit workers fairly share provider quotas without starving critical security checks."*
- *Mechanism (do NOT emit)*: *"Manages rate limits using a Redis token bucket."* A purpose that restates the code cannot show an architectural gap.

## Your evidence packet

Read `<packetPath>` — it holds the evidence for this review. Cite claims from this packet by symbol and literal quote, not by line number; you do not need to open files outside it.

<Your packet holds the repo's doc files plus comments | file tree + declarations | comment-stripped source>

## Build your goal graph

Organize the purposes you find into one directed graph with no cycles. An edge `from → to` means the child purpose SERVES the parent purpose. A purpose may serve more than one parent. The tool derives each node's level from your edges.

Each node carries:
- `node_id` — a short slug you choose; it is local to this submission.
- `purpose` — the telos statement (the WHY, not the WHAT).
- `provenance` — evidence citations: `<path>#<symbol>` with a literal quote, or `<path>:<line>` for comments and unnamed blocks.
- `confidence` — `"high"` | `"medium"` | `"low"`.
- `files` — <Structural/Revealed: the in-scope files that implement this purpose, as relative paths matching your packet. | Stated: optional; include only files your evidence names.>

Each edge carries `from`, `to`, and `provenance` for the relationship itself.

A suggested scaffold from structure analysis (a hint — adjust boundaries where evidence supports it):
- <count> file(s): <preview>

You author teleology ONLY — do NOT review code correctness.

## Anti-slop discipline (do NOT emit)
- No **restated-mechanism** purposes; describe the WHY, not the WHAT.
- No **generic** telos any subsystem could claim; be specific to THIS code.
- No **fabricated profundity**; every node and edge cites provenance from your packet.
- No files outside your packet; the limited view is intentional.

## Output

Write your submission as JSON to `<submissionPath>`:

```json
{
  "kind": "<kind>",
  "nodes": [
    {
      "node_id": "quota-fairness",
      "purpose": "Ensures independent audit workers fairly share provider quotas without starving critical security checks",
      "files": ["src/dispatch/quota.ts", "src/dispatch/pool.ts"],
      "provenance": [{ "kind": "code", "ref": "src/dispatch/quota.ts#QuotaManager", "quote": "class QuotaManager {" }],
      "confidence": "high"
    }
  ],
  "edges": [
    {
      "from": "quota-fairness",
      "to": "trustworthy-audits",
      "provenance": [{ "kind": "comment", "ref": "src/dispatch/quota.ts:12", "quote": "so no lens is starved" }]
    }
  ]
}
```

- `kind`: Must be `"<kind>"`.
- `provenance[].kind`: one of `code`, `doc`, `comment`, `intent_checkpoint`, `user_feedback`, `inferred`.
- Every `from` and `to` names a `node_id` in this submission.
````

### 9. `charter_comparison` (was `charter_delta`; `src/audit/cli/charterDeltaPrompt.ts`) — APPROVED (2026-09-15)

Re-specified from `spec/conceptual-design-review-design.md` §"The estimator charters", steps 2
(correspondences) and 3 (differences). The old delta-miner prompt, its triangulated telos and its
goal-graph authorship are superseded; the 2026-09-15 lane draft for the old prompt is moot.

#### Summary of Key Refinements Applied
- **Role.** "Independent delta-miner + triangulated telos + goal-graph author" becomes the comparison reader: confirm, reject, or widen each tool-proposed correspondence, add matches with one checkable ref per side, then record differences.
- **No unified telos, no goal graph authoring.** Both are gone; the three lane DAGs stay as persisted.
- **Typed differences.** Each record names its correspondence, one of the seven dimensions with its decision rule, one relation, each side's account with provenance, and for `presence` whether the silent channel should have covered the goal.
- **Routing, severity, and finding-ness are absent from the prompt.** The tool routes by `(dimension, relation, channels)` and the fidelity lane gates findings.
- **Backend Schema Evolution (Backlog)**: replace the `charter_delta_current` obligation and `CharterDeltaSubmissionSchema` (`src/shared/decompose/charterExtraction.ts`) with a `charter_comparison_current` obligation and a submission `{ correspondences[], differences[], no_correspondences? }`; add the deterministic candidate generator (file-scope overlap + provenance cross-refs from `src/audit/extractors/commentDecomposition.ts`) and the seven-dimension `difference_type` enum; re-key `DELTA_ROUTES` on `(dimension, relation, channels)`.

#### Finalized Prompt Specification

````markdown
# Design review — charter comparison (correspondences and differences)

Three readers each built a goal graph of this repository from one evidence channel:
**stated** (docs and comments), **structural** (file tree, declarations, imports), **revealed**
(comment-stripped code). Edges mean `from` SERVES `to`. You authored none of them. Your job is to
say which parts of the three graphs speak about the same thing, and how their accounts differ.
Do not merge the graphs and do not write a unified purpose; the three accounts stay separate.

## The three goal graphs

Read them at:
- stated: `<statedGraphPath>`
- structural: `<structuralGraphPath>`
- revealed: `<revealedGraphPath>`

## Candidate correspondences (tool-proposed)

Each candidate pairs regions the tool found related by file overlap or by a provenance
cross-reference. Confirm, reject, or widen each one; add any the tool missed.

- `<candidate_id>` — <kind>:`<node_id>` ↔ <kind>:`<node_id>` (basis: <file overlap | cross-ref `<ref>`>)

Rules:
- A correspondence may join one node to one node, several nodes, or a connected subgraph on the other side.
- A correspondence you add must cite one provenance ref per side; the tool re-checks both.
- A node that matches nothing stays uncorresponded. Do not force a match.

## Differences

For every confirmed correspondence, record each way the accounts differ. File each difference on
exactly one dimension; the rule says when it belongs there and not elsewhere:

| Dimension | File here when |
|---|---|
| `purpose` | Holding the subsystem fixed, the goal labels still contradict (an explicit non-goal against a pursued goal files here) |
| `presence` | No node at the same level matches in a channel that should cover the goal; a missing child goal counts here, at its level |
| `responsibility` | Goal labels match, owner or location differs |
| `hierarchy` | The node matches, the parents or subgoals differ |
| `scope` | Adding a when / for-whom / to-what-extent qualifier reconciles the claims |
| `standing` | The claims reconcile once versioned in time: planned, active, deprecated, removed |
| `standard` | Both agree on what and where, disagree on how well |

A difference holds the account of every channel in the correspondence — two or three. Give each
difference one relation judged across all of them: `equivalent` (same claim, other words),
`complementary` (no account contradicts another), or `incompatible` (some two cannot both hold).
For an `incompatible` difference also give the `split`: `two_against_one` with the odd channel
named, or `three_way`. For a `presence` difference, say whether the silent channel should have
covered the goal (`covered_channel_gap: true`).

## Output

Write your submission as JSON to `<submissionPath>`:

```json
{
  "correspondences": [
    {
      "candidate_id": "<tool candidate id, or omit for one you add>",
      "verdict": "confirm | reject | widen",
      "members": [
        { "kind": "stated", "node_ids": ["billing-trust"] },
        { "kind": "revealed", "node_ids": ["charge-capture", "fraud-check"] }
      ],
      "evidence": [{ "kind": "doc", "ref": "docs/billing.md#Goals", "quote": "..." }, { "kind": "code", "ref": "src/billing/stripe.ts#capture", "quote": "..." }]
    }
  ],
  "differences": [
    {
      "correspondence": "<index or candidate_id of the correspondence above>",
      "dimension": "standing",
      "relation": "incompatible",
      "split": { "kind": "two_against_one", "odd": "stated" },
      "accounts": [
        { "kind": "stated", "claim": "SSO is planned", "provenance": [{ "kind": "doc", "ref": "docs/roadmap.md:40", "quote": "SSO planned" }] },
        { "kind": "structural", "claim": "SSO is a shipped auth module", "provenance": [{ "kind": "code", "ref": "src/auth/index.ts#samlLogin", "quote": "export { samlLogin }" }] },
        { "kind": "revealed", "claim": "SSO login is implemented and wired", "provenance": [{ "kind": "code", "ref": "src/auth/saml.ts#samlLogin", "quote": "export function samlLogin" }] }
      ],
      "gap": "The roadmap describes as planned what the code already ships.",
      "covered_channel_gap": false
    }
  ]
}
```

- Every `node_id` must exist in the named graph. Every `kind` is one of `stated`, `structural`, `revealed`.
- `equivalent` differences are welcome: they corroborate the match.
- If no candidate and no addition corresponds anywhere, write `"correspondences": []` and `"differences": []` and set `"no_correspondences": true`.
````

### 9b. `charter_fidelity` (new renderer) — APPROVED (2026-09-15)

Specified from `spec/conceptual-design-review-design.md` §"The estimator charters", step 4
(fidelity). New prompt; no predecessor.

#### Summary of Key Refinements Applied
- **Separate reader.** The fidelity reader is a different lane from the comparison reader; separation is enforced by dispatch, so the prompt carries no identity plea (owner amendment 2026-09-15).
- **Blind by input.** The packet holds the difference records and the exact source slices their provenance cites; nothing else. Every quote was re-read from disk by the tool before the packet was built, so the prompt does not ask the reader to check quotes.
- **Three verdicts, nothing else.** `supported`, `interpretation` (naming the over-reading side), `unverifiable`. No severity, no routing, no rewrite of the difference.
- **Backend Schema Evolution (Backlog)**: new `charter_fidelity_current` obligation after `charter_comparison_current`; a packet materializer that slices sources at the cited refs (extend `src/audit/orchestrator/charterPackets.ts`); a submission `{ verdicts[] }` stamped onto the difference records; only `supported` records reach the discrepancy report.

#### Finalized Prompt Specification

````markdown
# Design review — charter fidelity check

A comparison pass recorded differences between three accounts of this repository's goals: what
the docs say (**stated**), what the code's organization promises (**structural**), and what the
code does (**revealed**). For each difference, decide whether the two sources genuinely say
different things, or whether a reader read more into a source than it says.

## Your packet

Read `<packetPath>`. It holds, per difference: the two accounts, their cited provenance, and the
exact source slices at those citations. Judge from the slices only; every quote in them has
already been checked against disk.

## Verdicts

Give each difference exactly one verdict:
- `supported` — the cited sources genuinely make the two claims; the difference is in the sources.
- `interpretation` — one side's claim goes beyond what its cited source says. Name that side.
- `unverifiable` — the cited slices do not settle whether the claims differ.

Judge the claim against its own source, not against the other source. A claim can be
well-supported and still wrong about the code; that is not your question.

## Output

Write your submission as JSON to `<submissionPath>`:

```json
{
  "verdicts": [
    {
      "difference_id": "<id from the packet>",
      "verdict": "supported | interpretation | unverifiable",
      "over_read_side": "stated | structural | revealed",
      "rationale": "<one or two sentences citing the slice that decides it>"
    }
  ]
}
```

- One entry per difference in the packet; `over_read_side` only with `interpretation`.
- Every `difference_id` must come from the packet.
````

### 10. `charter_clarification` (`src/audit/cli/charterClarificationPrompt.ts`) — APPROVED (2026-09-15)

Re-specified from `spec/conceptual-design-review-design.md` §"The estimator charters", step 5 and
§"The triangulation loop", with the n-ary decision (differences hold two or three accounts).

#### Summary of Key Refinements Applied
- **Questions are the discrepancy report's investigation questions**, VOI- and blast-radius-ranked by the tool as before.
- **All accounts side by side, no opinion line.** The triangulated-telos line and the disagreement-density line are removed. Each question shows the dimension, the relation, the split, and every account in the correspondence with its citation.
- **N-ary answer.** The binary pair enum (`this_side_wins` / `that_side_wins`) is replaced by naming the governing channel, or `rewrite_all`, or `leave_open`.
- **Symmetry rule kept in one sentence.** Any account may move, including what the docs state.
- **Loop mechanics removed from the text.** "Partition, VOI-rank, risk-gate, split by attention" is tool history; the host sees "pre-ranked". Unanswered questions default to `leave_open` in the tool.
- **Backend Schema Evolution (Backlog)**: `CharterClarificationRequest` (`src/shared/types/charter.ts`) gains `difference_id`, `dimension`, `relation`, `split`, and `accounts[]` with provenance; `CharterClarificationAnswerSchema` becomes the union `{ governs: CharterKind } | "rewrite_all" | "leave_open"`; the renderer drops its reads of `charter_register.triangulated` and `charter_register.disagreement`.

#### Finalized Prompt Specification

````markdown
# Design review — charter clarification

Below are this run's highest-leverage charter questions, pre-ranked. Each comes from a verified
difference between accounts of the same goal. Any account may move — including what the docs
state — so never frame a question as "your code violates your intent, shall we fix the code?"

Relay each question to the user and record ONE answer per question:

- `governs: <channel>` — that channel's account governs; the others move to match.
- `rewrite_all` — none as-is; the accounts rewrite to a third thing.
- `leave_open` — a deliberate held tension (a decision, not a failure).

## Questions

### Q<n> — subsystem `<node_id>` · <dimension> · <relation> · <two_against_one: <odd channel> | three_way>
- request_id: `<request_id>`
- blast radius: <blast_radius>; cascade: <cascade_count>
- **stated** says: <claim> — `<ref>` "<quote>"
- **structural** says: <claim> — `<ref>` "<quote>"
- **revealed** says: <claim> — `<ref>` "<quote>"
  (only the channels in the correspondence appear; two or three)

<question text>

## Output

Write the answers as JSON to `<answersPath>`:

```json
{
  "answers": [
    { "request_id": "<one of the request_ids above>", "answer": { "governs": "stated | structural | revealed" } },
    { "request_id": "<one of the request_ids above>", "answer": "rewrite_all" },
    { "request_id": "<one of the request_ids above>", "answer": "leave_open" }
  ]
}
```

If the user stops mid-loop, write answers for what is resolved and leave the rest unanswered
(unanswered questions stay `leave_open`). When the answers are written, run:

  <continueCommand>
````

### 13. `semantic_review` (`src/audit/cli/semanticReviewStep.ts`) — APPROVED (owner, 2026-09-17)

⚠ **This spec is the lane DRAFT. The landed prompt differs**: the owner's answer
("Third section, chosen by a shared rule") adds a THIRD issue section, so the "two lists kept"
bullet and the two-section example below are superseded. Read the tracker row for prompt 13 in
Part 3 for what landed.

#### Summary of Key Refinements Applied
- **One repair instruction, two lists kept**: The "Results not yet written" and "Result status requiring attention" headings stay (the split is on the issue CODE, so a host parser never reads message text), but the paragraph that explains why a bound path can move is cut to one sentence: the republished workload is the authority for every `result_path`.
- **Advisory warnings stay, labelled**: "Advisory notes on accepted results" is kept because the host may re-run an accepted item on its own initiative; the word ACCEPTED in each bullet is what stops it reading as a refusal.
- **Removed the "provider-neutral" qualifier**: The host does not need the architecture label; it needs the path.
- **Positive execution directive**: "Execute every work item using the host facilities available in this conversation" and the negative "do not edit audit state or hand-merge results" become two imperative steps. Hand-merged results are already refused by `ingestAuditHostResults` (result identity + prompt digest binding), so the plea is redundant.
- **No backend change required**: every heading and locator the prompt carries today is preserved.

#### Finalized Prompt Specification

````markdown
# audit-code semantic review

## Results not yet written

- `<work_item_id>` (<code>): <message> (`<result_path>`)

## Result status requiring attention

- `<work_item_id>` (<code>): <message> (`<result_path>`)

Each item above is still pending and is republished in the workload below. Write its result at the `result_path` the workload binds — the workload is the authority for every path.

## Advisory notes on accepted results

- `<work_item_id>` was ACCEPTED; advisory: <message>

Read the workload at: <workload_path>

For each work item in the workload:
1. Follow its prompt.
2. Write the result JSON at its bound `result_path`.

When the results are written, run: <continueCommand>
````

(The three issue sections render only when they have entries; the empty sections are omitted, as today.)

#### Evidence
- Renderer: `src/audit/cli/semanticReviewStep.ts#renderSemanticReviewStep`; sections from `renderIngestIssueLines` and `renderValidationWarningLines` in the same file.
- Consumer/validator: `src/audit/cli/dispatch/hostHandoff.ts#ingestAuditHostResults` reads `host-workload.json`, `host-result-map.json`, `host-task-bindings.json`; `parseHostResult` binds `run_id`, `work_item_id`, `prompt_sha256` — a hand-merged or moved result is refused mechanically.

---

### 14. `synthesis_narrative` (`src/audit/reporting/synthesisNarrativePrompt.ts`) — APPROVED (owner, 2026-09-17)

⚠ **The landed prompt goes BEYOND this spec, on the owner's three answers.** Read tracker row 14 for
what shipped. Three things below were written before the defects were measured and are superseded:

1. The findings list is now ordered MOST-SEVERE-FIRST before the 120-finding cap applies. This spec
   is silent on order, so it reads as an endorsement of the merge-order cut it inherited.
2. The overflow line names the findings report by the path the step GRANTS, not the bare filename
   `audit-findings.json` written below. A path a lane cannot open is worse than no path.
3. "The first theme that lists an id keeps it" is OVERTURNED. A finding claimed by two themes now
   refuses the whole narrative, at both the prompt and `applyNarrative`.

#### Summary of Key Refinements Applied
- **Removed the observational-vs-conceptual paragraph**: The host cannot tell which findings are "contract assessment" versus "design critique" from the rendered list (the line shows `severity/lens/category` only). Themes group by root cause; the distinction is a rendering concern of `synthesis.ts`, not the narrator's.
- **Negative plea folded into scope**: "Do not re-audit the code, change severities, or invent new findings" becomes one positive sentence: use only the listed findings, by exact id. Severity is not part of the output contract, so it cannot be changed anyway.
- **Closed-set rule stated once, in the output section**: The unknown-id refusal and the one-theme-per-finding rule move under "Rules" in three short lines; the "you will be asked to re-submit it" clause is dropped (the refusal message in `applyNarrative` already says it).
- **Overflow note kept, stderr note removed from spec**: The `... and N more findings` line stays in the prompt (the host must not invent ids for those). The `process.stderr.write` truncation notice is tool telemetry and does not belong in the prompt; leave it in code.
- **No backend change required**: the JSON shape and the `SynthesisNarrative` contract are unchanged.

#### Finalized Prompt Specification

````markdown
# Synthesis narrative

The deterministic audit is complete. Group the finalized findings below into a small number of root-cause themes, write a short executive summary, and list the top risks. Use only the findings listed here, referenced by their exact `id`.

## Summary

- Findings: <finding_count>
- Work blocks: <work_block_count>

## Findings

- <id> [<severity>/<lens>/<category>] <title> — <summary> (files: <up to 4 paths>)
  ... and <n> more findings (see audit-findings.json).

## Output format

Write a single JSON object conforming to:

```json
{
  "themes": [
    {
      "theme_id": "T-001",
      "title": "short root-cause title",
      "root_cause": "what underlying cause ties these findings together",
      "finding_ids": ["<finding id>", "..."],
      "suggested_fix_pattern": "the shared remediation approach for this theme"
    }
  ],
  "executive_summary": "2-4 sentence overview of the audit outcome",
  "top_risks": ["highest-impact risk", "..."]
}
```

Rules:
- Every `finding_ids` entry is an id listed above, copied exactly. One unknown id refuses the whole narrative.
- A finding belongs to at most one theme. The first theme that lists an id keeps it.
- Prefer a few substantive themes over many thin ones.
````

#### Evidence
- Renderer: `src/audit/reporting/synthesisNarrativePrompt.ts#renderSynthesisNarrativePrompt` (`MAX_RENDERED_FINDINGS` = 120 governs the overflow line).
- Consumer/validator: `src/audit/reporting/synthesis.ts#applyNarrative` — throws on any unknown `finding_ids` entry AND on any finding two themes claim (the first-claiming rule this spec described was overturned by the owner, 2026-09-17); reads `theme_id`, `title`, `root_cause`, `finding_ids`, `suggested_fix_pattern`, `executive_summary`, `top_risks`. Contract type `SynthesisNarrative` in `src/shared/types/finding.ts`.

---

### 15. `dispatch_review` worker prompt (`src/audit/cli/dispatch/hostHandoff.ts`) — PROPOSED

#### Summary of Key Refinements Applied
- **Contract lines stay derived**: `findingContractPromptLines` (from `WorkerFindingSchema` + `AUDIT_RESULT_RULES`) and `verificationContractPromptLines` (from `VERIFICATION_CONTRACT_KEYS` / `VERIFICATION_FOLLOWUP_KEYS`) are rendered from the schemas ingestion enforces. They are the mechanism, not pleading, and are kept verbatim.
- **Removed the `grounding` plea**: `WorkerFindingSchema` is `.strict()` and omits `grounding`, so a supplied field is already refused by the parser. The sentence is replaced by one neutral line: "`grounding` is computed at ingest; do not include it." (The information that the tool re-reads `quoted_text` is useful to the host, so a short form stays.)
- **Fixed the boundary claim**: The follow-up rule says `file_paths` must lie "within THIS work item's file_coverage or packet boundary". `verificationAllowedPathsForEnvelope` admits only the binding's file set plus the envelope's `file_coverage` paths; there is no packet boundary at the host door. The prompt now states the rule the validator applies.
- **Assignment block made readable**: `Assignment: <one-line JSON>` becomes a fenced JSON block. The prompt digest covers the text, so this is a rendering change only; every field stays.
- **Envelope sentence lead with the file**: State "write one JSON object at `<result_path>`" before the contract so the host reads the destination first.
- **Backend Schema Evolution (Backlog)**: none required. The boundary wording fix is a one-line change in `verificationContractPromptLines`, which changes every steward prompt digest for a run in flight; ship it between runs.

#### Finalized Prompt Specification

````markdown
Perform the bounded semantic audit work item below. Review every listed file. Write one JSON object at the bound `result_path`.

Assignment:
```json
{
  "file_line_counts": { "<path>": <lines> },
  "files": ["<path>"],
  "lens": "<lens>",
  "pass_id": "<pass_id>",
  "rationale": "<rationale>",
  "result_path": "<result_path>",
  "task_id": "<task_id>",
  "unit_id": "<unit_id>"
}
```

Result contract: audit-host-result/v1alpha1 with exactly result_id, run_id, work_item_id, prompt_sha256, file_coverage, and findings in addition to contract_version. [steward lane: "..., findings, and verification ..."]
Each file_coverage entry must contain exactly path, reviewed_lines, and total_lines.
<findingContractPromptLines(): required fields, non-empty rules, array-shape rules, closed vocabularies, optional-field descriptions, and every AUDIT_RESULT_RULES line — unchanged>
`grounding` is computed at ingest by re-reading each finding's `quoted_text` from disk; do not include it.

[steward lane only]
This work item is a LENS STEWARD VERIFICATION task, so it also accepts an optional `verification` object.
verification, when present, must contain exactly verified, needs_followup, concerns, coverage_concerns, confidence_concerns, followup_tasks — all six, with no extra key: verified and needs_followup are booleans, concerns, coverage_concerns and confidence_concerns are arrays of non-empty strings (a genuine "nothing to report" is an empty array, not an omitted field), and followup_tasks is an array of objects.
Each verification.followup_tasks entry must contain exactly task_id, unit_id, pass_id, lens, file_paths, rationale — all six, with no extra key: file_paths is a non-empty array of non-empty repo-relative strings, each naming a file in THIS work item's assigned files or its file_coverage; lens must be the lens of THIS task; task_id, unit_id, pass_id and rationale must be non-empty strings.
Set needs_followup true only when followup_tasks is non-empty — a follow-up request with no bounded task is refused.
````

#### Evidence
- Renderer: `src/audit/cli/dispatch/hostHandoff.ts#buildPrompt` (lane predicate `isVerificationLane` on `LENS_VERIFICATION_TAG`); contract lines from `src/audit/contracts/findingContractPrompt.ts#findingContractPromptLines` and `hostHandoff.ts#verificationContractPromptLines`.
- Consumer/validator: `hostHandoff.ts#parseHostResult` (exact envelope keys, identity binding, `file_coverage` equality with bound line counts); `verificationContractFailure` + `verificationAllowedPathsForEnvelope` (binding file set + envelope coverage only); `WorkerFindingSchema` strict parse in `src/audit/contracts/workerSchemas.ts`.
- Unverified: whether a test pins the exact `grounding` sentence or the "packet boundary" phrase; check `tests/audit/` before the edit.

### 18. `contract_pipeline` (`src/remediate/steps/contractPipelinePrompts.ts`) — APPROVED (owner, 2026-09-18; see the Part 3 row for what landed)

Two exported renderers share one template substrate: the phased worker prompt
(`renderContractPipelinePrompt`, generic over 15 `ROLES` entries) and the
gate-ordered repair prompt (`renderContractRepairPrompt`, 2 triggers × 3 targets).
Each is specified separately below.

#### 18a. `renderContractPipelinePrompt` — phased worker prompt (15 roles, one template)

##### Summary of Key Refinements Applied

- **Trimmed role descriptions to task + contract**: the `decomposition`, `judge`, and `implementation_planning` descriptions carry the longest legalistic prose in the file (shim/barrel rules, expressibility surfaces, traceability rejections); cut each to the task directive plus the one field rule the author must get right first time.
- **Moved gate-failure warnings out of descriptions (G)**: phrases like "the enforcing gate (`validateDecompositionFileScope`) will reject a shim-only `file_scope`", "untraceable nodes are rejected", and "an omitted companion file stalls the work item on a mid-run clarification" expose backend refusal mechanics; replaced with the positive instruction (scope at the real-logic file; list every obligation/counterexample id; declare every file the node creates or edits).
- **Fixed the self-contradicting read scope (F)**: the template says "Read only the artifact files listed above. Do not read unrelated source files" while `decomposition` and `module_contract_drafting` descriptions order the worker to open repository files to verify `file_scope`; replaced with a bounded rule that permits exactly the repo reads the role names.
- **Kept the stop scope to one plain sentence (D)**: "Stop after writing the output file. Do not edit source files. Do not advance" states the write boundary once without repeated negative threats; write-scope beyond that is tooling's job at ingestion.
- **Kept the capability-neutral independence mandate (E)**: `renderIndependentReviewMandate` keys on lane class (adversarial review of another agent's work), not on host-reported capability, with the explicitly-degraded inline fallback in the same text — this already follows the Part 1 Issue E fix pattern, so it is preserved verbatim, not reworded.
- **Kept enforcement-adjacent field rules where they earn their keep**: the `implementation_planning` one-invocation-per-entry `targeted_commands` rule (`renderOutputConstraints`) and the `artifact:<name>` producer/consumer token rule stay in the prompt because the tool can only refuse after the fact and an unstated rule re-earns the refusal; both are single-sourced (`commandLeavesDeclaredShape`, token matching in the DAG derivation).
- **Preserved every contract placeholder**: `<title>`, `<description>`, `<repoRoot>` cwd note, `<inputs>` derived from `DEPENDENCY_MAP`, `<sourcePaths>`, `<pathASeedPath>`, `<outputPath>`, the role's JSON schema shape, the `validate-artifact` self-check command, and the `light`/`full` adversarial-depth switch.

##### Finalized Prompt Specification

````markdown
# <title>

<description: one task directive plus the role's field rules, no gate names>

> Set the shell/tool working directory to `<repoRoot>` before running any commands.

<for critique | critic | judge only — adversarialDepth full (default): the Independent Review mandate; adversarialDepth light: the light inline self-check>

## Required Inputs

- `<artifactPath>` (<artifactName>)
  (derived from the dependency map; `_No artifact inputs required for this role._` when empty)

## Source Inputs

- `<sourcePath>`

## Path-A Audit Seed

- `<pathASeedPath>` (path_a_seed) — frame the goal and context around these findings so every downstream node traces to an auditor finding.

## Your Task

Read the artifact files above. You may additionally open only the repository
files your role names (e.g. a module's `file_scope` to verify where logic
actually lives). Do not browse unrelated source.

Write the complete artifact to exactly:

`<outputPath>`

It must conform to this JSON shape:

```json
<outputSchema>
```

<Role-specific field rules (stated where the field is authored):>
- `decomposition`: scope each module at the file where the real logic lives, never at a thin re-export shim / barrel.
- `contract_finalization`: tag each shared artifact identically in the producer's `outputs` and the consumer's `inputs` as `artifact:<name>`; never hand-add `depends_on` edges.
- `judge`: verdict `approved` only when no accepted counterexample demands repair (then omit `repair_directive`); otherwise `needs_repair` with the single artifact whose own schema can express the fix — a remedy needing a new field, module, or structured data is `residual_risk`, never `accepted`.
- `implementation_planning`: every node traces to an obligation id or accepted-counterexample id; declare in `output_files` EVERY file the node creates or edits. Each `targeted_commands` entry runs as ONE shell invocation — write `"npm run build"` and `"npm run check"` as TWO entries, never chained, piped, redirected, or substituted.

Self-check before advancing:

`<validate-artifact --name <artifactName> --file <outputPath> [--root <repoRoot>]>`

`status: "ok"` means the structure is valid; fix reported issues before running next-step.

**Stop after writing the output file.** Do not edit source files. Do not advance to the next pipeline step.
````

##### Evidence

- Renderer: `src/remediate/steps/contractPipelinePrompts.ts#renderContractPipelinePrompt` (helpers `requiredInputKeysFor`, `renderIndependentCriticDirective`, `renderOutputConstraints`; role table `ROLES`, order map `PHASE_TO_ARTIFACT` / `CONTRACT_PIPELINE_PHASE_ORDER`).
- Input derivation: `src/remediate/contractPipeline/artifactStore.ts#DEPENDENCY_MAP` (the prompt's input list is read off the same map that drives staleness, so the two cannot drift).
- Consumer/validator: `src/remediate/validation/contractPipeline.ts#CONTRACT_PIPELINE_VALIDATORS` (one validator per artifact: `validateGoalSpec`, `validateContextBundle`, `validateModuleDecomposition`, `validateModuleContracts`, `validateSeamReconciliationReport`, `validateFinalizedModuleContracts`, `validateConceptualDesignCritique`, `validateObligationLedger`, `validateCyclicSeamResolution`, `validateTestValidatorPlan`, `validateContractAssessmentReport`, `validateCounterexample`, `validateJudgeReport`, `validateImplementationDAG`, `validateVerificationReport`; each requires `contract_version`, `goal_id`, the role's fields, and tool-stamped `created_at`).
- Self-check command: `src/remediate/index.ts#runValidateArtifactAction` (unwraps the content-hash envelope via `isEnvelope`, stamps `created_at`, runs the structural validator plus `evaluateContractPipelineCrossGateOutcomes` phase-scoped to artifacts authored at or before this one); command string via `src/remediate/steps/prompts.ts#loaderCommand`; mandate text via `src/shared/prompts.ts#renderIndependentReviewMandate`.
- Cross-artifact gates: `src/remediate/validation/contractPipelineGates.ts#evaluateContractPipelineCrossGateOutcomes` (what fields it requires beyond the per-artifact shape was not enumerated here — stated plainly as unverified at field level).
- Any claim I could not verify from source: I did not read the ingestion call site in `src/remediate/steps/contractPipeline.ts` beyond confirming it imports and calls `CONTRACT_PIPELINE_VALIDATORS`; whether a write-scope gate (analogous to `allowed_files` in the implement-phase handoff) binds these artifact-only roles was not verified, so the "do not edit source files" line is kept as a plain instruction rather than attributed to a named enforcer.

#### 18b. `renderContractRepairPrompt` — gate-ordered contract repair (judge | critique × 3 targets)

##### Summary of Key Refinements Applied

- **Preserved the trigger-as-data design**: `REPAIR_TRIGGER_CONTRACT` names the gate that actually fired (`judge`: "adversarial judge rejected"; `critique`: "conceptual design critique raised BLOCKING concerns") with the input set that trigger genuinely binds — this already closes the observed 2026-08-22 defect (critique repairs listing judge-side artifacts that do not exist on disk), so no reframing is proposed.
- **Kept the full-rewrite contract explicit**: "Rewrite the complete, corrected artifact (not a diff)" stays, because ingest expects a whole artifact payload and a diff-shaped write would fail validation.
- **Compressed the downstream note to one clause**: "Downstream artifacts are re-derived automatically — do not edit any other artifact" keeps the scope instruction while dropping the second mention of the staleness DAG mechanism.
- **Preserved every contract placeholder**: `<target>`, `<trigger>` lead and `<instructionHeading>`, `<instruction>`, the trigger's `<requiredInputs>` paths, `<repoRoot>` cwd note, `<outputPath>`, and the target's schema from `REPAIR_TARGET_SCHEMA`.
- **No backend change proposed**: the three repair targets reuse their producing roles' schemas, so the prompt introduces no new contract field.

##### Finalized Prompt Specification

````markdown
# Contract Repair: <target>

<judge: The adversarial judge rejected the current contract. Regenerate `<target>` IN FULL so that every judge-accepted counterexample is addressed. | critique: The conceptual design critique raised BLOCKING concerns about the current design. Regenerate `<target>` IN FULL so that none of those concerns still applies.>

> Set the shell/tool working directory to `<repoRoot>` before running any commands.

## <Judge Instruction | Blocking Concerns>

<instruction>

## Required Inputs

- `<artifactPath>` (<artifactName>)
  (judge: `goal_spec`, `finalized_module_contracts`, `obligation_ledger`, `contract_assessment_report`, `counterexample`, `judge_report` — attend to the accepted counterexamples in the judge report's classifications. critique: `goal_spec`, `finalized_module_contracts`, `conceptual_design_critique` — read each blocking concern's own description before rewriting.)

## Your Task

Read the inputs above. Rewrite the complete, corrected artifact (not a diff) to exactly:

`<outputPath>`

It must conform to this JSON shape:

```json
<outputSchema for the target>
```

Downstream artifacts are re-derived automatically — do not edit any other artifact.

**Stop after writing the output file.** Do not edit source files. Do not advance to the next pipeline step.
````

##### Evidence

- Renderer: `src/remediate/steps/contractPipelinePrompts.ts#renderContractRepairPrompt` (contract table `REPAIR_TRIGGER_CONTRACT` with `lead`, `instructionHeading`, `requiredInputs`, `readingNote` per trigger; schema map `REPAIR_TARGET_SCHEMA` sourcing `ROLES.contract_finalization` / `ROLES.obligation_ledger` / `ROLES.assessment` output schemas).
- Consumer/validator: `src/remediate/validation/contractPipeline.ts#CONTRACT_PIPELINE_VALIDATORS` (`validateFinalizedModuleContracts`, `validateObligationLedger`, `validateContractAssessmentReport` — the repair output must satisfy the same per-artifact validator as a first write, since the repair overwrites the artifact in full).
- Self-check and cross-gates: `src/remediate/index.ts#runValidateArtifactAction` with `evaluateContractPipelineCrossGateOutcomes` (a repair-time write is self-checked like any write; downstream re-derivation afterwards is tooling's job).
- Any claim I could not verify from source: I did not trace the downstream re-derivation path (`buildNextContractPipelineStep` / `derive.ts` obligation-ledger intercept) to confirm exactly which artifacts are re-derived after each of the three repair targets, so "downstream artifacts are re-derived automatically" is kept as the prompt's own scope instruction rather than attributed to a named derivation symbol.

### 19. `verify_remediation` (`src/remediate/steps/prompts.ts`) — APPROVED (owner, 2026-09-18; see the Part 3 row for what landed)

#### Summary of Key Refinements Applied
- **No Renderer Exists — State It Plainly**: `src/remediate/steps/prompts.ts` exports ten functions (`loaderCommand`, `clarificationPrompt`, `ambiguityReviewPrompt`, `reviewApprovalPrompt`, `triagePrompt`, `formatIntakeSources`, `extractedPlanDiscardedPrompt`, `collectStartingPointPrompt`, `synthesizeIntakePrompt`, `collectIntakeClarificationsPrompt`) and no `verify_remediation` renderer; no `verify_remediation` step kind is emitted anywhere in `src/remediate/steps/nextStep.ts`. There is no prompt to rewrite.
- **Absence Is the Desired End-State**: Verification is already enforced mechanically, which is exactly Part 1 Principle 1 ("Tooling Enforces, Prompts Instruct"). Adding a host prompt that pleads for test-proof, suite-green, or diff-scope properties would recreate Issue D against checks the tool already guarantees.
- **Mechanical Verifiers Named**: Per-item verification is `parseResult` plus `corroborateHostResult` plus `rerunRequiredTests` (all in `src/remediate/steps/dispatch/hostHandoff.ts`); the whole-repo floor is the tool-owned final gate (`toolOwnedFinalGateCommands` in `src/remediate/steps/gateCommands.ts` — ⚠ on the audit-tools repository ONLY; elsewhere it returns no commands, the gate records `scoped_out`, and the close phase's `plan.test_command` is the only whole-repository suite — surfaced as the `final_gate_red` pause from `emitFinalGateRedStep` in `src/remediate/steps/nextStep.ts`); close-gate legs are `verifyAnalyzerLeads` and `verifyHeadEvidenceAgainstFindings` (imported by `src/remediate/phases/close.ts`).
- **Only Host-Visible Verification Text Already Avoids Pleading**: The `final_gate_red` pause names the failing command, the record path holding the output tail, and the cache binding that moves it — concrete nouns, no repeated negative threats, no provider/routing fields.
- **Stale Inventory Row (Docs Backlog, No Code Change)**: Part 2 row 19 of `docs/reviews/prompt-refinement-2026-09-13.md` describes a `verify_remediation` prompt ("verify test proofs, full suite, diff scope, record evidence") that has no renderer; the row should be corrected to point at the mechanical verifiers above rather than at `src/remediate/steps/prompts.ts`.
- **No New Contract Field**: No output contract is emitted by any verify step, so there is nothing to preserve and no schema evolution to propose.

#### Finalized Prompt Specification

````markdown
# Verify remediation — no host prompt (verification is mechanical)

No `verify_remediation` prompt is emitted. Verification is enforced by the tool, never pleaded for in prose:

- Each work-item result must pass the ingest contract gate and git corroboration before any item advances.
- Each item's required tests are re-run mechanically at ingest; a red, hung, or over-buffer suite refuses the item regardless of what the result file claims.
- On the audit-tools repository only, a repository-wide build/typecheck/test gate runs at each phase boundary and before close; a red gate pauses the run without changing any item status. On any other repository that gate records `scoped_out`, and the close phase's `plan.test_command` is the only whole-repository suite (a gap logged in `docs/backlog/open-bugs.md`).

The only host-visible verification text is the gate-red pause, which names the failing command, the record path with its output tail, and what unblocks the run.
````

#### Evidence
- Renderer: none — `src/remediate/steps/prompts.ts` exports no verify renderer (all ten exports enumerated above); `src/remediate/steps/nextStep.ts` emits no `verify_remediation` step kind.
- Consumer/validator: `src/remediate/steps/dispatch/hostHandoff.ts#parseResult` (exact result/decision keys, identity binding, write scope, commit/test/obligation/worktree evidence, landing attestation), `#corroborateHostResult` (commit existence, baseline ancestry, HEAD reachability, diff-tree equality, dirt overlap, test rerun), `#rerunRequiredTests`; `src/remediate/steps/gateCommands.ts#toolOwnedFinalGateCommands`; host-visible pause `src/remediate/steps/nextStep.ts#emitFinalGateRedStep`.
- Could not verify from source: bodies of `verifyAnalyzerLeads` (`src/remediate/phases/closeVerifyAnalyzerLeads.ts`) and `verifyHeadEvidenceAgainstFindings` (`src/remediate/phases/closeVerifyHeadEvidence.ts`) were not read — names taken from the import block of `src/remediate/phases/close.ts`. Claim that no other file renders a verify prompt rests on step-kind enumeration in `nextStep.ts`, not on an exhaustive tree-wide search.

### 20. `host_handoff` (remediate worker item prompt) (`src/remediate/steps/dispatch/hostHandoff.ts`) — APPROVED (owner, 2026-09-18) with changes; the Part 3 row states what supersedes this draft

#### Summary of Key Refinements Applied
- **Cut Digest-Restoration Meta-Commentary (B)**: Dropped "The workload was restored from its tool-owned digest when necessary" from the host prompt footer — backend self-description the host cannot act on; the repair instruction that follows it is kept.
- **Replaced Dispatch Jargon (E)**: "The complete, dependency-safe current frontier" becomes "the work items ready now — dependencies and phases already checked", and "Do not start a later dependency level" names what is forbidden in plain terms.
- **Kept the No-Inventory Sentence Concrete**: "Audit-tools makes no launch, routing, or quota decision" is retained verbatim in spirit — it states the CLAUDE.md "No execution inventory" invariant once, plainly, with no repeated negative threats (no Issue D).
- **Kept Every Parsed Field**: The worker spec preserves the full `Assignment` JSON shape, both result contracts with their exact key sets (checked by `hasExactKeys` in `parseResult`), the per-obligation coverage rule, the decision-contract alternative, and the baseline/test/landing bindings the corroboration re-derives.
- **Compressed Worker Legalese (C)**: Fused the baseline/test/acceptance/merge bindings into one bulleted contract list instead of three dense sentences, without dropping any enforced property.
- **No Backend Change**: Every field the rewritten prompts name is already parsed by `parseResult`/`parseWorkItem`; no new contract field is proposed.

#### Finalized Prompt Specification

````markdown
# Implement the eligible remediation workload

Read the workload at:

`<workload_path>`

It lists the work items ready now — dependencies and phases already checked. For each item, follow its bound prompt and write the result contract to its `result_path`.

You own execution choices, grouping, and concurrency; audit-tools makes no launch, routing, or quota decision. Do not start items from a later dependency level.

<Append only the sections that apply:>

## Results landed but result file missing

- `<id>`: edits already landed (a corroborated commit is on record) but no result file exists at `result_path`. Write the result for that commit; do not redo the edit.

## Results refused — repair and rewrite

- `<id>`: <reason> (`<result_path>`)

## Results not yet written

- `<id>`: <reason> (`<result_path>`)

Repair or complete only the named result files.

After all changes are merged and every result file exists, run:

`<next_step_command>`
````

````markdown
Implement the bounded remediation work item below. Apply every assignment exactly, including any clarified scope or retry context.

Edit only files in `allowed_files` (a trailing `/` authorizes descendant files; any other entry authorizes that exact file). Run every required test. Land one commit whose changed-file set is exact. Write one JSON result to `result_path`.

Assignment: <assignment_json — id, finding_ids, allowed_files, baseline_commit, required_tests, result_path, assignments, plus module_contracts / obligation_ids when bound>

<Include when module_contracts is bound:> `module_contracts` carries the APPROVED contract for each module. Conform to every declared input, output, invariant, side effect, validation boundary, failure mode, and seam adjustment. A locally plausible interface that contradicts them is a defect even when the build and tests pass.

Write contract `<result_contract_version>` with exactly these keys: contract_version, result_id, run_id, work_item_id, prompt_sha256, changed_files, commit_evidence, test_evidence, obligation_evidence, worktree_evidence, acceptance, merge.

- `changed_files`: sorted, unique, normalized paths within `allowed_files`.
- `commit_evidence.before` and `worktree_evidence.baseline_commit` equal `baseline_commit`; `commit_evidence.after` is a distinct commit.
- `test_evidence`: one `{command, status: "passed"}` entry per required test, in order.
- `obligation_evidence`: one `{obligation_id, evidence}` per bound obligation id, each with at least one non-empty citation — or an empty array when no obligations are bound.
- `acceptance.status` is `accepted`; `merge.status` is `merged`.

If no edit should land, write contract `<decision_contract_version>` with exactly contract_version, result_id, run_id, work_item_id, prompt_sha256, outcome — one of `{status: resolved_no_change, evidence: [non-empty strings]}`, `{status: blocked, failure_reason: non-empty string}`, or `{status: needs_clarification, question: non-empty string, optional category}`.
````

#### Evidence
- Renderer (host): `src/remediate/steps/nextStep.ts#buildImplementDispatchStep` (prompt text) with the ingest report from `#remediationIngestReportLines`, over the shared `renderIngestReportLines` (`src/shared/submission/ingestReport.ts`).
- Renderer (worker item): `src/remediate/steps/dispatch/hostHandoff.ts#buildPrompt` (nine-sentence join plus `Assignment` JSON blob, `module_contracts` paragraph, result/decision contract paragraphs).
- Consumer/validator: `src/remediate/steps/dispatch/hostHandoff.ts#parseResult` (requires exact keys for both contracts; identity binding on run/work-item/prompt-sha; `changed_files` sorted/unique/in-scope; baseline-bound distinct commit; per-command `test_evidence` echo with `passed`; exact obligation coverage; `worktree_evidence` equality; `accepted`/`merged` attestation), `#corroborateHostResult`, `#corroborateNoChangeClaim`, `#rerunRequiredTests`; workload binding `#parseWorkload` / `#parseWorkItem`; contract versions in `src/remediate/steps/types.ts` (`REMEDIATION_HOST_WORKLOAD_CONTRACT_VERSION`, `REMEDIATION_HOST_RESULT_CONTRACT_VERSION`, `REMEDIATION_HOST_DECISION_CONTRACT_VERSION`).
- Any claim you could not verify from source: state it plainly — all claims above were verified from the listed symbols.

### 11a. `design_review` — contract pass (`src/audit/orchestrator/designReviewPrompt.ts`) — APPROVED (owner, 2026-09-17)

#### Summary of Key Refinements Applied
- **Dropped worker-transport trivia**: removed the NIM/`json_object`-constraint explanation for the `{ "findings": [...] }` envelope; the prompt now states the envelope once without justifying it.
- **Dropped cache-eligibility meta-commentary**: removed the note about placing shared context first "to make it cache-eligible" (class B); ordering is a backend concern.
- **Plain adversarial directive**: kept "infer contracts, attack with counterexamples" but cut the triple restatement ("be adversarial / violated not satisfied / stay observational" compressed to two lines).
- **Single grounding rule**: the original repeats the real-path requirement in the example block and the grounding paragraph; stated once, naming the tool verdict (`groundDesignFinding` quarantines ungrounded findings) instead of pleading.
- **Concrete lens assignment**: kept the operator lens-scope block verbatim in behavior (it already names the list); dropped the "un-exercised" lecture to one sentence.
- **Kept contract categories**: the four category literals are part of the parsed contract and are unchanged.

#### Finalized Prompt Specification

````markdown
# Project contract review (adversarial pass)

You are performing the **contract-assessment** pass on this project. Infer the contracts the code relies on, then attack them with concrete counterexamples.

<shared structural context block>

<lens scope block, when the operator selected lenses>

## Contract assessment instructions

- Infer existing contracts from the repository artifacts and code you inspect: invariants, trust boundaries, preconditions, postconditions, data lifecycle obligations, and critical-flow guarantees.
- Report evidenced gaps where the code relies on an invariant or boundary that is missing, unenforced, unclear, or uncovered for a critical flow.
- Stay observational: do not invent a contract DSL, write a remediation plan, or remediate code.

## Output format

Write a JSON object with a top-level `findings` array to `<submissionPath>`:

```json
{
  "findings": [
    {
      "id": "DR-001",
      "title": "short descriptive title",
      "category": "one of: inferred_contract_gap, trust_boundary_gap, invariant_counterexample, critical_invariant_coverage_gap",
      "severity": "one of: critical, high, medium, low, info",
      "confidence": "one of: high, medium, low",
      "lens": "<the lens this finding belongs to>",
      "summary": "detailed explanation of the observation and the recommended change",
      "affected_files": [{"path": "relevant/file.ts"}],
      "systemic": true
    }
  ]
}
```

- Use finding IDs starting with DR-001.
- Cite at least one real `affected_files` path that exists in this repository. A finding that cites no real component is quarantined as ungrounded, not admitted as confirmed.
- Prefer fewer high-quality findings over many surface-level ones.
````

#### Evidence
- Renderer: `src/audit/orchestrator/designReviewPrompt.ts#renderContractReviewPrompt` (envelope example via `findingsEnvelopeExample`; lens echo via `exampleLens`; scope via `renderLensScope`)
- Consumer/validator: `src/audit/cli/laneValidators.ts#laneSubmissionValidator` (contract lane uses the tolerant array door, `unwrapSubmissionArray` — accepts a bare array or a single-array-valued object); `src/shared/validation/designFindingGrounding.ts#groundDesignFindings` (stamps `evidence_lane: "design-review-lane"`, strips host-supplied `lead_lineage`, quarantines findings with no real `affected_files` path); ingested at `src/audit/cli/nextStepHelpers.ts` (`contract_findings`)
- Any claim you could not verify from source: state it plainly. I could not verify the exact `<submissionPath>` footer text (stated by "the lane materializer's results-path footer", a symbol I did not locate); the spec carries it as a placeholder.

### 11b. `design_review` — conceptual pass, shallow (`src/audit/orchestrator/designReviewPrompt.ts`) — APPROVED (owner, 2026-09-17)

#### Summary of Key Refinements Applied
- **Cut roaming/reporting lecture**: the "reading grant, not a reporting grant" distinction is correct but was three sentences plus a code comment; kept as one rule.
- **Condensed first-principles questions**: six questions kept (they are the pass's value), each cut to one line; removed "starting questions, not a form to fill" meta-framing.
- **Single grounding rule**: same dedupe as 11a — the "quarantined, not admitted" warning appears once.
- **Charter block conditional kept**: the charter context is appended only when non-empty (byte-identical fallback); the spec marks it conditional rather than inlining it.
- **No new contract fields**: output shape unchanged (`findings` envelope, conceptual categories, DR-001 ids).

#### Finalized Prompt Specification

````markdown
# Project conceptual design review (generative pass)

You are performing the **conceptual-design-critique** pass on this project. Provide generative observations about broader architecture ideas that static analysis cannot produce.

<shared structural context block>

<lens scope block, when the operator selected lenses>

<subsystem charter context, when the run produced charters>

## Orient, then roam

Read the project's own documentation first (README, `docs/`, design notes, agent-instruction files) to learn what this project is trying to be. Then roam the actual code freely: read whole files, follow imports and call paths, and build your own mental model. Do NOT confine yourself to the highest-risk units.

Read anything you need to understand the system, but produce findings only about units marked `[in scope]` — an `[excluded: <reason>]` unit may inform your reasoning and be cited as evidence, never be a finding's target.

## How to think — first principles, not a checklist

- **Is the fundamental approach the right one?** What would a clean-sheet redesign do differently, and why?
- **What load-bearing assumption does this design rest on?** What breaks if it is wrong?
- **Where is the deepest structural risk?** What is fragile by construction as the system grows or changes hands?
- **Does the structure match the problem?** Where do boundaries fit, and where does one change ripple through many places?
- **What is the design optimizing for, and is that the right trade-off?**
- **What is missing that will be expensive to add later?**

Prefer the single change that would most improve the design over a long list of small ones. If the approach is sound, say so with the evidence that convinced you.

## Output format

Write a JSON object with a top-level `findings` array to `<submissionPath>`. Each finding conforms to:

```json
{
  "findings": [
    {
      "id": "DR-001",
      "title": "short descriptive title",
      "category": "one of: fundamental_approach, core_assumption, structural_risk, architecture_pattern, design_simplification, tool_opportunity, integration, missing_capability",
      "severity": "one of: critical, high, medium, low, info",
      "confidence": "one of: high, medium, low",
      "lens": "<the lens this finding belongs to>",
      "summary": "detailed explanation of the observation and the recommended change",
      "affected_files": [{"path": "relevant/file.ts"}],
      "systemic": true
    }
  ]
}
```

- Use finding IDs starting with DR-001.
- Cite at least one real `affected_files` path that exists in this repository; otherwise the finding is quarantined as ungrounded.
- Prefer fewer high-quality findings over many surface-level ones.
````

#### Evidence
- Renderer: `src/audit/orchestrator/designReviewPrompt.ts#renderConceptualReviewPrompt` (critique questions via `conceptualCritiqueInstructions`; format via `conceptualOutputFormat`; categories via `CONCEPTUAL_FINDING_CATEGORIES`; charter via `renderCharterContext`)
- Consumer/validator: `src/audit/cli/laneValidators.ts#laneSubmissionValidator` (conceptual lane accepts `ConceptualJudgeSubmissionSchema` or the tolerant array door); `src/shared/validation/designFindingGrounding.ts#groundDesignFindings` (same grounding/stamping as 11a); ingested at `src/audit/cli/nextStepHelpers.ts` (`conceptual_findings`)
- Any claim you could not verify from source: state it plainly. I could not verify the exact results-path footer wording for this lane; carried as `<submissionPath>`.

### 11c. `design_review` — conceptual pass, one perspective of the deep fan-out (`src/audit/orchestrator/designReviewPrompt.ts`) — APPROVED (owner, 2026-09-17)

#### Summary of Key Refinements Applied
- **Kept the isolation instruction**: "you will NOT see the other reviewers' output" is load-bearing (real fan-out, not imagined perspectives) and stays.
- **Cut balanced-coverage pleading**: "do not try to be balanced" compressed to one line; the judge owns merging, so the perspective need not be told what the judge does.
- **Same context dedupe**: shared structural context, lens scope, charter block, and critique questions are referenced as blocks, not restated.
- **Perspective sharpening kept**: "sharpen this lens to fit this codebase, but stay in character" is the one directive that prevents seven identical reviews; kept verbatim in behavior.
- **No new contract fields**: perspective submissions travel the same array door as the shallow pass.

#### Finalized Prompt Specification

````markdown
# Conceptual design review — perspective <i> of <total>: <perspective name>

You are **one of <total> independent reviewers**, each assigned a deliberately different value system. You will NOT see the other reviewers' output; a separate judge merges everyone's findings. Judge the whole codebase only through your assigned lens — do not cover the other angles.

## Your perspective: <perspective name>

<perspective lens>

You may sharpen or extend this lens to fit this codebase's character and domain, but stay in character.

<shared structural context block>

<lens scope block, when the operator selected lenses>

<subsystem charter context, when the run produced charters>

<orient-then-roam and first-principles blocks, as in the shallow pass>

## Output format

Report findings *from your perspective only*. Write a JSON object with a top-level `findings` array to `<submissionPath>`, using finding IDs starting with DR-001 and the same finding shape and conceptual categories as the shallow pass. Cite at least one real `affected_files` path per finding.
````

#### Evidence
- Renderer: `src/audit/orchestrator/designReviewPrompt.ts#renderConceptualPerspectivePrompt` (perspective roster via `CONCEPTUAL_PERSPECTIVES`; count/default via `clampPerspectiveCount` / `DEFAULT_CONCEPTUAL_PERSPECTIVES` / `selectPerspectives`)
- Consumer/validator: `src/audit/cli/laneValidators.ts#laneSubmissionValidator` (perspective lanes use the tolerant array door); `src/audit/types/conceptualAdjudication.ts#loadConceptualPerspectiveFindings` (parses each perspective file as array-or-`findings`-envelope of `SubmittedDesignFindingSchema`); `src/shared/validation/designFindingGrounding.ts#groundDesignFindings`
- Any claim you could not verify from source: state it plainly. None material: the fan-out/dispatch mechanics live outside this renderer and I make no claim about them beyond what the prompt text states.

### 11d. `design_review` — conceptual judge / merge pass (`src/audit/orchestrator/designReviewPrompt.ts`) — APPROVED (owner, 2026-09-17)

#### Summary of Key Refinements Applied
- **Kept every contracted field**: `round_id`, `candidate_dispositions`, `final_finding_shares` with their sub-fields are enforced by `ConceptualJudgeSubmissionSchema`; nothing was cut, only reworded.
- **Converted legalistic bullets to a checklist**: the six judging rules (merge, dedupe, resolve, rank, merit-not-consensus, drop-noise) were already sound; the `refuted_at_head`, per-candidate accounting, verification-status, and attribution paragraphs were convoluted (class C) and are restated as four compact rules with the same field requirements.
- **Named the enforcing schema**: the prompt no longer pleads for shares to "total exactly 100%" in three places; it states the requirement once and the schema enforces it.
- **Kept judge-added findings**: the `(judge-added)` convention and its evidence bar are the judge's unique value; kept in one line.
- **Dropped the provenance essay**: the comment explaining why the judge renders shared structural context is backend history, not host instruction; the block is rendered, not explained.

#### Finalized Prompt Specification

````markdown
# Conceptual design review — judge / merge pass

You are an **independent judge and final reviewer**. Several reviewers each examined this project through a different value system and wrote their findings to separate files. You did not author any of them. Merge them into one ranked, deduplicated result, AND add anything significant they collectively missed.

<shared structural context block>

<lens scope block, when the operator selected lenses>

## Perspective result files

Read each of these JSON finding submissions (each a `{ "findings": [ ... ] }` object):

1. **<perspective name>** — contributor `<contributor_id>` — `<result path>`
<... one line per perspective>

## Judging instructions

- **Merge** all findings into a single list. **Deduplicate** findings describing the same underlying observation; keep the clearest statement and note corroboration in the summary.
- **Resolve contradictions** on evidence; if genuinely unresolved, keep the finding and say so. **Rank** by impact and actionability.
- **Judge on merit, not consensus.** A lone but well-evidenced finding survives; corroboration raises confidence but is never a survival requirement. Drop only vague, unactionable, unsupported, or out-of-scope assertions.
- **Reject what HEAD has already fixed.** Check each candidate's named defect against the current code. A defect that is absent or already fixed is `rejected` with `verification_status: "refuted_at_head"`, never merged.
- **Flag what the perspectives missed.** Add significant whole-system issues none of them raised; mark the title `(judge-added)` and hold it to the same evidence bar. Add only what genuinely matters.
- **Account for every candidate** (`<contributor_id>::<source finding id>`): exactly one `retained`, `merged`, or `rejected` disposition each, with `target_final_finding_ids`, a 0–100 `modification_percent`, and a rationale.
- **State what you verified, per candidate**: `judge_confirmed` (you checked and it holds — include a `verification_note` saying what you checked), `asserted` (you did not check — no note), or `refuted_at_head` (you checked and it is absent — include a note). `asserted` is the honest default.
- **Attribute every final finding**: contributor shares totaling exactly 100%, each contributor exactly once per finding (combine that contributor's candidate IDs into one `source_candidate_ids` array), plus exactly one `design_review_conceptual` judge share (zero when you only selected unchanged work). State a rationale for every share.

## Output format

Write ONE merged, ranked JSON object to `<submissionPath>`, renumbering finding IDs from DR-001:

```json
{
  "round_id": "<round_id>",
  "findings": [ /* same finding shape and conceptual categories as the shallow pass */ ],
  "candidate_dispositions": [
    {
      "candidate_id": "<contributor_id>::<source finding id>",
      "contributor_id": "<contributor_id>",
      "source_finding_id": "<source finding id>",
      "disposition": "one of: retained, merged, rejected",
      "target_final_finding_ids": ["DR-001"],
      "modification_percent": 0,
      "rationale": "<transformation or rejection reason>",
      "verification_status": "one of: judge_confirmed, asserted, refuted_at_head",
      "verification_note": "<what you checked and found — only when status is not asserted>"
    }
  ],
  "final_finding_shares": [
    {
      "final_finding_id": "DR-001",
      "contributors": [
        {
          "contributor_id": "<contributor_id>",
          "source_candidate_ids": ["<contributor_id>::<source finding id>"],
          "contribution_percent": 100,
          "rationale": "<why this share>"
        }
      ]
    }
  ]
}
```
````

#### Evidence
- Renderer: `src/audit/orchestrator/designReviewPrompt.ts#renderConceptualJudgePrompt`
- Consumer/validator: `src/audit/types/conceptualAdjudication.ts#ConceptualJudgeSubmissionSchema` (`round_id`, `findings` of `SubmittedDesignFindingSchema`, `candidate_dispositions`, `final_finding_shares`; tool-owned verdicts `verification_status`/`evidence_lane`/`lead_lineage` omitted-and-refused, derived by `deriveConceptualVerificationStatus`); `src/shared/validation/designFindingGrounding.ts#groundDesignFindings`
- Any claim you could not verify from source: state it plainly. I did not read the full `ConceptualCandidateDispositionSchema` field list line-by-line; the disposition sub-fields above mirror the prompt's own accounting bullets and the schema symbol named, and should be diffed against that schema before shipping.

### 11e. `design_review` — shared structural context block (`src/audit/orchestrator/designReviewPrompt.ts`) — APPROVED (owner, 2026-09-17)

#### Summary of Key Refinements Applied
- **Block, not a prompt**: this renderer emits the context section shared by 11a–11d; its spec below preserves every subsection because each carries distinct evidence (file map, inventory, units with scope tags, graph, surfaces, flows, risks, deterministic leads, reading list).
- **Kept the leads-not-verdicts framing**: the deterministic-findings disclaimer is the one case where prompt prose carries a trust-class distinction the array door cannot enforce (no schema parses that door); shortened to two sentences.
- **Kept graph-provenance disclosure**: naming which language analyzers fell back to the regex floor is concrete, host-neutral capability disclosure (the approved fix pattern for class E); kept.
- **Kept scope tags**: `[in scope]` / `[excluded: <reason>]` tags plus the reading-grant rule stay, since 11b/11c reporting scope depends on them.
- **No placeholders removed**: repository name, counts, and the `<maxUnits>` reading list are all backend-computed and preserved.

#### Finalized Prompt Specification

````markdown
## Project context

Repository: <repository name>

<graph provenance notice — only when a language analyzer failed: which analyzer, and that the graph is incomplete for those files>

<review file map: path-scoped recon pointers>

### File inventory

<file count> files (<language>: <count>, ...).

### Unit structure

<<n> units, each `- <unit_id> [in scope | excluded: <reason>] (<file count> files, lenses: <lenses>)`>

### Dependency graph

<edge counts per kind, or empty/unavailable notice>

### Externally reachable surfaces

<<n> surfaces, each `- <id> (<kind>): <entrypoint> [<methods>]`>

### Critical flows

<<n> critical flows, each `- <name>: <file count> files, concerns: <concerns>`>

### Risk profile

<<n> risk items, top 10 by score: `- <unit_id>: score <score>, signals: <signals>`>

### Deterministic structural findings

<<n> structural findings from deterministic analysis — **leads, not verdicts**. Confirm one against real code before treating it as a finding; report it as your own finding, never re-emit the lead unchanged.>

<when some carry no producer lineage: `⚠ <n> of these carry NO producer lineage record.`>

### Starting points (orient, then roam)

<top <maxUnits> highest-risk units with their files>
````

#### Evidence
- Renderer: `src/audit/orchestrator/designReviewPrompt.ts#renderSharedStructuralContext` (units via `summarizeUnits` + `deriveUnitScopeDisposition`; graph provenance via `renderGraphProvenance` + `degradedAnalyzerEntries`; file map via `buildReviewFileMap`/`renderReviewFileMap`; leads via `formatDeterministicFindings`)
- Consumer/validator: same ingests as 11a–11d (context is evidence, not a submission; its trust-class disclaimer compensates for the array door performing no schema parse — see `src/shared/validation/designFindingGrounding.ts` header)
- Any claim you could not verify from source: state it plainly. None: subsection list was read directly from the renderer body.

### 11f. `design_review` — charter context block (`src/audit/orchestrator/designReviewPrompt.ts`) — APPROVED (owner, 2026-09-17)

#### Summary of Key Refinements Applied
- **Disposition kept, jargon cut**: the confident-vs-low-confidence charter distinction is enforced by `charterReviewDisposition` in tooling; the prompt keeps the FLAG-vs-opine rule but drops the channel-pure estimator lecture (`stated`/`structural`/`revealed`/`true`) to the charter-kind tags themselves.
- **Kept the byte-identical fallback**: absent/`omitted`/empty register renders nothing; stated as one conditional line, not a paragraph.
- **No new contract fields**: the block cites charter IDs and purposes already in the bundle; nothing the host writes depends on it.

#### Finalized Prompt Specification

````markdown
<when the run produced surviving charters:>

### Subsystem charters (what each part is FOR)

Opine PER CHARTER: judge whether the design delivers the purpose each subsystem claims, and surface where a subsystem's structure works against its own charter. Where a charter is marked LOW-CONFIDENCE, flag the gap for human intent confirmation instead of opining.

- **<node_id>** (members: <members>)
  - [<charter kind>] <purpose><, when low-confidence: " — LOW-CONFIDENCE charter: FLAG for human intent input, do NOT opine on it">

<otherwise render nothing>
````

#### Evidence
- Renderer: `src/audit/orchestrator/designReviewPrompt.ts#renderCharterContext` (disposition via `charterReviewDisposition` from `audit-tools/shared`)
- Consumer/validator: none directly — the block is input context for the 11b–11d ingests above
- Any claim you could not verify from source: state it plainly. None: fallback conditions (`absent`, `status: "omitted"`, no surviving charters) were read from the function body.

### 12. `second_order_adversary` (`src/audit/systemic/secondOrderAdversaryPrompt.ts`) — APPROVED (owner, 2026-09-17)

⚠ The spec below is the lane's draft, kept as the record of what was proposed. The LANDED prompt
differs on the two points the owner decided: the grounding rule is stated and enforced at the lane
gate, and the closed vocabularies are rendered from their schemas with all five severity values. The
measured account is in the tracker row.

#### Summary of Key Refinements Applied
- **Kept the separate-agent identity block**: the "you did not author these findings; if you drove this audit, stop and say so" rule is the auditor-agnostic invariant (a dispatch-envelope constraint the worker must itself carry); kept, shortened.
- **Kept the evidence mandate, cut the threat repetition**: `evidence` min-1 is enforced by `SystemicFindingSchema` (refusal, not silent drop); the prompt states it once instead of warning twice about REFUSAL and downstream loss.
- **Compressed loop-control legalese**: the quiet-round vs host-forced-stop distinction is a real convergence-protection mechanism, but took three paragraphs; kept as two rules with the exact `stop`-object shape.
- **Demoted metrics explicitly**: "leads only, never proof" is stated in one line instead of a section plus a code comment; the counts stay because the schema-adjacent loop needs them named.
- **Replaced vague pressure language**: "human-grade pressure", "push HARDER", and "TRUE lens" pleading (classes C/E) become concrete directives: name the departure axis per finding, tag the lens the finding genuinely belongs to.
- **Cut backend-history trivia**: the round-3 lap anecdote, the `docs_digest.json`-vs-`charter_register.json` provenance aside, and the id-namespacing mechanics (`SYSTEMIC_FINDING_ID_PREFIX` prefixing) are tooling internals; the prompt keeps only what the host must do (supply a short stable id).

#### Finalized Prompt Specification

````markdown
# Design review — systemic improvement-seeking challenge (second-order adversary)

You are a SEPARATE second-order adversary. This is challenge round <round>. The audit already banked <n> distinct finding(s). Find what those findings and their contributors missed.

## Who you are (this is not optional)

You are a SEPARATE agent from the one that drove this audit. You did not author its findings, charters, adjudication, or prior rounds' improvements — challenge all of them freely. If you ARE the agent that drove this audit, stop and say so instead of answering.

## Mandate — optimization / better-way, NOT defect-finding

Do NOT hunt ordinary bugs (other lenses own that). Press for SUPERIOR ALTERNATIVES to things that currently work:

- What is **redundant** — done more than once or more than needed?
- What is **serial that could be parallel**?
- What is **duplicated** across places that should share one mechanism?
- What is **over-built** — complexity with no payload?
- What **assumption went unquestioned**?
- Is there a **categorically better approach** for a whole subsystem?

## Required evidence files

Read these full artifacts before concluding the round:

- `<evidence path>`
<... one per path>

## Prior verified recon — read this BEFORE re-deriving anything

<review file map>

## Stated-purpose / goal / delta projection

<charter register projection as JSON, or "No charter register was produced for this run.">

## Conceptual contributors, dispositions, and attribution

<round id, contributors, candidate dispositions, attribution shares, and outcome rates as JSON, or "No deep conceptual adjudication record was produced.">

## Actual banked findings

<- **<id> — <title>** (<lens>/<severity>): <summary> [<files>] — one per finding, or "No prior findings were banked.">

## Covered themes — what this round must depart from

<<n> banked improvement(s), covering lenses / categories / components already used — or "Nothing is banked yet; this round SETS the coverage." Re-raising covered ground in new words is not a new finding.>

## Variation bar (required)

For every finding, state in its `summary` which axis it departs on: a component no banked finding names, a mechanism class none addresses, or a categorically different approach to something they only patch.

## Repository/source verification (required)

Verify every proposed improvement against exact source sites: inspect the sites, trace callers and callees in both directions, and confirm the affected paths. If symbol search, bidirectional tracing, or coverage accounting is unavailable, state that limitation and do not present the claim as comprehensive. Aggregate counts and prior-review consensus are never proof.

## Aggregate metrics (supporting evidence — necessary, NOT sufficient)

Language-neutral counts are leads only:

- <label>: <count> <unit>
<... one per rollup>
- Max fan-out (out-degree): <n>

## Lens and evidence (required)

- Tag each finding with the lens it genuinely belongs to (e.g. test parallelization is `tests` or `performance`, operational simplification is `operability). Do not default everything to `architecture`.
- Every finding needs at least one `evidence` entry naming the symbol you read, the file holding it, and what you found. A finding without one is refused.

## Loop-until-dry

- **If this round found nothing new** — submit `"findings": []` and stop normally. Quiet rounds are how this loop ends. Do not manufacture a finding to look productive, and do not withhold a real one.
- **If you are stopping before the loop is dry** (budget spent, no further yield) — say so explicitly with a top-level `stop` object (shape below) and state the reason. Never submit an empty `findings` array to mean "I am stopping": an empty array asserts the round found nothing new.

## Finding ids

Supply a short, stable `id` of your own per finding; the tool namespaces it per round.

## Output

Write JSON to `<submissionPath>` with this shape:

```json
{
  "findings": [
    {
      "id": "<your short id>",
      "title": "<the improvement>",
      "category": "systemic_improvement",
      "severity": "low|medium|high",
      "confidence": "low|medium|high",
      "lens": "<the lens this finding belongs to>",
      "summary": "<what to do, why it is better, which axis it departs on, and source verification>",
      "evidence": ["<symbol you read, the file holding it, and what you found there>"],
      "affected_files": [{ "path": "<a real repo path>" }]
    }
  ]
}
```

To stop the loop early, include this ALONGSIDE any findings being submitted:

```json
{
  "findings": [ ],
  "stop": { "forced": true, "reason": "<why the loop is being stopped before it is dry>" }
}
```
````

#### Evidence
- Renderer: `src/audit/systemic/secondOrderAdversaryPrompt.ts#renderSecondOrderAdversaryPrompt` (identity via `adversaryIdentityLines`; themes via `renderCoveredThemes`/`summarizeCoveredThemes`; charter projection via `renderCharterProjection`; adjudication via `renderAdjudication`; file map via `buildReviewFileMap`/`renderReviewFileMap`)
- Consumer/validator: `src/shared/decompose/systemicChallenge.ts#SystemicChallengeSubmissionSchema` (strict: `findings` default `[]`, each refined to require `evidence` min-1; optional strict `stop: { forced: true, reason }`); `src/shared/validation/designFindingGrounding.ts#groundDesignFindings` (applied in `src/audit/systemic/systemicChallengeLoop.ts`); lane keyed as `GATE_LANES.systemic_challenge` in `src/audit/cli/laneValidators.ts#LANE_SUBMISSION_SCHEMAS`
- Any claim you could not verify from source: state it plainly. I did not verify which step grants `evidencePaths` in the host read set (stated in the renderer's doc comment); the spec assumes the listed paths are readable.

### 16a. `clarify_remediation_target` (`src/remediate/steps/prompts.ts`) — PROPOSED

#### Summary of Key Refinements Applied
- **Single refusal rule**: Merged the two repeated whole-file refusal threats (unknown `finding_id`, bad `scope_additions`) into one "Output contract" block.
- **Plain action definitions**: Replaced the convoluted parenthetical action glosses with a three-row table stating what each action does to the item.
- **Parser trivia removed**: Dropped the backend-failure explanation ("does not resolve beneath the repository root, or whose directory does not exist…") in favor of a one-line scope rule (corrected 2026-09-18: a new file is allowed when its directory already holds a tracked file).
- **Mechanical enforcement named**: `scope_additions` widening is enforced by `validateClarificationScopeAdditions`; the prompt states the constraint once instead of pleading ("NEVER edit … by hand" kept as one imperative).
- **Refusal banner kept conditional**: The archived-refusal block renders only when a prior resolution was refused.

#### Finalized Prompt Specification

````markdown
# Resolve Remediation Clarifications

<refusal banner, only when a previous resolution was refused: quote the reason and re-submit the whole resolution>

Ask the user to resolve every clarification below in one batched response.

## <finding_id>

- Category: <category>
- Question: <description>
- Options: <options, when present>

## Output contract

Write JSON to exactly `<resolutionPath>`:

```json
[
  {
    "finding_id": "<one id from the closed set below>",
    "action": "clarified | reject_finding | defer",
    "rationale": "<answer or decision>",
    "scope_additions": ["<optional repo-relative files the answer adds to the fix scope>"]
  }
]
```

| `action` | Meaning |
|---|---|
| `clarified` | Answered, or no real ambiguity — proceed; put the answer in `rationale`. |
| `reject_finding` | The finding itself is not a real issue — drops it. Never use it just to say the question was clear. |
| `defer` | The user explicitly chose to skip it this run. |

- `finding_id` must be copied from this closed set: `<finding_id…>`.
- `scope_additions` lists repo-relative paths (tests to create, mirrored sources, new modules, manifests). A path may name a new file, but its directory must already hold a tracked file. ⚠ Corrected 2026-09-18: this line first said "files that exist", which is wrong — the rule admits a new file. The tool widens the owning block; do not edit the plan's `touched_files` by hand.
- A bad id or bad path refuses the whole file and re-presents this step.

Then run `<remediate-code next-step>`.
````

#### Evidence
- Renderer: `src/remediate/steps/prompts.ts#clarificationPrompt`
- Consumer/validator: `src/remediate/steps/nextStep.ts#normalizePlanClarificationResolutions` (array of `{finding_id, action: clarified|reject_finding|defer, rationale?, scope_additions?}`; also accepts `{resolutions|items: [...]}` envelopes), `#validateClarificationScopeAdditions` (whole-file fail-closed on bad scope paths), `#applyClarificationActionToItem` (`clarified`→pending, `reject_finding`→`deemed_inappropriate`, `defer`→`ignored`)
- Any claim you could not verify from source: state it plainly. I did not verify the exact archived-refusal filename the host sees on re-halt.

### 16b. `clarify_remediation_target` (`src/remediate/steps/prompts.ts`) — PROPOSED

#### Summary of Key Refinements Applied
- **One manifest shape**: Replaced the two near-duplicate manifest examples (documents vs. conversation) with a single contract plus a `sources[]` row for each input kind.
- **Trivia trimmed**: Kept repository root, checked locations, and the missing-path note as plain facts; removed the "Do not edit source files" aside already enforced by write-scope tooling.
- **Conversation-first preserved**: Both input kinds (report paths, conversational feedback) remain accepted, alone or together.
- **No new contract fields**: `created_from`, `type`, `path`, `label` values unchanged.

#### Finalized Prompt Specification

````markdown
# Collect Remediation Starting Point

Ask the user for the starting point for this remediation. Accept:

- paths to audit reports, feedback documents, issue notes, or design notes;
- conversational feedback describing the refactor or remediation goal;
- both together.

Repository root: `<root>`

Checked default input locations:
- `<candidate>`

<supplied input path missing, only when present: `<missing path>` did not exist>

## Output contract

Write the source manifest JSON to exactly `<paths.sourceManifest>`:

```json
{
  "schema_version": "<INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION>",
  "created_from": "conversation",
  "sources": [
    { "type": "document", "path": "<user-supplied or absolute path>", "label": "input-01" },
    { "type": "conversation", "path": "<paths.conversationStart>", "label": "conversation-start" }
  ]
}
```

- Include one entry per input the user gave (document entries, conversation entry, or both in the same manifest).
- When the user gives conversational feedback, write their full feedback to exactly `<paths.conversationStart>` first, then list it as the `conversation` source.

Then run `<remediate-code next-step>`.
````

#### Evidence
- Renderer: `src/remediate/steps/prompts.ts#collectStartingPointPrompt`
- Consumer/validator: `src/remediate/intake.ts#IntakeSourceManifest` (`schema_version`, `created_from: input|default_candidates|conversation|mixed`, `sources: IntakeSource[]`), `#resolveManifestSources` (resolves each source path against the root into resolved/missing), `#readIntakeArtifacts` (reads `sourceManifest` + `conversationStart` text)
- Any claim you could not verify from source: state it plainly. I found no zod schema for the source manifest — shape is enforced by the `IntakeSourceManifest` interface and path resolution, not a runtime validator.

### 16c. `clarify_remediation_target` (`src/remediate/steps/prompts.ts`) — PROPOSED

#### Summary of Key Refinements Applied
- **Closed id set stated**: Added the valid `question_id` list to the prompt — the validator rejects unknown ids (`validateClarificationResolution`), so the host must see them.
- **Blank-answer rule surfaced**: Stated that whitespace-only answers do not resolve anything (`reconcileIntakeQuestions` ignores them).
- **Single-round instruction kept**: One batched user round, unchanged behavior.
- **No new contract fields**: `schema_version`, `answers[{question_id, answer, rationale?}]` unchanged.

#### Finalized Prompt Specification

````markdown
# Resolve Remediation Intake Questions

Ask the user to answer every blocking intake question below in one response.

## <id>

- Category: <category>
- Question: <question>

## Output contract

Write JSON to exactly `<paths.clarificationResolution>`:

```json
{
  "schema_version": "<INTAKE_CLARIFICATION_SCHEMA_VERSION>",
  "answers": [
    {
      "question_id": "Q-001",
      "answer": "<user's answer>",
      "rationale": "<optional short note on how it resolves the ambiguity>"
    }
  ]
}
```

- `question_id` must be copied from this closed set: `<id…>`. An unknown id is an error.
- Every `answer` must be non-blank; a whitespace-only answer resolves nothing.
- At least one blocking question must be answered.

Then run `<remediate-code next-step>`.
````

#### Evidence
- Renderer: `src/remediate/steps/prompts.ts#collectIntakeClarificationsPrompt` (renders `blockingIntakeQuestions(summary)`)
- Consumer/validator: `src/remediate/intake.ts#validateClarificationResolution` (requires `answers[]` with `question_id` + `answer`; unknown ids error; at least one blocking id addressed), `#reconcileIntakeQuestions` (blank answers ignored; answered ids removed from `open_questions` for every consumer)
- Any claim you could not verify from source: state it plainly. None — both validators read directly.

### 17a. `plan_proposal` (`src/remediate/steps/prompts.ts`) — PROPOSED

#### Summary of Key Refinements Applied
- **Candidate framing kept, shortened**: Tool-seeded candidates are starting points; the host drops false positives and adds missed ambiguities — same judgment slot, fewer words.
- **Single refusal rule**: Merged the duplicate whole-file refusal threats into one contract block.
- **Deferral authority preserved**: Deferral stays the user's call; the host never decides it unilaterally.
- **Empty-array path explicit**: `[]` proceeds with no forced user round on a clean plan.
- **Mechanical enforcement named**: Scope widening via `scope_additions` is validated by `validateClarificationScopeAdditions`, not by host care.

#### Finalized Prompt Specification

````markdown
# Resolve scoping/judgment ambiguity BEFORE implementing

<refusal banner, only when a previous resolution was refused: quote the reason and re-submit the whole resolution>

The candidates below are deterministic starting points, not a final list:

## <finding_id>

- Candidate ambiguity: <description>

<or: _(no deterministic candidates — still review the plan's findings yourself)_>

1. Check each candidate against the code (read the cited files). Drop false positives.
2. Add any genuine scoping/judgment ambiguity the heuristics missed — unclear scope, intended behavior, or whether to act at all.
3. Batch every genuine ambiguity into ONE round of user questions now. Nothing scoping-related slips to mid-run triage.

## Output contract

After the user answers (or if nothing is genuinely ambiguous), write JSON to exactly `<resolutionPath>` — `[]` if nothing is genuinely ambiguous:

```json
[
  {
    "finding_id": "<one id from the plan's closed set below>",
    "action": "clarified | reject_finding | defer",
    "rationale": "<user's answer or decided scope>",
    "scope_additions": ["<optional repo-relative files the answer adds to the fix scope>"]
  }
]
```

| `action` | Meaning |
|---|---|
| `clarified` | Answered, or not genuinely ambiguous — proceed; put the answer in `rationale`. |
| `reject_finding` | The finding itself is not a real issue — drops it. Never use it just to say a question was clear. |
| `defer` | The user explicitly chose to skip it this run. Deferral is the user's call — never decide it unilaterally. |

- `finding_id` must be copied from the plan's closed id set: `<id…>`.
- `scope_additions` lists repo-relative paths. A path may name a new file, but its directory must already hold a tracked file. ⚠ Corrected 2026-09-18: this line first said "files that exist", which is wrong — the rule admits a new file. The tool widens the owning block in-band; do not edit the plan's `touched_files` by hand.
- A bad id or bad path refuses the whole file and re-presents this step.

Then run `<remediate-code next-step>`.
````

#### Evidence
- Renderer: `src/remediate/steps/prompts.ts#ambiguityReviewPrompt`
- Consumer/validator: `src/remediate/steps/nextStep.ts#normalizePlanClarificationResolutions`, `#validateClarificationScopeAdditions`, `#applyClarificationActionToItem` (same resolution contract as 16a; `[]` = clean plan proceeds)
- Any claim you could not verify from source: state it plainly. I did not verify which caller renders the "no deterministic candidates" fallback most often.

### 17b. `plan_proposal` (`src/remediate/steps/prompts.ts`) — PROPOSED

#### Summary of Key Refinements Applied
- **History lecture removed**: Dropped the gate-origin paragraph (why strategic findings were once silently closed) — the directive to walk the Strategic tier item-by-item stays.
- **Vague tier framing replaced**: "Bucketed by how much of your judgment it needs" replaced with what each tier demands (decision per item, pros/cons of acting vs. not).
- **Approve-by-default kept prominent**: Empty resolution approves everything; declines are recorded, never silent.
- **Closed vocabularies stated once**: Valid finding ids and the `strategic|concrete|mechanical` tier enum in a single contract block.
- **No new contract fields**: `disapproved_findings`, `disapproved_tiers` (+ optional `plan_id` correlation) unchanged.

#### Finalized Prompt Specification

````markdown
# Review-Approval Gate — approve or disapprove before implementation

<refusal banner, only when a previous resolution was refused: quote the reason and re-submit the whole resolution>

Before any code changes, walk the user through every finding below, especially the **Strategic** tier, with the trade-offs of acting vs. leaving each as-is.

- Total findings: **<total>**
- Strategic: **<n>** · Concrete: **<n>** · Mechanical: **<n>**

## <tier label> — <n> item(s)

<tier description>

### <finding_id> — <title>

<one-line lead>

- Severity: <severity>
- Confidence: <confidence>
- Lens: <lens>
- Files: <affected files>
- Why this tier: <rationale>
- Implementation cost (blast radius): `<cost>`
- Present to the user with the pros/cons of acting vs. not acting, then record their decision.

## Output contract

Default: proceed with every finding. Record only what the user wants to disapprove. Write JSON to exactly `<resolutionPath>`:

```json
{
  "disapproved_findings": ["<finding id the user declined>"],
  "disapproved_tiers": []
}
```

- Leave `disapproved_findings` empty (`[]`) to approve everything.
- `disapproved_tiers` (e.g. `["mechanical"]`) declines a whole tier at once.
- Disapproved items are recorded as declined with a reason — never acted on, never silently dropped.
- `disapproved_findings` ids must be copied from this closed set: `<id…>`. `disapproved_tiers` entries must be one of `strategic`, `concrete`, `mechanical`. A bad id refuses the whole resolution and re-presents this gate.

Then run `<remediate-code next-step>`.
````

#### Evidence
- Renderer: `src/remediate/steps/prompts.ts#reviewApprovalPrompt` (item badge via `audit-tools/shared#findingLead` + `#renderFindingBadgeBody` with `showGrounding: false`, `evidencePointer: audit-findings.json`)
- Consumer/validator: `src/remediate/review/reviewGate.ts#applyReviewResolution` (default-approve; `disapproved_findings` ∪ `disapproved_tiers` → declined with recorded reason), `#screenResolutionIds` (whole-file refusal on unknown ids/tiers), `#isResolutionForRequest` (`plan_id` correlation; absent `plan_id` correlates)
- Any claim you could not verify from source: state it plainly. I did not verify whether the emitted prompt carries `plan_id` into the resolution file or leaves it absent.

### 17c. `plan_proposal` (`src/remediate/steps/prompts.ts`) — PROPOSED

#### Summary of Key Refinements Applied
- **Selective-reading directive fixed**: "Read only the listed source files" kept as a scope bound on file opens, not as a claim the host can unread payload text (issue class F).
- **Three artifacts, one order**: Manifest → sources (+ clarifications) → summary JSON → brief markdown → draft checkpoint; unchanged outputs, explicit sequence.
- **`ready` rule kept exact**: `true` only when no further user decision gates implementation; otherwise `false` with blocking questions listed.
- **Draft sentinel stated once**: `confirmed_by: "draft"` plus no-`closing_action` rule merged into the checkpoint block instead of scattered negatives.
- **No new contract fields**: Summary, brief sections, and checkpoint keys match `IntakeSummarySchema` and `IntentCheckpointSchema` exactly.

#### Finalized Prompt Specification

````markdown
# Synthesize Remediation Intake

Read the source manifest at `<manifestPath>`, then the listed source files:

- <type>: `<path>`

<only when a clarification resolution exists: Also read the clarification answers at `<paths.clarificationResolution>`.>

Write a launch brief that eliminates ambiguity before the planner turns this into findings.

## 1. Summary JSON — exactly `<paths.summary>`

```json
{
  "schema_version": "<INTAKE_SUMMARY_SCHEMA_VERSION>",
  "ready": false,
  "source_type": "documents",
  "goals": ["specific remediation goal"],
  "non_goals": ["explicitly out-of-scope change"],
  "constraints": ["compatibility, dependency, testing, timing, or style constraint"],
  "affected_files": [{ "path": "relative/path.ts", "reason": "why this file is implicated" }],
  "open_questions": [
    {
      "id": "Q-001",
      "category": "scope_of_fix",
      "question": "What needs to be clarified before code changes?",
      "blocking": true
    }
  ]
}
```

- `source_type` is one of `structured_audit`, `documents`, `conversation`, `mixed`.
- Set `ready: true` only when goals, non-goals, affected areas, and success criteria are clear enough that no implementation choice depends on another user decision. Otherwise `ready: false` with the blocking questions listed.
- A question blocks if and only if `blocking: true`.

## 2. Launch brief markdown — exactly `<paths.brief>`

Cover: source summary, goals, non-goals, constraints, affected files or discovery targets, acceptance criteria, open questions (if any).

## 3. Preliminary intent checkpoint — exactly `<checkpointPath>`

```json
{
  "schema_version": "intent-checkpoint/v1",
  "confirmed_at": "<ISO-8601 timestamp for when this draft was created>",
  "confirmed_by": "draft",
  "scope_summary": "<scope derived from goals and affected_files>",
  "intent_summary": "<purpose derived from goals and source_type>",
  "filters": {},
  "pre_draft_questions": [
    {
      "id": "Q-001",
      "question": "<question text from open_questions above>",
      "blocking": true
    }
  ]
}
```

- `confirmed_by` is `"draft"` (unconfirmed; planning must not begin, filtering must not apply).
- Copy ALL `open_questions` into `pre_draft_questions`, preserving ids and blocking flags.
- Leave `filters` empty (`{}`) unless the source clearly implies severity/lens/package scope.
- Record how free-form intent was read in `intent_interpretation` when applicable.
- Do NOT write a `closing_action`: the tool detects candidates and the host chooses at confirmation.

Do not edit source files.

Then run `<remediate-code next-step>`.
````

#### Evidence
- Renderer: `src/remediate/steps/prompts.ts#synthesizeIntakePrompt`
- Consumer/validator: `src/remediate/intake.ts#IntakeSummarySchema` / `#validateIntakeSummary` (`schema_version`, `ready: boolean`, `source_type` enum, `goals/non_goals/constraints: string[]`, `affected_files: {path, reason?}[]`, `open_questions: {id, question, category?, blocking?}[]`; `blocking === true` alone blocks per `#blockingIntakeQuestions`), `src/shared/types/intentCheckpoint.ts#IntentCheckpointSchema` (`confirmed_by: host|draft`, optional `filters` strict-object, `pre_draft_questions`, `intent_interpretation`, `closing_action`; `.strict()` at every level)
- Any claim you could not verify from source: state it plainly. The brief markdown (`remediation-brief.md`) has no schema validator I could find — it is a human render. I did not verify the exact `ready: false` re-synthesis path the decide loop takes.
