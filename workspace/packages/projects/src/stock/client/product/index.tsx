import { acquireProjectsLocale, acquireUiStyles } from '../../../client/ui/index.ts'
/** Complete product UI installed only in the Projects-owned client Context. */
import type { Context } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'
import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { ProjectsPanel } from '../../../client/ProjectsPanel.tsx'
import { ProjectsPanelController, type NativeFileOpenPort, type ProjectsPanelActions, type ProjectsRemote, type ProjectPanelBindingPort, type ProjectPanelReference } from '../../../client/controller.ts'
import { ProjectMainModelControl, type ProjectMainModelControlInjected } from '../../../client/ProjectMainModelControl.tsx'
import { ProjectCommunicationMessage, type ProjectCommunicationInjected, type ProjectCommunicationMessagePresentation } from '../../../client/ProjectCommunicationCard.tsx'
import { MemoryNotice } from '../../../client/MemoryNotice.tsx'
import type { ProjectsKey } from '../../../client/locales.ts'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectConversationFileRequest, ReadConversationFile } from '../../../client/workflow-navigation.ts'
import type { NativeEventSource } from '../../../source-types.ts'
import type { ProjectDetail } from '../../../public-types.ts'
import { installProjectProductToolViews, type ProjectProductCommunicationPorts } from './tool-views.tsx'
import { installProjectCommunicationQueue } from './communication-queue.tsx'
export { installProjectProductToolViews, PROJECT_PRODUCT_TOOL_NAMES } from './tool-views.tsx'
export type { ProjectProductCommunicationPorts, ProjectProductToolViewsOptions } from './tool-views.tsx'

export type { ProjectCommunicationFileContext } from '../../../client/ProjectCommunicationCard.tsx'
export type { ProjectsRemote, ProjectPanelReference, ProjectLogicalBinding, ProjectPanelBindingPort, ProjectPermanentDeleteIntent } from '../../../client/controller.ts'

export interface ProjectConversationPresentation {
  readonly readOnly: boolean
  /** Current display name, independent of a retained session binding's detail snapshot. */
  readonly projectName?: string
  /** Existing seat visibility; hiding does not unmount its native conversation. */
  readonly visible?: boolean
  readonly focus?: { readonly id: number; readonly eventSeq: number; readonly messageId?: string | undefined } | undefined
}

export interface ProjectProductFileReaderPort {
  readonly request: HostObservable<ProjectConversationFileRequest | undefined>
  readonly read: ReadConversationFile
  close(options?: { readonly focus?: boolean | undefined }): void
}

/** Every Host/native action is explicitly supplied; no ordinary-root service is captured. */
export interface ProjectProductUiPorts extends ProjectPanelBindingPort {
  readonly remote: ProjectsRemote
  readonly sessions: Pick<ISessions, 'retain'>
  readonly generation: ConnectionHandle['generation']
  readonly files: NativeFileOpenPort
  readonly fileReader: ProjectProductFileReaderPort
  readonly renderMainModelControl?: (reference: ProjectPanelReference) => ReactNode
  readonly renderConversation: (reference: ProjectPanelReference, options: ProjectConversationPresentation) => ReactNode
  readonly renderSourceConversation: (detail: ProjectDetail, source: NativeEventSource, options: { readonly readOnly: true }) => ReactNode
  readonly acquireModelDirectory: (reference: SessionReference) => ReturnType<ProjectMainModelControlInjected['acquireDirectory']>
  readonly focusInput: (id: SessionReference['sessionId']) => void
  readonly openCommunicationFile: ProjectCommunicationInjected['openCommunicationFile']
  readonly resolveCommunicationInvocation: ProjectCommunicationInjected['resolveCommunicationInvocation']
  readonly subscribeCommunicationChanges: NonNullable<ProjectCommunicationInjected['subscribeCommunicationChanges']>
  readonly pickWorkspaceDirectory?: () => Promise<string | null>
  readonly revealProjects?: () => void
  readonly toggleGlobalSidebar?: () => void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { projects: ProjectsKey }
  interface SlotMap {
    'projects.main.conversation': { kind: 'single'; scope: 'session'; owner: { focus?: { readonly id: number; readonly eventSeq: number; readonly messageId?: string | undefined } | undefined } }
    'projects.execution.conversation': { kind: 'single'; scope: 'session'; owner: { focus?: { readonly id: number; readonly eventSeq: number; readonly messageId?: string | undefined } | undefined } }
    'projects.main.model': { kind: 'single'; scope: 'session' }
    'projects.communication.message': { kind: 'single'; scope: 'session'; owner: ProjectCommunicationMessagePresentation }
  }
}

