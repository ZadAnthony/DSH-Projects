# Private stock Projects client domain

`index.tsx` is the normal plugin entry (`apply`/`inject`). On the stock root it owns the Projects sidebar item, `main/projects`, the DOM container and explicit host notification subscriptions. It creates `FullProjectClientDomain`, which mounts the complete product inside an independent Context and reuses the existing `src/client/` product components. Those components have been integrated; they are not a remaining P2 migration list.

`await FullProjectClientDomain.create()` acquires a new Cordis `Context` before constructing the domain and cleans it if construction or native activation fails. It owns its Remote shim, native renderer/SlotRegistry, locale, browser-local presentation preferences, `ProjectSessions`, UiSession, UiConversation, logical draft registry, native Lexical composer, Chat renderers, queue/Stop and native tool tree. It installs the product panels/settings/Library/Memory/communication UI, exact-source readers, read-only child domains and eligible native capabilities. No root Session, Conversation, Chat, Queue or Goal provider is replaced. Native UI mounts after its required service activation and the outer React commit. The earlier P0 native assembly is retained only in `tests/stock-client-domain-fixture.tsx`; it is not exported or bundled by the production entry.

## Identity and transport

- `ProjectClientRemotePort` explicitly lists the Projects façade methods; it never accepts arbitrary RPC names and never falls back to ordinary `remote.session`.
- `ProjectClientControlFrame` is Projects' envelope around the unchanged native control frames, with real catalog and status facts. The shim filters native control frames and publishes `api-session/status` only inside this private object.
- Each `SessionBinding`/SessionFace uses the exact `ProjectSessionRecord.hostSessionId`. Logical Project/session IDs never become native Session IDs. Every native send, Stop and page method captures the physical identity in the bound Session object.
- `ProjectSessions` implements public ISessions and independent references. Native public `createScope` establishes the exact scope generation; the public Cordis filter identity permits caller proxies while rejecting old or foreign scopes.
- The native Session constructor is not a public value export. Four limited original object-layer files are migrated under `native/`, with MIT/source notes. The transports, event feed, scope functions and complete UI use published public exports.

## Browser module-table build contract

Shared platform words and actual native public `/client` modules stay external. Stock already normalizes the `/client` suffix onto each registered package factory; no alias rewrite is needed. The browser-safe `SessionId`/sequence helpers, assistant-stream fold, UUID helper and Typert descriptor/error helpers are inline-safe libraries and must be bundled into this plugin. Listing them in `dsh.client.external` does not create a browser factory. Use exact request matching and bundle everything not explicitly requested, matching stock's `clientConfig` policy. See the real module-table verification below.

## Current verification and historical scope

The current 44.3 plugin targets stock DSH `0.2.1-rc.3`. Normal CLI/Web and Desktop installation results, exact exercised scope and limitations belong to the [release record](../../../../../../source/releases/44-latest/README.md). The source tests and controlled browser fixtures establish their stated assembly boundaries; they do not independently prove every installed flow or model behavior. This documentation update runs no new tests and does not rebuild the frozen release.

P0's rc.2 browser/module-table results, original missing-capability list and root-entry failures retain their original historical meaning in [module history](../../../../../../docs/archive/2026-10-26-current-docs-closeout/MODULE-HISTORY.md#stock-client的p0历史). Production Remote shims require the complete Projects port and an explicit carrier capture; live and reader access remain distinct. Model understanding and actual use effects remain unverified.

## Root entry activation and cleanup

The outer plugin mounts its generated Remote contribution first. A child Cordis fiber then declares `remote.projects` together with the root dependencies before reading the namespace. Putting the namespace on the outer injection set would prevent the contribution from mounting; reading it directly after `$mount` fails Cordis access checks. Original apply errors are logged with their real Error/cause/stack, followed by reverse cleanup of acquired UI, domain and Remote owners. Cleanup errors are reported separately without replacing the original error.

The original stock ModuleSystem-to-root-plugin fixture verified activation, mount-conflict ownership preservation and constructor-failure Remote cleanup with a controlled RPC carrier. Its original result and the earlier .3 packaged root-entry failure are indexed in module history; the earlier Domain-only fixture did not exercise root namespace injection. These results are not relabeled as the final 44.3 Desktop run.

## DSH 0.2.1-rc.3 compatibility

The latest target is upstream `1f81c047fc48fa190a683e469daa699857e9afe8`. Its UiSession access hooks receive a private deny-by-default source for native root endpoints; Projects operations continue through their own exact-carrier façade guards. The local Chat tool fold is migrated to the latest lazy `PartialArguments` contract, and its image hole addresses the latest published attachment gallery slot. The Project-owned editor supplies the new semantic draft persistence and initialization faces without replacing its logical owner. Projection refresh treats `migration-required` values as sequence-free cache hints rather than an event-sequenced baseline. Original source records retain their source commits; only explicitly migrated files carry a per-file latest commit.

Latest client validation evidence is recorded under `.dev/latest-dsh-20261026/client/`; it does not replace the historical rc.2 results above or establish final Desktop installation on its own.

The rc.3 native Skill provider also subscribes to the public `plugin-manager/changed` invalidation. The root entry owns that one explicit subscription and feeds a typed native Host notification channel; this event never enters `ProjectRefreshEvent` or a Session control frame. Live child domains receive only the channel's subscribe face and release it on disposal. History readers and read-only children do not install the Skill provider and acquire no upstream notification subscription. The retained regression in `tests/stock-client-remote.ts` exercises the published native Skill cache, its actual Projects catalog calls, private-event separation and child cleanup through the real module table.

A successful create RPC can carry a partial result. The root UI preserves its exact warning in an alert and adds the saved ProjectRecord immediately. It opens only a current available carrier with header-confirmed `sessionCreatedAt`; absent/unconfirmed carriers leave the previous view intact. It does not automatically repeat create or refresh away this evidence. Targeted root-UI cases are recorded in `client/root-entry/CREATE-WARNING.json`.
