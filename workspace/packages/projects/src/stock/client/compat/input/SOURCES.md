# Finite native input/composer sources

Source repository: https://github.com/deepseek-ai/deepseek-harness

Exact commit: `639ed015397290b3745d163aafe02ffee4aa3f84`.

Compatibility target is now DSH 0.2.1-rc.3, `1f81c047fc48fa190a683e469daa699857e9afe8`. Only `client/locales.ts` is replaced with that revision; its per-file commit and hash override the original default in `SOURCES.json`. Other copied files retain their original source hashes, with current local adaptation hashes where changed.

The same adapter also targets the public DSH 0.2.1-rc.5 SDK, `b830ec950faba0a46dda564be3e2d854afed94f1`; this is the recoverable SDK input, distinct from the installed App build. The published Conversation owns its locale namespace declaration. The adapter consumes that SDK's `LocaleKeysOf<'conversation'>` instead of redeclaring the namespace from a copied dictionary. Both dictionaries retain every rc.3 entry and check each other's complete key set; the unused rc.3-only key remains available as local copy. These changes affect types and declaration ownership, with no runtime dictionary or input behavior change.

License: MIT; the full upstream license is preserved in `LICENSE`. `SOURCES.json` lists every copied original path and its original SHA-256. Each source was compared byte-for-byte with `git show <commit>:<path>` before copying. No runtime deep imports of host source paths are used.

This boundary contains the native input shell, submit machine, Lexical editor/chips/keymap, submission preferences, composer and the immediately necessary Conversation apply/skeleton/dock templates. It does not copy the ConversationController, UiConversation, registry/assembler/history core, native React/Cordis, Session Controller, host runtime or native business providers. Public classes and published named types come from `@deepseek-ai/dsh-client-ui-conversation/client` with the stock module identity.

Local differences:

- `client/apply.ts`: uses public UiConversation/ConversationController and published contract types; injects ProjectDraftRegistry rather than native physical-binding InputHub; returns it to the domain. Public standard InputActions are binding/address-fixed adapters, so stale Provider callbacks cannot retarget the logical editor. The original workspace text/attachment transfer is removed because Projects own the logical editor. Picker/drop and retry capture exact upload targets. Native MIME dispatch is the unchanged finite `isImageMediaType` helper from upstream `client/service.ts` (not a public export). An explicit type-only layout import retains the public slot declaration.
- `client/input/facade.ts`: adds captured per-attempt scope dependencies, keeps those dependencies across slash/reference/attachment awaits, and releases attempt leases after settlement. Menu/Space command credentials and adjudication-returned claims retain their origin carrier; an old stock claim closure cannot run under a replacement lease. Original native machine/editor/failure restoration behavior remains. Permanent owner disposal also releases captured scopes.
- `client/input/editor/ComposerContentEditable.tsx`: parks and remounts the same actual DOM element for the same Lexical editor; preserves the editor's public selection object across physical Provider teardown. The original no-session workspace picker still uses its native React keyboard handler.
- `client/input/editor/runtime.ts` and `text-ref.ts`: add an explicit trigger-lexicon rebind when the physical receiver changes. Rebinding rescans with `HISTORY_MERGE_TAG`, preserving the original undo history without a no-content undo step. The rescan helper accepts that optional tag; original callers retain their original behavior.
- `client/input/editor/view-binding.ts`: clones/restores the public Lexical selection around DOM focus so browser focus during remount cannot reset it to the first text node.
- `client/skeleton/DefaultConversationViews.tsx`: removes physical Conversation-store text seeding; the logical editor remains authoritative. Existing mirror/view rendering remains.
- `client/skeleton/ConversationHeader.tsx`: composes the exact original header props from published `PropsRuntime`/`PropsRenderSlots` because that original named alias is not exported publicly.
- `client/queue/QueueDock.tsx`: deduplicates stale Host queue rows against identified submission echoes already handed to Chat by a native consumed message. It retains Host queue authority and pending actions for messages that have not been consumed.
- Other copied template imports of private contract/core paths are switched to their stock public exports. Unchanged files retain their original behavior.

`../../draft` contains newly authored Projects ownership and lease adapters. See its README for the required domain integration. `index.ts` is the new finite-template entrypoint.

The rc.3 adapter supplies semantic `bindDraftPersistence`/`persistDraft`, the header's complete injected face and exact-binding draft initialization. These operations use the retained logical editor; appended initialization keeps existing chip nodes and attachment ownership. The native configuration snapshot no longer contains the removed `mode` field.
