# Native capability sources

Target: DeepSeek Harness `0.2.0-rc.2`, commit `639ed015397290b3745d163aafe02ffee4aa3f84`, MIT.

The capability installer calls the published `/client` factories for input triggers, commands, unified file/session references, model selection, approval, user questions, Plan, and resources. Those modules retain the host's React, Cordis, service, controller and component identities. No runtime host `src` import is used.

`native/shortcut-registry.ts` comes from `packages/client/shortcuts/src/client/registry.ts` at that commit. Only imports are changed to published `shortcuts/protocol` and type-only `shortcuts/client`. Its MIT license is retained in `native/LICENSE`. `ProjectScopedShortcuts` is a new Projects owner: the stock service installs window/native handlers and therefore cannot be installed in a private panel. This owner binds listeners only to the mounted private container, runs the original registry, and rejects unavailable settings/native-window operations.

The Remote adapter must preserve the exact event scope (`this` is the physical Session Context), request cancellation, waterfall settlement, answer and foreground wait stream. The installer does not fabricate any of those services. The typed requirements live in `contracts.ts`.

Native service readiness is verified by awaiting the actual published producer fibers found through public `ctx.registry.get`, not by treating an inactive dependent `ctx.inject` fiber as proof of activation. Original constructor errors propagate unchanged. Subagent Plan resource identities preserve the child field while retaining direct-parent and native mode in the read address.

Plan requires actual navigation and tab rendering, not an empty `register` or success-only `openResource`. The caller supplies `ProjectPlanNavigationPort`, and the public resources owner handles durable Plan loading through Project session `follow`/`page`.

The default `ProjectPlanNavigation` owns a real Plan registration table, exact-source Session retain, cancellable resource subscription and a mounted React document preview. It does not implement the stock multi-tab sidebar. Native `subagentchat` navigation is decoded without guessing lifecycle mode and delegated to the caller's typed `openSubagentAside(SubagentAddress)` reader; the original sidebar registration is not evidence that this reader has been integrated.

`subagent-address.ts` is the address codec from `packages/client/ui-subagent/src/client/sidebar-chat/index.tsx` at the same pinned commit, with an additional empty-child rejection. Its MIT license is retained with the shortcut source.

`tool-views.ts` installs published `ui-workflow-run/client`, `ui-subagent/client`, `ui-skill/client`, `api-job-controller/client` and `ui-jobs/client` factories when their explicit `selectedTools` ports are supplied. `toolViewsInstalled` reports whether they were actually installed. The source modules require:

| Surface | Actual owner/read/write |
| --- | --- |
| Workflow run | Durable workflow events and `uiWorkspace.openSession(SessionTarget)`; workflow member addresses explicitly carry native `mode: one-shot`. |
| Subagent | Parent `subagentCatalog` projection, direct-parent/child/mode address, `refreshProjections`, exact main/aside navigation. Continuable input/Stop additionally use private `subagents.prompt`/`interruptByParent`. |
| Skill | `remote.skills.list({sessionId}, signal)`, `agent-preset/selected` and connection-reset invalidation, literal skill insertion and native `skill` tool row. |
| Jobs | Real public ClientJobs owner over `$stream` and `remote.job.list/follow/kill`; every private job observation includes its true owning session. |

Stock `ui-tool` already provides general detail views for workflow/subagent/job/terminal/session tools. Those generic rows alone do not provide the dedicated workflow lifecycle panel, native child navigation, skill source, jobs output or human kill.

Global-management audit: `ui-deliverables` directly fetches stock `api/changes.*` and `api/present.*` HTTP endpoints; it must not be applied to this private graph unchanged. Actual presented-result cards are handled by the limited `deliverables/` adapter, with exact session/path reading through the Projects FileReader owner. `ui-cordis` requires a real private dynamic runner plus loader/modules and request-run/inspect events; this installer does not acquire root management power or install a fake runner. Private inspection output can use the genuine generic tool result view. Whole permission/preset packages also include global Settings/default/creator writers; only the current-session controls in `pickers/` are eligible for this graph.
