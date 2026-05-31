import os
import json
import glob
import re

TEST_DIR = r"C:\Code\audit-tools\packages\audit-code\tests"
SRC_FILES = [
    "packages/audit-code/src/providers/spawnLoggedCommand.ts",
    "packages/audit-code/src/providers/subprocessTemplateProvider.ts",
    "packages/audit-code/src/providers/vscodeTaskProvider.ts",
    "packages/audit-code/src/quota/discoveredLimits.ts",
    "packages/audit-code/src/quota/headerExtraction.ts",
    "packages/audit-code/src/quota/headerExtractors/claudeCodeHeaderExtractor.ts",
    "packages/audit-code/src/quota/headerExtractors/genericHeaderExtractor.ts",
    "packages/audit-code/src/quota/headerExtractors/index.ts",
    "packages/audit-code/src/quota/hostLimits.ts",
    "packages/audit-code/src/quota/index.ts",
    "packages/audit-code/src/quota/probe.ts",
    "packages/audit-code/src/quota/scheduler.ts",
    "packages/audit-code/src/reporting/mergeFindings.ts",
    "packages/audit-code/src/reporting/synthesis.ts",
    "packages/audit-code/src/reporting/synthesisNarrativePrompt.ts",
    "packages/audit-code/src/reporting/workBlocks.ts",
    "packages/audit-code/src/supervisor/operatorHandoff.ts",
    "packages/audit-code/src/supervisor/runLedger.ts",
    "packages/audit-code/src/supervisor/sessionConfig.ts",
    "packages/audit-code/src/types.ts",
    "packages/audit-code/src/types/analyzerCapability.ts",
    "packages/audit-code/src/types/artifactMetadata.ts",
    "packages/audit-code/src/types/auditScope.ts",
    "packages/audit-code/src/types/auditState.ts",
    "packages/audit-code/src/types/designAssessment.ts",
    "packages/audit-code/src/types/externalAnalyzer.ts",
    "packages/audit-code/src/types/flowCoverage.ts",
    "packages/audit-code/src/types/reviewPlanning.ts",
    "packages/audit-code/src/types/runtimeValidation.ts",
    "packages/audit-code/src/types/synthesisNarrative.ts"
]

results = {src: False for src in SRC_FILES}

# Check if any test file imports or mentions the src file
for test_file in glob.glob(os.path.join(TEST_DIR, "*.test.mjs")):
    with open(test_file, 'r', encoding='utf-8') as f:
        content = f.read()
        for src in SRC_FILES:
            base_name = os.path.basename(src).replace('.ts', '')
            # Try to see if there is an import or string mentioning it
            if base_name in content:
                results[src] = True

for src, found in results.items():
    if not found:
        print(f"NO_COVERAGE: {src}")
    else:
        print(f"COVERED_MAYBE: {src}")