/** Registers product seats in a private graph. The outer root owns only its Projects DOM/navigation. */
export function installProjectProductUi(ctx: Context, ports: ProjectProductUiPorts) {
  const controller = new ProjectsPanelController(ports.remote, ports.sessions, ports.files, ports.generation, ports, ports.focusInput)
  const baseActions = controller.actions()
  const actions: ProjectsPanelActions = { ...baseActions,
    hooks: { ...baseActions.hooks, projectFileRequest: ports.fileReader.request },
    readConversationFile: ports.fileReader.read,
    dismissConversationFile: id => { if (ports.fileReader.request.getSnapshot()?.id === id) ports.fileReader.close({ focus: true }) },
    returnToFileConversation: async request => {
      request.signal.throwIfAborted()
      await baseActions.openTarget(request.projectId, { kind: request.role, sessionId: request.sessionId })
    },
    release: () => { ports.fileReader.close(); baseActions.release() },
  }
  const disposers: (() => void)[] = []
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    const failures: unknown[] = []
    for (const close of [...disposers].reverse()) { try { close() } catch (error) { failures.push(error) } }
    try { ports.fileReader.close() } catch (error) { failures.push(error) }
    try { controller.dispose() } catch (error) { failures.push(error) }
    if (failures.length !== 0) throw new AggregateError(failures, 'Projects product UI cleanup failed')
  }
  try {
    disposers.push(acquireProjectsLocale(ctx.locale))
    disposers.push(acquireUiStyles(document))
    disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main', key: 'projects', locale: 'projects',
      children: {
        'projects.main.conversation': { kind: 'single', scope: 'session' },
        'projects.execution.conversation': { kind: 'single', scope: 'session' },
        'projects.main.model': { kind: 'single', scope: 'session' },
      },
      inject: () => ({ ...actions, renderConversation: ports.renderConversation,
        renderSourceConversation: ports.renderSourceConversation,
        renderMainModelControl: ports.renderMainModelControl,
        pickWorkspaceDirectory: ports.pickWorkspaceDirectory,
        onToggleGlobalSidebar: ports.toggleGlobalSidebar }),
    }, ProjectsPanel)))
    disposers.push(ctx.slots.inject('projects.main.model', () => ctx.slots.register({
      name: 'projects.main.model', locale: 'projects', inject: sessionId => ({
        translate: ctx.locale.bind('projects'),
        acquireDirectory: () => {
          const reference = ports.sessions.retain(sessionId, { source: 'projectsPanel' })
          let lease: ReturnType<ProjectMainModelControlInjected['acquireDirectory']> | undefined
          let released = false
          return {
            ready: reference.ready.then(() => {
              if (released) throw new DOMException('Project model directory closed', 'AbortError')
              lease = ports.acquireModelDirectory(reference)
              return lease.ready
            }),
            release: () => { if (released) return; released = true; lease?.release(); reference.release() },
          }
        }, generation: ports.generation,
      }),
    }, ProjectMainModelControl)))
    const openTarget: ProjectCommunicationInjected['openTarget'] = async (projectId, target) => {
      await actions.openTarget(projectId, target)
      ports.revealProjects?.()
    }
    const unwrap = async <T,>(operation: Promise<import('@deepseek-ai/dsh-typert-protocol').RemoteResult<T>>): Promise<T> => {
      const result = await operation
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    }
    const communication: ProjectProductCommunicationPorts = Object.freeze<ProjectCommunicationInjected>({
      openTarget, openCommunicationFile: ports.openCommunicationFile, resolveCommunicationInvocation: ports.resolveCommunicationInvocation, subscribeCommunicationChanges: ports.subscribeCommunicationChanges,
      readCommunication: (request, signal) => unwrap(ports.remote.readCommunication(request, signal)),
      resolveCommunicationNavigation: (request, signal) => unwrap(ports.remote.resolveCommunicationNavigation(request, signal)),
      resolveCommunicationFile: (request, signal) => unwrap(ports.remote.resolveCommunicationFile(request, signal)),
    })
    disposers.push(ctx.slots.inject('projects.communication.message', () => ctx.slots.register({
      name: 'projects.communication.message', locale: 'projects', inject: () => communication,
    }, ProjectCommunicationMessage)))
    disposers.push(installProjectProductToolViews(ctx, communication, { registerLocale: false, installStyles: false }))
    disposers.push(installProjectCommunicationQueue(ctx, communication))
    disposers.push(ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
      name: 'conversation.input.dock', id: 'projects-memory-notice', order: 30, locale: 'projects',
      inject: () => ({ hooks: { projectMemoryNotice: actions.hooks.projectMemoryNotice, projectDetail: actions.hooks.projectDetail } }),
    }, MemoryNotice)))
    return { controller, actions, dispose,
      get communicationPorts(): ProjectProductCommunicationPorts { return communication },
      renderCommunicationMessage: (presentation: ProjectCommunicationMessagePresentation): ReactNode =>
        <ProjectCommunicationMessage {...presentation} {...communication} t={ctx.locale.bind('projects')} />,
    }
  } catch (error) {
    try { dispose() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Projects product UI installation and cleanup failed') }
    throw error
  }
}
