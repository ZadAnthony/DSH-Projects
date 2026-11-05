# Projects logical input owner

`applyProjectConversation(ctx, config, ports)` is the finite stock Conversation apply/composer template. Call it **instead of** public `applyConversation` on a Projects private Context after `applyUiSession`, before installing the native commands/model/interaction consumers. It uses the actual stock public `UiConversation` and `ConversationController`; all Session objects keep their real physical IDs. It returns a `ProjectDraftRegistry`.

The stock public `apply` cannot accept a different input owner: it constructs its own package-private InputHub, installs `input` and `inputActions` in `uiSession.provide`, and closes the composer entry over that instance. Adding a second provider throws a duplicate-source error. This finite template changes that original construction and its captured input dependencies, rather than shadowing a root service or patching a native prototype.

## Domain integration

```ts
let drafts: ProjectDraftRegistry | undefined
ctx.provide('fileUpload', {
  upload: (...args) => {
    if (drafts === undefined) throw new Error('Projects draft owner is not ready')
    return drafts.upload(...args)
  },
})
// Construct ProjectSessions and applyUiSession first.
drafts = applyProjectConversation(ctx, { maxConcurrentFileUploads: 2 }, {
  resolveCarrier: binding => sessions.carrierFor(binding.sessionId),
  isCurrent: address => sessions.isCurrentCarrier(address),
  upload: (address, data, name, signal, progress) => projectsUpload(address, data, name, signal, progress),
})
```

The example names `carrierFor` and `projectsUpload` denote the domain-owned typed ports, not additional methods required on native ISessions. `resolveCarrier` must return the exact `(projectId, logicalSessionId, hostSessionId, sessionCreatedAt, carrierEpoch)` identity for that binding. `carrierEpoch` is the real `ProjectSessionCarrier.sequence`; it is not a UI revision. `isCurrent` checks every field and deletion/writability. The upload port must send the same full captured address to the Projects attachment owner.

After a logical panel replaces its real physical reference, call `drafts.bind(address)`. This changes receiver, history and inbox binding; it never calls `setDraft` or reconstructs the editor. A target may be bound before its first renderer materialization, with the owner created by `shellFor` when the retained binding arrives. `ownerFor(address)?.shell.focus()` is available when the product explicitly returns focus to the input.

Before a **permanent deletion** RPC, call `drafts.invalidateLogical(projectId, logicalSessionId)` for each affected logical session. This records a tombstone, aborts current attempts, releases browser attachments and detaches the editor before any late result can restore it. Normal carrier handoff only changes `isCurrent` and binds the new address; it must not delete or dispose the logical draft owner. Dispose the registry with the private domain.

`captureFor(actx)` provides a releasable exact `CarrierLease` for asynchronous native integrations outside InputShell. Capture before any await; call `lease.assertCurrent()` before a write, pass `lease.address`/`lease.ctx` unchanged, combine its `signal` with the operation signal, and release it in `finally`. An already dispatched request keeps its actual acceptance result; do not check a new target after the response or resend. Old public `conversation.input.for(oldCtx)` and native standard `inputActions` faces refuse mutation/submission after handoff. The composer receives binding-fixed InputActions; its internal shell stays logical and stable.

## Retained state and failure behavior

Each `ProjectDraftOwner` holds the original native SessionInputShell, Lexical runtime, undo history, selection, chip node keys, failed detached sends and browser attachment IDs. The stock public ConversationController continues to own the actual File objects, image preview URLs, generic upload queue and upload snapshots for the private domain. Draft deletion releases its IDs through that real controller.

The resident contenteditable element is moved into a new composer mount on physical SessionProvider replacement. Both the actual DOM node and editor survive; selection uses public Lexical selection cloning, never exported text/JSON or private editor fields. Native decorators/keymaps, clipboard, paste, IME, commands, references, attachment rail, picker/drop, retry, queue/steer, Stop and existing composer slots remain the native implementation.

Picker/drop intake captures the complete address before the stock controller queues an upload Worker. The eventual FileUploadService call reads that captured File lease. An in-flight upload can settle under its original owner; an upload still queued at handoff fails explicitly instead of rebinding or reuploading. Retrying a failed upload is a new explicit action with a new address. A command claim created before handoff retains its original carrier provenance. If a stock claim closure still names that previous carrier, submitting it fails explicitly; selecting the command again creates a fresh claim. Trigger lexicon subscriptions rebind to the replacement controller, while the editor and undo history remain the original ones.

Existing receipts remain bound to the attachment owner that actually admitted them; no receipt is rewritten during handoff.

Plain sends, slash adjudication, reference serialization and claimed commands use a frozen scope captured before asynchronous work. A guard runs again at the actual native `SessionFace.prompt` after the controller's paint/attachment awaits. Expiry fails through InputShell's native failure outlet. Returned business failures are explicit rejections; a thrown admission transport failure is explicitly `PROJECT_INPUT_ADMISSION_UNKNOWN`. There is no automatic retry or new-carrier dispatch. Ordinary failures restore through the native detached-draft logic. Permanent deletion invalidates before settlement, so a late failure cannot resurrect text or attachments.

## Verification

Pure stock published browser factories, actual public renderer/UiSession/ConversationController/UiConversation, and this finite composer assembly are tested with controlled Projects transport/upload ports in `tests/stock-client-draft-native.ts`. Evidence and runnable build/browser scripts are under `.dev/stock-plugin-implementation-20261026/full/ui/draft`. The test covers original editor/DOM/selection/chips/File/upload state across carrier replacement, stale public resolver and standard InputActions faces, old command claims, late replacement lexicons, retained undo history, native failure restoration, unknown admission, asynchronous slash/reference expiry, queued/in-flight uploads, already accepted old input and deletion before late settlement. Normal package installation and full product-domain wiring are the integrating owner's checks.
