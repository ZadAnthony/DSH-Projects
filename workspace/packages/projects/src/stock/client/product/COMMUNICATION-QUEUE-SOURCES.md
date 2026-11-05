# Pending communication queue adaptation

The native input source remains owned by `../compat/input/SOURCES.md` and its
frozen `SOURCES.json`. This addendum records one user-approved local exception
on 2026-10-28; it does not rewrite the upstream source manifest.

- Adapted file: `../compat/input/client/queue/QueueDock.tsx`.
- Preimage SHA256: `dc786778cf27a0b617b54d3b811ee9f580ee500d67b112d76787c577c8365bfa`.
- Adapted SHA256: `e4c645437ed5525d68d6d8bded4f13b891ebfc489bdfa023f78c86f06e29881b`.
- Exact exception: 13 added and 5 removed lines providing optional
  `presentationFor(row)` content/edit presentation; no Projects-specific logic
  enters the native template. Omitted/undefined presentation keeps its original
  path, queue ordering, count, collapse, local submissions, attachments and actions.
- `communication-queue.tsx` and its CSS module are Projects-authored. The public
  queue slot adapter retains the native winner's injection and locale, renders
  the existing saved-copy communication view, and omits communication Edit.
  Native remove/steer use the original captured Session action ports.
- No other compat file, Host, Remote, saved-message format or permission changed.

The approved proposal, original failure and formal-source validation are retained
under `.dev/frontend-native-20261027/p5/next-20261028/method-review/queue/` in the
project worktree; `.dev` evidence is not part of the distributable source archive.
