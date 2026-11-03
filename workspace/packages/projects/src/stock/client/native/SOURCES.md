# Limited native client object-layer migration

Source: DeepSeek DSH `639ed015397290b3745d163aafe02ffee4aa3f84`, MIT.

- `packages/api/session-controller/src/client/sessions/session.ts`
- `packages/api/session-controller/src/client/sessions/assistant-stream.ts`
- `packages/api/session-controller/src/client/sessions/projection-store.ts`
- `packages/api/session-controller/src/client/sessions/notifier.ts`

The source is extracted with `git show`, never from the modified worktree. Imports now use released public modules and Projects' typed private Remote adapter. The object-layer constructor is not a public value export. Native session control/event transports, mutable event source, scope minting, UiSession, UiConversation, full native composer/Chat and tool rendering use public entrypoints. `time-zone.ts` is a local helper. No host source deep import, prototype patch or root service replacement.

Common dictionary pair: `packages/client/locale/src/locales/{en,zh}.ts`, same commit and MIT license; copied unchanged apart from source header.

The `session.ts` child-prompt request-id preservation fix is adapted from the same upstream path at `1f81c047fc48fa190a683e469daa699857e9afe8` (DSH 0.2.1-rc.3). Its remaining original object-layer implementation retains the rc.2 provenance above; this is not a wholesale replacement of the source record.

Local receipt adaptation: a native `user/message` hands its identified submission echo to Chat immediately, while retaining the original settlement until the Inbox projection acknowledges the claim. This prevents a lagging control projection from continuing to label consumed input as sending; attachment retirement and transport errors retain their existing owners.
