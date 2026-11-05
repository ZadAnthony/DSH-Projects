# Offline memory/chat upgrade

**Historical 41.3 offline tool.** This file describes the retained migration module and its former standalone integration. The current 44.3 stock package does not export `@local/dsh-projects/migration` and contains no current migration driver. New-format installation, user-data migration and daily cutover remain separate operations; use the [current installation boundary](../../../../docs/technical/DSH-Projects-原版插件安装与开发.md) and the [historical tool locator](../../../../docs/archive/2026-10-26-current-docs-closeout/MODULE-HISTORY.md#旧离线迁移工具). The calls below are module contracts, not commands available from the current installed plugin.

`memory-chat-migration.ts` upgrades only an explicitly supplied independent data copy. It never opens an application, creates an Agent, schedules old work, calls a model, changes a launcher, or overwrites an existing target root. Actual user migration and daily cutover remain separate authorized operations.

The module retains native logs and existing Markdown memory as their respective original owners. It copies only `projects/`, `sessions/` and `attachments/`; profiles, credentials, derived projection/SQLite caches and external workspaces are excluded. A file copy must have exact bytes, an independent inode and nlink 1. Data symlinks are not followed; unresolved entries remain reported against the preserved source.

## Calls

| Entry | Result |
| --- | --- |
| `inspectMemoryChatData(root)` | Read-only file paths, sizes, modes, SHA256 and unresolved entries; no body text |
| `preflightMemoryChatMigration(root, ports)` | Current Store/memory validation, real canonical native reads, pending request/frozen counts and per-item issues; no repair writes |
| `upgradeMemoryChatCopy({sourceRoot,targetRoot}, ports)` | Absent-target independent copy, explicit v14 relation upgrade, exact source conversion where unique, owner-controlled Bot v2 structural upgrade, index regeneration and report |
| `inspectMemoryChatRecovery(postUpgradeManifest,currentRoot)` | `no-new-data` only when the known file set and bytes match; otherwise `preserve-new-data` and changed paths |
| `preserveMemoryChatRecoveryCopy({currentRoot,targetRoot})` | Another absent-root preservation copy; refuses to certify a source containing unresolved entries and never performs a downgrade |

`ports.openSessions(directory)` must mount the real JSONL persistence provider for the supplied directory and return raw canonical events through a **read** handle. Use `open(id,'read') → read(0) → close()` and dispose that provider. Do not return header-only observations, Query-derived synthetic interrupted-turn closers or mocked success. This module does not import or launch a provider/application itself.

## Historical offline execution contract

Before an authorized real cutover, stop the original work Agents, Bot, schedules, uploads and other writers through their existing lifecycle owners, wait for settlement/flush/close, and retain exact old runtime material plus the closed source data copy. A stable file hash is not proof that writers stopped. The following steps operate on that independent copy; they do not modify a launcher or authorize cutover.

The 41.3 builder published the standalone `@local/dsh-projects/migration` entry separately from its matched Host. That version's offline driver consumed its installed default-resolved JavaScript export and matched JSONL provider. Its driver and instructions are historical materials located through module history; the old root `migration/` links are no longer current files. The following forms preserve that old version's contract only. Do not run them against a current 44.3 installation or treat them as migration authorization:

```text
<NODE> <migration-driver.mjs> preflight --projects-anchor <installed-Projects-package.json> --native-anchor <matched-host-package.json> --source <closed-source-copy> --report <new-preflight.json>
<NODE> <migration-driver.mjs> upgrade --projects-anchor <installed-Projects-package.json> --native-anchor <matched-host-package.json> --source <closed-source-copy> --target <absent-new-copy> --report <new-upgrade.json>
<NODE> <migration-driver.mjs> recovery --projects-anchor <installed-Projects-package.json> --native-anchor <matched-host-package.json> --baseline <new-upgrade.json> --current <new-copy> --report <new-recovery-check.json>
<NODE> <migration-driver.mjs> preserve --projects-anchor <installed-Projects-package.json> --native-anchor <matched-host-package.json> --current <new-copy> --target <absent-preserved-copy> --report <new-preserved.json>
```

All paths are explicit absolute paths. Report parents must exist, while report files and target roots must be absent. Examine item-level limitations and keep partial targets offline. The first two calls preserve the source; `recovery` only compares it with the post-upgrade baseline, and `preserve` keeps all newer bytes without writing over either copy. There is no automatic switch, paid request or destructive rollback step.

## Retained meaning

- `ProjectStore.upgradeCarrierRelations()` owns the v7/v13 to v14 relation representation. Original Project/ProjectSession/host IDs, role, archive and lifecycle facts remain. A legacy terminal record's per-carrier deletion time remains qualified by the relation owner's `lifecycleTimeBasis=project-deletion`; migration does not invent a per-carrier time.
- Legacy message/tool sources are resolved by the shared exact reader. Its compatibility semantics select a unique original consumed message, not the newest text; genuinely ambiguous versions retain the old locator with a limitation. The report retains each old-to-exact mapping. Existing precise source fields, including body digest/stream/range, are preserved without shortening.
- Memory body suffix bytes, revision, scope, author, timestamps, nature and unrelated metadata are retained. File/settings sources remain their original current-file/change-reference semantics; no historical snapshot is invented. Old `work` scopes and `record` sources keep their read-only restrictions. Withdrawal markers never recover withdrawn content.
- Deleted source identities do not reopen lingering raw bytes. Other unreadable or partially deleted sources retain the original locator with their actual limitation.
- `upgradeMemoryBotState()` performs structural conversion. Processed cuts and last results stay unchanged; failed frozen batches and every explicit request remain pending. Historical requests are not granted a fresh automatic attempt. No migration path calls Bot activity, clears requests, advances processed coverage or writes a completed result.
- Unknown/corrupt items are retained in the source, reported and left offline. `status=partial` is not a cutover approval. `upgraded` can still contain intentional `retained` notices; inspect every item rather than interpreting that word as full semantic restoration.

## Recovery and verification

Keep the immutable source copy and exact old runtime material until the authorized cutover succeeds. Before any upgrade-era write, switching back can use the retained old data. After new input/output/memory exists, preserve the entire current copy first. This module intentionally offers no overwrite-old-backup operation and no automatic reverse-format conversion. Old readers that reject new required events must not be pointed at new logs.

`tests/memory-chat-migration.test.ts` records that version's coverage of v7/v13 records, v3/v4 multi-frame logs, exact sources/body ranges, legacy scopes, failed frozen/explicit state, ambiguous/corrupt items, deleted sources, independent copies and recovery after new data. Its helper runs and failures retain their original scope. The former standalone export and matched-host driver do not establish a migration entry in the current stock package. Any future stock-data migration requires a separately confirmed scope and verification against its actual data owners.
