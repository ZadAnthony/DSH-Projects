import { acquireUiStyles, createWorkspaceDirectoryFlow, WorkspaceDirectoryFlow, WORKSPACE_DIRECTORY_FLOW_SLOT } from "./ui/index.ts";
import type { ComponentProps } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { ConnectionHandle } from "@deepseek-ai/dsh-api-remotes/client";
import type {} from "@deepseek-ai/dsh-api-session-controller/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-model-selection/client";
import type { MainPanelId } from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type {} from "@deepseek-ai/dsh-client-ui-tool/client";
import type {} from '@deepseek-ai/dsh-client-ui-chat/src/client/contract/file-open.ts';
import { IconProjectAddOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsRenderSlots, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import projectsRemote from "../../lib/typert.remote-client.js";
import { ProjectsPanel, EmbeddedConversation } from "./ProjectsPanel.tsx";
import { ProjectsPanelController, type ProjectsRemote } from "./controller.ts";
import {
  ProjectsToolCard,
  type ProjectToolCardInjected,
} from "./ProjectToolCard.tsx";
import { ProjectCommunicationCard, ProjectCommunicationMessage, type ProjectCommunicationInjected } from "./ProjectCommunicationCard.tsx";
import { ProjectMainModelControl, type ProjectMainModelControlInjected } from "./ProjectMainModelControl.tsx";
import { en, zh, type ProjectsKey } from "./locales.ts";
import { MemoryNotice, type ProjectMemoryNoticeInjected } from "./MemoryNotice.tsx";

const PANEL_ID = "projects" as MainPanelId;
const NS = "projects";
const PROJECT_TOOL_NAMES = [
  "project_read",
  "project_assign",
  "project_create_session",
  "project_send_message",
  "project_history",
  "project_instructions_read",
  "project_instructions_save",
  "project_stop_execution",
  "project_library_list",
  "project_library_add",
  "project_library_open",
  "project_library_remove",
  "project_overview_read",
  "project_overview_put_block",
  "project_overview_remove_block",
  "project_overview_reorder",
  "project_memory_list",
  "project_memory_read",
  "project_memory_save",
  "project_memory_withdraw",
] as const;

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    /** DSH Projects product copy. */
    projects: ProjectsKey;
  }

  interface SlotMap {
    /** Main project conversation embedded in the Projects panel. */
    "projects.main.conversation": { kind: "single"; scope: "session"; owner: { focus?: { readonly id: number; readonly eventSeq: number; readonly messageId?: string | undefined } | undefined } };
    "projects.main.model": { kind: "single"; scope: "session" };
    /** Selected execution conversation embedded beside the Projects main conversation. */
    "projects.execution.conversation": { kind: "single"; scope: "session"; owner: { focus?: { readonly id: number; readonly eventSeq: number; readonly messageId?: string | undefined } | undefined } };
  }
}

/** Decorative navigation icon; the Sidebar owns the accessible name. */
function ProjectsPanelIcon({ size }: PropsRuntime<"sidebar.panellist">) {
  return <IconProjectAddOutlineRegular size={size} />;
}

function installProjectsStyles(): () => void {
  return acquireUiStyles(document);
}

