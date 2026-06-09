<!-- audit-tools/audit-report/v1 -->
# Audit Report

## Summary

- Findings: 281
- Work blocks: 5
- Severity breakdown: high: 24, medium: 127, low: 120, info: 10
- Lens breakdown: architecture: 8, config_deployment: 6, correctness: 26, data_integrity: 11, maintainability: 131, observability: 50, operability: 5, reliability: 10, security: 2, tests: 32
- Fully audited files: 175
- Excluded non-auditable files: 385

## Work Blocks

### block-1

- Max severity: high
- Units: -codex-hooks, packages-audit-code, packages-remediate-code, packages-shared
- Owned files: .codex/hooks/session-start.sh, .codex/hooks/session-start.test.mjs, packages/audit-code/.audit-artifacts/active-dispatch.json, packages/audit-code/.audit-artifacts/artifact_metadata.json, packages/audit-code/.audit-artifacts/audit_plan_metrics.json, packages/audit-code/.audit-artifacts/audit_state.json, packages/audit-code/.audit-artifacts/audit_tasks.json, packages/audit-code/.audit-artifacts/auto_fixes_applied.json, packages/audit-code/.audit-artifacts/coverage_matrix.json, packages/audit-code/.audit-artifacts/critical_flows.json, packages/audit-code/.audit-artifacts/design_assessment.json, packages/audit-code/.audit-artifacts/dispatch/audit-result.schema.json, packages/audit-code/.audit-artifacts/dispatch/audit-results.schema.json, packages/audit-code/.audit-artifacts/dispatch/current-single-task.json, packages/audit-code/.audit-artifacts/dispatch/current-task.json, packages/audit-code/.audit-artifacts/dispatch/current-tasks.json, packages/audit-code/.audit-artifacts/dispatch/finding.schema.json, packages/audit-code/.audit-artifacts/external_analyzer_results.json, packages/audit-code/.audit-artifacts/file_disposition.json, packages/audit-code/.audit-artifacts/flow_coverage.json, packages/audit-code/.audit-artifacts/graph_bundle.json, packages/audit-code/.audit-artifacts/operator-handoff.json, packages/audit-code/.audit-artifacts/repo_manifest.json, packages/audit-code/.audit-artifacts/requeue_tasks.json, packages/audit-code/.audit-artifacts/review_packets.json, packages/audit-code/.audit-artifacts/risk_register.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/dispatch-plan.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/dispatch-quota.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/dispatch-result-map.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/dispatch-warnings.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/pending-audit-tasks.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/status.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-gemini-commands_maintainability_c43cd2c0fc74.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-gemini-commands_observability_1ac1795ddef7.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-gemini-commands_tests_60cb9627e146.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-github-workflows_config_deployment_20e7cbb0e074.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-github-workflows_operability_d8353879b2f9.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-github-workflows_reliability_8fe21bc237bc.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-tmp-opentoken_config_deployment_a1d548ed2e7d.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-tmp-opentoken_correctness_part-10_6426e25f84be.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-tmp-opentoken_correctness_part-11_4b3753a9b340.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-tmp-opentoken_correctness_part-1_9f06ecc6f652.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-tmp-opentoken_correctness_part-9_6119301de9a7.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-tmp-opentoken_data_integrity_0662f2996804.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-tmp-opentoken_maintainability_part-1_60850b9cfac8.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-tmp-opentoken_maintainability_part-9_5c5bf435dd77.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-tmp-opentoken_observability_part-10_d9f6bf8009b7.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-tmp-opentoken_observability_part-1_6e0a05b04c45.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-tmp-opentoken_operability_4e688d93f732.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-tmp-opentoken_performance_adce44c901d7.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-tmp-opentoken_reliability_f4de22fbe164.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-tmp-opentoken_tests_part-9_31a4b9f3ce6c.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/Codeauditor-lambda-audit-artifacts_correctness_d46201245396.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/dispatch_correctness_ae0181b73589.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/dispatch_maintainability_bee5088f1ffb.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/dispatch_observability_c793d60902a2.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/dispatch_tests_89add911d1cf.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/flow_flow_data_-tmp-opentoken--opencode-opentoken-config-schema-json_reliability_b4a5c2303dc0.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/flow_flow_data_-tmp-opentoken-opentoken--opencode-opentoken-config-schema-json_r_ec988d70a128.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/flow_flow_surface_-gemini-commands-audit-code-toml_correctness_32b1ce1a8123.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/flow_flow_surface_skills-audit-code-opencode-command-template-txt_correctness_6d52725063eb.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/flow_flow_surface_src-cli-ts_correctness_3f73ccd6a67b.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/flow_flow_surface_src-orchestrator-localCommands-ts_correctness_0a25236ea6d2.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/flow_flow_surface_src-orchestrator-requeueCommand-ts_correctness_e2c9dfdf6aaa.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/flow_flow_surface_src-providers-spawnLoggedCommand-ts_correctness_9dde49d78d10.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/flow_flow_surface_src-types-workerSession-ts_reliability_part-1_417a0deee4a3.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/flow_flow_surface_src-types-workerSession-ts_reliability_part-2_7435e6dc3c1e.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/flow_flow_surface_src-types-workerSession-ts_reliability_part-3_7423faf4ff70.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/flow_flow_surface_src-types-workerSession-ts_security_part-1_b6a8239214e4.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/flow_flow_surface_src-types-workerSession-ts_security_part-2_13d504c331b5.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/module-audit-code-mjs_correctness_ed6bf77ffaac.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/module-audit-code-mjs_maintainability_498cd1345358.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/module-audit-code-mjs_observability_9e816065064f.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/module-audit-code-mjs_tests_4c5ee0371662.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/module-audit-code-wrapper-lib-mjs_correctness_fbb41a3f0127.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/module-audit-code-wrapper-lib-mjs_maintainability_ae39ab0f98ad.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/module-audit-code-wrapper-lib-mjs_observability_cb5beb7fdcfc.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/module-audit-code-wrapper-lib-mjs_tests_4077823060d5.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/root-config_correctness_33525053f6dc.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/root-config_maintainability_20ac2f64ae01.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/root-config_observability_5eead3c1f915.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/schemas_data_integrity_part-1_90252d94b2a4.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/schemas_data_integrity_part-2_003e83577b4d.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/scripts_config_deployment_42880ab3fe04.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/scripts_correctness_2cbbdfa2d940.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/scripts_operability_41164778d629.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/skills-audit-code_config_deployment_69f5bbfc396f.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/skills-audit-code_maintainability_ff603dc015b7.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/skills-audit-code_observability_7f49f1ecc389.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/skills-audit-code_operability_be25dd8c53d6.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/skills-audit-code_reliability_fab55b9a92f5.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/skills-audit-code_tests_6791a614a56e.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-adapters_correctness_9956734fc469.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-adapters_maintainability_9b611a94427b.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-adapters_observability_52d91e962a0c.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-adapters_tests_5ce945a5e633.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-cli-ts_maintainability_9c728ead27f8.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-cli-ts_observability_3d1881f2d38c.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-cli-ts_tests_28d7b60ab4db.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-coverage-ts_correctness_8fef834a9f82.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-coverage-ts_maintainability_a80d961955de.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-coverage-ts_observability_2f4cad37430d.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-coverage-ts_tests_5dab4ea6f0dd.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_correctness_part-1_2077707e0154.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_correctness_part-2_57699035f4f8.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_correctness_part-3_ec84cf881d98.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_maintainability_part-1_26121e8756c4.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_maintainability_part-2_8963d829d695.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_maintainability_part-3_368d31263963.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_observability_part-1_b566b351d5dc.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_observability_part-2_3bf4c5164011.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_observability_part-3_1f6437890d0e.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_tests_part-1_acdc92091692.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_tests_part-2_81ce137ba1e2.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_tests_part-3_323b56aa194d.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-index-ts_correctness_9ca55091f0eb.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-index-ts_maintainability_7ffb4145deb6.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-index-ts_observability_597270b7ad7e.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-index-ts_tests_7d2317c4462b.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-io_correctness_fd7862ab2743.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-io_maintainability_be6039c5d4e2.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-io_observability_19573aca2329.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-io_tests_eb0e591337ac.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-mcp_correctness_a2ecd5efccf6.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-mcp_maintainability_d39fe3c33f96.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-mcp_observability_495cec676ebd.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-orchestrator-ts_correctness_00d274969910.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-orchestrator-ts_maintainability_735a9dcd4b55.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-orchestrator-ts_observability_e9fa1717f6f3.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-orchestrator_correctness_part-1_4009d4e70d4e.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-orchestrator_correctness_part-2_e509a6a969fd.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-orchestrator_correctness_part-3_3ea02cacf662.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-orchestrator_maintainability_part-1_fc6466bd3e84.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-orchestrator_maintainability_part-2_b3e18aa0f925.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-orchestrator_maintainability_part-3_09916849aac3.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-orchestrator_tests_part-3_639757d2801c.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-prompts_correctness_3ed82434db78.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-prompts_performance_8ebd5ce27ff5.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-prompts_tests_209348e77f0c.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-providers_correctness_b0bbcbc8d945.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-providers_maintainability_359f979a5fb0.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-providers_observability_eeeb668ef57a.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-providers_tests_72ad722f9b9b.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-quota_correctness_part-1_d45aa5d8dc9e.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-quota_correctness_part-2_adc29b6a6a32.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-quota_maintainability_part-1_42575bff0736.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-quota_maintainability_part-2_819f8c402c11.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-quota_observability_part-1_ef40940c6371.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-quota_observability_part-2_55e0cdcf34ec.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-quota_performance_4feb465ad31d.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-quota_tests_part-1_c45c269e54c2.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-quota_tests_part-2_4ea5974862ef.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-reporting_correctness_e8e049784fea.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-reporting_maintainability_dd4a047bc130.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-reporting_observability_0357926b8d15.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-reporting_tests_af740567136e.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-supervisor_correctness_cfa25a0a3190.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-supervisor_maintainability_6756ca817e65.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-supervisor_observability_45175a201904.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-supervisor_tests_785fd6a595b2.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-types_correctness_part-1_567bc81712e0.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-types_correctness_part-2_b615c32a3aa5.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-types_maintainability_9b09549ff681.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-types_observability_part-1_537fa24afa9e.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-types_observability_part-2_4122f0a8356a.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-types_performance_1243f8e5fa51.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-types_tests_part-1_dcea84cda542.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-types_tests_part-2_ac8a1a751556.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-validation_correctness_0d5ffd8778f6.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-validation_maintainability_c562d05b150b.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-validation_observability_3df03c32ea0a.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-validation_tests_236ada212774.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-audit-code-wrapper-test-mjs_maintainability_91ad44d4dd89.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-audit-code-wrapper-test-mjs_tests_1afcd18a18f6.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-field-trial-remediation-test-mjs_maintainability_49e93577c95a.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-field-trial-remediation-test-mjs_tests_44e5da1a2f34.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-helpers_correctness_acbb4def57ec.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-helpers_data_integrity_7c6ab57eb2f4.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-helpers_maintainability_7f4e86a11fa7.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-helpers_reliability_caeb7b058ae8.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-helpers_tests_d1c2a36e172a.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-json-schema-assert-test-mjs_correctness_371c441afe3c.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-json-schema-assert-test-mjs_data_integrity_b331dd8ba895.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-json-schema-assert-test-mjs_maintainability_a453fea9f888.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-json-schema-assert-test-mjs_reliability_0a16340dfd66.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-json-schema-assert-test-mjs_tests_d7288a0a165a.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-schema-contracts-test-mjs_correctness_64be1c0f0792.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-schema-contracts-test-mjs_data_integrity_313dbf74dbd4.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-schema-contracts-test-mjs_maintainability_37f2ca1b4a7b.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-schema-contracts-test-mjs_reliability_5560e4cb3a46.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-schema-contracts-test-mjs_tests_ab19689dd869.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-tiny-files_config_deployment_425c6a29f247.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-tiny-files_correctness_9b53d5bd525b.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-tiny-files_maintainability_part-1_8020c3871642.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-tiny-files_maintainability_part-2_ae3a7fac6969.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-tiny-files_observability_f904407e40b1.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-tiny-files_operability_ef87442ca0cc.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-tiny-files_performance_337eef2632d8.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-tiny-files_reliability_d4e0cc663b81.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-tiny-files_tests_part-1_5cbb44505bf6.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task.json, packages/audit-code/.audit-artifacts/runtime_validation_report.json, packages/audit-code/.audit-artifacts/runtime_validation_tasks.json, packages/audit-code/.audit-artifacts/session-config.json, packages/audit-code/.audit-artifacts/steps/current-step.json, packages/audit-code/.audit-artifacts/surface_manifest.json, packages/audit-code/.audit-artifacts/syntax_resolution_status.json, packages/audit-code/.audit-artifacts/tooling_manifest.json, packages/audit-code/.audit-artifacts/unit_manifest.json, packages/audit-code/.gemini/commands/audit-code.toml, packages/audit-code/.gitignore, packages/audit-code/.opencode/.gitignore, packages/audit-code/.opencode/package.json, packages/audit-code/.remediation-artifacts/steps/current-step.json, packages/audit-code/.vscode/mcp.json, packages/audit-code/audit-code-wrapper-build.mjs, packages/audit-code/audit-code-wrapper-install-hosts.mjs, packages/audit-code/audit-code-wrapper-io.mjs, packages/audit-code/audit-code-wrapper-legacy.mjs, packages/audit-code/audit-code-wrapper-lib.mjs, packages/audit-code/audit-code-wrapper-opencode.mjs, packages/audit-code/audit-code.mjs, packages/audit-code/dispatch/lens-definitions.json, packages/audit-code/dispatch/merge-results.mjs, packages/audit-code/dispatch/validate-result.mjs, packages/audit-code/dispatch/validate.mjs, packages/audit-code/opencode.json, packages/audit-code/package.json, packages/audit-code/schemas/analyzer_capability.schema.json, packages/audit-code/schemas/audit-code-v1alpha1.schema.json, packages/audit-code/schemas/audit_findings.schema.json, packages/audit-code/schemas/audit_plan_metrics.schema.json, packages/audit-code/schemas/audit_result.schema.json, packages/audit-code/schemas/audit_results.schema.json, packages/audit-code/schemas/audit_state.schema.json, packages/audit-code/schemas/audit_task.schema.json, packages/audit-code/schemas/blind_spot_register.schema.json, packages/audit-code/schemas/coverage_matrix.schema.json, packages/audit-code/schemas/critical_flows.schema.json, packages/audit-code/schemas/dispatch_quota.schema.json, packages/audit-code/schemas/external_analyzer_results.schema.json, packages/audit-code/schemas/file_disposition.schema.json, packages/audit-code/schemas/finding.schema.json, packages/audit-code/schemas/flow_coverage.schema.json, packages/audit-code/schemas/graph_bundle.schema.json, packages/audit-code/schemas/lens.schema.json, packages/audit-code/schemas/repo_manifest.schema.json, packages/audit-code/schemas/review_packets.schema.json, packages/audit-code/schemas/risk_register.schema.json, packages/audit-code/schemas/runtime_validation_report.schema.json, packages/audit-code/schemas/runtime_validation_tasks.schema.json, packages/audit-code/schemas/scope.schema.json, packages/audit-code/schemas/step_contract.schema.json, packages/audit-code/schemas/surface_manifest.schema.json, packages/audit-code/schemas/unit_manifest.schema.json, packages/audit-code/scripts/postinstall.mjs, packages/audit-code/scripts/release-and-publish.mjs, packages/audit-code/scripts/smoke-linked-audit-code.mjs, packages/audit-code/scripts/smoke-packaged-audit-code.mjs, packages/audit-code/scripts/update-languages.mjs, packages/audit-code/skills/audit-code/agents/openai.yaml, packages/audit-code/skills/audit-code/opencode-command-template.txt, packages/audit-code/src/adapters/coverageSummary.ts, packages/audit-code/src/adapters/eslint.ts, packages/audit-code/src/adapters/normalizeExternal.ts, packages/audit-code/src/adapters/npmAudit.ts, packages/audit-code/src/adapters/semgrep.ts, packages/audit-code/src/cli.ts, packages/audit-code/src/cli/advanceAuditCommand.ts, packages/audit-code/src/cli/args.ts, packages/audit-code/src/cli/auditStep.ts, packages/audit-code/src/cli/cleanup.ts, packages/audit-code/src/cli/cleanupCommand.ts, packages/audit-code/src/cli/dispatch.ts, packages/audit-code/src/cli/dispatchStatusCommand.ts, packages/audit-code/src/cli/envelope.ts, packages/audit-code/src/cli/explainTaskCommand.ts, packages/audit-code/src/cli/importExternalAnalyzerCommand.ts, packages/audit-code/src/cli/ingestResultsCommand.ts, packages/audit-code/src/cli/intakeCommand.ts, packages/audit-code/src/cli/lineIndex.ts, packages/audit-code/src/cli/mergeAndIngestCommand.ts, packages/audit-code/src/cli/nextStepCommand.ts, packages/audit-code/src/cli/paths.ts, packages/audit-code/src/cli/planCommand.ts, packages/audit-code/src/cli/prepareDispatchCommand.ts, packages/audit-code/src/cli/prompts.ts, packages/audit-code/src/cli/quotaCommand.ts, packages/audit-code/src/cli/requeueCommand.ts, packages/audit-code/src/cli/resynthesizeCommand.ts, packages/audit-code/src/cli/reviewRun.ts, packages/audit-code/src/cli/runToCompletion.ts, packages/audit-code/src/cli/sampleRunCommand.ts, packages/audit-code/src/cli/semanticReviewStep.ts, packages/audit-code/src/cli/statusCommand.ts, packages/audit-code/src/cli/steps.ts, packages/audit-code/src/cli/submitPacketCommand.ts, packages/audit-code/src/cli/synthesizeCommand.ts, packages/audit-code/src/cli/updateRuntimeValidationCommand.ts, packages/audit-code/src/cli/validateCommand.ts, packages/audit-code/src/cli/validateResultCommand.ts, packages/audit-code/src/cli/validateResultsCommand.ts, packages/audit-code/src/cli/waveManifest.ts, packages/audit-code/src/cli/workerResult.ts, packages/audit-code/src/cli/workerRunCommand.ts, packages/audit-code/src/coverage.ts, packages/audit-code/src/extractors/analyzers/css.ts, packages/audit-code/src/extractors/analyzers/html.ts, packages/audit-code/src/extractors/analyzers/merge.ts, packages/audit-code/src/extractors/analyzers/python.ts, packages/audit-code/src/extractors/analyzers/registry.ts, packages/audit-code/src/extractors/analyzers/resourceUrl.ts, packages/audit-code/src/extractors/analyzers/sql.ts, packages/audit-code/src/extractors/analyzers/treeSitter.ts, packages/audit-code/src/extractors/analyzers/types.ts, packages/audit-code/src/extractors/analyzers/typescript.ts, packages/audit-code/src/extractors/browserExtension.ts, packages/audit-code/src/extractors/bucketing.ts, packages/audit-code/src/extractors/designAssessment.ts, packages/audit-code/src/extractors/disposition.ts, packages/audit-code/src/extractors/fileInventory.ts, packages/audit-code/src/extractors/flows.ts, packages/audit-code/src/extractors/fsIntake.ts, packages/audit-code/src/extractors/graph.ts, packages/audit-code/src/extractors/graphManifestEdges/cargo.ts, packages/audit-code/src/extractors/graphManifestEdges/go.ts, packages/audit-code/src/extractors/graphManifestEdges/index.ts, packages/audit-code/src/extractors/graphManifestEdges/jsonc.ts, packages/audit-code/src/extractors/graphManifestEdges/maven.ts, packages/audit-code/src/extractors/graphManifestEdges/packageJson.ts, packages/audit-code/src/extractors/graphManifestEdges/pnpm.ts, packages/audit-code/src/extractors/graphManifestEdges/pyproject.ts, packages/audit-code/src/extractors/graphManifestEdges/toml.ts, packages/audit-code/src/extractors/graphManifestEdges/typescript.ts, packages/audit-code/src/extractors/graphManifestEdges/workspace.ts, packages/audit-code/src/extractors/graphManifestEdges/yaml.ts, packages/audit-code/src/extractors/graphManifestEdges/yamlPaths.ts, packages/audit-code/src/extractors/graphPathUtils.ts, packages/audit-code/src/extractors/graphPythonImports.ts, packages/audit-code/src/extractors/graphRoutes.ts, packages/audit-code/src/extractors/graphSuites.ts, packages/audit-code/src/extractors/graphTestSources.ts, packages/audit-code/src/extractors/ignore.ts, packages/audit-code/src/extractors/pathPatterns.ts, packages/audit-code/src/extractors/risk.ts, packages/audit-code/src/extractors/surfaces.ts, packages/audit-code/src/index.ts, packages/audit-code/src/io/artifacts.ts, packages/audit-code/src/io/runArtifactTypes.ts, packages/audit-code/src/io/runArtifacts.ts, packages/audit-code/src/io/toolingManifest.ts, packages/audit-code/src/orchestrator.ts, packages/audit-code/src/orchestrator/advance.ts, packages/audit-code/src/orchestrator/artifactFreshness.ts, packages/audit-code/src/orchestrator/artifactMetadata.ts, packages/audit-code/src/orchestrator/auditTaskUtils.ts, packages/audit-code/src/orchestrator/autoFixExecutor.ts, packages/audit-code/src/orchestrator/chunking.ts, packages/audit-code/src/orchestrator/dependencyMap.ts, packages/audit-code/src/orchestrator/designReviewPrompt.ts, packages/audit-code/src/orchestrator/edgeReasoning.ts, packages/audit-code/src/orchestrator/executorResult.ts, packages/audit-code/src/orchestrator/executors.ts, packages/audit-code/src/orchestrator/fileAnchors.ts, packages/audit-code/src/orchestrator/fileIntegrity.ts, packages/audit-code/src/orchestrator/flowCoverage.ts, packages/audit-code/src/orchestrator/flowPlanning.ts, packages/audit-code/src/orchestrator/flowRequeue.ts, packages/audit-code/src/orchestrator/graphEnrichmentExecutor.ts, packages/audit-code/src/orchestrator/ingestionExecutors.ts, packages/audit-code/src/orchestrator/intakeExecutors.ts, packages/audit-code/src/orchestrator/intentCheckpointExecutor.ts, packages/audit-code/src/orchestrator/lensSelection.ts, packages/audit-code/src/orchestrator/localCommands.ts, packages/audit-code/src/orchestrator/nextStep.ts, packages/audit-code/src/orchestrator/planning.ts, packages/audit-code/src/orchestrator/planningExecutors.ts, packages/audit-code/src/orchestrator/requeue.ts, packages/audit-code/src/orchestrator/requeueCommand.ts, packages/audit-code/src/orchestrator/resultIngestion.ts, packages/audit-code/src/orchestrator/reviewPacketGraph.ts, packages/audit-code/src/orchestrator/reviewPacketSizing.ts, packages/audit-code/src/orchestrator/reviewPackets.ts, packages/audit-code/src/orchestrator/runtimeCommand.ts, packages/audit-code/src/orchestrator/runtimeValidation.ts, packages/audit-code/src/orchestrator/runtimeValidationUpdate.ts, packages/audit-code/src/orchestrator/scope.ts, packages/audit-code/src/orchestrator/selectiveDeepening.ts, packages/audit-code/src/orchestrator/selectiveDeepening/conflict.ts, packages/audit-code/src/orchestrator/selectiveDeepening/findingFollowup.ts, packages/audit-code/src/orchestrator/selectiveDeepening/highRiskClean.ts, packages/audit-code/src/orchestrator/selectiveDeepening/index.ts, packages/audit-code/src/orchestrator/selectiveDeepening/lensVerification.ts, packages/audit-code/src/orchestrator/selectiveDeepening/runtimeValidation.ts, packages/audit-code/src/orchestrator/selectiveDeepening/shared.ts, packages/audit-code/src/orchestrator/selectiveDeepening/stewardFollowup.ts, packages/audit-code/src/orchestrator/staleness.ts, packages/audit-code/src/orchestrator/state.ts, packages/audit-code/src/orchestrator/structureExecutors.ts, packages/audit-code/src/orchestrator/syntaxResolutionExecutor.ts, packages/audit-code/src/orchestrator/synthesisExecutors.ts, packages/audit-code/src/orchestrator/taskBuilder.ts, packages/audit-code/src/orchestrator/trivialAudit.ts, packages/audit-code/src/orchestrator/unionFind.ts, packages/audit-code/src/orchestrator/unitBuilder.ts, packages/audit-code/src/prompts/renderWorkerPrompt.ts, packages/audit-code/src/providers/claudeCodeProvider.ts, packages/audit-code/src/providers/constants.ts, packages/audit-code/src/providers/index.ts, packages/audit-code/src/providers/opencodeProvider.ts, packages/audit-code/src/quota/discoveredLimits.ts, packages/audit-code/src/quota/headerExtraction.ts, packages/audit-code/src/quota/headerExtractors/claudeCodeHeaderExtractor.ts, packages/audit-code/src/quota/headerExtractors/genericHeaderExtractor.ts, packages/audit-code/src/quota/headerExtractors/index.ts, packages/audit-code/src/quota/hostLimits.ts, packages/audit-code/src/quota/index.ts, packages/audit-code/src/reporting/findingIdentity.ts, packages/audit-code/src/reporting/findingRanks.ts, packages/audit-code/src/reporting/mergeFindings.ts, packages/audit-code/src/reporting/synthesis.ts, packages/audit-code/src/reporting/synthesisNarrativePrompt.ts, packages/audit-code/src/reporting/workBlocks.ts, packages/audit-code/src/supervisor/operatorHandoff.ts, packages/audit-code/src/supervisor/runLedger.ts, packages/audit-code/src/supervisor/sessionConfig.ts, packages/audit-code/src/types.ts, packages/audit-code/src/types/activeDispatch.ts, packages/audit-code/src/types/analyzerCapability.ts, packages/audit-code/src/types/artifactMetadata.ts, packages/audit-code/src/types/auditScope.ts, packages/audit-code/src/types/auditState.ts, packages/audit-code/src/types/designAssessment.ts, packages/audit-code/src/types/externalAnalyzer.ts, packages/audit-code/src/types/flowCoverage.ts, packages/audit-code/src/types/reviewPlanning.ts, packages/audit-code/src/types/runtimeValidation.ts, packages/audit-code/src/types/synthesisNarrative.ts, packages/audit-code/src/types/toolingManifest.ts, packages/audit-code/src/types/workerResult.ts, packages/audit-code/src/types/workerSession.ts, packages/audit-code/src/validation/artifacts.ts, packages/audit-code/src/validation/auditResults.ts, packages/audit-code/src/validation/sessionConfig.ts, packages/audit-code/tests/adapters-remediation.test.mjs, packages/audit-code/tests/advance-error-paths.test.mjs, packages/audit-code/tests/analyzer-seam.test.mjs, packages/audit-code/tests/audit-code-completion.test.mjs, packages/audit-code/tests/audit-code-lifecycle.test.mjs, packages/audit-code/tests/audit-code-wrapper.test.mjs, packages/audit-code/tests/audit-task-utils.test.mjs, packages/audit-code/tests/auto-fix-executor-timings.test.mjs, packages/audit-code/tests/auto-fix-executor.test.mjs, packages/audit-code/tests/browser-extension-utils.test.mjs, packages/audit-code/tests/capture-console.test.mjs, packages/audit-code/tests/chunking.test.mjs, packages/audit-code/tests/cleanup.test.mjs, packages/audit-code/tests/cli-args-utils.test.mjs, packages/audit-code/tests/cli-dispatcher.test.mjs, packages/audit-code/tests/cli-remediation.test.mjs, packages/audit-code/tests/command-rendering.test.mjs, packages/audit-code/tests/config-error-handling.test.mjs, packages/audit-code/tests/coverage.test.mjs, packages/audit-code/tests/design-assessment.test.mjs, packages/audit-code/tests/design-review-budget.test.mjs, packages/audit-code/tests/discovered-limits.test.mjs, packages/audit-code/tests/dispatch-fanout.test.mjs, packages/audit-code/tests/dispatch-features.test.mjs, packages/audit-code/tests/dispatch-helpers.test.mjs, packages/audit-code/tests/dispatch-model-hint.test.mjs, packages/audit-code/tests/dispatch-prompt.test.mjs, packages/audit-code/tests/dispatch-quota-constants.test.mjs, packages/audit-code/tests/dispatch-scripts.test.mjs, packages/audit-code/tests/dispatch-validate.test.mjs, packages/audit-code/tests/edge-reasoning.test.mjs, packages/audit-code/tests/entrypoint-contract.test.mjs, packages/audit-code/tests/envelope.test.mjs, packages/audit-code/tests/executor-registry-sync.test.mjs, packages/audit-code/tests/extractors-remediation.test.mjs, packages/audit-code/tests/field-trial-remediation.test.mjs, packages/audit-code/tests/file-anchors.test.mjs, packages/audit-code/tests/file-inventory-language.test.mjs, packages/audit-code/tests/finalization-convergence.test.mjs, packages/audit-code/tests/finalization-cycle-guard.test.mjs, packages/audit-code/tests/finding-identity.test.mjs, packages/audit-code/tests/finding-ranks.test.mjs, packages/audit-code/tests/fixture-repo.test.mjs, packages/audit-code/tests/flow-coverage.test.mjs, packages/audit-code/tests/flow-planning.test.mjs, packages/audit-code/tests/fs-intake.test.mjs, packages/audit-code/tests/graph-enrichment-observability.test.mjs, packages/audit-code/tests/graph-framework-routes.test.mjs, packages/audit-code/tests/graph-heuristic-edges.test.mjs, packages/audit-code/tests/graph-manifest-edges.test.mjs, packages/audit-code/tests/graph-path-utils.test.mjs, packages/audit-code/tests/graph-python-imports.test.mjs, packages/audit-code/tests/graph-test-sources.test.mjs, packages/audit-code/tests/header-extraction.test.mjs, packages/audit-code/tests/helpers-withTempDir.test.mjs, packages/audit-code/tests/helpers/auditSchemaRegistry.mjs, packages/audit-code/tests/helpers/captureConsole.mjs, packages/audit-code/tests/helpers/countLines.mjs, packages/audit-code/tests/helpers/fixture.mjs, packages/audit-code/tests/helpers/jsonSchemaAssert.mjs, packages/audit-code/tests/helpers/provider-assisted-bridge.mjs, packages/audit-code/tests/helpers/run-wrapper.mjs, packages/audit-code/tests/helpers/sourceImport.mjs, packages/audit-code/tests/helpers/synthetic-results.mjs, packages/audit-code/tests/helpers/validate.mjs, packages/audit-code/tests/helpers/withTempDir.mjs, packages/audit-code/tests/host-bootstrap-descriptors.test.mjs, packages/audit-code/tests/intake-scope-summary.test.mjs, packages/audit-code/tests/io-remediation.test.mjs, packages/audit-code/tests/json-schema-assert.test.mjs, packages/audit-code/tests/lens-guard.test.mjs, packages/audit-code/tests/lens-selection.test.mjs, packages/audit-code/tests/line-index.test.mjs, packages/audit-code/tests/local-commands-resolve.test.mjs, packages/audit-code/tests/merge-findings-dedup.test.mjs, packages/audit-code/tests/next-step-edge-reasoning.test.mjs, packages/audit-code/tests/next-step-helpers.test.mjs, packages/audit-code/tests/next-step-narrative.test.mjs, packages/audit-code/tests/next-step.test.mjs, packages/audit-code/tests/observability-signals.test.mjs, packages/audit-code/tests/orchestration.test.mjs, packages/audit-code/tests/orchestrator-remediation.test.mjs, packages/audit-code/tests/orchestrator.test.mjs, packages/audit-code/tests/planning-executors.test.mjs, packages/audit-code/tests/postinstall-contract.test.mjs, packages/audit-code/tests/priority-chain-doc-sync.test.mjs, packages/audit-code/tests/prompt-invocation.test.mjs, packages/audit-code/tests/provider-assisted-bridge.test.mjs, packages/audit-code/tests/provider-assisted-continuation.test.mjs, packages/audit-code/tests/provider-auto-resolution.test.mjs, packages/audit-code/tests/providers-remediation.test.mjs, packages/audit-code/tests/python-logical-lines.test.mjs, packages/audit-code/tests/quota-error-parsers.test.mjs, packages/audit-code/tests/quota-error-parsing.test.mjs, packages/audit-code/tests/quota-file-lock.test.mjs, packages/audit-code/tests/quota-limits.test.mjs, packages/audit-code/tests/quota-packets.test.mjs, packages/audit-code/tests/quota-scheduler.test.mjs, packages/audit-code/tests/quota-sliding-window.test.mjs, packages/audit-code/tests/quota-source.test.mjs, packages/audit-code/tests/release-contract.test.mjs, packages/audit-code/tests/render-dispatch-review-prompt.test.mjs, packages/audit-code/tests/render-worker-prompt.test.mjs, packages/audit-code/tests/reporting-remediation.test.mjs, packages/audit-code/tests/resource-url.test.mjs, packages/audit-code/tests/result-ingestion.test.mjs, packages/audit-code/tests/resynthesize-command.test.mjs, packages/audit-code/tests/review-packets.test.mjs, packages/audit-code/tests/review-run-lifecycle.test.mjs, packages/audit-code/tests/run-artifacts-logging.test.mjs, packages/audit-code/tests/run-ledger.test.mjs, packages/audit-code/tests/run-to-completion-guards.test.mjs, packages/audit-code/tests/runtime-command.test.mjs, packages/audit-code/tests/runtime-validation-merge.test.mjs, packages/audit-code/tests/runtime-validation-update.test.mjs, packages/audit-code/tests/schema-contracts.test.mjs, packages/audit-code/tests/scope.test.mjs, packages/audit-code/tests/semantic-review-step.test.mjs, packages/audit-code/tests/session-start-hook.test.mjs, packages/audit-code/tests/staleness.test.mjs, packages/audit-code/tests/state-budget-obligation.test.mjs, packages/audit-code/tests/status-command.test.mjs, packages/audit-code/tests/steps-write-current-step.test.mjs, packages/audit-code/tests/submit-packet-command.test.mjs, packages/audit-code/tests/supervisor-remediation.test.mjs, packages/audit-code/tests/syntax-resolution.test.mjs, packages/audit-code/tests/synthesis-budget.test.mjs, packages/audit-code/tests/synthesis-narrative-prompt.test.mjs, packages/audit-code/tests/synthesis-narrative.test.mjs, packages/audit-code/tests/tree-sitter-analyzers.test.mjs, packages/audit-code/tests/tree-sitter-language-cache.test.mjs, packages/audit-code/tests/trivial-audit.test.mjs, packages/audit-code/tests/typescript-analyzer.test.mjs, packages/audit-code/tests/union-find.test.mjs, packages/audit-code/tests/validate-command.test.mjs, packages/audit-code/tests/validation-remediation.test.mjs, packages/audit-code/tests/wave-manifest.test.mjs, packages/audit-code/tests/within-root.test.mjs, packages/audit-code/tests/work-blocks.test.mjs, packages/audit-code/tests/worker-result.test.mjs, packages/audit-code/tests/worker-run-command-write-failure.test.mjs, packages/audit-code/tests/worker-run-command.test.mjs, packages/audit-code/tests/working-directory-prompts.test.mjs, packages/audit-code/tsconfig.json, packages/remediate-code/.gitignore, packages/remediate-code/.opencode/.gitignore, packages/remediate-code/.opencode/package.json, packages/remediate-code/.smoke-tmp/remediate-code-smoke-4sXp3q/install/package.json, packages/remediate-code/.smoke-tmp/remediate-code-smoke-4sXp3q/npm-cache/_cacache/content-v2/sha512/29/c3/042eb3238182b69c2f8d4f205570838715fed50c09d67d11a20e980f7ef22fdabed497b043479856f7ea8755c0423dabee893253419267002cf5d493bb3a, packages/remediate-code/.smoke-tmp/remediate-code-smoke-4sXp3q/npm-cache/_cacache/index-v5/b2/c7/c86481ccd7b7d7756369c1bed8912fbabc87dfe278c09175b6630214ce3c, packages/remediate-code/.smoke-tmp/remediate-code-smoke-4sXp3q/npm-cache/_cacache/index-v5/c9/10/07121c98f70effee06b108eb7220cb5ac80081c21a8e14701b583a23e530, packages/remediate-code/.smoke-tmp/remediate-code-smoke-4sXp3q/npm-cache/_cacache/index-v5/e0/99/06c864ebf7d361f2978e27c9e0bfa9b3ae46062ab51c653cca1a7816a938, packages/remediate-code/.smoke-tmp/remediate-code-smoke-4sXp3q/npm-cache/_update-notifier-last-checked, packages/remediate-code/.vscode/mcp.json, packages/remediate-code/opencode.json, packages/remediate-code/package.json, packages/remediate-code/remediate-code.mjs, packages/remediate-code/remediator-lambda-0.1.4.tgz, packages/remediate-code/remediator-lambda-0.3.5.tgz, packages/remediate-code/schemas/clarification_request.schema.json, packages/remediate-code/schemas/closing_plan.schema.json, packages/remediate-code/schemas/closing_result.schema.json, packages/remediate-code/schemas/contract_pipeline.schema.json, packages/remediate-code/schemas/dispatch_plan.schema.json, packages/remediate-code/schemas/dispatch_quota.schema.json, packages/remediate-code/schemas/finding.schema.json, packages/remediate-code/schemas/item_spec.schema.json, packages/remediate-code/schemas/remediation_block.schema.json, packages/remediate-code/schemas/remediation_outcomes.schema.json, packages/remediate-code/schemas/remediation_plan.schema.json, packages/remediate-code/schemas/remediation_report.schema.json, packages/remediate-code/schemas/shared.schema.json, packages/remediate-code/schemas/step.schema.json, packages/remediate-code/schemas/test_spec.schema.json, packages/remediate-code/schemas/triage_batch.schema.json, packages/remediate-code/schemas/verification_result.schema.json, packages/remediate-code/schemas/worker_result.schema.json, packages/remediate-code/scripts/generate-auditor-contract-fixture.mjs, packages/remediate-code/scripts/postinstall.mjs, packages/remediate-code/scripts/release-and-publish.mjs, packages/remediate-code/scripts/smoke-linked-remediate-code.mjs, packages/remediate-code/scripts/smoke-packaged-remediate-code.mjs, packages/remediate-code/skills/remediate-code/agents/openai.yaml, packages/remediate-code/src/contractPipeline/artifactStore.ts, packages/remediate-code/src/dedup/crossLensDedup.ts, packages/remediate-code/src/index.ts, packages/remediate-code/src/intake.ts, packages/remediate-code/src/phases/close.ts, packages/remediate-code/src/phases/constants.ts, packages/remediate-code/src/phases/document.ts, packages/remediate-code/src/phases/implement.ts, packages/remediate-code/src/phases/plan.ts, packages/remediate-code/src/phases/triage.ts, packages/remediate-code/src/phases/workerTasks.ts, packages/remediate-code/src/providers/claudeCodeProvider.ts, packages/remediate-code/src/providers/constants.ts, packages/remediate-code/src/providers/index.ts, packages/remediate-code/src/providers/opencodeProvider.ts, packages/remediate-code/src/quota/hostLimits.ts, packages/remediate-code/src/quota/index.ts, packages/remediate-code/src/state/closingActions.ts, packages/remediate-code/src/state/store.ts, packages/remediate-code/src/state/types.ts, packages/remediate-code/src/steps/contractPipeline.ts, packages/remediate-code/src/steps/contractPipelinePrompts.ts, packages/remediate-code/src/steps/dispatch.ts, packages/remediate-code/src/steps/intakeResolver.ts, packages/remediate-code/src/steps/nextStep.ts, packages/remediate-code/src/steps/prompts.ts, packages/remediate-code/src/steps/stepUtils.ts, packages/remediate-code/src/steps/stepWriter.ts, packages/remediate-code/src/steps/types.ts, packages/remediate-code/src/steps/waveScheduler.ts, packages/remediate-code/src/types/options.ts, packages/remediate-code/src/types/workerSession.ts, packages/remediate-code/src/utils/commands.ts, packages/remediate-code/src/utils/fileIntegrity.ts, packages/remediate-code/src/validation/artifacts.ts, packages/remediate-code/src/validation/contractPipeline.ts, packages/remediate-code/src/validation/remediationState.ts, packages/remediate-code/tests/artifacts-validation.test.ts, packages/remediate-code/tests/classify-finding-risk.test.ts, packages/remediate-code/tests/command-rendering.test.ts, packages/remediate-code/tests/contract-pipeline-artifact-store.test.ts, packages/remediate-code/tests/contract-pipeline-prompts.test.ts, packages/remediate-code/tests/contract-pipeline.test.ts, packages/remediate-code/tests/cross-lens-dedup.test.ts, packages/remediate-code/tests/dispatch-conventions.test.ts, packages/remediate-code/tests/dispatch-model-hints.test.ts, packages/remediate-code/tests/dispatch-reconciliation.test.ts, packages/remediate-code/tests/file-integrity.test.ts, packages/remediate-code/tests/install-repo-assets.test.ts, packages/remediate-code/tests/intake-resolver.test.ts, packages/remediate-code/tests/io.test.ts, packages/remediate-code/tests/model-hints.test.ts, packages/remediate-code/tests/next-step.test.ts, packages/remediate-code/tests/phase-close.test.ts, packages/remediate-code/tests/phase-document.test.ts, packages/remediate-code/tests/phase-implement.test.ts, packages/remediate-code/tests/phase-plan-parse.test.ts, packages/remediate-code/tests/phase-plan-test-graph.test.ts, packages/remediate-code/tests/phase-plan.test.ts, packages/remediate-code/tests/phase-triage.test.ts, packages/remediate-code/tests/postinstall.test.ts, packages/remediate-code/tests/providers.test.ts, packages/remediate-code/tests/quota-error-parsers.test.ts, packages/remediate-code/tests/quota-error-parsing.test.ts, packages/remediate-code/tests/quota-file-lock.test.ts, packages/remediate-code/tests/quota-scheduler.test.ts, packages/remediate-code/tests/quota-sliding-window.test.ts, packages/remediate-code/tests/quota-source.test.ts, packages/remediate-code/tests/remediate-code.test.ts, packages/remediate-code/tests/remediation-coverage.json, packages/remediate-code/tests/remediation-outcomes.json, packages/remediate-code/tests/remediation-outcomes.test.ts, packages/remediate-code/tests/remediation-report.json, packages/remediate-code/tests/schema-contracts.test.ts, packages/remediate-code/tests/spec-no-change.test.ts, packages/remediate-code/tests/step-utils.test.ts, packages/remediate-code/tests/store.test.ts, packages/remediate-code/tests/test-helpers.ts, packages/remediate-code/tests/validation.test.ts, packages/remediate-code/tests/wave-scheduler.test.ts, packages/remediate-code/tests/working-directory-prompts.test.ts, packages/remediate-code/tsconfig.json, packages/remediate-code/vitest.config.ts, packages/shared/package.json, packages/shared/scripts/release-and-publish.mjs, packages/shared/src/contracts.ts, packages/shared/src/git.ts, packages/shared/src/index.ts, packages/shared/src/io/json.ts, packages/shared/src/observability/runLog.ts, packages/shared/src/parsing/stringAwareScanner.ts, packages/shared/src/prompts.ts, packages/shared/src/providers/codexProvider.ts, packages/shared/src/providers/constants.ts, packages/shared/src/providers/localSubprocessProvider.ts, packages/shared/src/providers/opencodeLaunch.ts, packages/shared/src/providers/providerFactory.ts, packages/shared/src/providers/spawnLoggedCommand.ts, packages/shared/src/providers/subprocessTemplateProvider.ts, packages/shared/src/providers/types.ts, packages/shared/src/providers/workerTaskLaunch.ts, packages/shared/src/quota/capacity.ts, packages/shared/src/quota/compositeQuotaSource.ts, packages/shared/src/quota/errorParsers/claudeCodeErrorParser.ts, packages/shared/src/quota/errorParsers/genericErrorParser.ts, packages/shared/src/quota/errorParsers/index.ts, packages/shared/src/quota/errorParsing.ts, packages/shared/src/quota/fileLock.ts, packages/shared/src/quota/hostLimits.ts, packages/shared/src/quota/learnedQuotaSource.ts, packages/shared/src/quota/limits.ts, packages/shared/src/quota/quotaSource.ts, packages/shared/src/quota/scheduler.ts, packages/shared/src/quota/slidingWindow.ts, packages/shared/src/quota/state.ts, packages/shared/src/quota/types.ts, packages/shared/src/tokens.ts, packages/shared/src/tooling/analyzerDeps.ts, packages/shared/src/tooling/exec.ts, packages/shared/src/tooling/repoConventions.ts, packages/shared/src/tooling/testCommand.ts, packages/shared/src/types/accessDeclaration.ts, packages/shared/src/types/contractPipeline.ts, packages/shared/src/types/disposition.ts, packages/shared/src/types/finding.ts, packages/shared/src/types/flows.ts, packages/shared/src/types/graph.ts, packages/shared/src/types/intentCheckpoint.ts, packages/shared/src/types/lens.ts, packages/shared/src/types/remediationOutcome.ts, packages/shared/src/types/risk.ts, packages/shared/src/types/runLedger.ts, packages/shared/src/types/sessionConfig.ts, packages/shared/src/types/stepContract.ts, packages/shared/src/types/surfaces.ts, packages/shared/src/validation/basic.ts, packages/shared/tests/analyzerDeps.test.mjs, packages/shared/tests/capacity.test.mjs, packages/shared/tests/codex-antigravity-providers.test.mjs, packages/shared/tests/compositeQuotaSource.test.mjs, packages/shared/tests/errorParsing.test.mjs, packages/shared/tests/exec.test.mjs, packages/shared/tests/fileLock.test.mjs, packages/shared/tests/git.test.mjs, packages/shared/tests/io-json-ndjson.test.mjs, packages/shared/tests/io-json-retry.test.mjs, packages/shared/tests/learnedQuotaSource.test.mjs, packages/shared/tests/opencode-launch.test.mjs, packages/shared/tests/prefixValidationIssues.test.mjs, packages/shared/tests/quota-state.test.mjs, packages/shared/tests/repoConventions.test.mjs, packages/shared/tests/runLog.test.mjs, packages/shared/tests/runtimeConstants.test.mjs, packages/shared/tests/scheduler.test.mjs, packages/shared/tests/sliding-window-property.test.mjs, packages/shared/tests/spawnLoggedCommand.test.mjs, packages/shared/tests/string-aware-scanner.test.mjs, packages/shared/tests/subprocessTemplateProvider.test.mjs, packages/shared/tests/testCommand.test.mjs, packages/shared/tests/tokens.test.mjs, packages/shared/tests/validation-basic.test.mjs, packages/shared/tests/vscode-task-provider.test.mjs, packages/shared/tests/worker-task-launch.test.mjs, packages/shared/tsconfig.json, packages/shared/tsconfig.tsbuildinfo
- Findings: ARC-23f9165e, CFG-4996560e, COR-11b75f89, COR-281a9b14, COR-49db2f4c, COR-53c7a3ee, COR-717ec279, COR-733266d1, COR-7aa2af30, COR-d31c8ea3, COR-f3c7d732, DAT-2624dff3, DAT-27cf4ebf, DAT-a0f81718, DAT-c014c153, DAT-ed4f3508, MNT-1a260410, MNT-57884bf8, REL-3c247ea1, REL-77285661, SEC-4747c5bf, TST-20f6280d, TST-9a4da7e5, ARC-3ab15025, ARC-564b31b7, ARC-64a1885c, ARC-6f37a71f, ARC-70bcf944, ARC-7cef647f, CFG-0843f20d, CFG-1c5c3d00, CFG-db4f5dbe, COR-5750c464, COR-5e3e2f8c, COR-6464fa65, COR-68ff21b2, COR-870ff293, COR-8779d235, COR-92cef10f, COR-a75b570b, COR-a9f5638a, COR-b4233406, COR-b4867804, COR-fa0b9d7e, DAT-4196a3f0, DAT-829e1d58, DAT-b813ae78, DAT-bb581ba4, MNT-0047837c, MNT-00f19b47, MNT-050283cd, MNT-06e4a393, MNT-091ea127, MNT-099239c5, MNT-0f966aa9, MNT-139d4e8c, MNT-14d407a2, MNT-179aac32, MNT-1acb2985, MNT-2b8c9b96, MNT-35666586, MNT-35a52f2e, MNT-3a1a4244, MNT-3a5ea976, MNT-3c895432, MNT-3cc3b849, MNT-40e7f88e, MNT-49c97832, MNT-4fef4d4f, MNT-50c25acb, MNT-50c7a63d, MNT-52afa354, MNT-53a85f8e, MNT-54aa8b51, MNT-5e5beab9, MNT-5f6bacdc, MNT-676d7e9e, MNT-68f7a179, MNT-701044bc, MNT-74ca9e58, MNT-7bada16b, MNT-88e63198, MNT-96f399f2, MNT-a5971908, MNT-a5be811c, MNT-ac254921, MNT-af05ed71, MNT-c724d334, MNT-ccc69b88, MNT-d671c06f, MNT-d7ae2055, MNT-d7fb0e04, MNT-da2276f9, MNT-dbfed56d, MNT-dc17d71d, MNT-e0a36ad7, MNT-e2541667, MNT-e2564b39, MNT-e2bbee08, MNT-e607f9bc, MNT-f020b0c4, OBS-01650bcb, OBS-01971b40, OBS-094d17cf, OBS-12a91d6b, OBS-1934f2fe, OBS-2ab59697, OBS-2f7af7bb, OBS-425859fa, OBS-77319328, OBS-886b64e7, OBS-8d5ecbf8, OBS-912c5926, OBS-ab3ffaeb, OBS-b1148341, OBS-b63d3314, OBS-d574efd7, OBS-e0de82a4, OBS-f1fcbeca, OPR-29e4fc2a, OPR-aec9c7ae, REL-0c49633f, REL-96019c44, REL-c30e25f7, REL-f524ba6d, SEC-b501a621, TST-1b04654d, TST-25fbb3fd, TST-3b209ceb, TST-444ed4b2, TST-4bcf7294, TST-5b4189a9, TST-5dd98fc7, TST-5f3b4446, TST-64db5f4d, TST-7620db54, TST-7c24b3a7, TST-85aaa50e, TST-9140ec42, TST-a660d2af, TST-c4670110, TST-c785923a, TST-d432360f, TST-d94a5d30, TST-e8ea387e, COR-034b1149, COR-1e12f6c7, COR-4bfc5a1c, COR-7d79757a, COR-f49f2bb0, DAT-1c70cb98, DAT-56bc2ac3, MNT-0280324f, MNT-0409cd1f, MNT-0d172686, MNT-15e4ef9a, MNT-1a26fa39, MNT-1d82f425, MNT-21aa9255, MNT-240d873b, MNT-288dbefe, MNT-29382fae, MNT-2fb0ff05, MNT-357c24c3, MNT-3d13f43b, MNT-46cb071f, MNT-4a64f623, MNT-4a73b42e, MNT-4a99b757, MNT-544b0f3a, MNT-599a4c9c, MNT-5cca9f90, MNT-5d2e2aff, MNT-5ff14c03, MNT-6596c1bc, MNT-69d6c145, MNT-6c6133d3, MNT-706be541, MNT-70c97d00, MNT-71b801ee, MNT-728df9d6, MNT-75c0a87a, MNT-7c475097, MNT-7ca3f932, MNT-8a94683f, MNT-92e161d1, MNT-9368dc49, MNT-94dd9425, MNT-9559094e, MNT-96e0a844, MNT-97cbaf84, MNT-98a05c9e, MNT-9fd8bd99, MNT-a396d454, MNT-adbb4c63, MNT-adc5c18a, MNT-af730b00, MNT-b26da9be, MNT-b745e454, MNT-b8976886, MNT-baf3b580, MNT-bd164109, MNT-c270bfd1, MNT-c666ef4f, MNT-c6693d57, MNT-c935abb2, MNT-cdb34f9b, MNT-d2601c34, MNT-d27f79fd, MNT-d5bc74c2, MNT-d75200ed, MNT-e06234df, MNT-e42b3f2f, MNT-e4c76de2, MNT-e7373005, MNT-e76b4117, MNT-f0706501, MNT-f95ab48c, OBS-187ef6c0, OBS-2658a6d3, OBS-28770651, OBS-3ec822ec, OBS-480cad6f, OBS-4b3d5259, OBS-4e642510, OBS-57837e48, OBS-57c8ddd7, OBS-5edc372b, OBS-6556d8c5, OBS-66779c90, OBS-6da9692d, OBS-7967d365, OBS-7acf324f, OBS-83cac0dc, OBS-859bdecd, OBS-a41f0eb5, OBS-a54af07e, OBS-a925bb4c, OBS-b6240645, OBS-bd30a2e5, OBS-bf664ef3, OBS-c35c4b50, OBS-ca696134, OBS-cb52b4e2, OBS-e7f2eed6, OBS-f3525202, OPR-7e7f52c7, OPR-93a95c6e, REL-6bb73c2b, REL-787a811b, REL-986966df, TST-0c3df6aa, TST-1c2c03b5, TST-220027ee, TST-55fe67e6, TST-5be73597, TST-7ec04338, TST-d27212b9, TST-d3216c57, TST-e1aa5f48, TST-ebba1500, TST-ef420164, MNT-7aa8b6c0, MNT-91151d44, MNT-ae7bc99f, MNT-c2893486, MNT-c93dbd0d, MNT-d53b9f50, OBS-3e40e474, OBS-4d90afa3, OBS-844af2bf, OBS-8a6d6f05
- Depends on: none
- Rationale: Findings share owned units transitively and should remain one non-overlapping remediation block.

### block-2

- Max severity: high
- Units: -codex, -remediation-artifacts, -vscode, audit
- Owned files: .codex/hooks.json, .remediation-artifacts/run.log.jsonl, .vscode/mcp.json, audit/audit-findings.json
- Findings: MNT-6c66181b, MNT-74f84bb0, MNT-e7ada589, ARC-4bb18f75
- Depends on: none
- Rationale: Findings share owned units transitively and should remain one non-overlapping remediation block.

### block-3

- Max severity: medium
- Units: -github-workflows
- Owned files: .github/workflows/ci.yml, .github/workflows/publish-package.yml
- Findings: OPR-fd8d2843, REL-46214fdc, CFG-306d2705
- Depends on: none
- Rationale: All findings map to the same owned unit and should be remediated together.

### block-4

- Max severity: medium
- Units: scripts
- Owned files: scripts/release-changed.mjs
- Findings: CFG-4f714882
- Depends on: none
- Rationale: All findings map to the same owned unit and should be remediated together.

### block-5

- Max severity: low
- Units: -gemini-commands
- Owned files: .gemini/commands/audit-code.toml
- Findings: MNT-375af3c5
- Depends on: none
- Rationale: All findings map to the same owned unit and should be remediated together.

## Findings

### COR-11b75f89 — App Router page.* files produce wrong conventional route paths

- Severity: high
- Confidence: high
- Lens: correctness
- Category: logic-error
- Files: packages/audit-code/src/extractors/graphRoutes.ts
- Summary: conventionalRoutePath matches only route.* files under app/ directories, but Next.js App Router also uses page.* files to define pages at the directory level. A file like app/api/users/page.ts falls through to the legacy pages-router logic, producing /api/users/page instead of the correct /api/users. This silently mislabels API routes in App Router projects.
- Evidence:
  - packages/audit-code/src/extractors/graphRoutes.ts:303 - the app branch only checks fileName.startsWith("route."), excluding page.* files
  - packages/audit-code/src/extractors/graphRoutes.ts:309-316 - page.* files fall through to pages-router logic which incorrectly includes the leaf filename as a path segment
  - packages/audit-code/src/extractors/graphRoutes.ts:314 - stripSourceExtension produces 'page' which is appended as a final path segment, producing wrong routes

### REL-77285661 — Claude Code and OpenCode Provider Command Line Length Limit on Windows

- Severity: high
- Confidence: high
- Lens: reliability
- Category: trust_boundary_gap
- Files: packages/audit-code/src/providers/claudeCodeProvider.ts, packages/audit-code/src/providers/opencodeProvider.ts
- Summary: In packages/audit-code/src/providers/claudeCodeProvider.ts and packages/audit-code/src/providers/opencodeProvider.ts, the entire generated prompt string is passed as a command-line argument when spawning the subprocess. On Windows, command lines are capped at 8191 characters. Large prompts containing file inventories, structures, or rules will easily exceed this limit, causing the provider to crash with E2BIG or run into silent truncation bugs. In contrast, packages/remediate-code/src/providers handles this safely by passing the prompt content via standard input (stdinText). The audit-code providers should be updated to pass prompts via standard input to ensure reliability on Windows.

### SEC-4747c5bf — Command injection in provider environment validation

- Severity: high
- Confidence: high
- Lens: security
- Category: command-execution
- Files: packages/audit-code/src/validation/sessionConfig.ts
- Summary: The `commandExists` function uses `execAsync` to execute command validation via shell lookups (`where` or `which`) without checking for shell subshell metacharacters like `$()`. A malicious repository config could execute arbitrary commands when environment validation is run.
- Evidence:
  - packages/audit-code/src/validation/sessionConfig.ts:176 - commandExists uses execAsync with unsanitized command parameter
  - packages/audit-code/src/validation/sessionConfig.ts:176 - commandExists uses execAsync with unsanitized command parameter containing subshell characters like $() that escape isBareExecutableName validation

### ARC-23f9165e — Dependency cycle: 6 modules

- Severity: high
- Confidence: high
- Lens: architecture
- Category: dependency_cycle
- Files: packages/audit-code/src/cli.ts, packages/audit-code/src/cli/advanceAuditCommand.ts, packages/audit-code/src/cli/args.ts, packages/audit-code/src/cli/auditStep.ts, packages/audit-code/src/index.ts, packages/audit-code/src/io/artifacts.ts, packages/audit-code/src/io/toolingManifest.ts
- Summary: Circular dependency among packages/audit-code/src/cli.ts → packages/audit-code/src/cli/advanceAuditCommand.ts → packages/audit-code/src/cli/auditStep.ts → packages/audit-code/src/io/artifacts.ts → packages/audit-code/src/io/toolingManifest.ts → packages/audit-code/src/index.ts → packages/audit-code/src/cli.ts. Cycles increase coupling, complicate testing, and can cause initialization-order bugs.

### COR-7aa2af30 — Dispatch artifacts reference wrong repository root

- Severity: high
- Confidence: high
- Lens: correctness
- Category: invalid-path
- Files: packages/audit-code/.audit-artifacts/dispatch/current-task.json, packages/audit-code/.audit-artifacts/dispatch/current-single-task.json
- Summary: dispatch/current-task.json and dispatch/current-single-task.json hardcode repo_root as C:\Code\auditor-lambda and C:\Code\auditor-lambda paths, but the current workspace is C:\Code\audit-tools. If consumed directly for task dispatch, these paths will fail to resolve.
- Evidence:
  - packages/audit-code/.audit-artifacts/dispatch/current-task.json:4 - repo_root is C:\Code\auditor-lambda, not C:\Code\audit-tools
  - packages/audit-code/.audit-artifacts/dispatch/current-single-task.json:4 - repo_root is C:\Code\auditor-lambda, not C:\Code\audit-tools

### MNT-1a260410 — Dispatch files contain environment-coupled absolute paths

- Severity: high
- Confidence: high
- Lens: maintainability
- Category: hardcoded-configuration
- Files: packages/audit-code/.audit-artifacts/dispatch/current-task.json, packages/audit-code/.audit-artifacts/dispatch/current-single-task.json
- Summary: dispatch/current-task.json and dispatch/current-single-task.json hardcode C:\Code\auditor-lambda as repo_root and in worker_command paths. This couples the artifacts to a specific development machine and makes them non-portable across environments.
- Evidence:
  - packages/audit-code/.audit-artifacts/dispatch/current-task.json:4-5 - repo_root and result_path use C:\Code\auditor-lambda
  - packages/audit-code/.audit-artifacts/dispatch/current-single-task.json:4 - repo_root uses C:\Code\auditor-lambda

### DAT-a0f81718 — Duplicate schema $id with divergent structure between schemas/ and dispatch/ directories

- Severity: high
- Confidence: high
- Lens: data_integrity
- Category: schema-violation
- Files: packages/audit-code/.audit-artifacts/dispatch/audit-result.schema.json, packages/audit-code/.audit-artifacts/dispatch/audit-result.schema.json, packages/audit-code/.audit-artifacts/dispatch/audit-results.schema.json, packages/audit-code/schemas/audit_result.schema.json, packages/audit-code/schemas/audit_result.schema.json, packages/audit-code/schemas/audit_results.schema.json
- Summary: Deepening confirms DI-P1-001 stands at high/high: two schema files claim $id 'audit_result.schema.json' but diverge structurally. schemas/audit_result.schema.json uses $ref for lens, includes run_id and submitted_at, and uses AuditTask objects for followup_tasks. dispatch/audit-result.schema.json inlines the lens enum, omits run_id/submitted_at, and uses string IDs for followup_tasks. Any resolver loading by $id produces inconsistent validation results depending on load order.
- Evidence:
  - packages/audit-code/schemas/audit_result.schema.json:26 - lens uses $ref: 'lens.schema.json'
  - packages/audit-code/.audit-artifacts/dispatch/audit-result.schema.json:26-28 - lens inlines type+string enum
  - packages/audit-code/schemas/audit_result.schema.json:79-80 - has run_id and submitted_at
  - packages/audit-code/.audit-artifacts/dispatch/audit-result.schema.json:83 - lacks run_id and submitted_at
  - packages/audit-code/schemas/audit_result.schema.json:3 - $id: 'audit_result.schema.json', lens uses $ref at line 26, has run_id at line 79, submitted_at at line 80, followup_tasks as objects ($ref #/$defs/AuditTask) at line 73
  - packages/audit-code/.audit-artifacts/dispatch/audit-result.schema.json:3 - Same $id: 'audit_result.schema.json', lens is inline enum at line 28, no run_id/submitted_at, followup_tasks are strings (type:string) at line 54
  - packages/audit-code/.audit-artifacts/dispatch/audit-results.schema.json:3 - $id: 'audit_results.schema.json', $ref points to audit_result.schema.json which resolver may resolve to either file

### MNT-57884bf8 — Duplicated fixture object construction across tests

- Severity: high
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/audit-code/tests/orchestrator-remediation.test.mjs
- Summary: The orchestrator-remediation test file constructs the same task fixture object shape (task_id/unit_id/pass_id/lens/file_paths/file_line_counts/rationale/priority/status) inline approximately 20 times across tests, with 70 task_id references and 32 file_line_counts references. A shared fixture factory would eliminate ~600 lines of repetition and reduce the cost of schema changes.
- Evidence:
  - packages/audit-code/tests/orchestrator-remediation.test.mjs:284 - buildSelectiveDeepeningTasks test constructs full task object inline
  - packages/audit-code/tests/orchestrator-remediation.test.mjs:340 - conflicting findings test reconstructs same base task shape
  - packages/audit-code/tests/orchestrator-remediation.test.mjs:430 - lens steward test duplicates the pattern again
  - packages/audit-code/tests/orchestrator-remediation.test.mjs:1119 - large_lens_surface test duplicates 3 full task objects
  - packages/audit-code/tests/orchestrator-remediation.test.mjs:1462 - first-owner semantics test duplicates 3 more task objects
  - packages/audit-code/tests/orchestrator-remediation.test.mjs:1656 - conflictGroups tests duplicate task/finding objects inline

### COR-733266d1 — Fastify Route Object Regex Cutoff on Nested Functions or Inner Calls

- Severity: high
- Confidence: high
- Lens: correctness
- Category: logic-error
- Files: packages/audit-code/src/extractors/graphRoutes.ts
- Summary: The ROUTE_OBJECT_PATTERN regex uses a lazy match ([\s\S]{0,1200}?) to the first closing brace and parenthesis (}) sequence. If the handler contains inline code with internal calls that close with }), the matcher terminates prematurely, causing the handler and other options to be omitted.
- Evidence:
  - packages/audit-code/src/extractors/graphRoutes.ts:14-15 - const ROUTE_OBJECT_PATTERN = /\b(?:app|router|server|fastify)\s*\.\s*route\s*\(\s*\{([\s\S]{0,1200}?)\}\s*\)/gi;

### COR-f3c7d732 — File paths missing packages/audit-code/ prefix

- Severity: high
- Confidence: high
- Lens: correctness
- Category: incorrect-path
- Files: packages/audit-code/.audit-artifacts/requeue_tasks.json
- Summary: 106 correctness tasks reference files with paths like src/... that are missing the packages/audit-code/ prefix. These paths do not resolve from the repository root.
- Evidence:
  - packages/audit-code/.audit-artifacts/requeue_tasks.json:2 - First entry has path src/adapters/coverageSummary.ts but file exists at packages/audit-code/src/adapters/coverageSummary.ts
  - 106 of 138 non-.tmp correctness task paths lack the packages/audit-code/ prefix

### MNT-6c66181b — Finding IDs collide across audit passes — 26 MNT-001, 25 MNT-002, 21 MNT-003 entries

- Severity: high
- Confidence: high
- Lens: maintainability
- Category: inconsistent-abstractions
- Files: audit/audit-findings.json, audit/audit-findings.json, audit/audit-findings.json
- Summary: Finding IDs are reused across every audit pass: MNT-001 appears 26 times, MNT-002 25 times, MNT-003 21 times. Since consumers use IDs as primary keys for ingestion, coverage, and packet submission, collisions cause silent overwrites and prevent unambiguous reference to any specific finding.
- Evidence:
  - audit/audit-findings.json:53 - MNT-001 (cli.ts is now a thin dispatcher)
  - audit/audit-findings.json:111 - MNT-001 (cmdRunToCompletion has been decomposed)
  - audit/audit-findings.json:135 - MNT-001 (cmdRunToCompletion phase extraction is mostly complete — near-duplicate of line 111)
  - audit/audit-findings.json:888 - MNT-002 (bash permission block duplicated verbatim)
  - audit/audit-findings.json:1341 - MNT-002 (Duplicate bash permission block ... same root issue, different pass)

### DAT-27cf4ebf — finding.schema.json duplicate $id with divergent structure

- Severity: high
- Confidence: high
- Lens: data_integrity
- Category: schema-violation
- Files: packages/audit-code/.audit-artifacts/dispatch/finding.schema.json, packages/audit-code/.audit-artifacts/dispatch/finding.schema.json
- Summary: Deepening confirms DI-P1-002 stands at high/high. dispatch/finding.schema.json claims $id 'finding.schema.json' which collides with schemas/finding.schema.json. The dispatch version inlines the lens enum and omits fields present in schemas/ (hash_at_plan_time, theme_id, contract_goal_id, contract_obligation_ids, verification_obligation_ids, targeted_commands). Any resolver loading by $id will produce inconsistent validation behavior depending on load order.
- Evidence:
  - packages/audit-code/.audit-artifacts/dispatch/finding.schema.json:3 - $id: 'finding.schema.json' with inline lens enum
  - packages/audit-code/.audit-artifacts/dispatch/finding.schema.json:76 - dispatch version lacks extra finding fields
  - packages/audit-code/schemas/finding.schema.json:26 - lens uses $ref: lens.schema.json
  - packages/audit-code/schemas/finding.schema.json:38-39,62-74 - has hash_at_plan_time, theme_id, contract_goal_id, contract_obligation_ids, verification_obligation_ids, targeted_commands
  - packages/audit-code/.audit-artifacts/dispatch/finding.schema.json:3 - $id: 'finding.schema.json', lens as inline enum at line 23, no contract/obligation/targeted-command fields
  - packages/audit-code/schemas/finding.schema.json:3 (boundary) - Same $id but lens via $ref at line 26, extra fields at lines 39, 62-75

### DAT-c014c153 — Inconsistent field requirements in dispatch_plan schema causing runtime validation failures

- Severity: high
- Confidence: high
- Lens: data_integrity
- Category: schema-inconsistency
- Files: packages/remediate-code/schemas/dispatch_plan.schema.json
- Summary: Finding DAT-001 stands: dispatch_plan.schema.json line 24 requires both finding_id and block_id on every item, but buildImplementDispatchItem only returns block_id and buildDocumentDispatchItem only returns finding_id. Neither builder produces items that satisfy the schema, so every generated dispatch plan fails schema validation. The issue remains unaddressed since the original finding was filed.
- Evidence:
  - packages/remediate-code/schemas/dispatch_plan.schema.json:24 - "required": ["task_id", "finding_id", "block_id", "prompt_path", "result_path"]
  - packages/remediate-code/src/steps/dispatch.ts:315-325 - buildImplementDispatchItem returns block_id but not finding_id
  - packages/remediate-code/src/steps/dispatch.ts:336-346 - buildDocumentDispatchItem returns finding_id but not block_id
  - packages/remediate-code/schemas/dispatch_plan.schema.json:24 - "required": ["task_id", "finding_id", "block_id", "prompt_path", "result_path"] requires both finding_id and block_id on every item
  - packages/remediate-code/src/steps/dispatch.ts:315-317 - buildImplementDispatchItem returns block_id but not finding_id
  - packages/remediate-code/src/steps/dispatch.ts:336-338 - buildDocumentDispatchItem returns finding_id but not block_id

### COR-49db2f4c — JSON Schema $ref resolution broken for cross-file refs with fragment

- Severity: high
- Confidence: high
- Lens: correctness
- Category: incorrect-api-usage
- Files: packages/audit-code/src/extractors/graphSuites.ts
- Summary: resolveJsonSchemaRef uses ref.split("#", 1)[0] which returns only 1 element (the entire string including the # fragment), so cross-file $ref values like "other-schema.json#/definitions/Foo" never resolve to the target file. The intent is to get the file path before the #, but split with limit 1 truncates the result array to 1 element containing the complete input.
- Evidence:
  - packages/audit-code/src/extractors/graphSuites.ts:67 - const targetSpecifier = (ref.split("#", 1)[0] ?? "").trim(); -- String.split with limit 1 returns at most 1 element; for input "schema.json#/definitions/Foo", this returns the full string including the fragment, so the function never strips the # fragment
  - packages/audit-code/src/extractors/graphSuites.ts:62-86 - The resolveJsonSchemaRef function then attempts path resolution with the fragment attached, causing all cross-file $ref values containing a fragment to silently fail to match any file in pathLookup

### COR-717ec279 — LocalSubprocessProvider spawns command directly without Windows executable resolution or batch wrapping

- Severity: high
- Confidence: high
- Lens: correctness
- Category: command-execution
- Files: packages/shared/src/providers/localSubprocessProvider.ts
- Summary: LocalSubprocessProvider extracts the command array from a worker task and spawns the command directly via spawnLoggedCommand. Because it does not apply platformCommand or wrapForWindowsBatch, direct execution of CLI shims (like npm, npx) or batch files will fail on Windows with ENOENT.
- Evidence:
  - packages/shared/src/providers/localSubprocessProvider.ts:28-33 - const [command, ...args] = task.worker_command; return await this.launchCommand(command, args, applyWorkerTaskLaunchSettings(input, task));

### CFG-4996560e — Postinstall deploys overbroad OpenCode permissions

- Severity: high
- Confidence: high
- Lens: config_deployment
- Category: overbroad-generated-permissions
- Files: packages/audit-code/scripts/postinstall.mjs, packages/audit-code/scripts/postinstall.mjs, packages/audit-code/scripts/postinstall.mjs, packages/audit-code/scripts/postinstall.mjs, packages/audit-code/scripts/postinstall.mjs
- Summary: The postinstall script writes a global OpenCode configuration that allows all bash commands and all external directories, then relies on a short denylist for a few audit-code commands and rm. Installing the package deploys a configuration that can bypass expected approval boundaries for future audit runs.
- Evidence:
  - packages/audit-code/scripts/postinstall.mjs:47 - OPENCODE_AUDIT_BASH_PERMISSION starts with '*': 'allow' and only denies a small set of commands later in the map.
  - packages/audit-code/scripts/postinstall.mjs:92 - renderOpenCodeExternalDirectoryPermission returns '*': 'allow'.
  - packages/audit-code/scripts/postinstall.mjs:176 - The generated global config forces external_directory '*': 'allow', and line 206 repeats it for the auditor agent.
  - packages/audit-code/scripts/postinstall.mjs:92 - renderOpenCodeExternalDirectoryPermission returns '*': 'allow' (called but overwritten by line 195 which sets external_directory: {'*': 'allow'} unconditionally).
  - packages/audit-code/scripts/postinstall.mjs:162 - renderOpenCodePermissionConfig builds the auditor-level permission with the same open bash rule.
  - packages/audit-code/scripts/postinstall.mjs:193 - line 195 unconditionally sets external_directory to {'*': 'allow'}, overriding any user preference.

### TST-20f6280d — scheduler.ts lacks coverage for cooldown, quota disabled, quota-source snapshot, and discovered-limits paths

- Severity: high
- Confidence: high
- Lens: tests
- Category: missing-test-coverage
- Files: packages/shared/src/quota/scheduler.ts
- Summary: scheduler.ts (360 lines) has only 5 tests covering the four main cap branches. The following critical paths are untested: active cooldown throttling to 1, quota-disabled path returning full concurrency, quota-source snapshot critical/low remaining_pct adjustment, discovered limits filling null RPM/TPM, host-concurrency limit ceiling, buildProviderModelKey, and the hostConcurrencyLimit early-return in computeUncappedWaveSize.
- Evidence:
  - packages/shared/src/quota/scheduler.ts:237-260 - Quota-disabled path returns full concurrency with host cap and minimal limits; no test.
  - packages/shared/src/quota/scheduler.ts:278-292 - Active cooldown throttles wave_size to 1 with binding_cap='cooldown'; no test.
  - packages/shared/src/quota/scheduler.ts:313-333 - Quota-source snapshot critical (<10%) and low (<30%) bands adjust wave_size; no test.
  - packages/shared/src/quota/scheduler.ts:269-273 - Discovered limits merging into ResolvedLimits via ??=; no test.
  - packages/shared/src/quota/scheduler.ts:355-360 - buildProviderModelKey untested.
  - packages/shared/src/quota/scheduler.ts:164-169 - Host-concurrency-limit early return branch untested.

### COR-53c7a3ee — State Store Lost Update Race Condition in remediate-code

- Severity: high
- Confidence: high
- Lens: correctness
- Category: trust_boundary_gap
- Files: packages/remediate-code/src/state/store.ts
- Summary: In packages/remediate-code/src/state/store.ts, the StateStore implements a pessimistic locking mechanism (state.lock) inside saveState(). However, loadState() loads the state file without acquiring or checking the lock. When the orchestrator executes concurrent operations or runs in an environment with multiple async event loops modifying state, two processes can concurrently load the same state, modify it, and write it back. The last writer will silently overwrite the changes of the first writer. This breaks transactional integrity. To fix this, the state store should acquire the lock on read and hold it throughout the read-modify-write operation (e.g. by returning a lock handle or introducing a withLockedState transaction wrapper).

### REL-3c247ea1 — Time-of-Check to Time-of-Use (TOCTOU) Race Condition in Lock Release

- Severity: high
- Confidence: high
- Lens: reliability
- Category: race-condition
- Files: packages/shared/src/quota/fileLock.ts, packages/shared/src/quota/fileLock.ts
- Summary: In acquireLock, a stale lock file is unlinked after checking its timestamp. If a concurrent process unlinks the stale lock and creates a fresh one in the gap, the first process will delete the newly created fresh lock, breaking mutual exclusion.
- Evidence:
  - packages/shared/src/quota/fileLock.ts:74-86 - releaseLock reads the content asynchronously, and then unlinks the path if it matched. If the lock is stolen between readFile and unlink, the new holder's lock is deleted.
  - packages/shared/src/quota/fileLock.ts:52-63 - isLockStale is checked asynchronously, and then unlink is called. If another process unlinks and recreates the lock during this window, the unlink deletes the new valid lock.

### COR-d31c8ea3 — tsc output regex fails to match standard TypeScript error format

- Severity: high
- Confidence: high
- Lens: correctness
- Category: wrong-regex-pattern
- Files: packages/audit-code/src/orchestrator/syntaxResolutionExecutor.ts
- Summary: The regex /^([^:]+)\((\d+),\d+\):\s+(error\s+TS\d+:.*)$/ in runTsc uses [^:]+ which greedily consumes everything up to the colon after the closing paren, so the (line,col) portion is consumed as part of the path and the \( is never matched. No tsc errors are ever parsed from standard TypeScript output, causing all tsc diagnostics to be silently dropped into the 'parse_error' fallback path.
- Evidence:
  - packages/audit-code/src/orchestrator/syntaxResolutionExecutor.ts:100 - Regex /^([^:]+)\((\d+),\d+\):\s+(error\s+TS\d+:.*)$/ - [^:]+ matches 'src/file.ts(5,10)' (greedy through the paren content), leaving no '(' for \( to match against standard TSC output format 'file.ts(5,10): error TS2345: ...'

### TST-9a4da7e5 — validate-command.test.mjs imports from compiled dist/ instead of source

- Severity: high
- Confidence: high
- Lens: tests
- Category: stale-build-risk
- Files: packages/audit-code/tests/validate-command.test.mjs
- Summary: validate-command.test.mjs line 12 imports from dist/cli.js (compiled output) rather than the source TypeScript file. If the dist/ build becomes stale after source changes, tests silently pass against old code, masking regressions. All other test files in this packet import directly from src/.
- Evidence:
  - packages/audit-code/tests/validate-command.test.mjs:12 - const { runCli } = await import(distCliUrl) where distCliUrl points to dist/cli.js

### COR-281a9b14 — VCS-ignored and temporary directories scanned and included in manifest

- Severity: high
- Confidence: high
- Lens: correctness
- Category: incorrect-behavior
- Files: packages/audit-code/.audit-artifacts/critical_flows.json, packages/audit-code/.audit-artifacts/design_assessment.json, packages/audit-code/.audit-artifacts/dispatch/current-single-task.json
- Summary: The filesystem intake walker ('fsIntake.ts') scanned and included files from git-ignored temporary/migration directories (like 'Codeauditor-lambda.audit-artifacts' and '.tmp/opentoken') in the repository manifest and critical flows, causing incorrect/polluted design artifacts.
- Evidence:
  - packages/audit-code/.audit-artifacts/critical_flows.json:202 - Inclusion of git-ignored file 'Codeauditor-lambda.audit-artifacts/session-config.json'
  - packages/audit-code/.audit-artifacts/design_assessment.json:1292 - Top-risk unit contains 'Codeauditor-lambda.audit-artifacts/session-config.json'
  - packages/audit-code/.audit-artifacts/dispatch/current-single-task.json:7-15 - Multiple duplicate paths under '.tmp/opentoken' included in task file_paths

### DAT-ed4f3508 — VerificationResult schema, prompt, and type inconsistencies confirmed - silent evidence data loss

- Severity: high
- Confidence: high
- Lens: data_integrity
- Category: schema-inconsistency
- Files: packages/remediate-code/schemas/verification_result.schema.json
- Summary: Deepening confirms DAT-002 stands. All three inconsistencies persist: (1) prompt at implement.ts:268 tells worker to emit 'notes', but close.ts:707 expects 'reason' (array), causing silent verification evidence loss; (2) schema reason type is 'string' while TS type is 'string[]'; (3) additionalProperties:false rejects 'notes' if schema validation were enforced. The 'failed status fallback' claim in the original finding is overstated - implement.ts only reads verRes.passed and does not validate against the schema, so the verify step does not fail; only evidence enrichment in close.ts silently drops data. Impact: verification evidence is always empty for worker-produced results when the prompt is followed.
- Evidence:
  - packages/remediate-code/schemas/verification_result.schema.json:10 - reason type is string, but TS type and close.ts expect string[]
  - packages/remediate-code/schemas/verification_result.schema.json:12 - additionalProperties:false would reject 'notes' if enforced
  - packages/remediate-code/src/phases/implement.ts:268 - prompt asks worker for { passed, notes } - no reason field
  - packages/remediate-code/src/state/types.ts:100 - reason?: string[] (array, not string)
  - packages/remediate-code/src/phases/close.ts:431 - Array.isArray(verRes.reason) - expects array, silently drops if undefined
  - packages/remediate-code/src/phases/implement.ts:284-285 - implement.ts only checks verRes.passed, no schema validation

### DAT-2624dff3 — VerificationResult schema, prompt, and type inconsistencies leading to validation failures and failed status fallback

- Severity: high
- Confidence: high
- Lens: data_integrity
- Category: schema-inconsistency
- Files: packages/remediate-code/schemas/verification_result.schema.json
- Summary: Mismatch between verification result schema, worker prompt, and close phase parsing logic: the prompt asks for 'notes', but the schema disallows 'notes' and requires 'reason' as a string, whereas typescript types and close phase parsing expect 'reason' to be an array of strings, leading to validation failure and automatic status fallback to 'failed'.
- Evidence:
  - packages/remediate-code/schemas/verification_result.schema.json:10 - "reason": { "type": "string" } with additionalProperties: false
  - packages/remediate-code/src/phases/implement.ts:268 - Prompt instructs worker to write a VerificationResult JSON with shape: { "passed": boolean, "notes": string }
  - packages/remediate-code/src/state/types.ts:100 - TS type VerificationResult defines reason?: string[] (array)
  - packages/remediate-code/src/phases/close.ts:707 - Close phase parses VerificationResult and expects verRes.reason to be an array, falling back to 'failed' status if it is not

### MNT-68f7a179 — 801 stale entries reference non-existent .tmp/opentoken/ paths

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: dead-code
- Files: packages/audit-code/.audit-artifacts/requeue_tasks.json
- Summary: 801 of 1527 entries (52%) reference files under .tmp/opentoken/ paths that do not exist in the repository. These entries will never resolve and add noise that obscures actionable requeue tasks, making the artifact harder to maintain and trust.
- Evidence:
  - packages/audit-code/.audit-artifacts/requeue_tasks.json:2587-2653 - cache.ts entries reference .tmp/opentoken/.opencode/plugins/opentoken/utils/cache.ts — .tmp/ directory does not exist at repo root
  - 801 of 1527 total entries use .tmp/opentoken/ file paths that are build artifacts, not source files

### MNT-35666586 — advanceAudit switch statement scales with every new executor

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: excessive_function_length
- Files: packages/audit-code/src/orchestrator/advance.ts
- Summary: The advanceAudit function spans 250 lines (115-365) with a 134-line switch statement handling 14 executor cases. Every new executor requires extending this switch, adding a requireRoot call, and copy-paste-logic for logging and error formatting.
- Evidence:
  - packages/audit-code/src/orchestrator/advance.ts:166-300 - 14-case switch handling all executors with nearly identical invocation patterns
  - packages/audit-code/src/orchestrator/advance.ts:269-299 - agent and default cases share the same block, conflating two distinct states
  - packages/audit-code/src/orchestrator/advance.ts:81-86 - requireRoot helper exists only because every executor branch repeats the same guard

### COR-92cef10f — Angular Route Object Parser Regex Fails on Nested Objects

- Severity: medium
- Confidence: high
- Lens: correctness
- Category: logic-error
- Files: packages/audit-code/src/extractors/graphRoutes.ts
- Summary: The regex in ANGULAR_ROUTE_OBJECT_PATTERN prohibits nested objects by using [^{}]*?, meaning that Angular routes containing data, resolve, or other nested properties are completely ignored by the route extractor.
- Evidence:
  - packages/audit-code/src/extractors/graphRoutes.ts:367-368 - const ANGULAR_ROUTE_OBJECT_PATTERN = /\{[^{}]*?\bpath\s*:\s*["'`]([^"'`]*)["'`][^{}]*?\}/g;

### TST-64db5f4d — applyNarrative in synthesis.ts has no direct test coverage

- Severity: medium
- Confidence: high
- Lens: tests
- Category: missing-tests
- Files: packages/audit-code/src/reporting/synthesis.ts
- Summary: The applyNarrative function (synthesis.ts:211-250) has non-trivial logic for filtering invalid finding IDs, first-claim-wins theme mapping, and theme-to-finding assignment, but no test imports or exercises it directly.
- Evidence:
  - packages/audit-code/tests/reporting-remediation.test.mjs: no import of applyNarrative
  - packages/audit-code/tests/synthesis-narrative-prompt.test.mjs: tests renderSynthesisNarrativePrompt only, not applyNarrative

### MNT-af05ed71 — Boilerplate-heavy extractor dispatch in extractContentEdgesForFile

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: inconsistent-abstractions
- Files: packages/audit-code/src/extractors/graph.ts
- Summary: extractContentEdgesForFile (graph.ts:504-567) contains 15 nearly identical push-to-accumulator calls for different extractors. Adding, removing, or reordering an extractor requires editing this single function. A registry-based pattern (list of extractor functions) would eliminate the boilerplate and make the dispatch declarative.
- Evidence:
  - packages/audit-code/src/extractors/graph.ts:504-567 - 15 sequential push calls following identical pattern: acc.imports/references.push(...extractXxxEdges(filePath, content, pathLookup))

### MNT-14d407a2 — buildBoundedClusterEdges high cognitive complexity (120 lines, 4+ nesting levels)

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: deep-nesting
- Files: packages/audit-code/src/orchestrator/reviewPacketGraph.ts
- Summary: buildBoundedClusterEdges (reviewPacketGraph.ts:372-491) spans 120 lines with 4+ levels of control-flow nesting. It builds a connected-component index, groups entries by root, deduplicates components, checks size/task/token limits, then emits edges. The deeply nested data pipeline (for->entries.map->for->components.map->filter->for) is hard to follow and debug.
- Evidence:
  - packages/audit-code/src/orchestrator/reviewPacketGraph.ts:372-491 - 120-line function with nested iteration over groups, clusters, components, and entries

### MNT-35a52f2e — buildChunkedAuditTasks has excessive length and multiple responsibilities

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: excessive-function-length
- Files: packages/audit-code/src/orchestrator/taskBuilder.ts
- Summary: buildChunkedAuditTasks in taskBuilder.ts spans 142 lines (278-420) and handles pending file filtering, flow-block claiming, remainder grouping, and task creation — four distinct concerns. Its addTaskBlock helper accepts 13 parameters split across two objects, indicating insufficient cohesion.
- Evidence:
  - packages/audit-code/src/orchestrator/taskBuilder.ts:278-325 - Pending file filtering and lens deduplication
  - packages/audit-code/src/orchestrator/taskBuilder.ts:335-357 - Flow block claiming and task creation
  - packages/audit-code/src/orchestrator/taskBuilder.ts:359-413 - Remainder grouping and second pass task creation
  - packages/audit-code/src/orchestrator/taskBuilder.ts:155-173 - addTaskBlock with 13 parameters across 2 objects

### MNT-50c25acb — buildFileAnchorSummary mixes multiple concerns in a single function

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: excessive_function_length
- Files: packages/audit-code/src/orchestrator/fileAnchors.ts
- Summary: buildFileAnchorSummary (96 lines) combines symbol scanning, keyword scanning, graph-edge collection, analyzer-signal collection, deduplication, sorting, and truncation. Each concern delegates to helpers but the orchestration and bookkeeping are tangled together.
- Evidence:
  - packages/audit-code/src/orchestrator/fileAnchors.ts:258-264 - inline line-iteration loop combines symbol and keyword scanning
  - packages/audit-code/src/orchestrator/fileAnchors.ts:266-276 - graph-edge collection interleaved after line scanning
  - packages/audit-code/src/orchestrator/fileAnchors.ts:278-292 - analyzer-signal collection interleaved after graph edges
  - packages/audit-code/src/orchestrator/fileAnchors.ts:294-300 - sorting and truncation in the same function body

### COR-6464fa65 — bun.lock files misclassified as pending audit instead of generated/excluded

- Severity: medium
- Confidence: high
- Lens: correctness
- Category: data-classification
- Files: packages/audit-code/.audit-artifacts/coverage_matrix.json, packages/audit-code/.audit-artifacts/coverage_matrix.json
- Summary: Two bun.lock lock files (.tmp/opentoken/bun.lock and .tmp/opentoken/opentoken/bun.lock) are classified as 'classified' with audit_status 'pending' and assigned correctness/reliability/performance/observability/tests lenses, while package-lock.json entries with identical semantics use the correct 'generated'/'excluded' status. This causes the audit pipeline to schedule unnecessary work on generated lock artifacts.
- Evidence:
  - packages/audit-code/.audit-artifacts/coverage_matrix.json:1005-1018 - .tmp/opentoken/bun.lock entry shows classification_status='classified', audit_status='pending', required_lenses=[correctness,reliability,performance,observability,tests]
  - packages/audit-code/.audit-artifacts/coverage_matrix.json:1803-1816 - .tmp/opentoken/opentoken/bun.lock entry shows same misclassification pattern
  - packages/audit-code/.audit-artifacts/coverage_matrix.json:130-136 - .opencode/package-lock.json correctly classified as generated/excluded
  - packages/audit-code/.audit-artifacts/coverage_matrix.json:3802-3807 - package-lock.json correctly classified as generated/excluded

### OPR-fd8d2843 — ci.yml verify:release traps reference wrong artifact name

- Severity: medium
- Confidence: high
- Lens: operability
- Category: misleading-error-message
- Files: .github/workflows/ci.yml, .github/workflows/ci.yml
- Summary: In ci.yml, the trap error message in both audit-code and remediate-code verify:release steps instructs operators to download the artifact 'ci-npm-logs', but the actual upload-artifact step uses names 'ci-npm-logs-audit-code' and 'ci-npm-logs-remediate-code'. Operators following the error message would not find the expected artifact, slowing diagnosis.
- Evidence:
  - .github/workflows/ci.yml:78 - trap references artifact "ci-npm-logs" but actual artifact name at line 84 is "ci-npm-logs-audit-code"
  - .github/workflows/ci.yml:138 - trap references artifact "ci-npm-logs" but actual artifact name at line 144 is "ci-npm-logs-remediate-code"

### ARC-3ab15025 — Circular Dependencies in audit-code CLI Module Graph

- Severity: medium
- Confidence: high
- Lens: architecture
- Category: architecture_pattern
- Files: packages/audit-code/src/cli.ts, packages/audit-code/src/cli/advanceAuditCommand.ts, packages/audit-code/src/cli/args.ts, packages/audit-code/src/index.ts
- Summary: Deterministic analysis flagged multiple circular dependencies within audit-code's command and argument modules (e.g., cli.ts -> advanceAuditCommand.ts -> args.ts -> cli.ts and cli.ts -> advanceAuditCommand.ts -> auditStep.ts -> artifacts.ts -> toolingManifest.ts -> index.ts -> cli.ts). These cycles increase coupling, complicate unit testing, and can lead to runtime initialization errors in ES modules. The CLI structure should be refactored to decouple arguments parsing, commands registry, and entry point execution. Moving command definitions into isolated files that do not import the root CLI executor, and using a clean command dispatcher would resolve these cyclic dependencies.

### TST-444ed4b2 — claudeCodeErrorParser.ts has no dedicated tests

- Severity: medium
- Confidence: high
- Lens: tests
- Category: missing-test-coverage
- Files: packages/shared/src/quota/errorParsers/claudeCodeErrorParser.ts
- Summary: ClaudeCodeErrorParser (47 lines) has no test file despite containing production JSON-stderr parsing logic with retry-after extraction, status code 429 detection, and rate_limit_error type matching. The claude-specific line-by-line JSON-parsing loop and retry_after/retry_after_ms extraction logic are entirely uncovered.
- Evidence:
  - packages/shared/src/quota/errorParsers/claudeCodeErrorParser.ts:7-43 - Full parse() method with JSON line-by-line loop, retry_after/retry_after_ms extraction logic untested.
  - No dedicated test file exists covering this parser.

### TST-c4670110 — cli-dispatcher.test.mjs imports from compiled dist/ instead of source, creating stale-build risk

- Severity: medium
- Confidence: high
- Lens: tests
- Category: test-fragility
- Files: packages/audit-code/tests/cli-dispatcher.test.mjs
- Summary: cli-dispatcher.test.mjs imports runCli from dist/cli.js (compiled output) rather than from src/cli.ts (source). If the dist/ directory is stale, tests silently pass against outdated compiled code while the source has diverged. Other test files in this packet (e.g. tokens.test.mjs) explicitly import from ../src/ to avoid this issue.
- Evidence:
  - packages/audit-code/tests/cli-dispatcher.test.mjs:9 - const { runCli } = await import(distCliUrl) where distCliUrl points to dist/cli.js
  - packages/audit-code/tests/cli-dispatcher.test.mjs:9 - const distCliUrl = pathToFileURL(join(repoRoot, 'dist', 'cli.js')).href

### DAT-4196a3f0 — closing_result definition mismatch between remediation_report and closing_result schemas

- Severity: medium
- Confidence: high
- Lens: data_integrity
- Category: schema-inconsistency
- Files: packages/remediate-code/schemas/remediation_report.schema.json, packages/remediate-code/schemas/closing_result.schema.json
- Summary: The remediation_report.schema.json embeds an inline definition of closing_result that is inconsistent with the standalone closing_result.schema.json. It permits the forbidden 'output' property and omits the required 'contract_version' and 'commands' fields, leading to runtime generation violating the closing_result schema.
- Evidence:
  - packages/remediate-code/schemas/closing_result.schema.json:6 - requires "contract_version" and "commands", with additionalProperties: false
  - packages/remediate-code/schemas/remediation_report.schema.json:120 - closing_result has "output": { "type": "string" } and does not require "contract_version" or "commands"
  - packages/remediate-code/src/phases/close.ts:851-874 - close.ts constructs closing_result without contract_version, which passes remediation_report validation but violates closing_result schema

### MNT-d7fb0e04 — Clutter and unit fragmentation in design artifacts from temporary directories

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: duplicate-logic
- Files: packages/audit-code/.audit-artifacts/critical_flows.json, packages/audit-code/.audit-artifacts/design_assessment.json
- Summary: Temporary directories (like '.tmp/opentoken') scanned during intake caused highly fragmented orphan units and duplicate file paths in the generated critical flows and design assessments, degrading artifact maintainability.
- Evidence:
  - packages/audit-code/.audit-artifacts/critical_flows.json:95-120 - Highly redundant/duplicate path listings under '.tmp/opentoken'
  - packages/audit-code/.audit-artifacts/design_assessment.json:230-240 - Orphan units includes git-ignored folders like '-opencode', '-tmp', and '-vscode' due to intake fragmentation

### MNT-091ea127 — cmdRunToCompletion main loop has complex state routing with multiple early returns

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: complex-control-flow
- Files: packages/audit-code/src/cli/runToCompletion.ts
- Summary: The main while loop in cmdRunToCompletion manages 6 mutable state variables (runCount, deepeningCycles, anyProgress, pendingBatchAuditResults, pendingAuditResultsPath, pendingRuntimeUpdatesPath) with 4+ early return paths plus continue statements, making execution flow hard to trace.
- Evidence:
  - packages/audit-code/src/cli/runToCompletion.ts:1432-1618 - Main loop with returns at lines 1509, 1523, 1549, 1584, 1617
  - packages/audit-code/src/cli/runToCompletion.ts:1446-1469 - continue and break via interrupted wave recovery and deepening cycle checks
  - packages/audit-code/src/cli/runToCompletion.ts:1477-1493 - State routing that reassigns preferredExecutor and obligationId based on pending paths

### OBS-b1148341 — collectVerifyCheck discards error stack traces

- Severity: medium
- Confidence: high
- Lens: observability
- Category: error-reporting-context
- Files: packages/audit-code/audit-code-wrapper-install-hosts.mjs
- Summary: When a verification check fails, collectVerifyCheck stores only error.message in the status summary, discarding the full stack trace. This makes it harder for operators to locate the failure source without re-running the check.
- Evidence:
  - packages/audit-code/audit-code-wrapper-install-hosts.mjs:562 - Summary is 'error instanceof Error ? error.message : String(error)' with no stack property propagated
  - packages/audit-code/audit-code-wrapper-install-hosts.mjs:559 - catch block drops the full error object down to a single string

### REL-c30e25f7 — Concurrent Session Config Modifications Lack File Lock

- Severity: medium
- Confidence: high
- Lens: reliability
- Category: race-condition
- Files: packages/audit-code/src/supervisor/sessionConfig.ts
- Summary: In supervisor/sessionConfig.ts, persistAnalyzerSettings reads, merges, and writes session-config.json without obtaining a file lock, allowing concurrent subagent reviews to overwrite settings or lose configuration changes due to race conditions.
- Evidence:
  - packages/audit-code/src/supervisor/sessionConfig.ts:57-74 - reads session-config.json, merges new settings, and writes back without using withFileLock, exposing the operation to write-races.

### COR-b4867804 — Corrupted Unit ID and File Path Heuristics in Risk Register

- Severity: medium
- Confidence: high
- Lens: correctness
- Category: path-normalization
- Files: packages/audit-code/.audit-artifacts/risk_register.json
- Summary: The unit ID and corresponding files in the risk register contain corrupted path heuristics, mapping a non-existent folder named 'Codeauditor-lambda.audit-artifacts' and unit 'Codeauditor-lambda-audit-artifacts' instead of '.audit-artifacts'. This indicates a path normalization logic bug that incorrectly replaced package segments.
- Evidence:
  - packages/audit-code/.audit-artifacts/risk_register.json:30 - "unit_id": "Codeauditor-lambda-audit-artifacts"

### COR-68ff21b2 — Critical flow analysis reports fallback_required with low confidence on majority of flows

- Severity: medium
- Confidence: high
- Lens: correctness
- Category: incomplete-analysis
- Files: packages/audit-code/.audit-artifacts/critical_flows.json
- Summary: critical_flows.json has fallback_required: true and 9 of 14 flows are at low confidence with generic notes. The heuristic path classification did not achieve full coverage, meaning critical flows may be missed.
- Evidence:
  - packages/audit-code/.audit-artifacts/critical_flows.json:349 - fallback_required: true
  - packages/audit-code/.audit-artifacts/critical_flows.json:15-19 - all 9 interface flows have confidence: low

### ARC-564b31b7 — Dependency cycle: 3 modules

- Severity: medium
- Confidence: high
- Lens: architecture
- Category: dependency_cycle
- Files: packages/audit-code/src/extractors/graphManifestEdges/cargo.ts, packages/audit-code/src/extractors/graphManifestEdges/index.ts, packages/audit-code/src/extractors/graphManifestEdges/workspace.ts, packages/audit-code/src/extractors/graphManifestEdges/yamlPaths.ts
- Summary: Circular dependency among packages/audit-code/src/extractors/graphManifestEdges/index.ts → packages/audit-code/src/extractors/graphManifestEdges/cargo.ts → packages/audit-code/src/extractors/graphManifestEdges/workspace.ts → packages/audit-code/src/extractors/graphManifestEdges/index.ts. Cycles increase coupling, complicate testing, and can cause initialization-order bugs.

### MNT-e607f9bc — Design assessment contains highly repetitive dependency cycle entries

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/audit-code/.audit-artifacts/design_assessment.json
- Summary: design_assessment.json is 1640 lines with 16 machine-generated findings, 9 of which are nearly identical dependency cycle entries (DA-001 through DA-009) differing only in module names. The repetitive structure makes manual review tedious and increases the chance of human error during triage.
- Evidence:
  - packages/audit-code/.audit-artifacts/design_assessment.json:3-222 - DA-001 through DA-009 all follow identical pattern with only module names differing
  - packages/audit-code/.audit-artifacts/design_assessment.json - total 1640 lines for 22 findings

### OBS-01650bcb — Diagnostic messages use bare process.stderr.write instead of structured logging

- Severity: medium
- Confidence: high
- Lens: observability
- Category: logging-quality
- Files: packages/audit-code/src/adapters/normalizeExternal.ts, packages/audit-code/src/cli/auditStep.ts, packages/audit-code/src/cli/auditStep.ts
- Summary: Multiple files write diagnostic messages via process.stderr.write with ad-hoc string prefixes instead of using a structured logger with levels, correlation IDs, and machine-parseable output. The codebase already has a RunLogger (auditStep.ts:63) but the adapter and validation layers bypass it.
- Evidence:
  - packages/audit-code/src/adapters/normalizeExternal.ts:38 - process.stderr.write with [audit-code] prefix and no structured fields
  - packages/audit-code/src/cli/auditStep.ts:40 - process.stderr.write for archive failure with ad-hoc prefix [audit-results cleanup]
  - packages/audit-code/src/cli/auditStep.ts:88 - process.stderr.write for validation warnings with [audit-results validation] prefix
  - packages/audit-code/src/cli/auditStep.ts:63 - RunLogger already initialized but not passed to adapter or validation code paths

### OBS-1934f2fe — Disabled RunLogger in Template-based Session Providers

- Severity: medium
- Confidence: high
- Lens: observability
- Category: missing-logging
- Files: packages/shared/src/providers/providerFactory.ts
- Summary: The subprocess-template, vscode-task, and antigravity providers are instantiated in createFreshSessionProvider without receiving a runLogger instance. This defaults them to a disabled logger, silently swallowing all template substitution error events (such as unknown placeholder warnings).
- Evidence:
  - packages/shared/src/providers/providerFactory.ts:288-330 - createFreshSessionProvider instantiates SubprocessTemplateProvider for 'subprocess-template', 'vscode-task', and 'antigravity' but omits the fifth runLogger parameter, leaving it as disabled.

### ARC-7cef647f — Duplicate Lock Implementations and Inconsistent PID-Based Liveness Checking

- Severity: medium
- Confidence: high
- Lens: architecture
- Category: architecture_pattern
- Files: packages/shared/src/quota/fileLock.ts, packages/remediate-code/src/state/store.ts
- Summary: There is a duplication of locking utilities between the shared library and the remediate package. packages/shared/src/quota/fileLock.ts provides a time-based lock helper. However, packages/remediate-code/src/state/store.ts implements a custom PID-based file lock check (process.kill(pid, 0)) to quickly recover when a lock owner crashes. Having two locking implementations violates the single-source-of-truth principle for shared logic. The PID-based liveness checking logic is superior and should be moved into the shared locking utilities in @audit-tools/shared, allowing both the state store and the quota scheduler to benefit from fast crashed-process lock recovery.

### MNT-0f966aa9 — Duplicated command-runner structure between runTsc and runEslint

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/audit-code/src/orchestrator/syntaxResolutionExecutor.ts
- Summary: runTsc (lines 79-155) and runEslint (lines 157-248) in syntaxResolutionExecutor.ts share nearly identical structure: command resolution via runFirstAvailableCommand, error-path handling via commandErrorResult, output parsing, and multi-branch status return logic. Adding another tool requires copying the full pattern again.
- Evidence:
  - packages/audit-code/src/orchestrator/syntaxResolutionExecutor.ts:79-155 - runTsc body: command resolve, error check, output parse, status return
  - packages/audit-code/src/orchestrator/syntaxResolutionExecutor.ts:157-248 - runEslint body: identical structure with different output parser

### MNT-50c7a63d — Duplicated comment-stripping logic across yaml.ts and graphPythonImports.ts

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: duplicated-code
- Files: packages/audit-code/src/extractors/graphManifestEdges/yaml.ts, packages/audit-code/src/extractors/graphPythonImports.ts
- Summary: stripYamlComment in yaml.ts and stripPythonLineComment in graphPythonImports.ts implement nearly identical quote-aware comment stripping algorithms. Any bug fix or enhancement (e.g. handling triple-quoted strings in Python) must be applied to both independently.
- Evidence:
  - packages/audit-code/src/extractors/graphManifestEdges/yaml.ts:1-20 - stripYamlComment tracks quote state to find unquoted # characters
  - packages/audit-code/src/extractors/graphPythonImports.ts:20-50 - stripPythonLineComment implements the same algorithm with identical quote-state tracking

### MNT-d7ae2055 — Duplicated dedup logic across same-lens and cross-lens functions

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/audit-code/src/reporting/mergeFindings.ts
- Summary: deduplicateSameLens and deduplicateCrossLens in mergeFindings.ts share nearly identical structure (group by key, iterate pairwise, compute Jaccard similarity, check path overlap, rank by severity/confidence, absorb). They differ only in grouping key, lens-filter guard, and similarity thresholds — a textbook candidate for a shared dedup pipeline parameterized by group strategy and thresholds.
- Evidence:
  - packages/audit-code/src/reporting/mergeFindings.ts:124-167 - deduplicateSameLens groups by lens:path, iterates pairwise, checks titleSim against threshold 0.35/0.45, checks lineRangeOverlaps/filePathOverlap, absorbs loser
  - packages/audit-code/src/reporting/mergeFindings.ts:169-214 - deduplicateCrossLens groups by path only, adds normalizeText(a.lens) !== normalizeText(b.lens) guard, uses thresholds 0.4/0.5 — same structure, different parameter values

### MNT-5e5beab9 — Duplicated lens allowlist across flowCoverage.ts and flowPlanning.ts

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: duplicated_logic
- Files: packages/audit-code/src/orchestrator/flowCoverage.ts, packages/audit-code/src/orchestrator/flowPlanning.ts
- Summary: The identical list of 7 audit lenses is defined as a hardcoded array in both flowCoverage.ts (lensSetForFlow) and flowPlanning.ts (FLOW_REVIEW_LENSES). These can silently drift apart. A single shared constant would eliminate the duplication.
- Evidence:
  - packages/audit-code/src/orchestrator/flowCoverage.ts:9-17 - hardcoded allowed lens array with 7 values
  - packages/audit-code/src/orchestrator/flowPlanning.ts:4-12 - FLOW_REVIEW_LENSES with the same 7 values
  - packages/audit-code/src/orchestrator/auditTaskUtils.ts:8-10 - LENS_ORDER derived from LENS_REGISTRY shows the project already has a shared registry pattern

### MNT-dbfed56d — Duplicated line-count batching logic in buildLineIndex and buildLineIndexForPaths

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/audit-code/src/cli/lineIndex.ts, packages/audit-code/src/cli/lineIndex.ts
- Summary: lineIndex.ts exports two functions (buildLineIndex and buildLineIndexForPaths) that share identical batching logic with Promise.all. Only the input type differs — one accepts a RepoManifest, the other takes string[]. The core iteration, error handling, and batch-size logic is duplicated verbatim across both functions.
- Evidence:
  - packages/audit-code/src/cli/lineIndex.ts:13-38 — buildLineIndex iterates repoManifest.files in batches of LINE_COUNT_BATCH_SIZE with Promise.all + countLines + error handling
  - packages/audit-code/src/cli/lineIndex.ts:40-64 — buildLineIndexForPaths copies the same batch+Promise.all+error-handling pattern over uniquePaths

### MNT-53a85f8e — Duplicated orchestration loop logic across test helper and inline test

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/audit-code/tests/next-step.test.mjs, packages/audit-code/tests/next-step.test.mjs
- Summary: The advancePastDesignReview helper (lines 97-138) and its companion constants (ADVANCE_PAST_DESIGN_REVIEW_TERMINAL_KINDS, MAX_STRUCTURE_PHASE_PAUSES) are effectively duplicated in the inline helperUnderTest function (lines 315-329) with its TERMINAL Set. Any change to pause-step handling must be mirrored in both places.
- Evidence:
  - packages/audit-code/tests/next-step.test.mjs:85 - ADVANCE_PAST_DESIGN_REVIEW_TERMINAL_KINDS Set defined with same terminal kinds
  - packages/audit-code/tests/next-step.test.mjs:97-138 - advancePastDesignReview loop handles analyzer_install, design_review, edge_reasoning pauses
  - packages/audit-code/tests/next-step.test.mjs:300 - TERMINAL Set duplicates the same terminal kinds
  - packages/audit-code/tests/next-step.test.mjs:315-329 - helperUnderTest loop mirrors the same pause-handling logic

### MNT-da2276f9 — Duplicated positive/negative pattern splitting loop across cargo.ts and packageJson.ts

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/audit-code/src/extractors/graphManifestEdges/cargo.ts, packages/audit-code/src/extractors/graphManifestEdges/packageJson.ts
- Summary: The loop that categorizes workspace patterns into positive and negative lists, normalizes each pattern, and skips invalid ones is independently duplicated in extractCargoWorkspaceMemberEdges (cargo.ts:94-106) and extractWorkspacePackageEdges (packageJson.ts:237-249).
- Evidence:
  - packages/audit-code/src/extractors/graphManifestEdges/cargo.ts:94-106 - positive/negative pattern normalization loop
  - packages/audit-code/src/extractors/graphManifestEdges/packageJson.ts:237-249 - identical positive/negative pattern normalization loop

### MNT-3c895432 — Duplicated resolveSpawn implementation across two modules

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: duplicated-code
- Files: packages/audit-code/audit-code-wrapper-build.mjs, packages/audit-code/audit-code-wrapper-lib.mjs
- Summary: resolveSpawn() is defined in both audit-code-wrapper-build.mjs:21 and audit-code-wrapper-lib.mjs:72 with slightly different argument-quoting logic. The build variant uses a map().join(' ') pattern while the lib variant uses a separate quoteForCmd helper. Fixing shell-escaping bugs requires touching both copies.
- Evidence:
  - packages/audit-code/audit-code-wrapper-build.mjs:21 - resolveSpawn defined with inline map().join(' ') quoting
  - packages/audit-code/audit-code-wrapper-lib.mjs:72 - resolveSpawn defined with separate quoteForCmd helper

### MNT-701044bc — Duplicated specifier guard logic across four manifest resolver files

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/audit-code/src/extractors/graphManifestEdges/maven.ts, packages/audit-code/src/extractors/graphManifestEdges/go.ts, packages/audit-code/src/extractors/graphManifestEdges/packageJson.ts, packages/audit-code/src/extractors/graphManifestEdges/typescript.ts
- Summary: The guards checking for empty specifiers, absolute paths (startsWith('/')), and URL-like protocols (/^[a-z][a-z0-9+.-]*:/i) are independently repeated in resolveMavenModuleReference, resolveGoWorkspaceModuleReference, resolvePackageEntrypoint, and resolveTypescriptProjectReference. This is a cross-cutting concern that should be centralized.
- Evidence:
  - packages/audit-code/src/extractors/graphManifestEdges/maven.ts:41-53 - normalizedSpecifier guard checks
  - packages/audit-code/src/extractors/graphManifestEdges/go.ts:145-157 - same guard checks
  - packages/audit-code/src/extractors/graphManifestEdges/packageJson.ts:71-91 - same guard checks
  - packages/audit-code/src/extractors/graphManifestEdges/typescript.ts:25-50 - same guard checks

### MNT-d671c06f — Duplicated TOML section-walking state machine across cargo.ts and pyproject.ts

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/audit-code/src/extractors/graphManifestEdges/cargo.ts, packages/audit-code/src/extractors/graphManifestEdges/pyproject.ts
- Summary: The TOML section-walking state machine (section tracking, collecting-key state, flush-on-section-change, array-closed detection) is independently reimplemented in cargoWorkspacePatterns (cargo.ts:8-78) and pyprojectTestpaths (pyproject.ts:8-64). Changes to one will not propagate to the other, creating a maintenance hazard.
- Evidence:
  - packages/audit-code/src/extractors/graphManifestEdges/cargo.ts:8-78 - cargoWorkspacePatterns: section tracking, flushCollectedValue closure, collectingKey state machine
  - packages/audit-code/src/extractors/graphManifestEdges/pyproject.ts:8-64 - pyprojectTestpaths: same section tracking, flush closure, collectingKey state machine

### MNT-a5be811c — Duplicated truncation-and-summary pattern across 7 functions in designReviewPrompt

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: duplicated_logic
- Files: packages/audit-code/src/orchestrator/designReviewPrompt.ts, packages/audit-code/src/orchestrator/designReviewPrompt.ts, packages/audit-code/src/orchestrator/designReviewPrompt.ts, packages/audit-code/src/orchestrator/designReviewPrompt.ts, packages/audit-code/src/orchestrator/designReviewPrompt.ts, packages/audit-code/src/orchestrator/designReviewPrompt.ts, packages/audit-code/src/orchestrator/designReviewPrompt.ts
- Summary: Seven summarize functions each independently implement the same pattern: slice items to a max, format lines with dashes, append truncated count. Each uses a different hardcoded truncation limit (40, 10, 15, 20). This should be extracted into a shared helper.
- Evidence:
  - packages/audit-code/src/orchestrator/designReviewPrompt.ts:15-17 - "... and N more" truncation pattern (duplicated at lines 48, 125, 160)
  - packages/audit-code/src/orchestrator/designReviewPrompt.ts:15 - magic number 40 for units truncation
  - packages/audit-code/src/orchestrator/designReviewPrompt.ts:57 - magic number 10 for risk truncation
  - packages/audit-code/src/orchestrator/designReviewPrompt.ts:35 - magic number 15 for flows truncation
  - packages/audit-code/src/orchestrator/designReviewPrompt.ts:112 - magic number 20 for surfaces truncation

### TST-e8ea387e — errorParsing.ts: detectFromJson, extractResetsInMs, extractResetsAtClockMs, and computeCooldownUntil have zero test coverage

- Severity: medium
- Confidence: high
- Lens: tests
- Category: missing-test-coverage
- Files: packages/shared/src/quota/errorParsing.ts
- Summary: The 136-line errorParsing.ts has only 2 test cases in errorParsing.test.mjs covering the basic RATE_LIMIT_PATTERNS and USAGE_LIMIT_PATTERNS regex matches. The JSON-parsing branch (detectFromJson), extractResetsInMs, extractResetsAtClockMs, and computeCooldownUntil are completely untested despite containing non-trivial parsing logic with clock-time handling, header extraction, and retry-after computation.
- Evidence:
  - packages/shared/src/quota/errorParsing.ts:53-74 - detectFromJson function with status=429, type=rate_limit_error, and error.type handling untested.
  - packages/shared/src/quota/errorParsing.ts:76-85 - extractResetsInMs parses 'Resets in XhYmZs' format with no test coverage.
  - packages/shared/src/quota/errorParsing.ts:90-104 - extractResetsAtClockMs parses 'resets 3:30pm' clock-time format with no test coverage.
  - packages/shared/src/quota/errorParsing.ts:129-136 - computeCooldownUntil function with default-ms and now injection untested.
  - packages/shared/tests/errorParsing.test.mjs: Only 2 test cases covering basic regex pattern matching; no tests for JSON parsing path, Resets-in duration parsing, clock-time reset parsing, or computeCooldownUntil.

### MNT-139d4e8c — Excessive file size impairs maintainability

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: file-size
- Files: packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/pending-audit-tasks.json
- Summary: At 6862 lines, this JSON task manifest is excessively large. Large JSON files are difficult to inspect, validate, diff, and review in version control. The size stems from repeated identical data structures across hundreds of task entries.
- Evidence:
  - packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/pending-audit-tasks.json:1 - File spans 6862 lines from opening '[' to closing ']'

### MNT-a5971908 — Excessive function length in cmdMergeAndIngest (378 lines)

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: excessive-function-length
- Files: packages/audit-code/src/cli/mergeAndIngestCommand.ts
- Summary: cmdMergeAndIngest in mergeAndIngestCommand.ts is 378 lines and handles multiple distinct responsibilities: idempotency replay detection, dispatch result map loading, result file scanning with fallback-by-task-id indexing, per-task validation with nested error branching, audit result ingestion, dispatch state management, retry-dispatch creation, worker result building, completion marker writing, and exit code management.
- Evidence:
  - packages/audit-code/src/cli/mergeAndIngestCommand.ts:27-80 — idempotency replay and stale-marker detection (45 lines)
  - packages/audit-code/src/cli/mergeAndIngestCommand.ts:100-150 — result file scanning with fallback-by-task-id index (50 lines)
  - packages/audit-code/src/cli/mergeAndIngestCommand.ts:162-240 — per-task validation loop with nested fallback/error branching (78 lines)
  - packages/audit-code/src/cli/mergeAndIngestCommand.ts:262-281 — result ingestion and pending task update (19 lines)
  - packages/audit-code/src/cli/mergeAndIngestCommand.ts:296-318 — retry dispatch creation (22 lines)
  - packages/audit-code/src/cli/mergeAndIngestCommand.ts:324-377 — status computation, worker result, summary payload, exit code (53 lines)

### MNT-2b8c9b96 — Excessive function length in detectBootstrapRefreshReason

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: function-length
- Files: packages/audit-code/audit-code-wrapper-install-hosts.mjs
- Summary: detectBootstrapRefreshReason (install-hosts.mjs:946-1070) spans ~125 lines and contains a 6-branch switch statement with nested per-host validation logic. The dense mix of file-existence checks, contract-version comparisons, and content-diffing across 4 host types makes it hard to reason about or modify individual host refresh triggers.
- Evidence:
  - packages/audit-code/audit-code-wrapper-install-hosts.mjs:946-1070 - 125-line function with large switch statement

### MNT-3a5ea976 — Excessive function length in renderAuditReportMarkdown

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: excessive-function-length
- Files: packages/audit-code/src/reporting/synthesis.ts
- Summary: renderAuditReportMarkdown (synthesis.ts:257-383, 127 lines) handles six distinct rendering concerns: header, executive summary, summary stats, top risks, themes, work blocks, findings, and scope/coverage. This violates single responsibility and makes targeted edits risky.
- Evidence:
  - packages/audit-code/src/reporting/synthesis.ts:257-383 - single 127-line function rendering report header, executive summary, summary table, themes, work blocks, findings, and scope coverage

### MNT-ccc69b88 — Excessive single-file test length in extractors-remediation.test.mjs

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: excessive-file-length
- Files: packages/audit-code/tests/extractors-remediation.test.mjs
- Summary: extractors-remediation.test.mjs is 1917 lines, spanning ~25+ test blocks across multiple unrelated extractor concerns (path predicates, graph bundles, Chrome extensions, workspace manifests, etc.). This makes navigation and maintenance harder than necessary for a single file.
- Evidence:
  - packages/audit-code/tests/extractors-remediation.test.mjs:1 - File spans 1917 total lines covering loadIgnoreFile, buildRiskRegister, bucketFile, ~15 path predicate tests, buildGraphBundle (12+ scenarios), buildSurfaceManifest (Chrome ext + standard), buildUnitManifest, Chrome extension fixture (shared at line 679)

### MNT-e2541667 — Excessive vendor dependency path duplication across packets

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/audit-code/.audit-artifacts/review_packets.json
- Summary: The .tmp/opentoken vendor dependency tree appears in 28 of 64 packets (44%), creating 3.33x file_path redundancy (1394 entries vs 419 unique).
- Evidence:
  - review_packets.json:1-8057 - 64 packets with 28 (44%) including .tmp/opentoken vendor paths; 1394 total entries vs 419 unique (3.33x)

### OBS-b63d3314 — External analyzer skip status lacks diagnostic context

- Severity: medium
- Confidence: high
- Lens: observability
- Category: missing-telemetry
- Files: packages/audit-code/.audit-artifacts/external_analyzer_results.json
- Summary: external_analyzer_results.json records that eslint was skipped (resolved: false, status: skipped) but provides no reason, error, or fallback info. Operators cannot determine whether the skip is due to missing config, tool absence, or explicit opt-out.
- Evidence:
  - packages/audit-code/.audit-artifacts/external_analyzer_results.json:12-16 - eslint entry has no reason, error message, or log for the skip

### DAT-829e1d58 — external_analyzer_results.schema.json raw field bypasses validation

- Severity: medium
- Confidence: high
- Lens: data_integrity
- Category: missing-validation
- Files: packages/audit-code/schemas/external_analyzer_results.schema.json
- Summary: The raw field in external_analyzer_results.schema.json results items is an empty schema ({}) accepting any value without constraints. External tool results piped through this field bypass all schema validation, creating a data integrity gap at the trust boundary between external analyzers and the audit pipeline.
- Evidence:
  - packages/audit-code/schemas/external_analyzer_results.schema.json:65 - 'raw': {} empty schema accepts any value

### TST-5b4189a9 — Fragile stderr spy with overlapping restore paths in wave-scheduler.test.ts

- Severity: medium
- Confidence: high
- Lens: tests
- Category: fragile-test
- Files: packages/remediate-code/tests/wave-scheduler.test.ts
- Summary: The stderr spy test captures `process.stderr.write.bind(process.stderr)` at module scope and has overlapping restore paths in both the `finally` block and `afterEach` hook. If test execution order changes or other tests mock stderr, the captured `original` reference may become stale. The synchronous assertion on `written.join('')` after `await scheduleWave` does not guarantee all async stderr writes have flushed.
- Evidence:
  - packages/remediate-code/tests/wave-scheduler.test.ts:344-346 - afterEach calls vi.restoreAllMocks() which may race with mockRestore() in finally block at line 382-383
  - packages/remediate-code/tests/wave-scheduler.test.ts:350-351 - original reference captured via .bind(process.stderr) at module eval time — stale if other tests replace stderr.write before this test runs
  - packages/remediate-code/tests/wave-scheduler.test.ts:391-392 - Synchronous assertion on written.join('') after await — async stderr flush callbacks may still be pending

### TST-85aaa50e — fs-intake readdir/stat error-recovery branches untested on Windows

- Severity: medium
- Confidence: high
- Lens: tests
- Category: test-coverage
- Files: packages/audit-code/tests/fs-intake.test.mjs, packages/audit-code/tests/fs-intake.test.mjs
- Summary: The readdir-error (line 64) and stat-error (line 103) tests in fs-intake.test.mjs acknowledge they cannot simulate filesystem I/O errors on Windows (comment at line 82-84). Both tests fall back to happy-path assertions, never exercising the source implementation's 'skipping unreadable directory' and 'skipping unreadable file' warning branches.
- Evidence:
  - packages/audit-code/tests/fs-intake.test.mjs:78-86 - Comment: 'chmod is not available on Windows' and 'Instead, use a mock-friendly approach' admitting the test cannot trigger the error
  - packages/audit-code/tests/fs-intake.test.mjs:94-99 - Asserts zero warnings for clean walk, never exercises the error path
  - packages/audit-code/tests/fs-intake.test.mjs:123-127 - Same pattern: asserts zero stat-error warnings for clean walk

### OBS-2f7af7bb — Git command failures silently return empty results with no log emission

- Severity: medium
- Confidence: high
- Lens: observability
- Category: missing-telemetry
- Files: packages/shared/src/git.ts
- Summary: The gitLines helper in git.ts discards non-zero exit codes by returning an empty array with no structured log emission. All downstream helpers (isGitRepo, gitRefExists, changedFiles, fileCommits, stagedAndUntracked) inherit this behavior — a corrupted repo, permission error, or unexpected git version produces empty results indistinguishable from "no changes", leaving operators with no trace of the failure.
- Evidence:
  - packages/shared/src/git.ts:12-14 - gitLines checks result.status !== 0 and returns [] with no logging, no error message, no structured telemetry
  - packages/shared/src/git.ts:22-28 - isGitRepo silently degrades when git rev-parse fails
  - packages/shared/src/git.ts:36-41 - gitRefExists discards failure with no trace
  - packages/shared/src/git.ts:47-49 - changedFiles silently returns [] on git diff failure
  - packages/shared/src/git.ts:52-54 - fileCommits silently returns empty Set on failure

### MNT-0047837c — Hardcoded Developer-Specific Absolute Paths in Dispatch Plan

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: coupling
- Files: packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/dispatch-plan.json
- Summary: The dispatch-plan.json contains developer-specific absolute path strings ('C:\\Code\\auditor-lambda\\...') for generated prompt file targets, violating CWD-independence principles and hindering portability.
- Evidence:
  - packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/dispatch-plan.json:5 - "prompt_path": "C:\\Code\\auditor-lambda\\.audit-artifacts\\runs\\..."

### MNT-5f6bacdc — High file path duplication across lens-split tasks

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/audit-code/.audit-artifacts/audit_tasks.json
- Summary: The same file paths are repeated across multiple tasks under different lenses and splits. For example, .tmp/opentoken/bun.lock and .tmp/opentoken/src/utils/cache.ts each appear in 5+ tasks, and 197 unique .tmp/opentoken paths are distributed across 63 separate tasks. This creates tight coupling between task entries: any file path change requires updating many task definitions.
- Evidence:
  - packages/audit-code/.audit-artifacts/audit_tasks.json:141 - .tmp/opentoken/bun.lock referenced in flow:flow:surface:src-types-workerSession-ts:reliability:part-1
  - packages/audit-code/.audit-artifacts/audit_tasks.json:147 - .tmp/opentoken/opentoken/bun.lock also in same task's file_paths array
  - packages/audit-code/.audit-artifacts/audit_tasks.json:136-151 - At least 6 of 15 file_paths in task 'flow:flow:surface:src-types-workerSession-ts:reliability:part-1' are .tmp/opentoken paths that also appear under -tmp-opentoken:* tasks (63 total tasks for -tmp-opentoken unit)
  - packages/audit-code/.audit-artifacts/audit_tasks.json:1673-1676 - Four consecutive .tmp paths (cache.ts, bun.lock, cache.ts, cache.ts) repeat in the same task listing

### TST-4bcf7294 — hostLimits.ts (76 lines) has no tests despite multi-path fallback resolution

- Severity: medium
- Confidence: high
- Lens: tests
- Category: missing-test-coverage
- Files: packages/shared/src/quota/hostLimits.ts
- Summary: hostLimits.ts contains detectHostActiveSubagentLimit and resolveHostActiveSubagentLimit with a multi-tier fallback chain (explicit env var to Codex Desktop override to CLI flags to session config to env detection), plus a dedicated parsePositiveInteger helper. None of these paths have any test coverage.
- Evidence:
  - packages/shared/src/quota/hostLimits.ts:11-20 - parsePositiveInteger helper handles number, string, numeric regex validation, and safe-integer checks — untested.
  - packages/shared/src/quota/hostLimits.ts:22-47 - detectHostActiveSubagentLimit with env-prefix and Codex Desktop override — untested.
  - packages/shared/src/quota/hostLimits.ts:49-76 - resolveHostActiveSubagentLimit with full fallback chain — untested.

### CFG-0843f20d — Incomplete release rollback leaving remote repository in inconsistent state

- Severity: medium
- Confidence: high
- Lens: config_deployment
- Category: deployment-safety
- Files: packages/remediate-code/scripts/release-and-publish.mjs
- Summary: Pushed default branch commits are not rolled back on subsequent release errors.
- Evidence:
  - packages/remediate-code/scripts/release-and-publish.mjs:357 - git push of the bumped release branch is executed before tag push and GitHub release creation.
  - packages/remediate-code/scripts/release-and-publish.mjs:365-385 - catch block only deletes local/remote tags, leaving the bumped version commit on the remote branch.

### CFG-db4f5dbe — Incomplete release rollback leaving remote repository in inconsistent state

- Severity: medium
- Confidence: high
- Lens: config_deployment
- Category: deployment-safety
- Files: packages/shared/scripts/release-and-publish.mjs
- Summary: Pushed default branch commits are not rolled back on subsequent release errors.
- Evidence:
  - packages/shared/scripts/release-and-publish.mjs:320 - git push of the bumped release branch is executed before tag push and GitHub release creation.
  - packages/shared/scripts/release-and-publish.mjs:328-348 - catch block only deletes local/remote tags, leaving the bumped version commit on the remote branch.

### DAT-bb581ba4 — Inconsistent file classification enums between file_disposition and coverage_matrix schemas

- Severity: medium
- Confidence: high
- Lens: data_integrity
- Category: inconsistent-field-naming
- Files: packages/audit-code/schemas/file_disposition.schema.json
- Summary: file_disposition.schema.json uses status enum with 'included' for files that pass filtering, while coverage_matrix.schema.json uses classification_status enum with 'unclassified'/'classified' for the same conceptual state. These sibling schemas govern related file-tracking processes but use incompatible vocabularies, creating mapping ambiguity when reconciling dispositions against coverage data.
- Evidence:
  - packages/audit-code/schemas/file_disposition.schema.json:16-24 - status enum uses 'included' not 'unclassified'/'classified'
  - packages/audit-code/schemas/coverage_matrix.schema.json:19-21 - coverage_matrix uses 'unclassified'/'classified' not 'included'

### COR-fa0b9d7e — Incorrect final report path returned on natural completion in next-step

- Severity: medium
- Confidence: high
- Lens: correctness
- Category: logic-error
- Files: packages/audit-code/src/cli/nextStepCommand.ts
- Summary: When the audit completes naturally, nextStepCommand returns an incorrect finalReportPath using the repository root instead of the parent of artifactsDir, which mismatches where promoteFinalAuditReport actually writes the file.
- Evidence:
  - packages/audit-code/src/cli/nextStepCommand.ts:482-484 - finalReportPath: promoted.promoted ? join(params.root, AUDIT_REPORT_FILENAME) : join(params.artifactsDir, AUDIT_REPORT_FILENAME)

### MNT-179aac32 — inferLanguage uses final-dot-only extension parsing, leaving generated compound-extension and filename keys unreachable

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: inconsistent-abstraction
- Files: packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_correctness_part-1_2077707e0154.json
- Summary: The generated language map contains compound-extension entries like 'blade.php' and exact-filename entries like 'dockerfile' and 'tsconfig.json', but inferLanguage computes the extension via base.split('.').pop() which can only return the final dot segment. The data-generation and data-consumption abstractions are inconsistent, creating dead-code entries that a maintainer must manually cross-reference to discover. This was initially reported as correctness finding COR-003, but the root cause is an abstraction mismatch between map generation and lookup.
- Evidence:
  - packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_correctness_part-1_2077707e0154.json:76 - generated map has key 'blade.php' that inferLanguage can only resolve as 'php'
  - packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_correctness_part-1_2077707e0154.json:78 - generated map has key 'dockerfile' that inferLanguage resolves as empty string
  - packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_correctness_part-1_2077707e0154.json:80 - generated map has key 'tsconfig.json' that inferLanguage resolves as 'json'
  - Current src/extractors/fileInventory.ts:26-27 - the same base.split('.').pop() logic persists in the refactored codebase

### MNT-00f19b47 — Inline makeFinding helper duplicated across multiple test bodies

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/audit-code/tests/orchestrator-remediation.test.mjs
- Summary: The makeFinding factory function is defined inline inside three separate test bodies (lines 351, 1671, 1731, 1791) with identical structure. Hoisting to module scope would eliminate the duplication and improve discoverability.
- Evidence:
  - packages/audit-code/tests/orchestrator-remediation.test.mjs:351 - const finding = (id, severity, confidence) => ({...}) — defined inside test body
  - packages/audit-code/tests/orchestrator-remediation.test.mjs:1671 - const makeFinding = (id, severity, confidence) => ({...}) — duplicated inside another test body
  - packages/audit-code/tests/orchestrator-remediation.test.mjs:1731 - const makeFinding = (id, severity, confidence) => ({...}) — third copy
  - packages/audit-code/tests/orchestrator-remediation.test.mjs:1791 - const makeFinding = (id, severity, confidence) => ({...}) — fourth copy

### TST-7c24b3a7 — Insufficient test coverage for rate limit and clock reset parsing

- Severity: medium
- Confidence: high
- Lens: tests
- Category: test-coverage
- Files: packages/shared/src/quota/errorParsing.ts
- Summary: The error parsing test suite (errorParsing.test.mjs) only exercises basic regex pattern matches but completely misses JSON-based detection, headers parsing, duration-based reset parsing (Resets in ...), and wall-clock resets (resets ...am/pm).
- Evidence:
  - packages/shared/tests/errorParsing.test.mjs:6 - Only basic regex matching for RATE_LIMIT_PATTERNS and USAGE_LIMIT_PATTERNS is tested, leaving JSON and reset/clock math untested.

### TST-1b04654d — isFileMissingError and readOptionalJsonFile are completely untested

- Severity: medium
- Confidence: high
- Lens: tests
- Category: test-coverage-gap
- Files: packages/shared/src/io/json.ts, packages/shared/src/io/json.ts
- Summary: The JSON filesystem helpers isFileMissingError and readOptionalJsonFile lack any unit tests to verify error classification or fallback behavior.
- Evidence:
  - packages/shared/src/io/json.ts:104-111 - isFileMissingError is defined but never imported or tested in packages/shared/tests
  - packages/shared/src/io/json.ts:187-198 - readOptionalJsonFile is defined but never imported or tested in packages/shared/tests

### CFG-4f714882 — Lack of transactional rollback in multi-package release orchestrator

- Severity: medium
- Confidence: high
- Lens: config_deployment
- Category: deployment-safety
- Files: scripts/release-changed.mjs
- Summary: If release of subsequent packages in a batch fails, already-published packages cannot be easily rolled back.
- Evidence:
  - scripts/release-changed.mjs:319-324 - loop runs release command per workspace; failure of a latter package leaves earlier package releases deployed without automated rollback.

### TST-5dd98fc7 — limits.ts (168 lines) has no dedicated tests covering resolveLimits or classifyProvider

- Severity: medium
- Confidence: high
- Lens: tests
- Category: missing-test-coverage
- Files: packages/shared/src/quota/limits.ts
- Summary: limits.ts provides resolveLimits with a 4-tier resolution chain (explicit config, known metadata, provider-default, generic default), classifyProvider mapping all provider names to hosted/local/unknown, resolveHostModel with multi-source fallback, and agentHostFallbackConcurrency. None of these are directly tested; only indirect coverage through scheduler.test.mjs exercises one or two resolveLimits paths.
- Evidence:
  - packages/shared/src/quota/limits.ts:7-26 - classifyProvider maps 8 provider names across 3 types; no direct test coverage.
  - packages/shared/src/quota/limits.ts:116-168 - resolveLimits 4-tier resolution chain untested as a standalone function.
  - packages/shared/src/quota/limits.ts:68-85 - resolveHostModel with 4-source fallback untested.
  - packages/shared/src/quota/limits.ts:40-46 - agentHostFallbackConcurrency for claude-code/vscode-task vs others untested.

### TST-7620db54 — LocalSubprocessProvider is completely untested

- Severity: medium
- Confidence: high
- Lens: tests
- Category: test-coverage-gap
- Files: packages/shared/src/providers/localSubprocessProvider.ts
- Summary: LocalSubprocessProvider lacks any unit tests, leaving its task validation and launching behavior completely unverified.
- Evidence:
  - packages/shared/src/providers/localSubprocessProvider.ts:15-35 - Class LocalSubprocessProvider defines launch behavior but has no matching unit test file in packages/shared/tests

### MNT-40e7f88e — Long function: buildAuditPlanMetrics with excessive accumulators

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: function-length
- Files: packages/audit-code/src/orchestrator/reviewPackets.ts
- Summary: buildAuditPlanMetrics (lines 760-835) is ~75 lines computing 15+ derived fields across task counts, line counts, lens/priority breakdowns, packet quality, and packet size. The function directly accesses internals of buildReviewPacketPlanningData and has no intermediate data structure to separate concerns.
- Evidence:
  - packages/audit-code/src/orchestrator/reviewPackets.ts:766-795 - accumulates taskLineCounts, totalTaskLines, largestPacket, lensTaskCounts, priorityTaskCounts
  - packages/audit-code/src/orchestrator/reviewPackets.ts:798-834 - builds return object with 20+ metric fields

### MNT-49c97832 — Long function: computeAuditScope with complex frontier-expansion loop

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: function-length
- Files: packages/audit-code/src/orchestrator/scope.ts
- Summary: computeAuditScope (lines 49-180) is ~130 lines combining seed resolution, adjacency building, a max-product shortest-path frontier loop, hub-skipping, budget enforcement, and result assembly. The main loop (lines 111-153) has nested state tracking across best/visited/inScope/expandedKeys maps and sets, making the flow hard to follow and test.
- Evidence:
  - packages/audit-code/src/orchestrator/scope.ts:83-98 - adjacency building with bidirectional edges
  - packages/audit-code/src/orchestrator/scope.ts:111-153 - main frontier loop with 4 map/set accumulators
  - packages/audit-code/src/orchestrator/scope.ts:155-179 - result assembly and notes construction

### MNT-74ca9e58 — Low-confidence heuristic-container-edge noise dominates graph

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: high-noise-signal-ratio
- Files: packages/audit-code/.audit-artifacts/graph_bundle.json
- Summary: 336 of 956 import edges (35%) are heuristic-container-edge entries with confidence 0.25 that encode only path hierarchy information already implicit in the file paths. This bulk degrades navigation and processing speed without adding signal.
- Evidence:
  - packages/audit-code/.audit-artifacts/graph_bundle.json:7 - First heuristic-container-edge entry; all 336 share kind, 0.25 confidence, and nearly identical reason text.

### MNT-050283cd — Magic confidence threshold 0.65 hardcoded in test instead of referencing production constant

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: magic-constants
- Files: packages/audit-code/tests/next-step-edge-reasoning.test.mjs, packages/audit-code/tests/next-step-edge-reasoning.test.mjs
- Summary: The low-confidence edge threshold 0.65 is hardcoded in next-step-edge-reasoning.test.mjs (lines 55, 242) and also referenced in nextStepCommand.ts:233. If the production threshold changes, this test silently diverges, either failing unexpectedly or passing despite incorrect filtering.
- Evidence:
  - packages/audit-code/tests/next-step-edge-reasoning.test.mjs:55 - Hardcoded 0.65 filter threshold
  - packages/audit-code/tests/next-step-edge-reasoning.test.mjs:242 - Same threshold repeated
  - packages/audit-code/src/cli/nextStepCommand.ts:233 - Production reference to same value (boundary cross-reference)

### MNT-099239c5 — Magic number constants for line counts and thresholds scattered across tests

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: magic-constants
- Files: packages/audit-code/tests/orchestrator-remediation.test.mjs
- Summary: Line count values like 40, 30, 12, 56, 25, 20, 1800, 250, 9999, 1200, 700 are used directly in fixture construction without named constants. The semantic meaning (e.g., 'minimum lines to trigger large_lens_surface threshold') is invisible to readers and brittle against threshold changes.
- Evidence:
  - packages/audit-code/tests/orchestrator-remediation.test.mjs:291 - file_line_counts: { "src/api/auth.ts": 40 } — appears ~15+ times across tests
  - packages/audit-code/tests/orchestrator-remediation.test.mjs:1462 - 1800, 250, 9999 used as fixture values with implied threshold semantics (2000 totalLines boundary)
  - packages/audit-code/tests/orchestrator-remediation.test.mjs:1545 - 1200, 700 used in first-owner boundary test without named constants

### OBS-12a91d6b — Meta-audit tasks for packages-audit-code absent from task list

- Severity: medium
- Confidence: high
- Lens: observability
- Category: missing_observability_context
- Files: packages/audit-code/.audit-artifacts/audit_tasks.json
- Summary: The audit plan defines tasks for many units but contains no entries where unit_id includes 'packages-audit-code'. The self-audit tasks for the audit-code package itself (including this observability pass) are not represented in the plan, creating an observability blind spot where the plan's own coverage cannot be traced or verified from within the plan file.
- Evidence:
  - packages/audit-code/.audit-artifacts/audit_tasks.json:1-4845 - No task entry has a unit_id containing 'packages-audit-code'; grep for 'packages-audit-code' returns zero matches across all 4845 lines

### REL-46214fdc — Mismatched job and step timeouts in publish-shared workflow

- Severity: medium
- Confidence: high
- Lens: reliability
- Category: missing-timeout
- Files: .github/workflows/publish-package.yml
- Summary: In publish-package.yml, the publish-shared job has a 15-minute timeout-minutes limit, but its nested 'Verify release gate' step has a 20-minute timeout-minutes limit. If the verify step takes longer than 15 minutes, the job will fail prematurely, rendering the step timeout useless.
- Evidence:
  - .github/workflows/publish-package.yml:506 - publish-shared job defines timeout-minutes: 15
  - .github/workflows/publish-package.yml:560 - Step 'Verify release gate' defines timeout-minutes: 20

### COR-a75b570b — Missing '.tmp' in fsIntake DEFAULT_IGNORES

- Severity: medium
- Confidence: high
- Lens: correctness
- Category: missing-validation
- Files: packages/audit-code/.audit-artifacts/file_disposition.json, packages/audit-code/.audit-artifacts/flow_coverage.json
- Summary: The filesystem intake scanner (packages/audit-code/src/extractors/fsIntake.ts) does not ignore the '.tmp/' directory. Consequently, transient scratch files, build tools, and vendored dependencies (e.g. '.tmp/opentoken/') are walked, indexed, and audited, which bloats the token usage and violates the design rule that '.tmp/' should be excluded.
- Evidence:
  - packages/audit-code/.audit-artifacts/file_disposition.json:804 - '.tmp/opentoken/opentoken/src/lzw.ts' is walked and set to 'included'.
  - packages/audit-code/.audit-artifacts/flow_coverage.json:76 - '.tmp' paths are included in flow coverage paths.

### OBS-f1fcbeca — Missing generation provenance and metadata in graph bundle

- Severity: medium
- Confidence: high
- Lens: observability
- Category: missing-observability-context
- Files: packages/audit-code/.audit-artifacts/graph_bundle.json
- Summary: The graph_bundle.json carries no generation timestamp, tool version, input hash, or other provenance metadata. Consumers cannot determine when the graph was generated, which version of the dependency resolver produced it, or whether it is stale relative to the current source tree.
- Evidence:
  - packages/audit-code/.audit-artifacts/graph_bundle.json:1-5 - Top-level object has only 'graphs' and 'routes' keys; no 'generated_at', 'version', 'tool', or 'input_hash' fields exist anywhere in the file.
  - packages/audit-code/.audit-artifacts/graph_bundle.json:7653 - 'calls' graph is empty array; no diagnostic metadata explains why no call edges were extracted.
  - packages/shared/src/types/graph.ts:24-29 - GraphBundle type defines optional 'analyzers_used' provenance array, but the on-disk file omits it entirely.

### COR-5750c464 — Missing Task Existence Check in Single Result Validation

- Severity: medium
- Confidence: high
- Lens: correctness
- Category: logic-error
- Files: packages/audit-code/src/cli/validateResultCommand.ts
- Summary: In validateResultCommand.ts, validating a single result file for a task ID that is not present in pending-audit-tasks.json passes validation cleanly without flagging the task ID as unknown, because validateAuditResults only asserts task existence when the tasks array is non-empty.
- Evidence:
  - packages/audit-code/src/cli/validateResultCommand.ts:45-51 - const matchingTasks = allTasks.filter(t => t.task_id === taskId);\n  const lineIndex = matchingTasks[0]?.file_line_counts ?? {};\n  const issues = validateAuditResults([obj], matchingTasks, { lineIndex });

### OBS-912c5926 — Missing temporal metadata on all packet objects

- Severity: medium
- Confidence: high
- Lens: observability
- Category: missing-observability-metadata
- Files: packages/audit-code/.audit-artifacts/review_packets.json
- Summary: Every packet object in review_packets.json lacks creation timestamps, duration fields, and last-updated times. Without temporal metadata there is no basis for correlating packet lifecycle, measuring audit pass duration, or diagnosing latency regressions.
- Evidence:
  - packages/audit-code/.audit-artifacts/review_packets.json:2-8056 - All 40+ packet objects lack any timestamp, duration_ms, or date field; fields present are packet_id, task_ids, unit_ids, pass_ids, lenses, file_paths, file_line_counts, total_lines, priority, tags, key_edges, boundary_files, quality, rationale, estimated_tokens — none temporal.
  - packages/audit-code/.audit-artifacts/review_packets.json:178 - Example packet (line 2-265) shows estimated_tokens (planning metric) but no actual execution duration or timing data.

### TST-5f3b4446 — Missing test coverage for analyzer cache root resolution

- Severity: medium
- Confidence: high
- Lens: tests
- Category: test-coverage
- Files: packages/shared/src/tooling/analyzerDeps.ts
- Summary: The analyzerCacheRoot function in analyzerDeps.ts has no tests verifying fallback behavior to homedir or override behavior via the AUDIT_TOOLS_ANALYZER_CACHE environment variable.
- Evidence:
  - packages/shared/src/tooling/analyzerDeps.ts:32 - analyzerCacheRoot is defined but not imported or tested in packages/shared/tests/analyzerDeps.test.mjs.

### TST-a660d2af — Missing test coverage for command quoting and wrapping functions

- Severity: medium
- Confidence: high
- Lens: tests
- Category: test-coverage
- Files: packages/shared/src/tooling/exec.ts
- Summary: Functions quoteForOpenTokenCmd, wrapForOpenToken, and quotePromptCommandArg are defined in exec.ts but never imported, tested, or exercised in the test suite.
- Evidence:
  - packages/shared/src/tooling/exec.ts:190 - quoteForOpenTokenCmd is defined but not imported or tested in packages/shared/tests/exec.test.mjs.

### TST-25fbb3fd — Missing test coverage for host concurrency limit resolution

- Severity: medium
- Confidence: high
- Lens: tests
- Category: test-coverage
- Files: packages/shared/src/quota/hostLimits.ts
- Summary: The host limits detection and resolution logic in hostLimits.ts has no tests verifying environment-based limits, Codex Desktop overrides, or config-based resolution.
- Evidence:
  - packages/shared/src/quota/hostLimits.ts:22 - detectHostActiveSubagentLimit is defined but never imported or tested in packages/shared/tests.

### TST-3b209ceb — Missing test coverage for provider error parser implementations

- Severity: medium
- Confidence: high
- Lens: tests
- Category: test-coverage
- Files: packages/shared/src/quota/errorParsers/claudeCodeErrorParser.ts, packages/shared/src/quota/errorParsers/genericErrorParser.ts, packages/shared/src/quota/errorParsers/index.ts
- Summary: The ClaudeCodeErrorParser and GenericErrorParser implementations, along with getErrorParserForProvider factory, have zero tests verifying their line-splitting, JSON parsing, status/type classification, and backoff/retry-after extraction.
- Evidence:
  - packages/shared/src/quota/errorParsers/claudeCodeErrorParser.ts:7 - ClaudeCodeErrorParser.parse is defined but never imported or tested in packages/shared/tests.

### TST-9140ec42 — Missing test coverage for sliding capacity wave assignment loop

- Severity: medium
- Confidence: high
- Lens: tests
- Category: test-coverage
- Files: packages/shared/src/quota/capacity.ts
- Summary: The capacity planning loop in capacity.ts contains a trim-down loop for partitioning high-token-cost items across slots which is completely untested, alongside missing tests for empty pending items or cooldown states.
- Evidence:
  - packages/shared/src/quota/capacity.ts:158 - The while-loop trimming down assigned tokens to match scheduled slots has no tests covering its behavior.

### REL-96019c44 — Missing Timeout during Executable Resolution

- Severity: medium
- Confidence: high
- Lens: reliability
- Category: missing-timeout
- Files: packages/audit-code/src/validation/sessionConfig.ts
- Summary: In validation/sessionConfig.ts, the commandExists helper runs execAsync to search for external CLI executables (e.g. claude, opencode) using host lookup commands without specifying a timeout, potentially hanging execution indefinitely if path lookups block.
- Evidence:
  - packages/audit-code/src/validation/sessionConfig.ts:176-184 - execAsync(`${lookupCommand} ${command}`) is called with no timeout, which can hang if PATH includes slow network/remote mounts or hung directories.

### MNT-7bada16b — Monolithic artifact file — 19965 lines across 1527 entries

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: excessive-file-size
- Files: packages/audit-code/.audit-artifacts/requeue_tasks.json
- Summary: requeue_tasks.json is a single JSON array of 19965 lines containing 1527 entries. This monolithic structure is difficult to review, diff in version control, or reason about as a whole. The file should be split by lens or unit_id to improve maintainability.
- Evidence:
  - packages/audit-code/.audit-artifacts/requeue_tasks.json:19965 - File is 19965 lines containing 1527 entries in a single flat JSON array
  - Each entry is a requeue task — the data could be split by lens (10 unique lenses) or by unit_id to reduce cognitive load per artifact

### MNT-dc17d71d — Monolithic task listing without partitioning

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: excessive-file-size
- Files: packages/audit-code/.audit-artifacts/audit_tasks.json
- Summary: The audit_tasks.json file contains 273 tasks in a single 4845-line flat JSON array with no partitioning by lens, unit, or status. Any read, update, or validation operation requires loading the entire file into memory and scanning all entries, making incremental processing and parallel review impossible.
- Evidence:
  - packages/audit-code/.audit-artifacts/audit_tasks.json:1 - File starts directly with [ and ends at line 4845 with a single flat array of 273 task objects across 10 lens types (maintainability=67, tests=66, correctness=57, observability=48, reliability=12, data_integrity=6, config_deployment=5, operability=5, performance=5, security=2)

### MNT-c724d334 — Monolithic validateArtifactBundle handles all artifact types in one function

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: large-function
- Files: packages/audit-code/src/validation/artifacts.ts
- Summary: validateArtifactBundle (artifacts.ts:26-539) validates 15+ artifact types in a single 514-line function. The requireKeys check on lines 31-171 repeats an identical pattern 14 times, making it hard to extend and merge-conflict-prone.
- Evidence:
  - packages/audit-code/src/validation/artifacts.ts:31-171 - 14 nearly identical if-blocks each calling requireKeys on a different bundle property
  - packages/audit-code/src/validation/artifacts.ts:231-242 - coverage_matrix cross-check structurally identical to file_disposition cross-check on lines 244-257
  - packages/audit-code/src/validation/artifacts.ts:173-219 - Repeated asArray<> casts with type annotations for each property

### OBS-ab3ffaeb — No error or retry telemetry on packet objects

- Severity: medium
- Confidence: high
- Lens: observability
- Category: missing-observability-metadata
- Files: packages/audit-code/.audit-artifacts/review_packets.json
- Summary: Packet objects have no fields for tracking task execution outcomes — no error_count, retry_count, success/failure status, or error_type categorization. This prevents measuring audit reliability, identifying persistently failing tasks, or generating error-rate dashboards.
- Evidence:
  - packages/audit-code/.audit-artifacts/review_packets.json:2-8056 - All packet objects define only planning/scope fields; no error_count, retry_count, status, or failure-tracking fields exist anywhere in the file.
  - packages/audit-code/.audit-artifacts/review_packets.json:178 - Packet at line 266-513 shows same structure with priority, tags, quality graph metrics but zero error-tracking fields.

### OBS-886b64e7 — No lifecycle timestamps on tasks

- Severity: medium
- Confidence: high
- Lens: observability
- Category: missing-observability
- Files: packages/audit-code/.audit-artifacts/dispatch/current-tasks.json
- Summary: Task objects lack created_at, started_at, and completed_at timestamps, preventing duration measurement, stall detection, and throughput SLIs.
- Evidence:
  - packages/audit-code/.audit-artifacts/dispatch/current-tasks.json:3-6862 - No task object contains created_at, started_at, or completed_at fields

### OBS-2ab59697 — No retry or error tracking on tasks

- Severity: medium
- Confidence: high
- Lens: observability
- Category: missing-observability
- Files: packages/audit-code/.audit-artifacts/dispatch/current-tasks.json
- Summary: Task objects lack retry_count, last_error, or error_count fields, making failure rate and error distribution invisible.
- Evidence:
  - packages/audit-code/.audit-artifacts/dispatch/current-tasks.json:3-6862 - No task object contains retry_count, last_error, or error_count fields

### TST-d94a5d30 — No unit tests exist for 10 shared/src modules with significant logic

- Severity: medium
- Confidence: high
- Lens: tests
- Category: missing-test-coverage
- Files: packages/shared/src/io/json.ts, packages/shared/src/providers/spawnLoggedCommand.ts, packages/shared/src/providers/providerFactory.ts, packages/shared/src/providers/subprocessTemplateProvider.ts, packages/shared/src/git.ts, packages/shared/src/observability/runLog.ts, packages/shared/src/parsing/stringAwareScanner.ts, packages/shared/src/providers/codexProvider.ts, packages/shared/src/providers/localSubprocessProvider.ts, packages/shared/src/providers/opencodeLaunch.ts
- Summary: The packages/shared package has zero test files. Ten source files listed in this task contain branching logic, error handling, or state management and go completely untested: io/json.ts (atomic writes with retry + 7 public functions), spawnLoggedCommand.ts (process lifecycle with timeout/escalation), providerFactory.ts (auto-resolution with 11 priority rules), subprocessTemplateProvider.ts (template rendering with placeholder substitution), git.ts (git command wrappers), runLog.ts (logging class), stringAwareScanner.ts (character-level state machine), codexProvider.ts, localSubprocessProvider.ts, and opencodeLaunch.ts.
- Evidence:
  - glob packages/shared/**/*.test.ts returned zero results — no test files exist in the shared package
  - packages/shared/src/io/json.ts:65-84 - withFsRetry implements exponential backoff with transient error detection — untested
  - packages/shared/src/io/json.ts:86-102 - writeFileAtomic implements atomic temp-file + rename pattern — untested
  - packages/shared/src/providers/spawnLoggedCommand.ts:70-285 - SpawnRunController manages spawn, timeout escalation, heartbeat interval, log flush-before-settle — untested
  - packages/shared/src/providers/providerFactory.ts:121-197 - PROVIDER_PRIORITY_RULES table with 11 ranked auto-resolution rules — untested
  - packages/shared/src/providers/subprocessTemplateProvider.ts:18-82 - applyTemplate implements placeholder substitution with shell-quoting and wholePlaceholder detection — untested
  - packages/shared/src/parsing/stringAwareScanner.ts:29-77 - scanStringAware implements character-level state machine with quote tracking and escape handling — untested
  - packages/shared/src/observability/runLog.ts:46-83 - RunLogger class with serialization safety, error swallowing, disabled() factory — untested
  - packages/shared/src/providers/opencodeLaunch.ts:15-31 - resolveOpenCodeSpawnCommand platform branching logic — untested

### MNT-96f399f2 — Overlarge module mixing packet construction, quality metrics, and plan metrics

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: module-size
- Files: packages/audit-code/src/orchestrator/reviewPackets.ts
- Summary: reviewPackets.ts is 835 lines containing packet building (buildPacket, chunkPacketTasks), quality metrics (buildPacketQualityMetrics, countMergeEdgeKinds), plan metrics (buildAuditPlanMetrics), and many small helpers. This forces readers to navigate a single large module to understand three distinct concerns.
- Evidence:
  - packages/audit-code/src/orchestrator/reviewPackets.ts:311-376 - buildReviewPacketPlanningData orchestrates grouping and packet assembly
  - packages/audit-code/src/orchestrator/reviewPackets.ts:684-758 - buildPacketQualityMetrics aggregates seven metric groups
  - packages/audit-code/src/orchestrator/reviewPackets.ts:760-835 - buildAuditPlanMetrics computes 15+ numeric fields across tasks and packets

### MNT-1acb2985 — Overly long function with nested loops in staleness computation

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: excessive-function-length
- Files: packages/audit-code/src/orchestrator/staleness.ts
- Summary: computeStaleArtifacts in staleness.ts is a single 86-line function containing three nested loops (for metadata entries, for dependency entries, transitive propagation loop) with deep branching and mutation-heavy state management via a shared Set, making it difficult to test individual phases independently.
- Evidence:
  - packages/audit-code/src/orchestrator/staleness.ts:22-108 - Single function spans 86 lines with 3 distinct phases: dependency hash comparison (lines 27-71), upstream absence propagation (lines 74-88), transitive staleness loop (lines 90-106)

### COR-5e3e2f8c — Path normalization mismatch during task file coverage validation

- Severity: medium
- Confidence: high
- Lens: correctness
- Category: logic-error
- Files: packages/audit-code/src/validation/auditResults.ts, packages/audit-code/src/validation/auditResults.ts, packages/audit-code/src/validation/auditResults.ts
- Summary: In validateAuditResults, declaredAssignedCoveragePaths stores raw, unnormalized metadata paths, which are then compared directly against normalized path strings in affected_files checks, leading to false validation failures on Windows or mismatched path formats.
- Evidence:
  - packages/audit-code/src/validation/auditResults.ts:738-740 - declaredAssignedCoveragePaths.add(canonicalPath ?? entryNorm) adds raw task file paths, which may be unnormalized.
  - packages/audit-code/src/validation/auditResults.ts:850-851 - Checks declaredAssignedCoveragePaths.has(affectedPathNorm) where affectedPathNorm is normalized, causing mismatch.
  - packages/audit-code/src/validation/auditResults.ts:868 - coversAffectedSpan(normalizedFileCoverage, affectedPathNorm, ...) compares unnormalized canonicalPath with normalized affectedPathNorm, causing mismatch.

### REL-0c49633f — Percent-encoded characters in URL pathname cause spawnSync failures

- Severity: medium
- Confidence: high
- Lens: reliability
- Category: command-execution
- Files: .codex/hooks/session-start.test.mjs
- Summary: Using new URL(..., import.meta.url).pathname directly to get HOOK_PATH will preserve percent-encoded characters if the directory name contains spaces or special characters. Passing this encoded path to spawnSync causes file-not-found failures on environments where paths have spaces.
- Evidence:
  - .codex/hooks/session-start.test.mjs:6-9 - HOOK_PATH uses .pathname which is percent-encoded. Under node, fileURLToPath from node:url should be used to properly convert file URLs to paths.

### MNT-3cc3b849 — prepareDispatchArtifacts is excessively long (345 lines)

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: function-length
- Files: packages/audit-code/src/cli/dispatch.ts
- Summary: prepareDispatchArtifacts in dispatch.ts spans 345 lines (724-1069) and handles multiple concerns: loading bundle state, building review packets, extracting file anchors, writing dispatch plans, computing quotas, collecting warnings, and returning results. This violates single responsibility and makes the function hard to test, reason about, or change safely.
- Evidence:
  - packages/audit-code/src/cli/dispatch.ts:724-1069 - The function is 345 lines with no clear decomposition; it performs bundle loading (749), task building (751-758), schema writing (769), anchor extraction (901-903), dispatch plan writing (957-962), quota computation (974-983), warning collection (985-1005), and active dispatch state writing (1034)

### OBS-e0de82a4 — Provider Launch Failure Bypasses Completion Telemetry

- Severity: medium
- Confidence: high
- Lens: observability
- Category: telemetry-gap
- Files: packages/audit-code/src/providers/opencodeProvider.ts
- Summary: In OpenCodeProvider, if spawnLoggedCommand throws an error, the function rejects immediately and fails to log the structured provider_done event to stderr.
- Evidence:
  - packages/audit-code/src/providers/opencodeProvider.ts:29 - spawnLoggedCommand is called without a try/catch block, preventing the provider_done log on line 39 from executing if an error is thrown.

### OBS-d574efd7 — Quota state corruption silently resets to empty state

- Severity: medium
- Confidence: high
- Lens: observability
- Category: silent-error-suppression
- Files: packages/shared/src/quota/state.ts
- Summary: In readQuotaState(), when the file is unreadable (non-ENOENT errors), the code logs to stderr and silently returns an empty state. This means a corrupted quota-state.json causes all learned quota data to be silently discarded on that read, with only a single stderr message that may go unnoticed.
- Evidence:
  - packages/shared/src/quota/state.ts:66-79 - On invalid JSON or parse failure (code != ENOENT), writes one line to process.stderr then returns { version: 2, entries: {} }, discarding all learned rate-limit history silently

### OPR-aec9c7ae — Release script has no non-mutating preview mode

- Severity: medium
- Confidence: high
- Lens: operability
- Category: missing-dry-run
- Files: packages/audit-code/scripts/release-and-publish.mjs, packages/audit-code/scripts/release-and-publish.mjs
- Summary: The release script performs local version mutation, git commit/tag creation, pushes, and GitHub Release creation on its normal path, but it only exposes --bump-only as an alternate mode. Operators cannot preview the exact release actions without mutating the worktree or publishing path.
- Evidence:
  - packages/audit-code/scripts/release-and-publish.mjs:13 - The only alternate release flag is --bump-only; there is no --dry-run or plan mode.
  - packages/audit-code/scripts/release-and-publish.mjs:246 - The main function runs release gate, bumps and tags the package, pushes branch and tag, then creates the GitHub Release.

### OPR-29e4fc2a — Release script lacks dry-run or preview mode for destructive operations

- Severity: medium
- Confidence: high
- Lens: operability
- Category: missing-dry-run
- Files: packages/audit-code/scripts/release-and-publish.mjs
- Summary: The release script performs version mutation, git commit/tag creation, pushes, GitHub Release creation, and triggers the publish workflow on its normal path, but only exposes --bump-only as an alternate mode. Operators cannot preview the full release pipeline without mutating the worktree or triggering a publish.
- Evidence:
  - packages/audit-code/scripts/release-and-publish.mjs:13 - The only alternate release flag is --bump-only; there is no --dry-run or --plan mode.
  - packages/audit-code/scripts/release-and-publish.mjs:246 - The main function immediately runs verify:release (or skips it), then bumps, tags, pushes, creates GitHub Release, and waits for publish workflow completion with no preview path.

### CFG-1c5c3d00 — Release script runs publish pipeline without human approval gate

- Severity: medium
- Confidence: high
- Lens: config_deployment
- Category: unguarded-package-publish
- Files: packages/audit-code/scripts/release-and-publish.mjs
- Summary: The release-and-publish script performs the entire release pipeline — version bump, git commit, tag, push, GitHub Release creation — and then triggers the npm publish workflow, all without a human confirmation step or protected environment. An operator running the script has no chance to verify the pending release before pushes and the publish trigger are sent.
- Evidence:
  - packages/audit-code/scripts/release-and-publish.mjs:254-261 - ensureCleanWorktree and ensureMainBranch are programmatic gates but do not pause for human approval.
  - packages/audit-code/scripts/release-and-publish.mjs:270-271 - verify:release runs if not pre-verified, then immediately proceeds to bump and publish.
  - packages/audit-code/scripts/release-and-publish.mjs:279-283 - git push and git push --tags run with no confirmation prompt.
  - packages/audit-code/scripts/release-and-publish.mjs:286 - gh release create runs and immediately triggers the publish workflow with no approval step between creation and publish.

### COR-870ff293 — releaseLock does not handle transient Windows filesystem errors during readFile or unlink

- Severity: medium
- Confidence: high
- Lens: correctness
- Category: error-handling
- Files: packages/shared/src/quota/fileLock.ts
- Summary: releaseLock in fileLock.ts does not catch or retry on transient Windows filesystem errors (such as EACCES or EPERM) during readFile or unlink. Because releaseLock runs inside a withFileLock finally block, a transient release failure will throw and abort the caller's transaction.
- Evidence:
  - packages/shared/src/quota/fileLock.ts:74-86 - releaseLock function only ignores ENOENT errors and will throw on any other errors such as EACCES/EPERM.

### MNT-e2bbee08 — Repetitive if-block pattern for per-language formatter selection in autoFixExecutor

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: duplicated_logic
- Files: packages/audit-code/src/orchestrator/autoFixExecutor.ts
- Summary: The runAutoFixExecutor function uses four nearly identical if-blocks to dispatch formatters by language extension (Prettier, Black, sqlfluff, gofmt). Each block checks an extension, defines tool candidates inline, and calls runFormatter. A configuration map would eliminate the repetition.
- Evidence:
  - packages/audit-code/src/orchestrator/autoFixExecutor.ts:106-128 - Prettier block with 14-line boolean condition and 3 fallback candidates
  - packages/audit-code/src/orchestrator/autoFixExecutor.ts:132-138 - Black block with 4 fallback candidates, same pattern
  - packages/audit-code/src/orchestrator/autoFixExecutor.ts:141-148 - sqlfluff block with 3 fallback candidates, same pattern
  - packages/audit-code/src/orchestrator/autoFixExecutor.ts:150-155 - gofmt block with 1 candidate, same pattern

### MNT-e0a36ad7 — Repetitive obligation pattern in deriveAuditState

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/audit-code/src/orchestrator/state.ts
- Summary: deriveAuditState in state.ts (216 lines) repeats the same obligation construction pattern ~10 times with only name and dependency list varying between calls. Each obligation() call wrapped in staleOrSatisfied() with a manually listed dependency array could be driven from a declarative configuration table.
- Evidence:
  - packages/audit-code/src/orchestrator/state.ts:35-50 - Obligation for repo_manifest and file_disposition follow identical pattern
  - packages/audit-code/src/orchestrator/state.ts:61-70 - syntax_resolved obligation repeats same structure
  - packages/audit-code/src/orchestrator/state.ts:95-115 - graph_enrichment_current and design_assessment_current repeat pattern
  - packages/audit-code/src/orchestrator/state.ts:205-224 - synthesis obligations repeat pattern

### MNT-e2564b39 — reviewPacketGraph.ts exceeds 900 lines combining multiple graph planning concerns

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: excessive-file-length
- Files: packages/audit-code/src/orchestrator/reviewPacketGraph.ts
- Summary: At 993 lines, reviewPacketGraph.ts conflates graph-edge collection, degree indexing, packet-expansion filtering, UnionFind-based component analysis, three clustering strategies (subsystem, package-ownership, module-ownership), entrypoint-flow bridge building, and packet-graph context assembly. Each cluster type is a distinct domain that could be a separate module.
- Evidence:
  - packages/audit-code/src/orchestrator/reviewPacketGraph.ts:1-993 - Single file containing 15+ public functions: collectGraphEdges, buildGraphDegreeIndex, isPacketExpansionEdge, unionFindFromGroups, buildBoundedClusterEdges, buildSubsystemClusterEdges, buildPackageOwnershipClusterEdges, buildModuleOwnershipClusterEdges, buildEntrypointFlowBridgeEdges, buildPlanningGraphEdges, buildPacketGraphContext, and more.

### ARC-70bcf944 — Risk concentrated in top quartile of units

- Severity: medium
- Confidence: high
- Lens: architecture
- Category: risk_concentration
- Files: .codex/hooks/session-start.sh, .codex/hooks/session-start.test.mjs, packages/audit-code/.audit-artifacts/active-dispatch.json, packages/audit-code/.audit-artifacts/artifact_metadata.json, packages/audit-code/.audit-artifacts/audit_plan_metrics.json, packages/audit-code/.audit-artifacts/audit_state.json, packages/audit-code/.audit-artifacts/audit_tasks.json, packages/audit-code/.audit-artifacts/auto_fixes_applied.json, packages/audit-code/.audit-artifacts/coverage_matrix.json, packages/audit-code/.audit-artifacts/critical_flows.json, packages/audit-code/.audit-artifacts/design_assessment.json, packages/audit-code/.audit-artifacts/dispatch/audit-result.schema.json, packages/audit-code/.audit-artifacts/dispatch/audit-results.schema.json, packages/audit-code/.audit-artifacts/dispatch/current-single-task.json, packages/audit-code/.audit-artifacts/dispatch/current-task.json, packages/audit-code/.audit-artifacts/dispatch/current-tasks.json, packages/audit-code/.audit-artifacts/dispatch/finding.schema.json, packages/audit-code/.audit-artifacts/external_analyzer_results.json, packages/audit-code/.audit-artifacts/file_disposition.json, packages/audit-code/.audit-artifacts/flow_coverage.json, packages/audit-code/.audit-artifacts/graph_bundle.json, packages/audit-code/.audit-artifacts/operator-handoff.json, packages/audit-code/.audit-artifacts/repo_manifest.json, packages/audit-code/.audit-artifacts/requeue_tasks.json, packages/audit-code/.audit-artifacts/review_packets.json, packages/audit-code/.audit-artifacts/risk_register.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/dispatch-plan.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/dispatch-quota.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/dispatch-result-map.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/dispatch-warnings.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/pending-audit-tasks.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/status.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-gemini-commands_maintainability_c43cd2c0fc74.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-gemini-commands_observability_1ac1795ddef7.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-gemini-commands_tests_60cb9627e146.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-github-workflows_config_deployment_20e7cbb0e074.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-github-workflows_operability_d8353879b2f9.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-github-workflows_reliability_8fe21bc237bc.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-tmp-opentoken_config_deployment_a1d548ed2e7d.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-tmp-opentoken_correctness_part-1_9f06ecc6f652.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-tmp-opentoken_correctness_part-10_6426e25f84be.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-tmp-opentoken_correctness_part-11_4b3753a9b340.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-tmp-opentoken_correctness_part-9_6119301de9a7.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-tmp-opentoken_data_integrity_0662f2996804.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-tmp-opentoken_maintainability_part-1_60850b9cfac8.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-tmp-opentoken_maintainability_part-9_5c5bf435dd77.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-tmp-opentoken_observability_part-1_6e0a05b04c45.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-tmp-opentoken_observability_part-10_d9f6bf8009b7.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-tmp-opentoken_operability_4e688d93f732.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-tmp-opentoken_performance_adce44c901d7.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-tmp-opentoken_reliability_f4de22fbe164.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/-tmp-opentoken_tests_part-9_31a4b9f3ce6c.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/Codeauditor-lambda-audit-artifacts_correctness_d46201245396.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/dispatch_correctness_ae0181b73589.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/dispatch_maintainability_bee5088f1ffb.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/dispatch_observability_c793d60902a2.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/dispatch_tests_89add911d1cf.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/flow_flow_data_-tmp-opentoken--opencode-opentoken-config-schema-json_reliability_b4a5c2303dc0.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/flow_flow_data_-tmp-opentoken-opentoken--opencode-opentoken-config-schema-json_r_ec988d70a128.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/flow_flow_surface_-gemini-commands-audit-code-toml_correctness_32b1ce1a8123.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/flow_flow_surface_skills-audit-code-opencode-command-template-txt_correctness_6d52725063eb.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/flow_flow_surface_src-cli-ts_correctness_3f73ccd6a67b.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/flow_flow_surface_src-orchestrator-localCommands-ts_correctness_0a25236ea6d2.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/flow_flow_surface_src-orchestrator-requeueCommand-ts_correctness_e2c9dfdf6aaa.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/flow_flow_surface_src-providers-spawnLoggedCommand-ts_correctness_9dde49d78d10.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/flow_flow_surface_src-types-workerSession-ts_reliability_part-1_417a0deee4a3.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/flow_flow_surface_src-types-workerSession-ts_reliability_part-2_7435e6dc3c1e.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/flow_flow_surface_src-types-workerSession-ts_reliability_part-3_7423faf4ff70.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/flow_flow_surface_src-types-workerSession-ts_security_part-1_b6a8239214e4.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/flow_flow_surface_src-types-workerSession-ts_security_part-2_13d504c331b5.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/module-audit-code-mjs_correctness_ed6bf77ffaac.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/module-audit-code-mjs_maintainability_498cd1345358.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/module-audit-code-mjs_observability_9e816065064f.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/module-audit-code-mjs_tests_4c5ee0371662.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/module-audit-code-wrapper-lib-mjs_correctness_fbb41a3f0127.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/module-audit-code-wrapper-lib-mjs_maintainability_ae39ab0f98ad.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/module-audit-code-wrapper-lib-mjs_observability_cb5beb7fdcfc.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/module-audit-code-wrapper-lib-mjs_tests_4077823060d5.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/root-config_correctness_33525053f6dc.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/root-config_maintainability_20ac2f64ae01.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/root-config_observability_5eead3c1f915.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/schemas_data_integrity_part-1_90252d94b2a4.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/schemas_data_integrity_part-2_003e83577b4d.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/scripts_config_deployment_42880ab3fe04.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/scripts_correctness_2cbbdfa2d940.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/scripts_operability_41164778d629.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/skills-audit-code_config_deployment_69f5bbfc396f.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/skills-audit-code_maintainability_ff603dc015b7.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/skills-audit-code_observability_7f49f1ecc389.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/skills-audit-code_operability_be25dd8c53d6.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/skills-audit-code_reliability_fab55b9a92f5.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/skills-audit-code_tests_6791a614a56e.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-adapters_correctness_9956734fc469.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-adapters_maintainability_9b611a94427b.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-adapters_observability_52d91e962a0c.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-adapters_tests_5ce945a5e633.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-cli-ts_maintainability_9c728ead27f8.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-cli-ts_observability_3d1881f2d38c.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-cli-ts_tests_28d7b60ab4db.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-coverage-ts_correctness_8fef834a9f82.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-coverage-ts_maintainability_a80d961955de.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-coverage-ts_observability_2f4cad37430d.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-coverage-ts_tests_5dab4ea6f0dd.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_correctness_part-1_2077707e0154.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_correctness_part-2_57699035f4f8.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_correctness_part-3_ec84cf881d98.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_maintainability_part-1_26121e8756c4.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_maintainability_part-2_8963d829d695.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_maintainability_part-3_368d31263963.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_observability_part-1_b566b351d5dc.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_observability_part-2_3bf4c5164011.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_observability_part-3_1f6437890d0e.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_tests_part-1_acdc92091692.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_tests_part-2_81ce137ba1e2.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_tests_part-3_323b56aa194d.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-index-ts_correctness_9ca55091f0eb.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-index-ts_maintainability_7ffb4145deb6.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-index-ts_observability_597270b7ad7e.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-index-ts_tests_7d2317c4462b.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-io_correctness_fd7862ab2743.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-io_maintainability_be6039c5d4e2.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-io_observability_19573aca2329.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-io_tests_eb0e591337ac.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-mcp_correctness_a2ecd5efccf6.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-mcp_maintainability_d39fe3c33f96.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-mcp_observability_495cec676ebd.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-orchestrator_correctness_part-1_4009d4e70d4e.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-orchestrator_correctness_part-2_e509a6a969fd.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-orchestrator_correctness_part-3_3ea02cacf662.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-orchestrator_maintainability_part-1_fc6466bd3e84.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-orchestrator_maintainability_part-2_b3e18aa0f925.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-orchestrator_maintainability_part-3_09916849aac3.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-orchestrator_tests_part-3_639757d2801c.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-orchestrator-ts_correctness_00d274969910.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-orchestrator-ts_maintainability_735a9dcd4b55.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-orchestrator-ts_observability_e9fa1717f6f3.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-prompts_correctness_3ed82434db78.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-prompts_performance_8ebd5ce27ff5.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-prompts_tests_209348e77f0c.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-providers_correctness_b0bbcbc8d945.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-providers_maintainability_359f979a5fb0.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-providers_observability_eeeb668ef57a.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-providers_tests_72ad722f9b9b.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-quota_correctness_part-1_d45aa5d8dc9e.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-quota_correctness_part-2_adc29b6a6a32.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-quota_maintainability_part-1_42575bff0736.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-quota_maintainability_part-2_819f8c402c11.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-quota_observability_part-1_ef40940c6371.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-quota_observability_part-2_55e0cdcf34ec.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-quota_performance_4feb465ad31d.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-quota_tests_part-1_c45c269e54c2.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-quota_tests_part-2_4ea5974862ef.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-reporting_correctness_e8e049784fea.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-reporting_maintainability_dd4a047bc130.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-reporting_observability_0357926b8d15.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-reporting_tests_af740567136e.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-supervisor_correctness_cfa25a0a3190.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-supervisor_maintainability_6756ca817e65.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-supervisor_observability_45175a201904.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-supervisor_tests_785fd6a595b2.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-types_correctness_part-1_567bc81712e0.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-types_correctness_part-2_b615c32a3aa5.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-types_maintainability_9b09549ff681.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-types_observability_part-1_537fa24afa9e.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-types_observability_part-2_4122f0a8356a.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-types_performance_1243f8e5fa51.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-types_tests_part-1_dcea84cda542.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-types_tests_part-2_ac8a1a751556.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-validation_correctness_0d5ffd8778f6.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-validation_maintainability_c562d05b150b.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-validation_observability_3df03c32ea0a.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-validation_tests_236ada212774.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-audit-code-wrapper-test-mjs_maintainability_91ad44d4dd89.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-audit-code-wrapper-test-mjs_tests_1afcd18a18f6.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-field-trial-remediation-test-mjs_maintainability_49e93577c95a.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-field-trial-remediation-test-mjs_tests_44e5da1a2f34.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-helpers_correctness_acbb4def57ec.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-helpers_data_integrity_7c6ab57eb2f4.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-helpers_maintainability_7f4e86a11fa7.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-helpers_reliability_caeb7b058ae8.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-helpers_tests_d1c2a36e172a.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-json-schema-assert-test-mjs_correctness_371c441afe3c.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-json-schema-assert-test-mjs_data_integrity_b331dd8ba895.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-json-schema-assert-test-mjs_maintainability_a453fea9f888.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-json-schema-assert-test-mjs_reliability_0a16340dfd66.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-json-schema-assert-test-mjs_tests_d7288a0a165a.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-schema-contracts-test-mjs_correctness_64be1c0f0792.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-schema-contracts-test-mjs_data_integrity_313dbf74dbd4.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-schema-contracts-test-mjs_maintainability_37f2ca1b4a7b.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-schema-contracts-test-mjs_reliability_5560e4cb3a46.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-schema-contracts-test-mjs_tests_ab19689dd869.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-tiny-files_config_deployment_425c6a29f247.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-tiny-files_correctness_9b53d5bd525b.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-tiny-files_maintainability_part-1_8020c3871642.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-tiny-files_maintainability_part-2_ae3a7fac6969.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-tiny-files_observability_f904407e40b1.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-tiny-files_operability_ef87442ca0cc.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-tiny-files_performance_337eef2632d8.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-tiny-files_reliability_d4e0cc663b81.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/tests-tiny-files_tests_part-1_5cbb44505bf6.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task.json, packages/audit-code/.audit-artifacts/runtime_validation_report.json, packages/audit-code/.audit-artifacts/runtime_validation_tasks.json, packages/audit-code/.audit-artifacts/session-config.json, packages/audit-code/.audit-artifacts/steps/current-step.json, packages/audit-code/.audit-artifacts/surface_manifest.json, packages/audit-code/.audit-artifacts/syntax_resolution_status.json, packages/audit-code/.audit-artifacts/tooling_manifest.json, packages/audit-code/.audit-artifacts/unit_manifest.json, packages/audit-code/.gemini/commands/audit-code.toml, packages/audit-code/.gitignore, packages/audit-code/.opencode/.gitignore, packages/audit-code/.opencode/package.json, packages/audit-code/.remediation-artifacts/steps/current-step.json, packages/audit-code/.vscode/mcp.json, packages/audit-code/audit-code-wrapper-build.mjs, packages/audit-code/audit-code-wrapper-install-hosts.mjs, packages/audit-code/audit-code-wrapper-io.mjs, packages/audit-code/audit-code-wrapper-legacy.mjs, packages/audit-code/audit-code-wrapper-lib.mjs, packages/audit-code/audit-code-wrapper-opencode.mjs, packages/audit-code/audit-code.mjs, packages/audit-code/dispatch/lens-definitions.json, packages/audit-code/dispatch/merge-results.mjs, packages/audit-code/dispatch/validate-result.mjs, packages/audit-code/dispatch/validate.mjs, packages/audit-code/opencode.json, packages/audit-code/package.json, packages/audit-code/schemas/analyzer_capability.schema.json, packages/audit-code/schemas/audit_findings.schema.json, packages/audit-code/schemas/audit_plan_metrics.schema.json, packages/audit-code/schemas/audit_result.schema.json, packages/audit-code/schemas/audit_results.schema.json, packages/audit-code/schemas/audit_state.schema.json, packages/audit-code/schemas/audit_task.schema.json, packages/audit-code/schemas/audit-code-v1alpha1.schema.json, packages/audit-code/schemas/blind_spot_register.schema.json, packages/audit-code/schemas/coverage_matrix.schema.json, packages/audit-code/schemas/critical_flows.schema.json, packages/audit-code/schemas/dispatch_quota.schema.json, packages/audit-code/schemas/external_analyzer_results.schema.json, packages/audit-code/schemas/file_disposition.schema.json, packages/audit-code/schemas/finding.schema.json, packages/audit-code/schemas/flow_coverage.schema.json, packages/audit-code/schemas/graph_bundle.schema.json, packages/audit-code/schemas/lens.schema.json, packages/audit-code/schemas/repo_manifest.schema.json, packages/audit-code/schemas/review_packets.schema.json, packages/audit-code/schemas/risk_register.schema.json, packages/audit-code/schemas/runtime_validation_report.schema.json, packages/audit-code/schemas/runtime_validation_tasks.schema.json, packages/audit-code/schemas/scope.schema.json, packages/audit-code/schemas/step_contract.schema.json, packages/audit-code/schemas/surface_manifest.schema.json, packages/audit-code/schemas/unit_manifest.schema.json, packages/audit-code/scripts/postinstall.mjs, packages/audit-code/scripts/release-and-publish.mjs, packages/audit-code/scripts/smoke-linked-audit-code.mjs, packages/audit-code/scripts/smoke-packaged-audit-code.mjs, packages/audit-code/scripts/update-languages.mjs, packages/audit-code/skills/audit-code/agents/openai.yaml, packages/audit-code/skills/audit-code/opencode-command-template.txt, packages/audit-code/src/adapters/coverageSummary.ts, packages/audit-code/src/adapters/eslint.ts, packages/audit-code/src/adapters/normalizeExternal.ts, packages/audit-code/src/adapters/npmAudit.ts, packages/audit-code/src/adapters/semgrep.ts, packages/audit-code/src/cli.ts, packages/audit-code/src/cli/advanceAuditCommand.ts, packages/audit-code/src/cli/args.ts, packages/audit-code/src/cli/auditStep.ts, packages/audit-code/src/cli/cleanup.ts, packages/audit-code/src/cli/cleanupCommand.ts, packages/audit-code/src/cli/dispatch.ts, packages/audit-code/src/cli/dispatchStatusCommand.ts, packages/audit-code/src/cli/envelope.ts, packages/audit-code/src/cli/explainTaskCommand.ts, packages/audit-code/src/cli/importExternalAnalyzerCommand.ts, packages/audit-code/src/cli/ingestResultsCommand.ts, packages/audit-code/src/cli/intakeCommand.ts, packages/audit-code/src/cli/lineIndex.ts, packages/audit-code/src/cli/mergeAndIngestCommand.ts, packages/audit-code/src/cli/nextStepCommand.ts, packages/audit-code/src/cli/paths.ts, packages/audit-code/src/cli/planCommand.ts, packages/audit-code/src/cli/prepareDispatchCommand.ts, packages/audit-code/src/cli/prompts.ts, packages/audit-code/src/cli/quotaCommand.ts, packages/audit-code/src/cli/requeueCommand.ts, packages/audit-code/src/cli/resynthesizeCommand.ts, packages/audit-code/src/cli/reviewRun.ts, packages/audit-code/src/cli/runToCompletion.ts, packages/audit-code/src/cli/sampleRunCommand.ts, packages/audit-code/src/cli/semanticReviewStep.ts, packages/audit-code/src/cli/statusCommand.ts, packages/audit-code/src/cli/steps.ts, packages/audit-code/src/cli/submitPacketCommand.ts, packages/audit-code/src/cli/synthesizeCommand.ts, packages/audit-code/src/cli/updateRuntimeValidationCommand.ts, packages/audit-code/src/cli/validateCommand.ts, packages/audit-code/src/cli/validateResultCommand.ts, packages/audit-code/src/cli/validateResultsCommand.ts, packages/audit-code/src/cli/waveManifest.ts, packages/audit-code/src/cli/workerResult.ts, packages/audit-code/src/cli/workerRunCommand.ts, packages/audit-code/src/coverage.ts, packages/audit-code/src/extractors/analyzers/css.ts, packages/audit-code/src/extractors/analyzers/html.ts, packages/audit-code/src/extractors/analyzers/merge.ts, packages/audit-code/src/extractors/analyzers/python.ts, packages/audit-code/src/extractors/analyzers/registry.ts, packages/audit-code/src/extractors/analyzers/resourceUrl.ts, packages/audit-code/src/extractors/analyzers/sql.ts, packages/audit-code/src/extractors/analyzers/treeSitter.ts, packages/audit-code/src/extractors/analyzers/types.ts, packages/audit-code/src/extractors/analyzers/typescript.ts, packages/audit-code/src/extractors/browserExtension.ts, packages/audit-code/src/extractors/bucketing.ts, packages/audit-code/src/extractors/designAssessment.ts, packages/audit-code/src/extractors/disposition.ts, packages/audit-code/src/extractors/fileInventory.ts, packages/audit-code/src/extractors/flows.ts, packages/audit-code/src/extractors/fsIntake.ts, packages/audit-code/src/extractors/graph.ts, packages/audit-code/src/extractors/graphManifestEdges/cargo.ts, packages/audit-code/src/extractors/graphManifestEdges/go.ts, packages/audit-code/src/extractors/graphManifestEdges/index.ts, packages/audit-code/src/extractors/graphManifestEdges/jsonc.ts, packages/audit-code/src/extractors/graphManifestEdges/maven.ts, packages/audit-code/src/extractors/graphManifestEdges/packageJson.ts, packages/audit-code/src/extractors/graphManifestEdges/pnpm.ts, packages/audit-code/src/extractors/graphManifestEdges/pyproject.ts, packages/audit-code/src/extractors/graphManifestEdges/toml.ts, packages/audit-code/src/extractors/graphManifestEdges/typescript.ts, packages/audit-code/src/extractors/graphManifestEdges/workspace.ts, packages/audit-code/src/extractors/graphManifestEdges/yaml.ts, packages/audit-code/src/extractors/graphManifestEdges/yamlPaths.ts, packages/audit-code/src/extractors/graphPathUtils.ts, packages/audit-code/src/extractors/graphPythonImports.ts, packages/audit-code/src/extractors/graphRoutes.ts, packages/audit-code/src/extractors/graphSuites.ts, packages/audit-code/src/extractors/graphTestSources.ts, packages/audit-code/src/extractors/ignore.ts, packages/audit-code/src/extractors/pathPatterns.ts, packages/audit-code/src/extractors/risk.ts, packages/audit-code/src/extractors/surfaces.ts, packages/audit-code/src/index.ts, packages/audit-code/src/io/artifacts.ts, packages/audit-code/src/io/runArtifacts.ts, packages/audit-code/src/io/runArtifactTypes.ts, packages/audit-code/src/io/toolingManifest.ts, packages/audit-code/src/orchestrator.ts, packages/audit-code/src/orchestrator/advance.ts, packages/audit-code/src/orchestrator/artifactFreshness.ts, packages/audit-code/src/orchestrator/artifactMetadata.ts, packages/audit-code/src/orchestrator/auditTaskUtils.ts, packages/audit-code/src/orchestrator/autoFixExecutor.ts, packages/audit-code/src/orchestrator/chunking.ts, packages/audit-code/src/orchestrator/dependencyMap.ts, packages/audit-code/src/orchestrator/designReviewPrompt.ts, packages/audit-code/src/orchestrator/edgeReasoning.ts, packages/audit-code/src/orchestrator/executorResult.ts, packages/audit-code/src/orchestrator/executors.ts, packages/audit-code/src/orchestrator/fileAnchors.ts, packages/audit-code/src/orchestrator/fileIntegrity.ts, packages/audit-code/src/orchestrator/flowCoverage.ts, packages/audit-code/src/orchestrator/flowPlanning.ts, packages/audit-code/src/orchestrator/flowRequeue.ts, packages/audit-code/src/orchestrator/graphEnrichmentExecutor.ts, packages/audit-code/src/orchestrator/ingestionExecutors.ts, packages/audit-code/src/orchestrator/intakeExecutors.ts, packages/audit-code/src/orchestrator/intentCheckpointExecutor.ts, packages/audit-code/src/orchestrator/lensSelection.ts, packages/audit-code/src/orchestrator/localCommands.ts, packages/audit-code/src/orchestrator/nextStep.ts, packages/audit-code/src/orchestrator/planning.ts, packages/audit-code/src/orchestrator/planningExecutors.ts, packages/audit-code/src/orchestrator/requeue.ts, packages/audit-code/src/orchestrator/requeueCommand.ts, packages/audit-code/src/orchestrator/resultIngestion.ts, packages/audit-code/src/orchestrator/reviewPacketGraph.ts, packages/audit-code/src/orchestrator/reviewPackets.ts, packages/audit-code/src/orchestrator/reviewPacketSizing.ts, packages/audit-code/src/orchestrator/runtimeCommand.ts, packages/audit-code/src/orchestrator/runtimeValidation.ts, packages/audit-code/src/orchestrator/runtimeValidationUpdate.ts, packages/audit-code/src/orchestrator/scope.ts, packages/audit-code/src/orchestrator/selectiveDeepening.ts, packages/audit-code/src/orchestrator/selectiveDeepening/conflict.ts, packages/audit-code/src/orchestrator/selectiveDeepening/findingFollowup.ts, packages/audit-code/src/orchestrator/selectiveDeepening/highRiskClean.ts, packages/audit-code/src/orchestrator/selectiveDeepening/index.ts, packages/audit-code/src/orchestrator/selectiveDeepening/lensVerification.ts, packages/audit-code/src/orchestrator/selectiveDeepening/runtimeValidation.ts, packages/audit-code/src/orchestrator/selectiveDeepening/shared.ts, packages/audit-code/src/orchestrator/selectiveDeepening/stewardFollowup.ts, packages/audit-code/src/orchestrator/staleness.ts, packages/audit-code/src/orchestrator/state.ts, packages/audit-code/src/orchestrator/structureExecutors.ts, packages/audit-code/src/orchestrator/syntaxResolutionExecutor.ts, packages/audit-code/src/orchestrator/synthesisExecutors.ts, packages/audit-code/src/orchestrator/taskBuilder.ts, packages/audit-code/src/orchestrator/trivialAudit.ts, packages/audit-code/src/orchestrator/unionFind.ts, packages/audit-code/src/orchestrator/unitBuilder.ts, packages/audit-code/src/prompts/renderWorkerPrompt.ts, packages/audit-code/src/providers/claudeCodeProvider.ts, packages/audit-code/src/providers/constants.ts, packages/audit-code/src/providers/index.ts, packages/audit-code/src/providers/opencodeProvider.ts, packages/audit-code/src/quota/discoveredLimits.ts, packages/audit-code/src/quota/headerExtraction.ts, packages/audit-code/src/quota/headerExtractors/claudeCodeHeaderExtractor.ts, packages/audit-code/src/quota/headerExtractors/genericHeaderExtractor.ts, packages/audit-code/src/quota/headerExtractors/index.ts, packages/audit-code/src/quota/hostLimits.ts, packages/audit-code/src/quota/index.ts, packages/audit-code/src/reporting/findingIdentity.ts, packages/audit-code/src/reporting/findingRanks.ts, packages/audit-code/src/reporting/mergeFindings.ts, packages/audit-code/src/reporting/synthesis.ts, packages/audit-code/src/reporting/synthesisNarrativePrompt.ts, packages/audit-code/src/reporting/workBlocks.ts, packages/audit-code/src/supervisor/operatorHandoff.ts, packages/audit-code/src/supervisor/runLedger.ts, packages/audit-code/src/supervisor/sessionConfig.ts, packages/audit-code/src/types.ts, packages/audit-code/src/types/activeDispatch.ts, packages/audit-code/src/types/analyzerCapability.ts, packages/audit-code/src/types/artifactMetadata.ts, packages/audit-code/src/types/auditScope.ts, packages/audit-code/src/types/auditState.ts, packages/audit-code/src/types/designAssessment.ts, packages/audit-code/src/types/externalAnalyzer.ts, packages/audit-code/src/types/flowCoverage.ts, packages/audit-code/src/types/reviewPlanning.ts, packages/audit-code/src/types/runtimeValidation.ts, packages/audit-code/src/types/synthesisNarrative.ts, packages/audit-code/src/types/toolingManifest.ts, packages/audit-code/src/types/workerResult.ts, packages/audit-code/src/types/workerSession.ts, packages/audit-code/src/validation/artifacts.ts, packages/audit-code/src/validation/auditResults.ts, packages/audit-code/src/validation/sessionConfig.ts, packages/audit-code/tests/adapters-remediation.test.mjs, packages/audit-code/tests/advance-error-paths.test.mjs, packages/audit-code/tests/analyzer-seam.test.mjs, packages/audit-code/tests/audit-code-completion.test.mjs, packages/audit-code/tests/audit-code-lifecycle.test.mjs, packages/audit-code/tests/audit-code-wrapper.test.mjs, packages/audit-code/tests/audit-task-utils.test.mjs, packages/audit-code/tests/auto-fix-executor-timings.test.mjs, packages/audit-code/tests/auto-fix-executor.test.mjs, packages/audit-code/tests/browser-extension-utils.test.mjs, packages/audit-code/tests/capture-console.test.mjs, packages/audit-code/tests/chunking.test.mjs, packages/audit-code/tests/cleanup.test.mjs, packages/audit-code/tests/cli-args-utils.test.mjs, packages/audit-code/tests/cli-dispatcher.test.mjs, packages/audit-code/tests/cli-remediation.test.mjs, packages/audit-code/tests/command-rendering.test.mjs, packages/audit-code/tests/config-error-handling.test.mjs, packages/audit-code/tests/coverage.test.mjs, packages/audit-code/tests/design-assessment.test.mjs, packages/audit-code/tests/design-review-budget.test.mjs, packages/audit-code/tests/discovered-limits.test.mjs, packages/audit-code/tests/dispatch-fanout.test.mjs, packages/audit-code/tests/dispatch-features.test.mjs, packages/audit-code/tests/dispatch-helpers.test.mjs, packages/audit-code/tests/dispatch-model-hint.test.mjs, packages/audit-code/tests/dispatch-prompt.test.mjs, packages/audit-code/tests/dispatch-quota-constants.test.mjs, packages/audit-code/tests/dispatch-scripts.test.mjs, packages/audit-code/tests/dispatch-validate.test.mjs, packages/audit-code/tests/edge-reasoning.test.mjs, packages/audit-code/tests/entrypoint-contract.test.mjs, packages/audit-code/tests/envelope.test.mjs, packages/audit-code/tests/executor-registry-sync.test.mjs, packages/audit-code/tests/extractors-remediation.test.mjs, packages/audit-code/tests/field-trial-remediation.test.mjs, packages/audit-code/tests/file-anchors.test.mjs, packages/audit-code/tests/file-inventory-language.test.mjs, packages/audit-code/tests/finalization-convergence.test.mjs, packages/audit-code/tests/finalization-cycle-guard.test.mjs, packages/audit-code/tests/finding-identity.test.mjs, packages/audit-code/tests/finding-ranks.test.mjs, packages/audit-code/tests/fixture-repo.test.mjs, packages/audit-code/tests/flow-coverage.test.mjs, packages/audit-code/tests/flow-planning.test.mjs, packages/audit-code/tests/fs-intake.test.mjs, packages/audit-code/tests/graph-enrichment-observability.test.mjs, packages/audit-code/tests/graph-framework-routes.test.mjs, packages/audit-code/tests/graph-heuristic-edges.test.mjs, packages/audit-code/tests/graph-manifest-edges.test.mjs, packages/audit-code/tests/graph-path-utils.test.mjs, packages/audit-code/tests/graph-python-imports.test.mjs, packages/audit-code/tests/graph-test-sources.test.mjs, packages/audit-code/tests/header-extraction.test.mjs, packages/audit-code/tests/helpers-withTempDir.test.mjs, packages/audit-code/tests/helpers/auditSchemaRegistry.mjs, packages/audit-code/tests/helpers/captureConsole.mjs, packages/audit-code/tests/helpers/countLines.mjs, packages/audit-code/tests/helpers/fixture.mjs, packages/audit-code/tests/helpers/jsonSchemaAssert.mjs, packages/audit-code/tests/helpers/provider-assisted-bridge.mjs, packages/audit-code/tests/helpers/run-wrapper.mjs, packages/audit-code/tests/helpers/sourceImport.mjs, packages/audit-code/tests/helpers/synthetic-results.mjs, packages/audit-code/tests/helpers/validate.mjs, packages/audit-code/tests/helpers/withTempDir.mjs, packages/audit-code/tests/host-bootstrap-descriptors.test.mjs, packages/audit-code/tests/intake-scope-summary.test.mjs, packages/audit-code/tests/io-remediation.test.mjs, packages/audit-code/tests/json-schema-assert.test.mjs, packages/audit-code/tests/lens-guard.test.mjs, packages/audit-code/tests/lens-selection.test.mjs, packages/audit-code/tests/line-index.test.mjs, packages/audit-code/tests/local-commands-resolve.test.mjs, packages/audit-code/tests/merge-findings-dedup.test.mjs, packages/audit-code/tests/next-step-edge-reasoning.test.mjs, packages/audit-code/tests/next-step-helpers.test.mjs, packages/audit-code/tests/next-step-narrative.test.mjs, packages/audit-code/tests/next-step.test.mjs, packages/audit-code/tests/observability-signals.test.mjs, packages/audit-code/tests/orchestration.test.mjs, packages/audit-code/tests/orchestrator-remediation.test.mjs, packages/audit-code/tests/orchestrator.test.mjs, packages/audit-code/tests/planning-executors.test.mjs, packages/audit-code/tests/postinstall-contract.test.mjs, packages/audit-code/tests/priority-chain-doc-sync.test.mjs, packages/audit-code/tests/prompt-invocation.test.mjs, packages/audit-code/tests/provider-assisted-bridge.test.mjs, packages/audit-code/tests/provider-assisted-continuation.test.mjs, packages/audit-code/tests/provider-auto-resolution.test.mjs, packages/audit-code/tests/providers-remediation.test.mjs, packages/audit-code/tests/python-logical-lines.test.mjs, packages/audit-code/tests/quota-error-parsers.test.mjs, packages/audit-code/tests/quota-error-parsing.test.mjs, packages/audit-code/tests/quota-file-lock.test.mjs, packages/audit-code/tests/quota-limits.test.mjs, packages/audit-code/tests/quota-packets.test.mjs, packages/audit-code/tests/quota-scheduler.test.mjs, packages/audit-code/tests/quota-sliding-window.test.mjs, packages/audit-code/tests/quota-source.test.mjs, packages/audit-code/tests/release-contract.test.mjs, packages/audit-code/tests/render-dispatch-review-prompt.test.mjs, packages/audit-code/tests/render-worker-prompt.test.mjs, packages/audit-code/tests/reporting-remediation.test.mjs, packages/audit-code/tests/resource-url.test.mjs, packages/audit-code/tests/result-ingestion.test.mjs, packages/audit-code/tests/resynthesize-command.test.mjs, packages/audit-code/tests/review-packets.test.mjs, packages/audit-code/tests/review-run-lifecycle.test.mjs, packages/audit-code/tests/run-artifacts-logging.test.mjs, packages/audit-code/tests/run-ledger.test.mjs, packages/audit-code/tests/run-to-completion-guards.test.mjs, packages/audit-code/tests/runtime-command.test.mjs, packages/audit-code/tests/runtime-validation-merge.test.mjs, packages/audit-code/tests/runtime-validation-update.test.mjs, packages/audit-code/tests/schema-contracts.test.mjs, packages/audit-code/tests/scope.test.mjs, packages/audit-code/tests/semantic-review-step.test.mjs, packages/audit-code/tests/session-start-hook.test.mjs, packages/audit-code/tests/staleness.test.mjs, packages/audit-code/tests/state-budget-obligation.test.mjs, packages/audit-code/tests/status-command.test.mjs, packages/audit-code/tests/steps-write-current-step.test.mjs, packages/audit-code/tests/submit-packet-command.test.mjs, packages/audit-code/tests/supervisor-remediation.test.mjs, packages/audit-code/tests/syntax-resolution.test.mjs, packages/audit-code/tests/synthesis-budget.test.mjs, packages/audit-code/tests/synthesis-narrative-prompt.test.mjs, packages/audit-code/tests/synthesis-narrative.test.mjs, packages/audit-code/tests/tree-sitter-analyzers.test.mjs, packages/audit-code/tests/tree-sitter-language-cache.test.mjs, packages/audit-code/tests/trivial-audit.test.mjs, packages/audit-code/tests/typescript-analyzer.test.mjs, packages/audit-code/tests/union-find.test.mjs, packages/audit-code/tests/validate-command.test.mjs, packages/audit-code/tests/validation-remediation.test.mjs, packages/audit-code/tests/wave-manifest.test.mjs, packages/audit-code/tests/within-root.test.mjs, packages/audit-code/tests/work-blocks.test.mjs, packages/audit-code/tests/worker-result.test.mjs, packages/audit-code/tests/worker-run-command-write-failure.test.mjs, packages/audit-code/tests/worker-run-command.test.mjs, packages/audit-code/tests/working-directory-prompts.test.mjs, packages/audit-code/tsconfig.json, packages/remediate-code/.gitignore, packages/remediate-code/.opencode/.gitignore, packages/remediate-code/.opencode/package.json, packages/remediate-code/.smoke-tmp/remediate-code-smoke-4sXp3q/install/package.json, packages/remediate-code/.smoke-tmp/remediate-code-smoke-4sXp3q/npm-cache/_cacache/content-v2/sha512/29/c3/042eb3238182b69c2f8d4f205570838715fed50c09d67d11a20e980f7ef22fdabed497b043479856f7ea8755c0423dabee893253419267002cf5d493bb3a, packages/remediate-code/.smoke-tmp/remediate-code-smoke-4sXp3q/npm-cache/_cacache/index-v5/b2/c7/c86481ccd7b7d7756369c1bed8912fbabc87dfe278c09175b6630214ce3c, packages/remediate-code/.smoke-tmp/remediate-code-smoke-4sXp3q/npm-cache/_cacache/index-v5/c9/10/07121c98f70effee06b108eb7220cb5ac80081c21a8e14701b583a23e530, packages/remediate-code/.smoke-tmp/remediate-code-smoke-4sXp3q/npm-cache/_cacache/index-v5/e0/99/06c864ebf7d361f2978e27c9e0bfa9b3ae46062ab51c653cca1a7816a938, packages/remediate-code/.smoke-tmp/remediate-code-smoke-4sXp3q/npm-cache/_update-notifier-last-checked, packages/remediate-code/.vscode/mcp.json, packages/remediate-code/opencode.json, packages/remediate-code/package.json, packages/remediate-code/remediate-code.mjs, packages/remediate-code/remediator-lambda-0.1.4.tgz, packages/remediate-code/remediator-lambda-0.3.5.tgz, packages/remediate-code/schemas/clarification_request.schema.json, packages/remediate-code/schemas/closing_plan.schema.json, packages/remediate-code/schemas/closing_result.schema.json, packages/remediate-code/schemas/contract_pipeline.schema.json, packages/remediate-code/schemas/dispatch_plan.schema.json, packages/remediate-code/schemas/dispatch_quota.schema.json, packages/remediate-code/schemas/finding.schema.json, packages/remediate-code/schemas/item_spec.schema.json, packages/remediate-code/schemas/remediation_block.schema.json, packages/remediate-code/schemas/remediation_outcomes.schema.json, packages/remediate-code/schemas/remediation_plan.schema.json, packages/remediate-code/schemas/remediation_report.schema.json, packages/remediate-code/schemas/shared.schema.json, packages/remediate-code/schemas/step.schema.json, packages/remediate-code/schemas/test_spec.schema.json, packages/remediate-code/schemas/triage_batch.schema.json, packages/remediate-code/schemas/verification_result.schema.json, packages/remediate-code/schemas/worker_result.schema.json, packages/remediate-code/scripts/generate-auditor-contract-fixture.mjs, packages/remediate-code/scripts/postinstall.mjs, packages/remediate-code/scripts/release-and-publish.mjs, packages/remediate-code/scripts/smoke-linked-remediate-code.mjs, packages/remediate-code/scripts/smoke-packaged-remediate-code.mjs, packages/remediate-code/skills/remediate-code/agents/openai.yaml, packages/remediate-code/src/contractPipeline/artifactStore.ts, packages/remediate-code/src/dedup/crossLensDedup.ts, packages/remediate-code/src/index.ts, packages/remediate-code/src/intake.ts, packages/remediate-code/src/phases/close.ts, packages/remediate-code/src/phases/constants.ts, packages/remediate-code/src/phases/document.ts, packages/remediate-code/src/phases/implement.ts, packages/remediate-code/src/phases/plan.ts, packages/remediate-code/src/phases/triage.ts, packages/remediate-code/src/phases/workerTasks.ts, packages/remediate-code/src/providers/claudeCodeProvider.ts, packages/remediate-code/src/providers/constants.ts, packages/remediate-code/src/providers/index.ts, packages/remediate-code/src/providers/opencodeProvider.ts, packages/remediate-code/src/quota/hostLimits.ts, packages/remediate-code/src/quota/index.ts, packages/remediate-code/src/state/closingActions.ts, packages/remediate-code/src/state/store.ts, packages/remediate-code/src/state/types.ts, packages/remediate-code/src/steps/contractPipeline.ts, packages/remediate-code/src/steps/contractPipelinePrompts.ts, packages/remediate-code/src/steps/dispatch.ts, packages/remediate-code/src/steps/intakeResolver.ts, packages/remediate-code/src/steps/nextStep.ts, packages/remediate-code/src/steps/prompts.ts, packages/remediate-code/src/steps/stepUtils.ts, packages/remediate-code/src/steps/stepWriter.ts, packages/remediate-code/src/steps/types.ts, packages/remediate-code/src/steps/waveScheduler.ts, packages/remediate-code/src/types/options.ts, packages/remediate-code/src/types/workerSession.ts, packages/remediate-code/src/utils/commands.ts, packages/remediate-code/src/utils/fileIntegrity.ts, packages/remediate-code/src/validation/artifacts.ts, packages/remediate-code/src/validation/contractPipeline.ts, packages/remediate-code/src/validation/remediationState.ts, packages/remediate-code/tests/artifacts-validation.test.ts, packages/remediate-code/tests/classify-finding-risk.test.ts, packages/remediate-code/tests/command-rendering.test.ts, packages/remediate-code/tests/contract-pipeline-artifact-store.test.ts, packages/remediate-code/tests/contract-pipeline-prompts.test.ts, packages/remediate-code/tests/contract-pipeline.test.ts, packages/remediate-code/tests/cross-lens-dedup.test.ts, packages/remediate-code/tests/dispatch-conventions.test.ts, packages/remediate-code/tests/dispatch-model-hints.test.ts, packages/remediate-code/tests/dispatch-reconciliation.test.ts, packages/remediate-code/tests/file-integrity.test.ts, packages/remediate-code/tests/install-repo-assets.test.ts, packages/remediate-code/tests/intake-resolver.test.ts, packages/remediate-code/tests/io.test.ts, packages/remediate-code/tests/model-hints.test.ts, packages/remediate-code/tests/next-step.test.ts, packages/remediate-code/tests/phase-close.test.ts, packages/remediate-code/tests/phase-document.test.ts, packages/remediate-code/tests/phase-implement.test.ts, packages/remediate-code/tests/phase-plan-parse.test.ts, packages/remediate-code/tests/phase-plan-test-graph.test.ts, packages/remediate-code/tests/phase-plan.test.ts, packages/remediate-code/tests/phase-triage.test.ts, packages/remediate-code/tests/postinstall.test.ts, packages/remediate-code/tests/providers.test.ts, packages/remediate-code/tests/quota-error-parsers.test.ts, packages/remediate-code/tests/quota-error-parsing.test.ts, packages/remediate-code/tests/quota-file-lock.test.ts, packages/remediate-code/tests/quota-scheduler.test.ts, packages/remediate-code/tests/quota-sliding-window.test.ts, packages/remediate-code/tests/quota-source.test.ts, packages/remediate-code/tests/remediate-code.test.ts, packages/remediate-code/tests/remediation-coverage.json, packages/remediate-code/tests/remediation-outcomes.json, packages/remediate-code/tests/remediation-outcomes.test.ts, packages/remediate-code/tests/remediation-report.json, packages/remediate-code/tests/schema-contracts.test.ts, packages/remediate-code/tests/spec-no-change.test.ts, packages/remediate-code/tests/step-utils.test.ts, packages/remediate-code/tests/store.test.ts, packages/remediate-code/tests/test-helpers.ts, packages/remediate-code/tests/validation.test.ts, packages/remediate-code/tests/wave-scheduler.test.ts, packages/remediate-code/tests/working-directory-prompts.test.ts, packages/remediate-code/tsconfig.json, packages/remediate-code/vitest.config.ts, packages/shared/package.json, packages/shared/scripts/release-and-publish.mjs, packages/shared/src/contracts.ts, packages/shared/src/git.ts, packages/shared/src/index.ts, packages/shared/src/io/json.ts, packages/shared/src/observability/runLog.ts, packages/shared/src/parsing/stringAwareScanner.ts, packages/shared/src/prompts.ts, packages/shared/src/providers/codexProvider.ts, packages/shared/src/providers/constants.ts, packages/shared/src/providers/localSubprocessProvider.ts, packages/shared/src/providers/opencodeLaunch.ts, packages/shared/src/providers/providerFactory.ts, packages/shared/src/providers/spawnLoggedCommand.ts, packages/shared/src/providers/subprocessTemplateProvider.ts, packages/shared/src/providers/types.ts, packages/shared/src/providers/workerTaskLaunch.ts, packages/shared/src/quota/capacity.ts, packages/shared/src/quota/compositeQuotaSource.ts, packages/shared/src/quota/errorParsers/claudeCodeErrorParser.ts, packages/shared/src/quota/errorParsers/genericErrorParser.ts, packages/shared/src/quota/errorParsers/index.ts, packages/shared/src/quota/errorParsing.ts, packages/shared/src/quota/fileLock.ts, packages/shared/src/quota/hostLimits.ts, packages/shared/src/quota/learnedQuotaSource.ts, packages/shared/src/quota/limits.ts, packages/shared/src/quota/quotaSource.ts, packages/shared/src/quota/scheduler.ts, packages/shared/src/quota/slidingWindow.ts, packages/shared/src/quota/state.ts, packages/shared/src/quota/types.ts, packages/shared/src/tokens.ts, packages/shared/src/tooling/analyzerDeps.ts, packages/shared/src/tooling/exec.ts, packages/shared/src/tooling/repoConventions.ts, packages/shared/src/tooling/testCommand.ts, packages/shared/src/types/accessDeclaration.ts, packages/shared/src/types/contractPipeline.ts, packages/shared/src/types/disposition.ts, packages/shared/src/types/finding.ts, packages/shared/src/types/flows.ts, packages/shared/src/types/graph.ts, packages/shared/src/types/intentCheckpoint.ts, packages/shared/src/types/lens.ts, packages/shared/src/types/remediationOutcome.ts, packages/shared/src/types/risk.ts, packages/shared/src/types/runLedger.ts, packages/shared/src/types/sessionConfig.ts, packages/shared/src/types/stepContract.ts, packages/shared/src/types/surfaces.ts, packages/shared/src/validation/basic.ts, packages/shared/tests/analyzerDeps.test.mjs, packages/shared/tests/capacity.test.mjs, packages/shared/tests/codex-antigravity-providers.test.mjs, packages/shared/tests/compositeQuotaSource.test.mjs, packages/shared/tests/errorParsing.test.mjs, packages/shared/tests/exec.test.mjs, packages/shared/tests/fileLock.test.mjs, packages/shared/tests/git.test.mjs, packages/shared/tests/io-json-ndjson.test.mjs, packages/shared/tests/io-json-retry.test.mjs, packages/shared/tests/learnedQuotaSource.test.mjs, packages/shared/tests/opencode-launch.test.mjs, packages/shared/tests/prefixValidationIssues.test.mjs, packages/shared/tests/quota-state.test.mjs, packages/shared/tests/repoConventions.test.mjs, packages/shared/tests/runLog.test.mjs, packages/shared/tests/runtimeConstants.test.mjs, packages/shared/tests/scheduler.test.mjs, packages/shared/tests/sliding-window-property.test.mjs, packages/shared/tests/spawnLoggedCommand.test.mjs, packages/shared/tests/string-aware-scanner.test.mjs, packages/shared/tests/subprocessTemplateProvider.test.mjs, packages/shared/tests/testCommand.test.mjs, packages/shared/tests/tokens.test.mjs, packages/shared/tests/validation-basic.test.mjs, packages/shared/tests/vscode-task-provider.test.mjs, packages/shared/tests/worker-task-launch.test.mjs, packages/shared/tsconfig.json, packages/shared/tsconfig.tsbuildinfo
- Summary: 67% of total risk score is concentrated in the top 4 of 13 units: -codex-hooks, packages-audit-code, packages-remediate-code, packages-shared. Consider decomposing high-risk units or adding isolation boundaries.

### OBS-77319328 — run() error messages lack command output context

- Severity: medium
- Confidence: high
- Lens: observability
- Category: error-reporting-context
- Files: packages/audit-code/audit-code-wrapper-lib.mjs
- Summary: When a spawned child process fails without capture mode (the default for commands like validate, next-step, etc.), the error only reports the exit code with no stdout or stderr output. Even with capture mode, stdout is discarded on error. This forces operators to manually re-run failing commands to see diagnostic output.
- Evidence:
  - packages/audit-code/audit-code-wrapper-lib.mjs:110 - Error message 'Command failed with exit code ${code}.' omits command output
  - packages/audit-code/audit-code-wrapper-lib.mjs:96-101 - stdout is accumulated but discarded on error; only stderr is included when capture=true

### OBS-094d17cf — runCli catch handler discards stack traces and uses unstructured console.error

- Severity: medium
- Confidence: high
- Lens: observability
- Category: error-reporting
- Files: packages/audit-code/src/cli.ts
- Summary: The top-level error handler in cli.ts uses console.error with only error.message, discarding the stack trace. For production diagnostics, structured error output with stack context and run correlation would improve debuggability.
- Evidence:
  - packages/audit-code/src/cli.ts:156 - catch handler uses error.message not error.stack via console.error

### MNT-3a1a4244 — runParallelWaveStep mixes quota, scheduling, launch, ingestion, and error reporting

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: function-responsibility
- Files: packages/audit-code/src/cli/runToCompletion.ts
- Summary: runParallelWaveStep (~227 lines) handles quota state reading, wave scheduling, cooldown waiting, slot building, worker launching, result ingestion, quota recording, error handling, and envelope emission — violating single responsibility principle.
- Evidence:
  - packages/audit-code/src/cli/runToCompletion.ts:1093-1319 - Function spans quota checks, cooldown, building slots, launching, ingesting, and error emission
  - packages/audit-code/src/cli/runToCompletion.ts:1130-1168 - Quota/scheduling logic (readQuotaState, buildQuotaSource, scheduleWave)
  - packages/audit-code/src/cli/runToCompletion.ts:1184-1192 - Slot building via buildParallelWaveSlots
  - packages/audit-code/src/cli/runToCompletion.ts:1204-1236 - Worker launching via runSlidingWindow

### MNT-52afa354 — runPlanningExecutor length (136 lines) combines too many stages

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: excessive-function-length
- Files: packages/audit-code/src/orchestrator/planningExecutors.ts
- Summary: runPlanningExecutor (planningExecutors.ts:23-159) is a 136-line function that sequentially runs coverage initialization, scope application, flow coverage, runtime validation discovery, task building, requeue payload construction, dedup/merge, review packet building, and metrics building. Each stage could be a composed step rather than one monolithic function.
- Evidence:
  - packages/audit-code/src/orchestrator/planningExecutors.ts:23-159 - Entire function body with ~8 sequential stages

### MNT-06e4a393 — runResultIngestionExecutor length (109 lines) mixes multiple update concerns

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: excessive-function-length
- Files: packages/audit-code/src/orchestrator/ingestionExecutors.ts
- Summary: runResultIngestionExecutor (ingestionExecutors.ts:113-221) is 109 lines that update the coverage matrix, rebuild flow coverage, reconstruct runtime validation tasks, merge validation reports, apply selective deepening, build requeue payloads, dedupe pending tasks, and recompute plan metrics. The bundle is mutated through several intermediate states (baseUpdatedBundle, selectiveDeepening, finalBundle) within one function.
- Evidence:
  - packages/audit-code/src/orchestrator/ingestionExecutors.ts:113-221 - Full function body with six stages of bundle transformation

### MNT-88e63198 — runToCompletion.ts exceeds 1600 lines with multiple excessively long functions

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: excessive-module-size
- Files: packages/audit-code/src/cli/runToCompletion.ts
- Summary: runToCompletion.ts is 1629 lines with several functions exceeding 100 lines (runParallelWaveStep ~227, cmdRunToCompletion ~248, runSingleWorkerStep ~193), making the module difficult to navigate, understand, and change safely.
- Evidence:
  - packages/audit-code/src/cli/runToCompletion.ts:1093 - runParallelWaveStep is ~227 lines handling quota, scheduling, launch, ingestion, and error reporting
  - packages/audit-code/src/cli/runToCompletion.ts:1381 - cmdRunToCompletion is ~248 lines with complex loop control flow and 6 mutable state variables
  - packages/audit-code/src/cli/runToCompletion.ts:690 - runSingleWorkerStep is ~193 lines covering task construction, launch, and result processing

### MNT-e7ada589 — Same root cause reported across passes without cross-reference or merging

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: audit/audit-findings.json, audit/audit-findings.json, audit/audit-findings.json
- Summary: The 'duplicated config permission block' issue is reported three times independently: line 888 (opencode.json top-level vs agent.auditor), line 1341 (packages/audit-code/opencode.json specific), and line 3852 (packages/remediate-code/opencode.json agent.remediator). Each adds marginal detail but no cross-reference links them, making it impossible to gauge the total scope or track remediation holistically.
- Evidence:
  - audit/audit-findings.json:888-906 - MNT-002 bash permission block duplicated verbatim under agent.auditor (opencode.json)
  - audit/audit-findings.json:1341-1364 - MNT-002 Duplicate bash permission block in opencode.json between top-level and agent.auditor
  - audit/audit-findings.json:3852-3874 - MNT-007 Bash permission rules duplicated between top-level and agent.remediator in opencode.json

### SEC-b501a621 — Shell-based PATH lookup in commandExists creates unnecessary injection surface

- Severity: medium
- Confidence: high
- Lens: security
- Category: command-execution
- Files: packages/audit-code/src/validation/sessionConfig.ts
- Summary: commandExists uses exec (shell) with string interpolation for PATH lookups instead of execFile or a direct PATH search. Prior validation via isSupportedConfiguredCommand gates against shell metacharacters, but the shell-based call remains an unnecessary risk surface — any bypass of the character filter would expose shell injection. Downgraded from original high severity because the validation gates (isBareExecutableName, containsForbiddenCommandSyntax) prevent practical exploitation.
- Evidence:
  - packages/audit-code/src/validation/sessionConfig.ts:178 - execAsync is called with shell command string interpolation: `${lookupCommand} ${command}`
  - packages/audit-code/src/validation/sessionConfig.ts:208-216 - isBareExecutableName gates against whitespace, slashes, and forbidden characters before commandExists is reached
  - packages/audit-code/src/validation/sessionConfig.ts:226-232 - isSupportedConfiguredCommand provides the outer validation gate

### OBS-01971b40 — Silent error swallowing in quota command

- Severity: medium
- Confidence: high
- Lens: observability
- Category: missing-error-logging
- Files: packages/audit-code/src/cli/quotaCommand.ts
- Summary: quotaCommand.ts uses .catch(() => null) and .catch(() => ({})) to discard errors from quota state reads and quota source queries without any logging, making quota source failures, storage corruption, or network errors invisible.
- Evidence:
  - packages/audit-code/src/cli/quotaCommand.ts:34 - readQuotaState().catch(...) silently returns empty state on error
  - packages/audit-code/src/cli/quotaCommand.ts:45 - quotaSource.queryCurrentUsage().catch(() => null) discards errors
  - packages/audit-code/src/cli/quotaCommand.ts:46 - lookupDiscoveredLimits().catch(() => null) discards errors

### MNT-74f84bb0 — Single flat 10040-line JSON mixes 390 findings across 9 lenses without grouping

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: excessive-module-length
- Files: audit/audit-findings.json
- Summary: The file is a flat array of 390 findings from 9 lenses (maintainability 121, tests 133, observability 65, correctness 23, etc.) with no structural separation. Reviewing or updating findings for a single lens requires reading the entire 10040-line file and filtering entries by the lens field. A maintainability reviewer must skip 269 non-maintainability entries.
- Evidence:
  - audit/audit-findings.json:13-27 - lens_breakdown lists 9 lenses merged in a single file with no section boundaries
  - audit/audit-findings.json:159 - DA-002 architecture finding interleaved between maintainability findings
  - audit/audit-findings.json:1367 - COR-001 correctness finding appears between maintainability findings
  - audit/audit-findings.json:3878 - OBS-001 observability finding appears between maintainability findings

### OBS-8d5ecbf8 — Spawn Failures Not Written to Session Stderr Logs

- Severity: medium
- Confidence: high
- Lens: observability
- Category: missing-logging
- Files: packages/shared/src/providers/spawnLoggedCommand.ts, packages/shared/src/providers/spawnLoggedCommand.ts
- Summary: When a provider session times out and is terminated (via SIGTERM/SIGKILL), the event is rejected via promise rejection but is not written to the session's stderr log file, leaving no traceback or tombstone indicating timeout.
- Evidence:
  - packages/shared/src/providers/spawnLoggedCommand.ts:108-114 - fail() rejects the promise with the spawn error but does not write any error description or stack trace to this.stderrLog.
  - packages/shared/src/providers/spawnLoggedCommand.ts:128-136 - When timedOut is true, the controller rejects the promise but does not log a timeout warning to this.stderrLog before settling.

### COR-a9f5638a — Spurious temporary, generated, and duplicate files tracked in repository manifest

- Severity: medium
- Confidence: high
- Lens: correctness
- Category: incorrect-file-coverage
- Files: packages/audit-code/.audit-artifacts/repo_manifest.json
- Summary: The repository manifest incorrectly indexes temporary directories (.tmp/, .remediation-artifacts/, .opencode/) and duplicate nested folder structures due to an incomplete default ignore list and lack of gitignore integration.
- Evidence:
  - packages/audit-code/.audit-artifacts/repo_manifest.json:73 - .remediation-artifacts/steps/current-prompt.md is tracked
  - packages/audit-code/.audit-artifacts/repo_manifest.json:323 - .tmp/opentoken/.opencode/plugins/opentoken/utils/cache.ts is tracked
  - packages/audit-code/.audit-artifacts/repo_manifest.json:393 - duplicate nested folder .tmp/opentoken/opentoken/ is tracked
  - packages/audit-code/.audit-artifacts/repo_manifest.json:1193 - .tmp/search-pending.mjs is tracked

### TST-c785923a — syntax-resolution.test.mjs tsc parse-error test is fragile on non-Unix platforms

- Severity: medium
- Confidence: high
- Lens: tests
- Category: non-deterministic-test
- Files: packages/audit-code/tests/syntax-resolution.test.mjs
- Summary: The tsc parse-error test (lines 221-267) creates a fake tsc binary with a #!/usr/bin/env node shebang script that cannot execute on Windows. The test acknowledges this with a conditional-skip comment on lines 263-265, causing the core assertions for root, exit_code, and timestamp to be silently skipped on Windows without any indication.
- Evidence:
  - packages/audit-code/tests/syntax-resolution.test.mjs:228-235 - fake tsc written with #!/usr/bin/env node shebang
  - packages/audit-code/tests/syntax-resolution.test.mjs:263-265 - conditional skip comment: 'If the fake tsc binary wasn't resolved (e.g. no exec bit on Windows) the parse-error branch may not fire — skip assertion rather than fail.'

### COR-b4233406 — Tasks reference non-existent .tmp build artifact paths

- Severity: medium
- Confidence: high
- Lens: correctness
- Category: invalid-path
- Files: packages/audit-code/.audit-artifacts/requeue_tasks.json
- Summary: 183 correctness tasks reference files under .tmp/ directories that do not exist in the repository. These are likely build artifacts that should have been excluded from the audit backlog.
- Evidence:
  - packages/audit-code/.audit-artifacts/requeue_tasks.json:2590 - .tmp/opentoken/.opencode/plugins/opentoken/utils/cache.ts does not exist
  - 183 of 326 correctness tasks reference .tmp/ paths that do not exist on disk

### TST-d432360f — Tests resolve @audit-tools/shared imports from compiled dist/ rather than source

- Severity: medium
- Confidence: high
- Lens: tests
- Category: stale-build
- Files: packages/remediate-code/tests/validation.test.ts, packages/remediate-code/tests/validation.test.ts, packages/remediate-code/tests/wave-scheduler.test.ts
- Summary: Multiple tests import from `@audit-tools/shared` which resolves to `dist/index.js` per the package.json exports map. This means tests compile against the pre-built dist/, not the current source. If source is modified without rebuilding, tests silently pass against stale code. Only relative `../src/` imports (e.g. `../src/validation/remediationState.js`, `../src/steps/waveScheduler.js`) guarantee source-level correctness.
- Evidence:
  - packages/shared/package.json:9 - exports['.'] points to './dist/index.js'
  - packages/remediate-code/tests/validation.test.ts:18 - imports createValidationIssue, describeValue, formatValidationIssues from '@audit-tools/shared'
  - packages/remediate-code/tests/validation.test.ts:300-312 - imports CONTRACT_PIPELINE_*_VERSION constants from '@audit-tools/shared'
  - packages/remediate-code/tests/wave-scheduler.test.ts:15-17 - imports CODEX_DESKTOP_ACTIVE_SUBAGENT_LIMIT, QuotaStateEntry from '@audit-tools/shared'

### OBS-425859fa — Transient I/O error retries proceed with no visibility into retry count or outcome

- Severity: medium
- Confidence: high
- Lens: observability
- Category: missing-telemetry
- Files: packages/shared/src/io/json.ts
- Summary: withFsRetry in io/json.ts performs up to 20 retries with exponential backoff on transient Windows lock errors (EPERM, EBUSY, EACCES, EEXIST) but emits zero logging during the retry cycle. Operators have no visibility into how many retries occurred, what delays were applied, or whether the operation recovered via retry or only failed after exhausting all attempts. The only signal is the final thrown error.
- Evidence:
  - packages/shared/src/io/json.ts:73-83 - The retry loop catches transient errors and silently retries with no log.warn or structured event emission
  - packages/shared/src/io/json.ts:76-78 - Catch block rethrows after exhausting attempts with no logging of retries attempted or cumulative delay

### MNT-4fef4d4f — Triplicated vendored file paths inflate dispatch file

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/audit-code/.audit-artifacts/dispatch/current-tasks.json
- Summary: The .tmp/opentoken/ directory content is included at three nested path variants (.tmp/opentoken/, .tmp/opentoken/opentoken/, .tmp/opentoken/.opencode/plugins/opentoken/), triplicating the same logical source files across tasks and adding ~3x JSON overhead that makes the dispatch file harder to review and maintain.
- Evidence:
  - packages/audit-code/.audit-artifacts/dispatch/current-tasks.json:175 - cache.ts at .tmp/opentoken/opentoken/src/utils/cache.ts
  - packages/audit-code/.audit-artifacts/dispatch/current-tasks.json:303 - cache.ts at .tmp/opentoken/src/utils/cache.ts
  - packages/audit-code/.audit-artifacts/dispatch/current-tasks.json:408 - cache.ts at .tmp/opentoken/.opencode/plugins/opentoken/utils/cache.ts

### COR-8779d235 — Unguarded fallback result write propagates unhandled rejection

- Severity: medium
- Confidence: high
- Lens: correctness
- Category: missing-error-handling
- Files: packages/audit-code/src/cli/workerRunCommand.ts
- Summary: workerRunCommand.ts:155 — when the initial writeJsonFile(result_path) fails, the catch block attempts a fallback write. If the fallback also fails, there is no try-catch around it, so the error propagates as an unhandled rejection from cmdWorkerRun. process.exitCode is never set and the intended degraded result is lost upstream.
- Evidence:
  - packages/audit-code/src/cli/workerRunCommand.ts:136-158 — The catch block at line 138 handles the initial write failure but line 155 (fallback write) has no guard; if writeJsonFile throws again, the error escapes unhandled.

### REL-f524ba6d — Unhandled Rejection in Fallback Persistence Block

- Severity: medium
- Confidence: high
- Lens: reliability
- Category: unhandled-promise-rejection
- Files: packages/audit-code/src/cli/workerRunCommand.ts
- Summary: In cli/workerRunCommand.ts, when the first attempt to write the workerResult fails, the fallback write of writeFailedResult is called without an enclosing try-catch. If the second write fails (e.g. due to persistent disk or permission issues), the error triggers an unhandled promise rejection.
- Evidence:
  - packages/audit-code/src/cli/workerRunCommand.ts:155 - await writeJsonFile(task.result_path, writeFailedResult) is called directly inside the catch block without any wrapper, meaning secondary write errors reject the main promise.

### ARC-64a1885c — Unnecessary Provider Duplication Across Packages

- Severity: medium
- Confidence: high
- Lens: architecture
- Category: architecture_pattern
- Files: packages/audit-code/src/providers/claudeCodeProvider.ts, packages/audit-code/src/providers/opencodeProvider.ts, packages/remediate-code/src/providers/claudeCodeProvider.ts, packages/remediate-code/src/providers/opencodeProvider.ts
- Summary: ClaudeCodeProvider and OpenCodeProvider are duplicated between packages/audit-code/src/providers/ and packages/remediate-code/src/providers/. While they have minor default configuration differences (like dangerously_skip_permissions defaults or prompt delivery mechanisms), they serve identical roles. Keeping them duplicated makes maintenance and bug fixes difficult (evidenced by the Windows command line length bug existing in audit-code's providers but not in remediate-code's). These providers should be moved to the shared library @audit-tools/shared/src/providers and configured with parameters to drive their package-specific defaults.

### MNT-ac254921 — validation-remediation.test.mjs is an 871-line monolith testing multiple concerns

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: excessive-module-length
- Files: packages/audit-code/tests/validation-remediation.test.mjs
- Summary: validation-remediation.test.mjs at 871 lines combines tests for artifact validation (validateArtifactBundle), audit result validation (validateAuditResults), and session config validation (validateSessionConfig / validateConfiguredProviderEnvironment) into a single file. Splitting by validation domain would reduce cognitive load and make targeted edits safer.
- Evidence:
  - packages/audit-code/tests/validation-remediation.test.mjs:53-183 - validateArtifactBundle tests
  - packages/audit-code/tests/validation-remediation.test.mjs:185-525 - validateAuditResults tests
  - packages/audit-code/tests/validation-remediation.test.mjs:527-871 - validateSessionConfig and validateConfiguredProviderEnvironment tests
  - packages/audit-code/tests/state-budget-obligation.test.mjs:264 - comparable single-domain test file for reference size

### MNT-54aa8b51 — Vendored .tmp code dilutes project graph signal by 2x

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: excessive-noise
- Files: packages/audit-code/.audit-artifacts/graph_bundle.json
- Summary: 469 of 956 import edges (49%) originate from or target the .tmp/opentoken/ vendored dependency tree across 4 directory copies, overwhelming the project's own structural signal.
- Evidence:
  - packages/audit-code/.audit-artifacts/graph_bundle.json:62 - First .tmp/opentoken edge; .tmp paths appear across ~469 entries.

### MNT-676d7e9e — Weak validation in isQuotaState allows null entries to cause TypeError crashes

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: missing-validation
- Files: packages/shared/src/quota/state.ts
- Summary: The isQuotaState type guard uses a loose typeof check for obj.entries that matches null, permitting corrupt or malformed state files to crash the orchestrator at runtime.
- Evidence:
  - packages/shared/src/quota/state.ts:54 - typeof obj["entries"] === "object" matches null, allowing invalid state to pass guard
  - packages/shared/src/quota/state.ts:64 - Object.values(parsed.entries) will throw TypeError if entries is null
  - packages/shared/src/quota/state.ts:83 - returns the state, allowing callers (like learnedQuotaSource.ts) to crash when accessing properties of entries

### DAT-b813ae78 — Worker results schema allows duplicate finding_id entries

- Severity: medium
- Confidence: high
- Lens: data_integrity
- Category: missing-uniqueness-validation
- Files: packages/remediate-code/schemas/worker_result.schema.json
- Summary: The worker_result.schema.json schema defines an item_results array of objects containing finding_id without enforcing uniqueness. Consequently, a worker result payload could contain duplicate results for the same finding_id, which can lead to double-counting, state corruption, or unexpected overwrite behavior in the orchestrator.
- Evidence:
  - packages/remediate-code/schemas/worker_result.schema.json:41 - item_results array is defined without uniqueness constraints on finding_id properties.

### MNT-f020b0c4 — WorkerTask object construction duplicated across three functions

- Severity: medium
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/audit-code/src/cli/runToCompletion.ts
- Summary: WorkerTask construction logic is nearly identical in buildParallelWaveSlots, runSingleWorkerStep, and handleLocalSubprocessBlock, violating DRY and creating multiple maintenance surface areas for contract_version, worker_command, and access policy changes.
- Evidence:
  - packages/audit-code/src/cli/runToCompletion.ts:179-197 - WorkerTask in buildParallelWaveSlots
  - packages/audit-code/src/cli/runToCompletion.ts:763-788 - WorkerTask in runSingleWorkerStep
  - packages/audit-code/src/cli/runToCompletion.ts:941-964 - WorkerTask in handleLocalSubprocessBlock

### ARC-6f37a71f — Dominant unit: packages-audit-code

- Severity: medium
- Confidence: medium
- Lens: architecture
- Category: monolith_unit
- Files: packages/audit-code/.audit-artifacts/active-dispatch.json, packages/audit-code/.audit-artifacts/artifact_metadata.json, packages/audit-code/.audit-artifacts/audit_plan_metrics.json, packages/audit-code/.audit-artifacts/audit_state.json, packages/audit-code/.audit-artifacts/audit_tasks.json, packages/audit-code/.audit-artifacts/auto_fixes_applied.json, packages/audit-code/.audit-artifacts/coverage_matrix.json, packages/audit-code/.audit-artifacts/critical_flows.json, packages/audit-code/.audit-artifacts/design_assessment.json, packages/audit-code/.audit-artifacts/dispatch/audit-result.schema.json
- Summary: Unit packages-audit-code contains 586 of 811 files (72%). A single unit this large suggests insufficient decomposition.

### OBS-b6240645 — Absolute paths in operator handoff persist state make runs non-portable

- Severity: low
- Confidence: high
- Lens: observability
- Category: logging-quality
- Files: packages/audit-code/.audit-artifacts/operator-handoff.json, packages/audit-code/.audit-artifacts/operator-handoff.json
- Summary: Persistence of absolute local machine paths (e.g. C:\\Code\\auditor-lambda\\.audit-artifacts) in operator-handoff.json limits execution portability. If a run is moved or resumed on a different machine or folder path, the absolute paths in the handoff state will be stale and incorrect, leading to potential failure or confusion.
- Evidence:
  - packages/audit-code/.audit-artifacts/operator-handoff.json:3 - 'repo_root' uses absolute path 'C:\\Code\\auditor-lambda'
  - packages/audit-code/.audit-artifacts/operator-handoff.json:32 - 'task_path' and other properties in active_review_run use absolute local paths.

### REL-6bb73c2b — acquireLock retry loop logs stale removal but not transient contention

- Severity: low
- Confidence: high
- Lens: reliability
- Category: inadequate-logging
- Files: packages/shared/src/quota/fileLock.ts
- Summary: The acquireLock retry loop logs stale lock removal but does not log transient EEXIST/EPERM/EACCES contention while waiting. Under high contention, operators have no visibility into retry duration or count, making it harder to diagnose performance issues or stuck acquisitions.
- Evidence:
  - packages/shared/src/quota/fileLock.ts:48 - EEXIST/EPERM/EACCES are silently retried
  - packages/shared/src/quota/fileLock.ts:57 - stale lock removal is logged
  - packages/shared/src/quota/fileLock.ts:66 - timeout error is logged
  - No logging of retry count or contention duration during normal waiting

### MNT-3d13f43b — agent executor case conflated with default fallthrough in advanceAudit

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: unclear_public_api
- Files: packages/audit-code/src/orchestrator/advance.ts
- Summary: The agent executor case at line 269 shares its block with default via fallthrough. An unrecognized executor and a legitimate host-delegation pause produce the same handoff, masking the distinction.
- Evidence:
  - packages/audit-code/src/orchestrator/advance.ts:269-270 - case "agent": falls through to default:
  - packages/audit-code/src/orchestrator/advance.ts:289-298 - return block says "selected but not yet dispatched" for both cases

### OBS-83cac0dc — All tasks stuck at pending with no staleness signal

- Severity: low
- Confidence: high
- Lens: observability
- Category: missing-observability
- Files: packages/audit-code/.audit-artifacts/dispatch/current-tasks.json
- Summary: Every task has status 'pending' with no timestamp to detect staleness; if dispatch stalls there is no observable signal.
- Evidence:
  - packages/audit-code/.audit-artifacts/dispatch/current-tasks.json:31 - All tasks have status 'pending' with no staleness metadata

### COR-7d79757a — Artifact status.json reports dispatched status for completed run

- Severity: low
- Confidence: high
- Lens: correctness
- Category: data-inconsistency
- Files: packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/status.json
- Summary: status.json contains status "dispatched" while the run directory and run_id both contain _audit_tasks_completed_001. A run that has finished dispatching should reflect a completed terminal status rather than an in-flight value, which could mislead downstream consumers about whether all tasks have finished.
- Evidence:
  - packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/status.json:3 - "status": "dispatched" while the run directory name includes _completed
  - packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/status.json:2 - run_id also ends with _audit_tasks_completed_001, creating a semantic mismatch

### MNT-f0706501 — Audit result artifacts duplicate file coverage metadata across passes

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: duplicated-data
- Files: packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-reporting_correctness_e8e049784fea.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-reporting_maintainability_dd4a047bc130.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-reporting_observability_0357926b8d15.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-reporting_tests_af740567136e.json
- Summary: The same source file paths (e.g., src/reporting/mergeFindings.ts) appear with identical total_lines in 4 separate result files. Updating a file's line count requires changes across many artifact files rather than referencing a canonical registry.
- Evidence:
  - src-reporting_correctness_e8e049784fea.json:6-18 - file_coverage lists mergeFindings.ts (355), synthesis.ts (170), workBlocks.ts (205)
  - src-reporting_maintainability_dd4a047bc130.json:6-18 - identical file_coverage entries for the same 3 files
  - src-reporting_observability_0357926b8d15.json:6-18 - identical file_coverage entries for the same 3 files
  - src-reporting_tests_af740567136e.json:6-18 - identical file_coverage entries for the same 3 files

### DAT-56bc2ac3 — Audit task schema lacks date-time format validation for completed_at

- Severity: low
- Confidence: high
- Lens: data_integrity
- Category: missing-validation
- Files: packages/audit-code/schemas/audit_task.schema.json
- Summary: The completed_at field in audit_task.schema.json is defined as a string without the date-time format constraint. Consequently, malformed date-time strings can bypass schema validation, potentially leading to inconsistencies when parsed by downstream systems expecting ISO-8601 timestamps.
- Evidence:
  - packages/audit-code/schemas/audit_task.schema.json:68 - 'completed_at' property specifies type 'string' but lacks the 'format': 'date-time' constraint.

### DAT-1c70cb98 — audit_plan_metrics.schema.json generated_at missing date-time format

- Severity: low
- Confidence: high
- Lens: data_integrity
- Category: inconsistent-field-naming
- Files: packages/audit-code/schemas/audit_plan_metrics.schema.json
- Summary: audit_plan_metrics.schema.json declares generated_at as plain string without format: date-time, unlike repo_manifest.schema.json which applies date-time format to the same-named field. Plan metrics timestamps have no parseability guarantee.
- Evidence:
  - packages/audit-code/schemas/audit_plan_metrics.schema.json:27 - generated_at: { type: 'string' } without format
  - packages/audit-code/schemas/repo_manifest.schema.json:18 - repo_manifest uses format: date-time for generated_at

### TST-5be73597 — buildAuditFindingsReport and normalizeExistingFindingsReport untested

- Severity: low
- Confidence: high
- Lens: tests
- Category: missing-tests
- Files: packages/audit-code/src/reporting/synthesis.ts, packages/audit-code/src/reporting/synthesis.ts
- Summary: buildAuditFindingsReport (synthesis.ts:191-202) wraps the model in the canonical contract format and normalizeExistingFindingsReport (synthesis.ts:394-408) re-derives summary fields — both lack direct test coverage despite being part of the public reporting API.
- Evidence:
  - packages/audit-code/tests/reporting-remediation.test.mjs: only imports buildAuditReportModel and renderAuditReportMarkdown
  - packages/audit-code/tests/synthesis-narrative-prompt.test.mjs: does not call buildAuditFindingsReport or normalizeExistingFindingsReport

### MNT-544b0f3a — buildDispatchModelHint has excessive conditional complexity

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: cyclomatic-complexity
- Files: packages/audit-code/src/cli/dispatch.ts
- Summary: buildDispatchModelHint in dispatch.ts:219-272 contains 8+ separate conditional branches with nested checks to determine model tier (deep/standard/small). The precedence between branches is implicit and hard to reason about, making future changes error-prone.
- Evidence:
  - packages/audit-code/src/cli/dispatch.ts:219-272 - The function has deep-reasons accumulation (5 sub-checks at lines 221-243), followed by a sensitive-lens / small-packet check (lines 248-261), followed by a standard-tier fallback (lines 262-271). A packet could match multiple tiers and the function returns on the first match, which is implicit

### OBS-bd30a2e5 — Bypass of Configured Logging in File Integrity I/O Error Reporting

- Severity: low
- Confidence: high
- Lens: observability
- Category: logging-bypass
- Files: packages/remediate-code/src/utils/fileIntegrity.ts
- Summary: The file integrity component directly writes I/O warnings as JSON to process.stderr, bypassing the configured RunLogger system and its settings (such as enablement, log path, and correlation IDs).
- Evidence:
  - packages/remediate-code/src/utils/fileIntegrity.ts:19-32 - reportHashIoError uses process.stderr.write(JSON.stringify({...}) + '\n') directly instead of passing the error event to a RunLogger instance.

### TST-55fe67e6 — captureConsole helper does not capture console.warn, requiring manual patching across test files

- Severity: low
- Confidence: high
- Lens: tests
- Category: test-fragility
- Files: packages/audit-code/tests/helpers/captureConsole.mjs
- Summary: The shared captureConsole.mjs helper only patches console.log and console.error but omits console.warn. This forces fs-intake.test.mjs and graph-enrichment-observability.test.mjs to independently implement nearly identical manual console.warn patching with try/finally guards, duplicating a pattern that should be centralized.
- Evidence:
  - packages/audit-code/tests/helpers/captureConsole.mjs:11-12 - Only saves/restores console.log and console.error
  - packages/audit-code/tests/fs-intake.test.mjs:26-30 - Manual console.warn override with t.after() cleanup
  - packages/audit-code/tests/graph-enrichment-observability.test.mjs:46-56 - Independent withWarnCapture() helper with its own console.warn patching

### TST-e1aa5f48 — CLI validation test runs against stale build

- Severity: low
- Confidence: high
- Lens: tests
- Category: stale-build
- Files: packages/audit-code/tests/validate-command.test.mjs
- Summary: validate-command.test.mjs imports compiled CLI logic from dist/ instead of TS source, risking false passes on stale compiled artifacts.
- Evidence:
  - packages/audit-code/tests/validate-command.test.mjs:11 - const distCliUrl = pathToFileURL(join(repoRoot, "dist", "cli.js")).href;
  - packages/audit-code/tests/validate-command.test.mjs:17 - join(repoRoot, "dist", "cli.js"),

### MNT-baf3b580 — console.error patching pattern repeated across six logging tests in analyzerDeps.test.mjs

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: duplicated-test-infrastructure
- Files: packages/shared/tests/analyzerDeps.test.mjs, packages/shared/tests/analyzerDeps.test.mjs, packages/shared/tests/analyzerDeps.test.mjs, packages/shared/tests/analyzerDeps.test.mjs, packages/shared/tests/analyzerDeps.test.mjs, packages/shared/tests/analyzerDeps.test.mjs, packages/shared/tests/analyzerDeps.test.mjs
- Summary: Six tests in analyzerDeps.test.mjs duplicate the same console.error capture/patch/restore boilerplate (capture array, store original, patch in try/finally, search for expected log lines). A shared helper would reduce the risk of inconsistent patching if the logging mechanism changes.
- Evidence:
  - packages/shared/tests/analyzerDeps.test.mjs:264 - logs.push + console.error patch block starts the first logging test.
  - packages/shared/tests/analyzerDeps.test.mjs:292 - identical console.error patching starts again for npm non-zero exit logging.
  - packages/shared/tests/analyzerDeps.test.mjs:309 - third repetition of the same patch/restore pattern.
  - packages/shared/tests/analyzerDeps.test.mjs:326 - fourth repetition.
  - packages/shared/tests/analyzerDeps.test.mjs:343 - fifth repetition.
  - packages/shared/tests/analyzerDeps.test.mjs:363 - sixth repetition.
  - packages/shared/tests/analyzerDeps.test.mjs:383 - seventh repetition.

### MNT-c935abb2 — Current single-task dispatch duplicates file entries across mirrored source trees

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/audit-code/.audit-artifacts/dispatch/current-single-task.json
- Summary: dispatch/current-single-task.json lists the same 5 source files 3 times each (under .tmp/opentoken/, .tmp/opentoken/opentoken/, and .tmp/opentoken/src/ prefixes) inflating the file to 48 lines. This triplication adds maintenance overhead when paths change.
- Evidence:
  - packages/audit-code/.audit-artifacts/dispatch/current-single-task.json:6-22 - session.ts, secrets.ts, session-store.ts, tokens.ts each appear 3 times

### MNT-e42b3f2f — Custom stable JSON serialization duplicates standard library solution

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: inconsistent_abstraction
- Files: packages/audit-code/src/orchestrator/artifactFreshness.ts
- Summary: artifactFreshness.ts implements a custom stableStringify that recursively sorts object keys. This duplicates the well-known fast-json-stable-stringify library. The custom implementation must be maintained for edge cases that a vended library already handles.
- Evidence:
  - packages/audit-code/src/orchestrator/artifactFreshness.ts:4-18 - full custom stable stringify implementation with recursive key sorting and undefined filtering
  - packages/audit-code/src/orchestrator/artifactMetadata.ts:11 - imported and used for dependency-revision comparison in computeArtifactMetadata

### MNT-4a64f623 — Custom temporary directory creation helper in test file

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: code-duplication
- Files: packages/audit-code/tests/worker-run-command.test.mjs
- Summary: The test file worker-run-command.test.mjs defines its own custom temporary directory creation and cleanup helper (makeTempDir) instead of sharing a single, unified utility like withTempDir from tests/helpers/withTempDir.mjs.
- Evidence:
  - packages/audit-code/tests/worker-run-command.test.mjs:14 - makeTempDir helper replicates mkdtemp/rm logic.

### MNT-6c6133d3 — Data duplication across task entries

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: data-duplication
- Files: packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/pending-audit-tasks.json
- Summary: The same file paths with identical file_line_counts appear repeatedly across different task entries (e.g., cache.ts:86, bun.lock:323). This duplication inflates the file ~3-5x over a normalized representation and creates consistency risk if line counts change in one place but not another.
- Evidence:
  - packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/pending-audit-tasks.json:175 - cache.ts path reference
  - packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/pending-audit-tasks.json:198 - identical cache.ts:86 line count
  - packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/pending-audit-tasks.json:303 - same cache.ts path reappears
  - packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/pending-audit-tasks.json:408 - same pattern with different tmp path prefix
  - packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/pending-audit-tasks.json:447 - bun.lock:323 first appearance

### MNT-5d2e2aff — Deeply nested conditionals in extractAnalyzerOwnershipEdges

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: excessive-nesting
- Files: packages/audit-code/src/extractors/graph.ts
- Summary: extractAnalyzerOwnershipEdges (graph.ts:174-244) has 4+ levels of nested conditionals within triple-nested loops (for each root, for each path, inner guard), making the logic hard to follow.
- Evidence:
  - packages/audit-code/src/extractors/graph.ts:174-244 - nested for-of loops with continue guards at lines 183-189, 191-194, 196-199, 210-224

### MNT-92e161d1 — detectMisScopeSmells has duplicated directory-traversal while loops

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/audit-code/src/orchestrator/intakeExecutors.ts, packages/audit-code/src/orchestrator/intakeExecutors.ts
- Summary: detectMisScopeSmells (intakeExecutors.ts:31-81) contains two while loops (lines 36-47 and 58-77) that both walk up the directory tree from root to ancestor with near-identical patterns (current/previous tracking, dirname/join, break conditions). The git-boundary check at line 71 exists in only one loop, creating an inconsistency risk.
- Evidence:
  - packages/audit-code/src/orchestrator/intakeExecutors.ts:36-47 - First while loop: ancestor git-repo detection
  - packages/audit-code/src/orchestrator/intakeExecutors.ts:58-77 - Second while loop: workspace-member detection with same traversal pattern

### COR-034b1149 — dispatch-result-map contains machine-local result paths from a different host

- Severity: low
- Confidence: high
- Lens: correctness
- Category: stale-reference
- Files: packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/dispatch-result-map.json
- Summary: All result_path entries in dispatch-result-map.json reference C:\Code\auditor-lambda\ paths from the prior audit's execution environment. These absolute paths do not resolve on the current host (C:\Code\audit-tools\), making the map unusable for locating result files without manual path rewriting.
- Evidence:
  - packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/dispatch-result-map.json:8 - result_path: "C:\Code\auditor-lambda\.audit-artifacts\runs\..." references a different project root
  - packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/dispatch-result-map.json:103 - src-types_correctness_part-1 result also points to C:\Code\auditor-lambda\

### MNT-357c24c3 — Duplicate evidence truncation logic in runCommand

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: duplicated-code
- Files: packages/audit-code/src/orchestrator/runtimeCommand.ts
- Summary: The evidence array construction with truncation at 10 lines is duplicated in the error handler (lines 53-57) and the close handler (lines 71-74) of runCommand. Any change to the truncation threshold or format must be kept in sync across both branches.
- Evidence:
  - packages/audit-code/src/orchestrator/runtimeCommand.ts:53-57 - error handler: const truncated = lines.length > 10; const evidence = truncated ? [...]
  - packages/audit-code/src/orchestrator/runtimeCommand.ts:71-74 - close handler: identical truncation logic

### MNT-b26da9be — Duplicated cross-validation iteration patterns in artifacts.ts

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/audit-code/src/validation/artifacts.ts
- Summary: Cross-validation loops for coverage_matrix (lines 231-242) and file_disposition (lines 244-257) are structurally identical: iterate repoPaths, test Set membership, pushIssue. This copy-paste pattern increases maintenance cost when validation rules change.
- Evidence:
  - packages/audit-code/src/validation/artifacts.ts:231-242 - Coverage matrix cross-check: iterate repoPaths, check coveragePaths Set, pushIssue
  - packages/audit-code/src/validation/artifacts.ts:244-257 - File disposition cross-check: iterate repoPaths, check dispositionPaths Set, pushIssue

### MNT-7ca3f932 — Duplicated default limits configuration fallback logic

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/shared/src/quota/limits.ts, packages/shared/src/quota/scheduler.ts
- Summary: The default limits configuration (context_tokens fallback of 32,000 and output_tokens fallback of 4,096) is duplicated between limits.ts and scheduler.ts.
- Evidence:
  - packages/shared/src/quota/limits.ts:105-113 - defaultLimits function defines default token counts
  - packages/shared/src/quota/scheduler.ts:242-248 - scheduleWave repeats the same default object construction when quota is disabled

### MNT-a396d454 — Duplicated emitEnvelope/promoteFinalAuditReport block in advanceAuditCommand.ts

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/audit-code/src/cli/advanceAuditCommand.ts, packages/audit-code/src/cli/advanceAuditCommand.ts
- Summary: The emitEnvelope + promoteFinalAuditReport sequence is duplicated across the batch-results branch (lines 44-60) and the single-result branch (lines 81-96) of cmdAdvanceAudit. Any change to the envelope structure or final report promotion logic must be applied to both copies.
- Evidence:
  - packages/audit-code/src/cli/advanceAuditCommand.ts:44-60 - emitEnvelope + promoteFinalAuditReport block in batch branch
  - packages/audit-code/src/cli/advanceAuditCommand.ts:81-96 - Near-identical emitEnvelope + promoteFinalAuditReport block in single-result branch; only the bundle/state field names differ (result.bundle vs result.updated_bundle)

### MNT-46cb071f — Duplicated getExternalSignalPaths function in flowRequeue.ts and requeue.ts

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/audit-code/src/orchestrator/flowRequeue.ts, packages/audit-code/src/orchestrator/requeue.ts
- Summary: The getExternalSignalPaths function (extracting valid paths from ExternalAnalyzerResults) is defined identically in flowRequeue.ts:7-22 and requeue.ts:16-31. This forces maintainers to update both copies when the extraction logic changes.
- Evidence:
  - packages/audit-code/src/orchestrator/flowRequeue.ts:7-22 - Full definition of getExternalSignalPaths
  - packages/audit-code/src/orchestrator/requeue.ts:16-31 - Identical function body in requeue.ts

### MNT-e4c76de2 — Duplicated process.stderr interception and AUDIT_CODE_VERBOSE lifecycle pattern

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/audit-code/tests/observability-signals.test.mjs
- Summary: The verbose-mode tests in observability-signals.test.mjs repeatedly inline the same ~15-line pattern of saving/restoring process.stderr.write and process.env.AUDIT_CODE_VERBOSE across 6+ test blocks, rather than composing with the existing withCapturedStderr helper. If the interception mechanism changes, all sites must be updated individually.
- Evidence:
  - packages/audit-code/tests/observability-signals.test.mjs:450 - unionFindFromGroups shared-file merge test inlines stderr/verbose interception
  - packages/audit-code/tests/observability-signals.test.mjs:481 - unionFindFromGroups edge-driven merge test duplicates same pattern
  - packages/audit-code/tests/observability-signals.test.mjs:509 - unionFindFromGroups no-verbose test duplicates same pattern
  - packages/audit-code/tests/observability-signals.test.mjs:535 - chunkPacketTasks verbose test duplicates same pattern
  - packages/audit-code/tests/observability-signals.test.mjs:575 - chunkPacketTasks no-verbose test duplicates same pattern
  - packages/audit-code/tests/observability-signals.test.mjs:648 - lensVerification truncation test inlines stderr interception

### MNT-c270bfd1 — Duplicated process.stderr.write intercept pattern for validation summary tests in validation-remediation.test.mjs

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/audit-code/tests/validation-remediation.test.mjs, packages/audit-code/tests/validation-remediation.test.mjs
- Summary: The process.stderr.write monkey-patching pattern for capturing validation summary log lines is written inline twice in validation-remediation.test.mjs (for validateAuditResults and validateArtifactBundle summary checks). This duplicates the same intercept/restore boilerplate rather than using the shared captureConsole helper or extracting a withCapturedStderr utility.
- Evidence:
  - packages/audit-code/tests/validation-remediation.test.mjs:692-739 - First stderr intercept for validateAuditResults summary log
  - packages/audit-code/tests/validation-remediation.test.mjs:742-769 - Second stderr intercept for validateArtifactBundle summary log with identical boilerplate
  - packages/audit-code/tests/synthesis-narrative.test.mjs:7 - Shared captureConsole helper already available in the test suite
  - packages/audit-code/tests/tree-sitter-analyzers.test.mjs:217-229 - withCapturedStderr helper defined for the same pattern elsewhere

### MNT-9368dc49 — Duplicated process.stderr.write intercept pattern in syntax-resolution.test.mjs

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/audit-code/tests/syntax-resolution.test.mjs, packages/audit-code/tests/syntax-resolution.test.mjs
- Summary: The process.stderr.write monkey-patching capture pattern is duplicated verbatim in two tests (tsc and eslint parse-error) instead of being extracted to a shared helper. The tree-sitter-analyzers.test.mjs file already defines a withCapturedStderr helper for this pattern, and the test suite already has a shared ./helpers/captureConsole.mjs, indicating this duplication is inconsistent with existing conventions.
- Evidence:
  - packages/audit-code/tests/syntax-resolution.test.mjs:238-253 - First instance of process.stderr.write intercept for tsc parse-error test
  - packages/audit-code/tests/syntax-resolution.test.mjs:277-295 - Duplicated intercept pattern for eslint parse-error test with identical monkey-patching boilerplate
  - packages/audit-code/tests/tree-sitter-analyzers.test.mjs:217-229 - withCapturedStderr helper that extracts this same pattern
  - packages/audit-code/tests/synthesis-narrative.test.mjs:7 - Existing shared captureConsole helper that could be extended for stderr capture

### MNT-adc5c18a — Duplicated retry-after unit conversion logic

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/shared/src/quota/errorParsing.ts, packages/shared/src/quota/errorParsers/claudeCodeErrorParser.ts
- Summary: The logic for converting retry_after values from seconds to milliseconds (threshold of 600 seconds) is duplicated in both errorParsing.ts and ClaudeCodeErrorParser.ts instead of using a shared helper.
- Evidence:
  - packages/shared/src/quota/errorParsing.ts:49-50 - extractRetryAfterMs converts values < 600 to milliseconds
  - packages/shared/src/quota/errorParsers/claudeCodeErrorParser.ts:30-31 - ClaudeCodeErrorParser replicates the same conversion logic

### MNT-e06234df — Duplicated schema-loading boilerplate across tests

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/audit-code/tests/schema-contracts.test.mjs
- Summary: The loadSchema(...) pattern for audit_result.schema.json, finding.schema.json, and audit_task.schema.json is identically repeated across at least 5 test blocks (lines 53-55, 94-96, 121-123, 167-169, 207-209). A shared helper would centralize schema resolution and reduce maintenance surface.
- Evidence:
  - packages/audit-code/tests/schema-contracts.test.mjs:53-55 - identical loadSchema trio for audit_result, finding, and audit_task schemas; also at :94-96, :121-123, :167-169, :207-209

### MNT-9fd8bd99 — Duplicated temp-directory cleanup in every dispatch-features test

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: duplicated_logic
- Files: packages/audit-code/tests/dispatch-features.test.mjs
- Summary: Each of the 18 tests in dispatch-features.test.mjs duplicates `t.after(() => rm(artifactsDir, { recursive: true, force: true }))`. A shared teardown wrapper would reduce boilerplate and prevent cleanup logic drift.
- Evidence:
  - packages/audit-code/tests/dispatch-features.test.mjs:105 - t.after(() => rm(artifactsDir, ...))
  - packages/audit-code/tests/dispatch-features.test.mjs:165 - t.after(() => rm(artifactsDir, ...))
  - packages/audit-code/tests/dispatch-features.test.mjs:192 - t.after(() => rm(artifactsDir, ...))
  - packages/audit-code/tests/dispatch-features.test.mjs:236 - t.after(() => rm(artifactsDir, ...))
  - packages/audit-code/tests/dispatch-features.test.mjs:278 - t.after(() => rm(artifactsDir, ...))
  - packages/audit-code/tests/dispatch-features.test.mjs:345 - t.after(() => rm(artifactsDir, ...))

### MNT-240d873b — Duplicated temp-directory helper boilerplate

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/shared/tests/learnedQuotaSource.test.mjs, packages/shared/tests/git.test.mjs, packages/shared/tests/io-json-ndjson.test.mjs, packages/shared/tests/io-json-retry.test.mjs
- Summary: Redundant and non-standardized implementations of temporary directory setup/cleanup helpers or inline try-finally block boilerplate exist across multiple test files, introducing maintainability overhead and risk of resource leakage.
- Evidence:
  - packages/shared/tests/learnedQuotaSource.test.mjs:12-20 - defines local helper function withTempStateDir
  - packages/shared/tests/git.test.mjs:15-31 - defines local helper function withTempRepo
  - packages/shared/tests/io-json-ndjson.test.mjs:19-33 - inline try-finally blocks used for temp directory setup/cleanup repeated 14 times
  - packages/shared/tests/io-json-retry.test.mjs:68-81 - inline try-finally block used for temp directory setup/cleanup

### MNT-0280324f — Duplicated temporary directory and repository creation helpers in test files

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: code-duplication
- Files: packages/audit-code/tests/syntax-resolution.test.mjs, packages/audit-code/tests/tree-sitter-analyzers.test.mjs, packages/audit-code/tests/validate-command.test.mjs
- Summary: Multiple test files define their own custom temporary directory creation and recursive cleanup helpers (e.g. withTempRepo in syntax-resolution.test.mjs and validate-command.test.mjs, and withRepo in tree-sitter-analyzers.test.mjs) instead of sharing a single, unified utility like withTempDir from tests/helpers/withTempDir.mjs.
- Evidence:
  - packages/audit-code/tests/syntax-resolution.test.mjs:12 - withTempRepo helper replicates mkdtemp/rm logic.
  - packages/audit-code/tests/tree-sitter-analyzers.test.mjs:22 - withRepo helper replicates mkdtemp/rm logic.
  - packages/audit-code/tests/validate-command.test.mjs:42 - withTempRepo helper replicates mkdtemp/rm logic.

### MNT-adbb4c63 — Duplicated test fixture withTempRepo across two test files

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/audit-code/tests/audit-code-completion.test.mjs, packages/audit-code/tests/audit-code-wrapper.test.mjs
- Summary: The withTempRepo fixture function is duplicated verbatim across audit-code-completion.test.mjs (lines 64-116) and audit-code-wrapper.test.mjs (lines 203-256). Both create identical temp repo structures with the same files, making cross-file maintenance brittle.
- Evidence:
  - packages/audit-code/tests/audit-code-completion.test.mjs:64-116 - withTempRepo fixture creates same dir structure (src/api/, src/lib/, infra/) and files (package.json, auth.ts, session.ts, deploy.yml)
  - packages/audit-code/tests/audit-code-wrapper.test.mjs:203-256 - Identical withTempRepo implementation (52 lines, same subdirs, same file contents)

### MNT-af730b00 — Duplicated test suites for document and implement worker prompts

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/remediate-code/tests/working-directory-prompts.test.ts
- Summary: The working-directory-prompts.test.ts contains two identical test suites (document vs implement workers) that repeat the same three assertions about workdir explicitness, forward-slash paths, and cd prohibition. Any change to workdir prompt expectations must be applied across 6 test locations in 2 suites, increasing the risk of drift.
- Evidence:
  - packages/remediate-code/tests/working-directory-prompts.test.ts:82-133 - document worker suite (3 tests on workdir explicitness, paths, cd prohibition)
  - packages/remediate-code/tests/working-directory-prompts.test.ts:135-184 - implement worker suite (identical 3-test structure with different state factory)

### MNT-5ff14c03 — Empty calls graph section adds dead weight

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: unnecessary-complexity
- Files: packages/audit-code/.audit-artifacts/graph_bundle.json
- Summary: The calls array is empty (calls: []) yet preserved in the output, suggesting a stale pipeline stage that was never populated.
- Evidence:
  - packages/audit-code/.audit-artifacts/graph_bundle.json:7653 - calls: [] with 0 entries.

### COR-1e12f6c7 — ESLint analysis silently skipped with no reason recorded

- Severity: low
- Confidence: high
- Lens: correctness
- Category: missing-validation
- Files: packages/audit-code/.audit-artifacts/external_analyzer_results.json
- Summary: external_analyzer_results.json reports eslint as skipped (resolved: false) but provides no reason. If eslint configuration issues are silently ignored, code quality issues could go undetected.
- Evidence:
  - packages/audit-code/.audit-artifacts/external_analyzer_results.json:12-16 - eslint status is 'skipped' with no explanation

### MNT-9559094e — Extreme repetitive boilerplate — 1527 entries with identical structure

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/audit-code/.audit-artifacts/requeue_tasks.json
- Summary: Every entry follows an identical 10-field JSON object pattern with only task_id, unit_id, file_paths, lens, and rationale varying by template. The same file_paths are repeated across multiple lens entries. This data could be compressed into a map keyed by file path with an array of missing lenses, reducing the artifact by ~70%.
- Evidence:
  - packages/audit-code/.audit-artifacts/requeue_tasks.json:2-14 - Example entry structure is identical across all 1527 entries
  - cache.ts appears 6 times (correctness, reliability, performance, observability, tests, data_integrity) with only lens/rationale differing

### OBS-2658a6d3 — FileLockTimeoutError lacks elapsed-time and retry-count context

- Severity: low
- Confidence: high
- Lens: observability
- Category: insufficient-error-context
- Files: packages/shared/src/quota/fileLock.ts
- Summary: FileLockTimeoutError only includes the lock path in its message, omitting the timeout duration, elapsed wait time, and retry count. When diagnosing contention or deadlocks, operators have no numeric context from the error alone.
- Evidence:
  - packages/shared/src/quota/fileLock.ts:7-11 - FileLockTimeoutError constructor only embeds lockPath; timeoutMs parameter is not captured in the message or as a property

### MNT-21aa9255 — Generated lockfiles included in audit scope

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: missing-filtering
- Files: packages/audit-code/.audit-artifacts/dispatch/current-tasks.json
- Summary: bun.lock lockfiles from .tmp/opentoken/ are included in critical-flow audit tasks (e.g., flow:surface:src-types-workerSession-ts:reliability:part-1). These generated artifacts add no audit value and increase file bloat.
- Evidence:
  - packages/audit-code/.audit-artifacts/dispatch/current-tasks.json:447 - bun.lock at .tmp/opentoken/bun.lock
  - packages/audit-code/.audit-artifacts/dispatch/current-tasks.json:470 - bun.lock size 323 lines
  - packages/audit-code/.audit-artifacts/dispatch/current-tasks.json:1516 - bun.lock in critical flow task file_paths

### TST-1c2c03b5 — getErrorParserForProvider in errorParsers/index.ts has no test coverage

- Severity: low
- Confidence: high
- Lens: tests
- Category: missing-test-coverage
- Files: packages/shared/src/quota/errorParsers/index.ts
- Summary: The factory function getErrorParserForProvider (index.ts:20-21) that resolves the correct ErrorParser by provider name is untested. This function is the single dispatch point ensuring claude-code errors use ClaudeCodeErrorParser vs the generic fallback.
- Evidence:
  - packages/shared/src/quota/errorParsers/index.ts:20-21 - getErrorParserForProvider has exactly one line of logic (dictionary lookup or fallback). No test coverage.
  - packages/shared/src/quota/errorParsers/index.ts:16-18 - The PROVIDER_PARSERS registry only maps 'claude-code'; no test verifies this mapping.

### OBS-187ef6c0 — Git Execution Failures Silently Swallowed

- Severity: low
- Confidence: high
- Lens: observability
- Category: missing-logging
- Files: packages/shared/src/git.ts
- Summary: If git command executions fail (due to lack of git installation, corrupted index, etc.), the gitLines helper silently returns an empty array with no warning or error logged, masking diagnostic issues.
- Evidence:
  - packages/shared/src/git.ts:11-18 - gitLines returns an empty array if runTracked result status is non-zero, without any logging or warning about the git command failure.

### MNT-b8976886 — Highly repetitive pattern validation in assertOpenCodeAuditPermissionConfig

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: code-duplication
- Files: packages/audit-code/audit-code-wrapper-opencode.mjs
- Summary: assertOpenCodeAuditPermissionConfig (opencode.mjs:160-225) performs ~30 individual allow/deny pattern checks using an identical if/throw structure. Adding or removing a bash permission requires editing multiple separate loops, and the error message pattern is boilerplate across all checks.
- Evidence:
  - packages/audit-code/audit-code-wrapper-opencode.mjs:160-225 - 65-line function with 30+ near-identical pattern checks

### MNT-599a4c9c — Inconsistent entry types — flow-requeue vs standard requeue mixed in single array

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: inconsistent-abstraction
- Files: packages/audit-code/.audit-artifacts/requeue_tasks.json
- Summary: 56 flow-requeue entries (task_id prefix flow-requeue:) use a different unit_id pattern (flow-based) and carry critical_flow_followup tags, while 1471 standard entries use file-path-based unit_ids with empty tags. Mixing two distinct task types in a single flat array without partitioning or typing makes the artifact harder to query and maintain.
- Evidence:
  - packages/audit-code/.audit-artifacts/requeue_tasks.json:19100-19965 - flow-requeue entries use unit_id 'flow:surface:...' vs standard entries use 'requeue:...'
  - 56 flow-requeue entries have tags: ['critical_flow_followup'] while 1471 standard entries have tags: []

### OBS-859bdecd — Inconsistent error output destinations and missing structured logging

- Severity: low
- Confidence: high
- Lens: observability
- Category: inconsistent-logging
- Files: packages/audit-code/src/cli/mergeAndIngestCommand.ts, packages/audit-code/src/cli/nextStepCommand.ts, packages/audit-code/src/cli/lineIndex.ts, packages/audit-code/src/cli/resynthesizeCommand.ts
- Summary: The codebase mixes console.log, console.warn, console.error, and process.stderr.write across files without a consistent logging abstraction, structured format, timestamps, or correlation IDs linking log output across pipeline steps.
- Evidence:
  - packages/audit-code/src/cli/mergeAndIngestCommand.ts:75-78 - uses process.stderr.write with ad-hoc string formatting
  - packages/audit-code/src/cli/lineIndex.ts:28-29 - uses console.warn with [lineIndex] prefix
  - packages/audit-code/src/cli/resynthesizeCommand.ts:27-28 - uses console.error without prefix
  - packages/audit-code/src/cli/nextStepCommand.ts:500-503 - uses process.stderr.write with [audit-code] prefix
  - No file uses a structured logging library, timestamps on log lines, or correlation IDs linking log output across pipeline steps

### MNT-98a05c9e — Inconsistent logging: console.warn instead of structured RunLogger

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: inconsistent_abstraction
- Files: packages/audit-code/src/orchestrator/fileIntegrity.ts
- Summary: fileIntegrity.ts uses console.warn for I/O error logging while the rest of the orchestrator uses RunLogger from @audit-tools/shared. File-integrity errors bypass the structured log pipeline.
- Evidence:
  - packages/audit-code/src/orchestrator/fileIntegrity.ts:52 - console.warn with structured context object but unstructured output
  - packages/audit-code/src/orchestrator/advance.ts:119 - RunLogger usage as the project standard

### CFG-306d2705 — Inconsistent publish-verification retry count across publish jobs

- Severity: low
- Confidence: high
- Lens: config_deployment
- Category: inconsistent-configuration
- Files: .github/workflows/publish-package.yml, .github/workflows/publish-package.yml, .github/workflows/publish-package.yml
- Summary: The audit-code publish job uses 12 registry-verification retries (2 min max) while remediate-code and shared use 24 retries (4 min max). This inconsistency may cause the audit-code job to fail registry-propagation checks more readily than the other packages.
- Evidence:
  - .github/workflows/publish-package.yml:230 - audit-code verify step uses or attempt in {1..12} (2 min with 10s sleep)
  - .github/workflows/publish-package.yml:458 - remediate-code verify step uses or attempt in {1..24} (4 min with 10s sleep)
  - .github/workflows/publish-package.yml:678 - shared verify step uses or attempt in {1..24} (4 min with 10s sleep)

### OBS-a41f0eb5 — Inconsistent structured logging conventions across modules

- Severity: low
- Confidence: high
- Lens: observability
- Category: logging
- Files: packages/audit-code/src/providers/opencodeProvider.ts, packages/audit-code/src/quota/headerExtraction.ts, packages/audit-code/src/quota/discoveredLimits.ts, packages/audit-code/src/reporting/synthesis.ts, packages/audit-code/src/reporting/synthesisNarrativePrompt.ts
- Summary: Modules use three different logging patterns — structured JSON stderr events (opencodeProvider.ts), plain-text prefix format (quota/*.ts), and console.error/console.warn (synthesis.ts, synthesisNarrativePrompt.ts) — making centralized log aggregation, level-based filtering, and event correlation harder. Some informational telemetry (synthesis.ts:182) is emitted via console.error, conflating routine progress events with actual error output.
- Evidence:
  - packages/audit-code/src/providers/opencodeProvider.ts:28 - structured JSON stderr event: process.stderr.write(JSON.stringify({event:'provider_launch',...}))
  - packages/audit-code/src/quota/headerExtraction.ts:87 - plain-text prefix log: process.stderr.write('[quota] header extraction: no rate-limit data...')
  - packages/audit-code/src/quota/discoveredLimits.ts:43 - plain-text prefix log: process.stderr.write('[quota] ignoring unreadable discovered-limits cache...')
  - packages/audit-code/src/reporting/synthesis.ts:182 - informational telemetry via console.error: console.error(JSON.stringify({tag:'synthesis_complete',...}))
  - packages/audit-code/src/reporting/synthesisNarrativePrompt.ts:31 - plain-text warning via console.warn: console.warn('[audit-code] synthesisNarrative: truncated findings list...')

### MNT-728df9d6 — Inconsistent task_id naming conventions

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: naming-conventions
- Files: packages/audit-code/.audit-artifacts/audit_tasks.json
- Summary: Task IDs use at least three distinct prefix conventions: flow-colon-delimited (flow:flow:surface:src-types-workerSession-ts:reliability:part-1), leading-hyphen (-tmp-opentoken:correctness:part-1), and bare unit name (src-orchestrator:maintainability:part-1). The leading-hyphen prefix on unit_ids like -tmp-opentoken, -gemini-commands, -vscode, and -remediation-artifacts-steps has no documented meaning, making it unclear whether these represent temporary, external, or excluded units.
- Evidence:
  - packages/audit-code/.audit-artifacts/audit_tasks.json:4-17 - task_id 'flow:flow:data:-tmp-opentoken--opencode-opentoken-config-schema-json:reliability' shows flow-colon prefix
  - packages/audit-code/.audit-artifacts/audit_tasks.json:264 - task_id '-tmp-opentoken:data_integrity' shows leading-hyphen prefix
  - packages/audit-code/.audit-artifacts/audit_tasks.json:363 - task_id 'dispatch:maintainability' shows bare unit prefix

### MNT-8a94683f — Inline stream capturing and redirection in test files

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: code-duplication
- Files: packages/audit-code/tests/submit-packet-command.test.mjs, packages/audit-code/tests/tree-sitter-analyzers.test.mjs
- Summary: Test files manually override and intercept process.stderr.write and process.stdout.write using custom local helper functions instead of leveraging a shared stream/console capture utility (e.g., extending the existing captureConsole.mjs helper).
- Evidence:
  - packages/audit-code/tests/submit-packet-command.test.mjs:132 - runSubmit helper overrides process.stdout/stderr manually.
  - packages/audit-code/tests/tree-sitter-analyzers.test.mjs:216 - withCapturedStderr helper overrides process.stderr manually.

### MNT-5cca9f90 — Inline stream capturing and redirection in test files

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: code-duplication
- Files: packages/audit-code/tests/validation-remediation.test.mjs
- Summary: Test files manually override and intercept process.stderr.write and process.stdout.write using custom local helper functions or inline try/finally blocks instead of leveraging a shared stream/console capture utility (e.g., extending the existing captureConsole.mjs helper).
- Evidence:
  - packages/audit-code/tests/validation-remediation.test.mjs:691 - Manual process.stderr.write interceptor logic used in validateAuditResults test block.
  - packages/audit-code/tests/validation-remediation.test.mjs:741 - Manual process.stderr.write interceptor logic used in validateArtifactBundle test block.

### TST-d27212b9 — JSON validity assertion is a tautology guaranteed by beforeAll

- Severity: low
- Confidence: high
- Lens: tests
- Category: fragile-test
- Files: packages/remediate-code/tests/schema-contracts.test.ts
- Summary: In schema-contracts.test.ts, the `exists and is valid JSON` test re-parses `content` which was already successfully parsed in `beforeAll`. If `beforeAll`'s `JSON.parse` throws, the test never runs; if it succeeds, the test cannot fail. The assertion is dead and provides no coverage.
- Evidence:
  - packages/remediate-code/tests/schema-contracts.test.ts:37-40 - beforeAll already calls JSON.parse(content) and would throw on invalid JSON
  - packages/remediate-code/tests/schema-contracts.test.ts:42-44 - it('exists and is valid JSON') calls JSON.parse(content) again, guaranteed to pass after beforeAll succeeds

### MNT-d27f79fd — Local VALID_PRIORITIES set duplicates shared vocabulary pattern

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: inconsistent-abstraction
- Files: packages/audit-code/src/validation/auditResults.ts
- Summary: VALID_PRIORITIES (auditResults.ts:42) is defined locally instead of being imported from @audit-tools/shared, unlike VALID_SEVERITIES and VALID_CONFIDENCES which use the canonical shared vocabulary. This creates a drift risk.
- Evidence:
  - packages/audit-code/src/validation/auditResults.ts:42 - const VALID_PRIORITIES = new Set(["high", "medium", "low"]) defined locally
  - packages/audit-code/src/validation/auditResults.ts:6-9 - Imports VALID_SEVERITIES and VALID_CONFIDENCES from shared but not priorities

### MNT-f95ab48c — Long if/else chains with hardcoded strings in unit inference

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: inconsistent-abstractions
- Files: packages/audit-code/src/orchestrator/unitBuilder.ts
- Summary: inferUnitKind (lines 28-58) and inferUnitId (lines 60-100) in unitBuilder.ts use long if/else-if chains with hardcoded path prefix checks and magic strings. Adding a new source tree layout requires modifying the chain rather than extending a registry.
- Evidence:
  - packages/audit-code/src/orchestrator/unitBuilder.ts:37-43 - Hardcoded prefixes: apps/, services/, packages/, infra/, scripts/, bin/
  - packages/audit-code/src/orchestrator/unitBuilder.ts:64-99 - inferUnitId: 7-branch if/else chain with path-position magic numbers

### MNT-cdb34f9b — Magic confidence values scattered across graph bundle tests

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: magic-numbers
- Files: packages/audit-code/tests/extractors-remediation.test.mjs
- Summary: Confidence values (0.95, 0.93, 0.92, 0.90, 0.88, 0.87, 0.86, 0.85, 0.82, 0.78, 0.72) appear as literal magic numbers across ~50+ assertion sites in the graph bundle tests. Without named constants or documented derivation, adjusting scoring heuristics requires updating scattered assertions with no single point of control.
- Evidence:
  - packages/audit-code/tests/extractors-remediation.test.mjs:831 - assert.equal(edge.confidence, 0.95) for esm import edges
  - packages/audit-code/tests/extractors-remediation.test.mjs:843 - assert.equal(edge.confidence, 0.72) for repo path string literal references
  - packages/audit-code/tests/extractors-remediation.test.mjs:853 - assert.equal(edge.confidence, 0.82) for relative string references
  - packages/audit-code/tests/extractors-remediation.test.mjs:1007 - assert.equal(edge.confidence, 0.88) for test-source-link edges
  - packages/audit-code/tests/extractors-remediation.test.mjs:1169 - assert.equal(edge.confidence, 0.88) for package script links
  - packages/audit-code/tests/extractors-remediation.test.mjs:1278 - assert.equal(edge.confidence, 0.93) for JSON Schema refs
  - packages/audit-code/tests/extractors-remediation.test.mjs:1429 - assert.equal(edge.confidence, 0.86) for workspace package links

### MNT-375af3c5 — Magic constant 4 for --host-max-active-subagents duplicated in three code paths

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: magic-constants
- Files: .gemini/commands/audit-code.toml
- Summary: The value 4 for --host-max-active-subagents appears three times (lines 35, 44, and 82) in the prompt template. If the recommended default changes, all occurrences must be updated in sync.
- Evidence:
  - .gemini/commands/audit-code.toml:35 - `audit-code next-step --host-max-active-subagents 4`
  - .gemini/commands/audit-code.toml:44 - `node packages/audit-code/audit-code.mjs next-step --host-max-active-subagents 4`
  - .gemini/commands/audit-code.toml:82 - `audit-code next-step --host-max-active-subagents 4`

### MNT-0d172686 — makeFailingChild is defined twice with different signatures in spawnLoggedCommand.test.mjs

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: duplicated-test-helper
- Files: packages/shared/tests/spawnLoggedCommand.test.mjs, packages/shared/tests/spawnLoggedCommand.test.mjs
- Summary: makeFailingChild is defined as a local closure inside a single test (line 549, parameterized by code) and again as a module-level helper (line 584, fixed exit code 1). Changing the child-factory contract requires patching both definitions, creating a maintenance trap.
- Evidence:
  - packages/shared/tests/spawnLoggedCommand.test.mjs:549 - makeFailingChild(code) closure inside 'SpawnRunController.run() rejects when child exits with a non-zero code'.
  - packages/shared/tests/spawnLoggedCommand.test.mjs:584 - Second makeFailingChild module-level helper (hard-coded exit code 1) used by the following two tests.

### TST-0c3df6aa — Misleading test title: 'missing traces array' tests non-array instead

- Severity: low
- Confidence: high
- Lens: tests
- Category: incorrect-assertion
- Files: packages/remediate-code/tests/validation.test.ts
- Summary: In validation.test.ts, the test titled 'rejects missing traces array on finding' provides `traces: 'not-array'` (a string), not a missing `traces` field. The test covers type mismatch, not omission. A separate test for truly missing `traces` is absent.
- Evidence:
  - packages/remediate-code/tests/validation.test.ts:429 - Test title: 'rejects missing traces array on finding'
  - packages/remediate-code/tests/validation.test.ts:432 - traces: 'not-array' (a string value, not omitted)
  - packages/remediate-code/tests/validation.test.ts:433 - Assertion checks for message containing 'traces' — passes for type mismatch, would also pass for omission, so missing-traces path is never isolated

### TST-ebba1500 — Missing negative tests for build-step failure propagation

- Severity: low
- Confidence: high
- Lens: tests
- Category: missing-negative-tests
- Files: .codex/hooks/session-start.sh
- Summary: The error-propagation test only covers npm install failure, but does not test failure of the two subsequent build commands (npm run build -w @audit-tools/shared and npm run build). While set -e should propagate these failures, the behavior is untested for the build-specific failure paths.
- Evidence:
  - packages/audit-code/tests/session-start-hook.test.mjs:90-133 - success path tests all three npm invocations
  - packages/audit-code/tests/session-start-hook.test.mjs:136-163 - failure path only tests npm install exit 1
  - .codex/hooks/session-start.sh:31-32 - two untested failure paths for npm run build -w @audit-tools/shared and npm run build

### MNT-1a26fa39 — Missing schema version and metadata header

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: missing-documentation
- Files: packages/audit-code/.audit-artifacts/audit_tasks.json
- Summary: The file begins directly with the JSON array opener (line 1: '[') with no version field, generation timestamp, schema reference, or description of the task format. Consumers of this file cannot determine what version of the task schema it conforms to or when it was generated without external context.
- Evidence:
  - packages/audit-code/.audit-artifacts/audit_tasks.json:1 - First line is '[' with no metadata header, version field, or schema reference
  - schemas/audit_task.schema.json - Schema exists for individual task objects but the file itself has no versioned envelope

### OBS-3ec822ec — Missing top-level generation metadata on task list

- Severity: low
- Confidence: high
- Lens: observability
- Category: missing_observability_context
- Files: packages/audit-code/.audit-artifacts/audit_tasks.json
- Summary: The audit_tasks.json file is a bare JSON array with no envelope object providing generated_at timestamp, schema_version, or run_id. This prevents verifying plan freshness, format version, or associating the plan with a specific generation run from the file content alone.
- Evidence:
  - packages/audit-code/.audit-artifacts/audit_tasks.json:1 - File opens directly as '[' with no metadata wrapper
  - packages/audit-code/.audit-artifacts/audit_tasks.json:1-4845 - No generated_at, schema_version, or run_id fields found anywhere in the file

### MNT-2fb0ff05 — Nested directory duplication in tracked manifest files

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/audit-code/.audit-artifacts/repo_manifest.json
- Summary: The repository manifest tracks nested duplicate directory hierarchies (e.g. .tmp/opentoken/ and .tmp/opentoken/opentoken/), which unnecessarily inflates manifest size and complicates down-stream parsing.
- Evidence:
  - packages/audit-code/.audit-artifacts/repo_manifest.json:393 - .tmp/opentoken/opentoken/ is a complete copy of the parent .tmp/opentoken/ folder, duplicating all its structure
  - packages/audit-code/.audit-artifacts/repo_manifest.json:930 - End of nested .tmp/opentoken/opentoken/ files

### OBS-7acf324f — No correlation IDs across split-part tasks

- Severity: low
- Confidence: high
- Lens: observability
- Category: missing-distributed-tracing-context
- Files: packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/pending-audit-tasks.json
- Summary: Tasks split into part-1 through part-14 share no trace_id, span_id, or batch_id, making it impossible to aggregate observability signals across the logical unit.
- Evidence:
  - packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/pending-audit-tasks.json:2122-2410 - Tasks -tmp-opentoken:observability:part-1 through part-14 lack any shared correlation identifier

### OBS-66779c90 — No elapsed-time or progress reporting for long-running operations

- Severity: low
- Confidence: high
- Lens: observability
- Category: missing-telemetry
- Files: packages/audit-code/audit-code-wrapper-install-hosts.mjs, packages/audit-code/audit-code-wrapper-install-hosts.mjs, packages/audit-code/audit-code-wrapper-install-hosts.mjs
- Summary: Install, verify, and ensure-bootstrap operations perform sequential file I/O and host verification but report no elapsed time, progress count, or timing breakdown. Operators diagnosing slow installs have no data beyond the final payload.
- Evidence:
  - packages/audit-code/audit-code-wrapper-install-hosts.mjs:761 - installBootstrap returns payload with no elapsed_time field
  - packages/audit-code/audit-code-wrapper-install-hosts.mjs:1094-1095 - ensureBootstrap payload has no elapsed_time field
  - packages/audit-code/audit-code-wrapper-install-hosts.mjs:927-941 - verifyInstalledBootstrap JSON output omits timing

### OBS-5edc372b — No metrics counters for adapter-level dropped items or processing throughput

- Severity: low
- Confidence: high
- Lens: observability
- Category: metrics
- Files: packages/audit-code/src/adapters/normalizeExternal.ts
- Summary: The normalizeGenericExternalResults function tracks dropped/valid counts but only writes a one-off stderr message — it never emits a metric counter that could feed into a dashboard or alert. There are no metrics for adapter throughput, error rates, or latency anywhere in the packet's files.
- Evidence:
  - packages/audit-code/src/adapters/normalizeExternal.ts:36-41 - dropped count computed but only written to stderr text, never to a metric counter
  - packages/audit-code/src/adapters/npmAudit.ts:24-41 - no metrics for items processed or severity distribution
  - packages/audit-code/src/adapters/semgrep.ts:45-61 - no metrics for items processed or severity distribution

### OPR-93a95c6e — No poll-log throttling in shared release script polling loops

- Severity: low
- Confidence: high
- Lens: operability
- Category: noisy-logging
- Files: packages/shared/scripts/release-and-publish.mjs, packages/shared/scripts/release-and-publish.mjs, packages/shared/scripts/release-and-publish.mjs
- Summary: The shared release script's waitForReleaseRun, waitForRunCompletion, and waitForRegistryVersion functions log on every 5-second poll attempt without throttling, producing ~120 log lines per 10-minute wait. The remediate-code counterpart uses shouldLogPoll to limit output to ~20 lines per 10-minute wait.
- Evidence:
  - packages/shared/scripts/release-and-publish.mjs:199-203 - waitForReleaseRun logs console.log([release] waiting for publish run : attempt , elapsed ms) on every 5s poll iteration without throttling
  - packages/shared/scripts/release-and-publish.mjs:226-228 - waitForRunCompletion logs on every 5s poll iteration without throttling
  - packages/shared/scripts/release-and-publish.mjs:261-263 - waitForRegistryVersion logs on every 5s poll iteration without throttling
  - packages/remediate-code/scripts/release-and-publish.mjs:60-63 - shouldLogPoll function throttles polling logs to ~30s intervals
  - packages/remediate-code/scripts/release-and-publish.mjs:219-224,253-258,290-295 - remediate-code version uses shouldLogPoll to gate each poll log

### OBS-57837e48 — No progress metrics for large-task processing

- Severity: low
- Confidence: high
- Lens: observability
- Category: missing-observability
- Files: packages/audit-code/.audit-artifacts/dispatch/current-tasks.json
- Summary: file_line_counts shows total lines but no lines_processed or equivalent field, preventing completion-progress observability for large tasks.
- Evidence:
  - packages/audit-code/.audit-artifacts/dispatch/current-tasks.json:33-48 - file_line_counts maps paths to total lines only, no processed count

### OBS-480cad6f — No temporal metadata on any task

- Severity: low
- Confidence: high
- Lens: observability
- Category: missing-observability-metadata
- Files: packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/pending-audit-tasks.json
- Summary: None of the 273 task objects include creation timestamps, update timestamps, or any temporal field, preventing queue-age monitoring, stale-task detection, and SLA tracking.
- Evidence:
  - packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/pending-audit-tasks.json - Zero tasks contain fields like created_at, updated_at, timestamp, or queued_at across all 273 entries

### OBS-7967d365 — No trace or correlation IDs across tasks

- Severity: low
- Confidence: high
- Lens: observability
- Category: missing-observability
- Files: packages/audit-code/.audit-artifacts/dispatch/current-tasks.json
- Summary: Tasks lack trace_id, correlation_id, or span_id, preventing distributed debugging across multi-task workflows.
- Evidence:
  - packages/audit-code/.audit-artifacts/dispatch/current-tasks.json:3-6862 - No task object contains trace_id, correlation_id, or span_id

### MNT-69d6c145 — Overly long monolithic test covering multiple concerns

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: excessive-function-length
- Files: packages/audit-code/tests/io-remediation.test.mjs
- Summary: The 'run artifact helpers produce parseable run ids and clean only dispatch files' test spans ~119 lines and verifies run ID building, directory creation, task file writing, dispatch artifact writing, schema copying, and cleanup assertions in a single test function, making it harder to isolate failures.
- Evidence:
  - packages/audit-code/tests/io-remediation.test.mjs:227-346 - Single test function spanning 6 distinct verification concerns

### MNT-706be541 — Oversized single-file packet manifest

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: excessive-function-length
- Files: packages/audit-code/.audit-artifacts/review_packets.json
- Summary: review_packets.json is 8057 lines and ~1.2M estimated tokens across 64 packets.
- Evidence:
  - review_packets.json:1-8057 - 8057 line JSON array with 64 packet objects

### COR-f49f2bb0 — Path corruption and drive-relative folder creation on Windows

- Severity: low
- Confidence: high
- Lens: correctness
- Category: command-execution
- Files: packages/audit-code/.audit-artifacts/file_disposition.json, packages/audit-code/.audit-artifacts/flow_coverage.json, packages/audit-code/.audit-artifacts/operator-handoff.json
- Summary: On Windows, when an absolute artifacts path is passed with backslashes (e.g. C:\Code\auditor-lambda\.audit-artifacts), if backslashes are stripped during command execution or string replacements, it results in a drive-relative path (C:Codeauditor-lambda.audit-artifacts) resolving to packages/audit-code/Codeauditor-lambda.audit-artifacts/. This directory is then scanned and incorrectly included in the file disposition and flow coverage.
- Evidence:
  - packages/audit-code/.audit-artifacts/file_disposition.json:1224 - Path is set to 'Codeauditor-lambda.audit-artifacts/session-config.json'
  - packages/audit-code/.audit-artifacts/flow_coverage.json:174 - Malformed path 'Codeauditor-lambda.audit-artifacts/session-config.json' is referenced in flow paths.
  - packages/audit-code/.audit-artifacts/operator-handoff.json:3 - 'repo_root' is set to 'C:\\Code\\auditor-lambda' absolute path while the artifacts directory was resolved relative to the drive, causing a folder to be created in packages/audit-code.

### OBS-28770651 — Provider auto-resolution logging is semi-structured and omits rule-level decision context

- Severity: low
- Confidence: high
- Lens: observability
- Category: incomplete-telemetry
- Files: packages/shared/src/providers/providerFactory.ts, packages/shared/src/providers/providerFactory.ts
- Summary: createFreshSessionProvider in providerFactory.ts emits a single human-readable stderr line with the resolved provider name and fallback reason, but chooseAutoProvider logs nothing about which priority rule matched, why earlier rules were skipped, or the context snapshot (env signals, config presence, command availability) that drove the decision. Debugging unexpected auto-resolution requires adding instrumentation or reading code.
- Evidence:
  - packages/shared/src/providers/providerFactory.ts:192-197 - chooseAutoProvider iterates priority rules with no logging of which rule matched or why
  - packages/shared/src/providers/providerFactory.ts:274-282 - The only structured output is a single human-readable stderr line; no JSON-structured event with context snapshot is emitted
  - packages/shared/src/providers/providerFactory.ts:65-107 - getAutoProviderContext captures rich context (env vars, config flags, command availability) but none of it is logged

### TST-d3216c57 — readJsonFile error handling paths are completely untested

- Severity: low
- Confidence: high
- Lens: tests
- Category: test-coverage-gap
- Files: packages/shared/src/io/json.ts
- Summary: No unit tests assert that readJsonFile correctly propagates file missing errors or correctly wraps JSON parsing errors into rich descriptive errors.
- Evidence:
  - packages/shared/src/io/json.ts:113-129 - readJsonFile is only invoked inside a happy path concurrent-write test, with no negative test cases validating throw behavior on non-existent files or invalid JSON content

### OBS-6556d8c5 — recordWaveOutcome does not pass logger to withFileLock, causing silent lock-contention events

- Severity: low
- Confidence: high
- Lens: observability
- Category: missing-observability-context
- Files: packages/shared/src/quota/state.ts
- Summary: In recordWaveOutcome(), withFileLock is called to acquire the quota state lock, but no RunLogger instance is passed to it. Consequently, lock timeouts or stale lock removal events occurring during wave outcome updates are not logged to the structured run log, impairing telemetry on lock contention.
- Evidence:
  - packages/shared/src/quota/state.ts:152-160 - withFileLock called on quota state path lock without passing a logger parameter, silently bypassing the run log for locking events

### OBS-a54af07e — Redundant and False Positive Rate-Limit Warning Telemetry

- Severity: low
- Confidence: high
- Lens: observability
- Category: logging-quality
- Files: packages/audit-code/src/quota/headerExtraction.ts, packages/audit-code/src/quota/headerExtractors/claudeCodeHeaderExtractor.ts
- Summary: Rate-limit header extraction logs false-positive warnings to stderr for any non-empty stderr output, even if it is normal diagnostics. Additionally, ClaudeCodeHeaderExtractor prints redundant warnings for the same event.
- Evidence:
  - packages/audit-code/src/quota/headerExtraction.ts:87-90 - Writes format warning to stderr on any non-empty text
  - packages/audit-code/src/quota/headerExtractors/claudeCodeHeaderExtractor.ts:31-33 - Writes redundant warning before calling extractRateLimitHeaders which logs a second warning

### MNT-bd164109 — Redundant duplicate test files

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: duplicated-logic
- Files: packages/shared/tests/validation-basic.test.mjs
- Summary: The validation-basic.test.mjs file is entirely redundant as its test coverage and test cases for prefixValidationIssues overlap exactly with the tests in prefixValidationIssues.test.mjs.
- Evidence:
  - packages/shared/tests/validation-basic.test.mjs:1-30 - tests prefixValidationIssues, which are more comprehensively tested in prefixValidationIssues.test.mjs

### TST-220027ee — renderAuditReportMarkdown delta/budget scope branches untested

- Severity: low
- Confidence: high
- Lens: tests
- Category: missing-tests
- Files: packages/audit-code/src/reporting/synthesis.ts
- Summary: renderAuditReportMarkdown (synthesis.ts:257-383) has three scope-rendering branches (full/delta/budget) plus theme and top_risk sections, but only the fallthrough (full/no-scope) path is tested. The delta and budget scope renderings and themes/top_risks sections have no coverage.
- Evidence:
  - packages/audit-code/tests/reporting-remediation.test.mjs: renderAuditReportMarkdown test at line 249 passes no scope option
  - synthesis.ts lines 360-380: delta/budget branches never exercised

### MNT-b745e454 — Repeated findings-by-category filtering pattern across design-assessment.test.mjs

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: duplicated_logic
- Files: packages/audit-code/tests/design-assessment.test.mjs
- Summary: The pattern `result.findings.filter((f) => f.category === "xxx")` is repeated approximately 15 times across the file. A helper like `findingsByCategory(result, category)` would reduce duplication and improve change safety if the finding data structure evolves.
- Evidence:
  - packages/audit-code/tests/design-assessment.test.mjs:38 - cycleFindings = result.findings.filter((f) => f.category === 'dependency_cycle')
  - packages/audit-code/tests/design-assessment.test.mjs:82 - hubFindings = result.findings.filter((f) => f.category === 'hub_module')
  - packages/audit-code/tests/design-assessment.test.mjs:169 - orphanFindings = result.findings.filter((f) => f.category === 'orphan_units')
  - packages/audit-code/tests/design-assessment.test.mjs:199 - concFindings = result.findings.filter((f) => f.category === 'risk_concentration')
  - packages/audit-code/tests/design-assessment.test.mjs:219 - monoFindings = result.findings.filter((f) => f.category === 'monolith_unit')
  - packages/audit-code/tests/design-assessment.test.mjs:514 - fragFindings = result.findings.filter((f) => f.category === 'unit_fragmentation')

### MNT-0409cd1f — Replicated implementation logic inside worker-run-command test

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: code-duplication
- Files: packages/audit-code/tests/worker-run-command.test.mjs
- Summary: The test file worker-run-command.test.mjs duplicates the error/warning partitioning logic from workerRunCommand.ts as a local partitionIssues helper to test it, rather than exporting and testing the production implementation itself.
- Evidence:
  - packages/audit-code/tests/worker-run-command.test.mjs:103 - partitionIssues duplicates the implementation partition loop from workerRunCommand.ts.

### MNT-288dbefe — resolveYamlPathReference resolves ./-prefixed paths from repo root first, inverting conventional same-directory semantics

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: surprising-behavior
- Files: packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_correctness_part-3_ec84cf881d98.json
- Summary: resolveYamlPathReference strips the leading ./ from specifiers and tries repo-root-relative resolution before falling back to the YAML file's directory. A ./ prefix conventionally means 'same directory as the current file', but this implementation prioritizes root-relative matching. This was initially reported as correctness finding COR-001, but the resolution-order choice creates a surprising abstraction that is error-prone to extend.
- Evidence:
  - packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_correctness_part-3_ec84cf881d98.json:49 - the ./ prefix is stripped before resolution
  - packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-extractors_correctness_part-3_ec84cf881d98.json:51 - repo-root-relative is attempted first, YAML-dir-relative is the fallback
  - Current src/extractors/graphManifestEdges/yamlPaths.ts:57-69 - the same resolution-order logic persists in the refactored codebase

### MNT-7c475097 — Route paths use fragile file-path sanitization

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: ambiguous-naming
- Files: packages/audit-code/.audit-artifacts/graph_bundle.json
- Summary: Route paths replace / with _ (e.g., /.tmp_opentoken_src_router.ts), creating collision risk if files differ only by directory structure after sanitization, and the leading / falsely implies an HTTP path.
- Evidence:
  - packages/audit-code/.audit-artifacts/graph_bundle.json:8498 - Route path .tmp_opentoken_.opencode_plugins_opentoken_router.ts collapses separators into underscores with no collision detection.
  - packages/audit-code/.audit-artifacts/graph_bundle.json:8518 - Route path /login is the sole semantic name, highlighting the inconsistency.

### MNT-70c97d00 — runWrapperJsonOutput helper has excessive function length and nested async complexity

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: complex-function
- Files: packages/audit-code/tests/audit-code-wrapper.test.mjs
- Summary: runWrapperJsonOutput in audit-code-wrapper.test.mjs spans 72 lines (99-170) with a inner settle closure, timer management, a settled guard flag, and dual exit paths (onStdoutChunk vs child exit). The async settling logic is hard to follow and prone to race-condition bugs.
- Evidence:
  - packages/audit-code/tests/audit-code-wrapper.test.mjs:99-170 - 72-line function with settle closure (lines 113-129), setTimeout (lines 102-111), dual resolve paths (onStdoutChunk line 134, child exit line 145)

### TST-ef420164 — scanStringAware early exit path is untested

- Severity: low
- Confidence: high
- Lens: tests
- Category: test-coverage-gap
- Files: packages/shared/src/parsing/stringAwareScanner.ts
- Summary: The stringAwareScanner test suite lacks any assertion verifying that returning false from onUnquoted aborts scanner execution early.
- Evidence:
  - packages/shared/src/parsing/stringAwareScanner.ts:72-75 - The scanner returns early when callbacks.onUnquoted returns false, but packages/shared/tests/string-aware-scanner.test.mjs contains no tests that return false or verify early return

### OBS-4b3d5259 — Skipped lint tools lack diagnostic explanation or context in tool status

- Severity: low
- Confidence: high
- Lens: observability
- Category: logging-quality
- Files: packages/audit-code/.audit-artifacts/external_analyzer_results.json
- Summary: The external analyzer results mark ESLint as skipped but omit any details, configuration status, or diagnostic reason why the check was not executed, hindering operations debugging.
- Evidence:
  - packages/audit-code/.audit-artifacts/external_analyzer_results.json:13-17 - ESLint tool status has resolved: false and status: skipped with no reason or message field.

### MNT-d5bc74c2 — SpawnRunController settle lifecycle uses mutable boolean state flags

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: complex-state-management
- Files: packages/shared/src/providers/spawnLoggedCommand.ts
- Summary: SpawnRunController coordinates run completion via four mutable boolean flags (childClosed, pendingLogWrites, settled, timedOut) spread across the settle, maybeSettleFromClose, writeLog, and onHeartbeat methods. The interplay is not immediately obvious — a maintainer must trace through 4+ methods to understand what conditions cause a run to resolve, reject, or hang.
- Evidence:
  - packages/shared/src/providers/spawnLoggedCommand.ts:101-106 - settle() guard checks this.settled before proceeding
  - packages/shared/src/providers/spawnLoggedCommand.ts:116-122 - writeLog() decrements pendingLogWrites and calls maybeSettleFromClose
  - packages/shared/src/providers/spawnLoggedCommand.ts:124-156 - maybeSettleFromClose coordinates childClosed, pendingLogWrites, settled, and timedOut
  - packages/shared/src/providers/spawnLoggedCommand.ts:261-269 - timeout handler sets timedOut, sends SIGTERM, schedules SIGKILL

### MNT-d2601c34 — splitPythonImportList has excessive complexity with manual parser state

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: complex-function
- Files: packages/audit-code/src/extractors/graphPythonImports.ts
- Summary: splitPythonImportList (53 lines) manually tracks quote state, escape sequences, and parenthesis depth in a single loop, making the function harder to reason about and modify than necessary.
- Evidence:
  - packages/audit-code/src/extractors/graphPythonImports.ts:127-180 - Function splits a Python import list while manually managing quote, escape, and paren-depth state in a single 53-line loop

### OBS-e7f2eed6 — Stale lock cleanup failure is silently swallowed

- Severity: low
- Confidence: high
- Lens: observability
- Category: silent-error-suppression
- Files: packages/shared/src/quota/fileLock.ts
- Summary: In acquireLock(), when a stale lock is detected and unlink() fails, the error is caught and discarded without any log. This makes it impossible to distinguish expected races from unexpected filesystem failures during lock cleanup.
- Evidence:
  - packages/shared/src/quota/fileLock.ts:38-45 - catch block after unlink(lockPath) is empty with only a comment; no logging of the error or the stale lock path

### MNT-29382fae — Static and narrow ignore patterns in DEFAULT_IGNORES

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: inconsistent-abstractions
- Files: packages/audit-code/.audit-artifacts/file_disposition.json
- Summary: DEFAULT_IGNORES in fsIntake.ts uses a static list of exact folder names to ignore. When anomalous directory structures are created (such as Codeauditor-lambda.audit-artifacts/), the scanner lacks fallback pattern-based or wildcard rules to ignore them, resulting in these directories being crawled and processed.
- Evidence:
  - packages/audit-code/.audit-artifacts/file_disposition.json:1224 - 'Codeauditor-lambda.audit-artifacts/session-config.json' was crawled due to lack of pattern-based ignore logic in fsIntake.ts.

### OBS-6da9692d — Task-context load failures are silent across dispatch pipelines

- Severity: low
- Confidence: high
- Lens: observability
- Category: silent-degraded-validation-context
- Files: packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/dispatch_observability_c793d60902a2.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/dispatch_observability_c793d60902a2.json
- Summary: The dispatch validation helpers and the CLI merge-and-ingest command continue without task metadata when pending-audit-tasks.json cannot be parsed or a result contains a mismatched task_id, but they emit no operator-visible warning. Operators see valid-looking output without knowing that line-count, task-context, or attribution checks were degraded.
- Evidence:
  - dispatch_observability_c793d60902a2.json:30 - pending task manifest parse failure is caught with an empty catch, no stderr warning emitted.
  - dispatch_observability_c793d60902a2.json:43 - single-result validator uses the same silent fallback, leaving task as null.

### MNT-1d82f425 — Test claims to verify concurrency but cannot actually assert the property

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: misleading-naming
- Files: packages/audit-code/tests/line-index.test.mjs
- Summary: Test 'buildLineIndexForPaths concurrent countLines calls never exceed LINE_COUNT_BATCH_SIZE' at line 258 cannot intercept countLines without module mocking and admits it only verifies that all paths appear in the result, not the concurrency bound. This creates a false sense of safety if the batching logic changes.
- Evidence:
  - packages/audit-code/tests/line-index.test.mjs:258 - Test name claims concurrency bound assertion
  - packages/audit-code/tests/line-index.test.mjs:268-272 - Comment admits the test cannot verify the claimed property

### MNT-c6693d57 — Test-only underscore-aliased re-exports in audit-code-wrapper-lib.mjs

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: test-coupling
- Files: packages/audit-code/audit-code-wrapper-lib.mjs, packages/audit-code/audit-code-wrapper-install-hosts.mjs
- Summary: audit-code-wrapper-lib.mjs:12-15 re-exports symbols as underscore-aliased names (_INSTALL_HOST_ORDER, _INSTALL_HOST_DEFINITIONS, _getInstallHostKeys, _getInstallProfile) solely for consumption by host-bootstrap-descriptors.test.mjs. This couples the public library surface to internal test imports.
- Evidence:
  - packages/audit-code/audit-code-wrapper-lib.mjs:12-15 - underscore-aliased re-exports
  - packages/audit-code/audit-code-wrapper-install-hosts.mjs:1132-1139 - comment says 'Keep these so the test import chain resolves'

### MNT-97cbaf84 — Tight coupling of analyzer dependency resolution to console.error

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: tight-coupling
- Files: packages/shared/src/tooling/analyzerDeps.ts
- Summary: The analyzer dependency resolution functions in analyzerDeps.ts use hardcoded console.error calls directly instead of using the repository's standard RunLogger or an injectable logging interface, making it difficult to control or capture diagnostic output.
- Evidence:
  - packages/shared/src/tooling/analyzerDeps.ts:114 - console.error resolves dependency via repo directly without standard logger mapping
  - packages/shared/src/tooling/analyzerDeps.ts:121 - console.error resolves dependency via cache directly
  - packages/shared/src/tooling/analyzerDeps.ts:168 - console.error reports cache installs directly to console.error

### MNT-c666ef4f — TODO(verify) comments signal unverified Codex CLI assumptions in production code

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: incomplete-specification
- Files: packages/shared/src/providers/codexProvider.ts
- Summary: Three TODO(verify) comments in codexProvider.ts document unresolved assumptions about the Codex CLI invocation pattern, stdin convention, and rate-limit introspection. These represent incomplete knowledge embedded in production code that makes future changes riskier — a maintainer cannot distinguish verified behavior from unverified assumptions without external confirmation.
- Evidence:
  - packages/shared/src/providers/codexProvider.ts:15-19 - TODO(verify) about Codex CLI subcommand and prompt flag shape
  - packages/shared/src/providers/codexProvider.ts:49-52 - TODO(verify) about stdin vs flag prompt delivery
  - packages/shared/src/providers/codexProvider.ts:69-76 - TODO(verify) about rate-limit header introspection

### MNT-94dd9425 — Triplicated normalizeNewlines utility function

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: duplicated-code
- Files: packages/audit-code/audit-code-wrapper-install-hosts.mjs, packages/audit-code/audit-code-wrapper-io.mjs, packages/audit-code/audit-code-wrapper-legacy.mjs
- Summary: The normalizeNewlines (replace \r\n with \n) function is defined identically in three modules: install-hosts.mjs:50, io.mjs:123, and legacy.mjs:5. Any behavioral change to line-ending normalization requires updating all three copies.
- Evidence:
  - packages/audit-code/audit-code-wrapper-install-hosts.mjs:50 - normalizeNewlines defined
  - packages/audit-code/audit-code-wrapper-io.mjs:123 - normalizeNewlines defined
  - packages/audit-code/audit-code-wrapper-legacy.mjs:5 - normalizeNewlines defined

### MNT-6596c1bc — Undocumented magic constant RECENT_RUN_LIMIT in statusCommand.ts

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: magic-constant
- Files: packages/audit-code/src/cli/statusCommand.ts
- Summary: RECENT_RUN_LIMIT = 5 is used as an arbitrary limit on recent runs displayed in status output without documentation or configuration.
- Evidence:
  - packages/audit-code/src/cli/statusCommand.ts:46 - const RECENT_RUN_LIMIT = 5

### MNT-d75200ed — Undocumented magic number thresholds in finding dedup

- Severity: low
- Confidence: high
- Lens: maintainability
- Category: magic-constants
- Files: packages/audit-code/src/reporting/mergeFindings.ts
- Summary: The Jaccard similarity thresholds in deduplicateSameLens (0.35, 0.45) and deduplicateCrossLens (0.4, 0.5) are hard-coded literals with no explanation of how they were calibrated. Anyone tuning dedup behavior must reverse-engineer the rationale.
- Evidence:
  - packages/audit-code/src/reporting/mergeFindings.ts:150 - const threshold = catMatch ? 0.35 : 0.45; — no comment explaining why 0.35 vs 0.45
  - packages/audit-code/src/reporting/mergeFindings.ts:196 - const threshold = catMatch ? 0.4 : 0.5; — different values from same-lens dedup, no rationale

### OBS-4e642510 — warnIfNotGitRepo uses plain console.warn with no structured format

- Severity: low
- Confidence: high
- Lens: observability
- Category: logging-quality
- Files: packages/audit-code/src/cli/args.ts
- Summary: The warnIfNotGitRepo function in args.ts writes a warning via console.warn without any prefix, structured format, or telemetry hook. This makes it indistinguishable from other console output in log aggregation.
- Evidence:
  - packages/audit-code/src/cli/args.ts:225 - console.warn with plain interpolated string, no prefix or structure

### ARC-4bb18f75 — 4 orphan unit(s) with no graph connections

- Severity: low
- Confidence: medium
- Lens: architecture
- Category: orphan_units
- Files: .codex/hooks.json, .remediation-artifacts/run.log.jsonl, .vscode/mcp.json, audit/audit-findings.json
- Summary: Units [-codex, -remediation-artifacts, -vscode, audit] have no import, call, or reference edges in the dependency graph. They may be dead code, or the graph extraction missed their connections.

### MNT-15e4ef9a — buildAuditCodeHandoff mixes artifact path construction with business logic

- Severity: low
- Confidence: medium
- Lens: maintainability
- Category: excessive-function-length
- Files: packages/audit-code/src/supervisor/operatorHandoff.ts
- Summary: buildAuditCodeHandoff (operatorHandoff.ts:318-418, ~95 lines) constructs artifact paths, builds suggested inputs, suggested commands, interactive provider hints, file maps, and quick-start commands inline rather than delegating to separate builders. Adding a new handoff concern requires editing the middle of this function.
- Evidence:
  - packages/audit-code/src/supervisor/operatorHandoff.ts:318-418 - single function constructing artifact paths (330-360), suggested inputs (361-366), handoff object (368-394), quick-start/file-map (397-414)

### OBS-57c8ddd7 — Critical flow analysis lacks per-flow timing and confidence metadata

- Severity: low
- Confidence: medium
- Lens: observability
- Category: missing-metrics
- Files: packages/audit-code/.audit-artifacts/critical_flows.json
- Summary: critical_flows.json records 14 flows with a single generic confidence per flow but no timing, duration, or analysis-step telemetry. The generic note on every flow reduces diagnostic value for understanding which classifications may be unreliable.
- Evidence:
  - packages/audit-code/.audit-artifacts/critical_flows.json:15-19 - all interface flows share identical notes text
  - packages/audit-code/.audit-artifacts/critical_flows.json:349 - fallback_required: true with no detail on what fell back

### OBS-ca696134 — Delegated command failures lose command context in error reporting

- Severity: low
- Confidence: medium
- Lens: observability
- Category: low-context-child-process-error
- Files: packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/module-audit-code-wrapper-lib-mjs_observability_cb5beb7fdcfc.json
- Summary: The wrapper delegates to npm or dist/index.js for operations such as submit-packet, merge-and-ingest, or run-to-completion. When the child exits non-zero without useful stderr, the reported error is only the numeric exit code with no command name, cwd, root, or artifacts directory. Operators and automation lack the operational context needed to diagnose which backend step failed.
- Evidence:
  - module-audit-code-wrapper-lib-mjs_observability_cb5beb7fdcfc.json:20 - summary identifies that non-zero exit reports only numeric code without command context.
  - module-audit-code-wrapper-lib-mjs_observability_cb5beb7fdcfc.json:36 - evidence: on non-zero exit thrown message is just stderr or exit code.
  - module-audit-code-wrapper-lib-mjs_observability_cb5beb7fdcfc.json:38 - evidence: runDistCommand delegates through generic run helper sharing low-context path.

### OBS-cb52b4e2 — installToCache npm install failure produces no log

- Severity: low
- Confidence: medium
- Lens: observability
- Category: missing-error-logging
- Files: packages/shared/src/tooling/analyzerDeps.ts
- Summary: installToCache() returns a structured result on failure but never emits any log. A failed npm install is surfaced only to the immediate caller; if the caller silently falls back to 'absent', there is no observable record of the installation failure.
- Evidence:
  - packages/shared/src/tooling/analyzerDeps.ts:158-175 - on npm install failure (status !== 0) or post-install verification failure, returns {ok: false, error: ...} with no process.stderr.write or equivalent

### MNT-e76b4117 — Long conditional chain: lensVerificationTriggers with many boolean checks

- Severity: low
- Confidence: medium
- Lens: maintainability
- Category: function-length
- Files: packages/audit-code/src/orchestrator/selectiveDeepening/lensVerification.ts
- Summary: lensVerificationTriggers (lines 51-139) is ~88 lines with 6 distinct pre-computation steps (findingPaths, externalPathsInScope, cleanResults, etc.) followed by 10 sequential boolean trigger checks. The coupling between pre-computed values and trigger decisions makes it hard to verify that every trigger is correctly guarded.
- Evidence:
  - packages/audit-code/src/orchestrator/selectiveDeepening/lensVerification.ts:56-87 - pre-computes 6 different derived collections
  - packages/audit-code/src/orchestrator/selectiveDeepening/lensVerification.ts:89-138 - 10 sequential trigger checks with conditionals

### MNT-96e0a844 — Long orchestration: buildSelectiveDeepeningTasks sequences 6 strategies inline

- Severity: low
- Confidence: medium
- Lens: maintainability
- Category: function-length
- Files: packages/audit-code/src/orchestrator/selectiveDeepening/index.ts
- Summary: buildSelectiveDeepeningTasks (lines 38-178) is ~140 lines that manually sequences finding-followup, conflict, steward-followup, runtime-validation, lens-verification, and high-risk-clean strategies with shared budget tracking via pushIfNew. Adding a new deepening strategy requires modifying this central function.
- Evidence:
  - packages/audit-code/src/orchestrator/selectiveDeepening/index.ts:60-66 - pushIfNew budget-gate closure
  - packages/audit-code/src/orchestrator/selectiveDeepening/index.ts:68-89 - finding followup strategy
  - packages/audit-code/src/orchestrator/selectiveDeepening/index.ts:91-101 - conflict strategy
  - packages/audit-code/src/orchestrator/selectiveDeepening/index.ts:103-112 - steward followup strategy
  - packages/audit-code/src/orchestrator/selectiveDeepening/index.ts:114-146 - runtime validation strategy
  - packages/audit-code/src/orchestrator/selectiveDeepening/index.ts:148-155 - lens verification strategy
  - packages/audit-code/src/orchestrator/selectiveDeepening/index.ts:157-175 - high-risk-clean strategy

### TST-7ec04338 — Missing negative test for extractFromHeaderObject when JSON has only remaining fields without limit fields

- Severity: low
- Confidence: medium
- Lens: tests
- Category: missing-test-cases
- Files: packages/audit-code/src/quota/headerExtraction.ts
- Summary: The JSON extraction path in headerExtraction.ts calls extractFromHeaderObject which returns null when both requests_per_minute and input_tokens_per_minute are absent. No test exercises the case where JSON contains only remaining_requests/remaining_tokens without limit fields, causing a silent null return from the JSON path.
- Evidence:
  - packages/audit-code/tests/header-extraction.test.mjs: all JSON object tests include both rpm and tpm limit fields
  - headerExtraction.ts:126 returns null at extractFromHeaderObject line 147 when rpm==null && tpm==null

### OBS-c35c4b50 — Missing resolution error and coverage diagnostics

- Severity: low
- Confidence: medium
- Lens: observability
- Category: insufficient-error-reporting
- Files: packages/audit-code/.audit-artifacts/graph_bundle.json
- Summary: The graph bundle does not record which dependency resolutions failed, which files were skipped, or any success/failure counts. Silent omission of unresolved imports or unresolvable references makes it impossible to monitor graph-generation health or debug incomplete graphs without re-running the full pipeline.
- Evidence:
  - packages/audit-code/.audit-artifacts/graph_bundle.json:2-3 - Only 'imports', 'calls', 'references', and 'routes' keys present; no 'errors', 'warnings', 'unresolved', or 'resolved_counts' diagnostic sections.
  - packages/audit-code/.audit-artifacts/graph_bundle.json:7653 - 'calls' is an empty array [] with no surrounding context to distinguish 'extraction not attempted' from 'extraction ran and found nothing'.
  - packages/audit-code/src/types/analyzerCapability.ts:9-18 - Edge-count and routing provenance is tracked in a separate analyzer_capability.json artifact rather than embedded in the graph bundle itself, requiring multi-artifact correlation for full observability.

### OBS-bf664ef3 — Missing Telemetry Context and Limit Metadata in Quota Details

- Severity: low
- Confidence: medium
- Lens: observability
- Category: telemetry
- Files: packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/dispatch-quota.json
- Summary: The dispatch-quota.json file has key telemetry and limit metadata fields (model, requests_per_minute, input_tokens_per_minute, output_tokens_per_minute, and quota_source_snapshot) set to null, which limits scheduler debuggability.
- Evidence:
  - packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/dispatch-quota.json:4 - "model": null
  - packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/dispatch-quota.json:8 - "requests_per_minute": null

### OBS-a925bb4c — No task dependency or execution ordering metadata

- Severity: low
- Confidence: medium
- Lens: observability
- Category: missing_observability_context
- Files: packages/audit-code/.audit-artifacts/audit_tasks.json
- Summary: Tasks lack depends_on, order, or sequence fields. From an observability perspective, this prevents tracing execution flow, detecting blocked or starved tasks, and understanding pipeline sequencing from the plan metadata alone.
- Evidence:
  - packages/audit-code/.audit-artifacts/audit_tasks.json:2-4844 - Multiple task entries inspected across the file; none contain depends_on, order, or sequence fields

### REL-986966df — No timeout or abort mechanism on individual fs operations inside acquireLock

- Severity: low
- Confidence: medium
- Lens: reliability
- Category: missing-timeout
- Files: packages/shared/src/quota/fileLock.ts
- Summary: The writeFile, unlink, and stat calls inside acquireLock have no per-operation timeout. If the filesystem hangs (NFS stall, network drive, high I/O pressure), the lock acquisition loop can block indefinitely without respect to the overall deadline, since the deadline check only occurs after the fs call returns.
- Evidence:
  - packages/shared/src/quota/fileLock.ts:40 - writeFile with no timeout
  - packages/shared/src/quota/fileLock.ts:55-56 - unlink with no timeout
  - packages/shared/src/quota/fileLock.ts:65 - deadline check only happens after fs call returns

### MNT-71b801ee — O(n^2) scan in extractHeuristicAuthSessionEdges couples auth heuristic to full repo manifest

- Severity: low
- Confidence: medium
- Lens: maintainability
- Category: tight-coupling
- Files: packages/audit-code/src/extractors/graph.ts
- Summary: extractHeuristicAuthSessionEdges (graph.ts:459-487) iterates every repo manifest file for every auth-named file to find session-named files. This O(n^2) coupling means the heuristic's maintainability degrades as the repository grows.
- Evidence:
  - packages/audit-code/src/extractors/graph.ts:459-487 - full repoManifest.files iteration per auth file at line 469

### COR-4bfc5a1c — Potential incorrect line_index used for requeue task enrichment in runResultIngestionExecutor

- Severity: low
- Confidence: medium
- Lens: correctness
- Category: incorrect-variable-reference
- Files: packages/audit-code/src/orchestrator/ingestionExecutors.ts
- Summary: In ingestionExecutors.ts line 174, `lineIndex` is built from `deepenedTasks` (the deepened bundle's tasks), but the `pendingRequeueTasks` on lines 177-187 are enriched using this same lineIndex. The requeue tasks reference paths from `requeuePayload.tasks` which may include paths not present in `deepenedTasks`, causing those paths to be silently omitted from `file_line_counts` instead of being looked up from the original coverage matrix or sizeIndex.
- Evidence:
  - packages/audit-code/src/orchestrator/ingestionExecutors.ts:174 - `const lineIndex = lineIndexFromTasks(deepenedTasks)` builds index only from deepened tasks
  - packages/audit-code/src/orchestrator/ingestionExecutors.ts:182-186 - pendingRequeueTasks enrichment uses `lineIndex[p]` which will be undefined for paths not in deepenedTasks
  - packages/audit-code/src/orchestrator/planningExecutors.ts:100-104 - The same pattern exists in planningExecutors but uses the passed-in `lineIndex` parameter

### MNT-4a99b757 — providers-remediation test file uses process.stderr.write monkey-patching pattern for diagnostic verification

- Severity: low
- Confidence: medium
- Lens: maintainability
- Category: inconsistent-abstractions
- Files: packages/audit-code/tests/providers-remediation.test.mjs
- Summary: ClaudeCodeProvider (line 296) and OpenCodeProvider (line 346) diagnostic tests both manually monkey-patch process.stderr.write to capture stderr output, then restore it in try/finally. This shared testing concern is duplicated across two tests and could be extracted into a reusable helper like captureStderr(fn).
- Evidence:
  - packages/audit-code/tests/providers-remediation.test.mjs:307-312 - ClaudeCodeProvider test monkey-patches process.stderr.write
  - packages/audit-code/tests/providers-remediation.test.mjs:356-361 - OpenCodeProvider test duplicates the same monkey-patch pattern

### OBS-f3525202 — Quota scheduler wave decisions emit no operational log

- Severity: low
- Confidence: medium
- Lens: observability
- Category: missing-operational-logging
- Files: packages/shared/src/quota/scheduler.ts
- Summary: scheduleWave() applies multiple caps (RPM, TPM, cooldown, ramp-up, host concurrency) and returns a WaveSchedule, but emits no log of the final wave_size, which cap was binding, or why. Diagnosing unexpectedly conservative or liberal scheduling requires re-deriving the decision from scratch.
- Evidence:
  - packages/shared/src/quota/scheduler.ts:46-211 - no process.stderr.write, console.log, or structured log emitted anywhere in scheduleWave(); the returned WaveSchedule.source and .confidence fields carry provenance but are not emitted to any observable channel

### MNT-e7373005 — Recursive descent without depth limit in collectPackageEntrypointValues

- Severity: low
- Confidence: medium
- Lens: maintainability
- Category: excessive-function-length
- Files: packages/audit-code/src/extractors/graphManifestEdges/packageJson.ts
- Summary: collectPackageEntrypointValues (packageJson.ts:20-46) recursively descends into nested objects and arrays without a depth limit. A deeply nested package.json exports field could cause a stack overflow.
- Evidence:
  - packages/audit-code/src/extractors/graphManifestEdges/packageJson.ts:20-46 - recursive calls without depth guard at lines 34 and 44

### MNT-4a73b42e — resolveFromPath mixes PATH parsing, extension probing, and platform logic in one function

- Severity: low
- Confidence: medium
- Lens: maintainability
- Category: unclear-abstraction
- Files: packages/audit-code/src/orchestrator/localCommands.ts
- Summary: resolveFromPath (localCommands.ts:35-80) combines command-trim validation, absolute-path checks, PATH-environment parsing, PATHEXT extension probing with Win32-specific edge cases, and nested directory/extension iteration in a single 46-line function. The extension-probing strategy (effectiveExtensions logic) is expressed as a complex ternary on platform+extname that could be a named helper.
- Evidence:
  - packages/audit-code/src/orchestrator/localCommands.ts:35-80 - Full function body showing PATH split, PATHEXT probe, and nested loops

### OPR-7e7f52c7 — Smoke scripts use unstructured stderr logging with no verbosity control

- Severity: low
- Confidence: medium
- Lens: operability
- Category: poor-logging
- Files: packages/audit-code/scripts/smoke-linked-audit-code.mjs, packages/audit-code/scripts/smoke-packaged-audit-code.mjs
- Summary: Both smoke scripts write step/detail/success messages to stderr using fixed-format prefix strings with no structured log output, no log levels, and no configurable verbosity. The liveCommandOutput flag is hardcoded to true, forcing child-process stdout/stderr passthrough with no way to suppress it.
- Evidence:
  - packages/audit-code/scripts/smoke-linked-audit-code.mjs:16 - AUDIT_CODE_VERBOSE is the only verbosity control, used only for npm log level.
  - packages/audit-code/scripts/smoke-linked-audit-code.mjs:17 - liveCommandOutput is hardcoded to true.
  - packages/audit-code/scripts/smoke-linked-audit-code.mjs:190 - The step() function writes only a fixed-format '[smoke:linked] step:' prefix to stderr with no structured fields.
  - packages/audit-code/scripts/smoke-packaged-audit-code.mjs:37 - liveCommandOutput is also hardcoded to true.

### REL-787a811b — Stale lock cleanup has minor TOCTOU window between unlink and retry

- Severity: low
- Confidence: medium
- Lens: reliability
- Category: race-condition
- Files: packages/shared/src/quota/fileLock.ts, packages/shared/src/quota/fileLock.ts
- Summary: releaseLock reads the lock file content to verify ownership (line 76) then calls unlink (line 81). If another process steals and releases the lock between these two operations, the original owner may unlink a lock file it no longer owns. The next acquirer re-creates it via wx, so recovery is automatic, but this is a theoretical reliability concern under extreme contention.
- Evidence:
  - packages/shared/src/quota/fileLock.ts:54 - isLockStale returns true, then unlink is called
  - packages/shared/src/quota/fileLock.ts:58 - continue back to while loop for retry writeFile via wx flag
  - packages/shared/src/quota/fileLock.ts:70 - 50ms RETRY_INTERVAL_MS before next writeFile attempt
  - packages/shared/src/quota/fileLock.ts:76 - readFile checks owner token
  - packages/shared/src/quota/fileLock.ts:81 - unlink deletes only after owner check passes
  - packages/shared/src/quota/fileLock.ts:77-79 - silent return if token doesn't match (lock stolen)

### MNT-75c0a87a — Unexplained magic constant FINALIZATION_CYCLE_TOLERANCE

- Severity: low
- Confidence: medium
- Lens: maintainability
- Category: magic-constants
- Files: packages/audit-code/src/cli/nextStepCommand.ts
- Summary: nextStepCommand.ts defines FINALIZATION_CYCLE_TOLERANCE = 16 (line 457) without explaining why 16 was chosen. The constant's name is descriptive, and it is named rather than bare (which is good), but the specific value has no rationale comment. A comment linking the value to typical obligation counts or trace length expectations would help future maintainers tune it.
- Evidence:
  - packages/audit-code/src/cli/nextStepCommand.ts:457 — const FINALIZATION_CYCLE_TOLERANCE = 16; no comment justifies why 16 iterations without new artifact states constitutes a cycle

### MNT-c93dbd0d — Finding IDs use a flat global sequence without scoping to source run or lens

- Severity: info
- Confidence: high
- Lens: maintainability
- Category: inconsistent-naming
- Files: packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-reporting_maintainability_dd4a047bc130.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-supervisor_maintainability_6756ca817e65.json
- Summary: Finding IDs like MNT-005 and MNT-006 appear sequential across result files from different audit units (reporting vs supervisor), with no prefix or namespace to prevent collisions when artifacts from independent passes are merged.
- Evidence:
  - src-reporting_maintainability_dd4a047bc130.json:22 - id MNT-005 in a src-reporting result
  - src-supervisor_maintainability_6756ca817e65.json:17 - id MNT-006 in a src-supervisor result, implying cross-unit sequential numbering without explicit coordination

### OBS-3e40e474 — Flat status enum with no lifecycle observability

- Severity: info
- Confidence: high
- Lens: observability
- Category: missing-operational-telemetry
- Files: packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/pending-audit-tasks.json
- Summary: All 273 tasks use status 'pending' with no in_progress, completed, or failed states, no transition timestamps, and no retry/attempt counters. This provides no observability into task lifecycle progression.
- Evidence:
  - packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/pending-audit-tasks.json - All 273 tasks have status 'pending'; no task has attempt_count, retry_count, or status_history

### OBS-844af2bf — Inconsistent task tagging reduces observability dimensionality

- Severity: info
- Confidence: high
- Lens: observability
- Category: incomplete-telemetry-context
- Files: packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/pending-audit-tasks.json
- Summary: Only 117 of 273 tasks (43%) have tags. Tags serve as observability dimensions for filtering and aggregation; their absence on 156 tasks limits drill-down capability.
- Evidence:
  - packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/pending-audit-tasks.json - Only 117/273 task objects include a tags array; 156 tasks have no tags key at all

### MNT-c2893486 — Inconsistent task_id naming convention

- Severity: info
- Confidence: high
- Lens: maintainability
- Category: naming-convention
- Files: packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/pending-audit-tasks.json
- Summary: Task IDs use inconsistent delimiter styles (colons vs hyphens) and several entries start with an unconventional leading dash (e.g., -tmp-opentoken:correctness:part-1). This makes parsing, sorting, and shell-scripting against these IDs error-prone.
- Evidence:
  - packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/pending-audit-tasks.json:3 - flow:flow:surface:src-types-workerSession-ts:security:part-1 (colon-delimited)
  - packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/pending-audit-tasks.json:81 - -tmp-opentoken:correctness:part-1 (leading dash)
  - packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/pending-audit-tasks.json:681 - Codeauditor-lambda-audit-artifacts:correctness (no colon prefix)
  - packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/pending-audit-tasks.json:696 - dispatch:correctness (shortest pattern)

### MNT-ae7bc99f — Inconsistent withTempDir definition — local vs shared import

- Severity: info
- Confidence: high
- Lens: maintainability
- Category: inconsistent-abstractions
- Files: packages/audit-code/tests/observability-signals.test.mjs, packages/audit-code/tests/orchestration.test.mjs
- Summary: observability-signals.test.mjs defines its own withTempDir locally with a hardcoded tempdir prefix, while orchestration.test.mjs imports a parameterized version from the shared helpers/withTempDir.mjs module.
- Evidence:
  - packages/audit-code/tests/observability-signals.test.mjs:32 - Local withTempDir definition with hardcoded prefix 'audit-code-obs-'
  - packages/audit-code/tests/orchestration.test.mjs:115 - Shared withTempDir import from helpers/withTempDir.mjs accepting prefix parameter

### MNT-7aa8b6c0 — Magic number 24 in renderAnchorPreview anchor limit

- Severity: info
- Confidence: high
- Lens: maintainability
- Category: magic-constant
- Files: packages/audit-code/src/cli/dispatch.ts
- Summary: renderAnchorPreview in dispatch.ts:288 uses the literal 24 as an anchor preview slice limit with no named constant explaining why 24 was chosen. Nearby functions consistently extract constants (LARGE_FILE_PACKET_TARGET_LINES, SMALL_MODEL_HINT_MAX_LINES, etc.) making this omission stand out.
- Evidence:
  - packages/audit-code/src/cli/dispatch.ts:288 - .slice(0, 24) in renderAnchorPreview uses an unexplained literal instead of a named constant like ANCHOR_PREVIEW_LIMIT, unlike sibling constants at lines 54-57

### OBS-4d90afa3 — Run Ledger Lock Contention Log Lacks Telemetry Context

- Severity: info
- Confidence: high
- Lens: observability
- Category: logging-quality
- Files: packages/audit-code/src/supervisor/runLedger.ts
- Summary: The lock contention warning logged when acquiring the run ledger lock lacks context such as timestamp, process ID, or run ID, making it difficult to correlate contention events across concurrent executions.
- Evidence:
  - packages/audit-code/src/supervisor/runLedger.ts:37-39 - Lock contention warning written to stderr without timestamp, PID, or run ID context.

### MNT-d53b9f50 — Evidence strings embed structured data in ad-hoc delimiter format

- Severity: info
- Confidence: medium
- Lens: maintainability
- Category: magic-format
- Files: packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-quota_tests_part-2_4ea5974862ef.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-reporting_maintainability_dd4a047bc130.json, packages/audit-code/.audit-artifacts/runs/20260526T061751437Z_audit_tasks_completed_001/task-results/src-supervisor_maintainability_6756ca817e65.json
- Summary: Evidence entries use the format path:line - description (e.g., "src/quota/state.ts:147 - recordWaveOutcome takes the file lock"), encoding path, line number, and description into a single string. Consumers must parse this format rather than reading structured fields.
- Evidence:
  - src-quota_tests_part-2_4ea5974862ef.json:50 - "src/quota/state.ts:147 - recordWaveOutcome takes the file lock and delegates to recordWaveOutcomeUnsafe"
  - src-reporting_maintainability_dd4a047bc130.json:38 - "src/reporting/mergeFindings.ts:149 - deduplicateSameLens groups findings..."
  - src-supervisor_maintainability_6756ca817e65.json:40 - "src/supervisor/operatorHandoff.ts:63 - Handoff artifact filenames are declared as independent constants..."

### OBS-8a6d6f05 — No dispatch-file metadata for system health

- Severity: info
- Confidence: medium
- Lens: observability
- Category: missing-observability
- Files: packages/audit-code/.audit-artifacts/dispatch/current-tasks.json
- Summary: The dispatch file itself lacks metadata such as generated_at, task_count, version, or schema ref, making it impossible to observe dispatch system health from this artifact alone.
- Evidence:
  - packages/audit-code/.audit-artifacts/dispatch/current-tasks.json:1 - The file opens directly into a JSON array with no envelope or metadata object

### MNT-91151d44 — Oversized test function covering 8 schema contracts

- Severity: info
- Confidence: medium
- Lens: maintainability
- Category: function-length
- Files: packages/audit-code/tests/schema-contracts.test.mjs
- Summary: The 185-line test at line 699-884 validates 8 separate schemas in a single test block with 6 assert.throws calls, making it harder to isolate which schema caused a failure and increasing cognitive load.
- Evidence:
  - packages/audit-code/tests/schema-contracts.test.mjs:699-884 - validates unit_manifest, surface_manifest, graph_bundle, runtime_validation, review_packets, audit_plan_metrics schemas in one 185-line test with 6 assert.throws calls

## Scope and Coverage

This report is deterministic output from the completed audit. Non-auditable files were excluded from scope before task generation.
