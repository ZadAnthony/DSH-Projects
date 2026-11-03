/** Historical source metadata only. Existing saved introductions remain readable; new projects never produce this input. */
import type {} from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'project-workspace-introduction': {
      readonly kind: 'project-workspace-introduction'
      readonly projectId: string
      readonly workspace: string
      readonly creationReason?: string
    }
  }
}
