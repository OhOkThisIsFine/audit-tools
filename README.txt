Audit-tools source preservation â€” 2026-11-05

This history-isolated branch preserves source/test review material before local cleanup.
It is not an application release, an integration branch, or approval to apply old patches.
No main branch, package release, grant, hook installation or service configuration changes.

source-manifest.json records original commits/parents, exact source paths, SHA256 values,
and dispositions. Patches contain code/tests only; their original run logs and operational
artifacts were deliberately excluded. The preserved current-main base is 9538b256.

The old integrity-refresh and pending-review fixes already have their mechanisms and
regression cases on main. The citation/scratch fix is patch-equivalent to main. Other
patches are quarantined historical attempts: some target retired contracts or weaken
guards for tests. They are retained for review/provenance, NOT endorsed changes.
Review a specific requirement and adapt only useful verified behavior to current main.

documentation-cleanup.patch and documentation-snapshots preserve the four dirty files:
release workflow documentation, obsolete backlog entries and glossary/source-path updates.
They have been checked against current source; backlog removal remains a review decision.
hindsight-post-commit-reference.sh.txt is an inert reference, not an installed hook.

This branch intentionally has one root commit and no old Git ancestry, so excluded local
run artifacts cannot become reachable through a commit parent. No private operational
backup is included. Raw audit/recovery evidence, settings and service/database data must
be preserved separately before deleting their local copies. The source archive does not
replace those backups. Existing source/history on main remains in its normal branches.

Two further working-source snapshots preserve the large uncommitted pinned shared-lifecycle
redesign and the citation-route variant. Their source/tests/schemas/prompts/CI definitions
are retained as inert patches against the recorded main. Generated operational records,
nightly state, private settings, dependency installations and audit results are excluded.
These snapshots require substantial independent qualification before any integration.
The design reference records the engineering proposal, not an approved runtime rollout.