function registerProjectsUi(ctx: Context): void {
  ctx.effect(
    () => ctx.locale.register(NS, { zh, en }),
    "projects: dictionaries",
  );
  ctx.effect(installProjectsStyles, "projects: styles");

  const directoryFlow = createWorkspaceDirectoryFlow(ctx);
  type PanelRootProps = Omit<ComponentProps<typeof ProjectsPanel>, "renderSlot" | "renderSlotChain"> & PropsRenderSlots<
    "projects.main.conversation" | "projects.execution.conversation" | "projects.main.model" | typeof WORKSPACE_DIRECTORY_FLOW_SLOT
  >;
  const PanelRoot = (props: PanelRootProps) => <><ProjectsPanel {...props} /><WorkspaceDirectoryFlow flow={directoryFlow} renderSlot={props.renderSlot} /></>;

  const controller = new ProjectsPanelController(
    ctx.remote.projects,
    ctx.sessions,
    { canOpenWorkspacePath: () => ctx.remote.session.canOpenWorkspacePath(),
      openWorkspacePath: request => ctx.remote.session.openWorkspacePath(request),
      readConversationFile: (hostSessionId, path, offset, signal) => ctx.remote.workspaceFiles.read(hostSessionId as import('@deepseek-ai/dsh-session/types').SessionId, path, { offset }, signal),
    },
    (ctx.get("connection") as ConnectionHandle).generation,
    (from, to) => ctx.conversation.handoffUnsubmittedInput(from, to),
    id => {
      const binding = ctx.sessions.binding(id);
      if (binding !== undefined) ctx.conversation.input.for(binding.ctx).focus();
    },
  );
  const actions = controller.actions();
  ctx.on('chat/file-open', async (request, next) => {
    if (request.origin?.panelId !== PANEL_ID) { await next(); return; }
    if (ctx.layout.panelInfo.getSnapshot().activePanelId !== PANEL_ID) throw new DOMException(ctx.locale.bind(NS)("p5.panel.originalPanelLeft"), 'AbortError');
    controller.openConversationFile(request.binding, request.path, request.options, request.origin.signal);
  });
  ctx.effect(
    () => () => {
      controller.dispose();
    },
    "projects: session references",
  );

  ctx.slots.inject("main", function* () {
    yield ctx.slots.register(
      {
        name: "main",
        key: PANEL_ID,
        locale: NS,
        children: {
          [WORKSPACE_DIRECTORY_FLOW_SLOT]: { kind: "single", scope: "root" },
          "projects.main.conversation": { kind: "single", scope: "session" },
          "projects.main.model": { kind: "single", scope: "session" },
          "projects.execution.conversation": {
            kind: "single",
            scope: "session",
          },
        },
        inject: () => ({ ...actions, pickWorkspaceDirectory: directoryFlow.pick, onToggleGlobalSidebar: () => ctx.layout.toggleSidebar() }),
      },
      PanelRoot,
    );
    yield ctx.slots.register(
      { name: "projects.main.conversation" },
      EmbeddedConversation,
    );
    yield ctx.slots.register(
      { name: "projects.execution.conversation" },
      EmbeddedConversation,
    );
  });

  // 不把普通阶段的模型服务变成immediate UI的await前置；服务出现后接同一主会话目录。
  ctx.inject(["modelDirectories"], scope => {
    scope.slots.inject("projects.main.model", () => scope.slots.register(
      {
        name: "projects.main.model", locale: NS,
        inject: (sessionId): ProjectMainModelControlInjected => ({
          translate: scope.locale.bind(NS),
          acquireDirectory: () => {
            const reference = scope.sessions.retainKnown(sessionId, { source: "projectsPanel" });
            return {
              ready: reference.ready.then(binding => {
                if (binding.session.getSnapshot().openState === "error") throw new Error(ctx.locale.bind(NS)("p5.model.mainSettingsUnreadable"));
                return scope.modelDirectories.directoryFor(sessionId);
              }),
              release: () => reference.release(),
            };
          },
          generation: (scope.get("connection") as ConnectionHandle).generation,
        }),
      },
      ProjectMainModelControl,
    ));
  });

  ctx.slots.inject("sidebar.panellist", () =>
    ctx.slots.register(
      {
        name: "sidebar.panellist",
        id: PANEL_ID,
        order: 5,
        locale: NS,
        label: () => ctx.locale.bind(NS)("panel"),
      },
      ProjectsPanelIcon,
    ),
  );

  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register(
    {
      name: "conversation.input.dock",
      id: "projects-memory-notice",
      order: 30,
      locale: NS,
      inject: (): ProjectMemoryNoticeInjected => ({ hooks: {
        projectMemoryNotice: actions.hooks.projectMemoryNotice,
        projectDetail: actions.hooks.projectDetail,
      } }),
    },
    MemoryNotice,
  ));

  const openTarget: ProjectToolCardInjected["openTarget"] = async (
    projectId,
    target,
  ) => {
    await actions.openTarget(projectId, target);
    ctx.layout.selectPanel(PANEL_ID);
  };
  const remote: ProjectsRemote = ctx.remote.projects;
  const unwrap = async <T,>(operation: Promise<import('@deepseek-ai/dsh-typert-protocol').RemoteResult<T>>): Promise<T> => {
    const result = await operation;
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };
  const communication: ProjectCommunicationInjected = {
    beginNavigation: actions.beginNavigation,
    openTarget,
    openCommunicationFile: async path => { await unwrap(ctx.remote.session.openWorkspacePath({ path })); },
    readCommunication: (request, signal) => unwrap(remote.readCommunication(request, signal)),
    resolveCommunicationNavigation: (request, signal) => unwrap(remote.resolveCommunicationNavigation(request, signal)),
    resolveCommunicationFile: (request, signal) => unwrap(remote.resolveCommunicationFile(request, signal)),
  };
  ctx.slots.inject('conversation.message.body', () => ctx.slots.register({
    name: 'conversation.message.body', key: 'project-delivery', locale: NS,
    inject: () => communication,
  }, ProjectCommunicationMessage));
  for (const toolName of PROJECT_TOOL_NAMES) {
    ctx.slots.inject("tool.call.toolview", () =>
      ctx.slots.register(
        {
          name: "tool.call.toolview",
          key: toolName,
          locale: NS,
          inject: (): ProjectCommunicationInjected => communication,
        },
        toolName === "project_send_message" ? ProjectCommunicationCard : ProjectsToolCard,
      ),
    );
  }
}

/** Client services that must exist before the Projects Remote is mounted. */
export const inject = ["remote", "connection", "slots", "sessions", "locale", "layout"];

/** Mount the Projects Remote contribution, then its sidebar and main-panel UI. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(projectsRemote);
  const ui = ctx.inject(
    ["remote.projects", "remote.session", "remote.workspaceFiles", "connection", "slots", "sessions", "locale", "layout", "conversation"],
    registerProjectsUi,
  );
  try {
    await ui;
  } catch (error) {
    await ui.dispose();
    await disposeRemote();
    throw error;
  }
  return async () => {
    await ui.dispose();
    await disposeRemote();
  };
}
