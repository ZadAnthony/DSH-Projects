/** Exact published native client dependencies. No arbitrary RPC or root Session fallback. */
import type { Context } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { TypertClientEventListener } from '@deepseek-ai/dsh-typert-protocol'
import type { Shortcuts } from '@deepseek-ai/dsh-client-shortcuts/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { ProjectCurrentSessionPickerPorts } from './pickers/contracts.ts'
import type { ProjectPresentedFilesPorts } from './deliverables/index.ts'
import type { ProjectChangedFilesPorts } from './changes/index.ts'

export type ProjectNativeCommands = Pick<ClientRemote['commands'], 'list' | 'execute'>
export type ProjectNativeFileReferences = Pick<ClientRemote['fileReferences'], 'list'>
export type ProjectNativeSessionReferences = Pick<ClientRemote['sessionReferenceResolver'], 'candidates'>
export type ProjectNativeUserQuestions = Pick<ClientRemote['userQuestions'], 'answer' | 'attachWait'>

export type ProjectNativeInteractionEvent = 'approval/request' | 'user-questions/request'
export type ProjectNativeInteractionListener<E extends ProjectNativeInteractionEvent> = TypertClientEventListener<E>
export type ProjectNativeRefreshEvent = 'commands/change' | 'agent-preset/selected'
  | 'llm/adapters-updated' | 'settings/document-updated'
  | 'credentials/record-updated' | 'credentials/reference-updated'

/** The Remote shim must dispatch interactions with the exact retained physical Session Context as `this`. */
export interface ProjectNativeRemoteCapabilities {
  readonly session: Pick<ClientRemote['session'], 'follow' | 'page' | 'modelCatalog' | 'selectModel'>
  readonly commands: ProjectNativeCommands
  readonly fileReferences: ProjectNativeFileReferences
  readonly sessionReferenceResolver: ProjectNativeSessionReferences
  readonly userQuestions: ProjectNativeUserQuestions
}

/** A real owner may forward configuration operations; absent operations reject explicitly. */
export type ProjectShortcutSettingsPort = Pick<Shortcuts, 'runtime' | 'platform' | 'config'
  | 'stopSequenceMs' | 'edit' | 'recording' | 'closeWindow'>

/** ui-plan accesses precisely these public sidebar faces. The mount must actually render registered tab seats. */
export interface ProjectPlanNavigationPort {
  readonly sidebarRight: Pick<Context['sidebarRight'], 'openResource' | 'mounted'>
  readonly sidebarRightTabs: Pick<Context['sidebarRightTabs'], 'register'>
  /** Mount the actual registered document UI and return its owned cleanup. */
  mount(container: HTMLElement): () => void
}

export interface ProjectNativeCapabilityPorts {
  /** Reader domains have no composer, pending-answer listeners, command source, or keyboard owner. */
  readonly mode: 'live' | 'reader'
  readonly remote: ProjectNativeRemoteCapabilities
  readonly planNavigation?: ProjectPlanNavigationPort
  /** Non-Plan resources go to the Projects FileReaderOwner, retaining their original address. */
  readonly openResourceFallback?: Context['sidebarRight']['openResource']
  readonly shortcutSettings?: ProjectShortcutSettingsPort
  readonly selectedTools?: ProjectNativeToolCapabilityPorts
  readonly currentSessionPickers?: ProjectCurrentSessionPickerPorts
  readonly presentedFiles?: ProjectPresentedFilesPorts
  readonly changedFiles?: ProjectChangedFilesPorts
}

/** Additional native surfaces used by the selected preset; absence is reported by toolViewsInstalled. */
export interface ProjectNativeToolCapabilityPorts {
  readonly remote: Pick<ClientRemote, 'skills' | 'job'>
  readonly uiWorkspace: Pick<Context['uiWorkspace'], 'openSession'>
  /** Exact direct-parent address from the native catalog/URI. Reader owner validates and renders it. */
  readonly openSubagentAside: (address: SubagentAddress) => void
}
