/** Join the controller's project actions with the actual product file owner. */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectsPanelActions, ProjectsPanelCoreActions } from '../../../client/controller.ts'
import type { ProjectConversationFileRequest, ReadConversationFile } from '../../../client/workflow-navigation.ts'

export interface ProjectProductFileReaderPort {
  readonly request: HostObservable<ProjectConversationFileRequest | undefined>
  readonly read: ReadConversationFile
  close(options?: { readonly focus?: boolean | undefined }): void
}

export function createProjectPanelActions(
  core: ProjectsPanelCoreActions,
  fileReader: ProjectProductFileReaderPort,
): ProjectsPanelActions {
  return {
    ...core,
    hooks: { ...core.hooks, projectFileRequest: fileReader.request },
    readConversationFile: fileReader.read,
    dismissConversationFile: id => {
      if (fileReader.request.getSnapshot()?.id === id) fileReader.close({ focus: true })
    },
    returnToFileConversation: async request => {
      request.signal.throwIfAborted()
      await core.openTarget(request.projectId, { kind: request.role, sessionId: request.sessionId })
    },
    release: () => { fileReader.close(); core.release() },
  }
}
